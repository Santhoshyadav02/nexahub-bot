#!/bin/bash
# Remote, human-verified browser for the video downloader (server equivalent of
# video-scrapper/video-tools/start_browser.ps1).
#
# - Real Google Chrome on a virtual display (Xvfb :99), run as the unprivileged
#   user "nexabrowser" (not root).
# - Chrome DevTools endpoint on 127.0.0.1:9222 only -> pipeline.py --cdp-url.
# - Screen shared via x11vnc (127.0.0.1:5900) and noVNC (127.0.0.1:6080).
#   Nothing listens on a public interface; access only through an SSH tunnel.
# - A human opens the site in this browser and completes any verification
#   manually, exactly like the local Windows flow.
set -euo pipefail

BROWSER_USER="nexabrowser"
BROWSER_HOME="/var/lib/nexahub-browser"
PROFILE_DIR="$BROWSER_HOME/chrome-profile"
DISPLAY_NUM=":99"

export DEBIAN_FRONTEND=noninteractive
APT="apt-get -y -o DPkg::Lock::Timeout=300"

echo "== packages"
$APT update -qq
$APT install -qq xvfb x11vnc novnc websockify fluxbox wget ca-certificates fonts-noto-cjk >/dev/null
if ! command -v google-chrome >/dev/null; then
  wget -q -O /tmp/google-chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  $APT install -qq /tmp/google-chrome.deb >/dev/null
  rm -f /tmp/google-chrome.deb
fi
echo "chrome: $(google-chrome --version)"

echo "== user"
if ! id "$BROWSER_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$BROWSER_HOME" --create-home --shell /usr/sbin/nologin "$BROWSER_USER"
fi
mkdir -p "$PROFILE_DIR"
chown -R "$BROWSER_USER:$BROWSER_USER" "$BROWSER_HOME"
chmod 700 "$BROWSER_HOME"

echo "== systemd units"
cat > /etc/systemd/system/nexahub-xvfb.service <<UNIT
[Unit]
Description=NexaHub remote browser - virtual display $DISPLAY_NUM
After=network.target

[Service]
User=$BROWSER_USER
ExecStart=/usr/bin/Xvfb $DISPLAY_NUM -screen 0 1366x900x24 -nolisten tcp
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/nexahub-fluxbox.service <<UNIT
[Unit]
Description=NexaHub remote browser - window manager
After=nexahub-xvfb.service
Requires=nexahub-xvfb.service

[Service]
User=$BROWSER_USER
Environment=DISPLAY=$DISPLAY_NUM
Environment=HOME=$BROWSER_HOME
ExecStartPre=/bin/sleep 2
ExecStart=/usr/bin/fluxbox
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/nexahub-chrome.service <<UNIT
[Unit]
Description=NexaHub remote browser - Google Chrome (DevTools on 127.0.0.1:9222)
After=nexahub-fluxbox.service
Requires=nexahub-xvfb.service

[Service]
User=$BROWSER_USER
Environment=DISPLAY=$DISPLAY_NUM
Environment=HOME=$BROWSER_HOME
ExecStartPre=/bin/sleep 3
ExecStart=/usr/bin/google-chrome --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir=$PROFILE_DIR --no-first-run --no-default-browser-check --disable-dev-shm-usage --start-maximized about:blank
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/nexahub-vnc.service <<UNIT
[Unit]
Description=NexaHub remote browser - VNC (127.0.0.1:5900 only)
After=nexahub-xvfb.service
Requires=nexahub-xvfb.service

[Service]
User=$BROWSER_USER
ExecStartPre=/bin/sleep 2
ExecStart=/usr/bin/x11vnc -display $DISPLAY_NUM -localhost -rfbport 5900 -forever -shared -nopw -quiet
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/nexahub-novnc.service <<UNIT
[Unit]
Description=NexaHub remote browser - noVNC web viewer (127.0.0.1:6080 only)
After=nexahub-vnc.service
Requires=nexahub-vnc.service

[Service]
User=$BROWSER_USER
ExecStart=/usr/bin/websockify --web=/usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now nexahub-xvfb nexahub-fluxbox nexahub-chrome nexahub-vnc nexahub-novnc
sleep 12

echo "== verify"
for s in nexahub-xvfb nexahub-fluxbox nexahub-chrome nexahub-vnc nexahub-novnc; do
  echo "$s: $(systemctl is-active $s)"
done
echo "devtools: $(curl -s --max-time 5 http://127.0.0.1:9222/json/version | grep -o '"Browser": *"[^"]*"' || echo NOT RESPONDING)"
echo "novnc page: http=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:6080/vnc.html)"
echo "listeners (must all be 127.0.0.1 except sshd):"
ss -ltnp | awk 'NR>1{print $4, $6}' | grep -E ':(22|5900|6080|9222) ' || true
echo "REMOTE_BROWSER_READY"
