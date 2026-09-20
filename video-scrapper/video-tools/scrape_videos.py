"""Collect post links, visit each, and export video sources from the DOM."""

import argparse
import json
import os
import shutil
import signal
import time
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import Error, TimeoutError as PlaywrightTimeoutError, sync_playwright

from proxy_config import load_proxy_config, redacted, require_proxy_if_expected

POST_SELECTOR = '#fboardlist .list-row a[href*="wr_id"]'
VIDEO_SELECTOR = '.jw-media video.jw-video'
OVERLAY_SELECTOR = 'div[data-cl-overlay], div.p6driy29haev'
# General-purpose guesses for a board post's content title, checked in order.
# Not verified against a specific live target (none was inspected for this
# change) - falls back to the page's own <title> tag, which is present on
# virtually any well-formed page, so extraction never simply comes back empty
# just because none of these class names happen to match.
POST_TITLE_SELECTORS = ['h1', '.bo_v_tit', '.view_title', '.subject', '.post-title']
# System browser names probed on PATH, in order (Debian/Ubuntu, Fedora, Chrome).
CHROMIUM_EXECUTABLE_NAMES = ('chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome')
# /dev/shm is tiny on many VPS/container setups; without this Chromium tabs crash.
CHROMIUM_LAUNCH_ARGS = ['--disable-dev-shm-usage']


def find_chromium_executable():
    """Explicit env override first (PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH / CHROME_BIN),
    then a system Chromium/Chrome on PATH. Returns None if nothing is found."""
    for env_name in ('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH', 'CHROME_BIN'):
        candidate = os.environ.get(env_name, '').strip()
        if candidate and os.path.exists(candidate):
            return candidate
    for name in CHROMIUM_EXECUTABLE_NAMES:
        found = shutil.which(name)
        if found:
            return found
    return None


def launch_chromium(chromium, headless, proxy):
    """Launch Chromium for headless Linux servers as well as Windows dev boxes.

    Tries a system executable first (see find_chromium_executable). If that
    binary exists but fails to launch (snap confinement, missing libraries,
    version mismatch with the Playwright driver), falls back to Playwright's own
    bundled Chromium instead of aborting the whole run."""
    launch_kwargs = {'headless': headless, 'proxy': proxy, 'args': list(CHROMIUM_LAUNCH_ARGS)}
    exec_path = find_chromium_executable()
    if exec_path:
        try:
            return chromium.launch(executable_path=exec_path, **launch_kwargs)
        except Exception as exc:
            first_line = str(exc).strip().splitlines()[0] if str(exc).strip() else type(exc).__name__
            print(f'[Browser] Chromium at {exec_path} failed to launch ({first_line}); '
                  f'falling back to Playwright\'s bundled Chromium.', flush=True)
    try:
        return chromium.launch(**launch_kwargs)
    except Exception as exc:
        raise RuntimeError(
            'Could not launch Chromium. Install a system Chromium, set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, '
            'or run "python3 -m playwright install --with-deps chromium". '
            f'Last error: {exc}'
        ) from exc


def install_sigterm_handler():
    """Turn SIGTERM (e.g. PM2/NexaHub stopping the process) into a normal
    interpreter exit, so every pending `finally` - closing the browser and
    context - runs exactly as it does for Ctrl+C."""
    def handle_sigterm(signum, frame):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)  # a repeated SIGTERM must not interrupt cleanup
        raise SystemExit(128 + signum)
    try:
        signal.signal(signal.SIGTERM, handle_sigterm)
    except (ValueError, OSError, AttributeError):
        pass  # not the main thread, or the platform lacks SIGTERM


def connect_browser(chromium, endpoint, timeout):
    """Retry a briefly unavailable debug listener, without launching another browser."""
    for attempt in range(3):
        try:
            return chromium.connect_over_cdp(endpoint, timeout=timeout)
        except Error as exc:
            if 'ECONNREFUSED' not in str(exc) or attempt == 2:
                raise
            print('Browser debug port is unavailable; retrying connection...', flush=True)
            time.sleep(1)


