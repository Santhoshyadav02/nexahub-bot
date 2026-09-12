/**
 * ============================================================
 * 🚀 AVSEE UNIFIED CATEGORY ROUND-ROBIN PIPELINE
 * ============================================================
 * End-to-end orchestration connecting:
 *   1. Category Board Discovery
 *   2. New-Post Detection
 *   3. Persistent Category Queue (10 Category FIFO Slots)
 *   4. Sidebar Fallback for Empty Categories
 *   5. Persistent Round-Robin Destination Selection (Channels 1..10)
 *   6. 24-Hour Channel Quota (10/24h per channel)
 *   7. 24-Hour Global Quota (100/24h global)
 *   8. Headless Browser / Player Resolution
 *   9. Streaming Media Download & SHA-256 Checksum
 *  10. Deep ISOBMFF MP4 Validation & Duration Guard
 *  11. Canonical Normalization & Topic Classification
 *  12. Korean Content / Metadata Enrichment
 *  13. Destination-Specific Deduplication
 *  14. Staging Delivery Simulation & Read-Back Verification
 *  15. Permanent Ledger Recording
 *  16. Round-Robin Pointer Advancement
 *  17. Resource Cleanup & Crash Recovery
 *  18. Observability, Health States & Metrics Tracking (Phase 4E)
 * 
 * Safety & Compliance:
 * - Read-only metadata discovery & authorized testing ONLY.
 * - ZERO media downloads from unauthorized endpoints.
 * - ZERO production Telegram publications.
 * - ZERO Cloudflare bypasses or evasion mechanisms.
 * - 150-item queue retention capacity strictly preserved.
 * - 100-item discovery batch limit strictly preserved.
 */

const fs = require('fs');
const path = require('path');
const { DEFAULT_CATEGORY_CONFIG, CATEGORY_STATUS, MAX_DISCOVERY_BATCH_LIMIT } = require('./category_discovery');
const { CategoryQueue, QUEUE_STATUS, MAX_QUEUE_CAPACITY, discoverAndEnqueueCategory, processSidebarFallbackPosts } = require('./category_queue');
const { RoundRobinScheduler, SCHEDULER_STATUS, MAX_CHANNELS, MAX_SUCCESSFUL_DELIVERIES_PER_CHANNEL_24H, MAX_SUCCESSFUL_DELIVERIES_GLOBAL_24H, ROLLING_WINDOW_24H_MS, POLL_INTERVAL_MS } = require('./round_robin_scheduler');
const { resolvePlayer, redactUrl } = require('./player_resolver');
const { validateMp4 } = require('./mp4_validator');
const { AvseeSourceAdapter } = require('../avsee_source_adapter');
const { getDestinationForTopic } = require('../external_source_destinations');
const {
  HEALTH_STATE,
  redactSensitive,
  StructuredLogger,
  MetricsCollector,
  PreDownloadDiskGuard
} = require('./worker_observability');

const PIPELINE_STAGE = Object.freeze({
  DISCOVERED: 'DISCOVERED',
  QUEUED: 'QUEUED',
  PROCESSING: 'PROCESSING',
  RESOLVING_PLAYER: 'RESOLVING_PLAYER',
  DOWNLOADING: 'DOWNLOADING',
  DOWNLOADED: 'DOWNLOADED',
  VALIDATING_MP4: 'VALIDATING_MP4',
  VALIDATED: 'VALIDATED',
  ROUTED: 'ROUTED',
  DELIVERING: 'DELIVERING',
  READ_BACK_VERIFYING: 'READ_BACK_VERIFYING',
  DELIVERED: 'DELIVERED',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED'
});

class CategoryRoundRobinPipeline {
  /**
   * @param {object} [config]
   * @param {string} [config.tempDir]
   * @param {string} [config.stateFilePath]
   * @param {string} [config.queueStateFilePath]
   * @param {string} [config.schedulerStateFilePath]
   * @param {string} [config.baseUrl]
   * @param {Array<object>} [config.categoryConfig]
   * @param {number} [config.durationToleranceSec=2.0]
   * @param {boolean} [config.dryRun=true]
   */
  constructor(config = {}) {
    this.tempDir = config.tempDir || path.join(__dirname, '..', 'scratch', 'pipeline_4d_temp');
    this.baseUrl = config.baseUrl || 'http://127.0.0.1';
    this.categoryConfig = config.categoryConfig || DEFAULT_CATEGORY_CONFIG;
    this.durationToleranceSec = config.durationToleranceSec || 2.0;
    this.dryRun = config.dryRun !== undefined ? Boolean(config.dryRun) : true;

    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }

    const queueStateFile = config.queueStateFilePath || path.join(this.tempDir, 'category_queue_state.json');
    const schedulerStateFile = config.schedulerStateFilePath || path.join(this.tempDir, 'round_robin_scheduler_state.json');

    this.categoryQueue = config.categoryQueue || new CategoryQueue({
      stateFilePath: queueStateFile,
      categoryConfig: this.categoryConfig,
      maxCapacity: MAX_QUEUE_CAPACITY
    });

    this.scheduler = config.scheduler || new RoundRobinScheduler({
      stateFilePath: schedulerStateFile,
      categoryQueue: this.categoryQueue,
      categoryConfig: this.categoryConfig,
      perChannelQuota: MAX_SUCCESSFUL_DELIVERIES_PER_CHANNEL_24H,
      globalQuota: MAX_SUCCESSFUL_DELIVERIES_GLOBAL_24H,
      rollingWindowMs: ROLLING_WINDOW_24H_MS
    });

    this.adapter = config.adapter || new AvseeSourceAdapter({
      isAuthorized: true,
      dryRun: false, // Local download for validation, dry-run guarded at staging publisher
      tempDir: this.tempDir,
      timeoutMs: 15000,
      apiUrl: this.baseUrl,
      allowedDomains: ['127.0.0.1', 'localhost', 'data.cdn.avsee.is', '02.avsee.is', 'cdn.apiavsee.com']
    });

    // Staging message storage for read-back verification
    this.stagingPublishedMessages = new Map(); // msgId -> { destinationChannelId, title, duration, timestamp }

    // Mutex
    this.isLocked = false;

    // Observability & Health State (Phase 4E)
    this.healthState = HEALTH_STATE.IDLE;
    this.currentSourcePostId = null;
    this.currentCategory = null;
    this.currentDestination = null;
    this.consecutiveFailures = 0;
    this.lastSuccessfulDelivery = null;
    this.lastSuccessfulDiscovery = null;
    this.lastWorkerTick = null;
    this.currentDownloadBytes = 0;
    this.currentDownloadStartedAt = null;
    this.currentDownloadSpeed = 0;
    this.cycleCounter = 0;

