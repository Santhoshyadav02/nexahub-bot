"""Optional HTTP/HTTPS proxy configuration for Playwright's own browser launch.

Reads an explicitly configured proxy from environment variables (preferred) or a
local, gitignored JSON file, and returns it in the shape Playwright's
`chromium.launch(proxy=...)` / `launch_persistent_context(proxy=...)` expect.

Deliberately out of scope, by design:
  - no proxy rotation (one explicitly configured proxy per run)
  - no stealth / fingerprint / anti-bot-detection logic of any kind
  - no credentials ever hard-coded here or printed by redacted()

When no proxy is configured, load_proxy_config() returns None and every call site
that does `proxy=load_proxy_config()` behaves exactly as it did before this file
existed - Playwright treats proxy=None as "no proxy" (its own default).
"""
import json
import os
from pathlib import Path

LOCAL_CONFIG_PATH = Path(__file__).parent / ".proxy.local.json"


def load_proxy_config():
    """Return a Playwright-compatible proxy dict, or None if none is configured.

    Priority order:
      1. Environment variables: PROXY_SERVER, PROXY_USERNAME, PROXY_PASSWORD
      2. Local file .proxy.local.json (never committed - see .gitignore) with the
         same fields lowercased: {"server": "...", "username": "...", "password": "..."}

    PROXY_SERVER / "server" is a bare host:port or scheme://host:port, e.g.
    "104.207.58.10:3129" or "http://104.207.58.10:3129" - Playwright treats a
    bare host:port as an HTTP proxy.
    """
    server = os.environ.get("PROXY_SERVER", "").strip()
    username = os.environ.get("PROXY_USERNAME", "").strip()
    password = os.environ.get("PROXY_PASSWORD", "").strip()

    if not server and LOCAL_CONFIG_PATH.exists():
        try:
            data = json.loads(LOCAL_CONFIG_PATH.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        server = server or str(data.get("server", "")).strip()
        username = username or str(data.get("username", "")).strip()
        password = password or str(data.get("password", "")).strip()

    if not server:
        return None

    proxy = {"server": server}
    if username:
        proxy["username"] = username
    if password:
        proxy["password"] = password
    return proxy


def redacted(proxy):
    """Safe-to-print summary: host/port and whether auth is set. Never the password,
    and never the username either (it can itself be sensitive for some providers)."""
    if not proxy:
        return "none"
    server = proxy.get("server", "?")
    has_auth = bool(proxy.get("username") or proxy.get("password"))
    return f"{server} (auth: {'yes' if has_auth else 'no'})"
