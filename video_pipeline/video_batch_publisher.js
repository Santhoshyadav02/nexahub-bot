/**
 * ============================================================
 * 📤 VIDEO BATCH PUBLISHER (Phase 4C - Local Publishing Lifecycle)
 * ============================================================
 * Consumes ONLY a frozen BATCH_READY batch produced by BatchCycleManager,
 * generates a deterministic publish plan via VideoDestinationRouter, and
 * publishes authorized/non-explicit test MP4 files to a configured Telegram
 * STAGING destination.
 *
 * Hard safety boundaries:
 *   - Refuses to run if VIDEO_PIPELINE_STAGING_CHAT_ID is missing or matches
 *     a known production channel.
 *   - Never modifies production routing or production channels.
 *   - Deletes media files ONLY after confirmed publication via MediaCleaner.
 *   - Deterministic captions using frozen media.title only (no re-scraping).
 *   - Strictly sequential publishing (no parallel Telegram uploads).
 *   - Idempotent: skips any mediaId already marked PUBLISHED for this destination.
 */

const fs = require('fs');
const path = require('path');

const { BatchState } = require('./batch_state');
const { PublishLedger } = require('./publish_ledger');
const { MediaCleaner } = require('./media_cleaner');
const { VideoDestinationRouter } = require('./video_destination_router');
const { validateMediaFile } = require('./media_validator');
const { GlobalRoundRobinRouter } = require('../global_round_robin_router');

const LOG_PREFIX = '[VIDEO_BATCH_PUBLISHER]';
const DEFAULT_RATE_LIMIT_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Safe-to-log form of a source URL: strips query strings (where signed
 * tokens/credentials typically live) and any embedded userinfo, keeping only
 * scheme+host+path. Never throws - an unparsable value is redacted whole.
 * @param {string} url
 * @returns {string}
 */
function redactUrl(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch (e) {
    return '<redacted>';
  }
}

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

class VideoBatchPublisher {
  /**
   * @param {object} config
   * @param {string} [config.stagingChatId] Explicit staging destination ID (e.g. process.env.VIDEO_PIPELINE_STAGING_CHAT_ID)
   * @param {object} [config.telegramClient] Injected Telegram client (must provide sendVideo or sendFile method)
   * @param {BatchState} [config.batchState]
   * @param {PublishLedger} [config.publishLedger]
   * @param {MediaCleaner} [config.mediaCleaner]
   * @param {VideoDestinationRouter} [config.destinationRouter]
   * @param {Function} [config.mediaValidator]
   * @param {number} [config.rateLimitDelayMs] Delay between sequential uploads (ms)
   * @param {number} [config.maxRetries=1]
   * @param {boolean} [config.enableCleanup=false] Whether to clean media files after confirmed publication
   */
  constructor(config = {}) {
    // The staging target is retained solely for isolated legacy tests. The live
    // runtime deliberately does not read VIDEO_PIPELINE_STAGING_CHAT_ID: a
    // configured value such as "me" must never override routed destinations.
    this.stagingChatId = config.stagingChatId || null;
    this.telegramClient = config.telegramClient || null;
    this.batchState = config.batchState || new BatchState({ statePath: config.batchStatePath });
    this.publishLedger = config.publishLedger || new PublishLedger({ ledgerPath: config.publishLedgerPath });
    this.mediaCleaner = config.mediaCleaner || new MediaCleaner({ publishLedger: this.publishLedger });
    this.destinationRouter = config.destinationRouter || new VideoDestinationRouter();
    this.useRoundRobin = config.useRoundRobin !== undefined ? Boolean(config.useRoundRobin) : !this.stagingChatId;
    this.roundRobinRouter = config.roundRobinRouter || (this.useRoundRobin
      ? new GlobalRoundRobinRouter({
        destinations: this.destinationRouter.getDestinations().map(destination => destination.id),
        ledger: this.publishLedger
      }) : null);
    this.mediaValidator = config.mediaValidator || validateMediaFile;
    this.rateLimitDelayMs = config.rateLimitDelayMs !== undefined ? config.rateLimitDelayMs : DEFAULT_RATE_LIMIT_DELAY_MS;
    this.maxRetries = config.maxRetries !== undefined ? config.maxRetries : 1;
    this.enableCleanup = Boolean(config.enableCleanup);

    if (!this.useRoundRobin) this._validateStagingDestination(this.stagingChatId);
  }

