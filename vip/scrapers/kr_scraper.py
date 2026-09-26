import argparse
import csv
import html
import json
import os
import re
import time
from urllib.parse import urljoin
from playwright.sync_api import sync_playwright
from bs4 import BeautifulSoup

DEFAULT_TAG_URL = "https://missav123.com/en/tags/South%20Korea"
BASE_URL = "https://missav123.com"


def sanitize_filename(name):
    """Sanitizes string for valid Windows filenames."""
    if not name or name.strip() == "":
        name = "untitled_video"
    name = html.unescape(name)
    sanitized = re.sub(r'[\\/*?:"<>|\'`]', "", name).strip()
    return sanitized[:100]


def clean_kr_title(title):
    """
    Removes leading video code prefixes (like MFK0084, MFK-0084, [MFK0084], etc.)
    and bracketed tags so that only the descriptive sentence title is saved.
    """
    if not title:
        return ""
    cleaned = re.sub(r"\[.*?\]", "", title)
    cleaned = re.sub(r"^[A-Za-z0-9_\-]+(?:\s*[-:]\s*|\s+)", "", cleaned.strip())
    cleaned = re.sub(r"^\s*[-:/]\s*", "", cleaned)
    cleaned = cleaned.strip()
    return cleaned if cleaned else title.strip()


def save_checkpoint(output_file, saved_data):
    """Saves checkpoint data immediately to both JSON and CSV."""
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(list(saved_data.values()), f, ensure_ascii=False, indent=2)

    csv_file = output_file.replace(".json", ".csv")
    with open(csv_file, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=["title", "mp4_download_url", "post_url", "page", "category"],
        )
        writer.writeheader()
        for v in saved_data.values():
            writer.writerow(
                {
                    "title": v.get("title", ""),
                    "mp4_download_url": v.get("mp4_download_url", ""),
                    "post_url": v.get("post_url", ""),
                    "page": v.get("page", ""),
                    "category": "kr",
                }
            )


