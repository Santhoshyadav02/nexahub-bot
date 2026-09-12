/**
 * ============================================================
 * 🧪 VIDEO PIPELINE RUNTIME MANAGER TEST SUITE (PHASE 6B)
 * ============================================================
 * Validates the NexaHub orchestration runtime wrapper:
 *   - Disabled-by-default behavior (fail-closed)
 *   - Module-scoped singleton behavior
 *   - Configuration validation & forbidden channel protection
 *   - Safe start/stop/runOnce delegating to BatchCycleManager
 *   - Sanitized status reporting with zero secrets
 *   - Error isolation ensuring parent process stability
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawnSync } = require('child_process');

const {
  VideoPipelineRuntime,
  getVideoPipelineRuntime,
  _resetRuntimeInstanceForTesting
} = require('./video_pipeline_runtime');
const { BatchState } = require('./batch_state');
const { MediaLedger } = require('./media_ledger');
const { PublishLedger } = require('./publish_ledger');
const { MediaCleaner } = require('./media_cleaner');
const { getFFmpegPath } = require('./media_validator');

const ROOT_DIR = path.resolve(__dirname, '..');
const TEST_WORKSPACE = path.join(ROOT_DIR, 'scratch', 'test_video_pipeline_runtime_workspace');

let passed = 0;
let failed = 0;

function check(label, condition, details = '') {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label} ${details}`);
    failed++;
  }
}

function section(name) {
  console.log(`\n============================================================\n${name}\n============================================================`);
}

function freshEnv(tag) {
  const dir = path.join(TEST_WORKSPACE, tag);
  fs.rmSync(dir, { recursive: true, force: true });
  const outputDir = path.join(dir, 'output');
  const downloadsDir = path.join(dir, 'downloads');
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(downloadsDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  return {
    dir,
    outputDir,
    downloadsDir,
    stateDir
  };
}

function getValidFixtureMp4(id) {
  const fixtureDir = path.join(TEST_WORKSPACE, 'fixtures');
  fs.mkdirSync(fixtureDir, { recursive: true });
  const fixturePath = path.join(fixtureDir, `fixture_${id}.mp4`);
  if (fs.existsSync(fixturePath)) return fixturePath;

  const ffmpeg = getFFmpegPath();
  const res = spawnSync(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x120:d=1',
    '-pix_fmt', 'yuv420p', fixturePath
  ], { encoding: 'utf8' });

  if (res.status !== 0 || !fs.existsSync(fixturePath)) {
    throw new Error(`Could not generate local test fixture MP4: ${res.stderr}`);
  }
  return fixturePath;
}

function createFixtureServer(postsData) {
  let currentPosts = [...postsData];

  const server = http.createServer((req, res) => {
    const rawUrl = req.url.split('?')[0];

    if (rawUrl === '/' || rawUrl === '/board') {
      const itemsHtml = currentPosts.map(p => `
        <div class="list-row">
          <a href="/post/${p.id}?wr_id=${p.id}">${p.title}</a>
        </div>
      `).join('\n');

      const html = `<!DOCTYPE html>
<html>
<head><title>Test Board</title></head>
<body>
  <form id="fboardlist">
    ${itemsHtml}
  </form>
</body>
</html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    const postMatch = rawUrl.match(/\/post\/(\w+)/);
    if (postMatch) {
      const postId = postMatch[1];
      const post = currentPosts.find(p => String(p.id) === String(postId));
      if (!post) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      const html = `<!DOCTYPE html>
<html>
<head><title>${post.title}</title></head>
<body>
  <h1>${post.title}</h1>
  <div class="jw-media">
    <video class="jw-video" src="/media/${post.id}.mp4"></video>
  </div>
</body>
</html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    const mediaMatch = rawUrl.match(/\/media\/(\w+)\.mp4/);
    if (mediaMatch) {
      const postId = mediaMatch[1];
      const mp4Path = getValidFixtureMp4(postId);
      const mp4Buf = fs.readFileSync(mp4Path);
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': mp4Buf.length
      });
      res.end(mp4Buf);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  return {
    server,
    listen: () => new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        resolve({ port, url: `http://127.0.0.1:${port}/` });
      });
    }),
    close: () => new Promise(resolve => server.close(resolve))
  };
}

async function runRuntimeTests() {
  console.log('============================================================');
  console.log('🧪 RUNNING VIDEO PIPELINE RUNTIME TEST SUITE');
  console.log('============================================================');

  const proxyConfigPath = path.join(ROOT_DIR, 'video-scrapper', 'video-tools', '.proxy.local.json');
  const proxyBackupPath = `${proxyConfigPath}.set-aside-by-runtime-test`;
  let hadProxyConfig = false;

  if (fs.existsSync(proxyConfigPath)) {
    hadProxyConfig = true;
    fs.renameSync(proxyConfigPath, proxyBackupPath);
  }

  try {

  // ============================================================
  // TEST 1: DISABLED DEFAULT BEHAVIOR
  // ============================================================
  section('TEST 1: Disabled Default Behavior');
  const runtime1 = new VideoPipelineRuntime({ enabled: false });
  const status1 = runtime1.getStatus();
  check('Status reports enabled=false', status1.enabled === false);
  check('Status state is DISABLED', status1.state === 'DISABLED');
  check('Scheduler is not active', status1.schedulerActive === false);

  const startRes1 = runtime1.start();
  check('start() returns DISABLED status', startRes1.status === 'DISABLED' && startRes1.started === false);
  check('Runtime is not started after disabled start', runtime1.isStarted() === false);

  const runRes1 = await runtime1.runOnce();
  check('runOnce() is safely skipped when disabled', runRes1.status === 'SKIPPED');

  const stopRes1 = await runtime1.stop();
  check('stop() returns NOT_RUNNING when disabled', stopRes1.status === 'NOT_RUNNING');

  // ============================================================
  // TEST 2: SINGLETON INTEGRITY
  // ============================================================
  section('TEST 2: Singleton Integrity');
  _resetRuntimeInstanceForTesting();
  const instA = getVideoPipelineRuntime({ enabled: false });
  const instB = getVideoPipelineRuntime();
  check('getVideoPipelineRuntime() returns same instance', instA === instB);
  _resetRuntimeInstanceForTesting();

  // ============================================================
  // TEST 3: INVALID CONFIG FAIL-CLOSED
  // ============================================================
  section('TEST 3: Invalid Config Fail-Closed');
  const runtime3 = new VideoPipelineRuntime({
    enabled: true,
    acquisitionUrl: null,
    stagingChatId: '-1009990001'
  });
  const status3 = runtime3.getStatus();
  check('Status reports configValid=false', status3.configValid === false);
  check('Status state is CONFIG_ERROR', status3.state === 'CONFIG_ERROR');
  check('Status includes config error description', typeof status3.lastConfigError === 'string');

  const startRes3 = runtime3.start();
  check('start() rejects missing acquisitionUrl with CONFIG_ERROR', startRes3.status === 'CONFIG_ERROR');
  check('Runtime is not started', runtime3.isStarted() === false);

  const runRes3 = await runtime3.runOnce();
  check('runOnce() rejects invalid config with CONFIG_ERROR', runRes3.status === 'CONFIG_ERROR');

  // ============================================================
  // TEST 4: VALID CONFIGURATION VALIDATION
  // ============================================================
  section('TEST 4: Valid Configuration Validation');
  const env4 = freshEnv('test4_valid_config');
  const runtime4 = new VideoPipelineRuntime({
    enabled: true,
    acquisitionUrl: 'http://127.0.0.1:8080/',
    stagingChatId: '-1009990001',
    intervalMs: 10800000,
    downloadsDir: env4.downloadsDir,
    outputDir: env4.outputDir,
    stateDir: env4.stateDir
  });
  const status4 = runtime4.getStatus();
  check('Valid config reports configValid=true', status4.configValid === true);
  check('State is IDLE prior to start', status4.state === 'IDLE');

  // ============================================================
  // TEST 5: START RUNTIME & PREVENT DUPLICATES
  // ============================================================
  section('TEST 5: Start Runtime & Duplicate Start Protection');
  const env5 = freshEnv('test5_start');
  let schedulerStarts = 0;
  const mockBatchCycleManager = {
    startScheduler: () => { schedulerStarts++; },
    stop: async () => {},
    isSchedulerActive: () => true,
    batchState: {
      getControllerState: () => 'IDLE',
      getCurrentCycleId: () => null
    },
    getLastCycleSummary: () => null,
    runOnce: async () => ({ status: 'COMPLETED' })
  };

  const runtime5 = new VideoPipelineRuntime({
    enabled: true,
    acquisitionUrl: 'http://127.0.0.1:8080/',
    stagingChatId: '-1009990001',
    intervalMs: 3600000,
    batchCycleManager: mockBatchCycleManager
  });

  const startRes5 = runtime5.start();
  check('start() returns STARTED', startRes5.status === 'STARTED' && startRes5.started === true);
  check('isStarted() is true', runtime5.isStarted() === true);
  check('Scheduler was started once', schedulerStarts === 1);

  // Repeated start
  const startDup = runtime5.start();
  check('Repeated start() returns ALREADY_STARTED', startDup.status === 'ALREADY_STARTED');
  check('Scheduler was NOT duplicated', schedulerStarts === 1);

  await runtime5.stop();
  check('isStarted() is false after stop()', runtime5.isStarted() === false);

  // ============================================================
  // TEST 6: RUN ONCE END-TO-END DELEGATION
  // ============================================================
  section('TEST 6: runOnce End-to-End Delegation');
  const env6 = freshEnv('test6_run_once');
  const fixture6 = createFixtureServer([
    { id: 'rt1', title: 'Romantic Vibe Runtime Test Video' }
  ]);
  const { url: serverUrl6 } = await fixture6.listen();

  const telegramUploads = [];
  const mockTelegram = {
    sendVideo: async (chatId, filePath, options) => {
      telegramUploads.push({ chatId, filePath, options });
      return { message_id: 881100 };
    }
  };

  const runtime6 = new VideoPipelineRuntime({
    enabled: true,
    acquisitionUrl: serverUrl6,
    stagingChatId: '-1009990001',
    downloadsDir: env6.downloadsDir,
    outputDir: env6.outputDir,
    stateDir: env6.stateDir,
    telegramClient: mockTelegram,
    autoPublish: true,
    enableCleanup: true,
    acquisitionOptions: { workers: 1, timeout: 15, targetLinks: 1, maxPages: 1, standalone: true }
  });

  const cycleResult6 = await runtime6.runOnce();
  check('runOnce() returned COMPLETED status', cycleResult6.status === 'COMPLETED');
  check('Cycle discovered and published 1 item', cycleResult6.publishResult && cycleResult6.publishResult.published === 1);
  check('Telegram received 1 upload call', telegramUploads.length === 1);
  check('Media was unlinked by MediaCleaner', fs.readdirSync(env6.downloadsDir).filter(f => f.endsWith('.mp4')).length === 0);

  await fixture6.close();

  // ============================================================
  // TEST 7: STATUS INTEGRITY & SECRECY
  // ============================================================
  section('TEST 7: Status Reporting & Sanitization');
  const status6 = runtime6.getStatus();
  check('Status reports enabled=true', status6.enabled === true);
  check('Status state is IDLE after completion', status6.state === 'IDLE');
  check('Status contains lastCycleSummary', status6.lastCycleSummary !== null && status6.lastCycleSummary.status === 'COMPLETED');
  check('Status does NOT contain credentials or tokens',
    !('token' in status6) && !('proxy' in status6) && !('secret' in status6));

  // ============================================================
  // TEST 8: IDEMPOTENT STOP
  // ============================================================
  section('TEST 8: Idempotent Stop');
  const stopRes8A = await runtime6.stop();
  check('First stop() returns STOPPED or NOT_RUNNING', stopRes8A.status === 'STOPPED' || stopRes8A.status === 'NOT_RUNNING');
  const stopRes8B = await runtime6.stop();
  check('Second stop() is safe and returns NOT_RUNNING', stopRes8B.status === 'NOT_RUNNING');

  // ============================================================
  // TEST 9: FAILURE ISOLATION
  // ============================================================
  section('TEST 9: Failure Isolation');
  const failingManager = {
    startScheduler: () => { throw new Error('Simulated scheduler boot crash'); },
    stop: async () => { throw new Error('Simulated stop error'); },
    isSchedulerActive: () => false,
    batchState: { getControllerState: () => 'FAILED', getCurrentCycleId: () => null },
    getLastCycleSummary: () => null,
    runOnce: async () => { throw new Error('Simulated unhandled acquisition explosion'); }
  };

  const runtime9 = new VideoPipelineRuntime({
    enabled: true,
    acquisitionUrl: 'http://127.0.0.1:8080/',
    stagingChatId: '-1009990001',
    batchCycleManager: failingManager
  });

  const startErrRes = runtime9.start();
  check('start() catches internal manager error and returns ERROR status', startErrRes.status === 'ERROR');
  check('Parent process did not crash on start error', true);

  const runErrRes = await runtime9.runOnce();
  check('runOnce() catches internal error and returns FAILED status', runErrRes.status === 'FAILED');
  check('Parent process did not crash on runOnce error', true);

  // ============================================================
  // TEST 10: CONFIG SAFETY (PRODUCTION DESTINATION BLOCK)
  // ============================================================
  section('TEST 10: Config Safety on Forbidden Channels');
  const runtime10 = new VideoPipelineRuntime({
    enabled: true,
    acquisitionUrl: 'http://127.0.0.1:8080/',
    stagingChatId: '@ccsfvk', // Protected production channel
    autoPublish: true
  });
  const val10 = runtime10._validateConfiguration();
  check('Configuration validator strictly rejects production channel @ccsfvk', val10.valid === false);
  check('start() refuses to run against production channel', runtime10.start().status === 'CONFIG_ERROR');

  // Missing staging with autoPublish=true
  const runtime10B = new VideoPipelineRuntime({
    enabled: true,
    acquisitionUrl: 'http://127.0.0.1:8080/',
    stagingChatId: null,
    autoPublish: true
  });
  check('Missing staging destination with autoPublish=true is rejected', runtime10B.start().status === 'CONFIG_ERROR');

  // ============================================================
  // TEST 11: CLEAN RESTART & RE-INSTANTIATION
  // ============================================================
  section('TEST 11: Clean Restart and Re-instantiation');
  _resetRuntimeInstanceForTesting();
  const runtime11A = getVideoPipelineRuntime({
    enabled: true,
    acquisitionUrl: 'http://127.0.0.1:8080/',
    stagingChatId: '-1009990001',
    batchCycleManager: mockBatchCycleManager
  });
  runtime11A.start();
  check('Runtime 11A started', runtime11A.isStarted() === true);

  await runtime11A.stop();
  check('Runtime 11A stopped', runtime11A.isStarted() === false);

  _resetRuntimeInstanceForTesting();
  const runtime11B = getVideoPipelineRuntime({
    enabled: true,
    acquisitionUrl: 'http://127.0.0.1:8080/',
    stagingChatId: '-1009990001',
    batchCycleManager: mockBatchCycleManager
  });
  check('New runtime 11B created cleanly after reset', runtime11B.isStarted() === false);
  runtime11B.start();
  check('New runtime 11B started cleanly', runtime11B.isStarted() === true);
  await runtime11B.stop();
  _resetRuntimeInstanceForTesting();

  console.log('\n============================================================');
  console.log(`RUNTIME SUITE RESULT: ${passed} passed, ${failed} failed`);
  console.log('============================================================\n');

    if (failed > 0) {
      process.exit(1);
    }
  } finally {
    if (hadProxyConfig && fs.existsSync(proxyBackupPath)) {
      fs.renameSync(proxyBackupPath, proxyConfigPath);
      console.log('Restored video-tools/.proxy.local.json.');
    }
  }
}

runRuntimeTests().catch(err => {
  console.error('[TEST_RUNTIME] Unexpected error:', err);
  process.exit(1);
});
