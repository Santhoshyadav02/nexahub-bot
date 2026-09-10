/**
 * ============================================================
 * 🔄 AVSEE INTEGRATED PIPELINE ORCHESTRATOR
 * ============================================================
 * Connects:
 *   1. Post Discovery
 *   2. Player Resolver (Stage 1)
 *   3. Authorized Downloader (Stage 2)
 *   4. Deep ISOBMFF MP4 Validator
 *   5. Duration Delta Guard
 *   6. NexaHub Canonical Normalization
 *   7. 12-Topic Classification
 *   8. 10-Channel Destination Routing
 *   9. Persistent Dedupe Ledger & Retention Pool
 *  10. Dry-Run Publisher Safety Gate
 * 
 * Safety & Compliance:
 * - EXTERNAL_PUBLISH_ENABLED=false
 * - AVSEE_DRY_RUN=true
 * - Zero Telegram production traffic
 * - Redacted token logging
 * - Reuses existing adapter, stateStore, and destinations without modifying production files.
 */

const path = require("path");
const fs = require("fs");
const { resolvePlayer, redactUrl, RESOLVER_STATES } = require("./player_resolver");
const { validateMp4 } = require("./mp4_validator");
const { AvseeSourceAdapter } = require("../avsee_source_adapter");
const { ExternalSourceState } = require("../external_source_state");
const { ExternalSourcePublisher } = require("../external_source_publisher");
const { getDestinationForTopic } = require("../external_source_destinations");

const PIPELINE_STATES = Object.freeze({
  DISCOVERY_FAILED: "DISCOVERY_FAILED",
  RESOLVER_FAILED: "RESOLVER_FAILED",
  DOWNLOAD_FAILED: "DOWNLOAD_FAILED",
  MP4_VALIDATION_FAILED: "MP4_VALIDATION_FAILED",
  DURATION_MISMATCH: "DURATION_MISMATCH",
  NORMALIZATION_FAILED: "NORMALIZATION_FAILED",
  DUPLICATE_SKIPPED: "DUPLICATE_SKIPPED",
  DRY_RUN_DELIVERED: "DRY_RUN_DELIVERED",
  SUCCESS: "SUCCESS"
});

