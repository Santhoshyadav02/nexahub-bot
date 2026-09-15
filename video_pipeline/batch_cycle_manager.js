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
 * Nothing here ever talks to Telegram directly or routes to a destination -
 * publishing is delegated to the injected VideoBatchPublisher.
 *
 * Local disk hygiene (only when enableCleanup is set, and only ever INSIDE
 * downloadsDir):
 *   - DUPLICATE media and media that definitively failed validation are
 *     deleted as soon as that verdict is reached.
 *   - READY media whose publish failed is retried on later cycles, up to
 *     VIDEO_PIPELINE_MAX_PUBLISH_ATTEMPTS (default 3), then abandoned and deleted.
 *   - At the start of each cycle, orphan files older than
 *     VIDEO_PIPELINE_DOWNLOAD_RETENTION_HOURS (default 48) are swept, and the
 *     oldest files are removed while the directory exceeds
 *     VIDEO_PIPELINE_DOWNLOAD_MAX_BYTES (default 10 GiB, 0 disables).
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { VideoPipelineManager } = require('./video_pipeline_manager');
const { MediaIngestor } = require('./media_ingestor');
const { BatchState } = require('./batch_state');
const { isPathInside } = require('./media_cleaner');

const LOG_PREFIX = '[BATCH_CYCLE_MANAGER]';
const DEFAULT_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3 hours - production default, never hardcode a short test value here
const DEFAULT_ACQUISITION_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_STARTUP_DELAY_MS = 60 * 1000;
const DEFAULT_MAX_PUBLISH_ATTEMPTS = 3;
const DEFAULT_DOWNLOAD_RETENTION_HOURS = 48;
const DEFAULT_DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024 * 1024;
const DEFAULT_STOP_ACTIVE_RUN_WAIT_MS = 1500;
// Disk cleanup runs on its own timer so it still happens while a long cycle
// makes the scheduler skip ticks.
const DEFAULT_CLEANUP_INTERVAL_MS = 3 * 60 * 60 * 1000;
// Ledger states that mean a file's work is finished (safe to delete mid-cycle).
const TERMINAL_MEDIA_STATES = new Set(['FAILED', 'DUPLICATE', 'ABANDONED', 'CLEANED']);
const BOOT_TIME_TOLERANCE_MS = 2 * 60 * 1000;
const ACTIVE_CYCLE_STATES = ['ACQUIRING', 'PROCESSING', 'STREAMING', 'INGESTING', 'PUBLISHING', 'STOPPING'];

