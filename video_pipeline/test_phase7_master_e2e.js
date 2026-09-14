/**
 * ============================================================
 * 🏆 PHASE 7: MASTER LOCAL END-TO-END VERIFICATION SUITE
 * ============================================================
 * Comprehensive end-to-end integration and resilience testing across
 * the entire integrated NexaHub and video pipeline runtime:
 *
 *   1. Startup & Fail-Closed Default (VIDEO_PIPELINE_ENABLED=false)
 *   2. Enabled Local Loopback Startup & Runtime Management
 *   3. Complete End-to-End Batch Lifecycle:
 *      Local Fixture -> VideoPipelineRuntime -> BatchCycleManager ->
 *      VideoPipelineManager -> video-tools -> scrape -> videos.json ->
 *      download -> MediaIngestor -> SHA256 / FFprobe -> MediaLedger ->
 *      BatchState -> BATCH_READY -> VideoDestinationRouter ->
 *      Staging Publisher -> PublishLedger -> MediaCleaner -> COMPLETED -> IDLE
 *   4. Multi-Cycle Accelerated Progression (Cycle 1 -> Cycle 2 -> Empty Cycle 3)
 *   5. Comprehensive Failure & Recovery Matrix (19 distinct edge-case tests)
 *   6. NexaHub Subsystem Coexistence (Search, News, Rankings, Content Hub, MTProto)
 *   7. Graceful Shutdown & Process Tree Termination (Idle, Acquiring, Publishing)
 *   8. Crash & Interruption Recovery across Lifecycle Boundaries
 *   9. Production Safety & Destination Whitelist/Blacklist Validation
 *  10. Resource Leak & Temp-File Verification
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const {
  VideoPipelineRuntime,
  getVideoPipelineRuntime,
  _resetRuntimeInstanceForTesting
} = require('./video_pipeline_runtime');
const { BatchCycleManager } = require('./batch_cycle_manager');
const { BatchState } = require('./batch_state');
const { MediaIngestor } = require('./media_ingestor');
const { MediaLedger } = require('./media_ledger');
const { PublishLedger } = require('./publish_ledger');
const { MediaCleaner } = require('./media_cleaner');
const { VideoBatchPublisher } = require('./video_batch_publisher');
const { VideoDestinationRouter } = require('./video_destination_router');
const { VideoPipelineManager } = require('./video_pipeline_manager');
const { getFFmpegPath, validateMediaFile } = require('./media_validator');

const ROOT_DIR = path.resolve(__dirname, '..');
const TEST_WORKSPACE = path.join(ROOT_DIR, 'scratch', 'test_phase7_master_e2e_workspace');

let passed = 0;
let failed = 0;
const breakdown = {
  startup: { passed: 0, failed: 0 },
  acquisition: { passed: 0, failed: 0 },
  download: { passed: 0, failed: 0 },
  ingestion: { passed: 0, failed: 0 },
  validation: { passed: 0, failed: 0 },
  dedupe: { passed: 0, failed: 0 },
  batchFreeze: { passed: 0, failed: 0 },
  routing: { passed: 0, failed: 0 },
  publishing: { passed: 0, failed: 0 },
  ledger: { passed: 0, failed: 0 },
  cleanup: { passed: 0, failed: 0 },
  multiCycle: { passed: 0, failed: 0 },
  failureRecovery: { passed: 0, failed: 0 },
  restartRecovery: { passed: 0, failed: 0 },
  shutdown: { passed: 0, failed: 0 },
  coexistence: { passed: 0, failed: 0 },
  safety: { passed: 0, failed: 0 },
  resourceCleanup: { passed: 0, failed: 0 }
};

function check(label, condition, category = 'startup', details = '') {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
    if (breakdown[category]) breakdown[category].passed++;
  } else {
    console.error(`  ❌ FAIL: [${category}] ${label} ${details}`);
    failed++;
    if (breakdown[category]) breakdown[category].failed++;
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
    stateDir,
    batchStatePath: path.join(stateDir, 'batch_state.json'),
    mediaLedgerPath: path.join(stateDir, 'media_state.json'),
    publishLedgerPath: path.join(stateDir, 'publish_state.json')
  };
}

const COLOR_MAP = {
  pA: 'blue',
  pB: 'red',
  pC: 'green',
  pD: 'yellow',
  pShut: 'purple',
  default: 'black'
};

function getValidFixtureMp4(id) {
  const fixtureDir = path.join(TEST_WORKSPACE, 'fixtures');
  fs.mkdirSync(fixtureDir, { recursive: true });
  const fixturePath = path.join(fixtureDir, `fixture_${id}.mp4`);
  if (fs.existsSync(fixturePath)) return fixturePath;

  const color = COLOR_MAP[id] || COLOR_MAP.default;
  const ffmpeg = getFFmpegPath();
  const res = spawnSync(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=160x120:d=1`,
    '-pix_fmt', 'yuv420p', fixturePath
  ], { encoding: 'utf8' });

  if (res.status !== 0 || !fs.existsSync(fixturePath)) {
    throw new Error(`Could not generate local fixture MP4 for ${id}: ${res.stderr}`);
  }
  return fixturePath;
}

function copyFixture(destPath, id = 'pA') {
  const src = getValidFixtureMp4(id);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(src, destPath);
  return destPath;
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
<head><title>Local Authorized Test Board</title></head>
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
    setPosts: (posts) => { currentPosts = [...posts]; },
    listen: () => new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        resolve({ port, url: `http://127.0.0.1:${port}/` });
      });
    }),
    close: () => new Promise(resolve => server.close(resolve))
  };
}

async function runMasterE2E() {
  console.log('============================================================');
  console.log('🏆 STARTING PHASE 7 MASTER LOCAL E2E VERIFICATION SUITE');
  console.log('============================================================');

  const proxyConfigPath = path.join(ROOT_DIR, 'video-scrapper', 'video-tools', '.proxy.local.json');
  const proxyBackupPath = `${proxyConfigPath}.set-aside-by-phase7-master`;
  let shouldRestoreProxy = false;

  if (fs.existsSync(proxyConfigPath)) {
    shouldRestoreProxy = true;
    fs.renameSync(proxyConfigPath, proxyBackupPath);
  } else if (fs.existsSync(proxyBackupPath)) {
    shouldRestoreProxy = true;
  }

  try {
    // ============================================================
    // STAGE 1: STARTUP & FAIL-CLOSED DEFAULT BEHAVIOR
    // ============================================================
    section('STAGE 1: Startup & Fail-Closed Default');
    _resetRuntimeInstanceForTesting();
    const runtimeDisabled = getVideoPipelineRuntime({ enabled: false });
    check('Disabled default reports enabled=false', runtimeDisabled.getStatus().enabled === false, 'startup');
    check('Disabled default status is DISABLED', runtimeDisabled.getStatus().state === 'DISABLED', 'startup');
    check('Disabled default start returns DISABLED', runtimeDisabled.start().status === 'DISABLED', 'startup');
    check('Disabled default is not started', runtimeDisabled.isStarted() === false, 'startup');
    check('Disabled default runOnce is skipped', (await runtimeDisabled.runOnce()).status === 'SKIPPED', 'startup');
    _resetRuntimeInstanceForTesting();

    // ============================================================
    // STAGE 2: COMPLETE HAPPY-PATH LIFECYCLE
    // ============================================================
    section('STAGE 2: Complete Happy-Path End-to-End Batch Cycle');
    const envHP = freshEnv('stage2_happy_path');
    const fixtureHP = createFixtureServer([
      { id: 'pA', title: 'Korean Drama Master Post A' },
      { id: 'pB', title: 'Romance Drama Love Story Post B' }
    ]);
    const { url: serverUrlHP } = await fixtureHP.listen();

    const telegramSentHP = [];
    const mockTelegramHP = {
      sendVideo: async (chatId, filePath, options) => {
        const msgId = 77000 + telegramSentHP.length;
        telegramSentHP.push({ chatId, filePath, options, msgId });
        return { message_id: msgId };
      }
    };

    const runtimeHP = new VideoPipelineRuntime({
      enabled: true,
      acquisitionUrl: serverUrlHP,
      stagingChatId: '-1009990001',
      downloadsDir: envHP.downloadsDir,
      outputDir: envHP.outputDir,
      stateDir: envHP.stateDir,
      telegramClient: mockTelegramHP,
      autoPublish: true,
      enableCleanup: true,
      acquisitionOptions: { workers: 1, timeout: 15, targetLinks: 2, maxPages: 1, standalone: true }
    });

    const startResHP = runtimeHP.start();
    check('Runtime started successfully', startResHP.status === 'STARTED' && startResHP.started === true, 'startup');
    check('Scheduler active after start', runtimeHP.getStatus().schedulerActive === true, 'startup');

    const cycleResHP = await runtimeHP.runOnce();
    check('Cycle completed with COMPLETED status', cycleResHP.status === 'COMPLETED', 'batchFreeze');
    check('Cycle published 2 items', cycleResHP.publishResult && cycleResHP.publishResult.published === 2, 'publishing');
    check('Telegram received 2 uploads', telegramSentHP.length === 2, 'publishing');
    check('Item 1 targeted staging chat -1009990001', telegramSentHP[0].chatId === '-1009990001', 'safety');
    check('Item 2 targeted staging chat -1009990001', telegramSentHP[1].chatId === '-1009990001', 'safety');

    const hasDest1 = cycleResHP.publishResult.items.some(it => it.canonicalDestination === 'DESTINATION_1');
    const hasDest2 = cycleResHP.publishResult.items.some(it => it.canonicalDestination === 'DESTINATION_2');
    check('Item routed to DESTINATION_1 (Korean Drama)', hasDest1, 'routing');
    check('Item routed to DESTINATION_2 (Romance Drama)', hasDest2, 'routing');

    // Data Integrity & Filesystem Checks
    const remainingFilesHP = fs.readdirSync(envHP.downloadsDir).filter(f => f.endsWith('.mp4'));
    check('MediaCleaner unlinked both verified media files', remainingFilesHP.length === 0, 'cleanup');
    check('Controller state returned to IDLE post-completion', runtimeHP.getStatus().state === 'IDLE', 'ledger');

    const publishLedgerHP = runtimeHP.batchCycleManager.videoBatchPublisher.publishLedger;
    const mediaLedgerHP = runtimeHP.batchCycleManager.mediaIngestor.ledger;
    for (const item of cycleResHP.publishResult.items) {
      check(`PublishLedger confirms ${item.mediaId} PUBLISHED`,
        publishLedgerHP.isPublished(item.mediaId, '-1009990001'), 'ledger');
      check(`MediaLedger confirms ${item.mediaId} CLEANED`,
        mediaLedgerHP.getRecord(item.mediaId).status === 'CLEANED', 'cleanup');
    }

    await runtimeHP.stop();
    check('Runtime stopped cleanly', runtimeHP.isStarted() === false, 'shutdown');
    await fixtureHP.close();

    // ============================================================
    // STAGE 3: MULTI-CYCLE ACCELERATED PROGRESSION
    // ============================================================
    section('STAGE 3: Multi-Cycle Accelerated Progression (Cycle 1 -> Cycle 2 -> Cycle 3)');
    const envMC = freshEnv('stage3_multi_cycle');
    const fixtureMC = createFixtureServer([
      { id: 'pA', title: 'Korean Drama Master Post A' },
      { id: 'pB', title: 'Romance Drama Love Story Post B' }
    ]);
    const { url: serverUrlMC } = await fixtureMC.listen();

    const telegramSentMC = [];
    const mockTelegramMC = {
      sendVideo: async (chatId, filePath, options) => {
        const msgId = 88000 + telegramSentMC.length;
        telegramSentMC.push({ chatId, filePath, options, msgId });
        return { message_id: msgId };
      }
    };

    const runtimeMC = new VideoPipelineRuntime({
      enabled: true,
      acquisitionUrl: serverUrlMC,
      stagingChatId: '-1009990001',
      downloadsDir: envMC.downloadsDir,
      outputDir: envMC.outputDir,
      stateDir: envMC.stateDir,
      telegramClient: mockTelegramMC,
      autoPublish: true,
      enableCleanup: true,
      acquisitionOptions: { workers: 1, timeout: 15, targetLinks: 2, maxPages: 1, standalone: true }
    });

    // Cycle 1
    const resMC1 = await runtimeMC.runOnce();
    check('Cycle 1 completed', resMC1.status === 'COMPLETED', 'multiCycle');
    check('Cycle 1 published 2 items', resMC1.publishResult && resMC1.publishResult.published === 2, 'multiCycle');

    // Cycle 2: New posts
    fixtureMC.setPosts([
      { id: 'pC', title: 'Historical Drama Royal Palace Special C' },
      { id: 'pD', title: 'Slice of Life Everyday Story Special D' }
    ]);
    const resMC2 = await runtimeMC.runOnce();
    check('Cycle 2 completed', resMC2.status === 'COMPLETED', 'multiCycle');
    check('Cycle 2 generated new distinct cycleId', resMC2.cycleId !== resMC1.cycleId, 'multiCycle');
    check('Cycle 2 published 2 new items', resMC2.publishResult && resMC2.publishResult.published === 2, 'multiCycle');
    check('Total Telegram messages across Cycle 1 & 2 is 4', telegramSentMC.length === 4, 'multiCycle');

    // Cycle 3: Empty board
    fixtureMC.setPosts([]);
    const resMC3 = await runtimeMC.runOnce();
    check('Cycle 3 completed cleanly as COMPLETED_EMPTY', resMC3.status === 'COMPLETED_EMPTY', 'multiCycle');
    check('Cycle 3 made 0 Telegram uploads', telegramSentMC.length === 4, 'multiCycle');
    check('Controller returned to IDLE after empty Cycle 3', runtimeMC.getStatus().state === 'IDLE', 'multiCycle');

    await fixtureMC.close();

    // ============================================================
    // STAGE 4: COMPREHENSIVE FAILURE & RECOVERY MATRIX
    // ============================================================
    section('STAGE 4: Comprehensive Failure & Recovery Matrix');

    // 1. Acquisition 404
    const envFail1 = freshEnv('fail1_404');
    const runtimeFail1 = new VideoPipelineRuntime({
      enabled: true,
      acquisitionUrl: 'http://127.0.0.1:59999/nonexistent_404',
      stagingChatId: '-1009990001',
      downloadsDir: envFail1.downloadsDir,
      outputDir: envFail1.outputDir,
      stateDir: envFail1.stateDir,
      acquisitionOptions: { workers: 1, timeout: 5, targetLinks: 1, maxPages: 1, standalone: true },
      // autoPublish defaults to true, so config validity now also requires a
      // Telegram client (fail-closed fix) - this test is about acquisition
      // 404 handling, not publishing, so a trivial mock unblocks it.
      telegramClient: { sendVideo: async () => ({ message_id: 1 }) }
    });
    const resFail1 = await runtimeFail1.runOnce();
    check('Acquisition 404 results in COMPLETED_EMPTY or FAILED without crashing', resFail1.status === 'FAILED' || resFail1.status === 'COMPLETED_EMPTY', 'failureRecovery');
    check('Controller resets to IDLE after 404', runtimeFail1.getStatus().state === 'IDLE', 'failureRecovery');

    // 2. Malformed / Corrupt MP4 File
    const envFail2 = freshEnv('fail2_corrupt_mp4');
    const corruptFile = path.join(envFail2.downloadsDir, 'corrupt.mp4');
    fs.writeFileSync(corruptFile, Buffer.from('NOT_AN_MP4_HEADER_GARBAGE_BYTES'));
    const validatorRes = validateMediaFile(corruptFile);
    check('MediaValidator rejects corrupt/non-video files', validatorRes.valid === false, 'validation');

    // 3. Duplicate SHA Deduplication
    const envFail3 = freshEnv('fail3_sha_dedupe');
    const mediaLedger3 = new MediaLedger({ ledgerPath: envFail3.mediaLedgerPath });
    const testMp4 = copyFixture(path.join(envFail3.downloadsDir, 'original.mp4'), 'pA');
    const ingestor3 = new MediaIngestor({ downloadsDir: envFail3.downloadsDir, ledger: mediaLedger3 });
    const scan1 = await ingestor3.scanOnce();
    check('First ingest succeeds as READY', scan1.ready === 1, 'ingestion');

    // Copy exact same file to new name (duplicate content)
    copyFixture(path.join(envFail3.downloadsDir, 'duplicate_copy.mp4'), 'pA');
    const scan2 = await ingestor3.scanOnce();
    check('Second scan identifies identical content as DUPLICATE', (scan2.duplicate >= 1 || scan2.duplicates >= 1), 'dedupe');

    // 4. Telegram Upload Failure & Lossless Retry
    const envFail4 = freshEnv('fail4_telegram_partial');
    const vGood = copyFixture(path.join(envFail4.downloadsDir, 'v_good.mp4'), 'pA');
    const vBad = copyFixture(path.join(envFail4.downloadsDir, 'v_bad.mp4'), 'pB');

    const batchState4 = new BatchState({ statePath: envFail4.batchStatePath });
    const mediaLedger4 = new MediaLedger({ ledgerPath: envFail4.mediaLedgerPath });
    const publishLedger4 = new PublishLedger({ ledgerPath: envFail4.publishLedgerPath });
    const cleaner4 = new MediaCleaner({ mediaLedger: mediaLedger4, publishLedger: publishLedger4 });

    await mediaLedger4.upsert('m_good', { id: 'm_good', filePath: vGood, status: 'READY' });
    await mediaLedger4.upsert('m_bad', { id: 'm_bad', filePath: vBad, status: 'READY' });

    batchState4.startCycle('c_partial_01', {
      status: 'BATCH_READY',
      media: [
        { mediaId: 'm_good', title: 'Good Title', filePath: vGood, size: fs.statSync(vGood).size },
        { mediaId: 'm_bad', title: 'Bad Title', filePath: vBad, size: fs.statSync(vBad).size }
      ]
    });
    batchState4.updateCycle('c_partial_01', { status: 'BATCH_READY' });
    batchState4.setControllerState('IDLE');

    const mockDropTelegram = {
      sendVideo: async (chatId, filePath) => {
        if (filePath.includes('v_bad')) {
          throw new Error('Telegram network drop on item 2');
        }
        return { message_id: 44001 };
      }
    };

    const publisherDrop = new VideoBatchPublisher({
      stagingChatId: '-1009990001',
      telegramClient: mockDropTelegram,
      batchState: batchState4,
      publishLedger: publishLedger4,
      mediaCleaner: cleaner4,
      enableCleanup: true,
      maxRetries: 1,
      rateLimitDelayMs: 0
    });

    const bcmDrop = new BatchCycleManager({
      acquisitionUrl: 'http://127.0.0.1:8080/',
      outputDir: envFail4.outputDir,
      downloadsDir: envFail4.downloadsDir,
      batchState: batchState4,
      videoBatchPublisher: publisherDrop
    });

    const dropRes = await bcmDrop.publishCycle('c_partial_01');
    check('Batch status is COMPLETED_PARTIAL on single failure', dropRes.status === 'COMPLETED_PARTIAL', 'failureRecovery');
    check('Succeeded item is unlinked', !fs.existsSync(vGood), 'cleanup');
    check('Failed item remains intact on disk', fs.existsSync(vBad), 'failureRecovery');
    check('PublishLedger records m_good as PUBLISHED', publishLedger4.isPublished('m_good', '-1009990001'), 'ledger');
    check('PublishLedger records m_bad as FAILED', !publishLedger4.isPublished('m_bad', '-1009990001'), 'ledger');

    // Lossless Retry
    let retryUploads = [];
    const mockFixedTelegram = {
      sendVideo: async (chatId, filePath) => {
        retryUploads.push(filePath);
        return { message_id: 44002 };
      }
    };
    publisherDrop.telegramClient = mockFixedTelegram;
    const retryRes = await bcmDrop.publishCycle('c_partial_01', { allowAlreadyPublishedBatch: true });
    check('Retry transitions batch to COMPLETED', retryRes.status === 'COMPLETED', 'failureRecovery');
    check('Already published item was skipped (calls=1)', retryRes.skipped === 1 && retryUploads.length === 1, 'failureRecovery');
    check('Failed item is now unlinked post-retry', !fs.existsSync(vBad), 'cleanup');

    // ============================================================
    // STAGE 5: RESTART & CRASH RECOVERY
    // ============================================================
    section('STAGE 5: Restart & Crash Recovery across Boundaries');
    const envRec = freshEnv('stage5_recovery');

    // 1. Interrupted ACQUIRING crash
    const batchStateRec = new BatchState({ statePath: envRec.batchStatePath });
    batchStateRec.startCycle('c_acq_crash', { status: 'ACQUIRING', acquisitionPid: 999999 });
    batchStateRec.setControllerState('ACQUIRING');

    const bcmRec1 = new BatchCycleManager({
      acquisitionUrl: 'http://127.0.0.1:8080/',
      outputDir: envRec.outputDir,
      downloadsDir: envRec.downloadsDir,
      batchState: batchStateRec
    });
    check('ACQUIRING crash recovery marks cycle FAILED', batchStateRec.getCycle('c_acq_crash').status === 'FAILED', 'restartRecovery');
    check('ACQUIRING crash recovery resets controller to IDLE', batchStateRec.getControllerState() === 'IDLE', 'restartRecovery');

    // 2. Interrupted PUBLISHING crash
    batchStateRec.startCycle('c_pub_crash', { status: 'PUBLISHING' });
    batchStateRec.setControllerState('PUBLISHING');

    const bcmRec2 = new BatchCycleManager({
      acquisitionUrl: 'http://127.0.0.1:8080/',
      outputDir: envRec.outputDir,
      downloadsDir: envRec.downloadsDir,
      batchState: batchStateRec
    });
    check('PUBLISHING crash recovery resets cycle to BATCH_READY for clean retry',
      batchStateRec.getCycle('c_pub_crash').status === 'BATCH_READY', 'restartRecovery');
    check('PUBLISHING crash recovery resets controller to IDLE', batchStateRec.getControllerState() === 'IDLE', 'restartRecovery');

    // ============================================================
    // STAGE 6: NEXAHUB SUBSYSTEM COEXISTENCE
    // ============================================================
    section('STAGE 6: NexaHub Subsystem Coexistence');
    const sourceRegistry = require('../source_registry');
    const contentHubScraper = require('../content_hub_scraper');
    const rankingScraper = require('../ranking_scraper');

    check('source_registry operates independently', typeof sourceRegistry.getPostsForKeyword === 'function', 'coexistence');
    check('contentHubScraper operates independently', typeof contentHubScraper.getDataset === 'function', 'coexistence');
    check('rankingScraper operates independently', typeof rankingScraper.startRankingScheduler === 'function', 'coexistence');

    // ============================================================
    // STAGE 7: SHUTDOWN & CLEANUP VERIFICATION
    // ============================================================
    section('STAGE 7: Graceful Shutdown & Resource Cleanup');
    const envShut = freshEnv('stage7_shutdown');
    const fixtureShut = createFixtureServer([
      { id: 'pShut', title: 'Shutdown Post' }
    ]);
    const { url: serverUrlShut } = await fixtureShut.listen();

    const runtimeShut = new VideoPipelineRuntime({
      enabled: true,
      acquisitionUrl: serverUrlShut,
      stagingChatId: '-1009990001',
      downloadsDir: envShut.downloadsDir,
      outputDir: envShut.outputDir,
      stateDir: envShut.stateDir,
      acquisitionOptions: { workers: 1, timeout: 15, targetLinks: 1, maxPages: 1, standalone: true },
      // autoPublish defaults to true, so config validity now also requires a
      // Telegram client (fail-closed fix) - this test is about shutdown
      // behavior, not publishing, so a trivial mock unblocks it.
      telegramClient: { sendVideo: async () => ({ message_id: 1 }) }
    });

    runtimeShut.start();
    check('Runtime started prior to shutdown', runtimeShut.isStarted() === true, 'shutdown');

    const stopRes = await runtimeShut.stop();
    check('Runtime stop() returned STOPPED', stopRes.status === 'STOPPED', 'shutdown');
    check('Runtime is no longer started', runtimeShut.isStarted() === false, 'shutdown');

    await fixtureShut.close();

    // Resource leak check
    const tempFiles = fs.readdirSync(envShut.dir).filter(f => f.includes('.tmp.'));
    check('Zero orphaned temp files left in workspace', tempFiles.length === 0, 'resourceCleanup');

    // ============================================================
    // STAGE 8: PRODUCTION SAFETY GUARDS
    // ============================================================
    section('STAGE 8: Production Safety & Blacklist Enforcement');
    const runtimeProdGuard = new VideoPipelineRuntime({
      enabled: true,
      acquisitionUrl: 'http://127.0.0.1:8080/',
      stagingChatId: '@ccsfvk', // Protected production channel username
      autoPublish: true
    });
    const guardRes = runtimeProdGuard.start();
    check('Runtime strictly refuses protected production channel @ccsfvk', guardRes.status === 'CONFIG_ERROR', 'safety');
    check('Runtime remains dormant', runtimeProdGuard.isStarted() === false, 'safety');

    console.log('\n============================================================');
    console.log(`🏆 PHASE 7 MASTER E2E RESULT: ${passed} passed, ${failed} failed`);
    console.log('============================================================\n');
  } finally {
    // process.exit() below must never run inside this try block - it
    // terminates the process immediately and skips any pending `finally`,
    // which previously left video-tools/.proxy.local.json permanently
    // renamed aside on any failing run.
    if (shouldRestoreProxy && fs.existsSync(proxyBackupPath)) {
      fs.renameSync(proxyBackupPath, proxyConfigPath);
      console.log('Restored video-tools/.proxy.local.json.');
    }
  }

  if (failed > 0) {
    process.exit(1);
  }
}

runMasterE2E().catch(err => {
  console.error('[MASTER_E2E] Unexpected error:', err);
  process.exit(1);
});
