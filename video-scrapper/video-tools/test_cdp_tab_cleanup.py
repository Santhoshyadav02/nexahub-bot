"""Stale CDP tab cleanup: tabs recorded by an interrupted run are closed on the next start.

Run: python test_cdp_tab_cleanup.py
"""
import json
import shutil
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from pipeline import CDP_TABS_FILE, close_stale_cdp_tabs, record_cdp_tab  # noqa: E402

passed = failed = 0


def check(label, cond, detail=""):
    global passed, failed
    if cond:
        print(f"  PASS {label}")
        passed += 1
    else:
        print(f"  FAIL {label} {detail}")
        failed += 1


class FakeDevTools(BaseHTTPRequestHandler):
    open_targets = set()
    close_calls = []

    def do_GET(self):
        if self.path.startswith("/json/close/"):
            target = self.path.rsplit("/", 1)[-1]
            FakeDevTools.close_calls.append(target)
            if target in FakeDevTools.open_targets:
                FakeDevTools.open_targets.discard(target)
                self.send_response(200); self.end_headers(); self.wfile.write(b"Target is closing")
                return
        self.send_response(404); self.end_headers()

    def log_message(self, *args):
        pass


def main():
    server = HTTPServer(("127.0.0.1", 0), FakeDevTools)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    cdp_url = f"http://127.0.0.1:{server.server_port}"
    root = Path(tempfile.mkdtemp(prefix="cdp_tabs_"))
    state = root / CDP_TABS_FILE
    try:
        record_cdp_tab(state, "T1")
        record_cdp_tab(state, "T2")
        record_cdp_tab(state, "T2")
        check("ids recorded once each", json.loads(state.read_text()) == ["T1", "T2"])

        record_cdp_tab(state, "T1", add=False)
        check("cleanly closed tab removed from state", json.loads(state.read_text()) == ["T2"])

        record_cdp_tab(state, "T3")
        FakeDevTools.open_targets = {"T2"}  # T3 is already gone (browser restarted)
        closed = close_stale_cdp_tabs(state, cdp_url)
        check("open leftover tab closed", closed == 1 and "T2" not in FakeDevTools.open_targets, f"closed={closed}")
        check("close requested for every recorded id", sorted(FakeDevTools.close_calls) == ["T2", "T3"], str(FakeDevTools.close_calls))
        check("state file removed after cleanup", not state.exists())

        check("no state file -> nothing to close", close_stale_cdp_tabs(state, cdp_url) == 0)

        state.write_text("not json")
        check("corrupt state tolerated", close_stale_cdp_tabs(state, cdp_url) == 0 and not state.exists())

        record_cdp_tab(state, "T9")
        check("unreachable browser tolerated", close_stale_cdp_tabs(state, "http://127.0.0.1:1", timeout=1) == 0)

        record_cdp_tab(state, "X"); record_cdp_tab(state, "X", add=False)
        check("last id removed -> state file deleted", not state.exists())
    finally:
        server.shutdown()
        shutil.rmtree(root, ignore_errors=True)

    print(f"\nRESULT: {passed} passed, {failed} failed")
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
