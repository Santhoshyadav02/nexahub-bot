/**
 * ============================================================
 * 🧪 DEPLOYMENT HARDENING - FOCUSED TESTS
 * ============================================================
 * Fast, local-only checks for the Linux/PM2 deployment fixes. Needs no
 * network, no browser, no Telegram token and no ffmpeg - child processes are
 * plain `node` scripts and every Telegram client/acquisition is a mock.
 *
 *   B6/M1  manager stops the whole process tree within its bound
 *   B7     missing interpreter -> START_FAILED, never stuck "running"
 *   B8/M2  async validation with hard timeouts; exit-code based decode verdict;
 *          publisher reuses ingest validation instead of re-decoding
 *   H1/H2  runtime fails closed without a source mode; busy fixture port never crashes
 *   H7     DUPLICATE/invalid files deleted, failed publishes retried then abandoned,
 *          orphan sweep by age/size (downloads dir only)
 *   H8     oversized media -> SKIPPED_TOO_LARGE, never uploaded or retried
 *   H10    data-dir defaults, corrupt state quarantined
 *   M3     first scheduled cycle anchored to the persisted last cycle
 *   M4     batch_state history capped
 *   L1/L2/L3 timeout alias, path containment, reboot-aware PID recovery
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const { VideoPipelineManager, buildPythonArgs } = require('./video_pipeline_manager');
const { runProcess, evaluateDecodeResult, validateMediaFile } = require('./media_validator');
const { BatchCycleManager, assessRecordedAcquisition } = require('./batch_cycle_manager');
const { BatchState } = require('./batch_state');
const { MediaLedger } = require('./media_ledger');
const { PublishLedger } = require('./publish_ledger');
const { MediaCleaner, isPathInside } = require('./media_cleaner');
const { VideoBatchPublisher, DEFAULT_MAX_UPLOAD_BYTES } = require('./video_batch_publisher');
const { VideoPipelineRuntime } = require('./video_pipeline_runtime');
const { dataPath } = require('../runtime_paths');

const WORKSPACE = path.join(__dirname, '..', 'scratch', 'deployment_hardening_test_workspace');
const DEST = '-1009990001';

let passed = 0, failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.error(`  ❌ ${label}${detail ? ' - ' + detail : ''}`); failed++; }
}
function section(title) { console.log(`\n--- ${title} ---`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(50);
  }
  return false;
}

function freshDir(name) {
  const dir = path.join(WORKSPACE, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Writes a file whose first box is a valid ISOBMFF ftyp header. */
function writeFakeMp4(filePath, totalBytes = 64) {
  const buf = Buffer.alloc(Math.max(32, totalBytes));
  buf.writeUInt32BE(24, 0);
  buf.write('ftyp', 4, 'latin1');
  buf.write('isom', 8, 'latin1');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buf);
  return filePath;
}

