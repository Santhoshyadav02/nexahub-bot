import argparse
import csv
import html
import json
import os
import re
import time
from playwright.sync_api import sync_playwright
from bs4 import BeautifulSoup

BASE_URL = "https://02.avsee.is/bbs/board.php?bo_table="


def sanitize_filename(name):
    """Sanitizes string for valid Windows filenames."""
    if not name or name.strip() == "":
        name = "untitled_video"
    name = html.unescape(name)
    sanitized = re.sub(r'[\\/*?:"<>|]', "", name).strip()
    return sanitized[:100]


def clean_krx_title(title):
    """
    Cleans title by removing bracketed tags and leading video code prefixes
    (e.g., [REMOVE]FC2PPV-4920167ULA, FC2-PPV-12345) to preserve clean title text.
    """
    if not title:
        return ""
    # Remove bracketed tags like [REMOVE], [자막], [HD], etc.
    cleaned = re.sub(r"\[.*?\]", "", title)
    # Remove leading video codes (e.g. FC2PPV-4920167ULA, FC2-PPV-123456, etc.)
    cleaned = re.sub(r"^[A-Za-z0-9_\-]+(?:\s*[-:]\s*|\s+)", "", cleaned.strip())
    # Clean whitespace and leading/trailing separators
    cleaned = re.sub(r"\s+", " ", cleaned)
    cleaned = re.sub(r"^\s*[-:/]\s*", "", cleaned)
    cleaned = re.sub(r"\s*[-:/]\s*$", "", cleaned)
    cleaned = cleaned.strip()
    return cleaned if cleaned else title.strip()


def save_checkpoint(output_file, saved_data, board="javleak"):
    """Saves checkpoint data immediately to both JSON and CSV."""
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
                    "category": "18+",
                    "board": v.get("board", board),
                }
            )


def extract_video_and_title(page, post_url, max_retries=2):
    """
    Visits a post page, extracts the clean video title,
    and intercepts/extracts the direct CDN token MP4 download URL.
    """
    for attempt in range(1, max_retries + 1):
        cdn_video_urls = []

        def handle_request(request):
            url = request.url
            if "data.cdn.avsee.is" in url and ".mp4" in url:
                clean_u = html.unescape(url)
                if clean_u not in cdn_video_urls:
                    cdn_video_urls.append(clean_u)

        page.on("request", handle_request)

        try:
            page.goto(post_url, wait_until="domcontentloaded", timeout=45000)

            # Wait for Cloudflare clearance
            for _ in range(25):
                if "Just a moment" not in page.title():
                    break
                page.wait_for_timeout(1000)

            try:
                page.wait_for_selector(
                    "#bo_v_title, .bo_v_tit, #bo_v_subj, video, .jw-media, iframe",
                    timeout=12000,
                )
            except Exception:
                pass

            page.wait_for_timeout(2500)

            page_html = page.content()
            soup = BeautifulSoup(page_html, "html.parser")

            # Extract title from on-page elements
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

            # Check if Cloudflare blocked
            if "Just a moment" in title or title.strip() in ["a moment...", "Just a moment..."]:
                if attempt < max_retries:
                    page.remove_listener("request", handle_request)
                    page.wait_for_timeout(3000)
                    continue

            title = clean_krx_title(title)

            # Check DOM video tag as fallback
            for video in soup.find_all("video"):
                src = video.get("src", "")
                if "data.cdn.avsee.is" in src and ".mp4" in src:
                    clean_src = html.unescape(src)
                    if clean_src not in cdn_video_urls:
                        cdn_video_urls.append(clean_src)

            # Check page content and all frames with regex
            all_htmls = [page_html]
            for frame in page.frames:
                try:
                    all_htmls.append(frame.content())
                except Exception:
                    pass

            for content_str in all_htmls:
                matches = re.findall(
                    r'(?:src=[\'"])?(https://data\.cdn\.avsee\.is/[^\'"\s<>]+?\.mp4)',
                    content_str,
                )
                for m in matches:
                    clean_m = html.unescape(m)
                    if clean_m not in cdn_video_urls:
                        cdn_video_urls.append(clean_m)

            mp4_url = cdn_video_urls[0] if cdn_video_urls else None

            return {"title": title, "mp4_download_url": mp4_url, "post_url": post_url}
        except Exception as e:
            if attempt == max_retries:
                return {
                    "title": "Error",
                    "mp4_download_url": None,
                    "post_url": post_url,
                    "error": str(e),
                }
            page.wait_for_timeout(2000)
        finally:
            try:
                page.remove_listener("request", handle_request)
            except Exception:
                pass


