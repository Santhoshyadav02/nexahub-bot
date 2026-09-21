import argparse
import csv
import html
import json
import os
import re
import sys
import time
from urllib.parse import urljoin
import requests
from bs4 import BeautifulSoup

DEFAULT_SERIES_URL = "https://en.xchina.co/videos/series-63824a975d8ae.html"
BASE_URL = "https://en.xchina.co"

DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://en.xchina.co/",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
}


def sanitize_filename(name):
    """Sanitizes string for valid filenames."""
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
                    "category": "xchina",
                }
            )


def extract_video_and_title(session, video_url, max_retries=2):
    """
    Visits an XChina video post page using HTTP GET,
    extracts the clean title, and searches for direct video stream or MP4 download URL.
    """
    for attempt in range(1, max_retries + 1):
        try:
            resp = session.get(video_url, headers=DEFAULT_HEADERS, timeout=20)
            if resp.status_code != 200:
                return {
                    "title": "Error",
                    "mp4_download_url": None,
                    "post_url": video_url,
                    "error": f"HTTP {resp.status_code}",
                }

            html_content = resp.text
            soup = BeautifulSoup(html_content, "html.parser")

            # 1. Title Extraction
            title = ""
            title_tag = (
                soup.select_one("h1.video-title")
                or soup.select_one("h1.entry-title")
                or soup.select_one("h1.title")
                or soup.select_one("h1")
                or soup.select_one(".page-title")
                or soup.select_one(".post-title")
                or soup.select_one("meta[property='og:title']")
            )

            if title_tag:
                if title_tag.name == "meta":
                    title = title_tag.get("content", "").strip()
                else:
                    title = title_tag.get_text(strip=True)
            elif soup.title and soup.title.string:
                title = (
                    soup.title.string.strip().split(" - ")[0].split(" | ")[0].strip()
                )
            else:
                title = "Untitled Video"

            title = html.unescape(title)

            # 2. Direct Video URL Extraction
            video_url_found = None

            # Check <video> and <source> tags
            for video in soup.find_all("video"):
                src = video.get("src")
                if src and not src.startswith("blob:"):
                    video_url_found = urljoin(BASE_URL, src)
                    break
                for source in video.find_all("source"):
                    src = source.get("src")
                    if src and not src.startswith("blob:"):
                        video_url_found = urljoin(BASE_URL, src)
                        break
                if video_url_found:
                    break

            # Check OpenGraph / Twitter meta tags
            if not video_url_found:
                for meta_prop in [
                    "og:video",
                    "og:video:url",
                    "og:video:secure_url",
                    "twitter:player:stream",
                ]:
                    meta_tag = soup.select_one(
                        f"meta[property='{meta_prop}'], meta[name='{meta_prop}']"
                    )
                    if meta_tag and meta_tag.get("content"):
                        video_url_found = urljoin(BASE_URL, meta_tag["content"])
                        break

            # Check inline JavaScript / player configuration
            if not video_url_found:
                script_patterns = [
                    r'(?:file|source|src|video_url|videoUrl|hls|streamUrl)\s*:\s*["\'](https?://[^"\']+\.(?:mp4|m3u8)[^"\']*)["\']',
                    r'(?:file|source|src|video_url|videoUrl|hls|streamUrl)\s*=\s*["\'](https?://[^"\']+\.(?:mp4|m3u8)[^"\']*)["\']',
                    r'["\'](https?://[^"\']+\.(?:mp4|m3u8)[^"\']*)["\']',
                    r'(?:file|source|src|video_url|videoUrl)\s*:\s*["\'](/[^"\']+\.(?:mp4|m3u8)[^"\']*)["\']',
                ]
                for script in soup.find_all("script"):
                    script_text = script.string or script.get_text() or ""
                    for pattern in script_patterns:
                        match = re.search(pattern, script_text)
                        if match:
                            raw_url = match.group(1)
                            video_url_found = urljoin(BASE_URL, raw_url)
                            break
                    if video_url_found:
                        break

            # Fallback iframe extraction
            if not video_url_found:
                iframe = soup.select_one(
                    "iframe[src*='embed'], iframe[src*='player'], iframe[src*='video']"
                )
                if iframe and iframe.get("src"):
                    video_url_found = urljoin(BASE_URL, iframe["src"])

            return {
                "title": title,
                "mp4_download_url": video_url_found,
                "post_url": video_url,
            }

        except Exception as e:
            if attempt < max_retries:
                time.sleep(1)
                continue
            return {
                "title": "Error",
                "mp4_download_url": None,
                "post_url": video_url,
                "error": str(e),
            }