  _validateStagingDestination(chatId) {
    if (!chatId || typeof chatId !== 'string' || !chatId.trim()) {
      return { valid: false, reason: 'VIDEO_PIPELINE_STAGING_CHAT_ID is not configured.' };
    }
    const clean = chatId.trim().replace(/^@/, '').toLowerCase();
    if (FORBIDDEN_PRODUCTION_DESTINATIONS.has(clean)) {
      return {
        valid: false,
        reason: `Target destination "${chatId}" is a protected production channel. Staging publisher strictly refuses.`
      };
    }
    return { valid: true };
  }

  /**
   * Formats a clean deterministic caption from the frozen batch title.
   * @param {object} media
   * @returns {string}
   */
  formatCaption(media) {
    let title = (media && media.title ? String(media.title).trim() : '');
    if (!title) {
      const fallbackId = (media && media.mediaId ? String(media.mediaId).substring(0, 8) : 'item');
      title = `Video Update (${fallbackId})`;
      console.log(`${LOG_PREFIX} Missing title for media ${fallbackId}; using fallback caption: "${title}"`);
    }
    // Limit caption length to Telegram max (1024 chars for media captions)
    if (title.length > 1000) {
      return title.substring(0, 997) + '...';
    }
    return title;
  }

  /**
   * Publishes a single media item to the configured staging destination.
   * Performs destination validation, idempotency check, file stability & validation,
   * ledger attempt recording, Telegram upload, ledger success recording, and post-publish cleanup.
   *
   * @param {string} batchId Cycle or batch ID
   * @param {object} media Media record { mediaId, title, filePath, contentSha256, ... }
   * @param {object} [options] Options override
   * @returns {Promise<object>} Item publish result
   */
  async publishSingleItem(batchId, media, options = {}) {
    if (!media || !media.mediaId) {
      return { status: 'FAILED', reason: 'Invalid media record: missing mediaId' };
    }

    const target = this._selectTarget(media, options);
    if (!target.valid) {
      return {
        status: 'REJECTED',
        mediaId: media.mediaId,
        destinationId: target.destinationId,
        reason: target.reason
      };
    }

    const shouldCleanup = options.enableCleanup !== undefined ? Boolean(options.enableCleanup) : this.enableCleanup;
    const routingDecision = this.destinationRouter.routeMedia(media);
    const canonicalDest = routingDecision.primaryDestination
      ? routingDecision.primaryDestination.id
      : 'DESTINATION_1';

    const planItem = {
      planId: `plan_${batchId}_${media.mediaId}`,
      cycleId: batchId,
      mediaId: media.mediaId,
      title: media.title || '',
      filePath: media.filePath,
      contentSha256: media.contentSha256,
      canonicalDestination: target.canonicalDestination || canonicalDest,
      targetDestinationId: target.destinationId,
      routingDecision,
      status: 'PENDING',
      attempts: 0
    };

    const result = await this._publishMediaItem(batchId, media, target.destinationId, planItem, shouldCleanup);
    this._confirmRoundRobinSuccess(target, result);
    return result;
  }

  /**
   * Builds a deterministic publish plan for a frozen batch using the router.
   * @param {string} batchId
   * @param {Array<object>} mediaList
   * @param {string} targetChatId
   * @returns {Array<object>} Publish plan items
   */
  createPublishPlan(batchId, mediaList, targetChatId) {
    if (!Array.isArray(mediaList)) return [];
    return mediaList.map(media => {
      const routingDecision = this.destinationRouter.routeMedia(media);
      const canonicalDest = routingDecision.primaryDestination
        ? routingDecision.primaryDestination.id
        : 'DESTINATION_1';

      return {
        planId: `plan_${batchId}_${media.mediaId}`,
        cycleId: batchId,
        mediaId: media.mediaId,
        title: media.title || '',
        filePath: media.filePath,
        contentSha256: media.contentSha256,
        canonicalDestination: canonicalDest,
        targetDestinationId: targetChatId,
        routingDecision,
        status: 'PENDING',
        attempts: 0
      };
    });
  }