def run_krx_scraper(
    board="javleak",
    start_page=1,
    end_page=None,
    output_file="krx_videos.json",
    refresh=False,
):
    saved_data = {}
    if os.path.exists(output_file) and not refresh:
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
            url = f"{BASE_URL}{board}&page=1"
            print(f"[*] Detecting total board pages from {url}...")
            page.goto(url, wait_until="domcontentloaded", timeout=45000)
            for _ in range(10):
                if "Just a moment" not in page.title():
                    break
                page.wait_for_timeout(1000)
            soup = BeautifulSoup(page.content(), "html.parser")
            page_numbers = [1]
            for a in soup.find_all("a", href=True):
                href = a.get("href", "")
                m = re.search(r"page=(\d+)", href)
                if m:
                    page_numbers.append(int(m.group(1)))
            end_page = max(page_numbers)
            print(f"[+] Total pages detected: {end_page}")

        print(f"\n=======================================================")
        print(f"[*] Starting KRX/18+ Scraper (Pages {start_page} to {end_page})")
        print(f"[*] Board: {board}")
        print(f"=======================================================\n")

        try:
            for page_num in range(start_page, end_page + 1):
                page_board_url = f"{BASE_URL}{board}&page={page_num}"
                print(f"[*] [Page {page_num}/{end_page}] Loading: {page_board_url}")

                page.goto(page_board_url, wait_until="domcontentloaded", timeout=45000)
                for _ in range(10):
                    if "Just a moment" not in page.title():
                        break
                    page.wait_for_timeout(1000)

                soup = BeautifulSoup(page.content(), "html.parser")
                post_links = []
                for a in soup.find_all(
                    "a", href=lambda h: h and f"bo_table={board}&wr_id=" in h
                ):
                    href = a.get("href", "")
                    full_url = (
                        href
                        if href.startswith("http")
                        else f"https://02.avsee.is{href}"
                    )
                    clean_url = full_url.split("&page=")[0]
                    if clean_url not in post_links:
                        post_links.append(clean_url)

                print(f"    -> Found {len(post_links)} posts on page {page_num}.")

                for idx, post_url in enumerate(post_links, 1):
                    if (
                        not refresh
                        and post_url in saved_data
                        and saved_data[post_url].get("mp4_download_url")
                    ):
                        print(
                            f"    [{idx}/{len(post_links)}] (Cached) {saved_data[post_url]['title']}"
                        )
                        continue

                    print(f"    [{idx}/{len(post_links)}] Extracting: {post_url}")
                    item = extract_video_and_title(page, post_url)
                    item["page"] = page_num
                    item["category"] = "18+"
                    item["board"] = board
                    saved_data[post_url] = item

                    print(f"        Title:   {item['title']}")
                    print(
                        f"        MP4 URL: {item['mp4_download_url'] or 'Not found'}\n"
                    )

                    # Immediate per-item checkpoint save
                    save_checkpoint(output_file, saved_data, board=board)

                print(
                    f"    [+] Checkpoint saved: {len(saved_data)} total items in '{output_file}'.\n"
                )

        except KeyboardInterrupt:
            print(
                "\n[!] Scraping paused by user. Saving current checkpoint...",
                flush=True,
            )
            save_checkpoint(output_file, saved_data, board=board)
            print(
                f"[+] Saved {len(saved_data)} items to '{output_file}'. You can resume anytime!"
            )
            browser.close()
            return

        browser.close()

    print(
        f"\n[+] KRX Scraping Completed! Output saved to '{output_file}' and '{output_file.replace('.json', '.csv')}'"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="KRX (javleak) Video Scraper")
    parser.add_argument(
        "--board", default="javleak", help="Board name (default: javleak)"
    )
    parser.add_argument("--start", type=int, default=1, help="Start page")
    parser.add_argument("--end", type=int, default=None, help="End page")
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
        board=args.board,
        start_page=args.start,
        end_page=args.end,
        output_file=args.output,
        refresh=args.refresh,
    )
