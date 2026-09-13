/**
 * process_lock.js
 *
 * Single-instance guard for the NexaHub bot. The bot owns one Telegram
 * polling slot and one MTProto user session; a second process on the same
 * machine (a duplicate PM2 app, a manual `node index.js`, a standalone
 * MTProto script) causes 409 polling conflicts and can get the session
 * permanently revoked by Telegram (AUTH_KEY_DUPLICATED).
 *
 * The lock is a JSON file in the data dir holding { pid, bootTime }. A lock is
 * considered stale when its process is gone or it was written during a
 * previous OS boot (protects against PID reuse after a reboot).
 *
 * NOTE: this only protects one machine. Never run the production session
 * string on two machines (e.g. laptop + server) at the same time.
 */

const fs = require("fs");
const os = require("os");
const { dataPath } = require("./runtime_paths");

const LOCK_FILE_NAME = "nexahub-bot.lock";
const BOOT_TIME_TOLERANCE_MS = 2 * 60 * 1000;

function getLockPath() {
  return dataPath(LOCK_FILE_NAME);
}

function currentBootTime() {
  return Date.now() - Math.round(os.uptime() * 1000);
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return err.code === "EPERM";
  }
}

function readLock() {
  try {
    const lockPath = getLockPath();
    if (!fs.existsSync(lockPath)) return null;
    return JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch (err) {
    return null;
  }
}

/**
 * Returns the lock holder info if another live bot process holds the lock,
 * otherwise null.
 */
function getActiveLockHolder() {
  const lock = readLock();
  if (!lock || lock.pid === process.pid) return null;
  if (typeof lock.bootTime === "number" && Math.abs(lock.bootTime - currentBootTime()) > BOOT_TIME_TOLERANCE_MS) {
    return null;
  }
  return isPidAlive(lock.pid) ? lock : null;
}

let ownsLock = false;

/**
 * Acquires the lock for this process. Returns { acquired: true } or
 * { acquired: false, holder }.
 */
function acquireBotLock() {
  const holder = getActiveLockHolder();
  if (holder) {
    return { acquired: false, holder };
  }
  const payload = {
    pid: process.pid,
    host: os.hostname(),
    bootTime: currentBootTime(),
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(getLockPath(), JSON.stringify(payload, null, 2), "utf8");
  ownsLock = true;
  process.once("exit", releaseBotLock);
  return { acquired: true };
}

function releaseBotLock() {
  if (!ownsLock) return;
  try {
    const lock = readLock();
    if (lock && lock.pid === process.pid) {
      fs.unlinkSync(getLockPath());
    }
  } catch (err) {}
  ownsLock = false;
}

/**
 * For standalone MTProto scripts: refuse to run while the bot is running on
 * this machine, because both would use the same session string.
 */
function assertBotNotRunning(scriptName) {
  if (process.argv.includes("--allow-while-bot-running")) return;
  const holder = getActiveLockHolder();
  if (holder) {
    console.error(`❌ ${scriptName}: the NexaHub bot is running (PID ${holder.pid}). Running this script now would reuse the same MTProto session and can get it revoked (AUTH_KEY_DUPLICATED). Stop the bot first, or pass --allow-while-bot-running if this script uses a different session.`);
    process.exit(1);
  }
}

module.exports = {
  acquireBotLock,
  releaseBotLock,
  getActiveLockHolder,
  assertBotNotRunning,
  isPidAlive,
};
