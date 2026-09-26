"""
============================================================
🚀 MODULAR PARALLEL VIDEO DOWNLOADER (3-4 Concurrent Workers)
============================================================
Downloads discovered videos from modular scraper JSON databases
using a multi-worker concurrent thread pool (3-4 workers) with
resume capability, progress tracking, and validation.
"""

import argparse
import concurrent.futures
import json
import os
import re
import sys
import time
import requests

# Ensure unbuffered terminal output
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(line_buffering=True)

MAX_ALLOWED_FILE_BYTES = int(1.95 * 1024 * 1024 * 1024)  # 1.95 GB ceiling


def sanitize_filename(name):
    if not name or name.strip() == "":
        name = "untitled_video"
    sanitized = re.sub(r'[\\/*?:"<>|]', "", name).strip()
    return sanitized[:100]


def extract_fresh_token_jit(post_url, timeout=35):
    """
    Extracts a fresh streaming token for a single post URL just-in-time
    using Playwright headless browser.
    """
    if not post_url or not post_url.startswith("http"):
        return None
    try:
        from playwright.sync_api import sync_playwright
        from bs4 import BeautifulSoup

        with sync_playwright() as p:
            browser = p.chromium.launch(
                channel="chrome",
                headless=True,
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                ],
            )
            context = browser.new_context(
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                    " (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
                )
            )
            page = context.new_page()
            cdn_urls = []

            def handle_req(req):
                u = req.url
                if (
                    "data.cdn.avsee.is" in u
                    or "surrit.com" in u
                    or ".m3u8" in u
                    or ".mp4" in u
                ) and not any(x in u for x in [".png", ".jpg", ".css", ".js", ".svg"]):
                    if u not in cdn_urls:
                        cdn_urls.append(u)

            page.on("request", handle_req)
            page.goto(post_url, wait_until="domcontentloaded", timeout=timeout * 1000)

            for _ in range(6):
                if "Just a moment" not in page.title():
                    break
                page.wait_for_timeout(1000)

            try:
                page.wait_for_selector("video, .jw-media, iframe", timeout=6000)
            except Exception:
                pass
            page.wait_for_timeout(2000)

            soup = BeautifulSoup(page.content(), "html.parser")
            for video in soup.find_all("video"):
                src = video.get("src", "")
                if src and (".mp4" in src or ".m3u8" in src) and src not in cdn_urls:
                    cdn_urls.append(src)

            browser.close()
            return cdn_urls[0] if cdn_urls else None
    except Exception as e:
        print(
            f"[JIT Warning] Failed to extract fresh token for {post_url}: {e}",
            flush=True,
        )
        return None


