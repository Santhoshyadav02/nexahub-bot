/**
 * ============================================================
 * ⏱️ BATCH CYCLE MANAGER (Phase 3A - 3-hour acquisition batch controller)
 * ============================================================
 * Orchestrates exactly one bounded acquisition cycle at a time:
 *
 *   VideoPipelineManager (video-tools, --Once) -> MediaIngestor.scanOnce()
 *   -> freeze this cycle's READY media -> BATCH_READY
 *
 * This module does NOT duplicate process management (that's
 * VideoPipelineManager's job) or validation/dedupe (that's MediaIngestor's
 * job) - it only sequences them into one cycle, tracks cycle state, and
 * persists a frozen snapshot of each cycle's media for a future publisher.
 *
 * Hard boundary for this phase: a cycle stops at BATCH_READY. Nothing here
 * ever calls Telegram, routes to a destination, or deletes a file.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { VideoPipelineManager } = require('./video_pipeline_manager');
const { MediaIngestor } = require('./media_ingestor');
const { BatchState } = require('./batch_state');

const LOG_PREFIX = '[BATCH_CYCLE_MANAGER]';
const DEFAULT_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3 hours - production default, never hardcode a short test value here
const DEFAULT_ACQUISITION_TIMEOUT_MS = 20 * 60 * 1000;

function generateCycleId() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = crypto.randomBytes(3).toString('hex');
  return `cycle_${ts}_${rand}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

class BatchCycleManager {
  /**
   * @param {object} config
   * @param {string} [config.acquisitionUrl] Local/authorized listing URL - required unless acquisitionOptions.inputLinks is set. Never defaults to any live source.
   * @param {string} config.outputDir video-tools --Output directory (persistent across cycles)
   * @param {string} config.downloadsDir video-tools --Downloads directory (persistent across cycles)
   * @param {object} [config.acquisitionOptions] Extra pass-through options for VideoPipelineManager.start() (workers, standalone, targetLinks, maxPages, timeoutSec, inputLinks, ...)
   * @param {VideoPipelineManager} [config.videoPipelineManager] Inject an instance (tests)
   * @param {MediaIngestor} [config.mediaIngestor] Inject an instance (tests)
   * @param {BatchState} [config.batchState] Inject an instance (tests)
   * @param {string} [config.batchStatePath]
   * @param {number} [config.acquisitionTimeoutMs] Bound on step 2's wait-for-completion poll
   * @param {number} [config.stabilityCheckMs] Passed through to a freshly-constructed MediaIngestor
   */
  constructor(config = {}) {
    const hasInputLinks = !!(config.acquisitionOptions && config.acquisitionOptions.inputLinks);
    if (!config.acquisitionUrl && !hasInputLinks) {
      throw new Error('BatchCycleManager requires an explicit acquisitionUrl (or acquisitionOptions.inputLinks) - it never defaults to any live source.');
    }
    if (!config.outputDir || !config.downloadsDir) {
      throw new Error('BatchCycleManager requires outputDir and downloadsDir');
    }

    this.acquisitionUrl = config.acquisitionUrl || null;
    this.outputDir = config.outputDir;
    this.downloadsDir = config.downloadsDir;
    this.acquisitionOptions = config.acquisitionOptions || {};
    this.acquisitionTimeoutMs = config.acquisitionTimeoutMs || DEFAULT_ACQUISITION_TIMEOUT_MS;

    this.videoPipelineManager = config.videoPipelineManager || new VideoPipelineManager();
    this.mediaIngestor = config.mediaIngestor || new MediaIngestor({
      downloadsDir: this.downloadsDir,
      stabilityCheckMs: config.stabilityCheckMs
    });
    this.batchState = config.batchState || new BatchState({ statePath: config.batchStatePath });

    this._timerId = null;
    this._acceptingRuns = true;
    this._activeRunPromise = null;
    this._lastCycleSummary = null;

    this._recoverOnStartup();
  }

  // ============================================================
  // 🔄 RESTART RECOVERY
  // ============================================================

  _recoverOnStartup() {
    const state = this.batchState.getControllerState();
    const cycleId = this.batchState.getCurrentCycleId();
    if (state !== 'ACQUIRING' || !cycleId) return;

    const cycle = this.batchState.getCycle(cycleId);
    const pid = cycle ? cycle.acquisitionPid : null;
    const stillAlive = isPidAlive(pid);

    if (stillAlive) {
      console.warn(`${LOG_PREFIX} Recovery: cycle ${cycleId} was ACQUIRING when this process last stopped, and PID ${pid} `
        + `still appears to be alive. Not resuming automatically - a stray acquisition process may still be running. `
        + `Marking the cycle FAILED and returning the controller to IDLE; stop PID ${pid} manually if still active.`);
    } else {
      console.warn(`${LOG_PREFIX} Recovery: cycle ${cycleId} was interrupted (ACQUIRING, no live acquisition process). `
        + `Marking it FAILED. Any media already downloaded/validated by the Media Ingestor remains intact and untouched.`);
    }

    this.batchState.updateCycle(cycleId, {
      status: 'FAILED',
      completedAt: new Date().toISOString(),
      lastError: stillAlive
        ? `Recovered at startup: acquisition PID ${pid} may still be running independently; cycle marked FAILED without touching media.`
        : 'Recovered at startup: process restarted mid-acquisition with no live acquisition process; cycle marked FAILED without touching media.'
    });
    this.batchState.data.currentCycleId = null;
    this.batchState.setControllerState('IDLE');
  }

  // ============================================================
  // 📊 STATUS
  // ============================================================

  getStatus() {
    return {
      state: this.batchState.getControllerState(),
      currentCycleId: this.batchState.getCurrentCycleId(),
      schedulerRunning: this._timerId !== null,
      lastCycleSummary: this._lastCycleSummary,
      recentSkippedTicks: this.batchState.getSkippedTicks().slice(-10)
    };
  }

  getCycle(cycleId) {
    return this.batchState.getCycle(cycleId);
  }

  listCycles() {
    return this.batchState.listCycles();
  }

  // ============================================================
  // ▶️ RUN ONCE
  // ============================================================

  /**
   * Performs exactly one complete acquisition cycle. Refuses to overlap with
   * an already-active cycle - from either a concurrent runOnce() call in
   * this process or a controller state recovered as ACQUIRING - returning a
   * SKIPPED result rather than throwing or queuing.
   */
  async runOnce() {
    if (this._activeRunPromise) {
      return { status: 'SKIPPED', reason: 'A cycle is already running in this process' };
    }
    if (this.batchState.getControllerState() === 'ACQUIRING') {
      return { status: 'SKIPPED', reason: 'Controller state is already ACQUIRING' };
    }

    const run = this._runOnceInternal();
    this._activeRunPromise = run;
    try {
      return await run;
    } finally {
      this._activeRunPromise = null;
    }
  }

  async _runOnceInternal() {
    const cycleId = generateCycleId();
    const startedAt = new Date().toISOString();
    console.log(`${LOG_PREFIX} Starting acquisition cycle ${cycleId}`);
    this.batchState.startCycle(cycleId, { startedAt });

    try {
      // 1. Start video-tools through the existing, unmodified VideoPipelineManager.
      const startOptions = {
        ...this.acquisitionOptions,
        output: this.outputDir,
        downloads: this.downloadsDir,
        once: true // an acquisition cycle is, by definition, one bounded batch
      };
      if (!startOptions.inputLinks && this.acquisitionUrl) {
        startOptions.url = this.acquisitionUrl;
      }

      const startResult = this.videoPipelineManager.start(startOptions);
      if (startResult.status !== 'STARTED') {
        throw new Error(`VideoPipelineManager did not start: ${JSON.stringify(startResult)}`);
      }
      this.batchState.updateCycle(cycleId, { acquisitionPid: startResult.pid });

      // 2. Wait for the acquisition pipeline to finish (bounded).
      const deadline = Date.now() + this.acquisitionTimeoutMs;
      while (this.videoPipelineManager.isRunning() && Date.now() < deadline) {
        await sleep(300);
      }
      if (this.videoPipelineManager.isRunning()) {
        await this.videoPipelineManager.stop();
        throw new Error(`Acquisition did not finish within ${this.acquisitionTimeoutMs}ms and was stopped`);
      }

      const discovered = this._countDiscovered();
      const downloaded = this._countDownloaded();

      // 3/4. Scan downloads using the existing, unmodified MediaIngestor.
      const scanSummary = await this.mediaIngestor.scanOnce();

      // 5/6/7. Freeze this cycle's READY media and mark the cycle BATCH_READY.
      const media = this._freezeReadyMedia(scanSummary);
      const completedAt = new Date().toISOString();
      const updated = this.batchState.updateCycle(cycleId, {
        status: 'BATCH_READY',
        completedAt,
        discovered,
        downloaded,
        ready: scanSummary.ready || 0,
        duplicates: scanSummary.duplicate || 0,
        failed: scanSummary.failed || 0,
        media
      });
      this.batchState.data.currentCycleId = cycleId;
      this.batchState.setControllerState('BATCH_READY');

      const summary = {
        cycleId,
        status: 'BATCH_READY',
        startedAt,
        completedAt,
        discovered,
        downloaded,
        ready: updated.ready,
        duplicates: updated.duplicates,
        failed: updated.failed
      };
      this._lastCycleSummary = summary;
      console.log(`${LOG_PREFIX} Cycle ${cycleId} -> BATCH_READY `
        + `(discovered=${discovered}, downloaded=${downloaded}, ready=${updated.ready}, `
        + `duplicates=${updated.duplicates}, failed=${updated.failed})`);
      return summary;
    } catch (err) {
      const completedAt = new Date().toISOString();
      this.batchState.updateCycle(cycleId, { status: 'FAILED', completedAt, lastError: err.message });
      this.batchState.data.currentCycleId = null;
      this.batchState.setControllerState('FAILED');
      console.error(`${LOG_PREFIX} Cycle ${cycleId} FAILED: ${err.message}`);
      const summary = { cycleId, status: 'FAILED', startedAt, completedAt, error: err.message };
      this._lastCycleSummary = summary;
      return summary;
    }
  }

  _countDiscovered() {
    const videosJsonPath = path.join(this.outputDir, 'videos.json');
    if (!fs.existsSync(videosJsonPath)) return 0;
    try {
      const records = JSON.parse(fs.readFileSync(videosJsonPath, 'utf8'));
      return Array.isArray(records) ? records.length : 0;
    } catch (e) {
      return 0;
    }
  }

  _countDownloaded() {
    const reportPath = path.join(this.downloadsDir, 'download_report.json');
    if (!fs.existsSync(reportPath)) return 0;
    try {
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      return Array.isArray(report) ? report.filter(r => r.status === 'downloaded').length : 0;
    } catch (e) {
      return 0;
    }
  }

  /**
   * Correlates video-tools' own videos.json (page_url/title -> video_url)
   * with download_report.json (video_url -> file) to associate each
   * downloaded file with the title Playwright captured for its post -
   * without touching or duplicating any video-tools logic.
   */
  _buildFileTitleMap() {
    const map = new Map();
    const videosJsonPath = path.join(this.outputDir, 'videos.json');
    const reportPath = path.join(this.downloadsDir, 'download_report.json');
    if (!fs.existsSync(videosJsonPath) || !fs.existsSync(reportPath)) return map;

    const titleByUrl = new Map();
    try {
      const records = JSON.parse(fs.readFileSync(videosJsonPath, 'utf8'));
      for (const rec of records || []) {
        if (Array.isArray(rec.video_urls)) {
          for (const url of rec.video_urls) {
            if (url) titleByUrl.set(url, rec.title || '');
          }
        }
      }
    } catch (e) {
      return map;
    }

    try {
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      for (const entry of report || []) {
        if (entry.file && entry.video_url && titleByUrl.has(entry.video_url)) {
          map.set(path.resolve(entry.file), titleByUrl.get(entry.video_url));
        }
      }
    } catch (e) {
      // best effort only
    }
    return map;
  }

  /**
   * Freezes a snapshot of the READY media discovered by THIS scan pass -
   * never "all READY files" queried later, since new media could appear
   * before a future publisher consumes the batch.
   */
  _freezeReadyMedia(scanSummary) {
    const fileTitleMap = this._buildFileTitleMap();
    // alreadyProcessed=true means this file's READY status was determined by
    // an earlier scan, not this cycle - excluding it is what makes this a
    // true snapshot of THIS cycle's new work, not "all READY files right now".
    const readyOutcomes = (scanSummary.results || []).filter(r => r.status === 'READY' && !r.alreadyProcessed);
    return readyOutcomes.map(outcome => {
      const record = this.mediaIngestor.ledger.getRecord(outcome.id);
      const filePath = record ? record.filePath : outcome.filePath;
      return {
        mediaId: outcome.id,
        title: fileTitleMap.get(path.resolve(filePath)) || '',
        filePath,
        size: record ? record.size : null,
        contentSha256: record ? record.contentSha256 : null,
        sourceKeyHash: record ? record.sourceKeyHash : null,
        discoveredAt: record ? record.discoveredAt : null,
        validatedAt: record ? record.validatedAt : null
      };
    });
  }

  // ============================================================
  // ⏱️ RECURRING SCHEDULE (not enabled in production by this phase)
  // ============================================================

  /**
   * Starts the recurring schedule. Never overlaps cycles: if a scheduled
   * tick lands while the previous cycle is still ACQUIRING (or a runOnce()
   * is already active in this process), it is skipped and recorded via
   * batchState.recordSkippedTick() - never queued, never forced.
   * @param {number} [intervalMs] Defaults to 3 hours; pass a short value (e.g. 5000) for local tests only - production default is untouched either way.
   * @param {object} [options]
   * @param {boolean} [options.runImmediately=false]
   */
  start(intervalMs = DEFAULT_INTERVAL_MS, options = {}) {
    if (this._timerId) {
      return { status: 'ALREADY_RUNNING' };
    }
    this._acceptingRuns = true;
    if (options.runImmediately) {
      this._scheduledTick();
    }
    this._timerId = setInterval(() => this._scheduledTick(), intervalMs);
    return { status: 'STARTED' };
  }

  _scheduledTick() {
    if (!this._acceptingRuns) return;
    if (this._activeRunPromise || this.batchState.getControllerState() === 'ACQUIRING') {
      const reason = 'Previous acquisition cycle was still ACQUIRING when the next scheduled time arrived';
      console.warn(`${LOG_PREFIX} Scheduled cycle skipped: ${reason}`);
      this.batchState.recordSkippedTick(reason);
      return;
    }
    this.runOnce().catch(err => {
      console.error(`${LOG_PREFIX} Scheduled runOnce() rejected unexpectedly: ${err.message}`);
    });
  }

  /**
   * Stops the recurring schedule and, if a cycle is actively ACQUIRING,
   * gracefully stops the underlying acquisition process via the existing
   * VideoPipelineManager before settling - never leaves an orphan process.
   */
  async stop() {
    this._acceptingRuns = false;
    if (this._timerId) {
      clearInterval(this._timerId);
      this._timerId = null;
    }

    if (this.videoPipelineManager.isRunning()) {
      const cycleId = this.batchState.getCurrentCycleId();
      this.batchState.setControllerState('STOPPING');
      console.log(`${LOG_PREFIX} Stopping in-progress acquisition (cycle ${cycleId})...`);
      await this.videoPipelineManager.stop();
      if (cycleId) {
        this.batchState.updateCycle(cycleId, {
          status: 'FAILED',
          completedAt: new Date().toISOString(),
          lastError: 'Cycle interrupted by controller stop()'
        });
      }
      this.batchState.data.currentCycleId = null;
      this.batchState.setControllerState('IDLE');
    }

    if (this._activeRunPromise) {
      try {
        await this._activeRunPromise;
      } catch (e) {}
    }

    return { status: 'STOPPED' };
  }
}

module.exports = { BatchCycleManager, generateCycleId, DEFAULT_INTERVAL_MS };
