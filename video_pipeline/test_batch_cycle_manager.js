/**
 * ============================================================
 * 🧪 BATCH CYCLE MANAGER - LOCAL AUTHORIZED FIXTURE TEST SUITE
 * ============================================================
 * All fixtures are local-only (127.0.0.1). No live/external/adult source,
 * no Telegram call anywhere in this file or the modules it exercises.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const { BatchCycleManager } = require('./batch_cycle_manager');
const { BatchState } = require('./batch_state');
const { VideoPipelineManager } = require('./video_pipeline_manager');
const { MediaIngestor } = require('./media_ingestor');
const { getFFmpegPath } = require('./media_validator');

const ROOT_DIR = path.resolve(__dirname, '..');
const FIXTURE_MP4 = path.join(ROOT_DIR, 'scratch', 'real_video_test.mp4');
const WORKSPACE = path.join(ROOT_DIR, 'scratch', 'batch_cycle_manager_test_workspace');

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

let passed = 0, failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.error(`  ❌ ${label}${detail ? ' - ' + detail : ''}`); failed++; }
}
function section(title) { console.log(`\n--- ${title} ---`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function freshDir(name) {
  const dir = path.join(WORKSPACE, name);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const TITLES = {
  1: 'Authorized Fixture Video One',
  2: 'Authorized Fixture Video Two'
};

/** Starts a local fixture server: 2 good posts + 1 post whose video 404s. */
async function startFixtureServer() {
  const fixtureBytes1 = fs.readFileSync(FIXTURE_MP4);
  const fixtureBytes2 = fs.readFileSync(SECOND_FIXTURE_MP4);
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><body><form id="fboardlist">
        <div class="list-row"><a href="/post/1?wr_id=1">Post 1</a></div>
        <div class="list-row"><a href="/post/2?wr_id=2">Post 2</a></div>
        <div class="list-row"><a href="/post/3?wr_id=3">Post 3</a></div>
      </form></body></html>`);
      return;
    }
    if (url === '/post/1') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><body><h1>${TITLES[1]}</h1>
        <div class="jw-media"><video class="jw-video" src="/media/video1.mp4"></video></div></body></html>`);
      return;
    }
    if (url === '/post/2') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><body><h1>${TITLES[2]}</h1>
        <div class="jw-media"><video class="jw-video" src="/media/video2.mp4"></video></div></body></html>`);
      return;
    }
    if (url === '/post/3') {
      // Video source resolves, but the underlying file 404s -> a genuinely
      // failed download, not merely a validation failure.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><body><h1>Authorized Fixture Video Three (will fail to download)</h1>
        <div class="jw-media"><video class="jw-video" src="/media/video_missing.mp4"></video></div></body></html>`);
      return;
    }
    if (url === '/media/video1.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': fixtureBytes1.length });
      res.end(fixtureBytes1);
      return;
    }
    if (url === '/media/video2.mp4') {
      // Genuinely different content from video1.mp4 (synthetic, locally
      // generated) so both posts are expected to become distinct READY
      // records, not a content-dedupe collision with each other.
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': fixtureBytes2.length });
      res.end(fixtureBytes2);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { server, baseUrl: `http://127.0.0.1:${port}/`, port };
}

function withoutRealProxyConfig(fn) {
  const proxyConfigPath = path.join(ROOT_DIR, 'video-scrapper', 'video-tools', '.proxy.local.json');
  const backupPath = `${proxyConfigPath}.set-aside-by-batch-cycle-test`;
  const had = fs.existsSync(proxyConfigPath);
  if (had) fs.renameSync(proxyConfigPath, backupPath);
  const restore = () => { if (had && fs.existsSync(backupPath)) fs.renameSync(backupPath, proxyConfigPath); };
  return fn().finally(restore);
}

function makeManager(testName, fixture, overrides = {}) {
  const dir = path.join(WORKSPACE, testName);
  const downloadsDir = path.join(dir, 'downloads');
  fs.mkdirSync(path.join(dir, 'output'), { recursive: true });
  fs.mkdirSync(downloadsDir, { recursive: true });
  // Each test gets its own isolated Media Ingestor ledger - MediaIngestor's
  // own default ledger path is shared/global, which would otherwise let
  // unrelated tests' content-dedupe collide with each other.
  const mediaIngestor = new MediaIngestor({
    downloadsDir,
    ledgerPath: path.join(dir, 'media_state.json'),
    stabilityCheckMs: 150
  });
  return new BatchCycleManager({
    acquisitionUrl: fixture.baseUrl,
    outputDir: path.join(dir, 'output'),
    downloadsDir,
    batchStatePath: path.join(dir, 'batch_state.json'),
    acquisitionOptions: { workers: 2, standalone: true, timeoutSec: 15, targetLinks: 3, maxPages: 1, ...overrides.acquisitionOptions },
    acquisitionTimeoutMs: overrides.acquisitionTimeoutMs || 60000,
    mediaIngestor
  });
}

