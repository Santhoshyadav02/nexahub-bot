/**
 * runtime_paths.js
 *
 * Central place for where NexaHub keeps mutable runtime state, plus
 * crash-safe JSON persistence helpers.
 *
 * - NEXAHUB_DATA_DIR (optional): directory for all runtime JSON state
 *   (ledgers, caches, registries). Defaults to the repository directory so
 *   local development keeps working unchanged. On a server, point it at a
 *   directory outside the git checkout (e.g. /var/lib/nexahub) so `git pull`
 *   never conflicts with, or rolls back, live state.
 * - Files that are committed to git (e.g. source_registry.json) act as seeds:
 *   the first time a state file is requested inside a separate data dir, the
 *   committed copy is copied there once, and from then on only the data-dir
 *   copy is read and written.
 */

const fs = require("fs");
const path = require("path");

const REPO_DIR = __dirname;

function getDataDir() {
  const configured = String(process.env.NEXAHUB_DATA_DIR || "").trim();
  return configured ? path.resolve(configured) : REPO_DIR;
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
}

/**
 * Absolute path for a runtime file inside the data dir (no seeding).
 */
function dataPath(...segments) {
  const dataDir = ensureDir(getDataDir());
  return path.join(dataDir, ...segments);
}

/**
 * Absolute path for a runtime file inside the data dir. If the data dir is
 * separate from the repo and the file does not exist there yet, the committed
 * repo copy (if any) is copied in first.
 */
function seededDataPath(fileName) {
  const target = dataPath(fileName);
  const seed = path.join(REPO_DIR, fileName);
  if (target !== seed && !fs.existsSync(target) && fs.existsSync(seed)) {
    try {
      ensureDir(path.dirname(target));
      fs.copyFileSync(seed, target);
      console.log(`[RUNTIME_PATHS] Seeded ${fileName} into data dir ${path.dirname(target)}`);
    } catch (err) {
      console.error(`[RUNTIME_PATHS] Failed to seed ${fileName}: ${err.message}`);
    }
  }
  return target;
}

/**
 * Writes a string atomically: temp file in the same directory -> fsync ->
 * rename over the target. A crash or SIGKILL mid-write leaves either the old
 * file or the new file, never a torn one. Throws on failure.
 */
function writeFileAtomicSync(filePath, content) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tmpPath, "w");
    fs.writeSync(fd, content, null, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    try {
      fs.renameSync(tmpPath, filePath);
    } catch (renameErr) {
      // Windows can refuse to replace a file that another handle (AV, editor)
      // has open. Fall back to copy-over, which is still far safer than an
      // in-place truncate+write of the target.
      if (renameErr.code === "EPERM" || renameErr.code === "EACCES" || renameErr.code === "EBUSY") {
        fs.copyFileSync(tmpPath, filePath);
        fs.unlinkSync(tmpPath);
      } else {
        throw renameErr;
      }
    }
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (e) {}
    }
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) {}
    throw err;
  }
}

function writeJsonAtomicSync(filePath, data, { pretty = true } = {}) {
  writeFileAtomicSync(filePath, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data));
}

/**
 * Moves an unreadable/corrupt state file aside so it is preserved for manual
 * recovery instead of being silently overwritten. Returns the new path, or
 * null if nothing was moved.
 */
function quarantineCorruptFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const corruptPath = `${filePath}.corrupt-${stamp}`;
    fs.renameSync(filePath, corruptPath);
    console.error(`[RUNTIME_PATHS] Corrupt state file preserved as ${corruptPath}`);
    return corruptPath;
  } catch (err) {
    console.error(`[RUNTIME_PATHS] Failed to quarantine corrupt file ${filePath}: ${err.message}`);
    return null;
  }
}

module.exports = {
  REPO_DIR,
  getDataDir,
  ensureDir,
  dataPath,
  seededDataPath,
  writeFileAtomicSync,
  writeJsonAtomicSync,
  quarantineCorruptFile,
};
