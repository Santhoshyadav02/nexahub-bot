"""Local, fully offline tests for the proxy configuration layer.

No network access, no real proxy, no external or adult site involved - see
check_proxy.py for the separate, explicit, opt-in live diagnostic against a safe
public IP-echo endpoint.

Covers:
  A. no proxy configured -> load_proxy_config() is None, existing direct-connection
     Playwright launch still works (regression check against a local fixture server)
  B. one configured proxy (via env vars) -> load_proxy_config() parses it correctly
     into the exact shape Playwright expects, and redacted() never leaks the secret
"""
import http.server
import json
import os
import threading
import unittest
from pathlib import Path
from unittest import mock

from playwright.sync_api import sync_playwright

import proxy_config
from proxy_config import load_proxy_config, redacted


class _EchoHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({"ip": self.client_address[0], "path": self.path}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass  # keep test output quiet


class ProxyConfigTests(unittest.TestCase):
    def setUp(self):
        for var in ("PROXY_SERVER", "PROXY_USERNAME", "PROXY_PASSWORD"):
            os.environ.pop(var, None)
        # Isolate from whatever real .proxy.local.json a developer may actually have
        # configured on disk for live use - these tests must be hermetic regardless.
        patcher = mock.patch.object(proxy_config, "LOCAL_CONFIG_PATH", Path("/nonexistent/.proxy.local.json"))
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_a_no_proxy_by_default(self):
        self.assertIsNone(load_proxy_config())
        self.assertEqual(redacted(None), "none")

    def test_b_configured_proxy_parsed_and_redacted(self):
        os.environ["PROXY_SERVER"] = "104.207.58.10:3129"
        os.environ["PROXY_USERNAME"] = "testuser"
        os.environ["PROXY_PASSWORD"] = "testsecret"
        proxy = load_proxy_config()
        self.assertEqual(proxy, {
            "server": "104.207.58.10:3129",
            "username": "testuser",
            "password": "testsecret",
        })
        summary = redacted(proxy)
        self.assertIn("104.207.58.10:3129", summary)
        self.assertIn("auth: yes", summary)
        self.assertNotIn("testsecret", summary)
        self.assertNotIn("testuser", summary)

    def test_a_direct_connection_regression_local_fixture(self):
        """No proxy configured -> Playwright launches and browses exactly as before."""
        server = http.server.HTTPServer(("127.0.0.1", 0), _EchoHandler)
        port = server.server_port
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            proxy = load_proxy_config()
            self.assertIsNone(proxy)
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True, proxy=proxy)
                try:
                    page = browser.new_context().new_page()
                    page.goto(f"http://127.0.0.1:{port}/ip", wait_until="domcontentloaded")
                    data = json.loads(page.evaluate("document.body.innerText"))
                    self.assertEqual(data["ip"], "127.0.0.1")
                finally:
                    browser.close()
        finally:
            server.shutdown()
            thread.join(timeout=5)
            server.server_close()

    def test_c_proxy_required_but_missing_fails_loudly(self):
        """PROXY_REQUIRED=true + no resolvable proxy must raise, never silently
        proceed as Proxy: none."""
        os.environ["PROXY_REQUIRED"] = "true"
        self.addCleanup(os.environ.pop, "PROXY_REQUIRED", None)
        self.assertIsNone(load_proxy_config())
        with self.assertRaises(proxy_config.ProxyRequiredError):
            proxy_config.require_proxy_if_expected(load_proxy_config())

    def test_d_proxy_required_and_present_passes_silently(self):
        os.environ["PROXY_REQUIRED"] = "true"
        os.environ["PROXY_SERVER"] = "104.207.58.10:3129"
        self.addCleanup(os.environ.pop, "PROXY_REQUIRED", None)
        proxy = load_proxy_config()
        self.assertIsNotNone(proxy)
        proxy_config.require_proxy_if_expected(proxy)  # must not raise

    def test_e_proxy_not_required_and_missing_is_fine(self):
        os.environ.pop("PROXY_REQUIRED", None)
        self.assertIsNone(load_proxy_config())
        proxy_config.require_proxy_if_expected(None)  # must not raise

    def test_f_error_message_never_contains_credentials(self):
        os.environ["PROXY_REQUIRED"] = "true"
        self.addCleanup(os.environ.pop, "PROXY_REQUIRED", None)
        try:
            proxy_config.require_proxy_if_expected(None)
            self.fail("expected ProxyRequiredError")
        except proxy_config.ProxyRequiredError as exc:
            self.assertNotIn("PROXY_PASSWORD", str(exc).lower())


if __name__ == "__main__":
    unittest.main()
