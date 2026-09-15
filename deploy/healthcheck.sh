#!/bin/bash
# NexaHub VPS health check (run every 5 minutes from cron).
# Alerts HEALTHCHECK_CHAT_ID (else ADMIN_USER_ID) via the bot's own BOT_TOKEN when the bot is down, memory
# is nearly exhausted, the verified Chrome is leaking tabs, or the disk is
# filling up. It never restarts anything itself - it only reports, and repeats
# the same alert at most once per hour so a lasting problem doesn't spam.
set -u

APP_DIR="${APP_DIR:-/opt/nexahub-bot}"
STATE_DIR="${STATE_DIR:-/var/lib/nexahub/healthcheck}"
MIN_AVAILABLE_MB="${MIN_AVAILABLE_MB:-400}"
MAX_CHROME_PROCS="${MAX_CHROME_PROCS:-40}"
MAX_DISK_PERCENT="${MAX_DISK_PERCENT:-85}"
REPEAT_SECONDS="${REPEAT_SECONDS:-3600}"

mkdir -p "$STATE_DIR"
env_value() { grep -E "^$1=" "$APP_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"'\r'; }
BOT_TOKEN="$(env_value BOT_TOKEN)"
# A dedicated chat for alerts, so alerting doesn't require granting bot admin rights.
ADMIN_ID="$(env_value HEALTHCHECK_CHAT_ID)"
[ -n "$ADMIN_ID" ] || ADMIN_ID="$(env_value ADMIN_USER_ID)"

problems=()

bot_status="$(pm2 jlist 2>/dev/null | python3 -c "import sys,json
try:
    print(next((p['pm2_env']['status'] for p in json.load(sys.stdin) if p['name']=='nexahub-bot'), 'missing'))
except Exception:
    print('unknown')")"
[ "$bot_status" = "online" ] || problems+=("bot is $bot_status")

available_mb="$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)"
[ "$available_mb" -ge "$MIN_AVAILABLE_MB" ] || problems+=("low memory: ${available_mb} MB available")

chrome_procs="$(pgrep -fc '[g]oogle-chrome|[c]hrome/chrome' || true)"
[ "${chrome_procs:-0}" -le "$MAX_CHROME_PROCS" ] || problems+=("verified Chrome has ${chrome_procs} processes (tab leak?)")
systemctl is-active --quiet nexahub-chrome || problems+=("nexahub-chrome service is not active")

disk_percent="$(df --output=pcent / | tail -1 | tr -dc '0-9')"
[ "$disk_percent" -lt "$MAX_DISK_PERCENT" ] || problems+=("disk ${disk_percent}% full")

load1="$(cut -d' ' -f1 /proc/loadavg)"
cpus="$(nproc)"
awk -v l="$load1" -v c="$cpus" 'BEGIN{exit !(l > c*4)}' && problems+=("load ${load1} on ${cpus} CPUs")

stamp_file="$STATE_DIR/last_alert"
if [ ${#problems[@]} -eq 0 ]; then
  if [ -f "$stamp_file" ]; then
    rm -f "$stamp_file"
    msg="✅ NexaHub VPS recovered ($(hostname), $(date -u '+%H:%M UTC'))"
    [ -n "$BOT_TOKEN" ] && [ -n "$ADMIN_ID" ] && curl -s -m 15 "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${ADMIN_ID}" --data-urlencode "text=${msg}" >/dev/null
  fi
  exit 0
fi

summary="$(printf '%s; ' "${problems[@]}")"
echo "$(date -u '+%F %T') ${summary}" >> "$STATE_DIR/alerts.log"
now="$(date +%s)"
last="$(cat "$stamp_file" 2>/dev/null || echo 0)"
if [ $((now - last)) -ge "$REPEAT_SECONDS" ]; then
  echo "$now" > "$stamp_file"
  msg="⚠️ NexaHub VPS ($(hostname), $(date -u '+%H:%M UTC')): ${summary}"
  if [ -n "$BOT_TOKEN" ] && [ -n "$ADMIN_ID" ]; then
    curl -s -m 15 "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${ADMIN_ID}" --data-urlencode "text=${msg}" >/dev/null
  fi
fi
