import argparse
import csv
import html
import json
import os
import re
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright, Error
from bs4 import BeautifulSoup

BASE_URL = "https://02.avsee.is/bbs/board.php?bo_table="
POST_SELECTOR = ".main-box .post-image a[href], a[href*='wr_id=']"
OVERLAY_SELECTOR = "div[data-cl-overlay], div.p6driy29haev, .jw-preview, .jw-display-icon-container"
VIDEO_SELECTOR = ".jw-media video.jw-video, video"

ROOT_DIR = Path(__file__).resolve().parent
PROFILE_DIR = ROOT_DIR / "browser_profile"


def click_player_overlay(page, timeout=3000):
    """
    Clicks player overlay to trigger playback and closes any opened ad popups.
    Adapted from video-tools DOM extraction engine.
    """
    clicked = False
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

            page.on("popup", track_popup)
            try:
                overlay.click(timeout=timeout)
                popup_deadline = time.monotonic() + 3.0
                while not popups and time.monotonic() < popup_deadline:
                    page.wait_for_timeout(100)
                for popup in popups:
                    try:
                        if not popup.is_closed():
                            popup.close()
                    except Exception:
                        pass
                page.bring_to_front()
                clicked = True
                break
            except Exception:
                pass
            finally:
                page.remove_listener("popup", track_popup)
        if clicked:
            break
    return clicked


def wait_for_cloudflare_clearance(page, max_wait=10):
    """
    Waits for Cloudflare challenge clearance if present.
    """
    start = time.monotonic()
    while time.monotonic() - start < max_wait:
        t = ""
        try:
            t = page.title()
        except Exception:
            pass
        if (
            "Just a moment" not in t
            and "Security Verification" not in t
            and "Checking your browser" not in t
        ):
            return True
        page.wait_for_timeout(1000)
    return False


def extract_video_from_dom_and_network(page, post_url):
    """
    Visits post page with Playwright, intercepts network requests/responses,
    clicks player overlays across frames, and extracts direct video sources from DOM.
    """
    captured_urls = []

    def handle_request(request):
        url = request.url
        if "data.cdn.avsee.is" in url or ".mp4" in url:
            if "blob:" not in url and url not in captured_urls:
                captured_urls.append(url)

    def handle_response(response):
        url = response.url
        if "data.cdn.avsee.is" in url or ".mp4" in url:
            if "blob:" not in url and url not in captured_urls:
                captured_urls.append(url)

    page.on("request", handle_request)
    page.on("response", handle_response)

    try:
        page.goto(post_url, wait_until="commit", timeout=45000)
        wait_for_cloudflare_clearance(page, max_wait=10)

        # Trigger player overlay click to unlock streams
        try:
            click_player_overlay(page, timeout=3000)
        except Exception:
            pass

        # Inspect DOM video elements across all frames and attempt muted play
        dom_sources = []
        for frame in page.frames:
            try:
                videos = frame.locator(VIDEO_SELECTOR)
                sources = videos.evaluate_all("""videos => videos.flatMap(v =>
                    [v.currentSrc, v.getAttribute('src'),
                     ...Array.from(v.querySelectorAll('source[src]'), s => s.getAttribute('src'))]
                    .filter(s => s && s.trim())
                    .map(s => new URL(s, v.baseURI).href))""")
                for s in sources:
                    if s and "blob:" not in s and s not in dom_sources:
                        dom_sources.append(s)

                if videos.count() > 0:
                    videos.evaluate_all("""videos => { for (const v of videos) {
                        v.muted = true; v.play().catch(() => {});
                    }}""")
            except Exception:
                continue

        page.wait_for_timeout(1500)

        # Extract title and fallback video tags from HTML
        html_content = page.content()
        soup = BeautifulSoup(html_content, "html.parser")

        title = ""
        title_tag = (
            soup.select_one("#bo_v_title")
            or soup.select_one(".bo_v_tit")
            or soup.select_one("#bo_v_subj")
            or soup.select_one("h1.bo_v_tit")
            or soup.select_one("h2.bo_v_tit")
            or soup.select_one("article header h1")
        )

        if title_tag:
            title = title_tag.get_text(strip=True)
        elif soup.title and soup.title.string:
            title = soup.title.string.strip().split(">")[0].strip()
        else:
            title = "Unknown Title"

        title = html.unescape(title)

        # Combine captured network streams and DOM video sources
        candidate_urls = captured_urls + dom_sources
        mp4_url = None

        for u in candidate_urls:
            if u and ("data.cdn" in u or ".mp4" in u) and "blob:" not in u:
                mp4_url = u
                break

        # Fallback regex search on raw HTML
        if not mp4_url:
            match = re.search(
                r'https://data\.cdn\.avsee\.is/[^\s"\'<>]+\.mp4[^\s"\'<>]*', html_content
            )
            if match:
                mp4_url = match.group(0)

        if not mp4_url:
            match = re.search(
                r'https://data\.cdn\.avsee\.is/bcdn_token=[^\s"\'<>]+', html_content
            )
            if match:
                mp4_url = match.group(0)

        if mp4_url:
            mp4_url = html.unescape(mp4_url)

        return {"title": title, "mp4_download_url": mp4_url, "post_url": post_url}
    except Exception as e:
        return {
            "title": "Error",
            "mp4_download_url": None,
            "post_url": post_url,
            "error": str(e),
        }
    finally:
        page.remove_listener("request", handle_request)
        page.remove_listener("response", handle_response)


