/**
 * ============================================================
 * 🎬 VIDEO PIPELINE MANAGER (Phase 1 - process orchestration only)
 * ============================================================
 * Thin wrapper that starts, monitors, and stops the existing, independent
 * video-tools acquisition pipeline as a child process:
 *
 *   D:\Automation\hiruboy\video-scrapper\video-tools
 *
 * This module does NOT reimplement scraping or downloading. It never touches
 * Playwright, never parses HTML, never opens a socket to a media URL - it only
 * spawns video-tools' own run_pipeline.ps1 and passes configuration straight
 * through as CLI arguments, exactly as a human would from a terminal.
 *
 * Scope boundary (see the NexaHub architecture audit for the full picture):
 * - No Telegram publishing of any kind.
 * - No metadata enrichment, routing, or scheduling.
 * - No production AVSEE/external-source flags are read, set, or activated here.
 * - Not started automatically from index.js in this phase - see
 *   video_pipeline/test_video_pipeline_manager.js for the controlled test entry point.
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const LOG_PREFIX = "[VIDEO_PIPELINE_MANAGER]";

const VIDEO_TOOLS_DIR = path.join(__dirname, "..", "video-scrapper", "video-tools");
const RUN_SCRIPT_PATH = path.join(VIDEO_TOOLS_DIR, "run_pipeline.ps1");
const DEFAULT_GRACEFUL_TIMEOUT_MS = 5000;
const DEFAULT_FORCE_TIMEOUT_MS = 3000;

/**
 * Builds the PowerShell CLI argument list for run_pipeline.ps1 from a plain
 * options object. Every option here maps 1:1 to an existing, already-working
 * run_pipeline.ps1 parameter - nothing is invented or reimplemented.
 * @param {object} options
 * @returns {string[]}
 */
function buildArgs(runScriptPath, options) {
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", runScriptPath];

  if (options.inputLinks) {
    args.push("-InputLinks", options.inputLinks);
  } else if (options.url) {
    args.push(options.url);
  }

  if (options.output) args.push("-Output", options.output);
  if (options.downloads) args.push("-Downloads", options.downloads);
  if (options.workers) args.push("-Workers", String(options.workers));
  if (options.interval) args.push("-Interval", String(options.interval));
  if (options.queueCap) args.push("-QueueCap", String(options.queueCap));
  if (options.timeoutSec) args.push("-Timeout", String(options.timeoutSec));
  if (options.targetLinks) args.push("-TargetLinks", String(options.targetLinks));
  if (options.maxPages) args.push("-MaxPages", String(options.maxPages));
  if (options.once) args.push("-Once");
  if (options.noPlay) args.push("-NoPlay");
  if (options.standalone) args.push("-Standalone");
  if (options.headed) args.push("-Headed");
  if (options.browser) args.push("-Browser", options.browser);
  if (options.port) args.push("-Port", String(options.port));

  return args;
}

/**
 * Builds the Python CLI argument list for pipeline.py directly (used on Linux/Railway).
 * @param {string} pythonScriptPath
 * @param {object} options
 * @returns {string[]}
 */
function buildPythonArgs(pythonScriptPath, options) {
  const args = [pythonScriptPath];

  if (options.inputLinks) {
    args.push("--input-links", options.inputLinks);
  } else if (options.url) {
    args.push(options.url);
  }

  if (options.output) args.push("--output", options.output);
  if (options.downloads) args.push("--downloads", options.downloads);
  if (options.workers) args.push("--workers", String(options.workers));
  if (options.interval) args.push("--interval", String(options.interval));
  if (options.queueCap) args.push("--queue-cap", String(options.queueCap));
  if (options.timeoutSec) args.push("--timeout", String(options.timeoutSec));
  if (options.targetLinks) args.push("--target-links", String(options.targetLinks));
  if (options.maxPages) args.push("--max-pages", String(options.maxPages));
  if (options.once) args.push("--once");
  if (options.noPlay) args.push("--no-play");
  if (options.headed) args.push("--headed");
  if (options.cdpUrl) args.push("--cdp-url", options.cdpUrl);

  return args;
}

