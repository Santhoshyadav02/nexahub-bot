/**
 * ============================================================
 * 📤 VIDEO BATCH PUBLISHER (Phase 4A - Isolated Telegram Staging Video Publisher)
 * ============================================================
 * Consumes ONLY a frozen BATCH_READY batch produced by BatchCycleManager and
 * publishes authorized/non-explicit test MP4 files to a configured Telegram
 * STAGING destination.
 *
 * Hard safety boundaries:
 *   - Refuses to run if VIDEO_PIPELINE_STAGING_CHAT_ID is missing or matches
 *     a known production channel.
 *   - Never modifies production routing or production channels.
 *   - Never deletes media files.
 *   - Deterministic captions using frozen media.title only (no re-scraping).
 *   - Strictly sequential publishing (no parallel Telegram uploads).
 *   - Idempotent: skips any mediaId already marked PUBLISHED for this destination.
 */

const fs = require('fs');
const path = require('path');

const { BatchState } = require('./batch_state');
const { PublishLedger } = require('./publish_ledger');
const { validateMediaFile } = require('./media_validator');

const LOG_PREFIX = '[VIDEO_BATCH_PUBLISHER]';
const DEFAULT_RATE_LIMIT_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Known production channel usernames/IDs to strictly forbid as staging destinations
const FORBIDDEN_PRODUCTION_DESTINATIONS = new Set([
  'ccsfvk', 'cccsefk', 'e5brygh', 'ccdjxc', 'r8dne7',
  'q8dne7', 'e9fjr8', 't9ekd7', 'y8ekd7', 'bzd4wrf',
  'romanticvibe', 'dating', 'romance', 'crotch', 'sister snake',
  'has work', 'bullying & sex', 'da ci ge', 'senior year love story',
  'sichuan mother & son', 'hu siyuan', 'kept lover', 'a muse'
]);

class VideoBatchPublisher {
  /**
   * @param {object} config
   * @param {string} [config.stagingChatId] Explicit staging destination ID (e.g. process.env.VIDEO_PIPELINE_STAGING_CHAT_ID)
   * @param {object} [config.telegramClient] Injected Telegram client (must provide sendVideo or sendFile method)
   * @param {BatchState} [config.batchState]
   * @param {PublishLedger} [config.publishLedger]
   * @param {Function} [config.mediaValidator]
   * @param {number} [config.rateLimitDelayMs] Delay between sequential uploads (ms)
   * @param {number} [config.maxRetries=1]
   */
  constructor(config = {}) {
    this.stagingChatId = config.stagingChatId || process.env.VIDEO_PIPELINE_STAGING_CHAT_ID || null;
    this.telegramClient = config.telegramClient || null;
    this.batchState = config.batchState || new BatchState({ statePath: config.batchStatePath });
    this.publishLedger = config.publishLedger || new PublishLedger({ ledgerPath: config.publishLedgerPath });
    this.mediaValidator = config.mediaValidator || validateMediaFile;
    this.rateLimitDelayMs = config.rateLimitDelayMs !== undefined ? config.rateLimitDelayMs : DEFAULT_RATE_LIMIT_DELAY_MS;
    this.maxRetries = config.maxRetries !== undefined ? config.maxRetries : 1;

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
    const title = (media && media.title ? String(media.title).trim() : '');
    if (!title) {
      return '';
    }
    // Limit caption length to Telegram max (1024 chars for media captions)
    if (title.length > 1000) {
      return title.substring(0, 997) + '...';
    }
    return title;
  }

