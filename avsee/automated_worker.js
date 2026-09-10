/**
 * ============================================================
 * ⚙️ AVSEE AUTOMATED WORKER & SCHEDULER
 * ============================================================
 * Hardened polling worker and interval scheduler for authorized
 * media resolution with strict mutex locking, timeouts, failure
 * recovery, and graceful lifecycle shutdown.
 * 
 * Safety & Compliance:
 * - EXTERNAL_PUBLISH_ENABLED=false
 * - AVSEE_DRY_RUN=true
 * - Mutex single-run execution guard
 * - Hard timeouts on all operations
 * - Automatic browser/file resource cleanup
 * - Zero production Telegram publication
 * - Redacted diagnostic logging
 */

const path = require("path");
const fs = require("fs");
const { discoverBoardPosts, filterNewPosts } = require("./board_discovery");
const { AvseePipelineOrchestrator, PIPELINE_STATES } = require("./pipeline_orchestrator");
const { redactUrl } = require("./player_resolver");

const WORKER_STATES = Object.freeze({
  IDLE: "IDLE",
  RUNNING: "RUNNING",
  STOPPING: "STOPPING",
  STOPPED: "STOPPED",
  ERROR: "ERROR"
});

const DEFAULT_WORKER_CONFIG = Object.freeze({
  pollIntervalMs: parseInt(process.env.EXTERNAL_SOURCE_POLL_INTERVAL_MS, 10) || 30 * 60 * 1000,
  dryRun: process.env.AVSEE_DRY_RUN !== "false",
  maxConsecutiveFailures: 5,
  timeouts: {
    boardDiscoveryTimeoutMs: 30000,
    playerResolutionTimeoutMs: 30000,
    inactivityTimeoutMs: parseInt(process.env.MEDIA_DOWNLOAD_INACTIVITY_TIMEOUT_MS, 10) || 60000,
    mp4ValidationTimeoutMs: 10000
  }
});

class AvseeAutomatedWorker {
  /**
   * @param {object} [config]
   */
  constructor(config = {}) {
    this.boardUrl = config.boardUrl || process.env.AVSEE_API_URL || "https://02.avsee.is/bbs/board.php?bo_table=korea";
    this.pollIntervalMs = config.pollIntervalMs || DEFAULT_WORKER_CONFIG.pollIntervalMs;
    this.dryRun = config.dryRun !== undefined ? Boolean(config.dryRun) : DEFAULT_WORKER_CONFIG.dryRun;
    this.maxConsecutiveFailures = config.maxConsecutiveFailures || DEFAULT_WORKER_CONFIG.maxConsecutiveFailures;

    this.timeouts = {
      ...DEFAULT_WORKER_CONFIG.timeouts,
      ...(config.timeouts || {})
    };

    this.tempDir = config.tempDir || path.join(__dirname, "..", "scratch", "worker_temp");
    this.stateFilePath = config.stateFilePath || path.join(this.tempDir, "worker_state.json");

    this.orchestrator = config.orchestrator || new AvseePipelineOrchestrator({
      dryRun: this.dryRun,
      tempDir: this.tempDir,
      stateFilePath: this.stateFilePath,
      apiUrl: config.apiUrl || this.boardUrl,
      allowedDomains: config.allowedDomains || ["127.0.0.1", "localhost", "data.cdn.avsee.is", "02.avsee.is", "cdn.apiavsee.com"]
    });

    // Worker state & observability
    this.workerState = WORKER_STATES.IDLE;
    this.isExecutionLocked = false;
    this.timerId = null;
    this.isStarted = false;
    this.runCounter = 0;

    this.lastRunAt = null;
    this.lastSuccessAt = null;
    this.lastFailureAt = null;
    this.lastProcessedPostId = null;
    this.lastError = null;
    this.consecutiveFailures = 0;
    this.totalRuns = 0;
    this.totalSuccesses = 0;

    // Active resource tracker for cleanup
    this.activeResources = {
      browsers: new Set(),
      tempFiles: new Set()
    };

    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }

