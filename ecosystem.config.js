/**
 * PM2 process file for the NexaHub bot (Ubuntu VPS).
 *
 *   pm2 start ecosystem.config.js
 *   pm2 save && pm2 startup
 *
 * Exactly ONE instance in fork mode: the bot owns a single Telegram polling
 * slot and a single MTProto user session. A second copy causes 409 polling
 * conflicts and can get the session revoked (AUTH_KEY_DUPLICATED). The bot
 * also takes a lock file in NEXAHUB_DATA_DIR to refuse a second copy.
 */
module.exports = {
  apps: [
    {
      name: "nexahub-bot",
      script: "index.js",
      cwd: __dirname,
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      // The bot writes JSON state at runtime; watching would restart it in a loop.
      watch: false,
      max_memory_restart: "1500M",
      // index.js needs up to ~15s to stop schedulers, the video pipeline child
      // process and MTProto cleanly before exiting.
      kill_timeout: 20000,
      min_uptime: "60s",
      max_restarts: 50,
      exp_backoff_restart_delay: 2000,
      time: true,
      env: {
        NODE_ENV: "production",
        // Keep runtime state outside the git checkout so `git pull` never
        // conflicts with, or rolls back, ledgers and caches.
        NEXAHUB_DATA_DIR: "/var/lib/nexahub",
      },
    },
    {
      name: "nexahub-bot-2",
      script: "bot2_index.js",
      cwd: __dirname,
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1500M",
      kill_timeout: 20000,
      min_uptime: "60s",
      max_restarts: 50,
      exp_backoff_restart_delay: 2000,
      time: true,
      env: {
        NODE_ENV: "production",
        NEXAHUB_DATA_DIR: "/var/lib/nexahub",
      },
    },
    {
      name: "vip-pipeline",
      script: "vip/vip_pipeline_daemon.js",
      cwd: __dirname,
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1000M",
      kill_timeout: 15000,
      min_uptime: "30s",
      max_restarts: 50,
      exp_backoff_restart_delay: 3000,
      time: true,
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "vip-bot",
      script: "vip/vip_forwarder.js",
      cwd: __dirname,
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "800M",
      kill_timeout: 10000,
      min_uptime: "30s",
      max_restarts: 50,
      exp_backoff_restart_delay: 3000,
      time: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
