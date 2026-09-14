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
    if (this.allowedDirectory && !resolvedPath.startsWith(this.allowedDirectory)) {
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

  /**
   * Sweeps the downloads directory and safely deletes untracked/stale orphan files
   * older than maxAgeMs (default: 3 hours).
   *
   * Safety Invariants:
   *   - Files younger than maxAgeMs are NEVER deleted.
   *   - Files in activeFilePaths (currently downloading/in-flight) are NEVER deleted.
   *   - Files with active pending status (VALIDATING / UPLOADING) in MediaLedger are NEVER deleted.
   *   - Only files inside the configured/allowed downloads directory are deleted.
   *   - Idempotent and fails safe on file errors.
   *
   * @param {object} [options]
   * @param {string} [options.downloadsDir] Target directory to sweep
   * @param {number} [options.maxAgeMs=10800000] Age threshold in milliseconds (default 3 hours)
   * @param {Set<string>|Array<string>} [options.activeFilePaths] Currently in-flight file paths to guard
   * @param {object} [options.mediaLedger] Optional MediaLedger override
   * @returns {Promise<object>} { totalScanned, cleanedCount, freedBytes, skippedCount, cleanedFiles }
   */
  async cleanOrphanFiles(options = {}) {
    const downloadsDir = options.downloadsDir ? path.resolve(options.downloadsDir) : (this.allowedDirectory ? path.resolve(this.allowedDirectory) : null);
    if (!downloadsDir || !fs.existsSync(downloadsDir)) {
      return { totalScanned: 0, cleanedCount: 0, freedBytes: 0, skippedCount: 0, cleanedFiles: [] };
    }

    if (this.allowedDirectory && !downloadsDir.startsWith(this.allowedDirectory)) {
      console.error(`${LOG_PREFIX} cleanOrphanFiles refused: "${downloadsDir}" is outside allowed boundary "${this.allowedDirectory}".`);
      return { totalScanned: 0, cleanedCount: 0, freedBytes: 0, skippedCount: 0, cleanedFiles: [], error: 'Path safety violation' };
    }

    const envMaxAge = Number(process.env.VIDEO_PIPELINE_ORPHAN_CLEANUP_MAX_AGE_MS);
    const maxAgeMs = (options.maxAgeMs && !isNaN(options.maxAgeMs))
      ? options.maxAgeMs
      : (!isNaN(envMaxAge) && envMaxAge > 0 ? envMaxAge : 3 * 60 * 60 * 1000); // 3 hours

    const activeSet = new Set();
    if (options.activeFilePaths) {
      const list = Array.isArray(options.activeFilePaths) ? options.activeFilePaths : Array.from(options.activeFilePaths);
      list.forEach(p => activeSet.add(path.resolve(p)));
    }

    const mLedger = options.mediaLedger || this.mediaLedger;
    let ledgerRecordsByPath = new Map();
    if (mLedger) {
      try {
        let recs = [];
        if (typeof mLedger.listAll === 'function') {
          recs = mLedger.listAll();
        } else if (typeof mLedger.listRecords === 'function') {
          recs = mLedger.listRecords();
        } else if (mLedger.data && mLedger.data.records) {
          recs = Object.values(mLedger.data.records);
        }
        for (const r of recs) {
          if (r && r.filePath) {
            ledgerRecordsByPath.set(path.resolve(r.filePath), r);
          }
        }
      } catch (e) {}
    }

    const now = Date.now();
    const cleanedFiles = [];
    let totalScanned = 0;
    let cleanedCount = 0;
    let freedBytes = 0;
    let skippedCount = 0;

    let entries = [];
    try {
      entries = fs.readdirSync(downloadsDir);
    } catch (err) {
      console.warn(`${LOG_PREFIX} Failed to read directory ${downloadsDir}: ${err.message}`);
      return { totalScanned: 0, cleanedCount: 0, freedBytes: 0, skippedCount: 0, cleanedFiles: [] };
    }

    for (const entry of entries) {
      const isTarget = entry.endsWith('.mp4') || entry.includes('.part.') || entry.includes('.tmp.');
      if (!isTarget) continue;

      const fullPath = path.join(downloadsDir, entry);
      const resolved = path.resolve(fullPath);

      // Guard 1: Active in-flight files
      if (activeSet.has(resolved)) {
        skippedCount++;
        continue;
      }

      let stat;
      try {
        stat = fs.statSync(resolved);
      } catch (e) {
        continue;
      }

      if (stat.isDirectory()) continue;
      totalScanned++;

      const fileAgeMs = now - stat.mtimeMs;
      // Guard 2: Age threshold (must be older than maxAgeMs, e.g. 3 hours)
      if (fileAgeMs < maxAgeMs) {
        skippedCount++;
        continue;
      }

      // Guard 3: If tracked in ledger with an active state (VALIDATING or UPLOADING), skip
      const matchingRecord = ledgerRecordsByPath.get(resolved);
      if (matchingRecord && (matchingRecord.status === 'VALIDATING' || matchingRecord.status === 'UPLOADING')) {
        skippedCount++;
        continue;
      }

      // Safe to delete: older than maxAgeMs, not active
      try {
        const size = stat.size;
        fs.unlinkSync(resolved);
        freedBytes += size;
        cleanedCount++;
        cleanedFiles.push({
          file: entry,
          path: resolved,
          size,
          ageHours: Number((fileAgeMs / (3600 * 1000)).toFixed(2))
        });
        console.log(`${LOG_PREFIX} Deleted stale orphan download (${(fileAgeMs / (3600 * 1000)).toFixed(1)}h old, ${(size / (1024 * 1024)).toFixed(1)} MB): ${entry}`);

        // Update ledger record to CLEANED if present
        if (matchingRecord && mLedger && typeof mLedger.upsert === 'function') {
          try {
            await mLedger.upsert(matchingRecord.id, {
              status: 'CLEANED',
              cleanedAt: new Date().toISOString(),
              cleanReason: 'ORPHAN_TTL_EXPIRED'
            });
          } catch (_) {}
        }
      } catch (err) {
        console.warn(`${LOG_PREFIX} Failed to delete orphan file ${entry}: ${err.message}`);
        skippedCount++;
      }
    }

    if (cleanedCount > 0) {
      console.log(`${LOG_PREFIX} Orphan cleanup complete: removed ${cleanedCount} file(s), freed ${(freedBytes / (1024 * 1024)).toFixed(1)} MB.`);
    }

    return {
      totalScanned,
      cleanedCount,
      freedBytes,
      skippedCount,
      cleanedFiles
    };
  }
}

module.exports = {
  MediaCleaner
};