def download_video_worker(item, output_dir, timeout=180, worker_id=1):
    """
    Downloads a single video file using chunked HTTP streaming with retry, backoff,
    and a strict 1.95 GB size ceiling.
    """
    title = item.get("title", "untitled")
    url = item.get("mp4_download_url")
    if not url and item.get("video_urls"):
        urls = item.get("video_urls")
        if isinstance(urls, list) and len(urls) > 0:
            url = urls[0]
        elif isinstance(urls, str):
            url = urls
    post_url = item.get("post_url") or item.get("page_url") or ""

    if not url and post_url:
        print(
            f"[Worker {worker_id}] [⚡ JIT] No pre-saved token for '{title}'. Resolving fresh token...",
            flush=True,
        )
        url = extract_fresh_token_jit(post_url)

    if not url:
        return {"status": "skipped", "title": title, "reason": "No MP4 URL"}

    safe_title = sanitize_filename(title)
    wr_id_match = re.search(r"wr_id=(\d+)", post_url)
    suffix = f"_{wr_id_match.group(1)}" if wr_id_match else ""
    filename = f"{safe_title}{suffix}.mp4"
    filepath = os.path.join(output_dir, filename)

    # If a broken/empty file exists (< 1MB), clean it up
    if os.path.exists(filepath) and os.path.getsize(filepath) < 1024 * 1024:
        try:
            os.remove(filepath)
        except Exception:
            pass

    # Check if complete file already exists (> 1MB)
    if os.path.exists(filepath) and os.path.getsize(filepath) >= 1024 * 1024:
        size_mb = os.path.getsize(filepath) / (1024 * 1024)
        print(
            f"[Worker {worker_id}] [Already Downloaded] {filename} ({size_mb:.1f} MB)",
            flush=True,
        )
        return {
            "status": "exists",
            "title": title,
            "filepath": filepath,
            "size_mb": size_mb,
            "post_url": post_url,
        }

    # Stagger thread start slightly to prevent synchronized burst rate-limiting (429)
    time.sleep(0.15 * worker_id)

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            " (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        ),
        "Referer": "https://02.avsee.is/",
        "Origin": "https://02.avsee.is",
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9,ko;q=0.8",
    }

    part_filepath = os.path.join(
        output_dir, f".part_{safe_title}{suffix}_{worker_id}_{int(time.time()*1000)}.tmp"
    )

    max_retries = 2
    for attempt in range(1, max_retries + 1):
        try:
            if attempt == 1:
                print(f"[Worker {worker_id}] [+] Starting download: {filename}", flush=True)
            start_time = time.time()

            with requests.get(url, headers=headers, stream=True, timeout=timeout) as response:
                status_code = response.status_code

                if status_code in [401, 403, 404, 410]:
                    if post_url and attempt == 1:
                        print(
                            f"[Worker {worker_id}] [!] [HTTP {status_code}] Token expired for {filename}. Resolving fresh JIT token...",
                            flush=True,
                        )
                        fresh_url = extract_fresh_token_jit(post_url)
                        if fresh_url:
                            print(
                                f"[Worker {worker_id}] [✅ JIT] Fresh token acquired! Retrying download...",
                                flush=True,
                            )
                            url = fresh_url
                            time.sleep(1.0)
                            continue

                    print(
                        f"[Worker {worker_id}] [!] [HTTP {status_code}] Expired/Forbidden: {filename}",
                        flush=True,
                    )
                    return {
                        "status": "failed",
                        "title": title,
                        "error": f"HTTP {status_code}",
                        "expired_token": True,
                        "post_url": post_url,
                    }


                if status_code == 429 and attempt < max_retries:
                    time.sleep(2.0)
                    continue

                if status_code not in [200, 206]:
                    print(
                        f"[Worker {worker_id}] [!] [HTTP {status_code}] Failed: {filename}",
                        flush=True,
                    )
                    return {
                        "status": "failed",
                        "title": title,
                        "error": f"HTTP {status_code}",
                        "expired_token": status_code in [401, 403],
                        "post_url": post_url,
                    }

                total_size = int(response.headers.get("content-length", 0) or 0)

                # 1.95 GB Safety Ceiling Check
                if total_size > MAX_ALLOWED_FILE_BYTES:
                    total_gb = total_size / (1024 * 1024 * 1024)
                    print(
                        f"[Worker {worker_id}] [!] [SKIPPED - OVERSIZED] {filename} ({total_gb:.2f} GB > 1.95 GB Telegram Limit)",
                        flush=True,
                    )
                    return {
                        "status": "skipped_oversized",
                        "title": title,
                        "size_bytes": total_size,
                        "error": f"Oversized: {total_gb:.2f} GB > 1.95 GB limit",
                    }

                total_mb = (total_size / (1024 * 1024)) if total_size > 0 else 0
                chunk_size = 1024 * 1024  # 1 MB chunks for optimized I/O throughput
                downloaded = 0
                last_log_time = time.time()
                prefix = None

                with open(part_filepath, "wb") as f:
                    for chunk in response.iter_content(chunk_size=chunk_size):
                        if not chunk:
                            continue
                        if prefix is None:
                            prefix = chunk[:32]
                            if len(prefix) >= 12 and prefix[4:8] != b"ftyp" and b"moov" not in prefix and b"<!DOCTYPE" in prefix:
                                raise ValueError("Not a valid MP4 container (received HTML error or challenge page)")
                        f.write(chunk)
                        downloaded += len(chunk)

                        now = time.time()
                        if now - last_log_time >= 4.0:
                            cur_mb = downloaded / (1024 * 1024)
                            pct = (downloaded / total_size * 100.0) if total_size > 0 else 0.0
                            if total_mb > 0:
                                print(
                                    f"[Worker {worker_id}] STREAM {cur_mb:.1f} MB / {total_mb:.1f} MB ({pct:.1f}%)",
                                    flush=True,
                                )
                            else:
                                print(
                                    f"[Worker {worker_id}] STREAM {cur_mb:.1f} MB downloaded",
                                    flush=True,
                                )
                            last_log_time = now

                # Verify completeness if content-length header was supplied
                if total_size > 0 and downloaded < (total_size * 0.98):
                    if os.path.exists(part_filepath):
                        os.remove(part_filepath)
                    raise IOError(
                        f"Incomplete download stream: received {downloaded}/{total_size} bytes"
                    )

            # Atomically move verified part file to final destination
            if os.path.exists(part_filepath):
                os.replace(part_filepath, filepath)

            final_mb = (
                (os.path.getsize(filepath) / (1024 * 1024))
                if os.path.exists(filepath)
                else 0
            )
            duration = time.time() - start_time
            speed = (final_mb / duration) if duration > 0 else 0

            print(
                f"[Worker {worker_id}] [✓] Finished: {filename} ({final_mb:.1f} MB in {duration:.1f}s at {speed:.2f} MB/s)",
                flush=True,
            )
            return {
                "status": "completed",
                "title": title,
                "filepath": os.path.abspath(filepath),
                "size_mb": final_mb,
                "post_url": post_url,
                "source_video_url": url,
            }

        except Exception as e:
            if os.path.exists(part_filepath):
                try:
                    os.remove(part_filepath)
                except Exception:
                    pass

            if attempt < max_retries:
                time.sleep(1.0)
                continue

            print(f"[Worker {worker_id}] [!] [Error] {filename}: {e}", flush=True)
            return {"status": "error", "title": title, "error": str(e)}

    return {"status": "failed", "title": title, "error": "All download attempts failed"}