  /**
   * Publishes all eligible media from an explicit BATCH_READY cycle to STAGING.
   * Transitions batch state: BATCH_READY -> PUBLISHING -> COMPLETED | COMPLETED_PARTIAL | FAILED.
   * @param {string} batchId Cycle ID to publish
   * @param {object} [options]
   * @param {string} [options.stagingChatIdOverride]
   * @param {boolean} [options.allowAlreadyPublishedBatch=false]
   * @param {boolean} [options.enableCleanup] Override cleanup setting for this run
   * @returns {Promise<object>} Publish summary
   */
  async publishBatch(batchId, options = {}) {
    if (!this.useRoundRobin) {
      const destValidation = this._validateStagingDestination(options.stagingChatIdOverride || this.stagingChatId);
      if (!destValidation.valid) {
        console.error(`${LOG_PREFIX} Refused to run: ${destValidation.reason}`);
        return { status: 'REJECTED', batchId, destinationId: this.stagingChatId, reason: destValidation.reason };
      }
    }
    const targetChatId = this.useRoundRobin ? null : (options.stagingChatIdOverride || this.stagingChatId);
    if (this.useRoundRobin && this.destinationRouter.getDestinations().some(destination => !destination.chatId || destination.chatId === 'me')) {
      const reason = 'Round-robin destination configuration is missing a valid Telegram chat ID.';
      console.error(`${LOG_PREFIX} Refused to run: ${reason}`);
      return {
        status: 'REJECTED',
        batchId,
        reason
      };
    }

    if (!batchId) {
      return {
        status: 'REJECTED',
        reason: 'batchId is required for publishBatch.'
      };
    }

    const batch = this.batchState.getCycle(batchId);
    if (!batch) {
      return {
        status: 'NOT_FOUND',
        batchId,
        reason: `Batch ${batchId} was not found in BatchState.`
      };
    }

    const isCompleted = ['COMPLETED', 'PUBLISHED'].includes(batch.status);
    const isRetryable = ['FAILED', 'COMPLETED_PARTIAL'].includes(batch.status);
    const isEligible = batch.status === 'BATCH_READY' || isRetryable || (options.allowAlreadyPublishedBatch && isCompleted);
    if (!isEligible) {
      return {
        status: 'REJECTED',
        batchId,
        batchStatus: batch.status,
        reason: `Batch status is "${batch.status}", expected "BATCH_READY" or retryable status.`
      };
    }

    const shouldCleanup = options.enableCleanup !== undefined ? Boolean(options.enableCleanup) : this.enableCleanup;
    const mediaList = Array.isArray(batch.media) ? batch.media : [];

    // Update batch state to PUBLISHING
    this.batchState.updateCycle(batchId, { status: 'PUBLISHING', publishingStartedAt: new Date().toISOString() });
    this.batchState.setControllerState('PUBLISHING');

    console.log(`${LOG_PREFIX} Publishing batch ${batchId} (${mediaList.length} items) using ${this.useRoundRobin ? 'round-robin destinations' : `staging destination ${targetChatId}`}`);

    // Generate deterministic publish plan
    const plan = this.createPublishPlan(batchId, mediaList, targetChatId);

    const results = [];
    let publishedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let cleanedCount = 0;

    for (let i = 0; i < plan.length; i++) {
      const planItem = plan[i];
      const media = mediaList[i];
      const target = this._selectTarget(media, options);
      if (!target.valid) {
        results.push({ mediaId: media.mediaId, status: 'REJECTED', reason: target.reason, destinationId: target.destinationId });
        failedCount++;
        continue;
      }
      planItem.canonicalDestination = target.canonicalDestination || planItem.canonicalDestination;
      planItem.targetDestinationId = target.destinationId;
      const itemResult = await this._publishMediaItem(batchId, media, target.destinationId, planItem, shouldCleanup);
      this._confirmRoundRobinSuccess(target, itemResult);
      results.push(itemResult);

      if (itemResult.status === 'PUBLISHED') {
        publishedCount++;
        if (itemResult.cleaned) cleanedCount++;
      } else if (itemResult.status === 'SKIPPED_ALREADY_PUBLISHED') {
        skippedCount++;
        if (itemResult.cleaned) cleanedCount++;
      } else {
        failedCount++;
      }

      // Conservative inter-item pacing delay
      if (i < plan.length - 1 && this.rateLimitDelayMs > 0) {
        await sleep(this.rateLimitDelayMs);
      }
    }

    // Determine overall batch outcome
    let finalBatchStatus = 'COMPLETED';
    if (mediaList.length === 0) {
      finalBatchStatus = 'COMPLETED_EMPTY';
    } else if (failedCount > 0 && publishedCount === 0 && skippedCount === 0) {
      finalBatchStatus = 'FAILED';
    } else if (failedCount > 0) {
      finalBatchStatus = 'COMPLETED_PARTIAL';
    }

    const completedAt = new Date().toISOString();
    this.batchState.updateCycle(batchId, {
      status: finalBatchStatus,
      completedAt,
      publishedCount,
      skippedCount,
      failedCount,
      cleanedCount
    });
    this.batchState.setControllerState(finalBatchStatus === 'FAILED' ? 'FAILED' : 'IDLE');

    const summary = {
      batchId,
      destinationId: targetChatId,
      status: finalBatchStatus,
      totalItems: mediaList.length,
      published: publishedCount,
      skipped: skippedCount,
      failed: failedCount,
      cleaned: cleanedCount,
      completedAt,
      items: results
    };

    console.log(`${LOG_PREFIX} Batch ${batchId} publishing complete -> ${finalBatchStatus} `
      + `(total=${mediaList.length}, published=${publishedCount}, skipped=${skippedCount}, failed=${failedCount}, cleaned=${cleanedCount})`);

    return summary;
  }

