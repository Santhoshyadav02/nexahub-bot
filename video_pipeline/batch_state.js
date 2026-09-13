/**
 * ============================================================
 * 📦 BATCH STATE (Phase 3A - dedicated acquisition-cycle persistence)
 * ============================================================
 * A brand-new, dedicated ledger for acquisition batch cycles - completely
 * separate from external_source_state.json, the old AVSEE ledger, and
 * media_state.json. Nothing else reads or writes this file.
 *
 * Same crash-safety model as media_ledger.js: every write goes through
 * runtime_paths' writeJsonAtomicSync (temp file -> fsync -> rename), so a
 * crash mid-write can only ever leave an orphaned temp file (swept on next
 * startup), never a corrupt or half-written batch_state.json. An unparsable
 * file is quarantined (*.corrupt-<timestamp>) rather than overwritten.
 *
 * Bounded growth: only the most recent MAX_CYCLE_HISTORY cycles are kept, and
 * only the most recent FULL_MEDIA_CYCLES keep their full frozen media arrays
 * (cycles still awaiting publication are never pruned or trimmed).
 *
 * Default location: <NEXAHUB_DATA_DIR>/video_pipeline/state/batch_state.json.
 */

const fs = require('fs');
const path = require('path');

const { dataPath, writeJsonAtomicSync, quarantineCorruptFile } = require('../runtime_paths');

const BATCH_STATE_VERSION = '1.0.0';
const MAX_CYCLE_HISTORY = 50;
const FULL_MEDIA_CYCLES = 10;
// Cycles in these states may still be published from their frozen media list.
const UNPRUNABLE_CYCLE_STATUSES = new Set(['BATCH_READY', 'PUBLISHING']);

const BATCH_LIFECYCLE_STATES = [
  'IDLE',
  'ACQUIRING',
  'PROCESSING',
  'STREAMING',
  'INGESTING',
  'BATCH_READY',
  'PUBLISHING',
  'COMPLETED',
  'COMPLETED_PARTIAL',
  'COMPLETED_EMPTY',
  'PARTIAL',
  'INSUFFICIENT_SUCCESS',
  'FAILED',
  'STOPPING',
  'STOPPED'
];

class BatchState {
  /**
   * @param {object} [config]
   * @param {string} [config.statePath] Defaults to <data dir>/video_pipeline/state/batch_state.json
   * @param {number} [config.maxCycleHistory]
   * @param {number} [config.fullMediaCycles]
   */
  constructor(config = {}) {
    this.statePath = config.statePath || dataPath('video_pipeline', 'state', 'batch_state.json');
    this.maxCycleHistory = config.maxCycleHistory || MAX_CYCLE_HISTORY;
    this.fullMediaCycles = config.fullMediaCycles || FULL_MEDIA_CYCLES;
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    this.data = {
      version: BATCH_STATE_VERSION,
      updatedAt: null,
      state: 'IDLE',
      currentCycleId: null,
      lastCycleStartedAt: null,
      lastCycleFinishedAt: null,
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
      const quarantined = quarantineCorruptFile(this.statePath);
      this._recovery.notes.push(`Existing batch state was not valid JSON (${e.message}); `
        + `${quarantined ? `preserved as ${quarantined}; ` : ''}starting fresh.`);
      console.error(`[BATCH_STATE] ${this.statePath} was not valid JSON; starting fresh.`);
      return;
    }
    this.data = {
      version: parsed.version || BATCH_STATE_VERSION,
      updatedAt: parsed.updatedAt || null,
      state: parsed.state || 'IDLE',
      currentCycleId: parsed.currentCycleId || null,
      lastCycleStartedAt: parsed.lastCycleStartedAt || null,
      lastCycleFinishedAt: parsed.lastCycleFinishedAt || null,
      skippedTicks: Array.isArray(parsed.skippedTicks) ? parsed.skippedTicks : [],
      cycles: parsed.cycles && typeof parsed.cycles === 'object' ? parsed.cycles : {}
    };
  }

  getRecoveryNotes() {
    return [...this._recovery.notes];
  }

  save() {
    this.data.updatedAt = new Date().toISOString();
    writeJsonAtomicSync(this.statePath, this.data);
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
    this.data.lastCycleStartedAt = initial.startedAt || new Date().toISOString();
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
    this._pruneHistory();
    this.save();
  }

  /**
   * Records when the most recent cycle finished (any terminal outcome). Used
   * with lastCycleStartedAt to keep the schedule's cadence across restarts.
   * @param {string} [at] ISO timestamp, defaults to now
   */
  recordCycleFinished(at = new Date().toISOString()) {
    this.data.lastCycleFinishedAt = at;
    this.save();
  }

  /**
   * @returns {{lastCycleStartedAt: string|null, lastCycleFinishedAt: string|null}}
   */
  getLastCycleTimes() {
    let startedAt = this.data.lastCycleStartedAt;
    if (!startedAt) {
      // Older state files predate this field - derive it from the history.
      for (const cycle of Object.values(this.data.cycles)) {
        if (cycle && cycle.startedAt && (!startedAt || cycle.startedAt > startedAt)) startedAt = cycle.startedAt;
      }
    }
    return { lastCycleStartedAt: startedAt || null, lastCycleFinishedAt: this.data.lastCycleFinishedAt || null };
  }

  /**
   * Bounds batch_state.json growth: drops cycles beyond maxCycleHistory and
   * replaces the frozen media arrays of all but the newest fullMediaCycles
   * with a count. The current cycle and cycles still awaiting publication
   * (BATCH_READY/PUBLISHING) are always kept intact.
   */
  _pruneHistory() {
    const isProtected = (c) => c.cycleId === this.data.currentCycleId || UNPRUNABLE_CYCLE_STATUSES.has(c.status);
    const ordered = Object.values(this.data.cycles)
      .filter(Boolean)
      .sort((a, b) => (String(a.startedAt || '') < String(b.startedAt || '') ? 1 : -1));

    ordered.forEach((cycle, index) => {
      if (isProtected(cycle)) return;
      if (index >= this.maxCycleHistory) {
        delete this.data.cycles[cycle.cycleId];
        return;
      }
      if (index >= this.fullMediaCycles && Array.isArray(cycle.media) && cycle.media.length > 0) {
        cycle.mediaCount = cycle.media.length;
        cycle.media = [];
        cycle.mediaTrimmed = true;
      }
    });
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

module.exports = { BatchState, BATCH_STATE_VERSION, BATCH_LIFECYCLE_STATES, MAX_CYCLE_HISTORY, FULL_MEDIA_CYCLES };
