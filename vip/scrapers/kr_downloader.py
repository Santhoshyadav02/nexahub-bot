import argparse
import concurrent.futures
import html
import json
import os
import re
import socket
import shutil
import subprocess
import sys
import time
from urllib.parse import urljoin
import requests
from tqdm import tqdm

EPORNER_IP = "94.75.220.6"

# Ensure socket resolves eporner.com directly to bypass local ISP DNS blocks
_orig_getaddrinfo = socket.getaddrinfo


def patched_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    if host in ["eporner.com", "www.eporner.com"]:
        host = EPORNER_IP
    return _orig_getaddrinfo(host, port, family, type, proto, flags)


socket.getaddrinfo = patched_getaddrinfo

# Ensure unbuffered terminal output
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(line_buffering=True)


def sanitize_filename(name):
    """Sanitizes string for valid Windows filenames."""
    if not name or name.strip() == "":
        name = "untitled_video"
    name = html.unescape(name)
    sanitized = re.sub(r'[\\/*?:"<>|]', "", name).strip()
    sanitized = re.sub(r'[\\/*?:"<>|\'`]', "", name).strip()
    return sanitized[:100]


def resolve_best_m3u8(master_url, headers):
    """
    Parses master playlist if needed and returns the highest resolution m3u8 URL.
    """
    try:
        r = requests.get(master_url, headers=headers, timeout=15)
        if r.status_code != 200:
            return master_url
        content = r.text
        if "#EXT-X-STREAM-INF" in content:
            # Master playlist
            variants = []
            lines = content.splitlines()
            for i, line in enumerate(lines):
                if line.startswith("#EXT-X-STREAM-INF"):
                    # Find next non-empty line as url
                    for next_line in lines[i + 1 :]:
                        next_line = next_line.strip()
                        if next_line and not next_line.startswith("#"):
                            res_match = re.search(r"RESOLUTION=(\d+)x(\d+)", line)
                            res = int(res_match.group(2)) if res_match else 0
                            variants.append((res, next_line))
                            break
            if variants:
                variants.sort(key=lambda x: x[0], reverse=True)
                best_sub = variants[0][1]
                return urljoin(master_url, best_sub)
    except Exception:
        pass
    return master_url


def download_m3u8_segments(m3u8_url, output_filepath, max_workers=8):
    """
    Downloads all HLS segments concurrently and muxes them into a clean .mp4 file.
    """
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Referer": "https://missav123.com/",
        "Origin": "https://missav123.com",
    }

    # 1. Resolve variant playlist
    target_playlist_url = resolve_best_m3u8(m3u8_url, headers)

    # 2. Fetch segment list
    try:
        r = requests.get(target_playlist_url, headers=headers, timeout=15)
        if r.status_code != 200:
            return False, f"Failed to fetch playlist (HTTP {r.status_code})"
        playlist_content = r.text
    except Exception as e:
        return False, str(e)

    segment_urls = []
    for line in playlist_content.splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            full_seg_url = urljoin(target_playlist_url, line)
            segment_urls.append(full_seg_url)

    if not segment_urls:
        return False, "No video segments found in playlist"

    temp_dir = output_filepath + ".tmp_segs"
    os.makedirs(temp_dir, exist_ok=True)
    temp_ts = output_filepath + ".temp.ts"

    print(
        f"    -> Found {len(segment_urls)} video segments. Downloading...", flush=True
    )

    def download_seg(idx, seg_url):
        seg_file = os.path.join(temp_dir, f"seg_{idx:06d}.ts")
        if os.path.exists(seg_file) and os.path.getsize(seg_file) > 0:
            return idx, seg_file, True
        for _ in range(3):
            try:
                res = requests.get(seg_url, headers=headers, timeout=20)
                if res.status_code == 200 and len(res.content) > 0:
                    with open(seg_file, "wb") as f:
                        f.write(res.content)
                    return idx, seg_file, True
                time.sleep(1)
            except Exception:
                time.sleep(1)
        return idx, seg_file, False

    downloaded_files = {}
    with tqdm(
        desc="    Progress",
        total=len(segment_urls),
        unit="seg",
        ncols=90,
        ascii=" #",
        leave=True,
    ) as pbar:
        with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_to_idx = {
                executor.submit(download_seg, i, u): i
                for i, u in enumerate(segment_urls)
            }
            for future in concurrent.futures.as_completed(future_to_idx):
                idx, seg_file, ok = future.result()
                if ok:
                    downloaded_files[idx] = seg_file
                pbar.update(1)

    if len(downloaded_files) != len(segment_urls):
        shutil.rmtree(temp_dir, ignore_errors=True)
        return (
            False,
            f"Downloaded only {len(downloaded_files)}/{len(segment_urls)} segments.",
        )

    # 3. Concatenate segments into temp .ts
    try:
        with open(temp_ts, "wb") as outfile:
            for i in range(len(segment_urls)):
                with open(downloaded_files[i], "rb") as infile:
                    outfile.write(infile.read())
    except Exception as e:
        shutil.rmtree(temp_dir, ignore_errors=True)
        if os.path.exists(temp_ts):
            os.remove(temp_ts)
        return False, f"Failed concatenating segments: {e}"

    # Cleanup segment files
    shutil.rmtree(temp_dir, ignore_errors=True)

    # 4. Remux to clean MP4 with ffmpeg
    print(f"    -> Muxing into final MP4...", flush=True)
    abs_output = os.path.abspath(output_filepath)
    abs_input = os.path.abspath(temp_ts)
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        abs_input,
        "-c",
        "copy",
        "-bsf:a",
        "aac_adtstoasc",
        abs_output,
    ]

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        _, stderr = proc.communicate()
        if os.path.exists(temp_ts):
            os.remove(temp_ts)

        if (
            proc.returncode == 0
            and os.path.exists(output_filepath)
            and os.path.getsize(output_filepath) > 1024 * 1024
        ):
            return True, None
        return False, stderr.decode("utf-8", errors="ignore")[-300:]
    except Exception as e:
        if os.path.exists(temp_ts):
            os.remove(temp_ts)
        return False, str(e)