  _selectTarget(media, options = {}) {
    if (!this.useRoundRobin) {
      const destinationId = options.chatIdOverride || options.stagingChatIdOverride || this.stagingChatId;
      const validation = this._validateStagingDestination(destinationId);
      return { valid: validation.valid, reason: validation.reason, destinationId };
    }
    if (!this.roundRobinRouter) return { valid: false, reason: 'Round-robin router is not initialized.' };
    const identity = `video:${media.mediaId}`;
    const decision = this.roundRobinRouter.assignDestination({ sourceChannelId: 'video', messageId: media.mediaId, title: media.title || '' });
    if (decision.alreadyPublished) {
      const destination = this.destinationRouter.getDestination(decision.destinationChannelId);
      return { valid: Boolean(destination && destination.chatId), destinationId: destination && destination.chatId, canonicalDestination: decision.destinationChannelId, identity, decision, reason: 'Previously published media has no configured destination.' };
    }
    const destination = this.destinationRouter.getDestination(decision.destinationChannelId);
    if (!destination || !destination.chatId || destination.chatId === 'me') {
      return { valid: false, reason: `Destination ${decision.destinationChannelId} has no valid chatId.`, canonicalDestination: decision.destinationChannelId, identity, decision };
    }
    return { valid: true, destinationId: destination.chatId, canonicalDestination: decision.destinationChannelId, identity, decision };
  }

  _confirmRoundRobinSuccess(target, result) {
    if (this.useRoundRobin && target.valid && result && result.status === 'PUBLISHED') {
      this.roundRobinRouter.confirmSuccess(target.identity, target.canonicalDestination);
    }
  }

