/**
 * ============================================================
 * 🎬 VIDEO PIPELINE RUNTIME (Phase 6B - NexaHub Runtime Manager)
 * ============================================================
 * Standalone orchestration boundary for integrating the batched video pipeline
 * into NexaHub.
 *
 * Core Responsibilities:
 *   - Configuration ingestion from environment with fail-closed validation.
 *   - Singleton lifecycle management (start, stop, runOnce, getStatus).
 *   - Prevents duplicate BatchCycleManager instances and runaway schedulers.
 *   - Strict isolation: errors within the video pipeline never crash parent NexaHub.
 *   - Production safety: refuses to run or publish to production channels in dev.
 */

const path = require('path');
const fs = require('fs');

const { BatchCycleManager } = require('./batch_cycle_manager');
const { VideoBatchPublisher } = require('./video_batch_publisher');
const { BatchState } = require('./batch_state');
const { MediaLedger } = require('./media_ledger');
const { PublishLedger } = require('./publish_ledger');
const { MediaCleaner } = require('./media_cleaner');
const { VideoDestinationRouter } = require('./video_destination_router');

const LOG_PREFIX = '[VIDEO_PIPELINE_RUNTIME]';
const ROOT_DIR = path.resolve(__dirname, '..');

const DEFAULT_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3 hours
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;      // 20 minutes
const DEFAULT_DISCOVERY_TARGET = 100;
const DEFAULT_DISCOVERY_MAX = 150;
const DEFAULT_MAX_PAGES = 50;
const DEFAULT_MIN_SUCCESSFUL_VIDEOS = 15;
const DEFAULT_MAX_SUCCESSFUL_VIDEOS = 25;

// Known production channel usernames/IDs to strictly forbid as staging destinations
const FORBIDDEN_PRODUCTION_DESTINATIONS = new Set([
  'ccsfvk', 'cccsefk', 'e5brygh', 'ccdjxc', 'vsdxda',
  'tfccdet', 'sfgfem', 'ddkicr', 'cccddghhgf', 'bzd4wrf',
  'romantic vibe', 'dating', 'romance', 'crotch', 'mosa',
  'bunny girl cosplay date', 'lustful hostess', 'concubine',
  'saki mizumi', 'a muse', 'romanticvibe', 'sister snake',
  'has work', 'bullying & sex', 'da ci ge', 'senior year love story',
  'sichuan mother & son', 'hu siyuan', 'kept lover'
]);