def click_player_overlay(page, timeout):
    """Click a visible overlay; wait for its popup before returning to the post."""
    for frame in page.frames:
        try:
            overlays = frame.locator(OVERLAY_SELECTOR).all()
        except Error:
            continue
        for overlay in overlays:
            try:
                if not overlay.is_visible():
                    continue
            except Error:
                continue
            popups = []
            def track_popup(popup):
                popups.append(popup)
            page.on('popup', track_popup)
            try:
                try:
                    overlay.click(timeout=timeout)
                except Error:
                    try:
                        overlay.click(force=True, timeout=min(1000, timeout))
                    except Error:
                        try:
                            overlay.evaluate("el => el.click()")
                        except Error:
                            return False
                print('Player overlay clicked; waiting up to 5s for popup...', flush=True)
                popup_deadline = time.monotonic() + 5
                while not popups and time.monotonic() < popup_deadline:
                    page.wait_for_timeout(100)
                for popup in popups:
                    if not popup.is_closed():
                        try:
                            popup.close()
                        except Error:
                            pass
                if not popups:
                    print('No popup appeared; checking original tab after overlay click.', flush=True)
                page.bring_to_front()
                print('Original tab active; now waiting for video DOM and source...', flush=True)
                return True
            except Error:
                return False
            finally:
                page.remove_listener('popup', track_popup)
    return False


class VerificationRequired(Exception):
    pass


class OverlayNotFound(Exception):
    pass


def verification_visible(page):
    for frame in page.frames:
        try:
            if frame.evaluate('''() => {
                const text = (document.body?.innerText || '').toLowerCase();
                return ['verify you are human', 'verifying you are human',
                    'performing security verification', 'checking your browser',
                    'why is this verification taking so long'].some(s => text.includes(s));
            }'''):
                return True
        except Error:
            continue
    return False


def wait_for_verification(page, seconds, headed):
    if not headed:
        raise VerificationRequired('Human verification detected. Run with --headed and complete it in the browser.')
    print(f'Complete human verification in the browser; waiting up to {seconds:g}s...', flush=True)
    deadline = time.monotonic() + seconds
    clear_since = None
    while time.monotonic() < deadline:
        page.wait_for_timeout(1000)
        try:
            ready = page.evaluate("document.readyState !== 'loading' && !!document.body && document.body.innerText.trim().length > 0")
            clear = ready and not verification_visible(page)
        except Error:
            clear = False  # A navigation/reload is not successful verification.
        if clear:
            if clear_since is None:
                clear_since = time.monotonic()
            if time.monotonic() - clear_since >= 3:
                return
        else:
            clear_since = None
    raise VerificationRequired('Human verification was not completed before the wait expired.')


def save_results(folder, results):
    (folder / 'videos.json').write_text(
        json.dumps(results, indent=2, ensure_ascii=False), encoding='utf-8'
    )


def extract_sources_from_frame(frame):
    """Extract media URLs from frame in conservative fallback order."""
    sources = []
    # 1. Conservative order: .jw-media video.jw-video -> video.jw-video -> video
    for sel in [VIDEO_SELECTOR, 'video.jw-video', 'video']:
        try:
            videos = frame.locator(sel)
            if videos.count() > 0:
                found = videos.evaluate_all('''videos => videos.flatMap(v =>
                    [v.currentSrc, v.getAttribute('src'),
                     ...Array.from(v.querySelectorAll('source[src]'), s => s.getAttribute('src'))]
                    .filter(s => s && s.trim())
                    .map(s => {
                        try { return new URL(s, v.baseURI || document.baseURI || window.location.href).href; } catch (e) { return ''; }
                    })
                    .filter(s => s && (s.startsWith('http://') || s.startsWith('https://'))))''')
                sources.extend(found)
                if sources:
                    break
        except Error:
            continue

    # 2. Try standalone source[src] if still empty
    if not sources:
        try:
            standalone = frame.locator('source[src]').evaluate_all('''els => els
                .map(s => s.getAttribute('src'))
                .filter(s => s && s.trim())
                .map(s => {
                    try { return new URL(s, document.baseURI || window.location.href).href; } catch (e) { return ''; }
                })
                .filter(s => s && (s.startsWith('http://') || s.startsWith('https://')))''')
            sources.extend(standalone)
        except Error:
            pass

    # 3. Try direct media iframes (e.g. iframe pointing directly to a media file)
    if not sources:
        try:
            iframe_sources = frame.locator('iframe[src]').evaluate_all('''iframes => iframes
                .map(f => f.getAttribute('src'))
                .filter(s => s && s.trim())
                .map(s => {
                    try { return new URL(s, document.baseURI || window.location.href).href; } catch (e) { return ''; }
                })
                .filter(s => s && (s.startsWith('http://') || s.startsWith('https://')) &&
                    ['.mp4', '.m4v', '.webm', '.mov', '.m3u8'].some(ext => s.toLowerCase().split('?')[0].endsWith(ext)))''')
            sources.extend(iframe_sources)
        except Error:
            pass

    return sources