def extract_video_and_title(page, post_url):
    """
    Visits a MissAV video post page using Playwright,
    extracts the clean title, and captures the direct .m3u8 / .mp4 video stream URL.
    """
    stream_urls = []

    def is_valid_media_url(url):
        url_lower = url.lower()
        if any(
            bad in url_lower
            for bad in [
                ".css",
                ".js",
                ".png",
                ".jpg",
                ".jpeg",
                ".gif",
                ".svg",
                ".webp",
                ".woff",
                ".ttf",
                "preview",
                "thumb",
                "banner",
                "analytics",
                "google",
                "doubleclick",
            ]
        ):
            return False
        if url.startswith("blob:"):
            return False
        return (
            ".m3u8" in url_lower
            or ".mp4" in url_lower
            or "playlist" in url_lower
            or "surrit.com" in url_lower
            or "sixyik.com" in url_lower
            or "eightyik.com" in url_lower
            or "/video/" in url_lower
        )

    def handle_request(request):
        url = request.url
        if is_valid_media_url(url):
            if url not in stream_urls:
                stream_urls.append(url)

    page.on("request", handle_request)

    try:
        page.goto(post_url, wait_until="domcontentloaded", timeout=45000)

        # Wait for Cloudflare clearance if present
        for _ in range(10):
            if "Just a moment" not in page.title():
                break
            page.wait_for_timeout(1000)

        # Allow player initialization
        try:
            page.wait_for_selector(
                "video, #player, .plyr, iframe, button[aria-label='Play']",
                timeout=8000,
            )
        except Exception:
            pass

        page.wait_for_timeout(2000)

        # Try clicking play button if stream not yet fired
        if not stream_urls:
            try:
                for selector in [
                    "button.plyr__control--overlaid",
                    ".plyr__control",
                    "button[aria-label='Play']",
                    "video",
                    "#player",
                    ".play-button",
                ]:
                    btn = page.query_selector(selector)
                    if btn:
                        btn.click(timeout=1500)
                        page.wait_for_timeout(1500)
                        break
            except Exception:
                pass

        page_content = page.content()
        soup = BeautifulSoup(page_content, "html.parser")

        # 1. Title Extraction
        title = ""
        title_tag = (
            soup.select_one("h1.text-base")
            or soup.select_one("h1.text-lg")
            or soup.select_one("h1.text-xl")
            or soup.select_one("h1")
            or soup.select_one("meta[property='og:title']")
            or soup.select_one("meta[name='twitter:title']")
        )

        if title_tag:
            if title_tag.name == "meta":
                title = title_tag.get("content", "").strip()
            else:
                title = title_tag.get_text(strip=True)
        elif soup.title and soup.title.string:
            title = soup.title.string.strip().split(" | ")[0].split(" - ")[0].strip()
        else:
            title = "Untitled Video"

        title = html.unescape(title)
        title = clean_kr_title(title)

        # 2. Video Stream URL Extraction
        video_url_found = None

        # Check intercepted m3u8/mp4 requests (prefer playlist.m3u8 or direct master.m3u8)
        if stream_urls:
            m3u8s = [u for u in stream_urls if ".m3u8" in u or "playlist" in u]
            mp4s = [u for u in stream_urls if ".mp4" in u]
            if m3u8s:
                video_url_found = m3u8s[0]
            elif mp4s:
                video_url_found = mp4s[0]
            else:
                video_url_found = stream_urls[0]

        # Check frames
        if not video_url_found:
            for frame in page.frames:
                try:
                    f_content = frame.content()
                    f_soup = BeautifulSoup(f_content, "html.parser")
                    for source in f_soup.find_all(["source", "video"]):
                        src = source.get("src", "")
                        if src and is_valid_media_url(src):
                            video_url_found = urljoin(BASE_URL, src)
                            break
                    if video_url_found:
                        break
                except Exception:
                    pass

        # Check DOM <video> and <source>
        if not video_url_found:
            for source in soup.find_all(["source", "video"]):
                src = source.get("src", "")
                if src and is_valid_media_url(src):
                    video_url_found = urljoin(BASE_URL, src)
                    break

        # Check embedded scripts / regex in page content (MissAV stores playlist URLs or surrit UUIDs in JS)
        if not video_url_found:
            patterns = [
                r'["\'](https?://[^"\']+\.(?:m3u8|mp4)[^"\']*)["\']',
                r'["\'](https?://[a-zA-Z0-9.-]*surrit\.com/[^"\']+)["\']',
                r'["\'](https?://[a-zA-Z0-9.-]*sixyik\.com/[^"\']+)["\']',
                r'["\'](https?://[a-zA-Z0-9.-]*eightyik\.com/[^"\']+)["\']',
                r'source\s*:\s*["\'](https?://[^"\']+)["\']',
                r'file\s*:\s*["\'](https?://[^"\']+)["\']',
            ]
            for pattern in patterns:
                matches = re.findall(pattern, page_content)
                for m in matches:
                    if is_valid_media_url(m):
                        video_url_found = m
                        break
                if video_url_found:
                    break

        # Check for UUID / playlist patterns e.g. https://surrit.com/{uuid}/playlist.m3u8
        if not video_url_found:
            uuid_match = re.search(
                r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
                page_content,
            )
            if uuid_match:
                uuid_str = uuid_match.group(1)
                video_url_found = f"https://surrit.com/{uuid_str}/playlist.m3u8"

        return {
            "title": title,
            "mp4_download_url": video_url_found,
            "post_url": post_url,
        }

    except Exception as e:
        return {
            "title": "Error",
            "mp4_download_url": None,
            "post_url": post_url,
            "error": str(e),
        }
    finally:
        page.remove_listener("request", handle_request)


def get_tag_page_url(base_url, page_num):
    """Constructs pagination URL e.g. https://missav123.com/en/tags/South%20Korea?page=2"""
    clean_base = re.sub(r"[?&]page=\d+", "", base_url)
    sep = "&" if "?" in clean_base else "?"
    if page_num <= 1:
        return f"{clean_base}{sep}page=1"
    return f"{clean_base}{sep}page={page_num}"


