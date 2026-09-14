/**
 * ============================================================
 * 📒 PUBLISH LEDGER (Phase 4A - Isolated Telegram Staging Publisher State)
 * ============================================================
 * Dedicated persistent ledger tracking all video publishing attempts and
 * results per media item and per destination.
 *
 * Crash-safety model:
 *   - Atomic write via runtime_paths' writeJsonAtomicSync (temp + fsync + rename).
 *   - Unparsable ledger files are quarantined (*.corrupt-<timestamp>), never overwritten.
 *   - Default location: <NEXAHUB_DATA_DIR>/video_pipeline/state/publish_state.json.
 *   - In-process mutex promise-chain lock for serialized mutations.
 *   - Startup crash recovery: resets interrupted UPLOADING records to PENDING.
 *   - Full idempotency index: (mediaId + ":" + destinationId) -> publishId.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { dataPath, writeJsonAtomicSync, quarantineCorruptFile } = require('../runtime_paths');

const PUBLISH_LEDGER_VERSION = '1.0.0';

class PublishLedger {
  /**
   * @param {object} [config]
   * @param {string} [config.ledgerPath] Defaults to <data dir>/video_pipeline/state/publish_state.json
   */
  constructor(config = {}) {
    this.ledgerPath = config.ledgerPath || dataPath('video_pipeline', 'state', 'publish_state.json');
    fs.mkdirSync(path.dirname(this.ledgerPath), { recursive: true });
    this.data = {
      version: PUBLISH_LEDGER_VERSION,
      updatedAt: null,
      records: {},
      destinationIndex: {} // key: `${mediaId}:${destinationId}` -> publishId
    };
    this._lockChain = Promise.resolve();
    this._recovery = { recoveredCount: 0, notes: [] };

    this._cleanupStaleTempFiles();
    this._load();
  }

  _cleanupStaleTempFiles() {
    const dir = path.dirname(this.ledgerPath);
    const base = path.basename(this.ledgerPath);
    // Matches both the legacy "<file>.tmp.<ns>" temp names and runtime_paths'
    // "<file>.<pid>.<ts>.<rand>.tmp" names. Writes are synchronous, so no temp
    // file can belong to an in-flight write while this runs at construction.
    const isStaleTemp = (entry) => {
      if (!entry.startsWith(`${base}.`)) return false;
      const rest = entry.slice(base.length + 1);
      return rest.startsWith('tmp.') || /^\d+\.\d+\.[a-z0-9]+\.tmp$/.test(rest);
    };
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      if (isStaleTemp(entry)) {
        try {
          fs.unlinkSync(path.join(dir, entry));
        } catch (e) {
          // best-effort only
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
      const quarantined = quarantineCorruptFile(this.ledgerPath);
      this._recovery.notes.push(`Existing publish ledger was invalid JSON (${e.message}); `
        + `${quarantined ? `preserved as ${quarantined}; ` : ''}starting fresh.`);
      console.error(`[PUBLISH_LEDGER] ${this.ledgerPath} was not valid JSON; starting fresh.`);
      return;
    }

    this.data = {
      version: parsed.version || PUBLISH_LEDGER_VERSION,
      updatedAt: parsed.updatedAt || null,
      records: parsed.records && typeof parsed.records === 'object' ? parsed.records : {},
      destinationIndex: parsed.destinationIndex && typeof parsed.destinationIndex === 'object' ? parsed.destinationIndex : {}
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
    writeJsonAtomicSync(this.ledgerPath, this.data);
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

  /**
   * Compact view of how far publishing of one media item to one destination
   * has progressed - used to bound cross-cycle publish retries.
   * @returns {{exists: boolean, status: string|null, attempts: number, published: boolean}}
   */
  getAttemptState(mediaId, destinationId) {
    const record = this.findRecord(mediaId, destinationId);
    return {
      exists: Boolean(record),
      status: record ? record.status : null,
      attempts: record ? (record.attemptsCount || 0) : 0,
      published: Boolean(record && record.status === 'PUBLISHED')
    };
  }

  /**
   * Attempt state for one media item across ALL destinations (round-robin
   * publishing sends retries of the same item to different chats).
   * @returns {{exists: boolean, status: string|null, attempts: number, published: boolean, publishedDestinationId: string|null}}
   */
  getMediaAttemptState(mediaId) {
    const records = Object.values(this.data.records).filter(r => r.mediaId === mediaId);
    const publishedRecord = records.find(r => r.status === 'PUBLISHED') || null;
    const latest = records.reduce((acc, r) => (!acc || String(r.attemptedAt || '') > String(acc.attemptedAt || '') ? r : acc), null);
    return {
      exists: records.length > 0,
      status: publishedRecord ? 'PUBLISHED' : (latest ? latest.status : null),
      attempts: records.reduce((sum, r) => sum + (r.attemptsCount || 0), 0),
      published: Boolean(publishedRecord),
      publishedDestinationId: publishedRecord ? publishedRecord.destinationId : null
    };
  }

  listByBatch(batchId) {
    return Object.values(this.data.records).filter(r => r.batchId === batchId);
  }

  listAll() {
    return Object.values(this.data.records);
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
        // Phase 7 verification record fields: LOCAL_SIZE/LOCAL_DURATION/
        // LOCAL_RESOLUTION captured alongside MEDIA_ID/TITLE/LOCAL_SHA256/
        // TELEGRAM_MESSAGE_ID/DESTINATION/READBACK_STATUS so a full,
        // persisted per-item verification record exists - not just a
        // console log line that could be missed.
        size: media.size != null ? media.size : (existing.size != null ? existing.size : null),
        duration: media.duration != null ? media.duration : (existing.duration != null ? existing.duration : null),
        width: media.width != null ? media.width : (existing.width != null ? existing.width : null),
        height: media.height != null ? media.height : (existing.height != null ? existing.height : null),
        codec: media.codec || existing.codec || null,
        sourceMode: media.sourceMode || existing.sourceMode || null,
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

  /**
   * Records a terminal, non-retryable skip (e.g. SKIPPED_TOO_LARGE). Unlike
   * FAILED, a skipped record is never retried by later cycles.
   * @param {string} publishId
   * @param {string} reason
   * @param {string} [status='SKIPPED_TOO_LARGE']
   */
  async recordSkipped(publishId, reason, status = 'SKIPPED_TOO_LARGE') {
    return this._withLock(() => {
      const record = this.data.records[publishId];
      if (!record) {
        throw new Error(`Record ${publishId} not found in PublishLedger`);
      }
      record.status = status;
      record.lastError = reason;
      record.skippedAt = new Date().toISOString();
      this._save();
      return { ...record };
    });
  }
}

module.exports = { PublishLedger, PUBLISH_LEDGER_VERSION };