class AvseePipelineOrchestrator {
  /**
   * @param {object} [config]
   */
  constructor(config = {}) {
    this.dryRun = config.dryRun !== undefined ? Boolean(config.dryRun) : true;
    this.tempDir = config.tempDir || path.join(__dirname, "..", "scratch", "orchestrator_temp");
    this.durationToleranceSec = config.durationToleranceSec || 2.0;

    this.adapter = config.adapter || new AvseeSourceAdapter({
      isAuthorized: true,
      dryRun: false, // Downloader active for validation, dry-run guarded at publisher
      tempDir: this.tempDir,
      timeoutMs: config.timeoutMs || 15000,
      apiUrl: config.apiUrl || "http://127.0.0.1",
      allowedDomains: config.allowedDomains || ["127.0.0.1", "localhost", "data.cdn.avsee.is", "02.avsee.is", "cdn.apiavsee.com"]
    });

    this.stateStore = config.stateStore || new ExternalSourceState({
      stateFilePath: config.stateFilePath || path.join(this.tempDir, "orchestrator_state.json"),
      maxTotalItems: config.maxTotalItems || 150
    });

    this.publisher = config.publisher || new ExternalSourcePublisher({
      stateStore: this.stateStore,
      maxTotalItems: config.maxTotalItems || 150
    });

    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  /**
   * Orchestrates the complete discovery-to-ledger pipeline for an authorized post.
   * 
   * @param {object} rawPost
   * @param {object} [options]
   * @returns {Promise<{
   *   success: boolean,
   *   pipelineState: string,
   *   error?: string,
   *   postDiscoveryPass: boolean,
   *   playerResolverPass: boolean,
   *   mediaUrlResolved: boolean,
   *   downloadPass: boolean,
   *   mp4ValidationPass: boolean,
   *   playerDuration: number,
   *   downloadedDuration: number,
   *   durationDelta: number,
   *   normalizationPass: boolean,
   *   classificationPass: boolean,
   *   routingPass: boolean,
   *   dedupeCheckPass: boolean,
   *   isDuplicate: boolean,
   *   ledgerDecision: string,
   *   telegramPublish: string,
   *   normalizedItem?: object,
   *   classification?: object,
   *   destination?: object,
   *   diagnostics: object
   * }>}
   */
  async processAuthorizedPost(rawPost, options = {}) {
    let localPath = null;

    const result = {
      success: false,
      pipelineState: null,
      error: null,
      postDiscoveryPass: false,
      playerResolverPass: false,
      mediaUrlResolved: false,
      downloadPass: false,
      mp4ValidationPass: false,
      playerDuration: 0,
      downloadedDuration: 0,
      durationDelta: 0,
      normalizationPass: false,
      classificationPass: false,
      routingPass: false,
      dedupeCheckPass: false,
      isDuplicate: false,
      ledgerDecision: "NONE",
      telegramPublish: "SKIPPED",
      normalizedItem: null,
      classification: null,
      destination: null,
      diagnostics: {}
    };

    try {
      // 1. Post Discovery Validation
      if (!rawPost || typeof rawPost !== "object" || !rawPost.pageUrl || !rawPost.title) {
        result.pipelineState = PIPELINE_STATES.DISCOVERY_FAILED;
        result.error = "Invalid raw post: missing required pageUrl or title";
        return result;
      }
      result.postDiscoveryPass = true;

      // 2. Player Resolution (Headless DOM inspection)
      const resolverRes = await resolvePlayer(rawPost.pageUrl, {
        headless: true,
        pageTimeoutMs: options.pageTimeoutMs || 15000,
        playerTimeoutMs: options.playerTimeoutMs || 10000,
        logDiagnostics: options.logDiagnostics !== undefined ? options.logDiagnostics : false
      });

      if (!resolverRes.success || !resolverRes.mediaUrl) {
        result.pipelineState = PIPELINE_STATES.RESOLVER_FAILED;
        result.error = `Player resolution failed: ${resolverRes.error || "No mediaUrl"}`;
        return result;
      }

      result.playerResolverPass = true;
      result.mediaUrlResolved = true;
      result.playerDuration = resolverRes.duration || 0;

      // 3. Authorized Streaming Download
      const downloadItem = {
        mediaUrl: resolverRes.mediaUrl,
        title: rawPost.title,
        uniqueHash: rawPost.itemId || rawPost.id || `post_${Date.now()}`
      };

      let downloadRes;
      try {
        downloadRes = await this.adapter.downloadAuthorizedMedia(downloadItem);
        localPath = downloadRes.localPath;
      } catch (dlErr) {
        result.pipelineState = PIPELINE_STATES.DOWNLOAD_FAILED;
        result.error = `Download failed: ${dlErr.message}`;
        return result;
      }

      if (!downloadRes || !downloadRes.localPath || !fs.existsSync(downloadRes.localPath)) {
        result.pipelineState = PIPELINE_STATES.DOWNLOAD_FAILED;
        result.error = "Downloaded media file does not exist on disk";
        return result;
      }
      result.downloadPass = true;

      // 4. Deep ISOBMFF MP4 Validation
      const mp4Validation = validateMp4(downloadRes.localPath);
      if (!mp4Validation.valid || !mp4Validation.hasVideoTrack) {
        result.pipelineState = PIPELINE_STATES.MP4_VALIDATION_FAILED;
        result.error = `MP4 validation failed: ${mp4Validation.error || "Missing video track"}`;
        return result;
      }
      result.mp4ValidationPass = true;
      result.downloadedDuration = mp4Validation.duration;

      // 5. Duration Consistency Guard
      const durationDelta = Math.abs(result.playerDuration - result.downloadedDuration);
      result.durationDelta = Math.round(durationDelta * 100) / 100;

      if (durationDelta > this.durationToleranceSec) {
        result.pipelineState = PIPELINE_STATES.DURATION_MISMATCH;
        result.error = `Duration mismatch exceeds tolerance: Player=${result.playerDuration}s, Downloaded=${result.downloadedDuration}s, Delta=${result.durationDelta}s`;
        return result;
      }

      // 6. Normalization
      const itemToNormalize = {
        ...rawPost,
        id: rawPost.itemId || rawPost.id || "auth_post_1",
        mediaUrl: resolverRes.mediaUrl,
        duration: mp4Validation.duration,
        width: mp4Validation.width,
        height: mp4Validation.height,
        codec: mp4Validation.codec
      };

      const normalized = this.adapter.normalizeItem(itemToNormalize);
      if (!normalized || !normalized.valid) {
        result.pipelineState = PIPELINE_STATES.NORMALIZATION_FAILED;
        result.error = `Normalization failed: ${normalized ? normalized.error : "Unknown"}`;
        return result;
      }
      result.normalizationPass = true;
      result.normalizedItem = normalized;

      // 7. 12-Topic Classification
      const classification = this.adapter.matchTopic(normalized);
      result.classificationPass = true;
      result.classification = classification;
      normalized.topicKey = classification.topicKey;
      normalized.topicConfidence = classification.confidence;
      normalized.matchedRule = classification.matchedRule;
      normalized.matchedToken = classification.matchedToken;
      normalized.koreanName = classification.koreanName;
      normalized.cardNum = classification.cardNum;

      // 8. 10-Channel Routing
      const destination = getDestinationForTopic(classification.topicKey);
      result.routingPass = true;
      result.destination = destination;
      normalized.destinationChannel = destination.destinationChannelId;

      // 9. Dedupe & Ledger Check
      result.dedupeCheckPass = true;
      if (this.stateStore.hasSeen(normalized)) {
        result.isDuplicate = true;
        result.pipelineState = PIPELINE_STATES.DUPLICATE_SKIPPED;
        result.ledgerDecision = "SKIPPED_DUPLICATE";
        result.telegramPublish = "SKIPPED";
        result.success = true; // Duplicate handling is successful completion of dedupe policy
        return result;
      }

      // 10. Dry-Run Publisher Decision
      await this.publisher.publishAuthorizedItem(normalized, localPath, destination);
      this.stateStore.recordPermanentItem(normalized, { isDelivered: false, status: "RETAINED_IN_POOL" });

      result.pipelineState = PIPELINE_STATES.DRY_RUN_DELIVERED;
      result.ledgerDecision = "DRY_RUN";
      result.telegramPublish = "SKIPPED";
      result.success = true;

      result.diagnostics = {
        sourceId: normalized.sourceId,
        itemId: normalized.itemId,
        title: normalized.title,
        destinationChannel: destination.destinationChannelId,
        destinationName: destination.destinationName,
        topicKey: classification.topicKey,
        matchedRule: classification.matchedRule,
        matchedToken: classification.matchedToken,
        sizeBytes: downloadRes.sizeBytes,
        checksum: downloadRes.checksum
      };

      return result;

    } finally {
      if (localPath) {
        this.adapter.cleanupMedia(localPath);
      }
    }
  }
}

module.exports = {
  AvseePipelineOrchestrator,
  PIPELINE_STATES
};