function mediaIdFor(filePath) {
  return crypto.createHash('sha256').update(path.resolve(filePath)).digest('hex');
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function withEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  const restore = () => {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
  let result;
  try {
    result = fn();
  } catch (e) {
    restore();
    throw e;
  }
  if (result && typeof result.then === 'function') {
    return result.finally(restore);
  }
  restore();
  return result;
}

/** Acquisition stand-in that "finishes" instantly. */
function makeInstantManager() {
  const mgr = { starts: 0 };
  mgr.start = () => { mgr.starts++; return { status: 'STARTED', pid: 424242 }; };
  mgr.isRunning = () => false;
  mgr.stop = async () => ({ status: 'NOT_RUNNING' });
  return mgr;
}

// ============================================================
// B7 / B6 / M1 - process lifecycle
// ============================================================

async function testSpawnFailure() {
  section('B7: missing interpreter -> START_FAILED and a later start() still works');
  const dir = freshDir('b7');
  fs.writeFileSync(path.join(dir, 'pipeline.py'), 'setTimeout(() => {}, 5000);\n');
  await withEnv({ PYTHON_PATH: path.join(dir, 'no-such-python-binary') }, async () => {
    const mgr = new VideoPipelineManager({ videoToolsDir: dir, runScriptPath: path.join(dir, 'missing.ps1'), gracefulTimeoutMs: 500, forceTimeoutMs: 2000 });
    const res = mgr.start({});
    check('start() with a missing interpreter returns START_FAILED', res.status === 'START_FAILED', JSON.stringify(res));
    await sleep(300); // the async spawn 'error' event must not crash the process
    check('isRunning() is false after the failed spawn', mgr.isRunning() === false);
    check('the failure is recorded in lastError', Boolean(mgr.getStatus().lastError));

    process.env.PYTHON_PATH = process.execPath;
    const res2 = mgr.start({});
    check('a later start() with a working interpreter is not blocked', res2.status === 'STARTED', JSON.stringify(res2));
    await mgr.stop();
    check('isRunning() is false after stop()', mgr.isRunning() === false);
  });

  const probe = new VideoPipelineManager();
  probe._child = {};
  probe._pid = undefined;
  check('isRunning() is false when a child handle exists but pid is undefined', probe.isRunning() === false);
}

async function testProcessTreeStop() {
  section('B6/M1: stop() terminates the whole process tree within its bound');
  const dir = freshDir('b6');
  const grandchildPidFile = path.join(dir, 'grandchild.pid');
  fs.writeFileSync(path.join(dir, 'pipeline.py'), [
    "const { spawn } = require('child_process');",
    "const fs = require('fs');",
    "const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    `fs.writeFileSync(${JSON.stringify(grandchildPidFile)}, String(gc.pid));`,
    "process.on('SIGTERM', () => {}); // ignore the graceful request -> exercises the forced path",
    'setInterval(() => {}, 1000);',
    ''
  ].join('\n'));

  const defaults = new VideoPipelineManager();
  check('default graceful+force stop budget is <= 6s', defaults.gracefulTimeoutMs + defaults.forceTimeoutMs <= 6000,
    `${defaults.gracefulTimeoutMs}+${defaults.forceTimeoutMs}`);

  let grandchildPid = null;
  await withEnv({ PYTHON_PATH: process.execPath }, async () => {
    const mgr = new VideoPipelineManager({ videoToolsDir: dir, runScriptPath: path.join(dir, 'missing.ps1'), gracefulTimeoutMs: 800, forceTimeoutMs: 3000 });
    try {
      const res = mgr.start({});
      check('fake pipeline started', res.status === 'STARTED', JSON.stringify(res));
      const sawGrandchild = await waitFor(() => fs.existsSync(grandchildPidFile) && fs.readFileSync(grandchildPidFile, 'utf8').length > 0, 8000);
      check('fake pipeline spawned a grandchild (stand-in for Chromium)', sawGrandchild);
      grandchildPid = sawGrandchild ? Number(fs.readFileSync(grandchildPidFile, 'utf8')) : null;

      const t0 = Date.now();
      const stopRes = await mgr.stop();
      const elapsed = Date.now() - t0;
      check('stop() reports a terminal status', ['STOPPED', 'STOPPED_FORCED'].includes(stopRes.status), stopRes.status);
      check('stop() finished within graceful+force bound', elapsed < 800 + 3000 + 500, `${elapsed}ms`);
      check('manager no longer reports running', mgr.isRunning() === false);
      if (grandchildPid) {
        const gone = await waitFor(() => !isAlive(grandchildPid), 3000);
        check('grandchild process was terminated too (no orphan)', gone);
      }
    } finally {
      if (mgr.isRunning()) await mgr.stop();
      if (grandchildPid && isAlive(grandchildPid)) {
        try { process.kill(grandchildPid, 'SIGKILL'); } catch (e) {}
      }
    }
  });
}

// ============================================================
// B8 / M2 - async validation
// ============================================================

async function testAsyncValidation() {
  section('B8: external tooling runs asynchronously with a hard timeout');
  let ticks = 0;
  const ticker = setInterval(() => { ticks++; }, 20);
  const t0 = Date.now();
  const res = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 400 });
  const elapsed = Date.now() - t0;
  clearInterval(ticker);
  check('a hung child is reported as timedOut', res.timedOut === true, JSON.stringify({ ...res, stdout: undefined }));
  check('the timeout is enforced (returns well before the child would finish)', elapsed < 3000, `${elapsed}ms`);
  check('the event loop kept running while the child ran', ticks >= 5, `ticks=${ticks}`);

  const missing = await runProcess('definitely-not-a-real-binary-xyz', ['-version'], { timeoutMs: 2000 });
  check('a missing binary resolves with an error instead of throwing', Boolean(missing.error));

  const dir = freshDir('b8');
  const fake = writeFakeMp4(path.join(dir, 'header_only.mp4'));
  const pending = validateMediaFile(fake);
  check('validateMediaFile() returns a Promise', pending instanceof Promise);
  await pending;

  await withEnv({ FFPROBE_PATH: undefined, FFMPEG_PATH: undefined, PATH: '' }, async () => {
    const noTooling = await validateMediaFile(fake);
    check('missing tooling still fails closed (toolingUnavailable)', noTooling.valid === false && noTooling.toolingUnavailable === true, JSON.stringify(noTooling));
  });

  section('M2: decode verdict is exit-code based; stderr alone is fatal only for clearly-fatal patterns');
  check('exit 0 + no stderr -> pass', evaluateDecodeResult({ code: 0, stderr: '' }).passed === true);
  check('exit 0 + non-fatal decoder warnings -> pass',
    evaluateDecodeResult({ code: 0, stderr: '[h264 @ 0x55] error while decoding MB 12 7, bytestream -5' }).passed === true);
  check('exit 0 + "moov atom not found" -> fail', evaluateDecodeResult({ code: 0, stderr: 'moov atom not found' }).passed === false);
  check('exit 0 + "Invalid data found when processing input" -> fail',
    evaluateDecodeResult({ code: 0, stderr: 'x.mp4: Invalid data found when processing input' }).passed === false);
  check('non-zero exit -> fail', evaluateDecodeResult({ code: 1, stderr: '' }).passed === false);
  check('timeout -> fail', evaluateDecodeResult({ code: null, timedOut: true }).passed === false);
}

