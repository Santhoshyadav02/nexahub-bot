"""Download direct MP4 sources from the scraper's videos.json in parallel (standard library only)."""

import argparse
import concurrent.futures
import hashlib
import json
import os
import signal
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


def is_valid_mp4_header(prefix: bytes) -> bool:
    """Verify minimum 8 bytes and ISOBMFF ftyp/moov atom box type."""
    if len(prefix) < 8:
        return False
    box_type = prefix[4:8]
    return box_type in (b'ftyp', b'moov')


def read_exact(response, n: int) -> bytes:
    """Read exactly n bytes from response stream unless EOF is reached."""
    buf = bytearray()
    while len(buf) < n:
        chunk = response.read(n - len(buf))
        if not chunk:
            break
        buf.extend(chunk)
    return bytes(buf)


def download(url, page_url, target, timeout, job_prefix=""):
    # Generate unique temporary part filename per worker/invocation
    temp_suffix = f'.part.{time.time_ns()}.tmp'
    partial = target.parent / (target.name + temp_suffix)
    headers = {'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'identity'}
    if page_url:
        headers['Referer'] = page_url

    try:
        req = Request(url, headers=headers)
        with urlopen(req, timeout=timeout) as response:
            status = getattr(response, 'status', 200)
            if status != 200:
                raise ValueError(f'Unexpected HTTP status: {status}')

            content_type = response.headers.get('Content-Type', 'unknown')
            expected_header = response.headers.get('Content-Length')
            total = int(expected_header) if (expected_header is not None and expected_header.isdigit()) else None

            print(f'{job_prefix} HTTP {status} content-type={content_type} content-length={total if total is not None else "chunked"}', flush=True)

            # Read first 32 bytes safely to check MP4 container header
            prefix = read_exact(response, 32)
            if not is_valid_mp4_header(prefix):
                raise ValueError(f'Not a direct MP4 response (missing MP4 ftyp header, read {len(prefix)} bytes)')

            print(f'{job_prefix} MP4 header check PASS', flush=True)

            received = len(prefix)
            last_log_time = time.monotonic()

            with partial.open('wb') as output:
                output.write(prefix)
                while True:
                    chunk = response.read(256 * 1024)
                    if not chunk:
                        break
                    output.write(chunk)
                    received += len(chunk)
                    if time.monotonic() - last_log_time >= 2:
                        mb = received / (1024 * 1024)
                        if total:
                            print(f'{job_prefix} STREAM {mb:.1f} MB / {total / (1024 * 1024):.1f} MB ({received / total:.1%})', flush=True)
                        else:
                            print(f'{job_prefix} STREAM {mb:.1f} MB', flush=True)
                        last_log_time = time.monotonic()

                output.flush()
                try:
                    os.fsync(output.fileno())
                except OSError:
                    pass

            print(f'{job_prefix} EOF bytes={received}', flush=True)

            if total is not None and received != total:
                raise ValueError(f'Incomplete download: Content-Length mismatch (expected {total}, got {received})')

            if received == 0:
                raise ValueError('Downloaded file is 0 bytes')

            # Atomic replace to final target
            partial.replace(target)

            if not target.exists() or target.stat().st_size == 0:
                raise ValueError('Final destination file is missing or 0 bytes after move')

            print(f'{job_prefix} FINAL size={target.stat().st_size}', flush=True)
            return target.stat().st_size

    finally:
        if partial.exists():
            try:
                partial.unlink(missing_ok=True)
            except OSError:
                pass


def is_valid_existing_file(target: Path) -> bool:
    """Check if target exists and has a non-zero size with a valid MP4 header."""
    if not target.exists() or target.stat().st_size < 32:
        return False
    try:
        with target.open('rb') as f:
            header = f.read(32)
            return is_valid_mp4_header(header)
    except OSError:
        return False


def write_json_atomic(path, data):
    """Write JSON via a same-directory temp file + os.replace, so a kill mid-write
    never leaves a truncated report behind (os.replace is atomic on POSIX and Windows)."""
    temp_path = path.parent / f'{path.name}.tmp.{time.time_ns()}'
    temp_path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding='utf-8')
    os.replace(temp_path, path)