  /**
   * Publishes all eligible media from an explicit BATCH_READY cycle to STAGING.
   * @param {string} batchId Cycle ID to publish
   * @param {object} [options]
   * @param {string} [options.stagingChatIdOverride]
   * @param {boolean} [options.allowAlreadyPublishedBatch=false]
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

    if (batch.status !== 'BATCH_READY' && !(options.allowAlreadyPublishedBatch && batch.status === 'PUBLISHED')) {
      return {
        status: 'REJECTED',
        batchId,
        batchStatus: batch.status,
        reason: `Batch status is "${batch.status}", expected "BATCH_READY".`
      };
    }

    const mediaList = Array.isArray(batch.media) ? batch.media : [];
    console.log(`${LOG_PREFIX} Publishing batch ${batchId} (${mediaList.length} items) to staging destination ${targetChatId}`);

    const results = [];
    let publishedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (let i = 0; i < mediaList.length; i++) {
      const media = mediaList[i];
      const itemResult = await this._publishMediaItem(batchId, media, targetChatId);
      results.push(itemResult);

      if (itemResult.status === 'PUBLISHED') {
        publishedCount++;
      } else if (itemResult.status === 'SKIPPED_ALREADY_PUBLISHED') {
        skippedCount++;
      } else {
        failedCount++;
      }

      // Conservative inter-item pacing delay
      if (i < mediaList.length - 1 && this.rateLimitDelayMs > 0) {
        await sleep(this.rateLimitDelayMs);
      }
    }

    // Determine overall batch outcome
    let finalBatchStatus = 'PUBLISHED';
    if (failedCount > 0 && publishedCount === 0) {
      finalBatchStatus = 'FAILED';
    } else if (failedCount > 0) {
      finalBatchStatus = 'PARTIAL';
    } else if (mediaList.length === 0) {
      finalBatchStatus = 'PUBLISHED_EMPTY';
    }

    const summary = {
      batchId,
      destinationId: targetChatId,
      status: finalBatchStatus,
      totalItems: mediaList.length,
      published: publishedCount,
      skipped: skippedCount,
      failed: failedCount,
      completedAt: new Date().toISOString(),
      items: results
    };

    console.log(`${LOG_PREFIX} Batch ${batchId} publishing complete -> ${finalBatchStatus} `
      + `(total=${mediaList.length}, published=${publishedCount}, skipped=${skippedCount}, failed=${failedCount})`);

    return summary;
  }

  /**
   * Publishes a single media item to the staging destination.
   * @private
   */
  async _publishMediaItem(batchId, media, destinationId) {
    if (!media || !media.mediaId) {
      return { status: 'FAILED', reason: 'Invalid media object: missing mediaId' };
    }

    const mediaId = media.mediaId;

    // 1. Idempotency Check BEFORE attempting any upload
    if (this.publishLedger.isPublished(mediaId, destinationId)) {
      const existing = this.publishLedger.findRecord(mediaId, destinationId);
      console.log(`${LOG_PREFIX} Media ${mediaId} already published to ${destinationId} (msgId=${existing.telegramMessageId}). Skipping.`);
      return {
        mediaId,
        status: 'SKIPPED_ALREADY_PUBLISHED',
        publishId: existing.publishId,
        telegramMessageId: existing.telegramMessageId,
        destinationId
      };
    }

    // 2. File Existence & Stability Check
    const filePath = media.filePath;
    if (!filePath || !fs.existsSync(filePath)) {
      const err = `Media file does not exist on disk: ${filePath}`;
      console.error(`${LOG_PREFIX} ${err}`);
      const attempt = await this.publishLedger.recordAttempt({ batchId, media, destinationId });
      await this.publishLedger.recordFailure(attempt.publishId, err);
      return { mediaId, status: 'FAILED', reason: err };
    }

    let currentStat;
    try {
      currentStat = fs.statSync(filePath);
    } catch (e) {
      const err = `Failed to stat media file: ${e.message}`;
      const attempt = await this.publishLedger.recordAttempt({ batchId, media, destinationId });
      await this.publishLedger.recordFailure(attempt.publishId, err);
      return { mediaId, status: 'FAILED', reason: err };
    }

    if (currentStat.size === 0) {
      const err = `Media file is empty (0 bytes): ${filePath}`;
      const attempt = await this.publishLedger.recordAttempt({ batchId, media, destinationId });
      await this.publishLedger.recordFailure(attempt.publishId, err);
      return { mediaId, status: 'FAILED', reason: err };
    }

    // 3. Media Integrity Validation
    try {
      const validation = await this.mediaValidator(filePath);
      if (!validation || !validation.valid) {
        const err = `Media integrity validation failed: ${validation ? validation.reason : 'unknown validator error'}`;
        console.error(`${LOG_PREFIX} ${err}`);
        const attempt = await this.publishLedger.recordAttempt({ batchId, media, destinationId });
        await this.publishLedger.recordFailure(attempt.publishId, err);
        return { mediaId, status: 'FAILED', reason: err };
      }
    } catch (valErr) {
      const err = `Media validator threw an exception: ${valErr.message}`;
      const attempt = await this.publishLedger.recordAttempt({ batchId, media, destinationId });
      await this.publishLedger.recordFailure(attempt.publishId, err);
      return { mediaId, status: 'FAILED', reason: err };
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
          media
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

        console.log(`${LOG_PREFIX} Successfully published media ${mediaId} -> msgId ${telegramMessageId}`);
        return {
          mediaId,
          publishId,
          status: 'PUBLISHED',
          destinationId,
          telegramMessageId: String(telegramMessageId),
          publishedAt: successRecord.publishedAt
        };
      } catch (uploadErr) {
        lastError = uploadErr;
        console.warn(`${LOG_PREFIX} Upload attempt ${attemptNum} failed for ${mediaId}: ${uploadErr.message}`);

        // Check if error is a FloodWait / 429 rate limit
        const floodWaitSec = this._extractFloodWaitSeconds(uploadErr);
        if (floodWaitSec > 0 && attemptNum <= this.maxRetries) {
          console.warn(`${LOG_PREFIX} Telegram FloodWait detected: waiting ${floodWaitSec}s before retry...`);
          await sleep(Math.min(floodWaitSec * 1000, 15000)); // Cap retry wait to 15s in test
        } else if (attemptNum <= this.maxRetries) {
          await sleep(1000);
        }
      }
    }

    // 7. Record Terminal Failure in PublishLedger
    await this.publishLedger.recordFailure(publishId, lastError ? lastError.message : 'Unknown upload error');
    return {
      mediaId,
      publishId,
      status: 'FAILED',
      destinationId,
      error: lastError ? lastError.message : 'Unknown upload error'
    };
  }

  /**
   * Internal wrapper to call injected Telegram client.
   * Supports both bot API (sendVideo) and MTProto (sendFile) or mock functions.
   */
  async _sendToTelegram({ destinationId, filePath, caption, media }) {
    const client = this.telegramClient;
    if (!client) {
      throw new Error('Telegram client is not configured.');
    }

    if (typeof client.sendVideo === 'function') {
      // Telegram Bot API (node-telegram-bot-api / grammY / telegraf / mock)
      return client.sendVideo(destinationId, filePath, { caption });
    }

    if (typeof client.sendFile === 'function') {
      // MTProto GramJS client
      return client.sendFile(destinationId, {
        file: filePath,
        caption
      });
    }

    if (typeof client.publish === 'function') {
      // Custom publisher adapter
      return client.publish({ destinationId, filePath, caption, media });
    }

    if (typeof client === 'function') {
      // Direct callable function
      return client({ destinationId, filePath, caption, media });
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