async function testPublisherReusesIngestValidation() {
  section('B8: publisher re-validates every upload (fresh technical + provenance + SHA256 handoff checks)');
  const dir = freshDir('b8_publisher');
  const downloads = path.join(dir, 'downloads');
  const file = writeFakeMp4(path.join(downloads, 'validated.mp4'), 2048);
  const sha256Of = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const provenance = (id, filePath) => ({
    sourceMode: 'fixture',
    isFixtureMedia: true,
    sourcePageUrl: `http://127.0.0.1:58923/post/${id}`,
    sourceVideoUrl: `http://127.0.0.1:58923/media/${id}.mp4`,
    contentSha256: sha256Of(filePath)
  });
  let validatorCalls = 0;
  const sent = [];
  const bot = { sendVideo: async (...args) => { sent.push(args); return { message_id: 77 }; } };
  const publisher = new VideoBatchPublisher({
    stagingChatId: DEST,
    telegramClient: bot,
    batchState: new BatchState({ statePath: path.join(dir, 'batch_state.json') }),
    publishLedger: new PublishLedger({ ledgerPath: path.join(dir, 'publish_state.json') }),
    rateLimitDelayMs: 0,
    mediaValidator: async () => { validatorCalls++; return { valid: true }; }
  });

  const r1 = await publisher.publishSingleItem('c1', { mediaId: 'm_validated', title: 'Validated', filePath: file, size: 2048, validatedAt: new Date().toISOString(), ...provenance('m_validated', file) });
  check('media with valid provenance publishes', r1.status === 'PUBLISHED', JSON.stringify(r1));
  check('technical validator runs again even for ingest-validated media', validatorCalls === 1, `calls=${validatorCalls}`);

  const bare = writeFakeMp4(path.join(downloads, 'bare.mp4'), 2048);
  const sentBefore = sent.length;
  const r2 = await publisher.publishSingleItem('c1', { mediaId: 'm_no_provenance', title: 'No provenance', filePath: bare, size: 2048 });
  check('media without provenance fields is blocked', r2.status === 'FAILED' && /provenance/i.test(r2.reason || ''), JSON.stringify(r2));
  check('nothing uploaded for media without provenance', sent.length === sentBefore);

  const changed = writeFakeMp4(path.join(downloads, 'changed.mp4'), 2048);
  const staleRecord = provenance('m_changed', changed);
  fs.appendFileSync(changed, Buffer.from('tampered-after-hash'));
  const r3 = await publisher.publishSingleItem('c1', { mediaId: 'm_changed', title: 'Changed', filePath: changed, size: 2048, ...staleRecord });
  check('file changed after hashing is blocked by the SHA256 handoff check', r3.status === 'FAILED' && /SHA256 mismatch/.test(r3.reason || ''), JSON.stringify(r3));
  check('nothing uploaded for the changed file', sent.length === sentBefore);
}

// ============================================================
// H8 - Telegram upload ceiling
// ============================================================

async function testUploadSizeLimit() {
  section('H8: oversized media -> SKIPPED_TOO_LARGE, never uploaded, not retried, file cleaned');
  const dir = freshDir('h8');
  const downloads = path.join(dir, 'downloads');
  const file = writeFakeMp4(path.join(downloads, 'big.mp4'), 4096);

  const publishLedger = new PublishLedger({ ledgerPath: path.join(dir, 'publish_state.json') });
  const mediaLedger = new MediaLedger({ ledgerPath: path.join(dir, 'media_state.json') });
  await mediaLedger.upsert('m_big', { status: 'READY', filePath: file });
  const cleaner = new MediaCleaner({ mediaLedger, publishLedger, allowedDirectory: downloads });
  const calls = [];
  const bot = { sendVideo: async (...args) => { calls.push(args); return { message_id: 1 }; } };
  let validatorCalls = 0;
  const publisher = new VideoBatchPublisher({
    stagingChatId: DEST,
    telegramClient: bot,
    batchState: new BatchState({ statePath: path.join(dir, 'batch_state.json') }),
    publishLedger,
    mediaCleaner: cleaner,
    enableCleanup: true,
    maxUploadBytes: 1024,
    rateLimitDelayMs: 0,
    mediaValidator: async () => { validatorCalls++; return { valid: true }; }
  });

  const media = { mediaId: 'm_big', title: 'Too Big', filePath: file, size: 4096 };
  const r1 = await publisher.publishSingleItem('cycle_h8', media);
  check('status is SKIPPED_TOO_LARGE', r1.status === 'SKIPPED_TOO_LARGE', JSON.stringify(r1));
  check('sendVideo was never called', calls.length === 0);
  check('no expensive validation was run for an unuploadable file', validatorCalls === 0);
  const record = publishLedger.findRecord('m_big', DEST);
  check('publish ledger records the distinct SKIPPED_TOO_LARGE status', record && record.status === 'SKIPPED_TOO_LARGE', JSON.stringify(record));
  check('isPublished() stays false', publishLedger.isPublished('m_big', DEST) === false);
  check('local file was deleted', !fs.existsSync(file));
  check('media ledger marks the item SKIPPED_TOO_LARGE', mediaLedger.getRecord('m_big').status === 'SKIPPED_TOO_LARGE');

  writeFakeMp4(file, 4096); // same item reappears on disk
  const attemptsBefore = record.attemptsCount;
  const r2 = await publisher.publishSingleItem('cycle_h8_again', media);
  check('a second attempt is short-circuited as SKIPPED_TOO_LARGE', r2.status === 'SKIPPED_TOO_LARGE', JSON.stringify(r2));
  check('no new publish attempt was recorded (not retried)', publishLedger.findRecord('m_big', DEST).attemptsCount === attemptsBefore);
  check('sendVideo still never called', calls.length === 0);

  await withEnv({ VIDEO_PIPELINE_MAX_UPLOAD_BYTES: undefined }, async () => {
    const dflt = new VideoBatchPublisher({ stagingChatId: DEST, batchState: new BatchState({ statePath: path.join(dir, 'b2.json') }), publishLedger });
    check('default upload ceiling is 50 MB', dflt.maxUploadBytes === 50 * 1024 * 1024 && DEFAULT_MAX_UPLOAD_BYTES === 50 * 1024 * 1024);
  });
  await withEnv({ VIDEO_PIPELINE_MAX_UPLOAD_BYTES: '2048' }, async () => {
    const fromEnv = new VideoBatchPublisher({ stagingChatId: DEST, batchState: new BatchState({ statePath: path.join(dir, 'b3.json') }), publishLedger });
    check('VIDEO_PIPELINE_MAX_UPLOAD_BYTES overrides the ceiling', fromEnv.maxUploadBytes === 2048);
  });
}