def process_job(job_info, folder, timeout):
    index, total_jobs, url, page_url = job_info
    filename = 'video_' + hashlib.sha256(url.encode()).hexdigest()[:20] + '.mp4'
    target = folder / filename
    job_prefix = f'[{index}/{total_jobs}]'
    result = dict(page_url=page_url, video_url=url, file='', status='', error='')

    try:
        scheme = urlsplit(url).scheme.lower()
        if scheme not in ('http', 'https'):
            result.update(status='skipped', error='Requires direct HTTP/HTTPS MP4 URL; blob sources cannot be downloaded here')
            print(f'{job_prefix} SKIPPED {filename} (unsupported scheme: {scheme})', flush=True)
            return index, result

        if is_valid_existing_file(target):
            result.update(status='already_exists', file=str(target.resolve()))
            print(f'{job_prefix} ALREADY_EXISTS {filename} (size={target.stat().st_size})', flush=True)
            return index, result

        print(f'{job_prefix} START {filename}', flush=True)
        final_size = download(url, page_url, target, timeout, job_prefix)
        result.update(status='downloaded', file=str(target.resolve()))
        print(f'{job_prefix} DONE {filename} (size={final_size})', flush=True)

    except Exception as exc:
        result.update(status='error', error=str(exc))
        print(f'{job_prefix} ERROR {filename}: {exc}', flush=True)

    return index, result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('json_file', nargs='?', default='output/videos.json')
    parser.add_argument('--output', default='downloads')
    parser.add_argument('--timeout', type=float, default=60, help='Network timeout in seconds')
    parser.add_argument('--workers', type=int, default=4, help='Number of concurrent download workers (1-8)')
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error('--timeout must be positive')
    if args.workers < 1 or args.workers > 8:
        parser.error('--workers must be between 1 and 8')

    # SIGTERM (service stop) takes the same path as Ctrl+C: the partial report is still written.
    def handle_sigterm(signum, frame):
        raise KeyboardInterrupt()
    try:
        signal.signal(signal.SIGTERM, handle_sigterm)
    except (ValueError, OSError, AttributeError):
        pass

    try:
        records = json.loads(Path(args.json_file).read_text(encoding='utf-8-sig'))
        if not isinstance(records, list):
            raise ValueError('Expected a JSON array from scrape_videos.py')
        jobs = {}
        for record in records:
            if not isinstance(record, dict):
                raise ValueError('Each JSON entry must be an object')
            urls = record.get('video_urls', [])
            page_url = record.get('page_url', '')
            if not isinstance(urls, list) or not all(isinstance(u, str) for u in urls):
                raise ValueError('video_urls must be an array of strings')
            if not isinstance(page_url, str):
                raise ValueError('page_url must be a string')
            for url in urls:
                if url.strip():
                    jobs.setdefault(url.strip(), page_url)
    except (OSError, ValueError) as exc:
        parser.error(str(exc))

    folder = Path(args.output)
    folder.mkdir(parents=True, exist_ok=True)

    if not jobs:
        print('No video URLs found in JSON.')
        write_json_atomic(folder / 'download_report.json', [])
        return

    start_time = time.monotonic()
    job_list = [
        (idx, len(jobs), url, page_url)
        for idx, (url, page_url) in enumerate(jobs.items(), 1)
    ]

    print(f'Starting downloads: {len(job_list)} unique URLs with {args.workers} worker(s)...', flush=True)

    ordered_results = [None] * len(job_list)
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
            future_to_job = {
                executor.submit(process_job, job, folder, args.timeout): job
                for job in job_list
            }
            for future in concurrent.futures.as_completed(future_to_job):
                try:
                    idx, result = future.result()
                    ordered_results[idx - 1] = result
                except Exception as exc:
                    job = future_to_job[future]
                    idx = job[0]
                    ordered_results[idx - 1] = dict(
                        page_url=job[3], video_url=job[2], file='', status='error', error=str(exc)
                    )
    except KeyboardInterrupt:
        print('\nDownload interrupted by user.', flush=True)

    report = [r for r in ordered_results if r is not None]
    write_json_atomic(folder / 'download_report.json', report)

    elapsed = time.monotonic() - start_time
    downloaded = sum(1 for r in report if r.get('status') == 'downloaded')
    existing = sum(1 for r in report if r.get('status') == 'already_exists')
    failed = sum(1 for r in report if r.get('status') == 'error')
    skipped = sum(1 for r in report if r.get('status') == 'skipped')
    successful = downloaded + existing

    print('\n========================================')
    print('=== DOWNLOAD SUMMARY ===')
    print(f'Total jobs: {len(jobs)}')
    print(f'Successful: {successful} (Downloaded: {downloaded}, Existing: {existing})')
    print(f'Failed: {failed}')
    print(f'Skipped: {skipped}')
    print(f'Workers: {args.workers}')
    print(f'Elapsed: {elapsed:.2f}s')
    print(f'Done. Files and JSON report: {folder.resolve()}')
    print('========================================')


if __name__ == '__main__':
    main()
