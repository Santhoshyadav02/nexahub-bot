/**
 * ============================================================
 * 📦 BATCH STATE (Phase 3A - dedicated acquisition-cycle persistence)
 * ============================================================
 * A brand-new, dedicated ledger for acquisition batch cycles - completely
 * separate from external_source_state.json, the old AVSEE ledger, and
 * media_state.json. Nothing else reads or writes this file.
 *
 * Same crash-safety model as media_ledger.js: every write serializes the
 * whole state to a nanosecond-unique temp file, fsyncs it, then rename()s it
 * over the real file - atomic on the same filesystem, so a crash mid-write
 * can only ever leave an orphaned temp file (swept on next startup), never a
 * corrupt or half-written batch_state.json.
 */

const fs = require('fs');
const path = require('path');

const BATCH_STATE_VERSION = '1.0.0';

const BATCH_LIFECYCLE_STATES = [
  'IDLE',
  'ACQUIRING',
  'INGESTING',
  'BATCH_READY',
  'PUBLISHING',
  'COMPLETED',
  'COMPLETED_PARTIAL',
  'COMPLETED_EMPTY',
  'FAILED',
  'STOPPING'
];

class BatchState {
  /**
   * @param {object} [config]
   * @param {string} [config.statePath] Defaults to video_pipeline/batch_state.json
   */
  constructor(config = {}) {
    this.statePath = config.statePath || path.join(__dirname, 'batch_state.json');
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    this.data = {
      version: BATCH_STATE_VERSION,
      updatedAt: null,
      state: 'IDLE',
      currentCycleId: null,
      skippedTicks: [],
      cycles: {}
    };
    this._recovery = { notes: [] };

    this._cleanupStaleTempFiles();
    this._load();
  }

  _cleanupStaleTempFiles() {
    const dir = path.dirname(this.statePath);
    const base = path.basename(this.statePath);
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
    if (!fs.existsSync(this.statePath)) return;
    let raw;
    try {
      raw = fs.readFileSync(this.statePath, 'utf8');
    } catch (e) {
      this._recovery.notes.push(`Could not read existing batch state: ${e.message}`);
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      this._recovery.notes.push(`Existing batch state was not valid JSON (${e.message}); starting fresh.`);
      return;
    }
    this.data = {
      version: parsed.version || BATCH_STATE_VERSION,
      updatedAt: parsed.updatedAt || null,
      state: parsed.state || 'IDLE',
      currentCycleId: parsed.currentCycleId || null,
      skippedTicks: Array.isArray(parsed.skippedTicks) ? parsed.skippedTicks : [],
      cycles: parsed.cycles && typeof parsed.cycles === 'object' ? parsed.cycles : {}
    };
  }

  getRecoveryNotes() {
    return [...this._recovery.notes];
  }

  save() {
    this.data.updatedAt = new Date().toISOString();
    const tmpPath = `${this.statePath}.tmp.${process.hrtime.bigint()}`;
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
        fs.renameSync(tmpPath, this.statePath);
        return;
      } catch (err) {
        if ((err.code === 'EPERM' || err.code === 'EBUSY') && i < 9) {
          const waitMs = (i + 1) * 10;
          const start = Date.now();
          while (Date.now() - start < waitMs) {}
        } else {
          try {
            fs.copyFileSync(tmpPath, this.statePath);
            try { fs.unlinkSync(tmpPath); } catch (_) {}
            return;
          } catch (_) {
            throw err;
          }
        }
      }
    }
  }

  getControllerState() {
    return this.data.state;
  }

  setControllerState(state) {
    this.data.state = state;
    this.save();
  }

  getCurrentCycleId() {
    return this.data.currentCycleId;
  }

  recordSkippedTick(reason) {
    this.data.skippedTicks.push({ at: new Date().toISOString(), reason });
    // Keep this list bounded - it is an audit trail, not an unbounded log.
    if (this.data.skippedTicks.length > 200) {
      this.data.skippedTicks = this.data.skippedTicks.slice(-200);
    }
    this.save();
  }

  getSkippedTicks() {
    return [...this.data.skippedTicks];
  }

  /**
   * Creates a new cycle record and marks it the current cycle.
   * @param {string} cycleId
   * @param {object} [initial]
   */
  startCycle(cycleId, initial = {}) {
    this.data.currentCycleId = cycleId;
    this.data.state = 'ACQUIRING';
    this.data.cycles[cycleId] = {
      cycleId,
      status: 'ACQUIRING',
      startedAt: new Date().toISOString(),
      completedAt: null,
      acquisitionPid: null,
      discovered: 0,
      downloaded: 0,
      ready: 0,
      duplicates: 0,
      failed: 0,
      media: [],
      lastError: null,
      ...initial
    };
    this.save();
  }

  updateCycle(cycleId, patch) {
    const existing = this.data.cycles[cycleId];
    if (!existing) return null;
    this.data.cycles[cycleId] = { ...existing, ...patch };
    this.save();
    return this.data.cycles[cycleId];
  }

  getCycle(cycleId) {
    return this.data.cycles[cycleId] || null;
  }

  listCycles() {
    return Object.values(this.data.cycles).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  }
}

module.exports = { BatchState, BATCH_STATE_VERSION, BATCH_LIFECYCLE_STATES };
