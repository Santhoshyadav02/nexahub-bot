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

const LOG_PREFIX = '[VIDEO_BATCH_PUBLISHER]';
const DEFAULT_RATE_LIMIT_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
    this.stagingChatId = config.stagingChatId || process.env.VIDEO_PIPELINE_STAGING_CHAT_ID || null;
    this.telegramClient = config.telegramClient || null;
    this.batchState = config.batchState || new BatchState({ statePath: config.batchStatePath });
    this.publishLedger = config.publishLedger || new PublishLedger({ ledgerPath: config.publishLedgerPath });
    this.mediaCleaner = config.mediaCleaner || new MediaCleaner({ publishLedger: this.publishLedger });
    this.destinationRouter = config.destinationRouter || new VideoDestinationRouter();
    this.mediaValidator = config.mediaValidator || validateMediaFile;
    this.rateLimitDelayMs = config.rateLimitDelayMs !== undefined ? config.rateLimitDelayMs : DEFAULT_RATE_LIMIT_DELAY_MS;
    this.maxRetries = config.maxRetries !== undefined ? config.maxRetries : 1;
    this.enableCleanup = Boolean(config.enableCleanup);

    this._validateStagingDestination(this.stagingChatId);
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

    const targetChatId = options.chatIdOverride || options.stagingChatIdOverride || this.stagingChatId;
    const destValidation = this._validateStagingDestination(targetChatId);
    if (!destValidation.valid) {
      return {
        status: 'REJECTED',
        mediaId: media.mediaId,
        destinationId: targetChatId,
        reason: destValidation.reason
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
      canonicalDestination: canonicalDest,
      targetDestinationId: targetChatId,
      routingDecision,
      status: 'PENDING',
      attempts: 0
    };

    return this._publishMediaItem(batchId, media, targetChatId, planItem, shouldCleanup);
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
    const targetChatId = options.stagingChatIdOverride || this.stagingChatId;
    const destValidation = this._validateStagingDestination(targetChatId);
    if (!destValidation.valid) {
      console.error(`${LOG_PREFIX} Refused to run: ${destValidation.reason}`);
      return {
        status: 'REJECTED',
        batchId,
        destinationId: targetChatId,
        reason: destValidation.reason
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

    console.log(`${LOG_PREFIX} Publishing batch ${batchId} (${mediaList.length} items) to staging destination ${targetChatId}`);

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
      const itemResult = await this._publishMediaItem(batchId, media, targetChatId, planItem, shouldCleanup);
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
      if (shouldCleanup && media.filePath && fs.existsSync(media.filePath)) {
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

        // 6. Record Success in PublishLedger
        const successRecord = await this.publishLedger.recordSuccess(publishId, {
          telegramMessageId: String(telegramMessageId),
          publishedAt: new Date().toISOString()
        });

        console.log(`${LOG_PREFIX} Successfully published media ${mediaId} (${canonicalDestination}) -> msgId ${telegramMessageId}`);

        // 7. Verified Post-Publish Cleanup (ONLY after confirmed publication in ledger)
        let cleaned = false;
        if (shouldCleanup) {
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