def run_parallel_downloader(
    json_file, output_dir, max_workers=2, limit=5, timeout=180
):
    """
    Spawns a ThreadPoolExecutor with 3-4 parallel workers to download up to `limit` videos,
    iterating through the database until target quota is reached or items are exhausted.
    """
    if not os.path.exists(json_file):
        print(f"[!] JSON file not found: {json_file}", flush=True)
        return []

    with open(json_file, "r", encoding="utf-8") as f:
        items = json.load(f)

    valid_items = [
        it
        for it in items
        if (
            it.get("mp4_download_url")
            or (isinstance(it.get("video_urls"), list) and len(it.get("video_urls")) > 0)
            or (isinstance(it.get("video_urls"), str) and it.get("video_urls").strip())
        )
    ]

    os.makedirs(output_dir, exist_ok=True)

    print("\n=======================================================", flush=True)
    print(f"[*] Modular Parallel Video Downloader", flush=True)
    print(f"[*] Database Valid Items: {len(valid_items)} (Target Quota: {limit})", flush=True)
    print(f"[*] Concurrent Workers:   {max_workers} Workers", flush=True)
    print(f"[*] Destination Dir:      {os.path.abspath(output_dir)}", flush=True)
    print("=======================================================\n", flush=True)

    results = []
    successful_downloads = []

    # Continuous dynamic worker queue: each worker immediately picks up next item as soon as it finishes
    with concurrent.futures.ThreadPoolExecutor(
        max_workers=max_workers
    ) as executor:
        active_futures = {}
        item_iter = iter(enumerate(valid_items))

        def submit_next(slot_worker_id=None):
            try:
                idx, next_item = next(item_iter)
                worker_id = slot_worker_id or ((idx % max_workers) + 1)
                fut = executor.submit(
                    download_video_worker,
                    next_item,
                    output_dir,
                    timeout,
                    worker_id,
                )
                active_futures[fut] = (worker_id, next_item)
                return True
            except StopIteration:
                return False

        # Prime all workers (Worker 1, Worker 2) with initial tasks
        for w in range(1, max_workers + 1):
            if len(successful_downloads) < limit:
                if not submit_next(w):
                    break

        # Process results as soon as ANY worker completes, immediately refilling that worker's slot
        while active_futures and len(successful_downloads) < limit:
            done, _ = concurrent.futures.wait(
                active_futures.keys(),
                return_when=concurrent.futures.FIRST_COMPLETED,
            )
            for fut in done:
                worker_id, item = active_futures.pop(fut)
                try:
                    res = fut.result()
                    results.append(res)
                    if res.get("status") in ["completed", "exists"]:
                        successful_downloads.append(res)
                except Exception as exc:
                    results.append(
                        {"status": "error", "error": str(exc), "title": item.get("title", "")}
                    )

                # Refill freed worker slot immediately if limit is not yet reached
                if len(successful_downloads) < limit:
                    submit_next(worker_id)

    completed = len(successful_downloads)
    print(
        f"\n[*] Parallel Download Complete: {completed}/{limit} target ready on disk.\n",
        flush=True,
    )
    return results


def main():
    parser = argparse.ArgumentParser(
        description="Unified 2-Worker Video Downloader"
    )
    parser.add_argument(
        "--json", required=True, help="Path to scraper JSON database"
    )
    parser.add_argument(
        "--output", required=True, help="Directory to save downloaded MP4s"
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=2,
        help="Number of parallel download workers (default 2)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=5,
        help="Maximum videos to download (default 5)",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=180,
        help="Download timeout per video in seconds",
    )

    args = parser.parse_args()
    results = run_parallel_downloader(
        json_file=args.json,
        output_dir=args.output,
        max_workers=args.workers,
        limit=args.limit,
        timeout=args.timeout,
    )

    # Output JSON summary to stdout for Node orchestrator consumption
    print(f"__RESULT_JSON__:{json.dumps(results)}")


if __name__ == "__main__":
    main()
