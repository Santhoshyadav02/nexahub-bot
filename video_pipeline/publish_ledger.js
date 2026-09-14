/**
 * ============================================================
 * 📒 PUBLISH LEDGER (Phase 4A - Isolated Telegram Staging Publisher State)
 * ============================================================
 * Dedicated persistent ledger tracking all video publishing attempts and
 * results per media item and per destination.
 *
 * Crash-safety model:
 *   - Atomic write via nanosecond-unique temp file + fsync + renameSync.
 *   - In-process mutex promise-chain lock for serialized mutations.
 *   - Startup crash recovery: resets interrupted UPLOADING records to PENDING.
 *   - Full idempotency index: (mediaId + ":" + destinationId) -> publishId.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PUBLISH_LEDGER_VERSION = '1.0.0';

class PublishLedger {
  /**
   * @param {object} [config]
   * @param {string} [config.ledgerPath] Defaults to video_pipeline/publish_state.json
   */
  constructor(config = {}) {
    this.ledgerPath = config.ledgerPath || path.join(__dirname, 'publish_state.json');
    fs.mkdirSync(path.dirname(this.ledgerPath), { recursive: true });
    this.data = {
      version: PUBLISH_LEDGER_VERSION,
      updatedAt: null,
      records: {},
      destinationIndex: {}, // key: `${mediaId}:${destinationId}` -> publishId
      // The next round-robin slot and per-media locks live beside the
      // publication records so a restart cannot change a failed item's target.
      roundRobin: { nextDestinationIndex: 0, assignments: {} }
    };
    this._lockChain = Promise.resolve();
    this._recovery = { recoveredCount: 0, notes: [] };

    this._cleanupStaleTempFiles();
    this._load();
  }

  _cleanupStaleTempFiles() {
    const dir = path.dirname(this.ledgerPath);
    const base = path.basename(this.ledgerPath);
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(`${base}.tmp.`)) {
        try {
          fs.unlinkSync(path.join(dir, entry));
        } catch (e) {
          // best-effort
        }
      }
    }
  }

  _load() {
    if (!fs.existsSync(this.ledgerPath)) {
      return;
    }
    let raw;
    try {
      raw = fs.readFileSync(this.ledgerPath, 'utf8');
    } catch (e) {
      this._recovery.notes.push(`Could not read existing publish ledger: ${e.message}`);
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      this._recovery.notes.push(`Existing publish ledger was invalid JSON (${e.message}); starting fresh.`);
      return;
    }

    this.data = {
      version: parsed.version || PUBLISH_LEDGER_VERSION,
      updatedAt: parsed.updatedAt || null,
      records: parsed.records && typeof parsed.records === 'object' ? parsed.records : {},
      destinationIndex: parsed.destinationIndex && typeof parsed.destinationIndex === 'object' ? parsed.destinationIndex : {},
      roundRobin: {
        nextDestinationIndex: Number.isInteger(parsed.roundRobin && parsed.roundRobin.nextDestinationIndex)
          ? ((parsed.roundRobin.nextDestinationIndex % 10) + 10) % 10 : 0,
        assignments: parsed.roundRobin && parsed.roundRobin.assignments && typeof parsed.roundRobin.assignments === 'object'
          ? parsed.roundRobin.assignments : {}
      }
    };

    // Rebuild destinationIndex and recover interrupted UPLOADING state
    for (const [id, rec] of Object.entries(this.data.records)) {
      if (rec.mediaId && rec.destinationId) {
        const key = `${rec.mediaId}:${rec.destinationId}`;
        this.data.destinationIndex[key] = id;
      }
      // Crash recovery: if a record was stuck in UPLOADING, reset to PENDING
      if (rec.status === 'UPLOADING') {
        rec.status = 'PENDING';
        rec.lastError = 'Recovered from interrupted upload (process exited while UPLOADING).';
        this._recovery.recoveredCount++;
        this._recovery.notes.push(`Recovered record ${id} from UPLOADING -> PENDING`);
      }
    }

    if (this._recovery.recoveredCount > 0) {
      this._save();
    }
  }

  getRecoverySummary() {
    return { ...this._recovery };
  }

  _save() {
    this.data.updatedAt = new Date().toISOString();
    const tmpPath = `${this.ledgerPath}.tmp.${process.hrtime.bigint()}`;
    const json = JSON.stringify(this.data, null, 2);
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeSync(fd, json);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    for (let i = 0; i < 10; i++) {
      try {
        fs.renameSync(tmpPath, this.ledgerPath);
        return;
      } catch (err) {
        if ((err.code === 'EPERM' || err.code === 'EBUSY') && i < 9) {
          const waitMs = (i + 1) * 10;
          const start = Date.now();
          while (Date.now() - start < waitMs) {}
        } else {
          try {
            fs.copyFileSync(tmpPath, this.ledgerPath);
            try { fs.unlinkSync(tmpPath); } catch (_) {}
            return;
          } catch (_) {
            throw err;
          }
        }
      }
    }
  }

  async _withLock(fn) {
    const run = this._lockChain.then(() => fn());
    this._lockChain = run.catch(() => {});
    return run;
  }

  getRecord(publishId) {
    return this.data.records[publishId] || null;
  }

  findRecord(mediaId, destinationId) {
    const key = `${mediaId}:${destinationId}`;
    const publishId = this.data.destinationIndex[key];
    return publishId ? this.data.records[publishId] : null;
  }

  isPublished(mediaId, destinationId) {
    const record = this.findRecord(mediaId, destinationId);
    return Boolean(record && record.status === 'PUBLISHED');
  }

  listByBatch(batchId) {
    return Object.values(this.data.records).filter(r => r.batchId === batchId);
  }

  listAll() {
    return Object.values(this.data.records);
  }

  // Compatibility surface for GlobalRoundRobinRouter. These state changes are
  // synchronously persisted by the ledger's atomic writer.
  getNextRoundRobinIndex() { return this.data.roundRobin.nextDestinationIndex; }
  setNextRoundRobinIndex(index) {
    this.data.roundRobin.nextDestinationIndex = ((Number(index) % 10) + 10) % 10;
    this._save();
  }
  advanceRoundRobinIndex() {
    this.data.roundRobin.nextDestinationIndex = (this.data.roundRobin.nextDestinationIndex + 1) % 10;
    this._save();
  }
  lockDestination(identity, destinationKey) {
    this.data.roundRobin.assignments[String(identity)] = String(destinationKey);
    this._save();
  }
  getAssignedDestination(identity) {
    return this.data.roundRobin.assignments[String(identity)] || null;
  }
  isRoundRobinPublished(identity) {
    // Round-robin stores the canonical key (DESTINATION_N), while the publish
    // record deliberately stores the actual Telegram chat ID. Match the media
    // identity across the ledger rather than conflating those two namespaces.
    const mediaId = String(identity).replace(/^video:/, '');
    return Object.values(this.data.records).some(record =>
      record.mediaId === mediaId && record.status === 'PUBLISHED'
    );
  }

  /**
   * Records the beginning of a publish attempt. Transitions to UPLOADING.
   * @param {object} params
   * @param {string} params.batchId
   * @param {object} params.media
   * @param {string} params.destinationId
   * @returns {Promise<object>}
   */
  async recordAttempt({ batchId, media, destinationId }) {
    return this._withLock(() => {
      const key = `${media.mediaId}:${destinationId}`;
      let publishId = this.data.destinationIndex[key];
      if (!publishId) {
        const rand = crypto.randomBytes(4).toString('hex');
        publishId = `pub_${media.mediaId}_${rand}`;
        this.data.destinationIndex[key] = publishId;
      }

      const existing = this.data.records[publishId] || {};
      const now = new Date().toISOString();
      const updated = {
        publishId,
        batchId,
        mediaId: media.mediaId,
        destinationId,
        status: 'UPLOADING',
        telegramMessageId: existing.telegramMessageId || null,
        title: media.title || existing.title || '',
        filePath: media.filePath || existing.filePath || '',
        contentSha256: media.contentSha256 || existing.contentSha256 || null,
        attemptedAt: now,
        publishedAt: existing.publishedAt || null,
        attemptsCount: (existing.attemptsCount || 0) + 1,
        lastError: null
      };

      this.data.records[publishId] = updated;
      this._save();
      return updated;
    });
  }

  /**
   * Records a successful publication with Telegram message ID.
   * @param {string} publishId
   * @param {object} params
   * @param {string|number} params.telegramMessageId
   * @param {string} [params.publishedAt]
   * @param {boolean} [params.readBackVerified] Whether Telegram's own response
   *   metadata (video/document stream present, duration/resolution/size
   *   consistent with the local file) was inspected and matched - not just
   *   that sendVideo returned without throwing.
   * @param {object} [params.readBackDetails] Non-secret diagnostic detail
   *   (reason string, compared field values) for an unverified read-back.
   */
  async recordSuccess(publishId, { telegramMessageId, publishedAt = new Date().toISOString(), readBackVerified = null, readBackDetails = null }) {
    return this._withLock(() => {
      const record = this.data.records[publishId];
      if (!record) {
        throw new Error(`Record ${publishId} not found in PublishLedger`);
      }
      record.status = 'PUBLISHED';
      record.telegramMessageId = String(telegramMessageId);
      record.publishedAt = publishedAt;
      record.lastError = null;
      if (readBackVerified !== null) record.readBackVerified = readBackVerified;
      if (readBackDetails !== null) record.readBackDetails = readBackDetails;
      this._save();
      return { ...record };
    });
  }

  /**
   * Records a failed publication attempt.
   * @param {string} publishId
   * @param {string|Error} error
   */
  async recordFailure(publishId, error) {
    return this._withLock(() => {
      const record = this.data.records[publishId];
      if (!record) {
        throw new Error(`Record ${publishId} not found in PublishLedger`);
      }
      record.status = 'FAILED';
      record.lastError = error instanceof Error ? error.message : String(error);
      this._save();
      return { ...record };
    });
  }
}

module.exports = { PublishLedger, PUBLISH_LEDGER_VERSION };
