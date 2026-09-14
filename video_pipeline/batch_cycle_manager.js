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
const ACTIVE_CYCLE_STATES = ['ACQUIRING', 'PROCESSING', 'STREAMING', 'INGESTING', 'PUBLISHING', 'STOPPING'];

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
   * @param {number} [config.minSuccessfulVideos] Minimum successful videos for COMPLETED status
   * @param {number} [config.maxSuccessfulVideos] Ceiling on successful videos per cycle (default 25)
   * @param {number} [config.discoveryTarget] Target links to discover (default 100)
   * @param {number} [config.discoveryMax] Upper bound on discovered links (default 150)
   * @param {number} [config.maxPages] Max pages to crawl (default 50)
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
      const pid = cycle ? cycle.acquisitionPid : null;
      const stillAlive = isPidAlive(pid);

      if (stillAlive) {
        console.warn(`${LOG_PREFIX} Recovery: cycle ${cycleId} was ${state} when this process last stopped, and PID ${pid} `
          + `still appears to be alive. Not resuming automatically - a stray acquisition process may still be running. `
          + `Marking the cycle FAILED and returning the controller to IDLE; stop PID ${pid} manually if still active.`);
      } else {
        console.warn(`${LOG_PREFIX} Recovery: cycle ${cycleId} was interrupted (${state}, no live acquisition process). `
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
    console.log(`${LOG_PREFIX} Starting acquisition cycle ${cycleId} (target=${this.discoveryTarget}, success range=${this.minSuccessfulVideos}-${this.maxSuccessfulVideos})`);
    this.batchState.startCycle(cycleId, { startedAt });

    const processedFiles = new Set();
    const readyMediaList = [];
    const publishedItems = [];
    let successfulCount = 0;
    let duplicateCount = 0;
    let failedCount = 0;
    let skippedAlreadyPublishedCount = 0;
    let hitCeiling = false;

    try {
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
      this.batchState.updateCycle(cycleId, { acquisitionPid: startResult.pid });

      const deadline = Date.now() + this.acquisitionTimeoutMs;

      // Helper to process a single downloaded file immediately
      const processDownloadedFile = async (filePath, videoUrlHint = '') => {
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
            return;
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
            } else {
              failedCount++;
            }
            if (!hitCeiling) {
              this.batchState.setControllerState(this.videoPipelineManager.isRunning() ? 'ACQUIRING' : 'PROCESSING');
            }
          }
        } else if (scanResult.status === 'DUPLICATE') {
          duplicateCount++;
        } else if (scanResult.status === 'FAILED') {
          failedCount++;
        }
      };

      // 2. Streaming loop: process items on-the-fly while acquisition runs
      while (this.videoPipelineManager.isRunning() && Date.now() < deadline && !hitCeiling) {
        if (!hitCeiling && fs.existsSync(this.downloadsDir)) {
          try {
            const files = fs.readdirSync(this.downloadsDir);
            for (const f of files) {
              if (hitCeiling) break;
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
        if (!hitCeiling && Date.now() >= deadline) {
          throw new Error(`Acquisition did not finish within ${this.acquisitionTimeoutMs}ms and was stopped`);
        }
      }

      // Process any remaining files
      if (!hitCeiling && fs.existsSync(this.downloadsDir)) {
        try {
          const files = fs.readdirSync(this.downloadsDir);
          for (const f of files) {
            if (hitCeiling) break;
            if (f.endsWith('.mp4') && !f.includes('.part.') && !f.includes('.tmp.')) {
              await processDownloadedFile(path.join(this.downloadsDir, f));
            }
          }
        } catch (e) {}
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
        lastError: statusReason,
        media: readyMediaList
      });
      this.batchState.data.currentCycleId = cycleId;
      this.batchState.setControllerState('IDLE');

      const publishResult = {
        batchId: cycleId,
        // A batch can now span all configured round-robin destinations. This
        // summary field is descriptive only and must never revive a staging
        // fallback or imply a single Telegram target.
        destinationId: this.videoBatchPublisher && this.videoBatchPublisher.useRoundRobin
          ? 'ROUND_ROBIN'
          : ((this.videoBatchPublisher && this.videoBatchPublisher.stagingChatId) || this.publishOptions.stagingChatIdOverride || null),
        status: finalStatus,
        totalItems: readyMediaList.length,
        published: successfulCount,
        skipped: skippedAlreadyPublishedCount,
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
        reason: statusReason,
        media: readyMediaList,
        publishedItems,
        publishResult: this.autoPublish ? publishResult : undefined
      };
      this._lastCycleSummary = summary;
      console.log(`${LOG_PREFIX} Cycle ${cycleId} -> ${finalStatus} `
        + `(discovered=${discovered}, downloaded=${downloaded}, ready=${readyMediaList.length}, `
        + `published=${successfulCount}, duplicates=${duplicateCount}, failed=${failedCount})`);

      return summary;
    } catch (err) {
      const completedAt = new Date().toISOString();
      this.batchState.updateCycle(cycleId, { status: 'FAILED', completedAt, lastError: err.message });
      this.batchState.data.currentCycleId = null;
      this.batchState.setControllerState('IDLE');
      console.error(`${LOG_PREFIX} Cycle ${cycleId} FAILED: ${err.message}`);
      const summary = { cycleId, status: 'FAILED', startedAt, completedAt, error: err.message };
      this._lastCycleSummary = summary;
      return summary;
    }
  }

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
    for (const [abs, prov] of this._buildFileProvenanceMap()) {
      map.set(abs, prov.title);
    }
    return map;
  }

  /**
   * Same correlation as the title map above, but also carries the source
   * page_url/video_url through for each downloaded file - required so every
   * media record can prove exactly which source_mode/page/URL it came from,
   * all the way through to the Telegram caption and publish ledger.
   */
  _buildFileProvenanceMap() {
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

  startScheduler(intervalMs = DEFAULT_INTERVAL_MS, options = {}) {
    return this.start(intervalMs, options);
  }

  isSchedulerActive() {
    return this._timerId !== null;
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