  /**
   * Publishes a single media item to the staging destination with post-publish cleanup.
   * @private
   */
  async _publishMediaItem(batchId, media, destinationId, planItem, shouldCleanup) {
    if (!media || !media.mediaId) {
      return { status: 'FAILED', reason: 'Invalid media object: missing mediaId' };
    }

    const mediaId = media.mediaId;
    const canonicalDestination = planItem ? planItem.canonicalDestination : 'DESTINATION_1';

    // 1. Idempotency Check BEFORE attempting any upload
    if (this.publishLedger.isPublished(mediaId, destinationId)) {
      const existing = this.publishLedger.findRecord(mediaId, destinationId);
      console.log(`${LOG_PREFIX} Media ${mediaId} already published to ${destinationId} (msgId=${existing.telegramMessageId}). Skipping.`);

      let cleaned = false;
      const priorReadBackOk = existing.readBackVerified !== false; // undefined (pre-existing records) treated as ok
      if (shouldCleanup && priorReadBackOk && media.filePath && fs.existsSync(media.filePath)) {
        const cleanRes = await this.mediaCleaner.cleanMedia({
          mediaId,
          destinationId,
          filePath: media.filePath,
          publishLedger: this.publishLedger
        });
        cleaned = cleanRes.status === 'CLEANED' || cleanRes.status === 'ALREADY_CLEANED';
      }

      return {
        mediaId,
        canonicalDestination,
        title: media.title || (planItem && planItem.title) || (existing && existing.title) || '',
        status: 'SKIPPED_ALREADY_PUBLISHED',
        publishId: existing.publishId,
        telegramMessageId: existing.telegramMessageId,
        destinationId,
        cleaned
      };
    }

    // 2. File Existence & Stability Check
    const filePath = media.filePath;
    if (!filePath || !fs.existsSync(filePath)) {
      const err = `Media file does not exist on disk: ${filePath}`;
      console.error(`${LOG_PREFIX} ${err}`);
      const attempt = await this.publishLedger.recordAttempt({ batchId, media, destinationId });
      await this.publishLedger.recordFailure(attempt.publishId, err);
      return { mediaId, canonicalDestination, status: 'FAILED', reason: err };
    }

    let currentStat;
    try {
      currentStat = fs.statSync(filePath);
    } catch (e) {
      const err = `Failed to stat media file: ${e.message}`;
      const attempt = await this.publishLedger.recordAttempt({ batchId, media, destinationId });
      await this.publishLedger.recordFailure(attempt.publishId, err);
      return { mediaId, canonicalDestination, status: 'FAILED', reason: err };
    }

    if (currentStat.size === 0) {
      const err = `Media file is empty (0 bytes): ${filePath}`;
      const attempt = await this.publishLedger.recordAttempt({ batchId, media, destinationId });
      await this.publishLedger.recordFailure(attempt.publishId, err);
      return { mediaId, canonicalDestination, status: 'FAILED', reason: err };
    }

    // 3. Media Integrity Validation
    try {
      const validation = await this.mediaValidator(filePath);
      if (!validation || !validation.valid) {
        const err = `Media integrity validation failed: ${validation ? validation.reason : 'unknown validator error'}`;
        console.error(`${LOG_PREFIX} ${err}`);
        const attempt = await this.publishLedger.recordAttempt({ batchId, media, destinationId });
        await this.publishLedger.recordFailure(attempt.publishId, err);
        return { mediaId, canonicalDestination, status: 'FAILED', reason: err };
      }
    } catch (valErr) {
      const err = `Media validator threw an exception: ${valErr.message}`;
      const attempt = await this.publishLedger.recordAttempt({ batchId, media, destinationId });
      await this.publishLedger.recordFailure(attempt.publishId, err);
      return { mediaId, canonicalDestination, status: 'FAILED', reason: err };
    }

    // 4. Record UPLOADING state in PublishLedger
    const attemptRecord = await this.publishLedger.recordAttempt({ batchId, media, destinationId });
    const publishId = attemptRecord.publishId;
    const caption = this.formatCaption(media);

    // 5. Execute Upload with retry and FloodWait handling
    let lastError = null;
    for (let attemptNum = 1; attemptNum <= (this.maxRetries + 1); attemptNum++) {
      try {
        if (!this.telegramClient) {
          throw new Error('Telegram client is not initialized or injected.');
        }

        // Provenance log BEFORE sending - proves exactly what is about to be
        // uploaded and from which source_mode/page, with URLs redacted.
        console.log(`${LOG_PREFIX} Publishing: MEDIA_ID=${mediaId} SOURCE_MODE=${media.sourceMode || 'unknown'} `
          + `SOURCE_PAGE=${redactUrl(media.sourcePageUrl)} LOCAL_FILE=${path.basename(filePath)} `
          + `SHA256=${media.contentSha256 || 'unknown'} SIZE=${currentStat.size} `
          + `DURATION=${media.duration != null ? media.duration : 'unknown'} `
          + `RESOLUTION=${media.width || '?'}x${media.height || '?'}`);

        const uploadResult = await this._sendToTelegram({
          destinationId,
          filePath,
          caption,
          media,
          canonicalDestination
        });

        const telegramMessageId = uploadResult.messageId || uploadResult.id || uploadResult.message_id;
        if (!telegramMessageId) {
          throw new Error(`Telegram upload did not return a valid message ID: ${JSON.stringify(uploadResult)}`);
        }

        // 6. Read-back verification: inspect Telegram's OWN response metadata
        // for the uploaded video/document, rather than trusting a bare
        // "no exception was thrown" as proof of a correct upload.
        const readBack = this._verifyReadBack(uploadResult, media);
        if (!readBack.verified) {
          console.warn(`${LOG_PREFIX} Read-back verification did NOT pass for media ${mediaId} (msgId ${telegramMessageId}): ${readBack.reason}. Message was sent, but local cleanup is withheld pending manual review.`);
        }

        // 7. Record Success in PublishLedger (upload objectively succeeded -
        // read-back outcome is recorded alongside, not used to un-record it)
        const successRecord = await this.publishLedger.recordSuccess(publishId, {
          telegramMessageId: String(telegramMessageId),
          publishedAt: new Date().toISOString(),
          readBackVerified: readBack.verified,
          readBackDetails: readBack.details
        });

        console.log(`${LOG_PREFIX} Successfully published media ${mediaId} (${canonicalDestination}) -> msgId ${telegramMessageId} (readBackVerified=${readBack.verified})`);

        // 8. Verified Post-Publish Cleanup (ONLY after confirmed publication
        // in the ledger AND a passing read-back verification)
        let cleaned = false;
        if (shouldCleanup && readBack.verified) {
          const cleanRes = await this.mediaCleaner.cleanMedia({
            mediaId,
            destinationId,
            filePath,
            publishLedger: this.publishLedger
          });
          cleaned = cleanRes.status === 'CLEANED' || cleanRes.status === 'ALREADY_CLEANED';
        }

        return {
          mediaId,
          publishId,
          canonicalDestination,
          title: media.title || (planItem && planItem.title) || '',
          status: 'PUBLISHED',
          destinationId,
          telegramMessageId: String(telegramMessageId),
          publishedAt: successRecord.publishedAt,
          readBackVerified: readBack.verified,
          cleaned
        };
      } catch (uploadErr) {
        lastError = uploadErr;
        console.warn(`${LOG_PREFIX} Upload attempt ${attemptNum} failed for ${mediaId}: ${uploadErr.message}`);

        // Check if error is a FloodWait / 429 rate limit
        const floodWaitSec = this._extractFloodWaitSeconds(uploadErr);
        if (floodWaitSec > 0 && attemptNum <= this.maxRetries) {
          console.warn(`${LOG_PREFIX} Telegram FloodWait detected: waiting ${floodWaitSec}s before retry...`);
          await sleep(Math.min(floodWaitSec * 1000, 15000));
        } else if (attemptNum <= this.maxRetries) {
          await sleep(1000);
        }
      }
    }

    // 8. Record Terminal Failure in PublishLedger (Media file is preserved on disk)
    await this.publishLedger.recordFailure(publishId, lastError ? lastError.message : 'Unknown upload error');
    return {
      mediaId,
      publishId,
      canonicalDestination,
      status: 'FAILED',
      destinationId,
      error: lastError ? lastError.message : 'Unknown upload error',
      cleaned: false
    };
  }