class VideoPipelineManager {
  /**
   * @param {object} [config]
   * @param {string} [config.videoToolsDir] Override for video-tools' directory (tests only)
   * @param {string} [config.runScriptPath] Override for run_pipeline.ps1's path (tests only)
   * @param {number} [config.gracefulTimeoutMs] Time to wait for a clean exit before forcing
   * @param {number} [config.forceTimeoutMs] Time to wait after a forced kill before giving up
   */
  constructor(config = {}) {
    this.videoToolsDir = config.videoToolsDir || VIDEO_TOOLS_DIR;
    this.runScriptPath = config.runScriptPath || RUN_SCRIPT_PATH;
    this.gracefulTimeoutMs = config.gracefulTimeoutMs || DEFAULT_GRACEFUL_TIMEOUT_MS;
    this.forceTimeoutMs = config.forceTimeoutMs || DEFAULT_FORCE_TIMEOUT_MS;

    this._child = null;
    this._pid = null;
    this._startedAt = null;
    this._lastExitCode = null;
    this._lastExitSignal = null;
    this._lastError = null;
    this._acceptingStarts = true;
    this._onLine = typeof config.onLine === "function" ? config.onLine : null;
  }

  /**
   * @returns {boolean} true only while a child process is actually alive
   */
  isRunning() {
    return this._child !== null && this._pid !== null;
  }

  /**
   * @returns {object} operational status snapshot - no secrets, no internal handles
   */
  getStatus() {
    return {
      running: this.isRunning(),
      pid: this._pid,
      startedAt: this._startedAt,
      lastExitCode: this._lastExitCode,
      lastExitSignal: this._lastExitSignal,
      lastError: this._lastError
    };
  }

  /**
   * Starts video-tools acquisition pipeline as a child process.
   * On Windows, uses run_pipeline.ps1; on Linux/Railway, executes pipeline.py via python.
   * @param {object} [options] See buildArgs() / buildPythonArgs() for supported fields.
   * @returns {{status: string, pid?: number, error?: string}}
   */
  start(options = {}) {
    if (!this._acceptingStarts) {
      console.warn(`${LOG_PREFIX} start() refused: manager is shutting down.`);
      return { status: "SHUTTING_DOWN" };
    }

    if (this.isRunning()) {
      console.warn(`${LOG_PREFIX} start() refused: already running (PID ${this._pid}).`);
      return { status: "ALREADY_RUNNING", pid: this._pid };
    }

    const isWindows = process.platform === "win32";
    const pythonScriptPath = path.join(this.videoToolsDir, "pipeline.py");
    let cmd, args;

    if (isWindows && fs.existsSync(this.runScriptPath)) {
      cmd = "powershell.exe";
      args = buildArgs(this.runScriptPath, options);
    } else {
      if (!fs.existsSync(pythonScriptPath)) {
        const error = `pipeline.py not found at ${pythonScriptPath}`;
        this._lastError = error;
        console.error(`${LOG_PREFIX} ${error}`);
        return { status: "START_FAILED", error };
      }
      cmd = process.env.PYTHON_PATH || (isWindows ? "python" : "python3");
      args = buildPythonArgs(pythonScriptPath, options);
    }

    console.log(`${LOG_PREFIX} Starting video-tools pipeline (cwd=${this.videoToolsDir})`);
    console.log(`${LOG_PREFIX} ${cmd} ${args.join(" ")}`);

    let child;
    try {
      child = spawn(cmd, args, {
        cwd: this.videoToolsDir,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PYTHONUNBUFFERED: "1" }
      });
    } catch (spawnErr) {
      this._lastError = spawnErr.message;
      console.error(`${LOG_PREFIX} Failed to spawn child process: ${spawnErr.message}`);
      return { status: "START_FAILED", error: spawnErr.message };
    }

    this._child = child;
    this._pid = child.pid;
    this._startedAt = new Date().toISOString();
    this._lastExitCode = null;
    this._lastExitSignal = null;
    this._lastError = null;

    this._attachChildHandlers(child);