class VideoPipelineRuntime {
  /**
   * @param {object} [config] Optional configuration override (for DI and tests)
   */
  constructor(config = {}) {
    this.enabled = config.enabled !== undefined
      ? Boolean(config.enabled)
      : (process.env.VIDEO_PIPELINE_ENABLED === 'true');

    this.acquisitionUrl = config.acquisitionUrl || process.env.VIDEO_PIPELINE_ACQUISITION_URL || null;
    this.inputLinks = config.inputLinks || process.env.VIDEO_PIPELINE_INPUT_LINKS || null;
    this.stagingChatId = config.stagingChatId || process.env.VIDEO_PIPELINE_STAGING_CHAT_ID || null;

    const envInterval = Number(process.env.VIDEO_PIPELINE_INTERVAL_MS);
    this.intervalMs = (config.intervalMs && !isNaN(config.intervalMs))
      ? config.intervalMs
      : (!isNaN(envInterval) && envInterval > 0 ? envInterval : DEFAULT_INTERVAL_MS);

    const envTimeout = Number(process.env.VIDEO_PIPELINE_TIMEOUT_MS);
    this.timeoutMs = (config.timeoutMs && !isNaN(config.timeoutMs))
      ? config.timeoutMs
      : (!isNaN(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS);

    const envWorkers = Number(process.env.VIDEO_PIPELINE_WORKERS);
    this.workers = (config.workers && !isNaN(config.workers))
      ? config.workers
      : (!isNaN(envWorkers) && envWorkers > 0 ? envWorkers : 1);

    const envDiscoveryTarget = Number(process.env.VIDEO_PIPELINE_DISCOVERY_TARGET);
    this.discoveryTarget = (config.discoveryTarget && !isNaN(config.discoveryTarget))
      ? config.discoveryTarget
      : (!isNaN(envDiscoveryTarget) && envDiscoveryTarget > 0 ? envDiscoveryTarget : DEFAULT_DISCOVERY_TARGET);

    const envDiscoveryMax = Number(process.env.VIDEO_PIPELINE_DISCOVERY_MAX);
    this.discoveryMax = (config.discoveryMax && !isNaN(config.discoveryMax))
      ? config.discoveryMax
      : (!isNaN(envDiscoveryMax) && envDiscoveryMax > 0 ? envDiscoveryMax : DEFAULT_DISCOVERY_MAX);

    const envMaxPages = Number(process.env.VIDEO_PIPELINE_MAX_PAGES);
    this.maxPages = (config.maxPages && !isNaN(config.maxPages))
      ? config.maxPages
      : (!isNaN(envMaxPages) && envMaxPages > 0 ? envMaxPages : DEFAULT_MAX_PAGES);

    const envMinSuccessful = Number(process.env.VIDEO_PIPELINE_MIN_SUCCESSFUL_VIDEOS);
    const defaultMin = (config.acquisitionOptions && config.acquisitionOptions.targetLinks && config.acquisitionOptions.targetLinks < DEFAULT_MIN_SUCCESSFUL_VIDEOS)
      ? config.acquisitionOptions.targetLinks
      : DEFAULT_MIN_SUCCESSFUL_VIDEOS;
    this.minSuccessfulVideos = (config.minSuccessfulVideos !== undefined && !isNaN(config.minSuccessfulVideos))
      ? config.minSuccessfulVideos
      : (!isNaN(envMinSuccessful) && envMinSuccessful > 0 ? envMinSuccessful : defaultMin);

    const envMaxSuccessful = Number(process.env.VIDEO_PIPELINE_MAX_SUCCESSFUL_VIDEOS);
    this.maxSuccessfulVideos = (config.maxSuccessfulVideos && !isNaN(config.maxSuccessfulVideos))
      ? config.maxSuccessfulVideos
      : (!isNaN(envMaxSuccessful) && envMaxSuccessful > 0 ? envMaxSuccessful : DEFAULT_MAX_SUCCESSFUL_VIDEOS);

    this.downloadsDir = config.downloadsDir || process.env.VIDEO_PIPELINE_DOWNLOADS_DIR || path.join(ROOT_DIR, 'downloads');
    this.outputDir = config.outputDir || process.env.VIDEO_PIPELINE_OUTPUT_DIR || path.join(ROOT_DIR, 'output');
    this.stateDir = config.stateDir || process.env.VIDEO_PIPELINE_STATE_DIR || path.join(ROOT_DIR, 'video_pipeline');

    this.autoPublish = config.autoPublish !== undefined
      ? Boolean(config.autoPublish)
      : (process.env.VIDEO_PIPELINE_AUTO_PUBLISH !== 'false');

    this.enableCleanup = config.enableCleanup !== undefined
      ? Boolean(config.enableCleanup)
      : (process.env.VIDEO_PIPELINE_ENABLE_CLEANUP !== 'false');

    this.acquisitionOptions = config.acquisitionOptions || {
      workers: this.workers,
      timeout: Math.floor(this.timeoutMs / 1000),
      standalone: true,
      targetLinks: this.discoveryTarget,
      maxPages: this.maxPages
    };
    if (!this.acquisitionOptions.targetLinks) {
      this.acquisitionOptions.targetLinks = this.discoveryTarget;
    }
    if (!this.acquisitionOptions.maxPages) {
      this.acquisitionOptions.maxPages = this.maxPages;
    }
    if (this.inputLinks) {
      this.acquisitionOptions.inputLinks = this.inputLinks;
    }

    // Injected dependencies (tests)
    this.telegramClient = config.telegramClient || null;
    this.batchCycleManager = config.batchCycleManager || null;
    this.videoBatchPublisher = config.videoBatchPublisher || null;
    this.batchState = config.batchState || null;
    this.mediaLedger = config.mediaLedger || null;
    this.publishLedger = config.publishLedger || null;
    this.mediaCleaner = config.mediaCleaner || null;

    this._started = false;
    this._lastConfigError = null;
    this._configValid = false;

    this._validateConfiguration();
  }

  _validateConfiguration() {
    if (!this.enabled) {
      this._configValid = true;
      this._lastConfigError = null;
      return { valid: true, enabled: false };
    }

    if (!this.acquisitionUrl && !this.inputLinks) {
      const err = 'VIDEO_PIPELINE_ACQUISITION_URL (or inputLinks) is required when video pipeline is enabled.';
      this._configValid = false;
      this._lastConfigError = err;
      return { valid: false, reason: err };
    }

    if (this.autoPublish) {
      if (!this.stagingChatId || typeof this.stagingChatId !== 'string' || !this.stagingChatId.trim()) {
        const err = 'VIDEO_PIPELINE_STAGING_CHAT_ID is required when autoPublish is enabled.';
        this._configValid = false;
        this._lastConfigError = err;
        return { valid: false, reason: err };
      }

      const cleanTarget = this.stagingChatId.trim().replace(/^@/, '').toLowerCase();
      if (FORBIDDEN_PRODUCTION_DESTINATIONS.has(cleanTarget)) {
        const err = `Target destination "${this.stagingChatId}" is a protected production channel. Staging publisher strictly refuses.`;
        this._configValid = false;
        this._lastConfigError = err;
        return { valid: false, reason: err };
      }

      // Fail closed rather than starting a scheduler that would fail every
      // single publish attempt: require either an injected Telegram client
      // (production: the bot instance from index.js), a fully pre-configured
      // publisher, or a fully custom batchCycleManager (whatever publishing
      // setup it has, if any, is that caller's own responsibility - this
      // runtime only guards the paths where IT would build the publisher).
      if (!this.batchCycleManager && !this.videoBatchPublisher && !this.telegramClient) {
        const err = 'A Telegram client is required when autoPublish is enabled (config.telegramClient, or a pre-configured config.videoBatchPublisher/batchCycleManager).';
        this._configValid = false;
        this._lastConfigError = err;
        return { valid: false, reason: err };
      }
    }

    this._configValid = true;
    this._lastConfigError = null;
    return { valid: true, enabled: true };
  }

  /**
   * Initializes and constructs the internal BatchCycleManager if not already created.
   * @private
   */
  _ensureManagerInitialized() {
    if (this.batchCycleManager) {
      return this.batchCycleManager;
    }

    // Ensure output and downloads directories exist
    try {
      fs.mkdirSync(this.outputDir, { recursive: true });
      fs.mkdirSync(this.downloadsDir, { recursive: true });
      fs.mkdirSync(this.stateDir, { recursive: true });
    } catch (e) {
      console.warn(`${LOG_PREFIX} Directory ensure warning: ${e.message}`);
    }

    const batchStatePath = path.join(this.stateDir, 'batch_state.json');
    const mediaLedgerPath = path.join(this.stateDir, 'media_state.json');
    const publishLedgerPath = path.join(this.stateDir, 'publish_state.json');

    const batchState = this.batchState || new BatchState({ statePath: batchStatePath });
    const mediaLedger = this.mediaLedger || new MediaLedger({ ledgerPath: mediaLedgerPath });
    const publishLedger = this.publishLedger || new PublishLedger({ ledgerPath: publishLedgerPath });
    const mediaCleaner = this.mediaCleaner || new MediaCleaner({
      mediaLedger,
      publishLedger,
      allowedDirectory: this.downloadsDir
    });

    let publisher = this.videoBatchPublisher;
    if (!publisher && this.autoPublish) {
      publisher = new VideoBatchPublisher({
        stagingChatId: this.stagingChatId,
        telegramClient: this.telegramClient,
        batchState,
        publishLedger,
        mediaCleaner,
        enableCleanup: this.enableCleanup
      });
    }

    this.batchCycleManager = new BatchCycleManager({
      acquisitionUrl: this.acquisitionUrl,
      outputDir: this.outputDir,
      downloadsDir: this.downloadsDir,
      batchState,
      mediaIngestor: new (require('./media_ingestor').MediaIngestor)({
        downloadsDir: this.downloadsDir,
        ledger: mediaLedger
      }),
      videoBatchPublisher: publisher,
      autoPublish: this.autoPublish,
      acquisitionOptions: this.acquisitionOptions,
      acquisitionTimeoutMs: this.timeoutMs,
      minSuccessfulVideos: this.minSuccessfulVideos,
      maxSuccessfulVideos: this.maxSuccessfulVideos,
      discoveryTarget: this.discoveryTarget,
      discoveryMax: this.discoveryMax
    });

    return this.batchCycleManager;
  }

  /**
   * Starts the 3-hour recurring batch scheduler.
   * Fail-closed: does nothing if disabled or if configuration is invalid.
   * @param {object} [options]
   * @param {boolean} [options.runImmediately=false]
   * @returns {object} Status object
   */
  start(options = {}) {
    if (!this.enabled) {
      console.log(`${LOG_PREFIX} Runtime is DISABLED (VIDEO_PIPELINE_ENABLED !== 'true'). Remaining dormant.`);
      return { status: 'DISABLED', started: false };
    }

    const validation = this._validateConfiguration();
    if (!validation.valid) {
      console.error(`${LOG_PREFIX} Startup aborted due to configuration error: ${validation.reason}`);
      return { status: 'CONFIG_ERROR', started: false, error: validation.reason };
    }

    if (this._started) {
      console.log(`${LOG_PREFIX} Runtime is already started. Existing scheduler active.`);
      return { status: 'ALREADY_STARTED', started: true };
    }

    try {
      this._ensureManagerInitialized();
      this.batchCycleManager.startScheduler(this.intervalMs, options);
      this._started = true;
      console.log(`${LOG_PREFIX} Runtime started successfully (interval=${this.intervalMs}ms, autoPublish=${this.autoPublish}).`);
      return { status: 'STARTED', started: true, intervalMs: this.intervalMs };
    } catch (err) {
      console.error(`${LOG_PREFIX} Failed to start runtime: ${err.message}`);
      return { status: 'ERROR', started: false, error: err.message };
    }
  }

  /**
   * Stops the recurring scheduler and any in-progress acquisition cleanly.
   * Idempotent: safe to call multiple times.
   * @returns {Promise<object>}
   */
  async stop() {
    if (!this._started && (!this.batchCycleManager || !this.batchCycleManager.isSchedulerActive())) {
      return { status: 'NOT_RUNNING', started: false };
    }

    console.log(`${LOG_PREFIX} Stopping runtime...`);
    try {
      if (this.batchCycleManager) {
        await this.batchCycleManager.stop();
      }
      this._started = false;
      console.log(`${LOG_PREFIX} Runtime stopped cleanly.`);
      return { status: 'STOPPED', started: false };
    } catch (err) {
      console.error(`${LOG_PREFIX} Error during runtime stop: ${err.message}`);
      this._started = false;
      return { status: 'ERROR', started: false, error: err.message };
    }
  }

  /**
   * Manually runs a single batch cycle through the underlying BatchCycleManager.
   * Enforces all configuration and state safety guards.
   * @param {object} [options]
   * @returns {Promise<object>}
   */
  async runOnce(options = {}) {
    if (!this.enabled) {
      return { status: 'SKIPPED', reason: 'Video pipeline runtime is disabled (VIDEO_PIPELINE_ENABLED !== true)' };
    }

    const validation = this._validateConfiguration();
    if (!validation.valid) {
      return { status: 'CONFIG_ERROR', error: validation.reason };
    }

    try {
      this._ensureManagerInitialized();
      return await this.batchCycleManager.runOnce(options);
    } catch (err) {
      console.error(`${LOG_PREFIX} runOnce error: ${err.message}`);
      return { status: 'FAILED', error: err.message };
    }
  }

  /**
   * @returns {boolean} Whether the runtime has been started
   */
  isStarted() {
    return this._started;
  }

  /**
   * Returns a sanitized, safe status snapshot with no secrets.
   * @returns {object}
   */
  getStatus() {
    let state = 'DISABLED';
    let cycleId = null;
    let schedulerActive = false;
    let lastSummary = null;

    if (this.enabled) {
      if (!this._configValid) {
        state = 'CONFIG_ERROR';
      } else if (this.batchCycleManager) {
        state = this.batchCycleManager.batchState.getControllerState();
        cycleId = this.batchCycleManager.batchState.getCurrentCycleId();
        schedulerActive = typeof this.batchCycleManager.isSchedulerActive === 'function'
          ? this.batchCycleManager.isSchedulerActive()
          : Boolean(this.batchCycleManager._timerId);
        lastSummary = typeof this.batchCycleManager.getLastCycleSummary === 'function'
          ? this.batchCycleManager.getLastCycleSummary()
          : (this.batchCycleManager._lastCycleSummary || null);
      } else {
        state = 'IDLE';
      }
    }

    return {
      enabled: this.enabled,
      started: this._started,
      state,
      cycleId,
      schedulerActive,
      configValid: this._configValid,
      lastConfigError: this._lastConfigError,
      lastCycleSummary: lastSummary
    };
  }
}

// Module-scoped singleton instance
let _runtimeInstance = null;

/**
 * Returns the singleton VideoPipelineRuntime instance.
 * @param {object} [config] Optional config for initial instantiation
 * @returns {VideoPipelineRuntime}
 */
function getVideoPipelineRuntime(config) {
  if (!_runtimeInstance) {
    _runtimeInstance = new VideoPipelineRuntime(config);
  }
  return _runtimeInstance;
}

/**
 * Resets the module-scoped singleton (for testing only).
 */
function _resetRuntimeInstanceForTesting() {
  if (_runtimeInstance && _runtimeInstance.isStarted()) {
    try {
      _runtimeInstance.stop();
    } catch (_) {}
  }
  _runtimeInstance = null;
}

module.exports = {
  VideoPipelineRuntime,
  getVideoPipelineRuntime,
  _resetRuntimeInstanceForTesting
};