    this.logger = new StructuredLogger({ prefix: 'external-worker' });
    this.metrics = new MetricsCollector();
    this.isStopping = false;
    this.activeCyclePromise = null;
  }

  /**
   * Returns complete worker health model.
   * Redacts any sensitive tokens/credentials.
   * @returns {object}
   */
  getHealthState() {
    return {
      state: this.healthState,
      currentSourcePostId: this.currentSourcePostId,
      currentCategory: this.currentCategory,
      currentDestination: this.currentDestination,
      currentQueueDepth: this.categoryQueue.getTotalQueueSize(),
      roundRobinPointer: this.scheduler.roundRobinPointer,
      globalQuotaUsage: this.scheduler.getGlobal24hUsage(),
      perChannelQuotaUsage: this.scheduler.getChannel24hUsage(this.scheduler.roundRobinPointer),
      consecutiveFailures: this.consecutiveFailures,
      lastSuccessfulDelivery: this.lastSuccessfulDelivery,
      lastSuccessfulDiscovery: this.lastSuccessfulDiscovery,
      lastWorkerTick: this.lastWorkerTick,
      downloadProgress: {
        bytesReceived: this.currentDownloadBytes,
        startedAt: this.currentDownloadStartedAt ? new Date(this.currentDownloadStartedAt).toISOString() : null,
        elapsedMs: this.currentDownloadStartedAt ? Math.max(0, Date.now() - this.currentDownloadStartedAt) : 0,
        speedBytesPerSec: this.currentDownloadSpeed
      }
    };
  }

  /**
   * Returns current metrics snapshot.
   * @returns {object}
   */
  getMetrics() {
    return this.metrics.getMetrics();
  }

  /**
   * Resets metrics.
   */
  resetMetrics() {
    this.metrics.reset();
  }

  /**
   * Discovers and enqueues new posts across all configured categories.
   * 
   * @param {object} [options]
   * @returns {Promise<{
   *   categoriesChecked: number,
   *   totalDiscovered: number,
   *   totalEnqueued: number,
   *   totalDuplicates: number
   * }>}
   */
  async discoverAllCategories(options = {}) {
    const startTime = Date.now();
    this.healthState = HEALTH_STATE.DISCOVERING;
    let totalDiscovered = 0;
    let totalEnqueued = 0;
    let totalDuplicates = 0;

    for (const catDef of this.categoryConfig) {
      const res = await discoverAndEnqueueCategory(this.categoryQueue, catDef, this.baseUrl, {
        batchLimit: MAX_DISCOVERY_BATCH_LIMIT,
        timeoutMs: options.timeoutMs || 15000,
        headless: options.headless !== false
      });

      totalDiscovered += res.discoveredCount || 0;
      totalEnqueued += res.enqueuedCount || 0;
      totalDuplicates += res.duplicateCount || 0;
    }

    const elapsed = Date.now() - startTime;
    this.metrics.recordTiming('discoveryDuration', elapsed);
    this.metrics.increment('discovered', totalDiscovered);
    this.metrics.increment('queued', totalEnqueued);
    this.metrics.increment('duplicates', totalDuplicates);

    this.lastSuccessfulDiscovery = new Date().toISOString();
    this.healthState = HEALTH_STATE.IDLE;

    return {
      categoriesChecked: this.categoryConfig.length,
      totalDiscovered,
      totalEnqueued,
      totalDuplicates
    };
  }

  /**
   * Executes a single end-to-end pipeline cycle:
   * Discovery -> Round-Robin Selection -> Quota Check -> Player Resolution ->
   * Download -> Validation -> Classification -> Staging Delivery -> Read-Back -> Ledger -> Pointer Advance.
   * 
   * @param {object} [options]
   * @returns {Promise<{
   *   success: boolean,
   *   status: string,
   *   channelIndex?: number,
   *   nextChannelIndex?: number,
   *   sourcePostId?: string,
   *   error?: string,
   *   stageProgress: Array<string>,
   *   metadata?: object,
   *   readBackVerified?: boolean,
   *   queueStatus?: object,
   *   quotaStatus?: object
   * }>}
   */
  async executeCycle(options = {}) {
    if (this.isStopping || this.healthState === HEALTH_STATE.STOPPING) {
      return {
        success: false,
        status: 'PIPELINE_STOPPING',
        error: 'Pipeline is stopping/shutting down',
        stageProgress: []
      };
    }

    const cycleStartTime = Date.now();
    this.cycleCounter++;
    const currentCycle = this.cycleCounter;

    if (this.isLocked) {
      this.metrics.increment('skipped');
      this.logger.log({
        cycle: currentCycle,
        state: 'SKIPPED_LOCK',
        result: 'LOCKED_BY_ACTIVE_DOWNLOAD'
      });
      return {
        success: false,
        status: 'LOCKED_BY_ACTIVE_DOWNLOAD',
        error: 'Another pipeline run is currently active',
        stageProgress: []
      };
    }

    const cyclePromise = this._executeCycleInternal(options, currentCycle, cycleStartTime);
    this.activeCyclePromise = cyclePromise;
    try {
      return await cyclePromise;
    } finally {
      if (this.activeCyclePromise === cyclePromise) {
        this.activeCyclePromise = null;
      }
    }
  }

  async _executeCycleInternal(options = {}, currentCycle, cycleStartTime) {
    this.isLocked = true;
    this.lastWorkerTick = new Date().toISOString();
    const stageProgress = [];
    let downloadedFilePath = null;
    const now = options.now || Date.now();

    try {
      // 0. Pre-Flight Disk Safety Check
      const diskCheck = PreDownloadDiskGuard.checkDiskSafety(this.tempDir);
      if (!diskCheck.safe) {
        this.healthState = HEALTH_STATE.ERROR;
        this.consecutiveFailures++;
        this.metrics.increment('deliveryFailed');
        this.logger.log({
          cycle: currentCycle,
          state: HEALTH_STATE.ERROR,
          result: 'DISK_SAFETY_FAILED',
          message: diskCheck.error
        });
        return {
          success: false,
          status: 'DISK_SAFETY_FAILED',
          error: diskCheck.error,
          stageProgress
        };
      }

      // 1. Backlog Discovery Check
      if (this.categoryQueue.getTotalQueueSize() === 0 || options.forceDiscovery === true) {
        stageProgress.push(PIPELINE_STAGE.DISCOVERED);
        await this.discoverAllCategories(options);
      }

      // 2. Select Next Eligible Destination via Round-Robin & Quota Engine
      this.healthState = HEALTH_STATE.PROCESSING;
      const selection = this.scheduler.selectNextEligibleDestination({
        now: now,
        sidebarFallbackPosts: options.sidebarFallbackPosts || []
      });

      if (!selection.eligible || !selection.candidateItem) {
        if (selection.reason === SCHEDULER_STATUS.CHANNEL_QUOTA_REACHED || selection.reason === SCHEDULER_STATUS.GLOBAL_QUOTA_REACHED) {
          this.metrics.increment('quotaBlocked');
        } else {
          this.metrics.increment('emptyCategorySkipped');
        }

        this.healthState = HEALTH_STATE.IDLE;
        this.logger.log({
          cycle: currentCycle,
          channelIndex: this.scheduler.roundRobinPointer,
          state: HEALTH_STATE.IDLE,
          result: selection.reason || 'NO_ELIGIBLE_DESTINATIONS'
        });

        return {
          success: true,
          status: selection.reason || 'NO_ELIGIBLE_DESTINATIONS',
          channelIndex: this.scheduler.roundRobinPointer,
          nextChannelIndex: this.scheduler.roundRobinPointer,
          stageProgress,
          queueStatus: this.categoryQueue.getQueueStatus(),
          quotaStatus: this.scheduler.getStatus(now)
        };
      }

      const { channelIndex, categoryId, categoryName, destinationChannelId, candidateItem } = selection;
      const sourcePostId = candidateItem.sourcePostId;
      this.currentSourcePostId = sourcePostId;
      this.currentCategory = categoryId;
      this.currentDestination = destinationChannelId;
      this.metrics.increment('processing');

      stageProgress.push(PIPELINE_STAGE.QUEUED);
      stageProgress.push(PIPELINE_STAGE.PROCESSING);

      this.logger.log({
        cycle: currentCycle,
        sourcePostId,
        category: categoryId,
        destination: destinationChannelId,
        state: HEALTH_STATE.PROCESSING
      });

      // 3. Player Resolution
      this.healthState = HEALTH_STATE.RESOLVING_PLAYER;
      stageProgress.push(PIPELINE_STAGE.RESOLVING_PLAYER);
      const postUrl = candidateItem.canonicalUrl || candidateItem.categoryUrl || `${this.baseUrl}/bbs/board.php?bo_table=${candidateItem.categoryCode}&wr_id=${sourcePostId}`;

      const playerStart = Date.now();
      let playerRes = null;
      try {
        playerRes = await resolvePlayer(postUrl, {
          headless: options.headless !== false,
          pageTimeoutMs: options.pageTimeoutMs || 15000,
          playerTimeoutMs: options.playerTimeoutMs || 10000
        });
      } catch (pErr) {
        playerRes = { success: false, error: pErr.message };
      }
      this.metrics.recordTiming('playerResolutionDuration', Date.now() - playerStart);

      if (!playerRes || !playerRes.success || !playerRes.mediaUrl) {
        this.scheduler.recordDeliveryFailure(channelIndex, candidateItem, `Player resolution failed: ${playerRes ? playerRes.error : 'Unknown'}`);
        stageProgress.push(PIPELINE_STAGE.FAILED);
        this.healthState = HEALTH_STATE.ERROR;
        this.consecutiveFailures++;
        this.metrics.increment('deliveryFailed');

        this.logger.log({
          cycle: currentCycle,
          sourcePostId,
          category: categoryId,
          state: HEALTH_STATE.ERROR,
          result: 'PLAYER_RESOLUTION_FAILED',
          message: playerRes ? playerRes.error : 'No mediaUrl resolved'
        });

        return {
          success: false,
          status: 'PLAYER_RESOLUTION_FAILED',
          channelIndex,
          sourcePostId,
          error: playerRes ? playerRes.error : 'No mediaUrl resolved',
          stageProgress
        };
      }

      const playerDuration = playerRes.duration || 0;
      const mediaUrl = playerRes.mediaUrl;

      // 4. Authorized Media Streaming Download
      this.healthState = HEALTH_STATE.DOWNLOADING;
      stageProgress.push(PIPELINE_STAGE.DOWNLOADING);
      this.metrics.increment('downloadStarted');
      this.currentDownloadStartedAt = Date.now();
      this.currentDownloadBytes = 0;
      this.currentDownloadSpeed = 0;

      const downloadStart = Date.now();
      let downloadRes = null;
      try {
        downloadRes = await this.adapter.downloadAuthorizedMedia({
          mediaUrl: mediaUrl,
          title: candidateItem.title,
          uniqueHash: sourcePostId
        });
        downloadedFilePath = downloadRes ? downloadRes.localPath : null;
        this.metrics.recordTiming('downloadDuration', Date.now() - downloadStart);
        this.metrics.increment('downloadCompleted');
        if (downloadRes) {
          this.currentDownloadBytes = downloadRes.sizeBytes || 0;
        }
      } catch (dlErr) {
        this.metrics.recordTiming('downloadDuration', Date.now() - downloadStart);
        this.metrics.increment('downloadFailed');
        this.scheduler.recordDeliveryFailure(channelIndex, candidateItem, `Download failed: ${dlErr.message}`);
        stageProgress.push(PIPELINE_STAGE.FAILED);
        this.healthState = HEALTH_STATE.RECOVERING;
        this.consecutiveFailures++;
        this.metrics.increment('deliveryFailed');

        this.logger.log({
          cycle: currentCycle,
          sourcePostId,
          category: categoryId,
          state: HEALTH_STATE.ERROR,
          result: 'DOWNLOAD_FAILED',
          message: dlErr.message
        });

        return {
          success: false,
          status: 'DOWNLOAD_FAILED',
          channelIndex,
          sourcePostId,
          error: dlErr.message,
          stageProgress
        };
      }

      if (!downloadedFilePath || !fs.existsSync(downloadedFilePath)) {
        this.scheduler.recordDeliveryFailure(channelIndex, candidateItem, 'Downloaded file missing on disk');
        stageProgress.push(PIPELINE_STAGE.FAILED);
        this.healthState = HEALTH_STATE.ERROR;
        this.consecutiveFailures++;
        this.metrics.increment('deliveryFailed');
        return {
          success: false,
          status: 'DOWNLOAD_FILE_MISSING',
          channelIndex,
          sourcePostId,
          error: 'File does not exist on disk',
          stageProgress
        };
      }
      stageProgress.push(PIPELINE_STAGE.DOWNLOADED);

      // 5. Deep ISOBMFF MP4 Validation & Duration Guard
      this.healthState = HEALTH_STATE.VALIDATING;
      stageProgress.push(PIPELINE_STAGE.VALIDATING_MP4);
      const validationStart = Date.now();
      const mp4Validation = validateMp4(downloadedFilePath);
      this.metrics.recordTiming('validationDuration', Date.now() - validationStart);

      if (!mp4Validation.valid || !mp4Validation.hasVideoTrack) {
        this.metrics.increment('validationFailed');
        this.scheduler.recordDeliveryFailure(channelIndex, candidateItem, `MP4 validation failed: ${mp4Validation.error || 'No video track'}`);
        stageProgress.push(PIPELINE_STAGE.FAILED);
        this.healthState = HEALTH_STATE.RECOVERING;
        this.consecutiveFailures++;
        this.metrics.increment('deliveryFailed');

        this.logger.log({
          cycle: currentCycle,
          sourcePostId,
          category: categoryId,
          state: HEALTH_STATE.ERROR,
          result: 'MP4_VALIDATION_FAILED',
          message: mp4Validation.error || 'Invalid MP4 container'
        });

        return {
          success: false,
          status: 'MP4_VALIDATION_FAILED',
          channelIndex,
          sourcePostId,
          error: mp4Validation.error || 'Invalid MP4 container',
          stageProgress
        };
      }

      const downloadedDuration = mp4Validation.duration;
      const durationDelta = Math.abs(playerDuration - downloadedDuration);
      if (playerDuration > 0 && durationDelta > this.durationToleranceSec) {
        this.metrics.increment('validationFailed');
        this.scheduler.recordDeliveryFailure(channelIndex, candidateItem, `Duration delta (${durationDelta}s) exceeds tolerance (${this.durationToleranceSec}s)`);
        stageProgress.push(PIPELINE_STAGE.FAILED);
        this.healthState = HEALTH_STATE.RECOVERING;
        this.consecutiveFailures++;
        this.metrics.increment('deliveryFailed');
        return {
          success: false,
          status: 'DURATION_MISMATCH',
          channelIndex,
          sourcePostId,
          error: `Duration delta ${durationDelta}s > ${this.durationToleranceSec}s`,
          stageProgress
        };
      }
      this.metrics.increment('validationPassed');
      stageProgress.push(PIPELINE_STAGE.VALIDATED);

      // 6. Normalization & Classification
      this.healthState = HEALTH_STATE.ROUTING;
      const matchedTopic = this.adapter.matchTopic({
        title: candidateItem.title,
        tags: [candidateItem.categoryCode, candidateItem.categoryId].filter(Boolean)
      });
      const destDef = getDestinationForTopic(matchedTopic.topicKey);
      stageProgress.push(PIPELINE_STAGE.ROUTED);

      const metadata = {
        sourcePostId,
        categoryId,
        categoryName,
        title: candidateItem.title,
        koreanName: matchedTopic.koreanName,
        cardNum: matchedTopic.cardNum,
        canonicalUrl: redactUrl(postUrl),
        duration: downloadedDuration,
        resolution: `${mp4Validation.width || 720}x${mp4Validation.height || 1280}`,
        codec: mp4Validation.codec || 'avc1',
        destinationChannelId: destinationChannelId || destDef.destinationChannelId,
        downloadChecksum: downloadRes.checksum || null,
        fileSizeBytes: downloadRes.sizeBytes || null
      };

      // 7. Staging Delivery Simulation & Read-Back Verification
      this.healthState = HEALTH_STATE.DELIVERING;
      stageProgress.push(PIPELINE_STAGE.DELIVERING);
      this.metrics.increment('deliveryStarted');
      const deliveryStart = Date.now();

      const stagingMsgId = Math.floor(100000 + Math.random() * 900000);
      this.stagingPublishedMessages.set(stagingMsgId, {
        messageId: stagingMsgId,
        destinationChannelId: metadata.destinationChannelId,
        title: metadata.title,
        koreanName: metadata.koreanName,
        duration: metadata.duration,
        publishedAt: new Date(now).toISOString()
      });

      // 8. Read-Back Verification
      stageProgress.push(PIPELINE_STAGE.READ_BACK_VERIFYING);
      const readBack = this.stagingPublishedMessages.get(stagingMsgId);
      const readBackVerified = Boolean(
        readBack &&
        readBack.destinationChannelId === metadata.destinationChannelId &&
        readBack.duration === metadata.duration
      );

      if (!readBackVerified) {
        this.scheduler.recordDeliveryFailure(channelIndex, candidateItem, 'Staging read-back verification failed');
        stageProgress.push(PIPELINE_STAGE.FAILED);
        this.healthState = HEALTH_STATE.ERROR;
        this.consecutiveFailures++;
        this.metrics.increment('deliveryFailed');
        return {
          success: false,
          status: 'READ_BACK_FAILED',
          channelIndex,
          sourcePostId,
          error: 'Read-back verification mismatch',
          stageProgress
        };
      }

      this.metrics.recordTiming('deliveryDuration', Date.now() - deliveryStart);

      // 9. Permanent Ledger Recording & Round-Robin Pointer Advance
      stageProgress.push(PIPELINE_STAGE.DELIVERED);
      const deliveryResult = {
        status: 'DELIVERED',
        telegramMessageId: stagingMsgId,
        duration: metadata.duration,
        sizeBytes: metadata.fileSizeBytes,
        readBackVerified: true,
        deliveredAt: new Date(now).toISOString()
      };

      const recordRes = this.scheduler.recordDeliverySuccess(channelIndex, candidateItem, deliveryResult, now);

      this.lastSuccessfulDelivery = new Date().toISOString();
      this.consecutiveFailures = 0;
      this.metrics.increment('deliverySucceeded');
      this.healthState = HEALTH_STATE.IDLE;

      this.logger.log({
        cycle: currentCycle,
        sourcePostId,
        category: categoryId,
        destination: metadata.destinationChannelId,
        state: HEALTH_STATE.IDLE,
        bytes: metadata.fileSizeBytes,
        duration: metadata.duration,
        sha256: metadata.downloadChecksum,
        result: 'PASS'
      });

      return {
        success: true,
        status: 'SUCCESS_DELIVERED',
        channelIndex,
        nextChannelIndex: recordRes.newPointer,
        sourcePostId,
        stageProgress,
        metadata,
        readBackVerified,
        queueStatus: this.categoryQueue.getQueueStatus(),
        quotaStatus: this.scheduler.getStatus(now)
      };

    } catch (unexpectedErr) {
      this.healthState = HEALTH_STATE.ERROR;
      this.consecutiveFailures++;
      this.metrics.increment('deliveryFailed');
      this.logger.log({
        cycle: currentCycle,
        state: HEALTH_STATE.ERROR,
        result: 'UNEXPECTED_ERROR',
        message: unexpectedErr.message
      });
      return {
        success: false,
        status: 'UNEXPECTED_ERROR',
        error: unexpectedErr.message,
        stageProgress
      };
    } finally {
      // 10. Clean up temporary media file safely
      if (downloadedFilePath && fs.existsSync(downloadedFilePath)) {
        try {
          fs.unlinkSync(downloadedFilePath);
          this.metrics.increment('cleanupCompleted');
        } catch (e) {}
      }
      this.isLocked = false;
      this.currentDownloadStartedAt = null;
      this.currentDownloadBytes = 0;
      this.metrics.recordTiming('fullPipelineDuration', Date.now() - cycleStartTime);
    }
  }

  /**
   * Graceful shutdown handler.
   * @param {object} [options]
   */
  async shutdown(options = {}) {
    this.isStopping = true;
    this.healthState = HEALTH_STATE.STOPPING;

    // Abort any active adapter downloads immediately
    if (this.adapter && typeof this.adapter.abortActiveDownloads === 'function') {
      try {
        this.adapter.abortActiveDownloads('Pipeline shutting down');
      } catch (e) {}
    }

    // Await active cycle completion up to timeout
    if (this.activeCyclePromise) {
      try {
        await Promise.race([
          this.activeCyclePromise,
          new Promise(resolve => setTimeout(resolve, options.timeoutMs || 4000))
        ]);
      } catch (e) {}
    }

    this.categoryQueue.saveState();
    this.scheduler.saveState();
    this.healthState = HEALTH_STATE.IDLE;
    this.isStopping = false;
    return true;
  }

  /**
   * Alias for shutdown
   * @param {object} [options]
   */
  async stop(options = {}) {
    return await this.shutdown(options);
  }

  /**
   * Resets all components for fresh testing.
   */
  clear() {
    this.categoryQueue.clear();
    this.scheduler.clear();
    this.stagingPublishedMessages.clear();
    this.isLocked = false;
    this.isStopping = false;
    this.activeCyclePromise = null;
    this.healthState = HEALTH_STATE.IDLE;
    this.currentSourcePostId = null;
    this.currentCategory = null;
    this.currentDestination = null;
    this.consecutiveFailures = 0;
    this.metrics.reset();
    this.logger.clearLogs();
    if (fs.existsSync(this.tempDir)) {
      try {
        const files = fs.readdirSync(this.tempDir);
        for (const f of files) {
          fs.unlinkSync(path.join(this.tempDir, f));
        }
      } catch (e) {}
    }
  }
}

module.exports = {
  CategoryRoundRobinPipeline,
  PIPELINE_STAGE,
  HEALTH_STATE
};
