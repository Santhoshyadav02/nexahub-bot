"""Continuous Producer/Consumer Video Pipeline with Playwright discovery and parallel workers."""

import argparse
import hashlib
import json
import os
import queue
import signal
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode

from playwright.sync_api import Error as PlaywrightError, TimeoutError as PlaywrightTimeoutError, sync_playwright

from download_videos import download, is_valid_existing_file
from proxy_config import load_proxy_config, redacted
from scrape_videos import POST_SELECTOR, connect_browser, extract_post_title, verification_visible, video_sources


class ContinuousPipeline:
    def __init__(self, args):
        self.url = args.url
        self.input_links = args.input_links
        self.output_dir = Path(args.output)
        self.downloads_dir = Path(args.downloads)
        self.workers_count = args.workers
        self.interval = args.interval
        self.queue_cap = args.queue_cap
        self.timeout = args.timeout
        self.headless = not args.headed
        self.cdp_url = args.cdp_url
        self.play = args.play
        self.once = args.once
        self.target_links = args.target_links
        self.max_pages = args.max_pages
        self.proxy = load_proxy_config()

        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.downloads_dir.mkdir(parents=True, exist_ok=True)

        self.job_queue = queue.Queue(maxsize=self.queue_cap)
        self.stop_event = threading.Event()

        self.records_lock = threading.RLock()
        self.report_lock = threading.RLock()

        self.seen_post_links = set()
        self.seen_video_urls = set()
        self.discovered_records = []
        self.download_reports = []

        self.worker_threads = []
        self.job_counter = 0
        self.stats = {
            "discovered_posts": 0,
            "discovered_videos": 0,
            "downloaded": 0,
            "already_exists": 0,
            "failed": 0,
            "skipped": 0,
            "total_bytes": 0
        }

        self._load_existing_state()
        self._cleanup_stale_temp_files()

    def _cleanup_stale_temp_files(self):
        """Remove orphaned .part.*.tmp files left by a previous run that was killed
        uncleanly (e.g. process crash, task-kill, power loss). Each download attempt
        uses a nanosecond-unique temp suffix (see download_videos.download), so any
        such file found at startup cannot belong to a job this process is about to
        run and can never be resumed - it is always safe to discard."""
        removed, freed_bytes = 0, 0
        patterns = [
            (self.downloads_dir, "*.part.*.tmp"),
            (self.output_dir, "videos.json.tmp.*"),
            (self.downloads_dir, "download_report.json.tmp.*"),
        ]
        for directory, pattern in patterns:
            for stale in directory.glob(pattern):
                try:
                    freed_bytes += stale.stat().st_size
                    stale.unlink()
                    removed += 1
                except OSError:
                    pass
        if removed:
            freed_mb = freed_bytes / (1024 * 1024)
            print(f"[Startup] Cleaned up {removed} stale temp file(s) from a previous run ({freed_mb:.1f} MB freed)", flush=True)

    def _load_existing_state(self):
        videos_json = self.output_dir / "videos.json"
        if videos_json.exists():
            try:
                data = json.loads(videos_json.read_text(encoding="utf-8-sig"))
                if isinstance(data, list):
                    self.discovered_records = data
            except Exception:
                pass

        report_json = self.downloads_dir / "download_report.json"
        successful_urls = set()
        if report_json.exists():
            try:
                rep = json.loads(report_json.read_text(encoding="utf-8-sig"))
                if isinstance(rep, list):
                    self.download_reports = rep
                    for r in rep:
                        if isinstance(r, dict) and r.get("status") in ("downloaded", "already_exists"):
                            vu = r.get("video_url")
                            if isinstance(vu, str) and vu.strip():
                                successful_urls.add(vu.strip())
            except Exception:
                pass

        # "Seen" must mean *completed*, not merely *discovered*. A post that errored
        # (verification block, network blip) or a video that was found but never
        # finished downloading (process killed, connection reset) must stay eligible
        # for retry on the next cycle/run - otherwise it is silently lost forever.
        resumed = 0
        for item in self.discovered_records:
            if not isinstance(item, dict):
                continue
            page = item.get("page_url")
            video_urls = item.get("video_urls", [])
            if not isinstance(video_urls, list):
                video_urls = []
            post_fully_done = bool(video_urls)
            for v in video_urls:
                if not (isinstance(v, str) and v.strip()):
                    continue
                v = v.strip()
                filename = "video_" + hashlib.sha256(v.encode()).hexdigest()[:20] + ".mp4"
                if v in successful_urls or is_valid_existing_file(self.downloads_dir / filename):
                    self.seen_video_urls.add(v)
                    continue
                # Discovered earlier but never actually downloaded - resume it now
                # instead of waiting for the post to be revisited.
                self.job_counter += 1
                try:
                    self.job_queue.put_nowait((self.job_counter, self.job_counter, v, page))
                    self.seen_video_urls.add(v)
                    resumed += 1
                except queue.Full:
                    post_fully_done = False  # leave it unseen so the post gets revisited later
            if page and post_fully_done:
                self.seen_post_links.add(page)
        if resumed:
            print(f"[Startup] Resumed {resumed} previously-discovered video(s) that never finished downloading", flush=True)

    def _save_records(self):
        with self.records_lock:
            temp_path = self.output_dir / f"videos.json.tmp.{time.time_ns()}"
            temp_path.write_text(
                json.dumps(self.discovered_records, indent=2, ensure_ascii=False),
                encoding="utf-8"
            )
            temp_path.replace(self.output_dir / "videos.json")

    def _save_report(self):
        with self.report_lock:
            temp_path = self.downloads_dir / f"download_report.json.tmp.{time.time_ns()}"
            temp_path.write_text(
                json.dumps(self.download_reports, indent=2, ensure_ascii=False),
                encoding="utf-8"
            )
            temp_path.replace(self.downloads_dir / "download_report.json")

    @staticmethod
    def _with_page_param(url, page_num):
        """Return url with its query string's page= param set to page_num (added if absent)."""
        parts = urlsplit(url)
        query = dict(parse_qsl(parts.query))
        query["page"] = str(page_num)
        return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))

    @staticmethod
    def _canonical_post_url(url):
        """Strip the navigational 'page' param the site embeds in each post's own link
        (e.g. '...&wr_id=123&page=2') so the same post is recognized as already-seen even
        after it shifts to a different listing page - otherwise it would look "new" again
        on every later cycle and get needlessly re-visited/re-recorded forever."""
        parts = urlsplit(url)
        query = [(k, v) for k, v in parse_qsl(parts.query) if k != "page"]
        return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))

    def _worker_loop(self, worker_id):
        worker_name = f"Worker {worker_id}"
        while not self.stop_event.is_set():
            try:
                job = self.job_queue.get(timeout=0.5)
            except queue.Empty:
                if self.stop_event.is_set():
                    break
                continue

            if job is None:
                self.job_queue.task_done()
                break

            job_idx, total_jobs, video_url, page_url = job
            filename = "video_" + hashlib.sha256(video_url.encode()).hexdigest()[:20] + ".mp4"
            target_path = self.downloads_dir / filename
            job_prefix = f"[{worker_name}]"
            result = dict(page_url=page_url, video_url=video_url, file="", status="", error="")

            try:
                scheme = urlsplit(video_url).scheme.lower()
                if scheme not in ("http", "https"):
                    result.update(status="skipped", error="Unsupported scheme")
                    print(f"{job_prefix} SKIPPED {filename} (unsupported scheme: {scheme})", flush=True)
                    with self.report_lock:
                        self.stats["skipped"] += 1
                elif is_valid_existing_file(target_path):
                    result.update(status="already_exists", file=str(target_path.resolve()))
                    print(f"{job_prefix} ALREADY_EXISTS {filename} (size={target_path.stat().st_size})", flush=True)
                    with self.report_lock:
                        self.stats["already_exists"] += 1
                else:
                    print(f"{job_prefix} START {filename}", flush=True)
                    final_size = download(video_url, page_url, target_path, self.timeout, job_prefix=job_prefix)
                    result.update(status="downloaded", file=str(target_path.resolve()))
                    print(f"{job_prefix} DONE {filename} (size={final_size})", flush=True)
                    with self.report_lock:
                        self.stats["downloaded"] += 1
                        self.stats["total_bytes"] += final_size

            except Exception as exc:
                result.update(status="error", error=str(exc))
                print(f"{job_prefix} ERROR {filename}: {exc}", flush=True)
                with self.report_lock:
                    self.stats["failed"] += 1

            with self.report_lock:
                self.download_reports.append(result)
                self._save_report()

            self.job_queue.task_done()

    def run(self):
        print("============================================================")
        print("CONTINUOUS VIDEO PIPELINE")
        print("============================================================")
        print(f"Producer: STARTED")
        print(f"Browser: {'HEADLESS' if self.headless else 'HEADED'}")
        print(f"Workers: {self.workers_count}")
        print(f"Queue capacity: {self.queue_cap}")
        print(f"Discovery interval: {self.interval}s")
        print(f"Mode: {'ONCE (Single Batch)' if self.once else 'CONTINUOUS'}")
        print(f"Proxy: {redacted(self.proxy)}")
        if self.proxy and self.cdp_url:
            print("NOTE: --cdp-url attaches to an already-running browser; its proxy was fixed "
                  "at that browser's own launch time and cannot be changed from here. The "
                  "configured proxy above will be ignored for this run.")
        print("============================================================", flush=True)

        # 1. Start background download worker threads
        for wid in range(1, self.workers_count + 1):
            t = threading.Thread(target=self._worker_loop, args=(wid,), daemon=True)
            t.start()
            self.worker_threads.append(t)

        # 2. Main thread runs the Playwright Producer
        print("\n[Producer] Starting Playwright browser...", flush=True)
        with sync_playwright() as p:
            browser = None
            if self.cdp_url:
                try:
                    browser = connect_browser(p.chromium, self.cdp_url, self.timeout * 1000)
                except Exception as exc:
                    print(f"[Producer] Cannot connect to CDP browser: {exc}", flush=True)
                    self.stop()
                    return
                context = browser.contexts[0]
            else:
                browser = p.chromium.launch(headless=self.headless, proxy=self.proxy)
                context = browser.new_context()

            page = context.new_page()
            page.set_default_timeout(self.timeout * 1000)

            cycle = 1
            try:
                while not self.stop_event.is_set():
                    print(f"\n[Producer] Discovery Cycle #{cycle} started...", flush=True)
                    discovered_in_cycle = 0

                    # Fetch Post Links
                    post_links = []
                    if self.input_links and Path(self.input_links).exists():
                        try:
                            raw_links = json.loads(Path(self.input_links).read_text(encoding="utf-8-sig"))
                            if isinstance(raw_links, list):
                                post_links = [l for l in raw_links if isinstance(l, str)]
                        except Exception as exc:
                            print(f"[Producer] Error reading input links: {exc}", flush=True)
                    elif self.url:
                        try:
                            collected = []
                            seen_this_cycle = set()
                            blocked = False
                            consecutive_empty_pages = 0
                            page_num = 1
                            while len(collected) < self.target_links and page_num <= self.max_pages:
                                page_url = self._with_page_param(self.url, page_num) if page_num > 1 else self.url
                                response = page.goto(page_url, wait_until="domcontentloaded")
                                try:
                                    page.locator(POST_SELECTOR).first.wait_for(state="attached", timeout=min(5000, self.timeout * 1000))
                                except Exception:
                                    pass

                                if verification_visible(page):
                                    status = response.status if response is not None else "?"
                                    print(f"[Producer] BLOCKED: Listing page returned a bot-verification/challenge page "
                                          f"(HTTP {status}, title: {page.title()!r}) instead of real content. "
                                          f"Headless Chromium cannot solve this. Re-run with --headed and solve it "
                                          f"manually, or start a verified session with start_browser.ps1 and pass "
                                          f"--cdp-url http://127.0.0.1:9222 instead.", flush=True)
                                    blocked = True
                                    break

                                extracted = page.locator(POST_SELECTOR).evaluate_all('''anchors => anchors
                                    .filter(a => (a.getAttribute('href') || '').trim() && !a.getAttribute('href').trim().startsWith('#'))
                                    .map(a => a.href).filter(u => u.startsWith('https://') || u.startsWith('http://'))''')
                                extracted = [self._canonical_post_url(u) for u in extracted]
                                new_on_page = [u for u in dict.fromkeys(extracted) if u not in seen_this_cycle]
                                for u in new_on_page:
                                    seen_this_cycle.add(u)
                                    collected.append(u)

                                if not extracted:
                                    consecutive_empty_pages += 1
                                    if consecutive_empty_pages >= 2:
                                        print(f"[Producer] Page {page_num} had no posts - reached the end of the listing.", flush=True)
                                        break
                                else:
                                    consecutive_empty_pages = 0

                                print(f"[Producer] Page {page_num}: +{len(new_on_page)} link(s) "
                                      f"(total collected {len(collected)}/{self.target_links})", flush=True)
                                page_num += 1

                            if not blocked:
                                post_links = collected
                                if not post_links:
                                    print(f"[Producer] WARNING: 0 links matched selector '{POST_SELECTOR}' across "
                                          f"{page_num - 1} page(s). The site's markup may have changed, or this "
                                          f"listing has no posts.", flush=True)
                                try:
                                    (self.output_dir / "post_links.json").write_text(
                                        json.dumps(post_links, indent=2, ensure_ascii=False),
                                        encoding="utf-8"
                                    )
                                except Exception:
                                    pass
                        except Exception as exc:
                            print(f"[Producer] Error visiting listing URL: {exc}", flush=True)

                    new_posts = [l for l in post_links if l not in self.seen_post_links]
                    print(f"[Producer] Discovered {len(post_links)} total post links ({len(new_posts)} new)", flush=True)

                    # Visit each new post
                    for idx, post_url in enumerate(new_posts, 1):
                        if self.stop_event.is_set():
                            break

                        self.seen_post_links.add(post_url)
                        print(f"[Producer] [{idx}/{len(new_posts)}] Opening post: {post_url}", flush=True)
                        result = dict(page_url=post_url, title="", video_urls=[], status="not_found", error="")

                        try:
                            response = page.goto(post_url, wait_until="commit")
                            try:
                                page.wait_for_load_state("domcontentloaded", timeout=min(5000, self.timeout * 1000))
                            except PlaywrightTimeoutError:
                                pass

                            result["title"] = extract_post_title(page)
                            sources = video_sources(page, self.timeout, self.play, verification_wait=10, headed=not self.headless)
                            if sources:
                                result["video_urls"] = sources
                                result["status"] = "found"
                            else:
                                result["error"] = "No nonempty video source appeared before timeout"
                        except Exception as exc:
                            result.update(status="error", error=str(exc))

                        with self.records_lock:
                            self.discovered_records.append(result)
                            self._save_records()

                        # Enqueue newly discovered video sources immediately
                        for v_url in result["video_urls"]:
                            if v_url not in self.seen_video_urls:
                                self.seen_video_urls.add(v_url)
                                self.job_counter += 1
                                job = (self.job_counter, self.job_counter, v_url, post_url)

                                # Apply backpressure if queue is full
                                enqueued = False
                                while not enqueued and not self.stop_event.is_set():
                                    try:
                                        self.job_queue.put(job, timeout=0.5)
                                        enqueued = True
                                        discovered_in_cycle += 1
                                        print(f"[Queue] Added job #{self.job_counter} (Queue size: {self.job_queue.qsize()}/{self.queue_cap})", flush=True)
                                    except queue.Full:
                                        print(f"⚠️ [Queue] Capacity ({self.queue_cap}) reached! Producer applying backpressure...", flush=True)

                    print(f"[Producer] Cycle #{cycle} complete: {discovered_in_cycle} new video URLs queued.", flush=True)

                    if self.once:
                        break

                    cycle += 1
                    sleep_deadline = time.monotonic() + self.interval
                    while time.monotonic() < sleep_deadline and not self.stop_event.is_set():
                        time.sleep(0.5)

            finally:
                try:
                    context.close()
                    if browser is not None:
                        browser.close()
                except Exception:
                    pass
                print("[Producer] Browser closed cleanly.", flush=True)

        if self.once:
            print("\n[Pipeline] Producer finished. Waiting for worker queue to drain...", flush=True)
            self.job_queue.join()
            self.stop()
        else:
            self.stop()

    def stop(self):
        self.stop_event.set()
        for _ in self.worker_threads:
            try:
                self.job_queue.put_nowait(None)
            except Exception:
                pass
        for t in self.worker_threads:
            t.join(timeout=3)
        self._print_summary()

    def _print_summary(self):
        print("\n============================================================")
        print("PIPELINE SUMMARY")
        print("============================================================")
        print(f"Discovered Post Records: {len(self.discovered_records)}")
        print(f"Unique Video URLs: {len(self.seen_video_urls)}")
        print(f"Downloaded: {self.stats['downloaded']}")
        print(f"Already Exists: {self.stats['already_exists']}")
        print(f"Failed: {self.stats['failed']}")
        print(f"Skipped: {self.stats['skipped']}")
        print(f"Total Bytes Downloaded: {self.stats['total_bytes']}")
        print(f"Output files: {self.output_dir.resolve() / 'videos.json'}")
        print(f"Download report: {self.downloads_dir.resolve() / 'download_report.json'}")
        print("============================================================", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url", nargs="?", default="", help="Main website/listing URL")
    parser.add_argument("--input-links", help="Read saved post_links.json instead of visiting main page")
    parser.add_argument("--output", default="output", help="Directory to save videos.json")
    parser.add_argument("--downloads", default="downloads", help="Directory to save MP4 downloads")
    parser.add_argument("--workers", type=int, default=4, help="Number of concurrent download workers (1-8)")
    parser.add_argument("--interval", type=float, default=30.0, help="Interval in seconds between producer discovery cycles")
    parser.add_argument("--queue-cap", type=int, default=150, help="Maximum items allowed in producer/consumer queue")
    parser.add_argument("--timeout", type=float, default=60.0, help="Network timeout in seconds per page/download")
    parser.add_argument("--headless", action="store_true", default=True, help="Run browser in headless mode (default: True)")
    parser.add_argument("--headed", action="store_true", help="Show browser window")
    parser.add_argument("--cdp-url", help="Attach to browser started with remote debugging")
    parser.add_argument("--play", action="store_true", default=True, help="Try muted playback to initialize video src")
    parser.add_argument("--once", action="store_true", help="Perform one discovery cycle and exit")
    parser.add_argument("--target-links", type=int, default=100,
                         help="Keep paginating the listing (page=2, page=3, ...) each discovery cycle "
                              "until at least this many post links are collected, then stop paginating (default: 100)")
    parser.add_argument("--max-pages", type=int, default=50,
                         help="Safety cap on how many listing pages to paginate through per cycle (default: 50)")

    args = parser.parse_args()
    if args.workers < 1 or args.workers > 8:
        parser.error("--workers must be between 1 and 8")
    if args.interval <= 0:
        parser.error("--interval must be positive")
    if args.queue_cap < 1:
        parser.error("--queue-cap must be at least 1")
    if args.target_links < 1:
        parser.error("--target-links must be at least 1")
    if args.max_pages < 1:
        parser.error("--max-pages must be at least 1")

    pipeline = ContinuousPipeline(args)

    def sig_handler(signum, frame):
        print(f"\n[Pipeline] Signal {signum} caught. Initiating graceful shutdown...", flush=True)
        pipeline.stop()
        sys.exit(0)

    signal.signal(signal.SIGINT, sig_handler)
    signal.signal(signal.SIGTERM, sig_handler)

    pipeline.run()


if __name__ == "__main__":
    main()