    this._boundShutdown = this.handleSignalShutdown.bind(this);
  }

  /**
   * Generates a safe, non-sensitive unique Run ID.
   * @private
   */
  _generateRunId() {
    this.runCounter++;
    const now = new Date();
    const dateStr = now.toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
    return `RUN_${dateStr}_${String(this.runCounter).padStart(3, "0")}`;
  }

  /**
   * Executes a single, complete polling & resolution cycle with mutex protection.
   * 
   * @param {object} [options]
   * @returns {Promise<{
   *   success: boolean,
   *   runId: string,
   *   status: string,
   *   error?: string|null,
   *   diagnostics?: object,
   *   pipelineResult?: object
   * }>}
   */
  async runOnce(options = {}) {
    const runId = this._generateRunId();

    // 1. Mutex Guard: Reject overlapping runs
    if (this.isExecutionLocked) {
      console.warn(`⚠️ [WORKER_MUTEX] [${runId}] Another worker run is already active. Action: SKIP_OVERLAPPING_RUN`);
      return {
        success: false,
        runId,
        status: "SKIPPED_OVERLAPPING",
        error: "Previous run is still active in mutex lock"
      };
    }

    if (this.workerState === WORKER_STATES.STOPPING || this.workerState === WORKER_STATES.STOPPED) {
      return {
        success: false,
        runId,
        status: "WORKER_STOPPED",
        error: "Worker is stopped or stopping"
      };
    }

    this.isExecutionLocked = true;
    this.workerState = WORKER_STATES.RUNNING;
    this.lastRunAt = new Date().toISOString();
    this.totalRuns++;

    console.log(`\n============================================================`);
    console.log(`⚙️ [WORKER RUN START] ${runId} | Time: ${this.lastRunAt}`);
    console.log(`============================================================`);

    try {
      const cycleResult = await this._executeCycle(runId, options);

      if (cycleResult.success) {
        this.consecutiveFailures = 0;
        this.lastSuccessAt = new Date().toISOString();
        this.totalSuccesses++;
        if (cycleResult.selectedPostId) {
          this.lastProcessedPostId = cycleResult.selectedPostId;
        }
      } else if (cycleResult.status !== "NO_NEW_POSTS" && cycleResult.status !== "SKIPPED_DUPLICATE") {
        this.consecutiveFailures++;
        this.lastFailureAt = new Date().toISOString();
        this.lastError = cycleResult.error || "Unknown cycle failure";
      }

      console.log(`⚙️ [WORKER RUN END] ${runId} | Status: ${cycleResult.status} | Consecutive Failures: ${this.consecutiveFailures}`);
      return cycleResult;

    } catch (err) {
      this.consecutiveFailures++;
      this.lastFailureAt = new Date().toISOString();
      this.lastError = err.message;

      console.error(`❌ [WORKER RUN ERROR] ${runId} | Error: ${err.message}`);
      await this.cleanupResources();

      return {
        success: false,
        runId,
        status: "RUN_FAILED",
        error: err.message
      };

    } finally {
      this.isExecutionLocked = false;
      if (this.workerState === WORKER_STATES.RUNNING) {
        this.workerState = WORKER_STATES.IDLE;
      }
      await this.cleanupResources();
    }
  }

  /**
   * Internal cycle execution logic
   * @private
   */
  async _executeCycle(runId, options = {}) {
    const targetBoardUrl = options.boardUrl || this.boardUrl;
    console.log(`[${runId}] Step 1: Discovering board listings from ${redactUrl(targetBoardUrl)}...`);

    // 1. Board Discovery
    const discovery = await discoverBoardPosts(targetBoardUrl, {
      headless: options.headless !== false,
      pageTimeoutMs: this.timeouts.boardDiscoveryTimeoutMs,
      limit: options.limit || 20
    });

    if (!discovery.success) {
      console.warn(`[${runId}] Discovery failed: ${discovery.error}`);
      return {
        success: false,
        runId,
        status: "DISCOVERY_FAILED",
        error: discovery.error
      };
    }

    const allPosts = discovery.posts || [];
    console.log(`[${runId}] Discovered ${allPosts.length} post(s) on board`);

    // 2. Dedupe Filtering
    const newPosts = filterNewPosts(allPosts, this.orchestrator.stateStore);
    console.log(`[${runId}] Found ${newPosts.length} new un-seen post(s)`);

    if (newPosts.length === 0) {
      console.log(`[${runId}] No new posts to process. Waiting for next interval.`);
      return {
        success: true,
        runId,
        status: "NO_NEW_POSTS",
        discoveredCount: allPosts.length,
        newPostsCount: 0
      };
    }

    // 3. Process the newest un-seen post
    const selectedPost = newPosts[0];
    const selectedPostId = selectedPost.itemId || selectedPost.postId;
    console.log(`[${runId}] Step 2: Processing post "${selectedPost.title}" (${selectedPostId})...`);

    const pipelineResult = await this.orchestrator.processAuthorizedPost(selectedPost, {
      pageTimeoutMs: this.timeouts.playerResolutionTimeoutMs,
      playerTimeoutMs: this.timeouts.playerResolutionTimeoutMs,
      logDiagnostics: options.logDiagnostics !== undefined ? options.logDiagnostics : false
    });

    if (!pipelineResult || !pipelineResult.success) {
      console.warn(`[${runId}] Pipeline processing failed for ${selectedPostId}: ${pipelineResult ? pipelineResult.error : "Unknown"}`);
      return {
        success: false,
        runId,
        selectedPostId,
        status: pipelineResult ? pipelineResult.pipelineState : "PIPELINE_FAILED",
        error: pipelineResult ? pipelineResult.error : "Pipeline failed",
        pipelineResult
      };
    }

    console.log(`[${runId}] Pipeline processing successful for ${selectedPostId}. Ledger Decision: ${pipelineResult.ledgerDecision}`);

    return {
      success: true,
      runId,
      selectedPostId,
      status: pipelineResult.pipelineState || "SUCCESS",
      pipelineResult
    };
  }

  /**
   * Starts the recurring interval scheduler.
   * @param {object} [options]
   */
  start(options = {}) {
    if (this.isStarted) {
      console.warn("⚠️ [WORKER] Scheduler is already started");
      return;
    }

    this.isStarted = true;
    this.workerState = WORKER_STATES.IDLE;
    console.log(`🚀 [WORKER] Scheduler started. Interval: ${this.pollIntervalMs}ms | DryRun: ${this.dryRun}`);

    // Register OS termination handlers
    if (options.registerSignalHandlers !== false) {
      process.on("SIGINT", this._boundShutdown);
      process.on("SIGTERM", this._boundShutdown);
    }

    // Immediate initial tick (T=0)
    if (options.runImmediate !== false) {
      this.runOnce(options).catch(err => console.error(`⚠️ [WORKER] Initial run error: ${err.message}`));
    }

    // Recurring ticks
    this.timerId = setInterval(() => {
      this.runOnce(options).catch(err => console.error(`⚠️ [WORKER] Scheduled run error: ${err.message}`));
    }, this.pollIntervalMs);
  }

  /**
   * Stops the recurring scheduler and terminates any active resources cleanly.
   */
  async stop() {
    if (!this.isStarted && !this.timerId) return;

    console.log("🛑 [WORKER] Stopping scheduler and cleaning up resources...");
    this.workerState = WORKER_STATES.STOPPING;

    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }

    this.isStarted = false;

    // Remove OS termination handlers
    process.removeListener("SIGINT", this._boundShutdown);
    process.removeListener("SIGTERM", this._boundShutdown);

    await this.cleanupResources();
    this.workerState = WORKER_STATES.STOPPED;
    console.log("✅ [WORKER] Scheduler stopped cleanly.");
  }

  /**
   * Handles OS SIGINT/SIGTERM gracefully
   */
  async handleSignalShutdown() {
    console.log("\n⚠️ [WORKER] Received OS termination signal. Initiating graceful shutdown...");
    await this.stop();
  }

  /**
   * Cleans up all tracked active browser instances and temporary files
   */
  async cleanupResources() {
    // 1. Close browsers
    for (const browser of this.activeResources.browsers) {
      try {
        if (browser && typeof browser.close === "function") {
          await browser.close().catch(() => {});
        }
      } catch (e) {}
    }
    this.activeResources.browsers.clear();

    // 2. Delete temporary files
    for (const filePath of this.activeResources.tempFiles) {
      try {
        if (filePath && fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (e) {}
    }
    this.activeResources.tempFiles.clear();
  }

  /**
   * Returns a sanitized, non-sensitive worker health and status snapshot.
   * @returns {{
   *   workerState: string,
   *   isExecutionLocked: boolean,
   *   isStarted: boolean,
   *   pollIntervalMs: number,
   *   dryRun: boolean,
   *   lastRunAt: string|null,
   *   lastSuccessAt: string|null,
   *   lastFailureAt: string|null,
   *   lastProcessedPostId: string|null,
   *   lastError: string|null,
   *   consecutiveFailures: number,
   *   totalRuns: number,
   *   totalSuccesses: number
   * }}
   */
  getStatus() {
    return {
      workerState: this.workerState,
      isExecutionLocked: this.isExecutionLocked,
      isStarted: this.isStarted,
      pollIntervalMs: this.pollIntervalMs,
      dryRun: this.dryRun,
      lastRunAt: this.lastRunAt,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      lastProcessedPostId: this.lastProcessedPostId,
      lastError: this.lastError,
      consecutiveFailures: this.consecutiveFailures,
      totalRuns: this.totalRuns,
      totalSuccesses: this.totalSuccesses
    };
  }
}

module.exports = {
  AvseeAutomatedWorker,
  WORKER_STATES,
  DEFAULT_WORKER_CONFIG
};
