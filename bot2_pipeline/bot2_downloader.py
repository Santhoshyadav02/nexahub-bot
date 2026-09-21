import argparse
import concurrent.futures
import json
import os
import re
import time
import requests


def sanitize_filename(name):
    """Sanitizes string for safe filesystem usage."""
    if not name or name.strip() == "":
        name = "untitled_video"
    sanitized = re.sub(r'[\\/*?:"<>|]', "", name).strip()
    return sanitized[:120]


def download_video_worker(item, output_dir, timeout=180, worker_id=1):
    """
    Downloads a single video via direct streaming with atomic verification.
    """
    url = item.get("mp4_download_url")
    title = item.get("title", "untitled")
    post_url = item.get("post_url", "")
    page_num = item.get("page", 0)

    if not url:
        return {"status": "skipped", "title": title, "reason": "No mp4_download_url"}

    # Extract ID from post_url
    wr_id_match = re.search(r"wr_id=(\d+)", post_url)
    wr_id = f"_{wr_id_match.group(1)}" if wr_id_match else ""

    clean_name = sanitize_filename(title)
    filename = f"{clean_name}{wr_id}.mp4"
    filepath = os.path.join(output_dir, filename)
    part_filepath = os.path.join(output_dir, f".part_{filename}")

    # Remove incomplete stale part files
    if os.path.exists(part_filepath):
        try:
            os.remove(part_filepath)
        except Exception:
            pass

    # Check if complete file already exists (> 1MB)
    if os.path.exists(filepath) and os.path.getsize(filepath) >= 1024 * 1024:
        size_mb = os.path.getsize(filepath) / (1024 * 1024)
        print(
            f"[Bot 2 Worker {worker_id}] [Already Downloaded] {filename} ({size_mb:.1f} MB)",
            flush=True,
        )
        return {
            "status": "exists",
            "title": title,
            "filepath": filepath,
            "size_mb": size_mb,
            "post_url": post_url,
        }

    # Stagger thread start slightly
    time.sleep(0.15 * worker_id)

    headers_attempts = [
        {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                " (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            ),
            "Referer": post_url if post_url else "https://02.avsee.is/",
            "Origin": "https://02.avsee.is",
            "Accept": "*/*",
            "Accept-Language": "en-US,en;q=0.9,ko;q=0.8",
        },
        {
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15"
                " (KHTML, like Gecko) Version/17.4 Safari/605.1.15"
            ),
            "Accept": "*/*",
        },
    ]

    for attempt, headers in enumerate(headers_attempts):
        try:
            if attempt == 0:
                print(f"[Bot 2 Worker {worker_id}] [+] Starting download: {filename}", flush=True)
            start_time = time.time()

            with requests.get(
                url, headers=headers, stream=True, timeout=timeout
            ) as response:
                if response.status_code in [403, 429] and attempt < len(headers_attempts) - 1:
                    time.sleep(1.2)
                    continue

                if response.status_code != 200:
                    print(
                        f"[Bot 2 Worker {worker_id}] [!] [HTTP {response.status_code}] Failed: {filename}",
                        flush=True,
                    )
                    is_expired = response.status_code == 403
                    return {
                        "status": "failed",
                        "title": title,
                        "error": f"HTTP {response.status_code}",
                        "expired_token": is_expired,
                        "post_url": post_url,
                    }

                try:
                    total_size = int(response.headers.get("content-length", 0) or 0)
                except (ValueError, TypeError):
                    total_size = 0
                total_mb = (total_size / (1024 * 1024)) if total_size > 0 else 0
                chunk_size = 1024 * 512  # 512 KB chunks for high throughput
                downloaded = 0
                last_log_time = time.time()

                with open(part_filepath, "wb") as f:
                    for chunk in response.iter_content(chunk_size=chunk_size):
                        if chunk:
                            f.write(chunk)
                            downloaded += len(chunk)

                            now = time.time()
                            if now - last_log_time >= 4.0:
                                cur_mb = downloaded / (1024 * 1024)
                                pct = (downloaded / total_size * 100.0) if total_size > 0 else 0.0
                                if total_mb > 0:
                                    print(
                                        f"[Bot 2 Worker {worker_id}] STREAM {cur_mb:.1f} MB / {total_mb:.1f} MB ({pct:.1f}%)",
                                        flush=True,
                                    )
                                else:
                                    print(
                                        f"[Bot 2 Worker {worker_id}] STREAM {cur_mb:.1f} MB downloaded",
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
                f"[Bot 2 Worker {worker_id}] [✓] Finished: {filename} ({final_mb:.1f} MB in {duration:.1f}s at {speed:.2f} MB/s)",
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

            if attempt < len(headers_attempts) - 1:
                time.sleep(1.0)
                continue

            print(f"[Bot 2 Worker {worker_id}] [!] [Error] {filename}: {e}", flush=True)
            return {"status": "error", "title": title, "error": str(e)}

    return {"status": "failed", "title": title, "error": "All download attempts failed"}


def run_parallel_downloader(
    json_file, output_dir, max_workers=2, limit=5, timeout=180
):
    """
    Spawns a ThreadPoolExecutor with 2 continuous parallel workers to download up to `limit` videos.
    """
    if not os.path.exists(json_file):
        print(f"[!] JSON file not found: {json_file}", flush=True)
        return []

    with open(json_file, "r", encoding="utf-8") as f:
        items = json.load(f)

    valid_items = [it for it in items if it.get("mp4_download_url")]

    os.makedirs(output_dir, exist_ok=True)

    print("\n=======================================================", flush=True)
    print(f"[*] Bot 2 Parallel Video Downloader (Scraping-1 Engine)", flush=True)
    print(f"[*] Database Valid Items: {len(valid_items)} (Target Quota: {limit})", flush=True)
    print(f"[*] Concurrent Workers:   {max_workers} Workers", flush=True)
    print(f"[*] Destination Dir:      {os.path.abspath(output_dir)}", flush=True)
    print("=======================================================\n", flush=True)

    results = []
    successful_downloads = []

    # Continuous dynamic worker queue
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

        # Prime all workers with initial tasks
        for w in range(1, max_workers + 1):
            if len(successful_downloads) < limit:
                if not submit_next(w):
                    break

        # Process results as soon as any worker completes
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
        f"\n[*] Bot 2 Parallel Download Complete: {completed}/{limit} target ready on disk.\n",
        flush=True,
    )
    return results


def main():
    parser = argparse.ArgumentParser(description="Bot 2 Parallel Video Downloader")
    parser.add_argument(
        "--json", required=True, help="Path to candidates JSON file"
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

    print(f"__RESULT_JSON__:{json.dumps(results)}")


if __name__ == "__main__":
    main()
