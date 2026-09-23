import argparse
import json
import os
import re
import requests
import sys
import time
from tqdm import tqdm

# Ensure unbuffered terminal output
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(line_buffering=True)


def sanitize_filename(name):
    """Sanitizes string for valid Windows filenames."""
    if not name or name.strip() == "":
        name = "untitled_video"
    sanitized = re.sub(r'[\\/*?:"<>|]', "", name).strip()
    return sanitized[:100]


def download_single_video(
    item, output_dir=os.path.join("downloads", "18+"), timeout=180, max_retries=3
):
    """
    Downloads a single KRX (18+) MP4 video file with HTTP Range resume and a live visual percentage progress bar.
    """
    title = item.get("title", "untitled")
    url = item.get("mp4_download_url")
    post_url = item.get("post_url", "")

    if not url:
        print(f"[-] [Skipped] '{title}' - No MP4 URL found", flush=True)
        return {"status": "skipped", "title": title}

    safe_title = sanitize_filename(title)
    wr_id_match = re.search(r"wr_id=(\d+)", post_url)
    suffix = f"_{wr_id_match.group(1)}" if wr_id_match else ""
    filename = f"{safe_title}{suffix}.mp4"
    filepath = os.path.join(output_dir, filename)

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Referer": "https://02.avsee.is/",
    }

    start_time = time.time()
    chunk_size = 1024 * 256  # 256 KB chunks

    for attempt in range(1, max_retries + 1):
        try:
            downloaded_bytes = (
                os.path.getsize(filepath) if os.path.exists(filepath) else 0
            )
            req_headers = headers.copy()
            if downloaded_bytes > 0:
                req_headers["Range"] = f"bytes={downloaded_bytes}-"

            with requests.get(
                url, headers=req_headers, stream=True, timeout=timeout
            ) as response:
                if response.status_code == 416:
                    total_mb = downloaded_bytes / (1024 * 1024)
                    print(
                        f"[*] [Already Downloaded] {filename} ({total_mb:.1f} MB)\n",
                        flush=True,
                    )
                    return {"status": "exists", "title": title, "filepath": filepath}

                if response.status_code not in [200, 206]:
                    print(
                        f"[!] [HTTP {response.status_code}] Failed: {filename} (Attempt {attempt}/{max_retries})\n",
                        flush=True,
                    )
                    if attempt == max_retries:
                        return {
                            "status": "failed",
                            "title": title,
                            "error": f"HTTP {response.status_code}",
                        }
                    time.sleep(2)
                    continue

                if response.status_code == 206:
                    content_range = response.headers.get("content-range", "")
                    m = re.search(r"/(\d+)", content_range)
                    total_size = (
                        int(m.group(1))
                        if m
                        else (
                            downloaded_bytes
                            + int(response.headers.get("content-length", 0))
                        )
                    )
                    mode = "ab"
                else:
                    total_size = int(response.headers.get("content-length", 0))
                    mode = "wb"
                    downloaded_bytes = 0

                total_mb = total_size / (1024 * 1024) if total_size > 0 else 0

                if downloaded_bytes > 0:
                    print(
                        f"[+] Resuming: {filename} ({downloaded_bytes / (1024 * 1024):.1f} MB / {total_mb:.1f} MB)",
                        flush=True,
                    )
                else:
                    print(
                        f"[+] Downloading: {filename} ({total_mb:.1f} MB)",
                        flush=True,
                    )

                with (
                    open(filepath, mode) as f,
                    tqdm(
                        desc=f"    Progress",
                        total=total_size,
                        initial=downloaded_bytes,
                        unit="B",
                        unit_scale=True,
                        unit_divisor=1024,
                        ncols=90,
                        ascii=" #",
                        leave=True,
                    ) as pbar,
                ):
                    for chunk in response.iter_content(chunk_size=chunk_size):
                        if chunk:
                            f.write(chunk)
                            pbar.update(len(chunk))

                duration = time.time() - start_time
                actual_mb = (
                    os.path.getsize(filepath) / (1024 * 1024)
                    if os.path.exists(filepath)
                    else 0
                )
                speed = (actual_mb / duration) if duration > 0 else 0

                print(
                    f"[✓] Saved: {filename} ({actual_mb:.1f} MB in {duration:.1f}s at {speed:.2f} MB/s)\n",
                    flush=True,
                )
                return {
                    "status": "completed",
                    "title": title,
                    "filepath": filepath,
                    "size_mb": actual_mb,
                }

        except (
            requests.exceptions.RequestException,
            requests.exceptions.Timeout,
        ) as e:
            print(
                f"[!] [Network Error] {filename}: {e} (Attempt {attempt}/{max_retries})\n",
                flush=True,
            )
            if attempt == max_retries:
                return {"status": "failed", "title": title, "error": str(e)}
            time.sleep(2)
        except Exception as e:
            print(f"[!] [Unexpected Error] {filename}: {e}\n", flush=True)
            return {"status": "failed", "title": title, "error": str(e)}

    return {"status": "failed", "title": title, "error": "Max retries exceeded"}


def download_all_krx_videos(
    json_file="krx_videos.json",
    output_dir=os.path.join("downloads", "18+"),
    limit=None,
):
    """
    Downloads all KRX (18+) videos sequentially with live progress bars.
    """
    if not os.path.exists(json_file):
        print(f"[!] JSON file not found: {json_file}", flush=True)
        return

    with open(json_file, "r", encoding="utf-8") as f:
        items = json.load(f)

    valid_items = [it for it in items if it.get("mp4_download_url")]
    # Process newest items first
    valid_items.reverse()

    os.makedirs(output_dir, exist_ok=True)

    print("\n=======================================================", flush=True)
    print(f"[*] Starting KRX/18+ Video Downloader (Sequential Mode)", flush=True)
    print(f"[*] Total Videos in Queue: {len(valid_items)} (Limit: {limit or 'ALL'})", flush=True)
    print(f"[*] Destination Folder:    {os.path.abspath(output_dir)}", flush=True)
    print("=======================================================\n", flush=True)

    results = {"completed": 0, "exists": 0, "failed": 0}

    for idx, item in enumerate(valid_items, 1):
        if limit and (results["completed"] + results["exists"]) >= limit:
            break

        print(f"[{idx}/{len(valid_items)}] {item.get('title', 'Video')}", flush=True)
        res = download_single_video(item, output_dir=output_dir)
        st = res.get("status", "failed")
        if st == "completed":
            results["completed"] += 1
        elif st == "exists":
            results["exists"] += 1
        else:
            results["failed"] += 1

    print("=======================================================", flush=True)
    print(f"[+] KRX Download Summary:", flush=True)
    print(f"    - Newly Downloaded: {results['completed']}", flush=True)
    print(f"    - Already Existed:  {results['exists']}", flush=True)
    print(f"    - Failed:           {results['failed']}", flush=True)
    print(f"    - Destination:      {os.path.abspath(output_dir)}", flush=True)
    print("=======================================================\n", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="KRX (18+) video downloader with live progress percentage"
    )
    parser.add_argument(
        "--json",
        default="krx_videos.json",
        help="Path to JSON file (default: krx_videos.json)",
    )
    parser.add_argument(
        "--output-dir",
        default=os.path.join("downloads", "18+"),
        help="Directory to save downloaded videos",
    )
    parser.add_argument(
        "--limit", type=int, default=None, help="Limit number of videos to download"
    )

    args = parser.parse_args()
    download_all_krx_videos(
        json_file=args.json, output_dir=args.output_dir, limit=args.limit
    )
