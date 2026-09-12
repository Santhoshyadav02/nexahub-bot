/**
 * ============================================================
 * 📒 MEDIA LEDGER (Phase 2 - Media Ingestor's dedicated persistent state)
 * ============================================================
 * A brand-new, dedicated ledger for the Media Ingestor - completely separate
 * from external_source_state.json and the old AVSEE ledger, per the explicit
 * boundary for this phase. Nothing else reads or writes this file.
 *
 * Crash-safety model:
 *   - Every write serializes the WHOLE ledger to a nanosecond-unique temp
 *     file, then rename()s it over the real file. Rename on the same
 *     filesystem is atomic, so a crash mid-write can only ever leave behind
 *     an orphaned temp file (swept on next startup) - never a corrupt or
 *     half-written media_state.json.
 *   - All mutating operations run through a single in-process promise-chain
 *     lock, so concurrent scanOnce()/claim() calls from the same process can
 *     never interleave a read-modify-write cycle against each other.
 *   - Claiming re-reads status from the in-memory (ledger-backed) record
 *     immediately before writing and only proceeds if it is still READY -
 *     an explicit state-check-then-write, not a bare in-memory flag, so a
 *     restart after a crash mid-claim can never silently double-claim: the
 *     persisted status is the only source of truth.
 */

const fs = require('fs');
const path = require('path');

const LEDGER_VERSION = '1.0.0';

class MediaLedger {
  /**
   * @param {object} [config]
   * @param {string} [config.ledgerPath] Defaults to video_pipeline/media_state.json
   */
  constructor(config = {}) {
    this.ledgerPath = config.ledgerPath || path.join(__dirname, 'media_state.json');
    fs.mkdirSync(path.dirname(this.ledgerPath), { recursive: true });
    this.data = { version: LEDGER_VERSION, updatedAt: null, records: {}, contentIndex: {}, sourceIndex: {} };
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
      this._recovery.notes.push(`Could not read existing ledger: ${e.message}`);
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // The atomic rename pattern should make this unreachable in practice,
      // but never trust a file blindly - start clean rather than crash.
      this._recovery.notes.push(`Existing ledger was not valid JSON (${e.message}); starting a fresh ledger.`);
      return;
    }

    this.data = {
      version: parsed.version || LEDGER_VERSION,
      updatedAt: parsed.updatedAt || null,
      records: parsed.records && typeof parsed.records === 'object' ? parsed.records : {},
      contentIndex: parsed.contentIndex && typeof parsed.contentIndex === 'object' ? parsed.contentIndex : {},
      sourceIndex: parsed.sourceIndex && typeof parsed.sourceIndex === 'object' ? parsed.sourceIndex : {}
    };

    // Crash recovery: a record stuck in VALIDATING means a previous process
    // died mid-validation. Never leave media permanently blocked - decide
    // safely based on whether the file is still there.
    for (const record of Object.values(this.data.records)) {
      if (record.status === 'VALIDATING') {
        if (record.filePath && fs.existsSync(record.filePath)) {
          record.status = 'DISCOVERED';
          record.lastError = 'Recovered from an interrupted validation (previous process did not exit cleanly); will re-validate.';
        } else {
          record.status = 'FAILED';
          record.lastError = 'File disappeared while a previous process was validating it.';
        }
        this._recovery.recoveredCount++;
        this._recovery.notes.push(`Recovered record ${record.id} from VALIDATING -> ${record.status}`);
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
    fs.renameSync(tmpPath, this.ledgerPath);
  }

  /**
   * Serializes all mutating operations through one promise chain so
   * concurrent callers within this process can never interleave a
   * read-modify-write cycle.
   * @param {() => any} fn
   */
  async _withLock(fn) {
    const run = this._lockChain.then(() => fn());
    // Swallow rejections in the chain itself so one failed operation doesn't
    // permanently wedge the lock for subsequent callers.
    this._lockChain = run.catch(() => {});
    return run;
  }

  getRecord(id) {
    return this.data.records[id] || null;
  }

  getRecordByContentSha256(sha) {
    const id = this.data.contentIndex[sha];
    return id ? this.data.records[id] : null;
  }

  getRecordBySourceKeyHash(sourceKeyHash) {
    const id = this.data.sourceIndex[sourceKeyHash];
    return id ? this.data.records[id] : null;
  }

  listByStatus(status) {
    return Object.values(this.data.records).filter(r => r.status === status);
  }

  listAll() {
    return Object.values(this.data.records);
  }

  /**
   * Creates or updates a record and persists atomically. Runs under the lock.
   * @param {string} id
   * @param {object} patch Fields to merge into the record
   */
  async upsert(id, patch) {
    return this._withLock(() => {
      const existing = this.data.records[id] || { id };
      const updated = { ...existing, ...patch, id };
      this.data.records[id] = updated;
      if (updated.contentSha256 && updated.status === 'READY') {
        this.data.contentIndex[updated.contentSha256] = id;
      }
      if (updated.sourceKeyHash && updated.status === 'READY') {
        this.data.sourceIndex[updated.sourceKeyHash] = id;
      }
      this._save();
      return updated;
    });
  }

  /**
   * Atomically transitions a record from READY to CLAIMED. Re-checks status
   * immediately before writing - the persisted status is the only source of
   * truth, so this is safe even if called again after a process restart.
   * @param {string} id
   * @returns {Promise<{status: string, record?: object}>}
   */
  async claim(id) {
    return this._withLock(() => {
      const record = this.data.records[id];
      if (!record) return { status: 'NOT_FOUND' };
      if (record.status !== 'READY') {
        return { status: 'NOT_CLAIMABLE', currentStatus: record.status };
      }
      record.status = 'CLAIMED';
      record.claimedAt = new Date().toISOString();
      this._save();
      return { status: 'CLAIMED', record };
    });
  }
}

module.exports = { MediaLedger, LEDGER_VERSION };
