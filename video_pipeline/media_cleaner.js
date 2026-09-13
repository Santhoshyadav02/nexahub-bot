/**
 * ============================================================
 * 🧹 MEDIA CLEANER (Phase 4C - Post-Publication Verified Cleanup)
 * ============================================================
 * Safely deletes local media files ONLY after verified publication in
 * PublishLedger and updates MediaLedger status to CLEANED.
 *
 * Hard Safety Boundaries:
 *   - Strictly verifies `publishLedger.isPublished(mediaId, destinationId)` before deletion.
 *   - Refuses deletion if publication is unconfirmed or failed.
 *   - Idempotent: safely handles already-deleted files without error.
 *   - Updates MediaLedger status to CLEANED with timestamp upon success.
 *   - File deletion errors (e.g. locks/permissions) do not corrupt ledgers and remain retryable.
 */

const fs = require('fs');
const path = require('path');

const LOG_PREFIX = '[MEDIA_CLEANER]';

/**
 * True only if candidatePath resolves to something strictly INSIDE parentDir.
 * Uses path.relative rather than a bare startsWith() so a sibling directory
 * sharing a name prefix (e.g. "downloads_old" vs "downloads") is never
 * mistaken for being inside the boundary, and ".." escapes are rejected.
 * @param {string} parentDir
 * @param {string} candidatePath
 * @returns {boolean}
 */