function generateCycleId() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = crypto.randomBytes(3).toString('hex');
  return `cycle_${ts}_${rand}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readNumberEnv(name, fallback, { allowZero = false } = {}) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  if (value > 0 || (allowZero && value === 0)) return value;
  return fallback;
}

function pickNumber(configValue, envName, fallback, options) {
  if (configValue !== undefined && configValue !== null && Number.isFinite(Number(configValue))) {
    return Number(configValue);
  }
  return readNumberEnv(envName, fallback, options);
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the PID exists but belongs to another user.
    return e.code === 'EPERM';
  }
}

function getBootId() {
  try {
    return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
  } catch (e) {
    return null;
  }
}

function getBootTimeMs() {
  return Date.now() - Math.round(os.uptime() * 1000);
}

function readProcCmdline(pid) {
  if (process.platform !== 'linux') return null;
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
  } catch (e) {
    return null;
  }
}

/**
 * Decides whether an acquisition PID recorded by a previous process is
 * really still OUR acquisition. A bare kill(pid, 0) is not enough: after a
 * reboot (or long enough uptime) the same PID number can belong to anything.
 * @param {object} cycle Persisted cycle record
 * @returns {{alive: boolean, pid: number|null, verified: boolean, reason: string}}
 */
function assessRecordedAcquisition(cycle) {
  const pid = cycle ? cycle.acquisitionPid : null;
  if (!pid) return { alive: false, pid: null, verified: false, reason: 'no acquisition PID was recorded' };

  const currentBootId = getBootId();
  if (cycle.acquisitionBootId && currentBootId && cycle.acquisitionBootId !== currentBootId) {
    return { alive: false, pid, verified: false, reason: 'PID was recorded before the last reboot' };
  }
  const bootTimeMs = getBootTimeMs();
  if (cycle.acquisitionBootTimeMs && Math.abs(cycle.acquisitionBootTimeMs - bootTimeMs) > BOOT_TIME_TOLERANCE_MS) {
    return { alive: false, pid, verified: false, reason: 'PID was recorded before the last reboot' };
  }
  if (!cycle.acquisitionBootId && !cycle.acquisitionBootTimeMs) {
    // Legacy record without boot info: a cycle that started before this boot
    // cannot possibly still have a live child.
    const startedAt = Date.parse(cycle.startedAt);
    if (Number.isFinite(startedAt) && startedAt < bootTimeMs - BOOT_TIME_TOLERANCE_MS) {
      return { alive: false, pid, verified: false, reason: 'cycle started before the last reboot' };
    }
  }

  if (!isPidAlive(pid)) {
    return { alive: false, pid, verified: false, reason: 'process is not running' };
  }
  const cmdline = readProcCmdline(pid);
  if (cmdline !== null && !/pipeline\.py|run_pipeline/i.test(cmdline)) {
    return { alive: false, pid, verified: false, reason: `PID ${pid} now belongs to an unrelated process` };
  }
  return { alive: true, pid, verified: cmdline !== null, reason: 'process is still running' };
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
   * @param {number} [config.minSuccessfulVideos] Minimum successful videos for COMPLETED status
   * @param {number} [config.maxSuccessfulVideos] Ceiling on successful videos per cycle (default 25)
   * @param {number} [config.discoveryTarget] Target links to discover (default 100)
   * @param {number} [config.discoveryMax] Upper bound on discovered links (default 150)
   * @param {number} [config.maxPages] Max pages to crawl (default 50)
   * @param {boolean} [config.enableCleanup=false] Delete rejected/abandoned/orphan files inside downloadsDir
   * @param {number} [config.maxPublishAttempts] Cross-cycle publish attempts before abandoning (default 3)
   * @param {number} [config.downloadRetentionHours] Orphan file age limit (default 48)
   * @param {number} [config.downloadMaxBytes] Downloads dir size cap, 0 disables (default 10 GiB)
   * @param {number} [config.startupDelayMs] Minimum delay before the first scheduled cycle (default 60s)
   * @param {number} [config.stopActiveRunWaitMs] How long stop() waits for an in-flight cycle to settle (default 1.5s)
   * @param {number} [config.cleanupIntervalMs] Scheduled disk cleanup period, 0 disables (default 3h)
   * @param {string} [config.uploadPartsDir] Split-upload scratch dir swept by the scheduled cleanup
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
    this.sourceMode = config.sourceMode || 'fixture';
    this.outputDir = config.outputDir;
    this.downloadsDir = config.downloadsDir;
    this.acquisitionOptions = config.acquisitionOptions || {};
    this.acquisitionTimeoutMs = config.acquisitionTimeoutMs || DEFAULT_ACQUISITION_TIMEOUT_MS;

    const envDiscoveryTarget = Number(process.env.VIDEO_PIPELINE_DISCOVERY_TARGET);
    this.discoveryTarget = (config.discoveryTarget !== undefined && !isNaN(config.discoveryTarget))
      ? config.discoveryTarget
      : (!isNaN(envDiscoveryTarget) && envDiscoveryTarget > 0 ? envDiscoveryTarget : 100);

    const envDiscoveryMax = Number(process.env.VIDEO_PIPELINE_DISCOVERY_MAX);
    this.discoveryMax = (config.discoveryMax !== undefined && !isNaN(config.discoveryMax))
      ? config.discoveryMax
      : (!isNaN(envDiscoveryMax) && envDiscoveryMax > 0 ? envDiscoveryMax : 150);

    const envMaxPages = Number(process.env.VIDEO_PIPELINE_MAX_PAGES);
    this.maxPages = (config.maxPages !== undefined && !isNaN(config.maxPages))
      ? config.maxPages
      : (!isNaN(envMaxPages) && envMaxPages > 0 ? envMaxPages : 50);

    const envMinSuccessful = Number(process.env.VIDEO_PIPELINE_MIN_SUCCESSFUL_VIDEOS);
    const defaultMin = (config.acquisitionOptions && config.acquisitionOptions.targetLinks && config.acquisitionOptions.targetLinks < 15)
      ? config.acquisitionOptions.targetLinks
      : 15;
    this.minSuccessfulVideos = (config.minSuccessfulVideos !== undefined && !isNaN(config.minSuccessfulVideos))
      ? config.minSuccessfulVideos
      : (!isNaN(envMinSuccessful) && envMinSuccessful > 0 ? envMinSuccessful : defaultMin);

    const envMaxSuccessful = Number(process.env.VIDEO_PIPELINE_MAX_SUCCESSFUL_VIDEOS);
    this.maxSuccessfulVideos = (config.maxSuccessfulVideos !== undefined && !isNaN(config.maxSuccessfulVideos))
      ? config.maxSuccessfulVideos
      : (!isNaN(envMaxSuccessful) && envMaxSuccessful > 0 ? envMaxSuccessful : 25);

    this.enableCleanup = Boolean(config.enableCleanup);
    this.maxPublishAttempts = Math.max(1, Math.floor(pickNumber(config.maxPublishAttempts, 'VIDEO_PIPELINE_MAX_PUBLISH_ATTEMPTS', DEFAULT_MAX_PUBLISH_ATTEMPTS)));
    this.downloadRetentionMs = pickNumber(config.downloadRetentionHours, 'VIDEO_PIPELINE_DOWNLOAD_RETENTION_HOURS', DEFAULT_DOWNLOAD_RETENTION_HOURS) * 60 * 60 * 1000;
    this.downloadMaxBytes = pickNumber(config.downloadMaxBytes, 'VIDEO_PIPELINE_DOWNLOAD_MAX_BYTES', DEFAULT_DOWNLOAD_MAX_BYTES, { allowZero: true });
    this.startupDelayMs = pickNumber(config.startupDelayMs, 'VIDEO_PIPELINE_STARTUP_DELAY_MS', DEFAULT_STARTUP_DELAY_MS, { allowZero: true });
    this.stopActiveRunWaitMs = pickNumber(config.stopActiveRunWaitMs, null, DEFAULT_STOP_ACTIVE_RUN_WAIT_MS, { allowZero: true });
    this.cleanupIntervalMs = pickNumber(config.cleanupIntervalMs, 'VIDEO_PIPELINE_CLEANUP_INTERVAL_MS', DEFAULT_CLEANUP_INTERVAL_MS, { allowZero: true });
    this.uploadPartsDir = config.uploadPartsDir || null;
    this._cleanupTimerId = null;
    this._cleanupRunning = false;

    this.videoPipelineManager = config.videoPipelineManager || new VideoPipelineManager();
    this.mediaIngestor = config.mediaIngestor || new MediaIngestor({
      downloadsDir: this.downloadsDir,
      stabilityCheckMs: config.stabilityCheckMs
    });
    this.batchState = config.batchState || new BatchState({ statePath: config.batchStatePath });
    this.videoBatchPublisher = config.videoBatchPublisher || null;
    this.autoPublish = Boolean(config.autoPublish);
    this.publishOptions = config.publishOptions || {};

    this._timerId = null;
    this._startupTimerId = null;
    this._nextRunAt = null;
    this._acceptingRuns = true;
    this._abortRequested = false;
    this._activeRunPromise = null;
    this._lastCycleSummary = null;
    this._provenanceCache = null;

    this._recoverOnStartup();
  }

  // ============================================================
  // 🔄 RESTART RECOVERY
  // ============================================================

  _recoverOnStartup() {
    const state = this.batchState.getControllerState();
    const cycleId = this.batchState.getCurrentCycleId();

    if (state === 'STOPPING' || state === 'STOPPED' || (!cycleId && state !== 'IDLE')) {
      console.warn(`${LOG_PREFIX} Recovery: controller was in state ${state} on startup. Resetting controller state to IDLE.`);
      if (cycleId) {
        this.batchState.updateCycle(cycleId, {
          status: 'FAILED',
          completedAt: new Date().toISOString(),
          lastError: `Recovered at startup: process stopped in state ${state}.`
        });
        this.batchState.data.currentCycleId = null;
      }
      this.batchState.setControllerState('IDLE');
      return;
    }

    if (!cycleId) return;

    if (state === 'ACQUIRING' || state === 'PROCESSING' || state === 'STREAMING') {
      const cycle = this.batchState.getCycle(cycleId);
      const assessment = assessRecordedAcquisition(cycle);
      const pid = assessment.pid;
      const stillAlive = assessment.alive;

      if (stillAlive && assessment.verified) {
        // Verified (same boot, same PID, command line is video-tools'
        // pipeline): this is a genuine orphan from the previous process. It
        // would otherwise keep writing into the same downloads dir as the
        // next cycle, so terminate its whole process group.
        console.warn(`${LOG_PREFIX} Recovery: cycle ${cycleId} was ${state} and its acquisition process (PID ${pid}) is still `
          + `running as an orphan from the previous process. Terminating it and marking the cycle FAILED.`);
        this._terminateOrphanAcquisition(pid);
      } else if (stillAlive) {
        console.warn(`${LOG_PREFIX} Recovery: cycle ${cycleId} was ${state} when this process last stopped, and PID ${pid} `
          + `still appears to be alive. Not resuming automatically - a stray acquisition process may still be running. `
          + `Marking the cycle FAILED and returning the controller to IDLE; stop PID ${pid} manually if still active.`);
      } else {
        console.warn(`${LOG_PREFIX} Recovery: cycle ${cycleId} was interrupted (${state}, no live acquisition process: ${assessment.reason}). `
          + `Marking it FAILED. Any media already downloaded/validated by the Media Ingestor remains intact and untouched.`);
      }

      this.batchState.updateCycle(cycleId, {
        status: 'FAILED',
        completedAt: new Date().toISOString(),
        lastError: stillAlive
          ? `Recovered at startup: acquisition PID ${pid} was still running${assessment.verified ? ' and was terminated' : ' independently'}; cycle marked FAILED without touching media.`
          : 'Recovered at startup: process restarted mid-acquisition with no live acquisition process; cycle marked FAILED without touching media.'
      });
      this.batchState.data.currentCycleId = null;
      this.batchState.setControllerState('IDLE');
    } else if (state === 'PUBLISHING') {
      console.warn(`${LOG_PREFIX} Recovery: cycle ${cycleId} was interrupted in state PUBLISHING. `
        + `PublishLedger recovers any stuck UPLOADING items to PENDING safely. Resetting cycle status to BATCH_READY for clean retry.`);
      this.batchState.updateCycle(cycleId, {
        status: 'BATCH_READY',
        lastError: 'Recovered at startup: publishing was interrupted mid-batch; reset to BATCH_READY without media loss.'
      });
      this.batchState.setControllerState('IDLE');
    }
  }

  _terminateOrphanAcquisition(pid) {
    const signal = (sig) => {
      try {
        process.kill(-pid, sig);
      } catch (e) {
        try { process.kill(pid, sig); } catch (_) {}
      }
    };
    signal('SIGTERM');
    const timer = setTimeout(() => signal('SIGKILL'), 3000);
    if (typeof timer.unref === 'function') timer.unref();
  }

  // ============================================================
  // 📊 STATUS
  // ============================================================

  getStatus() {
    return {
      state: this.batchState.getControllerState(),
      currentCycleId: this.batchState.getCurrentCycleId(),
      schedulerRunning: this.isSchedulerActive(),
      nextRunAt: this._nextRunAt ? new Date(this._nextRunAt).toISOString() : null,
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
    const currentState = this.batchState.getControllerState();
    if (ACTIVE_CYCLE_STATES.includes(currentState)) {
      return { status: 'SKIPPED', reason: `Controller state is already ${currentState}` };
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
    this._abortRequested = false;
    console.log(`${LOG_PREFIX} Starting acquisition cycle ${cycleId} (target=${this.discoveryTarget}, success range=${this.minSuccessfulVideos}-${this.maxSuccessfulVideos})`);
    this.batchState.startCycle(cycleId, { startedAt });

    const processedFiles = new Set();
    const readyMediaList = [];
    const publishedItems = [];
    let successfulCount = 0;
    let duplicateCount = 0;
    let failedCount = 0;
    let skippedAlreadyPublishedCount = 0;
    let skippedTooLargeCount = 0;
    let retriedCount = 0;
    let hitCeiling = false;

    try {
      // 0. Disk hygiene before new downloads land: drop orphan/expired files.
      if (this.enableCleanup) {
        try {
          await this._sweepDownloadsDir();
        } catch (sweepErr) {
          console.warn(`${LOG_PREFIX} Downloads sweep failed (continuing): ${sweepErr.message}`);
        }
      }

      // 1. Start video-tools through VideoPipelineManager.
      const startOptions = {
        targetLinks: this.discoveryTarget,
        maxPages: this.maxPages,
        ...this.acquisitionOptions,
        output: this.outputDir,
        downloads: this.downloadsDir,
        once: true
      };
      if (!startOptions.inputLinks && this.acquisitionUrl) {
        startOptions.url = this.acquisitionUrl;
      }

      const startResult = this.videoPipelineManager.start(startOptions);
      if (startResult.status !== 'STARTED') {
        throw new Error(`VideoPipelineManager did not start: ${JSON.stringify(startResult)}`);
      }
      this.batchState.updateCycle(cycleId, {
        acquisitionPid: startResult.pid,
        acquisitionBootId: getBootId(),
        acquisitionBootTimeMs: getBootTimeMs()
      });

      const deadline = Date.now() + this.acquisitionTimeoutMs;

      // Helper to process a single downloaded file immediately
      const processDownloadedFile = async (filePath, videoUrlHint = '') => {
        if (this._abortRequested) return;
        const absPath = path.resolve(filePath);
        if (processedFiles.has(absPath)) return;
        if (!fs.existsSync(absPath)) return;

        try {
          const initialStat = fs.statSync(absPath);
          if (initialStat.size === 0) return;
        } catch (e) {
          return;
        }

        processedFiles.add(absPath);

        const fileProvenanceMap = this._buildFileProvenanceMap();
        const prov = fileProvenanceMap.get(absPath) || {};
        let title = prov.title || '';
        if (!title && videoUrlHint) {
          title = this._lookupTitleByUrl(videoUrlHint) || '';
        }

        const scanResult = await this.mediaIngestor.processSingleFile(absPath, { title });
        if (scanResult.status === 'READY') {
          if (scanResult.alreadyProcessed) {
            // Validated by an earlier cycle. Only worth touching again if its
            // publish never succeeded and still has attempts left.
            const retry = await this._resolveStaleReadyMedia(scanResult.id, absPath);
            if (!retry) return;
            retriedCount++;
          }
          const record = this.mediaIngestor.ledger.getRecord(scanResult.id);
          const resolvedTitle = (record && record.title) || title || scanResult.title || '';
          const validation = record ? record.validation : null;
          const mediaRecord = {
            mediaId: scanResult.id,
            title: resolvedTitle,
            filePath: absPath,
            size: record ? record.size : scanResult.size,
            contentSha256: record ? record.contentSha256 : scanResult.contentSha256,
            sourceKeyHash: record ? record.sourceKeyHash : scanResult.sourceKeyHash,
            discoveredAt: record ? record.discoveredAt : new Date().toISOString(),
            validatedAt: record ? record.validatedAt : new Date().toISOString(),
            sourceMode: this.sourceMode,
            isFixtureMedia: this.sourceMode === 'fixture',
            sourcePageUrl: prov.pageUrl || '',
            sourceVideoUrl: prov.videoUrl || videoUrlHint || '',
            mimeType: validation ? validation.mimeType : null,
            container: validation ? validation.container : null,
            codec: validation ? validation.codec : null,
            duration: validation ? validation.duration : null,
            width: validation ? validation.width : null,
            height: validation ? validation.height : null,
            frameRate: validation ? validation.frameRate : null,
            hasAudio: validation ? validation.hasAudio : null
          };
          readyMediaList.push(mediaRecord);

          // Immediate Publishing
          if (this.autoPublish && this.videoBatchPublisher && !hitCeiling) {
            this.batchState.setControllerState('PUBLISHING');
            const pubRes = await this.videoBatchPublisher.publishSingleItem(cycleId, mediaRecord, this.publishOptions);
            if (pubRes.status === 'PUBLISHED') {
              successfulCount++;
              publishedItems.push(pubRes);
              console.log(`${LOG_PREFIX} Immediate publication ${successfulCount}/${this.maxSuccessfulVideos} complete for ${mediaRecord.mediaId} (msgId: ${pubRes.telegramMessageId})`);
              if (successfulCount >= this.maxSuccessfulVideos) {
                console.log(`${LOG_PREFIX} Reached maximum successful target (${this.maxSuccessfulVideos}). Halting cycle.`);
                hitCeiling = true;
                if (this.videoPipelineManager.isRunning()) {
                  await this.videoPipelineManager.stop();
                }
              }
            } else if (pubRes.status === 'SKIPPED_ALREADY_PUBLISHED') {
              skippedAlreadyPublishedCount++;
            } else if (pubRes.status === 'SKIPPED_TOO_LARGE') {
              skippedTooLargeCount++;
            } else {
              // File is kept on disk: a later cycle retries it (bounded by maxPublishAttempts).
              failedCount++;
            }
            if (!hitCeiling) {
              this.batchState.setControllerState(this.videoPipelineManager.isRunning() ? 'ACQUIRING' : 'PROCESSING');
            }
          }
        } else if (scanResult.status === 'DUPLICATE') {
          duplicateCount++;
          await this._discardRejectedMedia(scanResult, absPath);
        } else if (scanResult.status === 'FAILED') {
          failedCount++;
          await this._discardRejectedMedia(scanResult, absPath);
        }
      };

      // 2. Streaming loop: process items on-the-fly while acquisition runs
      while (this.videoPipelineManager.isRunning() && Date.now() < deadline && !hitCeiling && !this._abortRequested) {
        if (fs.existsSync(this.downloadsDir)) {
          try {
            const files = fs.readdirSync(this.downloadsDir);
            for (const f of files) {
              if (hitCeiling || this._abortRequested) break;
              if (f.endsWith('.mp4') && !f.includes('.part.') && !f.includes('.tmp.')) {
                await processDownloadedFile(path.join(this.downloadsDir, f));
              }
            }
          } catch (e) {}
        }
        await sleep(300);
      }

      // Stop acquisition if still running
      if (this.videoPipelineManager.isRunning()) {
        await this.videoPipelineManager.stop();
        if (!hitCeiling && !this._abortRequested && Date.now() >= deadline) {
          throw new Error(`Acquisition did not finish within ${this.acquisitionTimeoutMs}ms and was stopped`);
        }
      }

      // Process any remaining files
      if (!hitCeiling && !this._abortRequested && fs.existsSync(this.downloadsDir)) {
        try {
          const files = fs.readdirSync(this.downloadsDir);
          for (const f of files) {
            if (hitCeiling || this._abortRequested) break;
            if (f.endsWith('.mp4') && !f.includes('.part.') && !f.includes('.tmp.')) {
              await processDownloadedFile(path.join(this.downloadsDir, f));
            }
          }
        } catch (e) {}
      }

      if (this._abortRequested) {
        throw new Error('Cycle interrupted by controller stop()');
      }

      const discovered = this._countDiscovered();
      const downloaded = this._countDownloaded();
      const completedAt = new Date().toISOString();

      let finalStatus = 'COMPLETED';
      let statusReason = null;

      if (!this.autoPublish) {
        finalStatus = 'BATCH_READY';
      } else {
        if (successfulCount >= this.minSuccessfulVideos) {
          finalStatus = 'COMPLETED';
        } else if (successfulCount > 0) {
          finalStatus = 'PARTIAL';
          statusReason = `Candidate set exhausted before reaching minimum target (${successfulCount}/${this.minSuccessfulVideos})`;
        } else if (readyMediaList.length === 0 && (discovered === 0 || (duplicateCount === 0 && failedCount === 0))) {
          finalStatus = 'COMPLETED_EMPTY';
        } else {
          finalStatus = 'FAILED';
          statusReason = '0 successful video publications in cycle';
        }
      }

      this.batchState.updateCycle(cycleId, {
        status: finalStatus,
        completedAt,
        discovered,
        downloaded,
        ready: readyMediaList.length,
        duplicates: duplicateCount,
        failed: failedCount,
        publishedCount: successfulCount,
        skippedCount: skippedAlreadyPublishedCount,
        skippedTooLargeCount,
        retriedCount,
        lastError: statusReason,
        media: readyMediaList
      });
      this.batchState.data.currentCycleId = cycleId;
      this.batchState.setControllerState('IDLE');
      this._recordCycleFinished(completedAt);

      const publishResult = {
        batchId: cycleId,
        destinationId: (this.videoBatchPublisher && this.videoBatchPublisher.stagingChatId) || this.publishOptions.stagingChatIdOverride || '-1009990001',
        status: finalStatus,
        totalItems: readyMediaList.length,
        published: successfulCount,
        skipped: skippedAlreadyPublishedCount,
        skippedTooLarge: skippedTooLargeCount,
        failed: failedCount,
        cleaned: successfulCount,
        completedAt,
        items: publishedItems
      };

      const summary = {
        cycleId,
        status: finalStatus,
        startedAt,
        completedAt,
        discovered,
        downloaded,
        ready: readyMediaList.length,
        duplicates: duplicateCount,
        failed: failedCount,
        published: successfulCount,
        skipped: skippedAlreadyPublishedCount,
        skippedTooLarge: skippedTooLargeCount,
        retried: retriedCount,
        reason: statusReason,
        media: readyMediaList,
        publishedItems,
        publishResult: this.autoPublish ? publishResult : undefined
      };
      this._lastCycleSummary = summary;
      console.log(`${LOG_PREFIX} Cycle ${cycleId} -> ${finalStatus} `
        + `(discovered=${discovered}, downloaded=${downloaded}, ready=${readyMediaList.length}, `
        + `published=${successfulCount}, retried=${retriedCount}, tooLarge=${skippedTooLargeCount}, `
        + `duplicates=${duplicateCount}, failed=${failedCount})`);

      return summary;
    } catch (err) {
      const completedAt = new Date().toISOString();
      this.batchState.updateCycle(cycleId, { status: 'FAILED', completedAt, lastError: err.message });
      this.batchState.data.currentCycleId = null;
      this.batchState.setControllerState('IDLE');
      this._recordCycleFinished(completedAt);
      console.error(`${LOG_PREFIX} Cycle ${cycleId} FAILED: ${err.message}`);
      const summary = { cycleId, status: 'FAILED', startedAt, completedAt, error: err.message };
      this._lastCycleSummary = summary;
      return summary;
    }
  }

  _recordCycleFinished(at) {
    if (typeof this.batchState.recordCycleFinished === 'function') {
      try {
        this.batchState.recordCycleFinished(at);
      } catch (e) {
        console.warn(`${LOG_PREFIX} Could not persist cycle finish time: ${e.message}`);
      }
    }
  }

  // ============================================================
  // 🧹 LOCAL DISK HYGIENE (downloadsDir only)
  // ============================================================

  _publishDestinationId() {
    return this.publishOptions.chatIdOverride
      || this.publishOptions.stagingChatIdOverride
      || (this.videoBatchPublisher && this.videoBatchPublisher.stagingChatId)
      || null;
  }

  _getPublishAttemptState(mediaId) {
    const ledger = this.videoBatchPublisher && this.videoBatchPublisher.publishLedger;
    const roundRobin = this.videoBatchPublisher && typeof this.videoBatchPublisher.usesRoundRobin === 'function'
      && this.videoBatchPublisher.usesRoundRobin();
    if (roundRobin && ledger && typeof ledger.getMediaAttemptState === 'function') {
      return ledger.getMediaAttemptState(mediaId);
    }
    const destinationId = this._publishDestinationId();
    if (!ledger || !destinationId || typeof ledger.getAttemptState !== 'function') return null;
    return ledger.getAttemptState(mediaId, destinationId);
  }

  /**
   * For READY media validated by an EARLIER cycle: decides whether to retry
   * its publish now, or - once maxPublishAttempts is exhausted - abandon it
   * (status ABANDONED, file deleted when cleanup is enabled).
   * @returns {Promise<boolean>} true if the item should be published in this cycle
   */
  async _resolveStaleReadyMedia(mediaId, filePath) {
    if (!this.autoPublish || !this.videoBatchPublisher) return false;
    const attempt = this._getPublishAttemptState(mediaId);
    if (!attempt) return false;
    // Published (possibly with cleanup withheld pending read-back review) or
    // terminally skipped: nothing to retry. Leftover files age out via the sweep.
    if (attempt.published || attempt.status === 'SKIPPED_TOO_LARGE') return false;

    if (attempt.attempts >= this.maxPublishAttempts) {
      const reason = `publish abandoned after ${attempt.attempts} failed attempt(s) (max ${this.maxPublishAttempts})`;
      console.warn(`${LOG_PREFIX} Media ${mediaId}: ${reason}.`);
      await this._removeDownloadedFile(filePath, reason, mediaId, { status: 'ABANDONED', deleteFile: this.enableCleanup });
      return false;
    }

    console.log(`${LOG_PREFIX} Retrying publish for media ${mediaId} from an earlier cycle (attempt ${attempt.attempts + 1}/${this.maxPublishAttempts}).`);
    return true;
  }

  /**
   * Deletes the local file for a DUPLICATE, or for media whose validation
   * reached a DEFINITIVE negative verdict. Missing tooling or a timeout could
   * be a transient/configuration problem, so those files are kept (and only
   * ever age out through the retention sweep).
   */
  async _discardRejectedMedia(scanResult, filePath) {
    if (!this.enableCleanup) return false;
    const ledger = this.mediaIngestor && this.mediaIngestor.ledger;
    const record = ledger && typeof ledger.getRecord === 'function' ? ledger.getRecord(scanResult.id) : null;

    let reason;
    if (scanResult.status === 'DUPLICATE') {
      reason = `duplicate of ${scanResult.duplicateOf || (record && record.duplicateOf) || 'existing media'}`;
    } else {
      const validation = record && record.validation;
      const definitive = Boolean(validation) && validation.valid === false && !validation.toolingUnavailable && !validation.timedOut;
      if (!definitive) return false;
      reason = `validation failed: ${validation.error || 'unknown error'}`;
    }
    return this._removeDownloadedFile(filePath, reason, scanResult.id, { deleteFile: true });
  }

  /**
   * The ONLY place this module deletes files. Refuses anything not strictly
   * inside downloadsDir.
   */
  async _removeDownloadedFile(filePath, reason, mediaId, { status = null, deleteFile = true } = {}) {
    const resolved = path.resolve(filePath);
    let deleted = false;
    if (deleteFile) {
      if (!isPathInside(this.downloadsDir, resolved)) {
        console.error(`${LOG_PREFIX} Refusing to delete ${resolved}: outside downloads directory ${path.resolve(this.downloadsDir)}.`);
        return false;
      }
      try {
        if (fs.existsSync(resolved)) {
          fs.unlinkSync(resolved);
          deleted = true;
          console.log(`${LOG_PREFIX} Deleted local media file (${reason}): ${path.basename(resolved)}`);
        }
      } catch (err) {
        console.warn(`${LOG_PREFIX} Failed to delete ${resolved}: ${err.message}`);
        return false;
      }
    }

    const ledger = this.mediaIngestor && this.mediaIngestor.ledger;
    if (mediaId && ledger && typeof ledger.upsert === 'function' && typeof ledger.getRecord === 'function' && ledger.getRecord(mediaId)) {
      const patch = {};
      if (status) {
        patch.status = status;
        patch.lastError = reason;
      }
      if (deleted) {
        patch.fileDeletedAt = new Date().toISOString();
        patch.fileDeletedReason = reason;
      }
      if (Object.keys(patch).length > 0) {
        try {
          await ledger.upsert(mediaId, patch);
        } catch (err) {
          console.warn(`${LOG_PREFIX} Failed to update MediaLedger for ${mediaId}: ${err.message}`);
        }
      }
    }
    return deleted;
  }

  /**
   * True if a downloaded file is still legitimately waiting to be published
   * (so neither the age nor the size sweep may remove it).
   */
  _isPendingPublish(absPath) {
    const ledger = this.mediaIngestor && this.mediaIngestor.ledger;
    if (!ledger || typeof ledger.getRecord !== 'function') return false;
    const id = crypto.createHash('sha256').update(path.resolve(absPath)).digest('hex');
    const record = ledger.getRecord(id);
    if (!record || record.status !== 'READY') return false;
    if (!this.autoPublish || !this.videoBatchPublisher) return true; // BATCH_READY mode: awaiting a manual publish
    const attempt = this._getPublishAttemptState(id);
    if (!attempt) return true;
    return !attempt.published && attempt.status !== 'SKIPPED_TOO_LARGE' && attempt.attempts < this.maxPublishAttempts;
  }

  /**
   * Removes orphan/expired files from downloadsDir (top level only): *.mp4
   * media and video-tools' own leftover temp files. Never touches
   * download_report.json or any other bookkeeping file, and never removes
   * media still pending publication.
   * @returns {Promise<{deleted: number, freedBytes: number}>}
   */
  async _sweepDownloadsDir(now = Date.now(), { cycleActive = false } = {}) {
    const summary = { deleted: 0, freedBytes: 0 };
    if (!this.enableCleanup) return summary;
    // While a cycle runs, media it may still be ingesting, validating or
    // uploading (no ledger record yet, VALIDATING, or pending READY) is kept.
    const keep = (candidate) => candidate.isMedia
      && (this._isPendingPublish(candidate.abs) || (cycleActive && this._isInUseByActiveCycle(candidate.abs)));

    let entries;
    try {
      entries = fs.readdirSync(this.downloadsDir, { withFileTypes: true });
    } catch (e) {
      return summary;
    }

    const candidates = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      const isMedia = name.toLowerCase().endsWith('.mp4');
      const isTemp = /\.part\.\d+\.tmp$/i.test(name) || name.startsWith('download_report.json.tmp.');
      if (!isMedia && !isTemp) continue;
      const abs = path.join(this.downloadsDir, name);
      try {
        const stat = fs.statSync(abs);
        candidates.push({ abs, size: stat.size, mtimeMs: stat.mtimeMs, isMedia, removed: false });
      } catch (e) {}
    }

    const remove = async (candidate, reason) => {
      const mediaId = candidate.isMedia
        ? crypto.createHash('sha256').update(path.resolve(candidate.abs)).digest('hex')
        : null;
      if (await this._removeDownloadedFile(candidate.abs, reason, mediaId, { deleteFile: true })) {
        candidate.removed = true;
        summary.deleted++;
        summary.freedBytes += candidate.size;
      }
    };

    const retentionHours = Math.round((this.downloadRetentionMs / 3600000) * 100) / 100;
    for (const candidate of candidates) {
      if (now - candidate.mtimeMs > this.downloadRetentionMs && !keep(candidate)) {
        await remove(candidate, `older than ${retentionHours}h retention`);
      }
    }

    if (this.downloadMaxBytes > 0) {
      let total = candidates.filter(c => !c.removed).reduce((sum, c) => sum + c.size, 0);
      if (total > this.downloadMaxBytes) {
        const evictable = candidates
          .filter(c => !c.removed && !keep(c))
          .sort((a, b) => a.mtimeMs - b.mtimeMs);
        for (const candidate of evictable) {
          if (total <= this.downloadMaxBytes) break;
          await remove(candidate, `downloads dir above ${this.downloadMaxBytes} byte cap`);
          if (candidate.removed) total -= candidate.size;
        }
        if (total > this.downloadMaxBytes) {
          console.warn(`${LOG_PREFIX} Downloads dir still holds ${total} bytes (cap ${this.downloadMaxBytes}); remaining files are pending publication.`);
        }
      }
    }

    if (summary.deleted > 0) {
      console.log(`${LOG_PREFIX} Downloads sweep removed ${summary.deleted} file(s), freed ${(summary.freedBytes / (1024 * 1024)).toFixed(1)} MB.`);
    }
    return summary;
  }

  /**
   * True if an active cycle may still be working on this downloaded file:
   * not ingested yet (no ledger record) or not in a finished state.
   */
  _isInUseByActiveCycle(absPath) {
    const ledger = this.mediaIngestor && this.mediaIngestor.ledger;
    if (!ledger || typeof ledger.getRecord !== 'function') return true;
    const id = crypto.createHash('sha256').update(path.resolve(absPath)).digest('hex');
    const record = ledger.getRecord(id);
    if (!record) return true;
    if (TERMINAL_MEDIA_STATES.has(record.status)) return false;
    if (record.status === 'READY') {
      const attempt = this._getPublishAttemptState(id);
      return !(attempt && (attempt.published || attempt.status === 'SKIPPED_TOO_LARGE' || attempt.attempts >= this.maxPublishAttempts));
    }
    return true;
  }

  _isCycleActive() {
    return Boolean(this._activeRunPromise) || ACTIVE_CYCLE_STATES.includes(this.batchState.getControllerState());
  }

  /**
   * Removes leftover split-upload part directories older than the retention.
   * Skipped entirely while a cycle runs, since uploads only happen inside one.
   * @returns {{deleted: number}}
   */
  _sweepUploadPartsDir(now = Date.now()) {
    const summary = { deleted: 0 };
    if (!this.enableCleanup || !this.uploadPartsDir || this._isCycleActive()) return summary;
    let entries;
    try {
      entries = fs.readdirSync(this.uploadPartsDir, { withFileTypes: true });
    } catch (e) {
      return summary;
    }
    for (const entry of entries) {
      const abs = path.join(this.uploadPartsDir, entry.name);
      try {
        if (now - fs.statSync(abs).mtimeMs <= this.downloadRetentionMs) continue;
        fs.rmSync(abs, { recursive: true, force: true });
        summary.deleted++;
      } catch (e) {
        console.warn(`${LOG_PREFIX} Could not remove upload part leftover ${entry.name}: ${e.message}`);
      }
    }
    return summary;
  }

  /**
   * Scheduled disk cleanup, independent of the cycle schedule: sweeps
   * expired/finished downloads (safely, even mid-cycle) and leftover upload parts.
   * @returns {Promise<{deleted: number, freedBytes: number, partDirsDeleted: number, skipped?: boolean}>}
   */
  async runScheduledCleanup(now = Date.now()) {
    if (!this.enableCleanup || this._cleanupRunning) {
      return { deleted: 0, freedBytes: 0, partDirsDeleted: 0, skipped: true };
    }
    this._cleanupRunning = true;
    try {
      const cycleActive = this._isCycleActive();
      const downloads = await this._sweepDownloadsDir(now, { cycleActive });
      const parts = this._sweepUploadPartsDir(now);
      this._sweepQuarantineFiles(now);
      console.log(`${LOG_PREFIX} Scheduled cleanup${cycleActive ? ' (cycle active - in-use files kept)' : ''}: `
        + `removed ${downloads.deleted} download file(s), freed ${(downloads.freedBytes / (1024 * 1024)).toFixed(1)} MB, `
        + `removed ${parts.deleted} upload part dir(s).`);
      return { deleted: downloads.deleted, freedBytes: downloads.freedBytes, partDirsDeleted: parts.deleted };
    } catch (err) {
      console.error(`${LOG_PREFIX} Scheduled cleanup failed: ${err.message}`);
      return { deleted: 0, freedBytes: 0, partDirsDeleted: 0, error: err.message };
    } finally {
      this._cleanupRunning = false;
    }
  }

  _sweepQuarantineFiles(now = Date.now()) {
    const summary = { deleted: 0 };
    const targets = [this.stateDir, this.outputDir].filter(Boolean);
    const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
    for (const dir of targets) {
      if (!fs.existsSync(dir)) continue;
      try {
        const files = fs.readdirSync(dir);
        for (const f of files) {
          if (f.includes('.corrupt-')) {
            const p = path.join(dir, f);
            try {
              if (now - fs.statSync(p).mtimeMs > maxAgeMs) {
                fs.unlinkSync(p);
                summary.deleted++;
              }
            } catch (e) {}
          }
        }
      } catch (e) {}
    }
    return summary;
  }

  _startCleanupTimer() {
    if (this._cleanupTimerId || !this.enableCleanup || !(this.cleanupIntervalMs > 0)) return;
    this._cleanupTimerId = setInterval(() => {
      this.runScheduledCleanup().catch(() => {});
    }, this.cleanupIntervalMs);
    console.log(`${LOG_PREFIX} Scheduled cleanup every ${Math.round(this.cleanupIntervalMs / 60000)} min (retention ${Math.round(this.downloadRetentionMs / 60000)} min).`);
  }

  // ============================================================
  // 📤 PUBLISH / PROVENANCE
  // ============================================================

  /**
   * Publishes an existing BATCH_READY cycle using the configured VideoBatchPublisher.
   * @param {string} cycleId
   * @param {object} [options]
   * @returns {Promise<object>}
   */
  async publishCycle(cycleId, options = {}) {
    if (!this.videoBatchPublisher) {
      throw new Error('VideoBatchPublisher is not configured on BatchCycleManager.');
    }
    const pubOptions = { ...this.publishOptions, ...options };
    const pubResult = await this.videoBatchPublisher.publishBatch(cycleId, pubOptions);
    if (this._lastCycleSummary && this._lastCycleSummary.cycleId === cycleId) {
      this._lastCycleSummary.publishResult = pubResult;
      this._lastCycleSummary.status = pubResult.status;
    }
    return pubResult;
  }

  _readDownloadReport() {
    const reportPath = path.join(this.downloadsDir, 'download_report.json');
    if (!fs.existsSync(reportPath)) return [];
    try {
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      return Array.isArray(report) ? report : [];
    } catch (e) {
      return [];
    }
  }

  _lookupTitleByUrl(videoUrl) {
    if (!videoUrl) return '';
    const videosJsonPath = path.join(this.outputDir, 'videos.json');
    if (!fs.existsSync(videosJsonPath)) return '';
    try {
      const records = JSON.parse(fs.readFileSync(videosJsonPath, 'utf8'));
      for (const rec of records || []) {
        if (Array.isArray(rec.video_urls) && rec.video_urls.includes(videoUrl)) {
          return rec.title || '';
        }
        if (rec.page_url === videoUrl) {
          return rec.title || '';
        }
      }
    } catch (e) {}
    return '';
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
    const report = this._readDownloadReport();
    return report.filter(r => r && r.status === 'downloaded').length;
  }

  /**
   * Correlates video-tools' own videos.json (page_url/title -> video_url)
   * with download_report.json (video_url -> file) to associate each
   * downloaded file with the title Playwright captured for its post -
   * without touching or duplicating any video-tools logic.
   */
  _buildFileTitleMap() {
    const map = new Map();
    for (const [abs, prov] of this._buildFileProvenanceMap()) {
      map.set(abs, prov.title);
    }
    return map;
  }

  _statKey(filePath) {
    try {
      const stat = fs.statSync(filePath);
      return `${stat.size}:${stat.mtimeMs}`;
    } catch (e) {
      return 'missing';
    }
  }

  /**
   * Same correlation as the title map above, but also carries the source
   * page_url/video_url through for each downloaded file - required so every
   * media record can prove exactly which source_mode/page/URL it came from,
   * all the way through to the Telegram caption and publish ledger.
   *
   * Cached on the size/mtime of videos.json, download_report.json and the
   * downloads directory itself: a cycle processes many files, but both JSON
   * files are only re-parsed when video-tools has actually rewritten them.
   */
  _buildFileProvenanceMap() {
    const key = [
      this._statKey(path.join(this.outputDir, 'videos.json')),
      this._statKey(path.join(this.downloadsDir, 'download_report.json')),
      this._statKey(this.downloadsDir)
    ].join('|');
    if (this._provenanceCache && this._provenanceCache.key === key) {
      return this._provenanceCache.map;
    }
    const map = this._buildFileProvenanceMapUncached();
    this._provenanceCache = { key, map };
    return map;
  }

  _buildFileProvenanceMapUncached() {
    const map = new Map();
    const videosJsonPath = path.join(this.outputDir, 'videos.json');
    const reportPath = path.join(this.downloadsDir, 'download_report.json');
    if (!fs.existsSync(videosJsonPath)) return map;

    const provByUrl = new Map();
    const provByFilename = new Map();

    try {
      const records = JSON.parse(fs.readFileSync(videosJsonPath, 'utf8'));
      for (const rec of records || []) {
        const title = (rec.title || '').trim();
        const pageUrl = rec.page_url || '';
        if (rec.page_url) provByUrl.set(rec.page_url, { title, pageUrl, videoUrl: '' });
        if (Array.isArray(rec.video_urls)) {
          for (const url of rec.video_urls) {
            if (url) {
              const prov = { title, pageUrl, videoUrl: url };
              provByUrl.set(url, prov);
              try {
                const parsed = new URL(url, 'http://127.0.0.1');
                provByUrl.set(parsed.pathname, prov);
              } catch (_) {}
              try {
                const h = crypto.createHash('sha256').update(url).digest('hex').substring(0, 20);
                provByFilename.set(`video_${h}.mp4`, prov);
              } catch (_) {}
            }
          }
        }
      }
    } catch (e) {
      return map;
    }

    // Map from download_report.json if present
    if (fs.existsSync(reportPath)) {
      try {
        const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
        for (const entry of report || []) {
          if (entry.file && entry.video_url) {
            let prov = provByUrl.get(entry.video_url);
            if (!prov) {
              try {
                const parsed = new URL(entry.video_url, 'http://127.0.0.1');
                prov = provByUrl.get(parsed.pathname);
              } catch (_) {}
            }
            if (prov) {
              map.set(path.resolve(entry.file), { title: prov.title, pageUrl: prov.pageUrl, videoUrl: prov.videoUrl || entry.video_url });
            } else {
              map.set(path.resolve(entry.file), { title: '', pageUrl: '', videoUrl: entry.video_url });
            }
          }
        }
      } catch (e) {
        // best effort only
      }
    }

    // Also populate for any downloads matching filename hash directly
    if (fs.existsSync(this.downloadsDir)) {
      try {
        const files = fs.readdirSync(this.downloadsDir);
        for (const f of files) {
          const abs = path.resolve(path.join(this.downloadsDir, f));
          if (!map.has(abs) && provByFilename.has(f)) {
            map.set(abs, provByFilename.get(f));
          }
        }
      } catch (e) {}
    }

    return map;
  }

  /**
   * Freezes a snapshot of the READY media discovered by THIS scan pass -
   * never "all READY files" queried later, since new media could appear
   * before a future publisher consumes the batch.
   */
  _freezeReadyMedia(scanSummary) {
    const fileProvenanceMap = this._buildFileProvenanceMap();
    const readyOutcomes = (scanSummary.results || []).filter(r => r.status === 'READY' && !r.alreadyProcessed);
    return readyOutcomes.map(outcome => {
      const record = this.mediaIngestor.ledger.getRecord(outcome.id);
      const filePath = record ? record.filePath : outcome.filePath;
      const prov = fileProvenanceMap.get(path.resolve(filePath)) || {};
      const validation = record ? record.validation : null;
      return {
        mediaId: outcome.id,
        title: prov.title || '',
        filePath,
        size: record ? record.size : null,
        contentSha256: record ? record.contentSha256 : null,
        sourceKeyHash: record ? record.sourceKeyHash : null,
        discoveredAt: record ? record.discoveredAt : null,
        validatedAt: record ? record.validatedAt : null,
        sourceMode: this.sourceMode,
            isFixtureMedia: this.sourceMode === 'fixture',
        sourcePageUrl: prov.pageUrl || '',
        sourceVideoUrl: prov.videoUrl || '',
        mimeType: validation ? validation.mimeType : null,
        container: validation ? validation.container : null,
        codec: validation ? validation.codec : null,
        duration: validation ? validation.duration : null,
        width: validation ? validation.width : null,
        height: validation ? validation.height : null,
        frameRate: validation ? validation.frameRate : null,
        hasAudio: validation ? validation.hasAudio : null
      };
    });
  }

  // ============================================================
  // ⏱️ RECURRING SCHEDULE
  // ============================================================

  /**
   * Delay before the first scheduled cycle. The cadence is anchored to the
   * persisted start time of the last cycle, so a restart neither resets the
   * clock (waiting a full interval again) nor runs a cycle immediately if
   * one just ran. Always at least min(startupDelayMs, interval) and never
   * more than one interval away.
   * @param {number} intervalMs
   * @param {number} [now]
   * @returns {number}
   */
  computeFirstRunDelayMs(intervalMs, now = Date.now()) {
    const startupDelay = Math.min(this.startupDelayMs, intervalMs);
    const times = typeof this.batchState.getLastCycleTimes === 'function' ? this.batchState.getLastCycleTimes() : {};
    const lastStartedMs = Date.parse(times && times.lastCycleStartedAt);
    if (!Number.isFinite(lastStartedMs)) return startupDelay;
    const dueInMs = lastStartedMs + intervalMs - now;
    return Math.min(intervalMs, Math.max(startupDelay, dueInMs));
  }

  /**
   * Starts the recurring schedule. Never overlaps cycles: if a scheduled
   * tick lands while the previous cycle is still ACQUIRING (or a runOnce()
   * is already active in this process), it is skipped and recorded via
   * batchState.recordSkippedTick() - never queued, never forced.
   * @param {number} [intervalMs] Defaults to 3 hours; pass a short value (e.g. 5000) for local tests only - production default is untouched either way.
   * @param {object} [options]
   * @param {boolean} [options.runImmediately=false] Run a cycle right now (VIDEO_PIPELINE_RUN_ON_STARTUP)
   */
  start(intervalMs = DEFAULT_INTERVAL_MS, options = {}) {
    if (this.isSchedulerActive()) {
      return { status: 'ALREADY_RUNNING' };
    }
    this._acceptingRuns = true;
    this._abortRequested = false;
    this._startCleanupTimer();

    if (options.runImmediately) {
      this._scheduledTick();
      this._startInterval(intervalMs);
      return { status: 'STARTED', firstRunInMs: 0 };
    }

    const delayMs = this.computeFirstRunDelayMs(intervalMs);
    this._nextRunAt = Date.now() + delayMs;
    console.log(`${LOG_PREFIX} Scheduler started: first cycle in ${Math.round(delayMs / 1000)}s, then every ${Math.round(intervalMs / 1000)}s.`);
    this._startupTimerId = setTimeout(() => {
      this._startupTimerId = null;
      if (!this._acceptingRuns) return;
      this._scheduledTick();
      this._startInterval(intervalMs);
    }, delayMs);
    return { status: 'STARTED', firstRunInMs: delayMs };
  }

  _startInterval(intervalMs) {
    this._nextRunAt = Date.now() + intervalMs;
    this._timerId = setInterval(() => {
      this._nextRunAt = Date.now() + intervalMs;
      this._scheduledTick();
    }, intervalMs);
  }

  startScheduler(intervalMs = DEFAULT_INTERVAL_MS, options = {}) {
    return this.start(intervalMs, options);
  }

  isSchedulerActive() {
    return this._timerId !== null || this._startupTimerId !== null;
  }

  getLastCycleSummary() {
    return this._lastCycleSummary;
  }

  _scheduledTick() {
    if (!this._acceptingRuns) return;
    const currentState = this.batchState.getControllerState();
    if (this._activeRunPromise || ACTIVE_CYCLE_STATES.includes(currentState)) {
      const reason = `Previous cycle was still active (state=${currentState}) when the next scheduled time arrived`;
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
   * stops the underlying acquisition process via the existing
   * VideoPipelineManager (itself bounded: graceful, then forced) - never
   * leaves an orphan process. Waits at most stopActiveRunWaitMs for an
   * in-flight cycle (e.g. mid-upload) to settle so shutdown stays bounded;
   * that cycle sees the abort flag and stops picking up new work.
   */
  async stop() {
    this._acceptingRuns = false;
    if (this._startupTimerId) {
      clearTimeout(this._startupTimerId);
      this._startupTimerId = null;
    }
    if (this._timerId) {
      clearInterval(this._timerId);
      this._timerId = null;
    }
    if (this._cleanupTimerId) {
      clearInterval(this._cleanupTimerId);
      this._cleanupTimerId = null;
    }
    this._nextRunAt = null;
    if (this._activeRunPromise) {
      this._abortRequested = true;
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
      let timer = null;
      const settled = await Promise.race([
        this._activeRunPromise.then(() => true, () => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), this.stopActiveRunWaitMs); })
      ]);
      if (timer) clearTimeout(timer);
      if (!settled) {
        console.warn(`${LOG_PREFIX} In-flight cycle did not settle within ${this.stopActiveRunWaitMs}ms; `
          + 'it has been told to abort and will finish in the background.');
      }
    }

    return { status: 'STOPPED' };
  }
}

module.exports = { BatchCycleManager, generateCycleId, assessRecordedAcquisition, DEFAULT_INTERVAL_MS };