def get_series_page_url(base_series_url, page_num):
    """Constructs series pagination URL."""
    if page_num <= 1:
        return base_series_url
    if "?" in base_series_url:
        return f"{base_series_url}&page={page_num}"
    if base_series_url.endswith(".html"):
        return re.sub(r"(-p\d+)?\.html$", f"-p{page_num}.html", base_series_url)
    return f"{base_series_url}?page={page_num}"


def extract_video_links_from_page(session, series_page_url):
    """
    Extracts individual video post URLs and detects total pages from a series/board page.
    """
    try:
        resp = session.get(series_page_url, headers=DEFAULT_HEADERS, timeout=25)
        if resp.status_code != 200:
            print(
                f"[!] Failed to load page: {series_page_url} (HTTP {resp.status_code})"
            )
            return [], 1

        soup = BeautifulSoup(resp.text, "html.parser")
        video_links = []

        # Find all video links
        for a in soup.find_all("a", href=True):
            href = a.get("href", "")
            if (
                ("/videos/" in href or "/video/" in href)
                and not href.startswith("#")
                and "series-" not in href
                and "category" not in href
                and "tag" not in href
            ):
                full_url = urljoin(BASE_URL, href)
                if full_url not in video_links:
                    video_links.append(full_url)

        # Detect pagination
        detected_pages = [1]
        for a in soup.find_all("a", href=True):
            href = a.get("href", "")
            match = re.search(r"page=(\d+)|-p(\d+)\.html", href)
            if match:
                num = int(match.group(1) or match.group(2))
                detected_pages.append(num)

        total_pages = max(detected_pages)
        return video_links, total_pages
    except Exception as e:
        print(f"[!] Error reading page: {e}")
        return [], 1


def run_xchina_scraper(
    series_url=DEFAULT_SERIES_URL,
    start_page=1,
    end_page=None,
    output_file="xchina_videos.json",
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

    session = requests.Session()

    if end_page is None:
        print(f"[*] Detecting total pages from {series_url}...")
        _, detected_total = extract_video_links_from_page(session, series_url)
        end_page = max(1, detected_total)
        print(f"[+] Total pages detected: {end_page}")

    print(f"\n=======================================================")
    print(f"[*] Starting XChina Scraper (Pages {start_page} to {end_page})")
    print(f"[*] Series URL: {series_url}")
    print(f"=======================================================\n")

    try:
        for page_num in range(start_page, end_page + 1):
            current_page_url = get_series_page_url(series_url, page_num)
            print(f"[*] [Page {page_num}/{end_page}] Loading: {current_page_url}")

            post_links, _ = extract_video_links_from_page(session, current_page_url)
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
                item = extract_video_and_title(session, post_url)
                item["page"] = page_num
                item["category"] = "xchina"
                saved_data[post_url] = item

                print(f"        Title:   {item['title']}")
                print(f"        Video:   {item['mp4_download_url'] or 'Not found'}\n")

                # Save checkpoint immediately per video
                save_checkpoint(output_file, saved_data)
                time.sleep(0.3)

            print(
                f"    [+] Checkpoint saved: {len(saved_data)} total items in '{output_file}'.\n"
            )

    except KeyboardInterrupt:
        print("\n[!] Scraping paused by user. Saving current checkpoint...", flush=True)
        save_checkpoint(output_file, saved_data)
        print(
            f"[+] Saved {len(saved_data)} items to '{output_file}'. You can resume anytime!"
        )
        return

    print(
        f"\n[+] XChina Scraping Completed! Output saved to '{output_file}' and '{output_file.replace('.json', '.csv')}'"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="XChina Series Video Scraper (GET + BeautifulSoup)"
    )
    parser.add_argument(
        "--url",
        default=DEFAULT_SERIES_URL,
        help=f"Series / Category URL (default: {DEFAULT_SERIES_URL})",
    )
    parser.add_argument(
        "--start", type=int, default=1, help="Start page number (default: 1)"
    )
    parser.add_argument("--end", type=int, default=None, help="End page number")
    parser.add_argument(
        "--output",
        default="xchina_videos.json",
        help="Output JSON filename (default: xchina_videos.json)",
    )
    parser.add_argument(
        "--refresh",
        action="store_true",
        help="Force refresh URLs even if already cached in JSON",
    )
    args = parser.parse_args()
    run_xchina_scraper(
        series_url=args.url,
        start_page=args.start,
        end_page=args.end,
        output_file=args.output,
        refresh=args.refresh,
    )