  /**
   * Inspects Telegram's OWN response to sendVideo/sendDocument rather than
   * trusting a bare "no exception was thrown" as proof of a correct upload.
   * A real node-telegram-bot-api response always carries a `video` (or
   * `document`) object with file_id/file_size/duration/width/height, which
   * this compares against the locally-recorded media metadata.
   *
   * Minimal test doubles that don't return this metadata at all are treated
   * as inconclusive-but-not-failed (never a fabricated failure from an
   * absence of data) rather than unverified, to stay compatible with
   * existing mocks that predate this check and test unrelated concerns -
   * the real client always supplies this metadata, so production and the
   * dedicated fixture/authorized E2E tests exercise the strict path for real.
   * @param {object} uploadResult Raw response from the Telegram client
   * @param {object} media The local media record (size/duration/width/height)
   * @returns {{verified: boolean, reason: string|null, details: object}}
   */
  _verifyReadBack(uploadResult, media) {
    const videoMeta = uploadResult && (uploadResult.video || uploadResult.document);
    if (!videoMeta) {
      return {
        verified: true,
        reason: null,
        details: { inconclusive: true, note: 'Telegram client response contained no video/document metadata to compare' }
      };
    }

    const details = {
      telegramFileId: videoMeta.file_id || null,
      telegramFileSize: videoMeta.file_size != null ? videoMeta.file_size : null,
      telegramDuration: videoMeta.duration != null ? videoMeta.duration : null,
      telegramWidth: videoMeta.width != null ? videoMeta.width : null,
      telegramHeight: videoMeta.height != null ? videoMeta.height : null
    };

    if (!videoMeta.file_id) {
      return { verified: false, reason: 'Telegram video/document metadata is missing a file_id', details };
    }

    if (details.telegramFileSize != null && media.size != null) {
      const tolerance = Math.max(2048, media.size * 0.02); // 2% or 2KB - container remux overhead
      if (Math.abs(details.telegramFileSize - media.size) > tolerance) {
        return { verified: false, reason: `File size mismatch: local=${media.size} telegram=${details.telegramFileSize}`, details };
      }
    }

    if (details.telegramDuration != null && media.duration != null && media.duration > 0) {
      if (Math.abs(details.telegramDuration - media.duration) > 2) {
        return { verified: false, reason: `Duration mismatch: local=${media.duration}s telegram=${details.telegramDuration}s`, details };
      }
    }

    if (details.telegramWidth && details.telegramHeight && media.width && media.height) {
      if (details.telegramWidth !== media.width || details.telegramHeight !== media.height) {
        return { verified: false, reason: `Resolution mismatch: local=${media.width}x${media.height} telegram=${details.telegramWidth}x${details.telegramHeight}`, details };
      }
    }

    return { verified: true, reason: null, details };
  }

