/**
 * ============================================================
 * 📥 MEDIA INGESTOR (Phase 2)
 * ============================================================
 * Consumes completed files from video-tools' own downloads/ directory and
 * turns them into validated, deduplicated, persistently-tracked media
 * records - ready for a future Telegram publishing phase to claim.
 *
 * This module does NOT duplicate video-tools' downloader: it never fetches
 * a URL, never writes a .part file, never talks to the source site. It only
 * reads files that video-tools has ALREADY finished writing.
 *
 *   video-tools -> downloads/ -> MediaIngestor -> validation -> dedupe ->
 *   persistent ledger -> READY -> (future) Telegram Publisher
 *
 * State machine (see media_ledger.js for the persisted record shape):
 *   DISCOVERED -> VALIDATING -> READY   (validation passed, content is new)
 *                             -> DUPLICATE (validation passed, content/source already seen)
 *                             -> FAILED    (validation failed, or file vanished)
 *   READY -> CLAIMED   (future publisher reserves it - see claim())
 *   PUBLISHED / CLEANED / ABANDONED / SKIPPED_TOO_LARGE are set by later
 *   phases (publisher, cleaner, batch cycle manager); this module never sets them.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { MediaLedger } = require('./media_ledger');
const { validateMediaFile } = require('./media_validator');

const IGNORED_SUBSTRINGS = ['.part', '.tmp', '.crdownload', '.partial', '.set-aside-'];
const TERMINAL_STATUSES = ['READY', 'CLAIMED', 'FAILED', 'DUPLICATE', 'ABANDONED', 'SKIPPED_TOO_LARGE'];
const DEFAULT_STABILITY_CHECK_MS = 400;
const DEFAULT_SCAN_INTERVAL_MS = 30000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class MediaIngestor {
  /**
   * @param {object} config
   * @param {string} config.downloadsDir Directory to scan for completed *.mp4 files
   * @param {string} [config.downloadReportPath] Defaults to <downloadsDir>/download_report.json
   * @param {string} [config.ledgerPath] Defaults to <data dir>/video_pipeline/state/media_state.json
   * @param {MediaLedger} [config.ledger] Inject an existing ledger instance (tests)
   * @param {number} [config.stabilityCheckMs] Delay used to confirm a file has stopped changing
   */
  constructor(config = {}) {
    if (!config.downloadsDir) {
      throw new Error('MediaIngestor requires a downloadsDir');
    }
    this.downloadsDir = config.downloadsDir;
    this.downloadReportPath = config.downloadReportPath || path.join(this.downloadsDir, 'download_report.json');
    this.stabilityCheckMs = config.stabilityCheckMs || DEFAULT_STABILITY_CHECK_MS;
    this.ledger = config.ledger || new MediaLedger({ ledgerPath: config.ledgerPath });

    this._sourceMapCache = null;
    this._scanLock = Promise.resolve();
    this._timerId = null;
    this._lastScanSummary = null;
  }

  // ============================================================
  // 🔎 FILE DISCOVERY
  // ============================================================

  _listCandidateFiles() {
    let entries;
    try {
      entries = fs.readdirSync(this.downloadsDir, { withFileTypes: true });
    } catch (e) {
      return [];
    }
    return entries
      .filter(e => e.isFile())
      .map(e => e.name)
      .filter(name => !name.startsWith('.'))
      .filter(name => {
        const lower = name.toLowerCase();
        if (!lower.endsWith('.mp4')) return false;
        return !IGNORED_SUBSTRINGS.some(bad => lower.includes(bad));
      })
      .map(name => path.join(this.downloadsDir, name));
  }

  _loadSourceMap() {
    const map = new Map();
    let stat;
    try {
      stat = fs.statSync(this.downloadReportPath);
    } catch (e) {
      return map;
    }
    // download_report.json is rewritten by video-tools after every job, but
    // the ingestor may process many files between rewrites - only re-parse
    // when the file actually changed.
    const cacheKey = `${stat.size}:${stat.mtimeMs}`;
    if (this._sourceMapCache && this._sourceMapCache.key === cacheKey) {
      return this._sourceMapCache.map;
    }
    try {
      const report = JSON.parse(fs.readFileSync(this.downloadReportPath, 'utf8'));
      if (Array.isArray(report)) {
        for (const entry of report) {
          if (entry && entry.file && entry.video_url) {
            map.set(path.resolve(entry.file), entry.video_url);
          }
        }
      }
      this._sourceMapCache = { key: cacheKey, map };
    } catch (e) {
      // Best-effort correlation only; a missing/malformed report never blocks
      // ingestion (and a report caught mid-rewrite is simply re-read next time).
    }
    return map;
  }

  /**
   * Derives a non-sensitive source-identity dedupe key. Never returns or
   * stores the raw (possibly signed/tokenized) video URL itself.
   */
  _computeSourceKeyHash(filePath, sourceMap) {
    const videoUrl = sourceMap.get(path.resolve(filePath));
    if (videoUrl && typeof videoUrl === 'string' && videoUrl.trim()) {
      return crypto.createHash('sha256').update(videoUrl.trim()).digest('hex');
    }
    // Fallback: video-tools names files video_<sha256(url)[:20]>.mp4 - that
    // embedded identity hash is itself already derived from the source URL,
    // so it is a reasonable dedupe key even without a download_report.json.
    const match = path.basename(filePath).match(/^video_([0-9a-f]{20})\.mp4$/i);
    return match ? match[1] : null;
  }

  _hashFile(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  async _isStable(filePath, initialStat) {
    await sleep(this.stabilityCheckMs);
    let stat2;
    try {
      stat2 = fs.statSync(filePath);
    } catch (e) {
      return false;
    }
    return stat2.size === initialStat.size && stat2.mtimeMs === initialStat.mtimeMs;
  }

  // ============================================================
  // ⚙️ SCAN
  // ============================================================

  /**
   * Processes and ingests a single candidate file on-the-fly.
   * Performs stability check, SHA256 hashing, media validation, deduplication, and ledger upsert.
   * @param {string} filePath
   * @param {object} [options]
   * @param {string} [options.title]
   * @returns {Promise<object>} Outcome { filePath, id, status, contentSha256, ... }
   */
  async processSingleFile(filePath, options = {}) {
    const sourceMap = this._loadSourceMap();
    const outcome = await this._processFile(filePath, sourceMap);
    if (outcome.status === 'READY' && options.title) {
      await this.ledger.upsert(outcome.id, { title: options.title });
    }
    return outcome;
  }

  /**
   * Performs exactly one scan pass over downloadsDir. Concurrent calls to
   * scanOnce() are serialized (never interleaved) so repeated/simultaneous
   * scans can never create duplicate records for the same file.
   * @returns {Promise<object>} scan summary
   */
  async scanOnce() {
    const run = this._scanLock.then(() => this._scanOnceInternal());
    this._scanLock = run.catch(() => {});
    return run;
  }

  async _scanOnceInternal() {
    // ready/duplicate/failed/unstable/skipped count only outcomes NEWLY
    // determined during this scan - a file whose status was already decided
    // by an earlier scan (alreadyProcessed=true) is reported in `results`
    // for completeness but never recounted into these tallies, or a
    // long-lived READY file would look "newly ready" on every later scan.
    const summary = { scannedFiles: 0, ready: 0, duplicate: 0, failed: 0, unstable: 0, skipped: 0, results: [] };
    const candidates = this._listCandidateFiles();
    const sourceMap = this._loadSourceMap();

    for (const filePath of candidates) {
      const outcome = await this._processFile(filePath, sourceMap);
      summary.results.push(outcome);
      summary.scannedFiles++;
      if (!outcome.alreadyProcessed) {
        const key = outcome.status.toLowerCase();
        summary[key] = (summary[key] || 0) + 1;
      }
    }

    this._lastScanSummary = summary;
    return summary;
  }

  async _processFile(filePath, sourceMap) {
    const id = crypto.createHash('sha256').update(path.resolve(filePath)).digest('hex');

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (e) {
      return { filePath, id, status: 'SKIPPED', reason: 'File disappeared before processing could start' };
    }

    const existing = this.ledger.getRecord(id);
    if (existing && existing.size === stat.size && existing.mtimeMs === stat.mtimeMs &&
        TERMINAL_STATUSES.includes(existing.status)) {
      // alreadyProcessed=true: this outcome reflects a status determined by
      // a PRIOR scan, not a new determination made just now. Callers that
      // need "what became ready in THIS scan" (e.g. a batch freeze) must
      // filter on that flag rather than status alone, or the same file would
      // be counted as newly ready on every subsequent, unrelated scan.
      return { filePath, id, status: existing.status, alreadyProcessed: true, reason: 'Already processed; unchanged since last scan' };
    }

    const stable = await this._isStable(filePath, stat);
    if (!stable) {
      return { filePath, id, status: 'UNSTABLE', reason: 'File size/mtime changed during stability check; will retry next scan' };
    }

    const discoveredAt = (existing && existing.discoveredAt) ? existing.discoveredAt : new Date().toISOString();
    await this.ledger.upsert(id, {
      filePath: path.resolve(filePath),
      fileName: path.basename(filePath),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      status: 'VALIDATING',
      discoveredAt,
      publishedAt: existing ? existing.publishedAt || null : null,
      cleanedAt: existing ? existing.cleanedAt || null : null,
      lastError: null
    });

    // Re-verify existence right before the expensive work - a file can vanish
    // between discovery and validation (e.g. manual cleanup mid-scan).
    if (!fs.existsSync(filePath)) {
      await this.ledger.upsert(id, { status: 'FAILED', lastError: 'File disappeared during validation' });
      return { filePath, id, status: 'FAILED', reason: 'File disappeared during validation' };
    }

    let contentSha256;
    try {
      contentSha256 = await this._hashFile(filePath);
    } catch (e) {
      await this.ledger.upsert(id, { status: 'FAILED', lastError: `Failed to hash file: ${e.message}` });
      return { filePath, id, status: 'FAILED', reason: `Failed to hash file: ${e.message}` };
    }

    // Async (non-blocking) validation - a full ffmpeg decode can take minutes.
    const validation = await validateMediaFile(filePath);
    if (!validation.valid) {
      await this.ledger.upsert(id, { status: 'FAILED', contentSha256, lastError: validation.error, validation });
      return { filePath, id, status: 'FAILED', reason: validation.error };
    }

    const sourceKeyHash = this._computeSourceKeyHash(filePath, sourceMap);
    const contentDup = this.ledger.getRecordByContentSha256(contentSha256);
    const sourceDup = sourceKeyHash ? this.ledger.getRecordBySourceKeyHash(sourceKeyHash) : null;
    const dup = (contentDup && contentDup.id !== id) ? contentDup : ((sourceDup && sourceDup.id !== id) ? sourceDup : null);

    if (dup) {
      await this.ledger.upsert(id, {
        status: 'DUPLICATE',
        contentSha256,
        sourceKeyHash,
        duplicateOf: dup.id,
        validatedAt: new Date().toISOString(),
        validation
      });
      return { filePath, id, status: 'DUPLICATE', duplicateOf: dup.id };
    }

    await this.ledger.upsert(id, {
      status: 'READY',
      contentSha256,
      sourceKeyHash,
      validatedAt: new Date().toISOString(),
      validation
    });
    return { filePath, id, status: 'READY' };
  }

  // ============================================================
  // 🏷️ CLAIMING (for a future publishing phase - no publishing happens here)
  // ============================================================

  /**
   * Atomically reserves a READY record for a future consumer. Safe against
   * concurrent callers (in-process) and against a crash immediately after a
   * claim (the persisted status, not an in-memory flag, is the source of truth).
   * @param {string} id
   */
  async claim(id) {
    return this.ledger.claim(id);
  }

  /**
   * @returns {Array<object>} lightweight, publish-ready media descriptors
   */
  getReadyMedia() {
    return this.ledger.listByStatus('READY').map(r => ({
      id: r.id,
      fileName: r.fileName,
      filePath: r.filePath,
      size: r.size,
      contentSha256: r.contentSha256,
      validatedAt: r.validatedAt,
      validation: r.validation
    }));
  }

  // ============================================================
  // 🔁 LIFECYCLE
  // ============================================================

  getStatus() {
    return {
      running: this._timerId !== null,
      downloadsDir: this.downloadsDir,
      lastScanSummary: this._lastScanSummary,
      counts: {
        ready: this.ledger.listByStatus('READY').length,
        claimed: this.ledger.listByStatus('CLAIMED').length,
        failed: this.ledger.listByStatus('FAILED').length,
        duplicate: this.ledger.listByStatus('DUPLICATE').length
      }
    };
  }

  /**
   * Starts continuous scanning on an interval. NOT wired to the future
   * 3-hour publish schedule - this is acquisition-side polling only.
   * @param {number} [intervalMs]
   */
  start(intervalMs = DEFAULT_SCAN_INTERVAL_MS) {
    if (this._timerId) {
      return { status: 'ALREADY_RUNNING' };
    }
    this.scanOnce().catch(() => {});
    this._timerId = setInterval(() => {
      this.scanOnce().catch(() => {});
    }, intervalMs);
    return { status: 'STARTED' };
  }

  stop() {
    if (this._timerId) {
      clearInterval(this._timerId);
      this._timerId = null;
    }
    return { status: 'STOPPED' };
  }
}

module.exports = { MediaIngestor };
