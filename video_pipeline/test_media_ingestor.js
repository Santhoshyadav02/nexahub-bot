/**
 * ============================================================
 * 🧪 MEDIA INGESTOR - LOCAL AUTHORIZED FIXTURE TEST SUITE
 * ============================================================
 * All fixtures are local-only: the existing real_video_test.mp4 fixture, a
 * second synthetic MP4 generated locally via ffmpeg's lavfi testsrc, and
 * hand-built invalid/corrupt/temp files. No network access, no external or
 * adult site, no Telegram calls anywhere in this file.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const { MediaIngestor } = require('./media_ingestor');
const { MediaLedger } = require('./media_ledger');
const { getFFmpegPath } = require('./media_validator');

const ROOT_DIR = path.resolve(__dirname, '..');
const FIXTURE_MP4 = path.join(ROOT_DIR, 'scratch', 'real_video_test.mp4');
const WORKSPACE = path.join(ROOT_DIR, 'scratch', 'media_ingestor_test_workspace');

let passed = 0, failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.error(`  ❌ ${label}${detail ? ' - ' + detail : ''}`); failed++; }
}
function section(title) {
  console.log(`\n--- ${title} ---`);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function freshDir(name) {
  const dir = path.join(WORKSPACE, name);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeIngestor(testName, opts = {}) {
  const downloadsDir = path.join(WORKSPACE, testName, 'downloads');
  fs.mkdirSync(downloadsDir, { recursive: true });
  const ledgerPath = path.join(WORKSPACE, testName, 'media_state.json');
  return new MediaIngestor({ downloadsDir, ledgerPath, stabilityCheckMs: opts.stabilityCheckMs || 150 });
}

let SECOND_FIXTURE_MP4 = null;
function buildSecondFixture() {
  SECOND_FIXTURE_MP4 = path.join(WORKSPACE, 'synthetic_fixture.mp4');
  const ffmpeg = getFFmpegPath();
  const res = spawnSync(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=5',
    '-pix_fmt', 'yuv420p', SECOND_FIXTURE_MP4
  ], { encoding: 'utf8' });
  if (res.status !== 0 || !fs.existsSync(SECOND_FIXTURE_MP4)) {
    throw new Error(`Could not generate the second local synthetic fixture MP4: ${res.stderr}`);
  }
}

async function test1_validMp4Ready() {
  section('Test 1: Valid MP4 -> READY');
  const ing = makeIngestor('test1');
  const dest = path.join(ing.downloadsDir, 'video1.mp4');
  fs.copyFileSync(FIXTURE_MP4, dest);

  const summary = await ing.scanOnce();
  check('Scan processed exactly 1 file', summary.scannedFiles === 1, `got ${summary.scannedFiles}`);
  const records = ing.ledger.listAll();
  check('Exactly 1 record created', records.length === 1, `got ${records.length}`);
  const rec = records[0];
  check('Record status is READY', rec && rec.status === 'READY', rec && rec.status);
  check('contentSha256 was computed', !!(rec && rec.contentSha256));
  check('validation.valid is true', !!(rec && rec.validation && rec.validation.valid));
  return { ing, id: rec.id, dest };
}

async function test2_sameFileTwice(prev) {
  section('Test 2: Same file scanned twice -> one media record');
  const summary2 = await prev.ing.scanOnce();
  check('Second scan sees the file as already-processed (unchanged)', summary2.results[0].reason.includes('Already processed'));
  const records = prev.ing.ledger.listAll();
  check('Still exactly 1 record after a second scan', records.length === 1, `got ${records.length}`);
  check('Record is still READY', records[0].status === 'READY');
}

async function test3_copiedFileContentDedupe(prev) {
  section('Test 3: Copied/renamed identical MP4 -> content dedupe works');
  const copyPath = path.join(prev.ing.downloadsDir, 'video1_copy.mp4');
  fs.copyFileSync(prev.dest, copyPath);

  const summary = await prev.ing.scanOnce();
  const copyOutcome = summary.results.find(r => r.filePath === copyPath);
  check('Copy was processed', !!copyOutcome);
  check('Copy is marked DUPLICATE', copyOutcome && copyOutcome.status === 'DUPLICATE', copyOutcome && copyOutcome.status);
  check('Copy points at the original record via duplicateOf', copyOutcome && copyOutcome.duplicateOf === prev.id);

  const original = prev.ing.ledger.getRecord(prev.id);
  check('Original record is still READY (untouched)', original.status === 'READY');
  const readyRecords = prev.ing.ledger.listByStatus('READY');
  check('Only one READY record exists for this content', readyRecords.length === 1, `got ${readyRecords.length}`);
}

async function test4_differentMp4SeparateReady(prev) {
  section('Test 4: Different MP4 -> separate READY record');
  const diffPath = path.join(prev.ing.downloadsDir, 'video2_different.mp4');
  fs.copyFileSync(SECOND_FIXTURE_MP4, diffPath);

  const summary = await prev.ing.scanOnce();
  const outcome = summary.results.find(r => r.filePath === diffPath);
  check('Different file was processed', !!outcome);
  check('Different file reaches READY (not DUPLICATE)', outcome && outcome.status === 'READY', outcome && outcome.status);
  const readyRecords = prev.ing.ledger.listByStatus('READY');
  check('Now exactly 2 distinct READY records exist', readyRecords.length === 2, `got ${readyRecords.length}`);
}

async function test5_6_7_ignoredExtensions() {
  section('Test 5/6/7: .part / .tmp / .crdownload -> ignored');
  const ing = makeIngestor('test567');
  fs.writeFileSync(path.join(ing.downloadsDir, 'video_x.mp4.part'), Buffer.from('not a real video'));
  fs.writeFileSync(path.join(ing.downloadsDir, 'video_y.mp4.tmp'), Buffer.from('not a real video'));
  fs.writeFileSync(path.join(ing.downloadsDir, 'video_z.mp4.crdownload'), Buffer.from('not a real video'));
  fs.writeFileSync(path.join(ing.downloadsDir, '.hidden.mp4'), Buffer.from('not a real video'));

  const summary = await ing.scanOnce();
  check('.part file was never scanned', summary.scannedFiles === 0, `scanned ${summary.scannedFiles} file(s)`);
  check('No ledger records were created for ignored extensions', ing.ledger.listAll().length === 0);
}

async function test8_zeroByteMp4() {
  section('Test 8: Zero-byte MP4 -> not READY');
  const ing = makeIngestor('test8');
  fs.writeFileSync(path.join(ing.downloadsDir, 'empty.mp4'), Buffer.alloc(0));

  const summary = await ing.scanOnce();
  check('File was scanned', summary.scannedFiles === 1);
  const rec = ing.ledger.listAll()[0];
  check('Record status is FAILED (not READY)', rec && rec.status === 'FAILED', rec && rec.status);
}

async function test9_htmlAsMp4() {
  section('Test 9: HTML masquerading as .mp4 -> validation failure');
  const ing = makeIngestor('test9');
  fs.writeFileSync(path.join(ing.downloadsDir, 'fake.mp4'), '<!DOCTYPE html><html><body>Not a video</body></html>');

  await ing.scanOnce();
  const rec = ing.ledger.listAll()[0];
  check('Record status is FAILED', rec && rec.status === 'FAILED', rec && rec.status);
  check('Failure reason mentions the header/container check', /header|ISOBMFF|ftyp/i.test(rec.lastError || ''), rec.lastError);
}

async function test10_corruptMp4() {
  section('Test 10: Corrupt MP4 (valid header, unusable body) -> validation failure');
  const ing = makeIngestor('test10');
  const original = fs.readFileSync(FIXTURE_MP4);
  // Keep a real ftyp header (passes the cheap header check) but truncate hard
  // enough that neither ffprobe nor ffmpeg can find a usable video stream.
  const corrupted = original.subarray(0, 40);
  fs.writeFileSync(path.join(ing.downloadsDir, 'corrupt.mp4'), corrupted);

  await ing.scanOnce();
  const rec = ing.ledger.listAll()[0];
  check('Record status is FAILED', rec && rec.status === 'FAILED', rec && rec.status);
  check('Header check alone was insufficient (evidence of deeper validation)', !!(rec && rec.lastError));
}

async function test11_changingFileNotIngestedUntilStable() {
  section('Test 11: File changing during scan -> not ingested until stable');
  const ing = makeIngestor('test11', { stabilityCheckMs: 200 });
  const target = path.join(ing.downloadsDir, 'growing.mp4');
  const fullBytes = fs.readFileSync(FIXTURE_MP4);
  const half = fullBytes.subarray(0, Math.floor(fullBytes.length / 2));
  fs.writeFileSync(target, half);

  // Append the rest partway through the stability check's own wait window,
  // so the first scan is guaranteed to observe a size change.
  const growTimer = setTimeout(() => {
    fs.appendFileSync(target, fullBytes.subarray(half.length));
  }, 90);

  const summary1 = await ing.scanOnce();
  clearTimeout(growTimer);
  const outcome1 = summary1.results.find(r => r.filePath === target);
  check('First scan detects instability, does not ingest yet', outcome1 && outcome1.status === 'UNSTABLE', outcome1 && outcome1.status);
  check('No READY record exists yet', ing.ledger.listByStatus('READY').length === 0);

  // Ensure the write has fully landed and the file is now quiet.
  await sleep(300);
  const summary2 = await ing.scanOnce();
  const outcome2 = summary2.results.find(r => r.filePath === target);
  check('Second scan (file now stable) reaches READY', outcome2 && outcome2.status === 'READY', outcome2 && outcome2.status);
}

async function test12_disappearingFileHandledWithoutCrash() {
  section('Test 12: File disappears during processing -> handled without crash');
  const ing = makeIngestor('test12', { stabilityCheckMs: 60 });
  const target = path.join(ing.downloadsDir, 'vanishing.mp4');
  fs.copyFileSync(FIXTURE_MP4, target);

  // Delete shortly after the stability window closes, racing whichever of
  // the existence re-check / hash read / validation happens to be next -
  // every one of those paths already handles a missing file gracefully.
  setTimeout(() => {
    try { fs.unlinkSync(target); } catch (e) {}
  }, 65);

  let crashed = false;
  let summary;
  try {
    summary = await ing.scanOnce();
  } catch (e) {
    crashed = true;
  }
  check('scanOnce() did not throw/crash', !crashed);
  const outcome = summary && summary.results.find(r => r.filePath === target);
  check('Outcome is a sane terminal/retry state, never READY', !!outcome && outcome.status !== 'READY', outcome && outcome.status);
}

async function test13_killRestartRecovery() {
  section('Test 13: Kill/restart simulation -> persistent state recovers');
  const dir = freshDir('test13');
  const downloadsDir = path.join(dir, 'downloads');
  fs.mkdirSync(downloadsDir, { recursive: true });
  const ledgerPath = path.join(dir, 'media_state.json');

  const stillThereFile = path.join(downloadsDir, 'still_here.mp4');
  fs.copyFileSync(FIXTURE_MP4, stillThereFile);
  const goneFile = path.join(downloadsDir, 'gone.mp4');

  // Simulate a process that crashed mid-validation for two records.
  fs.writeFileSync(ledgerPath, JSON.stringify({
    version: '1.0.0',
    updatedAt: new Date().toISOString(),
    records: {
      idA: { id: 'idA', filePath: stillThereFile, fileName: 'still_here.mp4', status: 'VALIDATING', discoveredAt: new Date().toISOString(), lastError: null },
      idB: { id: 'idB', filePath: goneFile, fileName: 'gone.mp4', status: 'VALIDATING', discoveredAt: new Date().toISOString(), lastError: null }
    },
    contentIndex: {},
    sourceIndex: {}
  }, null, 2));

  const ledger = new MediaLedger({ ledgerPath });
  const recovery = ledger.getRecoverySummary();
  check('Recovery processed 2 stuck records', recovery.recoveredCount === 2, recovery.recoveredCount);
  check('Record for a file that still exists recovers to DISCOVERED', ledger.getRecord('idA').status === 'DISCOVERED', ledger.getRecord('idA').status);
  check('Record for a file that vanished recovers to FAILED', ledger.getRecord('idB').status === 'FAILED', ledger.getRecord('idB').status);

  // Bonus, closely-related check: a genuinely malformed ledger file must
  // never crash the process - it should just start fresh.
  const malformedLedgerPath = path.join(dir, 'malformed_media_state.json');
  fs.writeFileSync(malformedLedgerPath, '{ this is not : valid json ][');
  let crashed = false;
  let freshLedger;
  try {
    freshLedger = new MediaLedger({ ledgerPath: malformedLedgerPath });
  } catch (e) {
    crashed = true;
  }
  check('Malformed ledger file does not crash the process', !crashed);
  check('Malformed ledger results in a clean, empty starting state', !!freshLedger && freshLedger.listAll().length === 0);
}

async function test14_concurrentScansNoDuplicates() {
  section('Test 14: Concurrent scans -> no duplicate records');
  const ing = makeIngestor('test14');
  fs.copyFileSync(FIXTURE_MP4, path.join(ing.downloadsDir, 'concurrent1.mp4'));

  const [s1, s2, s3] = await Promise.all([ing.scanOnce(), ing.scanOnce(), ing.scanOnce()]);
  check('All three concurrent scanOnce() calls completed without throwing', !!(s1 && s2 && s3));
  const records = ing.ledger.listAll();
  check('Exactly 1 record exists after 3 concurrent scans', records.length === 1, `got ${records.length}`);
  check('That record is READY', records[0] && records[0].status === 'READY');
}

async function test15_atomicLedgerAlwaysValidJson() {
  section('Test 15: Atomic ledger remains valid JSON under concurrent writes');
  const ing = makeIngestor('test15');
  for (let i = 0; i < 5; i++) {
    fs.copyFileSync(i % 2 === 0 ? FIXTURE_MP4 : SECOND_FIXTURE_MP4, path.join(ing.downloadsDir, `file${i}.mp4`));
  }

  let readerFailures = 0;
  let readerChecks = 0;
  let keepReading = true;
  const reader = (async () => {
    while (keepReading) {
      if (fs.existsSync(ing.ledger.ledgerPath)) {
        readerChecks++;
        try {
          JSON.parse(fs.readFileSync(ing.ledger.ledgerPath, 'utf8'));
        } catch (e) {
          readerFailures++;
        }
      }
      await sleep(2);
    }
  })();

  await Promise.all([ing.scanOnce(), ing.scanOnce(), ing.scanOnce()]);
  const readyIds = ing.ledger.listByStatus('READY').map(r => r.id);
  const claimAttempts = await Promise.all(readyIds.map(id => ing.claim(id)));

  keepReading = false;
  await reader;

  check(`Ledger file was read/parsed concurrently ${readerChecks} time(s) during writes`, readerChecks > 0);
  check('The ledger file was NEVER observed as invalid/partial JSON', readerFailures === 0, `${readerFailures} failure(s)`);
  check('Concurrent claims all resolved without throwing', claimAttempts.every(r => r && r.status));
  const finalParse = JSON.parse(fs.readFileSync(ing.ledger.ledgerPath, 'utf8'));
  check('Final ledger file is valid, well-formed JSON', Array.isArray(Object.values(finalParse.records)));
}

async function integrationTest() {
  section('INTEGRATION: Video Pipeline Manager -> video-tools -> downloads/ -> Media Ingestor -> READY');
  const http = require('http');
  const { VideoPipelineManager } = require('./video_pipeline_manager');

  const fixtureBytes = fs.readFileSync(FIXTURE_MP4);
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><body><form id="fboardlist">
        <div class="list-row"><a href="/post/1?wr_id=1">Post 1</a></div>
      </form></body></html>`);
      return;
    }
    if (url === '/post/1') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><body><div class="jw-media"><video class="jw-video" src="/media/video1.mp4"></video></div></body></html>`);
      return;
    }
    if (url === '/media/video1.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': fixtureBytes.length });
      res.end(fixtureBytes);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/`;
  console.log(`  [LOCAL_FIXTURE] Listening at http://127.0.0.1:${port}`);

  const dir = freshDir('integration');
  const outputDir = path.join(dir, 'output');
  const downloadsDir = path.join(dir, 'downloads');

  const proxyConfigPath = path.join(ROOT_DIR, 'video-scrapper', 'video-tools', '.proxy.local.json');
  const proxyConfigBackupPath = `${proxyConfigPath}.set-aside-by-media-ingestor-test`;
  const hadProxyConfig = fs.existsSync(proxyConfigPath);
  if (hadProxyConfig) fs.renameSync(proxyConfigPath, proxyConfigBackupPath);

  try {
    const manager = new VideoPipelineManager();
    const startResult = manager.start({
      url: baseUrl,
      output: outputDir,
      downloads: downloadsDir,
      workers: 1,
      standalone: true,
      once: true,
      targetLinks: 1,
      maxPages: 1,
      timeoutSec: 15
    });
    check('Video Pipeline Manager started video-tools', startResult.status === 'STARTED');

    const deadline = Date.now() + 30000;
    while (manager.isRunning() && Date.now() < deadline) {
      await sleep(300);
    }
    check('video-tools pipeline finished on its own (--once)', !manager.isRunning());

    const downloadedMp4s = fs.existsSync(downloadsDir) ? fs.readdirSync(downloadsDir).filter(f => f.endsWith('.mp4')) : [];
    check('video-tools actually downloaded a file into downloads/', downloadedMp4s.length === 1, `got ${downloadedMp4s.length}`);

    const ing = new MediaIngestor({
      downloadsDir,
      ledgerPath: path.join(dir, 'media_state.json'),
      stabilityCheckMs: 150
    });
    const summary = await ing.scanOnce();
    check('Media Ingestor scanned the file video-tools produced', summary.scannedFiles === 1, `got ${summary.scannedFiles}`);
    const ready = ing.getReadyMedia();
    check('File reached READY via the Media Ingestor', ready.length === 1, `got ${ready.length}`);
    check('READY record content matches the original fixture (real, end-to-end bytes)',
      ready.length === 1 && ready[0].contentSha256 === crypto.createHash('sha256').update(fixtureBytes).digest('hex'));

    const originalFile = downloadedMp4s[0] ? path.join(downloadsDir, downloadedMp4s[0]) : null;
    check('The validated MP4 was left in place, not deleted (cleanup is a later phase)', !!originalFile && fs.existsSync(originalFile));
  } finally {
    server.close();
    if (hadProxyConfig && fs.existsSync(proxyConfigBackupPath)) {
      fs.renameSync(proxyConfigBackupPath, proxyConfigPath);
    }
  }
}

async function main() {
  if (fs.existsSync(WORKSPACE)) fs.rmSync(WORKSPACE, { recursive: true, force: true });
  fs.mkdirSync(WORKSPACE, { recursive: true });
  buildSecondFixture();

  const t1 = await test1_validMp4Ready();
  await test2_sameFileTwice(t1);
  await test3_copiedFileContentDedupe(t1);
  await test4_differentMp4SeparateReady(t1);
  await test5_6_7_ignoredExtensions();
  await test8_zeroByteMp4();
  await test9_htmlAsMp4();
  await test10_corruptMp4();
  await test11_changingFileNotIngestedUntilStable();
  await test12_disappearingFileHandledWithoutCrash();
  await test13_killRestartRecovery();
  await test14_concurrentScansNoDuplicates();
  await test15_atomicLedgerAlwaysValidJson();
  await integrationTest();

  fs.rmSync(WORKSPACE, { recursive: true, force: true });

  console.log('\n============================================================');
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log('============================================================');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