async function testCoreLifecycle() {
  section('Tests 1-11: runOnce full lifecycle (acquisition -> title capture -> download -> ingest -> READY -> frozen batch)');
  return withoutRealProxyConfig(async () => {
    const { server, baseUrl } = await startFixtureServer();
    try {
      const mgr = makeManager('core', { baseUrl });
      const summary = await mgr.runOnce();

      check('Test 1/2: runOnce() drove the acquisition to completion (status is a terminal state)',
        summary.status === 'BATCH_READY' || summary.status === 'FAILED', summary.status);
      check('Test 1/2: cycle did not fail', summary.status === 'BATCH_READY', JSON.stringify(summary));

      check('Test 3: videos were discovered (3 posts)', summary.discovered === 3, `got ${summary.discovered}`);
      check('Test 5: downloader completed (2 successful downloads; 1 genuinely 404s)', summary.downloaded === 2, `got ${summary.downloaded}`);
      check('Test 6: Media Ingestor produced READY media (2)', summary.ready === 2, `got ${summary.ready}`);
      check('Test 17: the failed download did not become failed/duplicate READY media', summary.duplicates === 0);

      check('Test 7: batch received a cycleId', typeof summary.cycleId === 'string' && summary.cycleId.startsWith('cycle_'));

      const cycle = mgr.getCycle(summary.cycleId);
      check('Test 8: batch was frozen and persisted (cycle record exists with BATCH_READY status)', !!cycle && cycle.status === 'BATCH_READY');
      check('Test 8: frozen batch survives via a fresh read of the persisted state file', (() => {
        const freshState = new BatchState({ statePath: mgr.batchState.statePath });
        const freshCycle = freshState.getCycle(summary.cycleId);
        return !!freshCycle && Array.isArray(freshCycle.media) && freshCycle.media.length === 2;
      })());

      check('Test 9: batch contains exactly the 2 ready media IDs, each with a real contentSha256',
        cycle.media.length === 2 && cycle.media.every(m => m.mediaId && m.contentSha256));

      const titles = cycle.media.map(m => m.title).sort();
      check('Test 4/10: titles were captured by Playwright and remain associated with their videos in the frozen batch',
        JSON.stringify(titles) === JSON.stringify([TITLES[1], TITLES[2]].sort()), JSON.stringify(titles));

      check('Test 16: the validated MP4 files remain on disk (not deleted)',
        cycle.media.every(m => fs.existsSync(m.filePath)));

      // Check for actual Telegram API usage (imports/calls), not just the
      // word "Telegram" appearing in an explanatory comment about its ABSENCE.
      const sourceCode = fs.readFileSync(path.join(__dirname, 'batch_cycle_manager.js'), 'utf8');
      check('Test 11: no Telegram API/publishing code exists anywhere in this module',
        !/require\(['"](node-)?telegram|new TelegramBot|\.sendMessage\(|\.sendVideo\(|bot\.send/i.test(sourceCode));

      return { mgr, baseUrl };
    } finally {
      server.close();
    }
  });
}

async function testSecondRunNewCycle() {
  section('Test 12: second run creates a new cycle');
  return withoutRealProxyConfig(async () => {
    const { server, baseUrl } = await startFixtureServer();
    try {
      const mgr = makeManager('second_run', { baseUrl });
      const s1 = await mgr.runOnce();
      const s2 = await mgr.runOnce();
      check('First and second cycle IDs differ', s1.cycleId !== s2.cycleId);
      check('Both cycles reached BATCH_READY', s1.status === 'BATCH_READY' && s2.status === 'BATCH_READY');
      check('Second cycle finds the same posts already downloaded (no new READY media - correct dedupe)', s2.ready === 0, `got ${s2.ready}`);
      check('Two distinct cycle records are persisted', mgr.listCycles().length === 2, `got ${mgr.listCycles().length}`);
    } finally {
      server.close();
    }
  });
}

async function testOverlappingRunOnceCalls() {
  section('Test 13: overlapping runOnce() calls are prevented');
  return withoutRealProxyConfig(async () => {
    const { server, baseUrl } = await startFixtureServer();
    try {
      const mgr = makeManager('overlap_runonce', { baseUrl });
      const [r1, r2] = await Promise.all([mgr.runOnce(), mgr.runOnce()]);
      const statuses = [r1.status, r2.status].sort();
      check('Exactly one call proceeded and one was SKIPPED', JSON.stringify(statuses) === JSON.stringify(['BATCH_READY', 'SKIPPED']), JSON.stringify(statuses));
      const skipped = r1.status === 'SKIPPED' ? r1 : r2;
      check('The skipped call explains why', typeof skipped.reason === 'string' && skipped.reason.length > 0);
    } finally {
      server.close();
    }
  });
}

async function testSchedulerNoOverlap() {
  section('Test 14: scheduler does not create overlapping cycles');
  const dir = freshDir('scheduler_overlap');

  // A fake, slow VideoPipelineManager: stays "running" for longer than the
  // scheduler's tick interval, so a tick is guaranteed to land mid-cycle.
  let starts = 0;
  let running = false;
  const fakeManager = {
    start() {
      if (running) return { status: 'ALREADY_RUNNING', pid: 999 };
      running = true;
      starts++;
      setTimeout(() => { running = false; }, 700);
      return { status: 'STARTED', pid: 999 };
    },
    isRunning() { return running; },
    async stop() { running = false; return { status: 'STOPPED' }; },
    getStatus() { return { running, pid: running ? 999 : null, lastExitCode: running ? null : 0 }; }
  };

  const outputDir = path.join(dir, 'output');
  const downloadsDir = path.join(dir, 'downloads');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(downloadsDir, { recursive: true });

  const mgr = new BatchCycleManager({
    acquisitionUrl: 'http://127.0.0.1:1/unused-fake-url',
    outputDir,
    downloadsDir,
    batchStatePath: path.join(dir, 'batch_state.json'),
    videoPipelineManager: fakeManager,
    mediaIngestor: new MediaIngestor({ downloadsDir, ledgerPath: path.join(dir, 'media_state.json') })
  });

  mgr.start(250); // tick every 250ms, each fake cycle "runs" for 700ms -> guarantees overlap attempts
  await sleep(1600);
  await mgr.stop();

  check('Scheduler ran multiple ticks but the fake acquisition was only actually started a few times (not once per tick)',
    starts >= 1 && starts < 6, `starts=${starts}`);
  check('At least one scheduled tick was skipped and recorded', mgr.batchState.getSkippedTicks().length > 0,
    `skipped=${mgr.batchState.getSkippedTicks().length}`);
}

async function testRestartRecovery() {
  section('Test 15: restart/recovery does not duplicate media');
  return withoutRealProxyConfig(async () => {
    const { server, baseUrl } = await startFixtureServer();
    try {
      const dir = freshDir('restart_recovery');
      const outputDir = path.join(dir, 'output');
      const downloadsDir = path.join(dir, 'downloads');
      const batchStatePath = path.join(dir, 'batch_state.json');
      const ledgerPath = path.join(dir, 'media_state.json');

      // First, a real successful cycle.
      const mgr1 = new BatchCycleManager({
        acquisitionUrl: baseUrl, outputDir, downloadsDir, batchStatePath,
        acquisitionOptions: { workers: 2, standalone: true, timeoutSec: 15, targetLinks: 3, maxPages: 1 },
        mediaIngestor: new MediaIngestor({ downloadsDir, ledgerPath, stabilityCheckMs: 150 })
      });
      const s1 = await mgr1.runOnce();
      check('Initial cycle succeeded before simulating a crash', s1.status === 'BATCH_READY' && s1.ready === 2);

      // Simulate a crash: hand-craft a batch_state.json claiming a second
      // cycle is still ACQUIRING under a PID that is guaranteed not to exist.
      const DEAD_PID = 999999;
      const crashedState = JSON.parse(fs.readFileSync(batchStatePath, 'utf8'));
      crashedState.state = 'ACQUIRING';
      crashedState.currentCycleId = 'cycle_crashed_simulated';
      crashedState.cycles['cycle_crashed_simulated'] = {
        cycleId: 'cycle_crashed_simulated', status: 'ACQUIRING', startedAt: new Date().toISOString(),
        completedAt: null, acquisitionPid: DEAD_PID, discovered: 0, downloaded: 0, ready: 0, duplicates: 0, failed: 0, media: [], lastError: null
      };
      fs.writeFileSync(batchStatePath, JSON.stringify(crashedState, null, 2));

      // "Restart": construct a fresh controller pointed at the same paths.
      const mgr2 = new BatchCycleManager({
        acquisitionUrl: baseUrl, outputDir, downloadsDir, batchStatePath,
        acquisitionOptions: { workers: 2, standalone: true, timeoutSec: 15, targetLinks: 3, maxPages: 1 },
        mediaIngestor: new MediaIngestor({ downloadsDir, ledgerPath, stabilityCheckMs: 150 })
      });

      check('Recovery marked the interrupted cycle FAILED', mgr2.getCycle('cycle_crashed_simulated').status === 'FAILED');
      check('Recovery reset the controller to IDLE (ready for new cycles)', mgr2.getStatus().state === 'IDLE');
      check('Recovery did not touch the earlier successful cycle', mgr2.getCycle(s1.cycleId).status === 'BATCH_READY');
      check('Recovery did not delete any already-downloaded/validated media', mgr2.getCycle(s1.cycleId).media.every(m => fs.existsSync(m.filePath)));

      const s2 = await mgr2.runOnce();
      check('A new cycle after recovery completes normally', s2.status === 'BATCH_READY');
      check('No duplicate media was created for files already READY before the simulated crash', s2.ready === 0, `got ${s2.ready}`);
    } finally {
      server.close();
    }
  });
}

async function main() {
  if (fs.existsSync(WORKSPACE)) fs.rmSync(WORKSPACE, { recursive: true, force: true });
  fs.mkdirSync(WORKSPACE, { recursive: true });
  buildSecondFixture();

  await testCoreLifecycle();
  await testSecondRunNewCycle();
  await testOverlappingRunOnceCalls();
  await testSchedulerNoOverlap();
  await testRestartRecovery();

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
