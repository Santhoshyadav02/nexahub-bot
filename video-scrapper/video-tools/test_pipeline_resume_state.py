"""Startup state: unfinished downloads reopen their post instead of re-queuing stale URLs.

Run: python test_pipeline_resume_state.py
"""
import json
import shutil
import sys
import tempfile
from argparse import Namespace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from pipeline import ContinuousPipeline  # noqa: E402

passed = failed = 0


def check(label, cond, detail=""):
    global passed, failed
    if cond:
        print(f"  PASS {label}")
        passed += 1
    else:
        print(f"  FAIL {label} {detail}")
        failed += 1


def make_pipeline(root, records, report):
    out, dl = root / "out", root / "dl"
    out.mkdir(parents=True, exist_ok=True)
    dl.mkdir(parents=True, exist_ok=True)
    (out / "videos.json").write_text(json.dumps(records), encoding="utf-8")
    (dl / "download_report.json").write_text(json.dumps(report), encoding="utf-8")
    args = Namespace(url="https://source.test/list", input_links=None, output=str(out), downloads=str(dl),
                     workers=1, interval=60, queue_cap=10, timeout=5, headed=False, cdp_url=None,
                     play=False, once=True, target_links=10, max_pages=1)
    return ContinuousPipeline(args)


def main():
    root = Path(tempfile.mkdtemp(prefix="pipeline_resume_"))
    try:
        done_post, stale_post, reopened_post, error_post = (f"https://source.test/post/{n}" for n in "ABCD")
        records = [
            {"page_url": done_post, "video_urls": ["https://cdn.test/a?sig=1"], "status": "found"},
            {"page_url": stale_post, "video_urls": ["https://cdn.test/b?sig=old"], "status": "found"},
            # older stale record, then a newer visit whose download completed
            {"page_url": reopened_post, "video_urls": ["https://cdn.test/c?sig=old"], "status": "found"},
            {"page_url": reopened_post, "video_urls": ["https://cdn.test/c?sig=new"], "status": "found"},
            {"page_url": error_post, "video_urls": [], "status": "error"},
        ]
        report = [
            {"video_url": "https://cdn.test/a?sig=1", "status": "downloaded"},
            {"video_url": "https://cdn.test/c?sig=new", "status": "downloaded"},
        ]
        p = make_pipeline(root, records, report)

        check("nothing re-queued from stored URLs", p.job_queue.qsize() == 0, f"queued={p.job_queue.qsize()}")
        check("completed post stays seen", done_post in p.seen_post_links)
        check("post with unfinished download is reopened", stale_post not in p.seen_post_links)
        check("post whose latest record completed stays seen", reopened_post in p.seen_post_links)
        check("post that found no video is reopened", error_post not in p.seen_post_links)
        check("stale video URL not marked seen", "https://cdn.test/b?sig=old" not in p.seen_video_urls)
        check("completed video URL marked seen", "https://cdn.test/a?sig=1" in p.seen_video_urls)
    finally:
        shutil.rmtree(root, ignore_errors=True)

    print(f"\nRESULT: {passed} passed, {failed} failed")
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