def run_kr_scraper(
    tag_url=DEFAULT_TAG_URL,
    start_page=1,
    end_page=None,
    output_file="kr_videos.json",
    refresh=False,
    proxy=None,
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

    browser_args = [
        "--disable-blink-features=AutomationControlled",
    ]

    launch_kwargs = {
        "channel": "chrome",
        "headless": True,
        "args": browser_args,
    }
    if proxy:
        launch_kwargs["proxy"] = {"server": proxy}

    with sync_playwright() as p:
        browser = p.chromium.launch(**launch_kwargs)
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        )
        page = context.new_page()

        if end_page is None:
            print(f"[*] Detecting total pages from {tag_url}...")
            try:
                first_page_url = get_tag_page_url(tag_url, 1)
                page.goto(first_page_url, wait_until="domcontentloaded", timeout=45000)
                for _ in range(10):
                    if "Just a moment" not in page.title():
                        break
                    page.wait_for_timeout(1000)
                soup = BeautifulSoup(page.content(), "html.parser")
                detected_pages = [1]
                for a in soup.find_all("a", href=True):
                    href = a.get("href", "")
                    match = re.search(r"page=(\d+)", href)
                    if match:
                        detected_pages.append(int(match.group(1)))
                end_page = max(detected_pages)
                print(f"[+] Total pages detected: {end_page}")
            except Exception as e:
                print(f"[!] Warning detecting total pages: {e}. Defaulting to 1.")
                end_page = 1

        print(f"\n=======================================================")
        print(f"[*] Starting KR (MissAV) Scraper (Pages {start_page} to {end_page})")
        print(f"[*] Target URL: {tag_url}")
        print(f"=======================================================\n")

        try:
            for page_num in range(start_page, end_page + 1):
                current_page_url = get_tag_page_url(tag_url, page_num)
                print(f"[*] [Page {page_num}/{end_page}] Loading: {current_page_url}")

                try:
                    page.goto(
                        current_page_url,
                        wait_until="domcontentloaded",
                        timeout=45000,
                    )
                except Exception as e:
                    print(f"[!] Failed to load {current_page_url}: {e}")
                    continue

                for _ in range(10):
                    if "Just a moment" not in page.title():
                        break
                    page.wait_for_timeout(1000)

                # Scroll down slightly to trigger lazy loading
                try:
                    page.evaluate("window.scrollBy(0, 1000)")
                    page.wait_for_timeout(1500)
                except Exception:
                    pass

                soup = BeautifulSoup(page.content(), "html.parser")
                post_links = []

                excluded_patterns = [
                    "/en/tags",
                    "/en/genres",
                    "/en/makers",
                    "/en/actresses",
                    "/en/directors",
                    "/en/series",
                    "/en/search",
                    "/en/login",
                    "/en/register",
                    "/en/vip",
                    "/en/dmca",
                    "/en/privacy-policy",
                    "/en/terms",
                    "/en/contact",
                    "/en/about",
                    "/en/saved",
                    "/en/playlists",
                    "/en/history",
                    "/en/new",
                    "/en/release",
                    "/en/uncensored-leak",
                    "/en/english-subtitle",
                    "/en/ads",
                    "/en/upload",
                    "/en/klive",
                    "/en/clive",
                    "/dm",
                ]

                # Target actual video cards first
                for card in soup.select(
                    "div.thumbnail a[href*='/en/'], a.text-secondary[href*='/en/'], div.my-2 a[href*='/en/']"
                ):
                    href = card.get("href", "").strip()
                    if href and not any(x in href for x in excluded_patterns):
                        full_url = urljoin(BASE_URL, href)
                        if full_url not in post_links:
                            post_links.append(full_url)

                # Fallback to general video links
                if not post_links:
                    for a in soup.find_all("a", href=True):
                        href = a.get("href", "").strip()
                        if (
                            href
                            and not href.startswith("#")
                            and not any(x in href for x in excluded_patterns)
                            and re.search(r"/en/[a-zA-Z0-9_-]+/?$", href)
                        ):
                            full_url = urljoin(BASE_URL, href)
                            clean_full = full_url.rstrip("/")
                            clean_tag = tag_url.split("?")[0].rstrip("/")
                            if (
                                full_url not in post_links
                                and clean_full != clean_tag
                                and clean_full != BASE_URL
                                and clean_full != f"{BASE_URL}/en"
                            ):
                                post_links.append(full_url)

                print(f"    -> Found {len(post_links)} video posts on page {page_num}.")

                for idx, post_url in enumerate(post_links, 1):
                    if (
                        not refresh
                        and post_url in saved_data
                        and saved_data[post_url].get("mp4_download_url")
                    ):
                        print(
                            f"    [{idx}/{len(post_links)}] (Cached) {saved_data[post_url].get('title', 'Video')}"
                        )
                        continue

                    print(f"    [{idx}/{len(post_links)}] Extracting: {post_url}")
                    item = extract_video_and_title(page, post_url)
                    item["page"] = page_num
                    item["category"] = "kr"
                    saved_data[post_url] = item

                    print(f"        Title:   {item['title']}")
                    print(
                        f"        Stream:  {item['mp4_download_url'] or 'Not found'}\n"
                    )

                    # Immediate per-item checkpoint save
                    save_checkpoint(output_file, saved_data)
                    time.sleep(0.3)

                print(
                    f"    [+] Checkpoint saved: {len(saved_data)} total items in '{output_file}'.\n"
                )

        except KeyboardInterrupt:
            print(
                "\n[!] Scraping paused by user. Saving current checkpoint...",
                flush=True,
            )
            save_checkpoint(output_file, saved_data)
            print(
                f"[+] Saved {len(saved_data)} items to '{output_file}'. You can resume anytime!"
            )
            browser.close()
            return

        browser.close()

    print(
        f"\n[+] KR Scraping Completed! Output saved to '{output_file}' and '{output_file.replace('.json', '.csv')}'"
    )