// ============================================================
// H7 - cycle disk hygiene and bounded publish retries
// ============================================================

async function testCycleDiskHygiene() {
  section('H7: rejected files deleted, failed publishes retried up to the max, then abandoned');
  const dir = freshDir('h7');
  const downloads = path.join(dir, 'downloads');
  const output = path.join(dir, 'output');
  fs.mkdirSync(output, { recursive: true });

  const mediaLedger = new MediaLedger({ ledgerPath: path.join(dir, 'media_state.json') });
  const publishLedger = new PublishLedger({ ledgerPath: path.join(dir, 'publish_state.json') });

  const dupFile = writeFakeMp4(path.join(downloads, 'dup.mp4'));
  const badFile = writeFakeMp4(path.join(downloads, 'bad.mp4'));
  const toolingFile = writeFakeMp4(path.join(downloads, 'tooling.mp4'));
  const readyFile = writeFakeMp4(path.join(downloads, 'ready.mp4'));
  const orphanFile = writeFakeMp4(path.join(downloads, 'orphan_old.mp4'));
  const outsideFile = writeFakeMp4(path.join(dir, 'outside_old.mp4'));
  const reportFile = path.join(downloads, 'download_report.json');
  fs.writeFileSync(reportFile, '[]');
  const old = new Date(Date.now() - 72 * 3600 * 1000);
  for (const f of [orphanFile, outsideFile, reportFile]) fs.utimesSync(f, old, old);

  const verdicts = { 'dup.mp4': 'DUPLICATE', 'bad.mp4': 'FAILED', 'tooling.mp4': 'FAILED_TOOLING' };
  const fakeIngestor = {
    ledger: mediaLedger,
    async processSingleFile(absPath) {
      const id = mediaIdFor(absPath);
      const existing = mediaLedger.getRecord(id);
      if (existing && ['READY', 'FAILED', 'DUPLICATE', 'ABANDONED'].includes(existing.status)) {
        return { filePath: absPath, id, status: existing.status, alreadyProcessed: true };
      }
      const verdict = verdicts[path.basename(absPath)];
      if (verdict === 'DUPLICATE') {
        await mediaLedger.upsert(id, { filePath: absPath, status: 'DUPLICATE', duplicateOf: 'original' });
        return { filePath: absPath, id, status: 'DUPLICATE', duplicateOf: 'original' };
      }
      if (verdict === 'FAILED') {
        await mediaLedger.upsert(id, { filePath: absPath, status: 'FAILED', validation: { valid: false, error: 'moov atom not found' } });
        return { filePath: absPath, id, status: 'FAILED' };
      }
      if (verdict === 'FAILED_TOOLING') {
        await mediaLedger.upsert(id, { filePath: absPath, status: 'FAILED', validation: { valid: false, toolingUnavailable: true, error: 'ffprobe missing' } });
        return { filePath: absPath, id, status: 'FAILED' };
      }
      await mediaLedger.upsert(id, { filePath: absPath, status: 'READY', size: fs.statSync(absPath).size, validatedAt: new Date().toISOString(), validation: { valid: true } });
      return { filePath: absPath, id, status: 'READY' };
    }
  };

  const publishCalls = [];
  const failingPublisher = {
    stagingChatId: DEST,
    publishLedger,
    async publishSingleItem(cycleId, media) {
      publishCalls.push(media.mediaId);
      const attempt = await publishLedger.recordAttempt({ batchId: cycleId, media, destinationId: DEST });
      await publishLedger.recordFailure(attempt.publishId, 'simulated Telegram outage');
      return { status: 'FAILED', mediaId: media.mediaId };
    }
  };

  const mgr = new BatchCycleManager({
    acquisitionUrl: 'http://127.0.0.1:1/unused',
    outputDir: output,
    downloadsDir: downloads,
    batchStatePath: path.join(dir, 'batch_state.json'),
    videoPipelineManager: makeInstantManager(),
    mediaIngestor: fakeIngestor,
    videoBatchPublisher: failingPublisher,
    autoPublish: true,
    enableCleanup: true,
    maxPublishAttempts: 3,
    downloadRetentionHours: 48,
    downloadMaxBytes: 0
  });

  const s1 = await mgr.runOnce();
  check('cycle 1 completed without throwing', Boolean(s1 && s1.cycleId), JSON.stringify(s1));
  check('DUPLICATE file deleted', !fs.existsSync(dupFile));
  check('file with a definitive validation failure deleted', !fs.existsSync(badFile));
  check('file that failed only because tooling was missing is KEPT', fs.existsSync(toolingFile));
  check('READY file whose publish failed is KEPT for retry', fs.existsSync(readyFile));
  check('orphan file older than retention swept', !fs.existsSync(orphanFile));
  check('download_report.json never swept', fs.existsSync(reportFile));
  check('file outside the downloads dir untouched', fs.existsSync(outsideFile));
  check('ledger records why the duplicate was deleted', Boolean(mediaLedger.getRecord(mediaIdFor(dupFile)).fileDeletedAt));
  check('cycle 1 attempted publish once', publishCalls.length === 1, `calls=${publishCalls.length}`);

  await mgr.runOnce();
  check('cycle 2 retried the failed publish', publishCalls.length === 2, `calls=${publishCalls.length}`);
  await mgr.runOnce();
  check('cycle 3 retried again (attempt 3 of 3)', publishCalls.length === 3, `calls=${publishCalls.length}`);
  const s4 = await mgr.runOnce();
  check('cycle 4 did NOT retry beyond VIDEO_PIPELINE_MAX_PUBLISH_ATTEMPTS', publishCalls.length === 3, `calls=${publishCalls.length}`);
  check('abandoned file deleted', !fs.existsSync(readyFile));
  check('abandoned media marked ABANDONED in the ledger', mediaLedger.getRecord(mediaIdFor(readyFile)).status === 'ABANDONED');
  check('cycle 4 still completed', Boolean(s4 && s4.cycleId));

  await withEnv({ VIDEO_PIPELINE_MAX_PUBLISH_ATTEMPTS: '5' }, async () => {
    const envMgr = new BatchCycleManager({
      acquisitionUrl: 'http://127.0.0.1:1/unused', outputDir: output, downloadsDir: downloads,
      batchStatePath: path.join(dir, 'batch_state_env.json'), videoPipelineManager: makeInstantManager(), mediaIngestor: fakeIngestor
    });
    check('VIDEO_PIPELINE_MAX_PUBLISH_ATTEMPTS is honored', envMgr.maxPublishAttempts === 5);
  });
}

