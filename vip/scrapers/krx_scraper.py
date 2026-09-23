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

DEFAULT_KRX_URL = "https://krx18.com/genre/korea/"
BASE_URL = "https://krx18.com"


def sanitize_filename(name):
    """Sanitizes string for valid Windows filenames."""
    if not name or name.strip() == "":
        name = "untitled_video"
    name = html.unescape(name)
    sanitized = re.sub(r'[\\/*?:"<>|]', "", name).strip()
    return sanitized[:100]


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
                    "category": "18+",
                }
            )


def extract_video_and_title(page, post_url):
    """
    Visits a KRX18 video post page using Playwright,
    extracts the clean title, and captures direct .mp4 / .m3u8 stream URLs.
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
                "challenge-platform",
                "speculation",
                "analytics",
                "google",
                "doubleclick",
                "preview",
                "thumb",
                "banner",
                "favicon",
            ]
        ):
            return False
        if url.startswith("blob:"):
            return False
        return (
            ".m3u8" in url_lower
            or ".mp4" in url_lower
            or "bkcdn.net" in url_lower
            or "bxcdn.net" in url_lower
            or "sacdnssedge.com" in url_lower
            or "/video/" in url_lower
            or "/stream/" in url_lower
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
                "video, iframe, .player, #player, .video-player", timeout=8000
            )
        except Exception:
            pass

        # Try to interact with player if stream not immediately fired
        page.wait_for_timeout(2000)
        if not stream_urls:
            try:
                for selector in [
                    "video",
                    "iframe",
                    ".play-btn",
                    ".jw-display-icon-container",
                    ".vjs-big-play-button",
                ]:
                    elem = page.query_selector(selector)
                    if elem:
                        elem.click(timeout=1500)
                        page.wait_for_timeout(1500)
                        break
            except Exception:
                pass

        soup = BeautifulSoup(page.content(), "html.parser")

        # 1. Title Extraction
        title = ""
        title_tag = (
            soup.select_one("h1.entry-title")
            or soup.select_one("h1.post-title")
            or soup.select_one("h1.title")
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
            title = soup.title.string.strip().split(" - ")[0].split(" | ")[0].strip()
        else:
            title = "Untitled Video"

        title = html.unescape(title)

        # 2. Direct Video URL Extraction
        video_url_found = None

        # Check intercepted video stream requests
        if stream_urls:
            # Prefer direct .mp4 or .m3u8
            m3u8_mp4 = [u for u in stream_urls if ".mp4" in u or ".m3u8" in u]
            video_url_found = m3u8_mp4[0] if m3u8_mp4 else stream_urls[0]

        # Check frames
        if not video_url_found:
            for frame in page.frames:
                try:
                    f_soup = BeautifulSoup(frame.content(), "html.parser")
                    for source in f_soup.find_all(["source", "video"]):
                        src = source.get("src", "")
                        if (
                            src
                            and not src.startswith("blob:")
                            and (".mp4" in src or ".m3u8" in src)
                        ):
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
                if (
                    src
                    and not src.startswith("blob:")
                    and (".mp4" in src or ".m3u8" in src)
                ):
                    video_url_found = urljoin(BASE_URL, src)
                    break

        # Check iframe src if embedded player
        if not video_url_found:
            for iframe in soup.select("iframe"):
                src = iframe.get("src", "")
                if (
                    src
                    and "disqus.com" not in src
                    and "facebook.com" not in src
                    and "twitter.com" not in src
                    and is_valid_media_url(src)
                ):
                    video_url_found = urljoin(BASE_URL, src)
                    break

        # Check script player configurations
        if not video_url_found:
            script_patterns = [
                r'["\'](https?://[^"\']+\.(?:mp4|m3u8)[^"\']*)["\']',
                r'(?:file|source|src|video_url|videoUrl|hls)\s*:\s*["\'](https?://[^"\']+)["\']',
            ]
            for script in soup.find_all("script"):
                script_text = script.string or script.get_text() or ""
                for pattern in script_patterns:
                    match = re.search(pattern, script_text)
                    if match:
                        raw_url = match.group(1)
                        if (
                            "thumb" not in raw_url
                            and "preview" not in raw_url
                            and is_valid_media_url(raw_url)
                        ):
                            video_url_found = urljoin(BASE_URL, raw_url)
                            break
                if video_url_found:
                    break

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


def get_krx_page_url(base_url, page_num):
    """Constructs pagination URL (e.g. /page/2/ or ?page=2)."""
    base_clean = base_url.rstrip("/")
    if page_num <= 1:
        return f"{base_clean}/"
    if re.search(r"/page/\d+$", base_clean):
        base_clean = re.sub(r"/page/\d+$", "", base_clean)
    return f"{base_clean}/page/{page_num}/"


def run_krx_scraper(
    target_url=DEFAULT_KRX_URL,
    start_page=1,
    end_page=None,
    output_file="krx_videos.json",
    refresh=False,
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

    with sync_playwright() as p:
        browser = p.chromium.launch(
            channel="chrome",
            headless=True,
            args=["--disable-blink-features=AutomationControlled"],
        )
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        )
        page = context.new_page()

        if end_page is None:
            print(f"[*] Detecting total pages from {target_url}...")
            try:
                page.goto(target_url, wait_until="domcontentloaded", timeout=45000)
                for _ in range(10):
                    if "Just a moment" not in page.title():
                        break
                    page.wait_for_timeout(1000)
                soup = BeautifulSoup(page.content(), "html.parser")
                detected_pages = [1]
                for a in soup.find_all("a", href=True):
                    href = a.get("href", "")
                    m = re.search(r"/page/(\d+)/?", href) or re.search(
                        r"page=(\d+)", href
                    )
                    if m:
                        detected_pages.append(int(m.group(1)))
                end_page = max(detected_pages)
                print(f"[+] Total pages detected: {end_page}")
            except Exception as e:
                print(f"[!] Warning detecting total pages: {e}. Defaulting to 1.")
                end_page = 1

        print(f"\n=======================================================")
        print(f"[*] Starting 18+ (KRX18) Scraper (Pages {start_page} to {end_page})")
        print(f"[*] Target URL: {target_url}")
        print(f"=======================================================\n")

        try:
            for page_num in range(start_page, end_page + 1):
                current_page_url = get_krx_page_url(target_url, page_num)
                print(f"[*] [Page {page_num}/{end_page}] Loading: {current_page_url}")

                page.goto(
                    current_page_url, wait_until="domcontentloaded", timeout=45000
                )
                for _ in range(10):
                    if "Just a moment" not in page.title():
                        break
                    page.wait_for_timeout(1000)

                soup = BeautifulSoup(page.content(), "html.parser")
                post_links = []

                # Excluded navigational patterns
                excluded_patterns = [
                    "/genre/",
                    "/tag/",
                    "/category/",
                    "/page/",
                    "/about",
                    "/contact",
                    "/terms",
                    "/privacy",
                    "/dmca",
                    "/search",
                ]

                for a in soup.find_all("a", href=True):
                    href = a.get("href", "").strip()
                    if (
                        href
                        and not href.startswith("#")
                        and href.rstrip("/")
                        not in [
                            "/movies",
                            "https://krx18.com/movies",
                            "http://krx18.com/movies",
                        ]
                        and not any(x in href for x in excluded_patterns)
                        and (
                            re.search(r"/movies/[a-zA-Z0-9_-]+/?$", href)
                            or re.search(r"/[a-zA-Z0-9_-]+\.html$", href)
                            or "/video/" in href
                        )
                    ):
                        full_url = urljoin(BASE_URL, href)
                        if full_url not in post_links and full_url.rstrip("/") not in [
                            f"{BASE_URL}/movies",
                            target_url.rstrip("/"),
                            BASE_URL,
                        ]:
                            post_links.append(full_url)

                # Fallback video card selectors (article links)
                if not post_links:
                    for article in soup.select(
                        "article a, .video-item a, .thumb a, .item-video a"
                    ):
                        href = article.get("href", "")
                        if (
                            href
                            and not href.startswith("#")
                            and not any(x in href for x in excluded_patterns)
                        ):
                            full_url = urljoin(BASE_URL, href)
                            if full_url not in post_links and full_url != target_url:
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
                    item["category"] = "18+"
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
        f"\n[+] 18+ Scraping Completed! Output saved to '{output_file}' and '{output_file.replace('.json', '.csv')}'"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="18+ (KRX18) Video Scraper")
    parser.add_argument(
        "--url",
        default=DEFAULT_KRX_URL,
        help=f"Target URL (default: {DEFAULT_KRX_URL})",
    )
    parser.add_argument(
        "--start", type=int, default=1, help="Start page number (default: 1)"
    )
    parser.add_argument("--end", type=int, default=None, help="End page number")
    parser.add_argument(
        "--output",
        default="krx_videos.json",
        help="Output JSON filename (default: krx_videos.json)",
    )
    parser.add_argument(
        "--refresh",
        action="store_true",
        help="Force refresh URLs even if already cached in JSON",
    )
    args = parser.parse_args()
    run_krx_scraper(
        target_url=args.url,
        start_page=args.start,
        end_page=args.end,
        output_file=args.output,
        refresh=args.refresh,
    )