def download_single_video(
    item, output_dir=os.path.join("downloads", "kr"), timeout=180, proxy=None
):
    """
    Downloads a single KR MP4 video file with HTTP Range resume and a live visual percentage progress bar.
    Downloads a single KR video (supports both .m3u8 streams and direct .mp4 files).
    """
    title = item.get("title", "untitled")
    url = item.get("mp4_download_url")
    post_url = item.get("post_url", "")

    if not url:
        print(f"[-] [Skipped] '{title}' - No video URL found", flush=True)
        return {"status": "skipped", "title": title}

    safe_title = sanitize_filename(title)

    # Extract ID from post_url
    id_match = re.search(r"(?:video-|/video/)?([a-zA-Z0-9_-]+)/?", post_url)
    suffix = f"_{id_match.group(1)}" if id_match else ""
    # Extract ID/slug from post_url
    slug_match = re.search(r"/en/([a-zA-Z0-9_-]+)/?$", post_url)
    suffix = f"_{slug_match.group(1)}" if slug_match else ""

    filename = f"{safe_title}{suffix}.mp4"
    filepath = os.path.join(output_dir, filename)

    # Check if file already exists (> 1MB)
    # Duplicate check (> 1MB)
    if os.path.exists(filepath) and os.path.getsize(filepath) > 1024 * 1024:
        size_mb = os.path.getsize(filepath) / (1024 * 1024)
        print(f"[*] [Already Downloaded] {filename} ({size_mb:.1f} MB)\n", flush=True)
        return {"status": "exists", "title": title, "filepath": filepath}

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Referer": "https://www.eporner.com/",
        "Accept": "*/*",
    }
    proxies = {"http": proxy, "https": proxy} if proxy else None
    chunk_size = 1024 * 256  # 256 KB chunks
    max_retries = 3

    print(f"[+] Downloading: {filename}", flush=True)
    start_time = time.time()

    for attempt in range(1, max_retries + 1):
        try:
            downloaded_bytes = (
                os.path.getsize(filepath) if os.path.exists(filepath) else 0
            )
            req_headers = headers.copy()
            if downloaded_bytes > 0:
                req_headers["Range"] = f"bytes={downloaded_bytes}-"
    success, err = download_m3u8_segments(url, filepath)

            with requests.get(
                url, headers=req_headers, proxies=proxies, stream=True, timeout=timeout
            ) as response:
                if response.status_code == 416:
                    break
    if not success:
        if os.path.exists(filepath) and os.path.getsize(filepath) < 1024 * 1024:
            try:
                os.remove(filepath)
            except Exception:
                pass
        print(f"[!] [Download Error] {filename}: {err}\n", flush=True)
        return {"status": "error", "title": title, "error": err}

                if response.status_code not in [200, 206]:
                    if attempt == max_retries:
                        print(
                            f"[!] [HTTP {response.status_code}] Failed: {filename}\n",
                            flush=True,
                        )
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
                    downloaded_bytes = 0
                    mode = "wb"

                if downloaded_bytes >= total_size and total_size > 0:
                    break

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
            break
        except Exception as e:
            if attempt < max_retries:
                time.sleep(2)
                continue
            if os.path.exists(filepath) and os.path.getsize(filepath) < 1024 * 1024:
                try:
                    os.remove(filepath)
                except Exception:
                    pass
            print(f"[!] [Download Error] {filename}: {e}\n", flush=True)
            return {"status": "error", "title": title, "error": str(e)}

    total_mb = (
        (os.path.getsize(filepath) / (1024 * 1024)) if os.path.exists(filepath) else 0
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


def download_all_kr_videos(
    json_file="kr_videos.json",
    output_dir=os.path.join("downloads", "kr"),
    limit=None,
    proxy=None,
):
    """
    Downloads all KR videos sequentially with live progress bars.
    Downloads all KR videos sequentially.
    """
    if not os.path.exists(json_file):
        print(f"[!] JSON file not found: {json_file}", flush=True)
        print(
            f"    Please run the scraper first: uv run python kr_scraper.py", flush=True
        )
        return

    with open(json_file, "r", encoding="utf-8") as f:
        items = json.load(f)

    valid_items = [it for it in items if it.get("mp4_download_url")]

    if limit:
        valid_items = valid_items[:limit]

    os.makedirs(output_dir, exist_ok=True)

    print("\n=======================================================", flush=True)
    print(f"[*] Starting KR Video Downloader (Sequential Mode)", flush=True)
    print(f"[*] Total Videos in Queue: {len(valid_items)}", flush=True)
    print(f"[*] Destination Folder:    {os.path.abspath(output_dir)}", flush=True)
    print("=======================================================\n", flush=True)

    results = {"completed": 0, "exists": 0, "failed": 0}

    for idx, item in enumerate(valid_items, 1):
        print(f"[{idx}/{len(valid_items)}] {item.get('title', 'Video')}", flush=True)
        res = download_single_video(item, output_dir=output_dir, proxy=proxy)
        st = res.get("status", "failed")
        if st == "completed":
            results["completed"] += 1
        elif st == "exists":
            results["exists"] += 1
        else:
            results["failed"] += 1

    print("=======================================================", flush=True)
    print(f"[+] KR Download Summary:", flush=True)
    print(f"    - Newly Downloaded: {results['completed']}", flush=True)
    print(f"    - Already Existed:  {results['exists']}", flush=True)
    print(f"    - Failed:           {results['failed']}", flush=True)
    print(f"    - Destination:      {os.path.abspath(output_dir)}", flush=True)
    print("=======================================================\n", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="KR video downloader with live progress percentage"
    )
    parser.add_argument(
        "--json",
        default="kr_videos.json",
        help="Path to JSON file (default: kr_videos.json)",
    )
    parser.add_argument(
        "--output-dir",
        default=os.path.join("downloads", "kr"),
        help="Directory to save downloaded videos",
    )
    parser.add_argument(
        "--limit", type=int, default=None, help="Limit number of videos to download"
    )
    parser.add_argument(
        "--proxy",
        default=None,
        help="Optional HTTP/SOCKS proxy (e.g. http://127.0.0.1:7890 or socks5://127.0.0.1:1080)",
    )

    args = parser.parse_args()
    download_all_kr_videos(
        json_file=args.json,
        output_dir=args.output_dir,
        limit=args.limit,
        proxy=args.proxy,
    )
