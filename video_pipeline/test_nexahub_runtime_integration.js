/**
 * ============================================================
 * 🧪 NEXAHUB RUNTIME INTEGRATION TEST SUITE (PHASE 6C)
 * ============================================================
 * Validates the complete NexaHub runtime integration:
 *   - Disabled default behavior (fail-closed, dormant)
 *   - Enabled local startup with safe loopback endpoints
 *   - Startup failure isolation (zero parent process disruption)
 *   - Singleton integrity & duplicate start prevention
 *   - Local end-to-end batch execution (acquire -> ingest -> publish -> clean)
 *   - NexaHub subsystem coexistence
 *   - Safe shutdown during idle and active cycles
 *   - Forbidden production destination protection
 *   - Restart and recovery behavior
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
const TEST_WORKSPACE = path.join(ROOT_DIR, 'scratch', 'test_nexahub_runtime_integration_workspace');

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
    '-y', '-f', 'lavfi', '-i', 'color=c=magenta:s=160x120:d=1',
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
<head><title>NexaHub Integration Test Board</title></head>
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

async function runNexaHubIntegrationTests() {
  console.log('============================================================');
  console.log('🔗 NEXAHUB RUNTIME INTEGRATION TEST SUITE (PHASE 6C)');
  console.log('============================================================');

  const proxyConfigPath = path.join(ROOT_DIR, 'video-scrapper', 'video-tools', '.proxy.local.json');
  const proxyBackupPath = `${proxyConfigPath}.set-aside-by-nexahub-integration`;
  let hadProxyConfig = false;

  if (fs.existsSync(proxyConfigPath)) {
    hadProxyConfig = true;
    fs.renameSync(proxyConfigPath, proxyBackupPath);
  }

  try {
    // ============================================================
    // TEST 1: DISABLED STARTUP (FAIL-CLOSED DEFAULT)
    // ============================================================
    section('TEST 1: Disabled Startup (Default Behavior)');
    _resetRuntimeInstanceForTesting();
    const runtime1 = getVideoPipelineRuntime({ enabled: false });
    const status1 = runtime1.getStatus();
    check('Runtime reports enabled=false', status1.enabled === false);
    check('Runtime state is DISABLED', status1.state === 'DISABLED');
    check('Scheduler is not active', status1.schedulerActive === false);

    const startRes1 = runtime1.start();
    check('start() returns DISABLED status', startRes1.status === 'DISABLED' && startRes1.started === false);
    check('Runtime is not started', runtime1.isStarted() === false);

    const runRes1 = await runtime1.runOnce();
    check('runOnce() is safely skipped when disabled', runRes1.status === 'SKIPPED');
    _resetRuntimeInstanceForTesting();

    // ============================================================
    // TEST 2: ENABLED LOCAL STARTUP
    // ============================================================
    section('TEST 2: Enabled Local Startup');
    const env2 = freshEnv('test2_enabled');
    const mockBatchCycleManager2 = {
      startScheduler: () => {},
      stop: async () => {},
      isSchedulerActive: () => true,
      batchState: { getControllerState: () => 'IDLE', getCurrentCycleId: () => null },
      getLastCycleSummary: () => null,
      runOnce: async () => ({ status: 'COMPLETED' })
    };

    const runtime2 = new VideoPipelineRuntime({
      enabled: true,
      acquisitionUrl: 'http://127.0.0.1:8080/',
      stagingChatId: '-1009990001',
      downloadsDir: env2.downloadsDir,
      outputDir: env2.outputDir,
      stateDir: env2.stateDir,
      batchCycleManager: mockBatchCycleManager2
    });

    const startRes2 = runtime2.start();
    check('start() returns STARTED', startRes2.status === 'STARTED' && startRes2.started === true);
    check('isStarted() is true', runtime2.isStarted() === true);
    check('getStatus() reports state=IDLE and schedulerActive=true',
      runtime2.getStatus().state === 'IDLE' && runtime2.getStatus().schedulerActive === true);

    await runtime2.stop();
    check('isStarted() is false after stop', runtime2.isStarted() === false);

    // ============================================================
    // TEST 3: STARTUP FAILURE ISOLATION
    // ============================================================
    section('TEST 3: Startup Failure Isolation');
    const runtime3 = new VideoPipelineRuntime({
      enabled: true,
      acquisitionUrl: null, // missing required URL
      stagingChatId: '-1009990001'
    });

    let didThrow = false;
    let startRes3 = null;
    try {
      startRes3 = runtime3.start();
    } catch (e) {
      didThrow = true;
    }

    check('start() did not throw unhandled exception', didThrow === false);
    check('start() returned CONFIG_ERROR', startRes3 && startRes3.status === 'CONFIG_ERROR');
    check('Runtime is not started on config error', runtime3.isStarted() === false);

    // ============================================================
    // TEST 4: SINGLETON IDENTITY PRESERVATION
    // ============================================================
    section('TEST 4: Singleton Identity Preservation');
    _resetRuntimeInstanceForTesting();
    const instA = getVideoPipelineRuntime({ enabled: false });
    const instB = getVideoPipelineRuntime();
    check('Repeated getVideoPipelineRuntime calls return identical instance', instA === instB);
    _resetRuntimeInstanceForTesting();

    // ============================================================
    // TEST 5: DUPLICATE STARTUP PROTECTION
    // ============================================================
    section('TEST 5: Duplicate Startup Protection');
    let schedulerInvocations = 0;
    const mockBatchCycleManager5 = {
      startScheduler: () => { schedulerInvocations++; },
      stop: async () => {},
      isSchedulerActive: () => true,
      batchState: { getControllerState: () => 'IDLE', getCurrentCycleId: () => null },
      getLastCycleSummary: () => null,
      runOnce: async () => ({ status: 'COMPLETED' })
    };

    const runtime5 = new VideoPipelineRuntime({
      enabled: true,
      acquisitionUrl: 'http://127.0.0.1:8080/',
      stagingChatId: '-1009990001',
      batchCycleManager: mockBatchCycleManager5
    });

    runtime5.start();
    check('First start successful', runtime5.isStarted() === true);
    check('Scheduler invoked once', schedulerInvocations === 1);

    const dupRes = runtime5.start();
    check('Duplicate start returns ALREADY_STARTED', dupRes.status === 'ALREADY_STARTED');
    check('Scheduler was NOT duplicated', schedulerInvocations === 1);

    await runtime5.stop();

    // ============================================================
    // TEST 6: LOCAL RUNONCE END-TO-END DELEGATION
    // ============================================================
    section('TEST 6: Local runOnce End-to-End Cycle');
    const env6 = freshEnv('test6_local_run_once');
    const fixture6 = createFixtureServer([
      { id: 'nh_int1', title: 'Romantic Vibe NexaHub Integration Test Video' }
    ]);
    const { url: serverUrl6 } = await fixture6.listen();

    const telegramSent6 = [];
    const mockTelegram6 = {
      sendVideo: async (chatId, filePath, options) => {
        telegramSent6.push({ chatId, filePath, options, msgId: 991122 });
        return { message_id: 991122 };
      }
    };

    const runtime6 = new VideoPipelineRuntime({
      enabled: true,
      acquisitionUrl: serverUrl6,
      stagingChatId: '-1009990001',
      downloadsDir: env6.downloadsDir,
      outputDir: env6.outputDir,
      stateDir: env6.stateDir,
      telegramClient: mockTelegram6,
      autoPublish: true,
      enableCleanup: true,
      acquisitionOptions: { workers: 1, timeout: 15, targetLinks: 1, maxPages: 1, standalone: true }
    });

    const cycleResult6 = await runtime6.runOnce();
    check('runOnce() returned COMPLETED status', cycleResult6.status === 'COMPLETED');
    check('Cycle published 1 item', cycleResult6.publishResult && cycleResult6.publishResult.published === 1);
    check('Telegram received 1 staging upload', telegramSent6.length === 1);
    check('Item routed to staging channel -1009990001', telegramSent6[0].chatId === '-1009990001');
    check('MediaCleaner deleted verified file', fs.readdirSync(env6.downloadsDir).filter(f => f.endsWith('.mp4')).length === 0);

    await fixture6.close();

    // ============================================================
    // TEST 7: EXISTING SUBSYSTEM COEXISTENCE
    // ============================================================
    section('TEST 7: Existing Subsystem Coexistence');
    const sourceRegistry = require('../source_registry');
    const contentHubScraper = require('../content_hub_scraper');
    const rankingScraper = require('../ranking_scraper');

    check('source_registry is intact and exposes getPostsForKeyword', typeof sourceRegistry.getPostsForKeyword === 'function');
    check('contentHubScraper is intact and exposes getDataset', typeof contentHubScraper.getDataset === 'function');
    check('rankingScraper is intact and exposes startRankingScheduler', typeof rankingScraper.startRankingScheduler === 'function');

    // ============================================================
    // TEST 8: SHUTDOWN DURING IDLE
    // ============================================================
    section('TEST 8: Shutdown During Idle');
    const runtime8 = new VideoPipelineRuntime({
      enabled: true,
      acquisitionUrl: 'http://127.0.0.1:8080/',
      stagingChatId: '-1009990001',
      batchCycleManager: mockBatchCycleManager5
    });

    runtime8.start();
    check('Runtime 8 started', runtime8.isStarted() === true);
    const stopRes8 = await runtime8.stop();
    check('stop() returned STOPPED', stopRes8.status === 'STOPPED');
    check('Runtime 8 is no longer started', runtime8.isStarted() === false);

    // ============================================================
    // TEST 9: SHUTDOWN DURING ACTIVE CYCLE
    // ============================================================
    section('TEST 9: Shutdown During Active Acquisition Cycle');
    const env9 = freshEnv('test9_shutdown_active');
    const fixture9 = createFixtureServer([
      { id: 'nh_shut1', title: 'Romantic Vibe Shutdown Video' }
    ]);
    const { url: serverUrl9 } = await fixture9.listen();

    const runtime9 = new VideoPipelineRuntime({
      enabled: true,
      acquisitionUrl: serverUrl9,
      stagingChatId: '-1009990001',
      downloadsDir: env9.downloadsDir,
      outputDir: env9.outputDir,
      stateDir: env9.stateDir,
      acquisitionOptions: { workers: 1, timeout: 15, targetLinks: 1, maxPages: 1, standalone: true }
    });

    // Start cycle and stop immediately
    const runPromise = runtime9.runOnce();
    await new Promise(resolve => setTimeout(resolve, 300));
    const stopRes9 = await runtime9.stop();
    await runPromise;

    check('stop() during cycle completes cleanly', stopRes9.status === 'STOPPED' || stopRes9.status === 'NOT_RUNNING');
    check('Runtime 9 is not started after stop', runtime9.isStarted() === false);

    await fixture9.close();

    // ============================================================
    // TEST 10: PRODUCTION DESTINATION PROTECTION
    // ============================================================
    section('TEST 10: Production Destination Rejection');
    const runtime10 = new VideoPipelineRuntime({
      enabled: true,
      acquisitionUrl: 'http://127.0.0.1:8080/',
      stagingChatId: '@cccsefk', // Protected Dating channel
      autoPublish: true
    });
    const startRes10 = runtime10.start();
    check('start() rejected protected production channel with CONFIG_ERROR', startRes10.status === 'CONFIG_ERROR');
    check('Runtime was NOT started', runtime10.isStarted() === false);

    // ============================================================
    // TEST 11: RESTART & CRASH RECOVERY BEHAVIOR
    // ============================================================
    section('TEST 11: Restart & Crash Recovery');
    const env11 = freshEnv('test11_recovery');
    const batchStatePath11 = path.join(env11.stateDir, 'batch_state.json');
    const mediaLedgerPath11 = path.join(env11.stateDir, 'media_state.json');
    const publishLedgerPath11 = path.join(env11.stateDir, 'publish_state.json');

    // Pre-populate interrupted batch state
    const priorState = {
      state: 'PUBLISHING',
      currentCycleId: 'interrupted_cycle_001',
      skippedTicks: [],
      cycles: {
        interrupted_cycle_001: {
          cycleId: 'interrupted_cycle_001',
          status: 'PUBLISHING',
          startedAt: new Date().toISOString()
        }
      }
    };
    fs.writeFileSync(batchStatePath11, JSON.stringify(priorState, null, 2));

    const runtime11 = new VideoPipelineRuntime({
      enabled: true,
      acquisitionUrl: 'http://127.0.0.1:8080/',
      stagingChatId: '-1009990001',
      downloadsDir: env11.downloadsDir,
      outputDir: env11.outputDir,
      stateDir: env11.stateDir
    });

    runtime11._ensureManagerInitialized();
    const recoveredState = runtime11.batchCycleManager.batchState;
    check('Interrupted PUBLISHING cycle was reset to BATCH_READY for clean retry',
      recoveredState.getCycle('interrupted_cycle_001').status === 'BATCH_READY');
    check('Controller state was recovered to IDLE', recoveredState.getControllerState() === 'IDLE');

    console.log('\n============================================================');
    console.log(`NEXAHUB INTEGRATION SUITE RESULT: ${passed} passed, ${failed} failed`);
    console.log('============================================================\n');
  } finally {
    // process.exit() below must never run inside this try block - it
    // terminates the process immediately and skips any pending `finally`,
    // which previously left video-tools/.proxy.local.json permanently
    // renamed aside on any failing run.
    if (hadProxyConfig && fs.existsSync(proxyBackupPath)) {
      fs.renameSync(proxyBackupPath, proxyConfigPath);
      console.log('Restored video-tools/.proxy.local.json.');
    }
  }

  if (failed > 0) {
    process.exit(1);
  }
}

runNexaHubIntegrationTests().catch(err => {
  console.error('[NEXAHUB_INTEGRATION_TEST] Unexpected error:', err);
  process.exit(1);
});
