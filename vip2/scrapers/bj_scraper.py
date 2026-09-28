import argparse
import csv
import json
import os
import re
import sys
import time
from playwright.sync_api import sync_playwright
from bs4 import BeautifulSoup

# Ensure unbuffered terminal output
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(line_buffering=True)


def extract_post_video_and_title(post_url):
    """
    Spawns a fresh browser context to visit the post URL directly,
    clearing Cloudflare and capturing the tokenized CDN MP4 URL.
    """
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-setuid-sandbox"
            ]
        )
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        )
        page = context.new_page()
        cdn_video_urls = []

        def handle_request(request):
            url = request.url
            if "data.cdn.avsee.is" in url and ".mp4" in url:
                if url not in cdn_video_urls:
                    cdn_video_urls.append(url)

        page.on("request", handle_request)

        try:
            page.goto(post_url, wait_until="domcontentloaded", timeout=45000)
            time.sleep(4)

            # Extract title
            soup = BeautifulSoup(page.content(), "html.parser")
            title_tag = (
                soup.select_one("#bo_v_title")
                or soup.select_one(".bo_v_tit")
                or soup.select_one("#bo_v_subj")
                or soup.select_one("h1.bo_v_tit")
                or soup.select_one("article header h1")
            )

            if title_tag:
                title = title_tag.get_text(strip=True)
            elif soup.title and soup.title.string:
                title = soup.title.string.strip().split(">")[0].strip()
            else:
                title = "BJ Video"

            mp4_url = cdn_video_urls[0] if cdn_video_urls else None
            browser.close()
            return {"title": title, "mp4_download_url": mp4_url, "post_url": post_url}
        except Exception as e:
            browser.close()
            return {"title": "Error", "mp4_download_url": None, "post_url": post_url, "error": str(e)}


def get_board_post_links(board="korea", limit=10):
    """
    Fetches latest post links from board page.
    """
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=["--disable-blink-features=AutomationControlled", "--no-sandbox"]
        )
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        )
        page = context.new_page()
        url = f"https://02.avsee.is/{board}"
        page.goto(url, wait_until="domcontentloaded", timeout=45000)
        time.sleep(4)

        soup = BeautifulSoup(page.content(), "html.parser")
        post_links = []
        for a in soup.find_all("a", href=True):
            href = a.get("href", "")
            if re.search(r"/korea/\d+|bo_table=korea&wr_id=\d+", href):
                full_url = href if href.startswith("http") else f"https://02.avsee.is{href}"
                clean_url = full_url.split("&page=")[0].split("?page=")[0].split("#")[0]
                if clean_url not in post_links:
                    post_links.append(clean_url)
                if len(post_links) >= limit:
                    break

        browser.close()
        return post_links


def run_bj_scraper(board="korea", limit=7, output_file="bj_videos.json"):
    print(f"\n=======================================================", flush=True)
    print(f"[*] Starting High-Speed BJ Scraper (Target: {limit} posts)", flush=True)
    print(f"=======================================================\n", flush=True)

    links = get_board_post_links(board=board, limit=limit)
    print(f"[+] Found {len(links)} candidate BJ posts on {board}.", flush=True)

    results = []
    for idx, post_url in enumerate(links, 1):
        print(f"[{idx}/{len(links)}] Extracting: {post_url}", flush=True)
        item = extract_post_video_and_title(post_url)
        item["category"] = "bj"
        item["board"] = board
        results.append(item)
        print(f"    Title:   {item['title']}", flush=True)
        print(f"    MP4 URL: {item['mp4_download_url'] or 'Not found'}\n", flush=True)

        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=2)

    print(f"[+] BJ Scraping Complete! Saved {len(results)} items to {output_file}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="BJ Video Scraper")
    parser.add_argument("--board", default="korea", help="Board name (default: korea)")
    parser.add_argument("--limit", type=int, default=7, help="Limit number of posts to scrape")
    parser.add_argument("--output", default="bj_videos.json", help="Output JSON filename")
    parser.add_argument("--start", type=int, default=1, help="Ignored (compatibility)")
    parser.add_argument("--end", type=int, default=1, help="Ignored (compatibility)")
    parser.add_argument("--refresh", action="store_true", help="Ignored (compatibility)")
    args = parser.parse_args()

    run_bj_scraper(board=args.board, limit=args.limit, output_file=args.output)
