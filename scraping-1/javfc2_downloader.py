import argparse
import json
import os
import re
import requests
import sys
import time
from tqdm import tqdm

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(line_buffering=True)

DEFAULT_OUTPUT_DIR = os.path.join("downloads", "JAV FC2")


def sanitize_filename(name):
    if not name or name.strip() == "":
        name = "untitled_video"
    sanitized = re.sub(r'[\\/*?:"<>|]', "", name).strip()
    return sanitized[:100]


def download_single_video(item, output_dir=DEFAULT_OUTPUT_DIR, timeout=180):
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

    # If broken/empty file exists, remove it
    if os.path.exists(filepath) and os.path.getsize(filepath) < 1024 * 1024:
        try:
            os.remove(filepath)
        except Exception:
            pass

    if os.path.exists(filepath) and os.path.getsize(filepath) >= 1024 * 1024:
        size_mb = os.path.getsize(filepath) / (1024 * 1024)
        print(f"[*] [Already Downloaded] {filename} ({size_mb:.1f} MB)\n", flush=True)
        return {"status": "exists", "title": title, "filepath": filepath}

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Referer": "https://02.avsee.is/",
    }

    part_filepath = os.path.join(output_dir, f".part_{safe_title}{suffix}_{int(time.time()*1000)}.tmp")

    try:
        print(f"[+] Downloading: {filename}", flush=True)
        start_time = time.time()

        with requests.get(
            url, headers=headers, stream=True, timeout=timeout
        ) as response:
            if response.status_code != 200:
                print(
                    f"[!] [HTTP {response.status_code}] Failed: {filename} (Token may have expired)\n",
                    flush=True,
                )
                return {
                    "status": "failed",
                    "title": title,
                    "error": f"HTTP {response.status_code}",
                }

            total_size = int(response.headers.get("content-length", 0))
            chunk_size = 1024 * 256
            downloaded = 0

            with (
                open(part_filepath, "wb") as f,
                tqdm(
                    desc=f"    Progress",
                    total=total_size,
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
                        downloaded += len(chunk)
                        pbar.update(len(chunk))

            if total_size > 0 and downloaded < (total_size * 0.98):
                if os.path.exists(part_filepath):
                    os.remove(part_filepath)
                raise IOError(f"Incomplete download: received {downloaded}/{total_size} bytes")

        if os.path.exists(part_filepath):
            os.replace(part_filepath, filepath)

        total_mb = (
            (os.path.getsize(filepath) / (1024 * 1024))
            if os.path.exists(filepath)
            else 0
        )
        duration = time.time() - start_time
        speed = (total_mb / duration) if duration > 0 else 0
        print(
            f"[✓] Saved: {filename} ({total_mb:.1f} MB in {duration:.1f}s at {speed:.2f} MB/s)\n",
            flush=True,
        )
        return {
            "status": "completed",
            "title": title,
            "filepath": filepath,
            "size_mb": total_mb,
        }

    except Exception as e:
        if os.path.exists(part_filepath):
            try:
                os.remove(part_filepath)
            except Exception:
                pass
        print(f"[!] [Download Error] {filename}: {e}\n", flush=True)
        return {"status": "error", "title": title, "error": str(e)}


def download_all_javfc2_videos(
    json_file="javfc2_videos.json", output_dir=DEFAULT_OUTPUT_DIR, limit=None
):
    if not os.path.exists(json_file):
        print(f"[!] JSON file not found: {json_file}", flush=True)
        return

    with open(json_file, "r", encoding="utf-8") as f:
        items = json.load(f)

    valid_items = [it for it in items if it.get("mp4_download_url")]

    if limit:
        valid_items = valid_items[:limit]

    os.makedirs(output_dir, exist_ok=True)

    print("\n=======================================================", flush=True)
    print(f"[*] Starting JAV FC2 Video Downloader (Sequential Mode)", flush=True)
    print(f"[*] Total Videos in Queue: {len(valid_items)}", flush=True)
    print(f"[*] Destination Folder:    {os.path.abspath(output_dir)}", flush=True)
    print("=======================================================\n", flush=True)

    results = {"completed": 0, "exists": 0, "failed": 0}

    for idx, item in enumerate(valid_items, 1):
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
    print(f"[+] JAV FC2 Download Summary:", flush=True)
    print(f"    - Newly Downloaded: {results['completed']}", flush=True)
    print(f"    - Already Existed:  {results['exists']}", flush=True)
    print(f"    - Failed:           {results['failed']}", flush=True)
    print(f"    - Destination:      {os.path.abspath(output_dir)}", flush=True)
    print("=======================================================\n", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="JAV FC2 MP4 downloader")
    parser.add_argument(
        "--json", default="javfc2_videos.json", help="Path to JSON file"
    )
    parser.add_argument(
        "--output-dir", default=DEFAULT_OUTPUT_DIR, help="Directory to save videos"
    )
    parser.add_argument(
        "--limit", type=int, default=None, help="Limit number of videos"
    )

    args = parser.parse_args()
    download_all_javfc2_videos(
        json_file=args.json, output_dir=args.output_dir, limit=args.limit
    )
