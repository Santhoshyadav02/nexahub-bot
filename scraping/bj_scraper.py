import argparse
import csv
import html
import json
import os
import re
import sys
import time
from pathlib import Path
import requests
from bs4 import BeautifulSoup

BASE_URL = "https://02.avsee.is/bbs/board.php?bo_table="

DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        " (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"
    ),
    "Accept-Language": "en-US,en;q=0.9,ko;q=0.8",
    "Referer": "https://02.avsee.is/",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Ch-Ua": '"Not-A.Brand";v="99", "Chromium";v="124", "Google Chrome";v="124"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-User": "?1",
}


def extract_video_from_html(html_text, post_url=""):
    """
    Parses HTML content using BeautifulSoup and regex to extract
    video title and direct CDN token download URL.
    """
    soup = BeautifulSoup(html_text, "html.parser")

    # 1. Extract Title
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

    # 2. Extract Video MP4 URL
    mp4_url = None

    # Check <video> tags
    for video in soup.find_all("video"):
        src = video.get("src", "")
        if src and "data.cdn.avsee.is" in src:
            mp4_url = src
            break

    # Check <source> tags
    if not mp4_url:
        for src_tag in soup.find_all("source"):
            src = src_tag.get("src", "")
            if src and "data.cdn.avsee.is" in src:
                mp4_url = src
                break

    # Regex search for CDN MP4 stream URLs (with bcdn_token)
    if not mp4_url:
        match = re.search(
            r'https://data\.cdn\.avsee\.is/[^\s"\'<>]+\.mp4[^\s"\'<>]*', html_text
        )
        if match:
            mp4_url = match.group(0)

    # Regex search for bcdn_token URL parameter
    if not mp4_url:
        match = re.search(
            r'https://data\.cdn\.avsee\.is/bcdn_token=[^\s"\'<>]+', html_text
        )
        if match:
            mp4_url = match.group(0)

    # Unescape HTML entities (e.g. &amp; -> &) in query params
    if mp4_url:
        mp4_url = html.unescape(mp4_url)

    return title, mp4_url


def fetch_post_http(session, post_url):
    """
    Sends direct GET request to extract title and video stream.
    """
    try:
        resp = session.get(post_url, headers=DEFAULT_HEADERS, timeout=25)
        if resp.status_code == 200:
            title, mp4_url = extract_video_from_html(resp.text, post_url)
            return {
                "title": title,
                "mp4_download_url": mp4_url,
                "post_url": post_url,
                "method": "http",
            }
        else:
            return {
                "title": f"HTTP {resp.status_code}",
                "mp4_download_url": None,
                "post_url": post_url,
                "method": "http",
            }
    except Exception as e:
        return {
            "title": "Error",
            "mp4_download_url": None,
            "post_url": post_url,
            "error": str(e),
            "method": "http",
        }


def get_board_post_links(session, board_url, board):
    """
    Extracts all candidate post links from a board page using BeautifulSoup.
    """
    post_links = []
    try:
        resp = session.get(board_url, headers=DEFAULT_HEADERS, timeout=25)
        if resp.status_code == 200:
            soup = BeautifulSoup(resp.text, "html.parser")
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
    except Exception:
        pass
    return post_links


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

    session = requests.Session()
    session.headers.update(DEFAULT_HEADERS)

    if end_page is None:
        end_page = start_page + 1

    print(f"\n=======================================================")
    print(f"[*] Starting BeautifulSoup/HTTP Video Scraper (Pages {start_page} to {end_page})")
    print(f"[*] Board: {board} | Output: {output_file}")
    print(f"=======================================================\n")

    for page_num in range(start_page, end_page + 1):
        page_board_url = f"{BASE_URL}{board}&page={page_num}"
        print(f"[*] [Page {page_num}/{end_page}] Requesting: {page_board_url}")

        post_links = get_board_post_links(session, page_board_url, board)
        print(f"    [+] Found {len(post_links)} post link(s) on page {page_num}")

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

            print(f"    [{idx}/{len(post_links)}] Extracting video from: {post_url}")
            item = fetch_post_http(session, post_url)
            item["page"] = page_num
            item["category"] = "bj"
            item["board"] = board
            item["scraped_at"] = now

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

            time.sleep(0.5)

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

    print(
        f"\n[+] Scraping Completed! Output saved to '{output_file}' and '{output_file.replace('.json', '.csv')}'"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="BeautifulSoup Video Scraper")
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