async function testSweepRules() {
  section('H7: age/size sweep keeps pending media and never runs without cleanup enabled');
  const dir = freshDir('h7_sweep');
  const downloads = path.join(dir, 'downloads');
  const output = path.join(dir, 'output');
  fs.mkdirSync(output, { recursive: true });
  const mediaLedger = new MediaLedger({ ledgerPath: path.join(dir, 'media_state.json') });

  const old = new Date(Date.now() - 72 * 3600 * 1000);
  const pendingFile = writeFakeMp4(path.join(downloads, 'pending.mp4'), 1000);
  const staleTemp = writeFakeMp4(path.join(downloads, 'video_x.mp4.part.123456.tmp'), 1000);
  const seenState = path.join(downloads, 'download_seen.json');
  fs.writeFileSync(seenState, '[]');
  for (const f of [pendingFile, staleTemp, seenState]) fs.utimesSync(f, old, old);
  await mediaLedger.upsert(mediaIdFor(pendingFile), { filePath: pendingFile, status: 'READY' });

  const recentA = writeFakeMp4(path.join(downloads, 'recent_a.mp4'), 3000);
  const recentB = writeFakeMp4(path.join(downloads, 'recent_b.mp4'), 3000);
  const olderTime = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(recentA, olderTime, olderTime);

  const common = {
    acquisitionUrl: 'http://127.0.0.1:1/unused', outputDir: output, downloadsDir: downloads,
    videoPipelineManager: makeInstantManager(), mediaIngestor: { ledger: mediaLedger, processSingleFile: async () => ({ status: 'SKIPPED' }) }
  };

  const disabled = new BatchCycleManager({ ...common, batchStatePath: path.join(dir, 'bs0.json'), enableCleanup: false });
  const none = await disabled._sweepDownloadsDir();
  check('sweep is a no-op when cleanup is disabled', none.deleted === 0 && fs.existsSync(staleTemp));

  const mgr = new BatchCycleManager({ ...common, batchStatePath: path.join(dir, 'bs1.json'), enableCleanup: true, downloadRetentionHours: 48, downloadMaxBytes: 5000 });
  const res = await mgr._sweepDownloadsDir();
  check('old READY media still awaiting publication is kept', fs.existsSync(pendingFile));
  check('stale video-tools temp file removed', !fs.existsSync(staleTemp));
  check('bookkeeping file (download_seen.json) never removed', fs.existsSync(seenState));
  check('size cap evicted the oldest non-pending file first', !fs.existsSync(recentA) && fs.existsSync(recentB), JSON.stringify(res));
}

// ============================================================
// H1 / H2 / H10 - runtime configuration
// ============================================================

