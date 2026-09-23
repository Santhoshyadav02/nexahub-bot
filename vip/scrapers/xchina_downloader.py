import argparse
import html
import json
import os
import re
import shutil
import subprocess
import sys
import time
import requests
from tqdm import tqdm

# Ensure unbuffered terminal output
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(line_buffering=True)


def sanitize_filename(name):
    """Sanitizes string for valid Windows filenames."""
    if not name or name.strip() == "":
        name = "untitled_video"
    name = html.unescape(name)
    sanitized = re.sub(r'[\\/*?:"<>|]', "", name).strip()
    return sanitized[:100]


def download_m3u8_with_ffmpeg(url, filepath):
    """
    Downloads an HLS (.m3u8) video stream and converts it directly into a clean .mp4 file via ffmpeg.
    """
    headers = (
        "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36\r\n"
        "Referer: https://en.xchina.co/\r\n"
    )

    cmd = [
        "ffmpeg",
        "-y",
        "-headers",
        headers,
        "-i",
        url,
        "-c",
        "copy",
        "-bsf:a",
        "aac_adtstoasc",
        filepath,
    ]

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        _, stderr = proc.communicate()
        if (
            proc.returncode == 0
            and os.path.exists(filepath)
            and os.path.getsize(filepath) > 1024 * 1024
        ):
            return True, None
        return False, stderr.decode("utf-8", errors="ignore")[-300:]
    except Exception as e:
        return False, str(e)


def download_direct_mp4(url, filepath, timeout=180):
    """
    Downloads a direct MP4 file with tqdm visual progress bar.
    """
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Referer": "https://en.xchina.co/",
    }
    with requests.get(url, headers=headers, stream=True, timeout=timeout) as response:
        if response.status_code != 200:
            return False, f"HTTP {response.status_code}"

        total_size = int(response.headers.get("content-length", 0))
        chunk_size = 1024 * 256

        with (
            open(filepath, "wb") as f,
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
                    pbar.update(len(chunk))
    return True, None


def download_single_video(
    item, output_dir=os.path.join("downloads", "xchina"), timeout=180
):
    """
    Downloads a single XChina video (supports both .m3u8 streams and direct .mp4 files).
    """
    title = item.get("title", "untitled")
    url = item.get("mp4_download_url")
    post_url = item.get("post_url", "")

    if not url:
        print(f"[-] [Skipped] '{title}' - No video URL found", flush=True)
        return {"status": "skipped", "title": title}

    safe_title = sanitize_filename(title)

    # Extract ID from post_url
    id_match = re.search(r"(?:video-|id-|videos/)?([a-zA-Z0-9_-]+)\.html", post_url)
    suffix = f"_{id_match.group(1)}" if id_match else ""

    filename = f"{safe_title}{suffix}.mp4"
    filepath = os.path.join(output_dir, filename)

    # Check if file already exists (> 1MB)
    if os.path.exists(filepath) and os.path.getsize(filepath) > 1024 * 1024:
        size_mb = os.path.getsize(filepath) / (1024 * 1024)
        print(f"[*] [Already Downloaded] {filename} ({size_mb:.1f} MB)\n", flush=True)
        return {"status": "exists", "title": title, "filepath": filepath}

    print(f"[+] Downloading: {filename}", flush=True)
    start_time = time.time()

    is_m3u8 = ".m3u8" in url or "m3u8" in url

    if is_m3u8 and shutil.which("ffmpeg"):
        print(f"    -> Streaming & muxing HLS video with ffmpeg...", flush=True)
        success, error_msg = download_m3u8_with_ffmpeg(url, filepath)
    else:
        success, error_msg = download_direct_mp4(url, filepath, timeout=timeout)

    if success:
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
    else:
        if os.path.exists(filepath) and os.path.getsize(filepath) < 1024 * 1024:
            try:
                os.remove(filepath)
            except Exception:
                pass
        print(f"[!] [Download Error] {filename}: {error_msg}\n", flush=True)
        return {"status": "error", "title": title, "error": error_msg}


def download_all_xchina_videos(
    json_file="xchina_videos.json",
    output_dir=os.path.join("downloads", "xchina"),
    limit=None,
):
    """
    Downloads all XChina videos sequentially with live progress bars.
    """
    if not os.path.exists(json_file):
        print(f"[!] JSON file not found: {json_file}", flush=True)
        print(
            f"    Please run the scraper first: uv run python xchina_scraper.py",
            flush=True,
        )
        return

    with open(json_file, "r", encoding="utf-8") as f:
        items = json.load(f)

    valid_items = [it for it in items if it.get("mp4_download_url")]

    if limit:
        valid_items = valid_items[:limit]

    os.makedirs(output_dir, exist_ok=True)

    print("\n=======================================================", flush=True)
    print(f"[*] Starting XChina Video Downloader (Sequential Mode)", flush=True)
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
    print(f"[+] XChina Download Summary:", flush=True)
    print(f"    - Newly Downloaded: {results['completed']}", flush=True)
    print(f"    - Already Existed:  {results['exists']}", flush=True)
    print(f"    - Failed:           {results['failed']}", flush=True)
    print(f"    - Destination:      {os.path.abspath(output_dir)}", flush=True)
    print("=======================================================\n", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="XChina video downloader (supports .m3u8 streams and .mp4 files)"
    )
    parser.add_argument(
        "--json",
        default="xchina_videos.json",
        help="Path to JSON file (default: xchina_videos.json)",
    )
    parser.add_argument(
        "--output-dir",
        default=os.path.join("downloads", "xchina"),
        help="Directory to save downloaded videos",
    )
    parser.add_argument(
        "--limit", type=int, default=None, help="Limit number of videos to download"
    )

    args = parser.parse_args()
    download_all_xchina_videos(
        json_file=args.json, output_dir=args.output_dir, limit=args.limit
    )