def extract_post_title(page):
    """Best-effort extraction of the post's content title from the DOM.
    Tries each of POST_TITLE_SELECTORS in order and returns the first
    nonempty match; falls back to the page's own <title> tag if none of them
    match anything. Never raises - a title is a nice-to-have annotation, not
    something that should ever abort scraping a post."""
    for sel in POST_TITLE_SELECTORS:
        try:
            loc = page.locator(sel)
            if loc.count() > 0:
                text = loc.first.inner_text().strip()
                if text:
                    return text
        except Error:
            continue
        except Exception:
            continue
    try:
        return (page.title() or '').strip()
    except Exception:
        return ''


def video_sources(page, timeout, play, verification_wait=180, headed=False):
    effective_timeout = min(timeout, 15) if timeout > 0 else 15
    deadline = time.monotonic() + effective_timeout
    attempted = set()
    verification_remaining = verification_wait
    overlay_attempted = False
    captured_network_sources = []

    def handle_request(request):
        try:
            url = request.url
            clean_path = url.split("?")[0].lower()
            resource_type = request.resource_type
            if resource_type == "media" or clean_path.endswith(".mp4") or clean_path.endswith(".m3u8"):
                if (
                    not clean_path.endswith(".js")
                    and not clean_path.endswith(".css")
                    and not clean_path.endswith(".html")
                    and not clean_path.endswith(".json")
                    and url not in captured_network_sources
                ):
                    captured_network_sources.append(url)
        except Exception:
            pass

    page.on("request", handle_request)
    print(f'Waiting up to {effective_timeout:g}s for video source (checking overlay: {OVERLAY_SELECTOR})', flush=True)

    try:
        while time.monotonic() < deadline:
            if verification_visible(page):
                if verification_remaining <= 0:
                    raise VerificationRequired('Human verification wait budget expired; video source was not reached.')
                started = time.monotonic()
                wait_for_verification(page, verification_remaining, headed)
                verification_remaining -= time.monotonic() - started
                deadline = time.monotonic() + effective_timeout

            if not overlay_attempted:
                try:
                    overlay_clicked = click_player_overlay(page, min(2000, max(1, (deadline - time.monotonic()) * 1000)))
                    if overlay_clicked:
                        deadline = time.monotonic() + effective_timeout
                except Error:
                    pass
                overlay_attempted = True

            sources = list(captured_network_sources)

            # Include videos inside iframes as well as the main document.
            for frame in page.frames:
                try:
                    frame_sources = extract_sources_from_frame(frame)
                    sources.extend(frame_sources)
                    if play and frame not in attempted:
                        videos = frame.locator('video')
                        if videos.count():
                            attempted.add(frame)
                            videos.evaluate_all('''videos => { for (const v of videos) {
                                v.muted = true; v.play().catch(() => {});
                            }}''')
                except Error:
                    continue  # An iframe may detach while the player loads.

            sources = list(dict.fromkeys(sources))
            if sources:
                return sources

            page.wait_for_timeout(400)

        return list(dict.fromkeys(captured_network_sources))
    finally:
        try:
            page.remove_listener("request", handle_request)
        except Exception:
            pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('url', nargs='?', help='Main website/listing URL')
    parser.add_argument('--input-links', help='Read saved post_links.json instead of visiting main page')
    parser.add_argument('--output', default='output')
    parser.add_argument('--links-only', action='store_true', help='Save main page links only, without visiting posts')
    parser.add_argument('--timeout', type=float, default=30, help='Wait per page in seconds')
    parser.add_argument('--delay', type=float, default=1, help='Delay between posts in seconds')
    parser.add_argument('--scrolls', type=int, default=0, help='Scroll main page for lazy-loaded posts')
    parser.add_argument('--headed', action='store_true', help='Show browser window')
    parser.add_argument('--headless', action='store_true', help='Run browser in headless mode (standalone Playwright Chromium)')
    parser.add_argument('--profile', help='Folder for a persistent browser session, e.g. browser-profile')
    parser.add_argument('--cdp-url', help='Attach to a browser started with remote debugging, e.g. http://127.0.0.1:9222')
    parser.add_argument('--play', action='store_true', help='Try muted playback to initialize video src')
    parser.add_argument('--verification-wait', type=float, default=180, help='Seconds allowed for manual human verification')
    parser.add_argument('--stop-on-verification', action='store_true', help='Stop batch if human verification remains unresolved')
    args = parser.parse_args()
    if args.cdp_url and args.profile:
        parser.error('Use --cdp-url or --profile, not both')
    if args.cdp_url and args.headless:
        parser.error('Use --cdp-url or --headless, not both')
    if args.headed and args.headless:
        parser.error('Use --headed or --headless, not both')
    if args.cdp_url:
        args.headed = True
    install_sigterm_handler()
    saved_links = None
    if args.input_links:
        try:
            saved_links = json.loads(Path(args.input_links).read_text(encoding='utf-8-sig'))
            if not isinstance(saved_links, list) or not all(
                isinstance(link, str) and urlsplit(link).scheme in ('http', 'https')
                and urlsplit(link).netloc for link in saved_links
            ):
                raise ValueError('Input must be a JSON array of complete HTTP/HTTPS URLs')
        except (OSError, ValueError) as exc:
            parser.error(str(exc))
    elif not args.url or urlsplit(args.url).scheme not in ('http', 'https') or not urlsplit(args.url).netloc:
        parser.error('Provide a complete http:// or https:// URL')
    if args.timeout <= 0 or args.verification_wait <= 0 or args.delay < 0 or args.scrolls < 0:
        parser.error('timeout and verification-wait must be positive; delay and scrolls must be nonnegative')

    folder = Path(args.output)
    folder.mkdir(parents=True, exist_ok=True)
    results = []
    proxy = load_proxy_config()
    require_proxy_if_expected(proxy)
    print(f'Proxy: {redacted(proxy)}', flush=True)
    if proxy and args.cdp_url:
        print('NOTE: --cdp-url attaches to an already-running browser; its proxy was fixed '
              'at that browser\'s own launch time and cannot be changed from here. The '
              'configured proxy above will be ignored for this run.', flush=True)
    with sync_playwright() as p:
        browser = None
        if args.cdp_url:
            try:
                browser = connect_browser(p.chromium, args.cdp_url, args.timeout * 1000)
            except Error as exc:
                parser.exit(1, f'Cannot connect to browser. Run start_browser.ps1 first and keep that window open.\n{exc}\n')
            if not browser.contexts:
                parser.exit(1, 'Connected browser has no available context.\n')
            context = browser.contexts[0]
        elif args.profile:
            context = p.chromium.launch_persistent_context(
                str(Path(args.profile).resolve()), headless=not args.headed, proxy=proxy
            )
        elif args.headless:
            browser = launch_chromium(p.chromium, True, proxy)
            context = browser.new_context()
        else:
            browser = launch_chromium(p.chromium, not args.headed, proxy)
            context = browser.new_context()
        page = context.new_page() if args.cdp_url else (context.pages[0] if context.pages else context.new_page())
        page.set_default_timeout(args.timeout * 1000)
        leave_page_open = False
        verification_blocked = False
        try:
            if saved_links is None:
                page.goto(args.url, wait_until='domcontentloaded')
                page.locator(POST_SELECTOR).first.wait_for(state='attached')
            links = list(saved_links) if saved_links is not None else []
            for step in range(args.scrolls + 1 if saved_links is None else 0):
                links.extend(page.locator(POST_SELECTOR).evaluate_all('''anchors => anchors
                    .filter(a => (a.getAttribute('href') || '').trim()
                        && !a.getAttribute('href').trim().startsWith('#'))
                    .map(a => a.href).filter(u => u.startsWith('https://') || u.startsWith('http://'))'''))
                if step < args.scrolls:
                    page.evaluate('window.scrollTo(0, document.body.scrollHeight)')
                    page.wait_for_timeout(1000)
            links = list(dict.fromkeys(links))
            if saved_links is None:
                (folder / 'post_links.json').write_text(json.dumps(links, indent=2), encoding='utf-8')
            print(f'Found {len(links)} unique post links', flush=True)
            if not links:
                print('No post links available to open.', flush=True)
                return
            if args.links_only:
                print(f"Links saved in: {(folder / 'post_links.json').resolve()}")
                return
            save_results(folder, results)
            # Reuse one visible tab for all posts instead of leaving a blank
            # listing tab in front and creating/closing detail tabs each time.
            detail = page
            def close_popup(popup):
                try:
                    popup.close()
                    print('New popup tab closed.', flush=True)
                    if not detail.is_closed():
                        detail.bring_to_front()
                except Error:
                    pass
            detail.on('popup', close_popup)
            for index, link in enumerate(links, 1):
                result = dict(page_url=link, title='', video_urls=[], status='not_found', error='')
                detail.set_default_timeout(args.timeout * 1000)
                try:
                    print(f'[{index}/{len(links)}] Opening post...', flush=True)
                    detail.bring_to_front()
                    response = detail.goto(link, wait_until='commit')
                    if response is not None:
                        print(f'  HTTP {response.status}; waiting for player...', flush=True)
                    try:
                        detail.wait_for_load_state('domcontentloaded', timeout=min(10000, args.timeout * 1000))
                    except PlaywrightTimeoutError:
                        print('  Page still loading; checking available DOM...', flush=True)
                    result['title'] = extract_post_title(detail)
                    result['video_urls'] = video_sources(
                        detail, args.timeout, args.play, args.verification_wait, args.headed
                    )
                    if result['video_urls']:
                        result['status'] = 'found'
                    else:
                        result['error'] = 'No nonempty video source appeared before timeout; player may need interaction or a different selector.'
                except VerificationRequired as exc:
                    result.update(status='verification_required', error=str(exc))
                except OverlayNotFound as exc:
                    result.update(status='overlay_not_found', error=str(exc))
                except Error as exc:
                    result.update(status='error', error=str(exc))
                results.append(result)
                save_results(folder, results)
                print(f"[{index}/{len(links)}] {result['status']}: {link}", flush=True)
                if result['error']:
                    print(f"  {result['error']}", flush=True)
                if result['status'] == 'verification_required' and args.stop_on_verification:
                    verification_blocked = True
                    leave_page_open = True
                    print('Batch stopped: resolve verification before retrying. Remaining posts were not opened.', flush=True)
                    break
                if index < len(links):
                    page.wait_for_timeout(args.delay * 1000)
        finally:
            if args.cdp_url:
                # Keep the user's browser and existing tabs open; leaving the
                # Playwright manager disconnects our client from the browser.
                if not leave_page_open and not page.is_closed():
                    page.close()
            else:
                try:
                    context.close()
                except Exception:
                    pass
                if browser is not None:
                    try:
                        browser.close()
                    except Exception:
                        pass
    print(f'Results saved in: {folder.resolve()}')
    if verification_blocked:
        raise SystemExit(2)


if __name__ == '__main__':
    main()