function isPathInside(parentDir, candidatePath) {
  if (!parentDir || !candidatePath) return false;
  const rel = path.relative(path.resolve(parentDir), path.resolve(candidatePath));
  if (!rel || path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

class MediaCleaner {
  /**
   * @param {object} [config]
   * @param {object} [config.mediaLedger] Injected MediaLedger instance
   * @param {object} [config.publishLedger] Injected PublishLedger instance
   * @param {string} [config.allowedDirectory] Optional root directory boundary
   */
  constructor(config = {}) {
    this.mediaLedger = config.mediaLedger || null;
    this.publishLedger = config.publishLedger || null;
    this.allowedDirectory = config.allowedDirectory ? path.resolve(config.allowedDirectory) : null;
  }

  /**
   * Cleans a single published media file.
   * @param {object} params
   * @param {string} params.mediaId Required
   * @param {string} params.destinationId Required destination to verify
   * @param {string} params.filePath Required absolute/relative path to MP4
   * @param {object} [params.publishLedger] Override ledger instance
   * @param {object} [params.mediaLedger] Override ledger instance
   * @returns {Promise<object>} Outcome: { status: 'CLEANED' | 'ALREADY_CLEANED' | 'REFUSED_UNCONFIRMED' | 'FAILED', ... }
   */
  async cleanMedia({ mediaId, destinationId, filePath, publishLedger = null, mediaLedger = null }) {
    if (!mediaId || !destinationId || !filePath) {
      return {
        status: 'FAILED',
        mediaId: mediaId || 'unknown',
        reason: 'mediaId, destinationId, and filePath are required for cleanup.'
      };
    }

    const pLedger = publishLedger || this.publishLedger;
    const mLedger = mediaLedger || this.mediaLedger;

    // 1. Mandatory Pre-Condition: Verify Publication in PublishLedger
    if (!pLedger || typeof pLedger.isPublished !== 'function') {
      const reason = 'PublishLedger is required to verify publication status before cleanup.';
      console.error(`${LOG_PREFIX} ${reason}`);
      return { status: 'REFUSED_UNCONFIRMED', mediaId, destinationId, reason };
    }

    const isConfirmed = pLedger.isPublished(mediaId, destinationId);
    if (!isConfirmed) {
      const reason = `Refusing cleanup for media ${mediaId}: publication to destination ${destinationId} is NOT confirmed in PublishLedger.`;
      console.warn(`${LOG_PREFIX} ${reason}`);
      return { status: 'REFUSED_UNCONFIRMED', mediaId, destinationId, reason };
    }

    // 2. Path Safety Validation
    const resolvedPath = path.resolve(filePath);
    if (this.allowedDirectory && !isPathInside(this.allowedDirectory, resolvedPath)) {
      const reason = `Path safety violation: file path "${resolvedPath}" is outside allowed directory "${this.allowedDirectory}".`;
      console.error(`${LOG_PREFIX} ${reason}`);
      return { status: 'FAILED', mediaId, destinationId, reason };
    }

    // 3. Idempotent File Deletion
    const fileExists = fs.existsSync(resolvedPath);
    if (fileExists) {
      try {
        fs.unlinkSync(resolvedPath);
        console.log(`${LOG_PREFIX} Deleted verified media file: ${resolvedPath}`);
      } catch (err) {
        const reason = `Failed to delete media file "${resolvedPath}": ${err.message}`;
        console.error(`${LOG_PREFIX} ${reason}`);
        return { status: 'FAILED', mediaId, destinationId, reason, retryable: true };
      }
    } else {
      console.log(`${LOG_PREFIX} Media file already removed from disk: ${resolvedPath}`);
    }

    // 4. Update MediaLedger
    if (mLedger && typeof mLedger.upsert === 'function') {
      try {
        await mLedger.upsert(mediaId, {
          status: 'CLEANED',
          cleanedAt: new Date().toISOString()
        });
      } catch (err) {
        console.warn(`${LOG_PREFIX} Failed to update MediaLedger for ${mediaId}: ${err.message}`);
      }
    }

    return {
      status: fileExists ? 'CLEANED' : 'ALREADY_CLEANED',
      mediaId,
      destinationId,
      filePath: resolvedPath,
      cleanedAt: new Date().toISOString()
    };
  }

  /**
   * Deletes a local media file that will NEVER be published (e.g. larger than
   * Telegram's upload limit). Unlike cleanMedia() this does not require a
   * confirmed publication, so it is deliberately stricter about WHERE it may
   * delete: an allowedDirectory boundary is mandatory, and the file must be
   * strictly inside it.
   * @param {object} params
   * @param {string} params.mediaId
   * @param {string} params.filePath
   * @param {string} params.reason Human-readable reason, recorded in MediaLedger
   * @param {string} [params.status] MediaLedger status to set (omit to keep the current status)
   * @param {object} [params.mediaLedger] Override ledger instance
   * @returns {Promise<object>} { status: 'DISCARDED' | 'ALREADY_REMOVED' | 'REFUSED_NO_BOUNDARY' | 'FAILED', ... }
   */
  async discardUnpublishableMedia({ mediaId, filePath, reason, status = null, mediaLedger = null }) {
    if (!filePath) {
      return { status: 'FAILED', mediaId: mediaId || 'unknown', reason: 'filePath is required for discard.' };
    }
    if (!this.allowedDirectory) {
      const msg = `Refusing to discard ${filePath}: no allowedDirectory boundary is configured on this MediaCleaner.`;
      console.warn(`${LOG_PREFIX} ${msg}`);
      return { status: 'REFUSED_NO_BOUNDARY', mediaId, reason: msg };
    }
    const resolvedPath = path.resolve(filePath);
    if (!isPathInside(this.allowedDirectory, resolvedPath)) {
      const msg = `Path safety violation: file path "${resolvedPath}" is outside allowed directory "${this.allowedDirectory}".`;
      console.error(`${LOG_PREFIX} ${msg}`);
      return { status: 'FAILED', mediaId, reason: msg };
    }

    const fileExists = fs.existsSync(resolvedPath);
    if (fileExists) {
      try {
        fs.unlinkSync(resolvedPath);
        console.log(`${LOG_PREFIX} Discarded unpublishable media file (${reason}): ${resolvedPath}`);
      } catch (err) {
        const msg = `Failed to discard media file "${resolvedPath}": ${err.message}`;
        console.error(`${LOG_PREFIX} ${msg}`);
        return { status: 'FAILED', mediaId, reason: msg, retryable: true };
      }
    }

    const mLedger = mediaLedger || this.mediaLedger;
    if (mediaId && mLedger && typeof mLedger.upsert === 'function' && typeof mLedger.getRecord === 'function' && mLedger.getRecord(mediaId)) {
      try {
        const patch = { fileDeletedAt: new Date().toISOString(), fileDeletedReason: reason || null };
        if (status) patch.status = status;
        await mLedger.upsert(mediaId, patch);
      } catch (err) {
        console.warn(`${LOG_PREFIX} Failed to update MediaLedger for ${mediaId}: ${err.message}`);
      }
    }

    return { status: fileExists ? 'DISCARDED' : 'ALREADY_REMOVED', mediaId, filePath: resolvedPath };
  }

  /**
   * Cleans a list of published media records.
   * @param {Array<object>} items Array of { mediaId, destinationId, filePath }
   * @param {object} [ledgers] { publishLedger, mediaLedger }
   * @returns {Promise<object>} Summary of cleaned items
   */
  async cleanBatch(items, ledgers = {}) {
    if (!Array.isArray(items)) return { total: 0, cleaned: 0, refused: 0, failed: 0, items: [] };

    const results = [];
    let cleaned = 0;
    let refused = 0;
    let failed = 0;

    for (const item of items) {
      const res = await this.cleanMedia({
        mediaId: item.mediaId,
        destinationId: item.destinationId,
        filePath: item.filePath,
        publishLedger: ledgers.publishLedger || this.publishLedger,
        mediaLedger: ledgers.mediaLedger || this.mediaLedger
      });
      results.push(res);
      if (res.status === 'CLEANED' || res.status === 'ALREADY_CLEANED') {
        cleaned++;
      } else if (res.status === 'REFUSED_UNCONFIRMED') {
        refused++;
      } else {
        failed++;
      }
    }

    return {
      total: items.length,
      cleaned,
      refused,
      failed,
      items: results
    };
  }
}

module.exports = {
  MediaCleaner,
  isPathInside
};