async function testRuntimeSourceModeFailClosed() {
  section('H1: enabled runtime with no explicit source mode fails closed');
  const dir = freshDir('h1');
  await withEnv({ VIDEO_PIPELINE_SOURCE_MODE: undefined }, async () => {
    const rt = new VideoPipelineRuntime({
      enabled: true, autoPublish: false,
      outputDir: path.join(dir, 'output'), downloadsDir: path.join(dir, 'downloads'), stateDir: path.join(dir, 'state')
    });
    const res = rt.start();
    check('start() returns CONFIG_ERROR', res.status === 'CONFIG_ERROR', JSON.stringify(res));
    check('error names VIDEO_PIPELINE_SOURCE_MODE', /VIDEO_PIPELINE_SOURCE_MODE is not configured/.test(res.error || ''));
    check('runtime not started and no cycle manager/fixture server built', !rt.isStarted() && rt.batchCycleManager === null && rt._fixtureServer === null);
    const once = await rt.runOnce();
    check('runOnce() also refuses with CONFIG_ERROR', once.status === 'CONFIG_ERROR');
    check('status reports sourceMode=null and CONFIG_ERROR', rt.getStatus().sourceMode === null && rt.getStatus().state === 'CONFIG_ERROR');
  });
  await withEnv({ VIDEO_PIPELINE_SOURCE_MODE: 'fixture' }, async () => {
    const rt = new VideoPipelineRuntime({ enabled: true, autoPublish: false, stateDir: path.join(dir, 'state2') });
    check('VIDEO_PIPELINE_SOURCE_MODE=fixture (explicit env) is accepted', rt.getStatus().configValid === true, rt.getStatus().lastConfigError);
  });
  await withEnv({ VIDEO_PIPELINE_SOURCE_MODE: undefined }, async () => {
    const rt = new VideoPipelineRuntime({ enabled: true, sourceMode: 'fixture', autoPublish: false, stateDir: path.join(dir, 'state3') });
    check('explicit config sourceMode "fixture" is accepted', rt.getStatus().configValid === true, rt.getStatus().lastConfigError);
  });
}

async function testFixturePortInUse() {
  section('H2: busy fixture port never crashes the process');
  const dir = freshDir('h2');
  const blocker = http.createServer();
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  const busyPort = blocker.address().port;
  let uncaught = null;
  const onUncaught = (err) => { uncaught = err; };
  process.on('uncaughtException', onUncaught);
  try {
    await withEnv({ VIDEO_PIPELINE_FIXTURE_PORT: String(busyPort), VIDEO_PIPELINE_RUN_ON_STARTUP: undefined }, async () => {
      const rt = new VideoPipelineRuntime({
        enabled: true, sourceMode: 'fixture', autoPublish: false,
        outputDir: path.join(dir, 'output'), downloadsDir: path.join(dir, 'downloads'), stateDir: path.join(dir, 'state')
      });
      const res = rt.start();
      check('start() succeeds even though the fixture port is taken', res.status === 'STARTED', JSON.stringify(res));
      const ok = await rt._fixtureReady;
      await sleep(100);
      check('no uncaught exception was raised', uncaught === null, uncaught && uncaught.message);
      check('fixture server recovered on another port', ok === true);
      const url = rt.batchCycleManager.acquisitionUrl;
      check('cycle manager points at the recovered port, not the busy one', /^http:\/\/127\.0\.0\.1:\d+\/$/.test(url) && !url.includes(`:${busyPort}/`), url);
      const stopRes = await rt.stop();
      check('stop() succeeds', stopRes.status === 'STOPPED', JSON.stringify(stopRes));
    });
  } finally {
    process.removeListener('uncaughtException', onUncaught);
    await new Promise(resolve => blocker.close(resolve));
  }
}

async function testDataDirDefaultsAndQuarantine() {
  section('H10: data-dir defaults, explicit overrides preserved, corrupt state quarantined');
  await withEnv({ VIDEO_PIPELINE_STATE_DIR: undefined, VIDEO_PIPELINE_DOWNLOADS_DIR: undefined, VIDEO_PIPELINE_OUTPUT_DIR: undefined }, async () => {
    const rt = new VideoPipelineRuntime({ enabled: false });
    check('default stateDir is <data dir>/video_pipeline/state', rt.stateDir === dataPath('video_pipeline', 'state'), rt.stateDir);
    check('default downloadsDir is <data dir>/video_pipeline/downloads', rt.downloadsDir === dataPath('video_pipeline', 'downloads'), rt.downloadsDir);
    check('default outputDir is <data dir>/video_pipeline/output', rt.outputDir === dataPath('video_pipeline', 'output'), rt.outputDir);
  });
  const dir = freshDir('h10');
  await withEnv({ VIDEO_PIPELINE_STATE_DIR: path.join(dir, 'env_state') }, async () => {
    const rt = new VideoPipelineRuntime({ enabled: false, downloadsDir: path.join(dir, 'cfg_downloads') });
    check('env VIDEO_PIPELINE_STATE_DIR override preserved', rt.stateDir === path.join(dir, 'env_state'));
    check('config downloadsDir override preserved', rt.downloadsDir === path.join(dir, 'cfg_downloads'));
  });

  const cases = [
    ['batch_state.json', p => new BatchState({ statePath: p }), inst => inst.setControllerState('IDLE')],
    ['publish_state.json', p => new PublishLedger({ ledgerPath: p }), inst => inst.recordAttempt({ batchId: 'b', media: { mediaId: 'm' }, destinationId: DEST })],
    ['media_state.json', p => new MediaLedger({ ledgerPath: p }), inst => inst.upsert('m', { status: 'READY' })]
  ];
  for (const [name, construct, write] of cases) {
    const statePath = path.join(dir, name);
    fs.writeFileSync(statePath, '{ this is : not json ][');
    let instance = null;
    let threw = false;
    try { instance = construct(statePath); } catch (e) { threw = true; }
    check(`${name}: corrupt file does not crash construction`, !threw && instance !== null);
    const quarantined = fs.readdirSync(dir).filter(f => f.startsWith(`${name}.corrupt-`));
    check(`${name}: corrupt file preserved as ${name}.corrupt-*`, quarantined.length === 1, JSON.stringify(quarantined));
    check(`${name}: quarantined copy still holds the original bytes`, quarantined.length === 1 && fs.readFileSync(path.join(dir, quarantined[0]), 'utf8').startsWith('{ this is'));
    await write(instance);
    let valid = false;
    try { JSON.parse(fs.readFileSync(statePath, 'utf8')); valid = true; } catch (e) {}
    check(`${name}: fresh state written atomically as valid JSON`, valid);
    const temps = fs.readdirSync(dir).filter(f => f.startsWith(`${name}.`) && f.endsWith('.tmp'));
    check(`${name}: no temp files left behind`, temps.length === 0, JSON.stringify(temps));
  }
}