def run_bj_scraper(
    board="korea", start_page=1, end_page=None, output_file="bj_videos.json"
):
    saved_data = {}
    if os.path.exists(output_file):
        try:
            with open(output_file, "r", encoding="utf-8") as f:
                for item in json.load(f):
                    if item.get("post_url"):
                        saved_data[item["post_url"]] = item
            print(f"[*] Resuming checkpoint: {len(saved_data)} items already saved.")
        except Exception:
            pass

    PROFILE_DIR.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        context = None
        launch_args = [
            "--disable-blink-features=AutomationControlled",
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-infobars",
            "--window-size=1920,1080",
        ]

        try:
            context = p.chromium.launch_persistent_context(
                str(PROFILE_DIR.resolve()),
                headless=True,
                args=launch_args,
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                    " (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
                ),
                viewport={"width": 1920, "height": 1080},
                locale="en-US",
                timezone_id="Asia/Seoul",
            )
        except Exception:
            try:
                browser = p.chromium.launch(headless=True, args=launch_args)
                context = browser.new_context(
                    user_agent=(
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                        " (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
                    ),
                    viewport={"width": 1920, "height": 1080},
                    locale="en-US",
                    timezone_id="Asia/Seoul",
                )
            except Exception as e:
                print(f"[!] Playwright browser launch error: {e}", flush=True)
                raise

        try:
            context.add_init_script("""
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                window.chrome = { runtime: {}, app: {}, loadTimes: function() {}, csi: function() {} };
                Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'ko'] });
                Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            """)

            page = context.pages[0] if context.pages else context.new_page()

            if end_page is None:
                url = f"{BASE_URL}{board}&page=1"
                print(f"[*] Detecting total board pages from {url}...")
                page.goto(url, wait_until="commit", timeout=45000)
                wait_for_cloudflare_clearance(page, max_wait=10)
                soup = BeautifulSoup(page.content(), "html.parser")
                page_numbers = [1]
                for a in soup.find_all("a", href=re.compile(r"page=(\d+)")):
                    m = re.search(r"page=(\d+)", a.get("href", ""))
                    if m:
                        page_numbers.append(int(m.group(1)))
                end_page = max(page_numbers)
                print(f"[+] Total pages detected: {end_page}")

            print(f"\n=======================================================")
            print(f"[*] Starting Playwright Video Scraper (Pages {start_page} to {end_page})")
            print(f"[*] Board: {board} | Output: {output_file}")
            print(f"=======================================================\n")

            for page_num in range(start_page, end_page + 1):
                page_board_url = f"{BASE_URL}{board}&page={page_num}"
                print(f"[*] [Page {page_num}/{end_page}] Loading: {page_board_url}")

                page.goto(page_board_url, wait_until="commit", timeout=45000)
                wait_for_cloudflare_clearance(page, max_wait=10)

                # Scroll to load lazy items
                try:
                    page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                    page.wait_for_timeout(800)
                except Exception:
                    pass

                post_links = []
                try:
                    # 1. Playwright locator evaluation (matching video-tools)
                    anchors = page.locator(".main-box .post-image a[href], a[href*='wr_id=']").evaluate_all("""anchors => anchors
                        .filter(a => (a.getAttribute('href') || '').trim() && !a.getAttribute('href').trim().startsWith('#'))
                        .map(a => a.href).filter(u => u.startsWith('https://') || u.startsWith('http://'))""")
                    for u in anchors:
                        clean_u = u.split("&page=")[0]
                        if clean_u not in post_links:
                            post_links.append(clean_u)
                except Exception:
                    pass

                # 2. BeautifulSoup fallback if locator returned empty
                if not post_links:
                    soup = BeautifulSoup(page.content(), "html.parser")
                    for a in soup.find_all(
                        "a", href=lambda h: h and f"bo_table={board}&wr_id=" in h
                    ):
                        href = a.get("href", "")
                        full_url = (
                            href if href.startswith("http") else f"https://02.avsee.is{href}"
                        )
                        clean_url = full_url.split("&page=")[0]
                        if clean_url not in post_links:
                            post_links.append(clean_url)

                # 3. If high page number returned 0 links, automatically fallback to page 1
                if not post_links and page_num > 1:
                    print(f"    [!] Page {page_num} is beyond board ceiling. Falling back to page 1...")
                    page.goto(f"{BASE_URL}{board}&page=1", wait_until="commit", timeout=45000)
                    wait_for_cloudflare_clearance(page, max_wait=10)
                    try:
                        anchors = page.locator(".main-box .post-image a[href], a[href*='wr_id=']").evaluate_all("""anchors => anchors
                            .filter(a => (a.getAttribute('href') || '').trim() && !a.getAttribute('href').trim().startsWith('#'))
                            .map(a => a.href).filter(u => u.startsWith('https://') || u.startsWith('http://'))""")
                        for u in anchors:
                            clean_u = u.split("&page=")[0]
                            if clean_u not in post_links:
                                post_links.append(clean_u)
                    except Exception:
                        pass

                print(f"    [+] Discovered {len(post_links)} candidate post links on page {page_num}")

                now = time.time()
                for idx, post_url in enumerate(post_links, 1):
                    cached = saved_data.get(post_url)
                    if (
                        cached
                        and cached.get("mp4_download_url")
                        and (now - cached.get("scraped_at", 0) < 3600)
                    ):
                        print(f"    [{idx}/{len(post_links)}] (Cached) {cached['title']}")
                        continue

                    item = extract_video_from_dom_and_network(page, post_url)
                    item["page"] = page_num
                    item["category"] = "bj"
                    item["board"] = board
                    item["scraped_at"] = now
                    item["page_url"] = post_url
                    if item.get("mp4_download_url"):
                        item["video_urls"] = [item["mp4_download_url"]]
                        item["status"] = "found"
                    else:
                        item["video_urls"] = []
                        item["status"] = "not_found"

                    if (
                        item.get("mp4_download_url")
                        and not item.get("title", "").startswith("Just a moment")
                        and item.get("title") != "Error"
                    ):
                        saved_data[post_url] = item
                        print(f"        Title:   {item['title']}")
                        print(f"        MP4 URL: {item['mp4_download_url']}\n")
                    else:
                        print(f"        Title:   {item.get('title')}")
                        print(f"        MP4 URL: Not found (Skipped)\n")

                # Save checkpoint after each page
                with open(output_file, "w", encoding="utf-8") as f:
                    json.dump(list(saved_data.values()), f, ensure_ascii=False, indent=2)

                csv_file = output_file.replace(".json", ".csv")
                with open(csv_file, "w", newline="", encoding="utf-8-sig") as f:
                    writer = csv.DictWriter(
                        f,
                        fieldnames=[
                            "title",
                            "mp4_download_url",
                            "post_url",
                            "page",
                            "category",
                            "board",
                        ],
                    )
                    writer.writeheader()
                    for v in saved_data.values():
                        writer.writerow(
                            {
                                "title": v.get("title", ""),
                                "mp4_download_url": v.get("mp4_download_url", ""),
                                "post_url": v.get("post_url", ""),
                                "page": v.get("page", ""),
                                "category": "bj",
                                "board": v.get("board", board),
                            }
                        )

                print(
                    f"    [+] Checkpoint saved: {len(saved_data)} total items in '{output_file}'.\n"
                )
        finally:
            if context:
                try:
                    context.close()
                except Exception:
                    pass

    print(
        f"\n[+] Playwright Scraping Completed! Output saved to '{output_file}' and '{output_file.replace('.json', '.csv')}'"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Playwright Video Scraper")
    parser.add_argument("--board", default="korea", help="Board name (default: korea)")
    parser.add_argument("--start", type=int, default=1, help="Start page")
    parser.add_argument("--end", type=int, default=None, help="End page")
    parser.add_argument(
        "--output",
        default="bj_videos.json",
        help="Output JSON filename (default: bj_videos.json)",
    )
    args = parser.parse_args()
    run_bj_scraper(
        board=args.board,
        start_page=args.start,
        end_page=args.end,
        output_file=args.output,
    )
