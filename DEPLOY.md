# Deploying NexaHub bot (Ubuntu 22.04 VPS)

Target: 2 vCPU / 4 GB RAM / 300 GB SSD, Ubuntu 22.04, PM2, one instance.

## 1. One-time server setup

```bash
# Swap (protects against OOM kills while Chromium/ffmpeg run)
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Node 22, ffmpeg, git, Python
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs ffmpeg git python3-pip python3-venv
sudo npm i -g pm2
pm2 install pm2-logrotate

# Runtime state directory (outside the git checkout)
sudo mkdir -p /var/lib/nexahub && sudo chown "$USER" /var/lib/nexahub
```

## 2. Code and dependencies

```bash
git clone https://github.com/Santhoshyadav02/nexahub-bot.git
cd nexahub-bot
npm ci                                   # exact versions from package-lock.json
npx playwright install --with-deps chromium
```

Only if `VIDEO_PIPELINE_ENABLED=true`:

```bash
python3 -m venv .venv
.venv/bin/pip install -r video-scrapper/video-tools/requirements.txt
.venv/bin/python -m playwright install --with-deps chromium
# then in .env: PYTHON_PATH=/full/path/to/nexahub-bot/.venv/bin/python
```

Install Playwright browsers as the same user that runs PM2 (browsers are stored in that user's `~/.cache/ms-playwright`). Do not install the Ubuntu `chromium-browser` snap.

## 3. Configuration

```bash
cp .env.example .env
nano .env
```

- Fill `BOT_TOKEN`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION_STRING`.
- Keep `NEXAHUB_DATA_DIR=/var/lib/nexahub`.
- Do not set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` / `CHROME_BIN` (old Nixpacks paths).
- If you enable the video pipeline, `VIDEO_PIPELINE_SOURCE_MODE` must be set explicitly.

On first start the committed `source_registry.json`, `published_ledger.json`, `ranking.json`, etc. are copied into `/var/lib/nexahub` once; after that only the data-dir copies are used, so `git pull` never touches live state.

## 4. Before the first start: stop every other copy

The bot token was previously deployed elsewhere (Railway). During testing on 2026-09-13 another process was still polling this `BOT_TOKEN` (`409 Conflict`). Before starting the server copy:

- Stop/delete the old Railway service (or any other machine running `node index.js`).
- Check: `curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates?timeout=0&limit=1"` repeated a few times must never return `409`.
- If that deployment also used `TELEGRAM_SESSION_STRING`, regenerate the session after stopping it.

## 4b. Remote verified browser for video downloads

Sites protected by a "verify you are human" check block the headless downloader on the server. The server equivalent of `start_browser.ps1` is a real Chrome on a virtual display that **you** verify manually through a private remote screen:

```bash
sudo bash deploy/remote_browser_setup.sh
```

It installs Google Chrome, Xvfb, x11vnc and noVNC, creates the unprivileged user `nexabrowser`, and starts systemd services `nexahub-xvfb`, `nexahub-fluxbox`, `nexahub-chrome`, `nexahub-vnc`, `nexahub-novnc`. Chrome DevTools listens on `127.0.0.1:9222`, the viewer on `127.0.0.1:6080` — nothing is exposed publicly.

**Use it (from your PC):**

1. Open a tunnel and keep the window open:
   ```powershell
   ssh -N -L 6080:127.0.0.1:6080 root@<server-ip>
   ```
2. Browse to `http://localhost:6080/vnc.html` → **Connect**. You see the server's Chrome.
3. In that Chrome, open the website and complete the verification/login yourself.
4. On the server, run the downloader attached to that browser:
   ```bash
   cd /opt/nexahub-bot/video-scrapper/video-tools
   /opt/nexahub-bot/.venv/bin/python pipeline.py "WEBSITE_URL" --cdp-url http://127.0.0.1:9222 --once --workers 2 \
     --output /var/lib/nexahub/downloader/output --downloads /var/lib/nexahub/downloader/downloads
   ```
5. When the site asks again (verification expired), repeat steps 1–3.

**Automatic (the bot runs it on a schedule):** instead of step 4, let the PM2 bot start video-tools attached to that browser and upload through the MTProto user session. In `.env`:

```bash
VIDEO_PIPELINE_ENABLED=true
VIDEO_PIPELINE_SOURCE_MODE=authorized
VIDEO_PIPELINE_AUTHORIZED_SOURCE_URL=WEBSITE_URL
VIDEO_PIPELINE_CDP_URL=http://127.0.0.1:9222
VIDEO_PIPELINE_UPLOAD_MODE=mtproto          # Bot API stops at 50 MB
VIDEO_PIPELINE_STAGING_CHAT_ID=me           # "me" = the session account's Saved Messages
VIDEO_PIPELINE_RUN_ON_STARTUP=true
VIDEO_PIPELINE_WORKERS=2
VIDEO_PIPELINE_TIMEOUT_MS=36000000          # 10 h: multi-GB downloads + validation + upload
VIDEO_PIPELINE_VALIDATION_TIMEOUT_MS=3600000
VIDEO_PIPELINE_DOWNLOAD_MAX_BYTES=107374182400
```

Then `pm2 restart nexahub-bot --update-env` and watch `pm2 logs nexahub-bot | grep -E "VIDEO_PIPELINE|BATCH_CYCLE|MTPROTO_VIDEO"`. Files land in `/var/lib/nexahub/video_pipeline/downloads`; anything above `VIDEO_PIPELINE_MTPROTO_MAX_PART_BYTES` is split with ffmpeg stream copy (no re-encode) into numbered parts under `/var/lib/nexahub/video_pipeline/upload_parts`, which are deleted after upload. A `BLOCKED: ... bot-verification` line in the log means the verification expired: repeat steps 1–3; the next scheduled cycle picks up again.

**Health check and SSH protection:**

- `deploy/healthcheck.sh` runs from root's crontab every 5 minutes (`*/5 * * * * /bin/bash /opt/nexahub-bot/deploy/healthcheck.sh`). It only reports: bot not online, less than 400 MB available memory, the verified Chrome above 40 processes (leaked tabs), `nexahub-chrome` inactive, disk ≥ 85 %, or load above 4× CPUs. Alerts go to `HEALTHCHECK_CHAT_ID` through a separate alert bot (`HEALTHCHECK_BOT_TOKEN`, created with @BotFather) — never the production bot — at most once per hour per incident, plus a recovery message. Without both values the check only writes `/var/lib/nexahub/healthcheck/alerts.log`. The alert chat must have started the alert bot once.
- `fail2ban` (`/etc/fail2ban/jail.d/nexahub-sshd.local`) bans an IP for 1 h after 5 failed SSH logins in 10 min; add team IPs to `ignoreip`. `/etc/ssh/sshd_config.d/99-nexahub.conf` raises `MaxStartups` so brute-force bursts don't lock out real logins.
- Deploy with `git pull --ff-only` (never `git reset --hard` or force-push) and keep `VIDEO_PIPELINE_WORKERS=2` on the 2 vCPU / 4 GB server.

Notes: data-center IPs can still be refused by the site regardless of verification; only download content you have the rights to re-publish. Manage the browser with `systemctl restart nexahub-chrome` / `systemctl status nexahub-*`.

## 5. Run

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup        # run the command it prints
pm2 logs nexahub-bot
```

Never run a second copy of the bot (or the standalone MTProto scripts) with the same `TELEGRAM_SESSION_STRING` — not on this server and not on a laptop. Telegram revokes a session used by two clients at once (`AUTH_KEY_DUPLICATED`). The bot holds a lock file in the data dir and refuses to start twice on the same machine.

## 5. Updating

```bash
cd nexahub-bot
git pull
npm ci
pm2 restart nexahub-bot
```

## 6. Troubleshooting

| Log message | Meaning / action |
|---|---|
| `Another NexaHub bot process ... is already running` | A second copy was started. `pm2 list`, stop the duplicate. |
| `AUTH_KEY_DUPLICATED` | Session revoked. Generate a new session string, update `.env`, restart. |
| `FloodWait: Telegram requires a Ns pause` | MTProto work pauses automatically; nothing to do. |
| `Corrupt state file preserved as ...corrupt-...` | A state file was unreadable; the bad copy is kept for inspection. |
| `409 Conflict` polling | The same `BOT_TOKEN` is polling somewhere else. |