// ============================================================
// M3 / M4 - schedule anchoring and bounded history
// ============================================================

async function testScheduleAnchoring() {
  section('M3: first cycle anchored to the persisted last cycle start');
  const dir = freshDir('m3');
  const output = path.join(dir, 'output');
  const downloads = path.join(dir, 'downloads');
  fs.mkdirSync(output, { recursive: true });
  fs.mkdirSync(downloads, { recursive: true });
  const statePath = path.join(dir, 'batch_state.json');
  const HOUR = 3600 * 1000;
  const INTERVAL = 3 * HOUR;
  const emptyIngestor = { ledger: new MediaLedger({ ledgerPath: path.join(dir, 'media_state.json') }), processSingleFile: async () => ({ status: 'SKIPPED' }) };

  const bs = new BatchState({ statePath });
  const mgr = new BatchCycleManager({
    acquisitionUrl: 'http://127.0.0.1:1/unused', outputDir: output, downloadsDir: downloads,
    batchState: bs, videoPipelineManager: makeInstantManager(), mediaIngestor: emptyIngestor, startupDelayMs: 60000
  });
  const now = Date.now();
  check('no history -> first cycle after the startup delay', mgr.computeFirstRunDelayMs(INTERVAL, now) === 60000);
  bs.data.lastCycleStartedAt = new Date(now - 30 * 60 * 1000).toISOString();
  check('last cycle 30 min ago -> next in ~2.5h (clock not reset by restart)', Math.abs(mgr.computeFirstRunDelayMs(INTERVAL, now) - 2.5 * HOUR) < 1000);
  bs.data.lastCycleStartedAt = new Date(now - 5 * HOUR).toISOString();
  check('overdue -> startup delay, not immediately', mgr.computeFirstRunDelayMs(INTERVAL, now) === 60000);
  bs.data.lastCycleStartedAt = new Date(now + 10 * HOUR).toISOString();
  check('clock skew into the future -> never more than one interval', mgr.computeFirstRunDelayMs(INTERVAL, now) === INTERVAL);

  const started = new Date(now - 1234).toISOString();
  bs.startCycle('cycle_persisted', { startedAt: started });
  bs.recordCycleFinished(new Date(now).toISOString());
  const reloaded = new BatchState({ statePath });
  const times = reloaded.getLastCycleTimes();
  check('last cycle start/finish persist across a restart', times.lastCycleStartedAt === started && Boolean(times.lastCycleFinishedAt), JSON.stringify(times));

  const schedDir = freshDir('m3_sched');
  const schedState = new BatchState({ statePath: path.join(schedDir, 'batch_state.json') });
  schedState.data.lastCycleStartedAt = new Date(Date.now() - (2000 - 300)).toISOString();
  const acq = makeInstantManager();
  const sched = new BatchCycleManager({
    acquisitionUrl: 'http://127.0.0.1:1/unused', outputDir: output, downloadsDir: downloads,
    batchState: schedState, videoPipelineManager: acq, mediaIngestor: emptyIngestor, startupDelayMs: 0
  });
  const startRes = sched.start(2000);
  check('scheduler reports its first-run delay', startRes.status === 'STARTED' && startRes.firstRunInMs <= 400, JSON.stringify(startRes));
  check('scheduler is active before the first tick', sched.isSchedulerActive() === true);
  const ran = await waitFor(() => acq.starts >= 1, 1500);
  check('first cycle ran at the anchored time (~300ms), not a full interval later', ran);
  await sched.stop();
  check('stop() clears the pending schedule', sched.isSchedulerActive() === false);

  const acq2 = makeInstantManager();
  const immediate = new BatchCycleManager({
    acquisitionUrl: 'http://127.0.0.1:1/unused', outputDir: output, downloadsDir: downloads,
    batchState: new BatchState({ statePath: path.join(schedDir, 'bs_immediate.json') }), videoPipelineManager: acq2, mediaIngestor: emptyIngestor
  });
  const immRes = immediate.start(INTERVAL, { runImmediately: true });
  check('runImmediately (VIDEO_PIPELINE_RUN_ON_STARTUP) still runs a cycle right away', immRes.firstRunInMs === 0 && acq2.starts === 1);
  await immediate.stop();
}