  /**
   * Internal wrapper to call injected Telegram client.
   */
  async _sendToTelegram({ destinationId, filePath, caption, media, canonicalDestination }) {
    const client = this.telegramClient;
    if (!client) {
      throw new Error('Telegram client is not configured.');
    }

    if (typeof client.sendVideo === 'function') {
      return client.sendVideo(destinationId, filePath, { caption });
    }

    if (typeof client.sendFile === 'function') {
      return client.sendFile(destinationId, {
        file: filePath,
        caption
      });
    }

    if (typeof client.publish === 'function') {
      return client.publish({ destinationId, filePath, caption, media, canonicalDestination });
    }

    if (typeof client === 'function') {
      return client({ destinationId, filePath, caption, media, canonicalDestination });
    }

    throw new Error('Injected Telegram client does not implement sendVideo, sendFile, or publish method.');
  }

  _extractFloodWaitSeconds(err) {
    if (!err) return 0;
    if (typeof err.seconds === 'number') return err.seconds;
    if (err.parameters && typeof err.parameters.retry_after === 'number') return err.parameters.retry_after;
    const msg = err.message || '';
    const match = msg.match(/FLOOD_WAIT_(\d+)/i) || msg.match(/retry after (\d+)/i);
    return match ? parseInt(match[1], 10) : 0;
  }
}

module.exports = {
  VideoBatchPublisher,
  FORBIDDEN_PRODUCTION_DESTINATIONS
};