    console.log(`${LOG_PREFIX} Started (PID ${this._pid}).`);
    return { status: "STARTED", pid: this._pid };
  }

  _attachChildHandlers(child) {
    const forwardLines = (stream, tag) => {
      stream.on("data", (chunk) => {
        const lines = chunk.toString("utf8").split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          console.log(`${LOG_PREFIX} [${tag}] ${line}`);
          if (this._onLine) {
            try {
              this._onLine(tag, line);
            } catch (e) {
              // A caller-supplied observer must never crash the manager.
            }
          }
        }
      });
    };
    forwardLines(child.stdout, "stdout");
    forwardLines(child.stderr, "stderr");

    child.on("error", (err) => {
      this._lastError = err.message;
      console.error(`${LOG_PREFIX} Child process error: ${err.message}`);
    });

    child.on("exit", (code, signal) => {
      console.log(`${LOG_PREFIX} Child process exited (code=${code}, signal=${signal}).`);
      this._lastExitCode = code;
      this._lastExitSignal = signal;
      this._child = null;
      this._pid = null;
    });
  }

  /**
   * Stops the running child process tree cleanly. On Windows, a plain
   * child.kill() only performs an immediate TerminateProcess and does not
   * reliably reach a PowerShell -> Python -> Chromium process tree, so this
   * uses `taskkill /PID <pid> /T` (whole-tree, no force) first and gives the
   * pipeline.py side's own SIGINT/SIGTERM handler a window to run its
   * existing graceful-shutdown logic (draining workers, closing the browser).
   * If it hasn't exited within gracefulTimeoutMs, falls back to
   * `taskkill /PID <pid> /T /F` (forced, whole-tree) so no orphan process is
   * ever left behind - matches every other shutdown path in this repo's
   * "bounded fallback" convention (see index.js's handleProcessExit).
   * @returns {Promise<{status: string}>}
   */
  async stop() {
    if (!this.isRunning()) {
      return { status: "NOT_RUNNING" };
    }

    const pid = this._pid;
    const child = this._child;
    console.log(`${LOG_PREFIX} Stopping child process tree (PID ${pid})...`);

    const exited = new Promise((resolve) => {
      child.once("exit", () => resolve());
    });

    this._runTaskkill(pid, { force: false });

    const gracefulResult = await Promise.race([
      exited.then(() => "exited"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), this.gracefulTimeoutMs))
    ]);

    if (gracefulResult === "exited") {
      console.log(`${LOG_PREFIX} Stopped cleanly (PID ${pid}).`);
      return { status: "STOPPED" };
    }

    console.warn(`${LOG_PREFIX} Graceful stop timed out after ${this.gracefulTimeoutMs}ms; forcing kill (PID ${pid}).`);
    this._runTaskkill(pid, { force: true });

    const forcedResult = await Promise.race([
      exited.then(() => "exited"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), this.forceTimeoutMs))
    ]);

    if (forcedResult === "timeout") {
      const error = `Process tree for PID ${pid} did not exit even after a forced kill.`;
      this._lastError = error;
      console.error(`${LOG_PREFIX} ${error}`);
      return { status: "STOP_FAILED", error };
    }

    console.log(`${LOG_PREFIX} Stopped by force (PID ${pid}).`);
    return { status: "STOPPED_FORCED" };
  }

  _runTaskkill(pid, { force }) {
    const args = ["/PID", String(pid), "/T"];
    if (force) args.push("/F");
    try {
      const killer = spawn("taskkill", args, { windowsHide: true, stdio: "ignore" });
      killer.on("error", (err) => {
        console.error(`${LOG_PREFIX} taskkill failed to launch: ${err.message}`);
      });
    } catch (err) {
      console.error(`${LOG_PREFIX} taskkill failed to launch: ${err.message}`);
    }
  }

  /**
   * Blocks any further start() calls without touching an already-running
   * child. Intended for use during NexaHub's own shutdown sequence, before
   * calling stop().
   */
  preventFurtherStarts() {
    this._acceptingStarts = false;
  }

  /**
   * Re-allows start() calls (mainly for tests that reuse one manager instance
   * across multiple start/stop cycles).
   */
  allowFurtherStarts() {
    this._acceptingStarts = true;
  }
}

// Singleton accessor, matching the existing getPipelineInstance() convention
// already used by external_source_pipeline.js.
let singleton = null;
function getManager(config = {}) {
  if (!singleton) {
    singleton = new VideoPipelineManager(config);
  }
  return singleton;
}

module.exports = {
  VideoPipelineManager,
  getManager,
  VIDEO_TOOLS_DIR,
  RUN_SCRIPT_PATH
};