def run_single_url_extraction(url, proxy=None):
    """Extracts a freshly minted CDN token for a single MissAV post URL (JIT token resolution)."""
    with sync_playwright() as p:
        browser = p.chromium.launch(
            channel="chrome",
            headless=True,
            proxy={"server": proxy} if proxy else None,
            args=["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-dev-shm-usage"],
        )
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        )
        page = context.new_page()
        item = extract_video_and_title(page, url)
        item["category"] = "kr"
        browser.close()
        print(f"[JIT_TOKEN_RESULT] {json.dumps(item, ensure_ascii=False)}", flush=True)
        return item


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="KR (MissAV) Video Scraper")
    parser.add_argument(
        "--url",
        default=DEFAULT_TAG_URL,
        help="Tag URL to scrape or single post URL",
    )
    parser.add_argument(
        "--single-url",
        default=None,
        help="Extract fresh CDN stream token for a single post URL (Just-In-Time resolution)",
    )
    parser.add_argument(
        "--start", type=int, default=1, help="Start page number (default: 1)"
    )
    parser.add_argument("--end", type=int, default=None, help="End page number")
    parser.add_argument(
        "--output",
        default="kr_videos.json",
        help="Output JSON filename (default: kr_videos.json)",
    )
    parser.add_argument(
        "--refresh",
        action="store_true",
        help="Force refresh URLs even if already cached in JSON",
    )
    parser.add_argument(
        "--proxy",
        default=None,
        help="Optional proxy server (e.g. http://127.0.0.1:7890 or socks5://127.0.0.1:1080)",
    )
    args = parser.parse_args()
    if args.single_url:
        run_single_url_extraction(args.single_url, proxy=args.proxy)
    elif args.url and not ("/tags/" in args.url or "/tag/" in args.url) and args.url != DEFAULT_TAG_URL:
        run_single_url_extraction(args.url, proxy=args.proxy)
    else:
        run_kr_scraper(
            tag_url=args.url,
            start_page=args.start,
            end_page=args.end,
            output_file=args.output,
            refresh=args.refresh,
            proxy=args.proxy,
        )