async function testHistoryCap() {
  section('M4: batch_state history is capped and old media arrays trimmed');
  const dir = freshDir('m4');
  const bs = new BatchState({ statePath: path.join(dir, 'batch_state.json') });
  const base = Date.now() - 100000;
  for (let i = 0; i < 60; i++) {
    const id = `cycle_${String(i).padStart(2, '0')}`;
    bs.startCycle(id, { startedAt: new Date(base + i * 1000).toISOString(), media: [{ mediaId: `m${i}` }] });
    bs.updateCycle(id, { status: i === 0 ? 'BATCH_READY' : 'COMPLETED' });
  }
  const count = Object.keys(bs.data.cycles).length;
  check('cycle history bounded (<= 50 + unpublished)', count <= 51, `count=${count}`);
  check('oldest COMPLETED cycles dropped', !bs.getCycle('cycle_05'));
  check('an old BATCH_READY cycle awaiting publication is never pruned or trimmed', Boolean(bs.getCycle('cycle_00')) && bs.getCycle('cycle_00').media.length === 1);
  check('recent cycles keep their full media array', bs.getCycle('cycle_59').media.length === 1 && bs.getCycle('cycle_51').media.length === 1);
  const trimmed = bs.getCycle('cycle_30');
  check('older cycles keep only a media count', trimmed && trimmed.mediaTrimmed === true && trimmed.media.length === 0 && trimmed.mediaCount === 1, JSON.stringify(trimmed));
}

// ============================================================
// L1 / L2 / L3
// ============================================================

async function testSmallFixes() {
  section('L1: acquisition timeout reaches pipeline.py under either option name');
  const withAlias = buildPythonArgs('pipeline.py', { timeout: 30 });
  check('`timeout` alias -> --timeout 30', withAlias.join(' ').includes('--timeout 30'), withAlias.join(' '));
  const canonical = buildPythonArgs('pipeline.py', { timeoutSec: 45, timeout: 30 });
  check('`timeoutSec` wins when both are set', canonical.join(' ').includes('--timeout 45'), canonical.join(' '));
  const rt = new VideoPipelineRuntime({ enabled: false });
  check('runtime default passes a per-page timeoutSec (not the 20 min acquisition bound)', rt.acquisitionOptions.timeoutSec === 60 && rt.acquisitionOptions.timeout === undefined, JSON.stringify(rt.acquisitionOptions));

  section('L2: path containment uses path.relative, not a bare prefix match');
  const root = path.join(WORKSPACE, 'l2', 'downloads');
  check('file inside -> true', isPathInside(root, path.join(root, 'a.mp4')));
  check('sibling dir sharing the prefix ("downloads_evil") -> false', !isPathInside(root, path.join(WORKSPACE, 'l2', 'downloads_evil', 'a.mp4')));
  check('".." escape -> false', !isPathInside(root, path.join(root, '..', 'a.mp4')));
  check('the directory itself -> false', !isPathInside(root, root));
  const sibling = writeFakeMp4(path.join(WORKSPACE, 'l2', 'downloads_evil', 'a.mp4'));
  const publishLedger = new PublishLedger({ ledgerPath: path.join(WORKSPACE, 'l2', 'publish_state.json') });
  const attempt = await publishLedger.recordAttempt({ batchId: 'b', media: { mediaId: 'm_l2' }, destinationId: DEST });
  await publishLedger.recordSuccess(attempt.publishId, { telegramMessageId: '1' });
  const cleaner = new MediaCleaner({ publishLedger, allowedDirectory: root });
  const cleanRes = await cleaner.cleanMedia({ mediaId: 'm_l2', destinationId: DEST, filePath: sibling });
  check('cleaner refuses a published file in a prefix-sharing sibling dir', cleanRes.status === 'FAILED' && fs.existsSync(sibling), JSON.stringify(cleanRes));

  section('L3: recorded acquisition PIDs are checked against the current boot');
  const bootTimeMs = Date.now() - Math.round(os.uptime() * 1000);
  const tenDays = 10 * 24 * 3600 * 1000;
  check('PID recorded in a previous boot is stale even if that PID number is alive now',
    assessRecordedAcquisition({ acquisitionPid: process.pid, acquisitionBootTimeMs: bootTimeMs - tenDays, startedAt: new Date().toISOString() }).alive === false);
  check('legacy record (no boot info) whose cycle started before this boot is stale',
    assessRecordedAcquisition({ acquisitionPid: process.pid, startedAt: new Date(bootTimeMs - tenDays).toISOString() }).alive === false);
  check('dead PID in the current boot is not alive',
    assessRecordedAcquisition({ acquisitionPid: 999999, acquisitionBootTimeMs: bootTimeMs, startedAt: new Date().toISOString() }).alive === false);
  const sameBoot = assessRecordedAcquisition({ acquisitionPid: process.pid, acquisitionBootTimeMs: bootTimeMs, startedAt: new Date().toISOString() });
  if (process.platform === 'linux') {
    check('live PID whose command line is not video-tools is treated as reused (not ours)', sameBoot.alive === false, JSON.stringify(sameBoot));
  } else {
    check('live PID in the current boot is reported alive but unverified (no /proc)', sameBoot.alive === true && sameBoot.verified === false, JSON.stringify(sameBoot));
  }
}

async function main() {
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
  fs.mkdirSync(WORKSPACE, { recursive: true });

  await testSpawnFailure();
  await testProcessTreeStop();
  await testAsyncValidation();
  await testPublisherReusesIngestValidation();
  await testUploadSizeLimit();
  await testCycleDiskHygiene();
  await testSweepRules();
  await testRuntimeSourceModeFailClosed();
  await testFixturePortInUse();
  await testDataDirDefaultsAndQuarantine();
  await testScheduleAnchoring();
  await testHistoryCap();
  await testSmallFixes();

  fs.rmSync(WORKSPACE, { recursive: true, force: true });

  console.log('\n============================================================');
  console.log(`DEPLOYMENT HARDENING RESULT: ${passed} passed, ${failed} failed`);
  console.log('============================================================');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
