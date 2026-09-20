import argparse
import csv
import json
import os
import re
import time
from playwright.sync_api import sync_playwright
from bs4 import BeautifulSoup

BASE_URL = "https://02.avsee.is/bbs/board.php?bo_table="


def extract_video_and_title(page, post_url):
    cdn_video_urls = []

    def handle_request(request):
        url = request.url
        if "data.cdn.avsee.is" in url and ".mp4" in url:
            if url not in cdn_video_urls:
                cdn_video_urls.append(url)

    page.on("request", handle_request)

    try:
        page.goto(post_url, wait_until="domcontentloaded", timeout=45000)

        for _ in range(10):
            if "Just a moment" not in page.title():
                break
            page.wait_for_timeout(1000)

        try:
            page.wait_for_selector("video, .jw-media, iframe", timeout=8000)
        except Exception:
            pass

        page.wait_for_timeout(2500)

        soup = BeautifulSoup(page.content(), "html.parser")

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

        for video in soup.find_all("video"):
            src = video.get("src", "")
            if (
                "data.cdn.avsee.is" in src
                and ".mp4" in src
                and src not in cdn_video_urls
            ):
                cdn_video_urls.append(src)

        mp4_url = cdn_video_urls[0] if cdn_video_urls else None

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


def run_javc_scraper(
    board="javc", start_page=1, end_page=None, output_file="javc_videos.json"
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
            url = f"{BASE_URL}{board}&page=1"
            print(f"[*] Detecting total JAV Censored pages from {url}...")
            page.goto(url, wait_until="domcontentloaded", timeout=45000)
            for _ in range(10):
                if "Just a moment" not in page.title():
                    break
                page.wait_for_timeout(1000)
            soup = BeautifulSoup(page.content(), "html.parser")
            page_numbers = [1]
            for a in soup.find_all("a", href=re.compile(r"page=(\d+)")):
                m = re.search(r"page=(\d+)", a.get("href", ""))
                if m:
                    page_numbers.append(int(m.group(1)))
            end_page = max(page_numbers)
            print(f"[+] Total pages detected: {end_page}")

        print(f"\n=======================================================")
        print(f"[*] Starting JAV Censored Scraper (Pages {start_page} to {end_page})")
        print(f"=======================================================\n")

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
                    href if href.startswith("http") else f"https://02.avsee.is{href}"
                )
                clean_url = full_url.split("&page=")[0]
                if clean_url not in post_links:
                    post_links.append(clean_url)

            now = time.time()
            for idx, post_url in enumerate(post_links, 1):
                cached = saved_data.get(post_url)
                if (
                    cached
                    and cached.get("mp4_download_url")
                    and (now - cached.get("scraped_at", 0) < 3600)
                ):
                    print(
                        f"    [{idx}/{len(post_links)}] (Cached) {cached['title']}"
                    )
                    continue

                print(f"    [{idx}/{len(post_links)}] Extracting fresh video link: {post_url}")
                item = extract_video_and_title(page, post_url)
                item["page"] = page_num
                item["category"] = "javc"
                item["board"] = board
                item["scraped_at"] = now
                saved_data[post_url] = item

                print(f"        Title:   {item['title']}")
                print(f"        MP4 URL: {item['mp4_download_url'] or 'Not found'}\n")

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
                            "category": "javc",
                            "board": v.get("board", board),
                        }
                    )

            print(
                f"    [+] Checkpoint saved: {len(saved_data)} total items in '{output_file}'.\n"
            )

        browser.close()

    print(
        f"\n[+] JAV Censored Scraping Completed! Output saved to '{output_file}' and '{output_file.replace('.json', '.csv')}'"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="JAV Censored Video Scraper")
    parser.add_argument("--board", default="javc", help="Board name (default: javc)")
    parser.add_argument("--start", type=int, default=1, help="Start page")
    parser.add_argument("--end", type=int, default=None, help="End page")
    parser.add_argument(
        "--output", default="javc_videos.json", help="Output JSON filename"
    )
    args = parser.parse_args()
    run_javc_scraper(
        board=args.board,
        start_page=args.start,
        end_page=args.end,
        output_file=args.output,
    )
