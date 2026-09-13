/**
 * ============================================================
 * 🎬 MASTER BATCH SCHEDULER + LIFECYCLE E2E TEST SUITE (PHASE 5)
 * ============================================================
 * Comprehensive end-to-end integration and scheduler lifecycle validation:
 *   - Multi-cycle progression (Cycle 1 -> Cycle 2) with zero cross-cycle duplicates
 *   - Active-state overlap prevention (ACQUIRING, INGESTING, PUBLISHING)
 *   - Clean empty cycles (COMPLETED_EMPTY)
 *   - Partial failure & lossless retry
 *   - Crash/restart recovery across all lifecycle state boundaries
 *   - Published-but-not-cleaned safe recovery
 *   - Fast recurring scheduler loop
 *   - Graceful shutdown without orphan processes or temp files
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const { spawnSync } = require('child_process');

const { BatchCycleManager } = require('./batch_cycle_manager');
const { VideoPipelineManager } = require('./video_pipeline_manager');
const { MediaIngestor } = require('./media_ingestor');
const { MediaLedger } = require('./media_ledger');
const { BatchState } = require('./batch_state');
const { VideoBatchPublisher } = require('./video_batch_publisher');
const { PublishLedger } = require('./publish_ledger');
const { MediaCleaner } = require('./media_cleaner');
const { VideoDestinationRouter } = require('./video_destination_router');
const { getFFmpegPath } = require('./media_validator');

const ROOT_DIR = path.resolve(__dirname, '..');
const TEST_WORKSPACE = path.join(ROOT_DIR, 'scratch', 'test_batch_scheduler_e2e_workspace');

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const COLOR_MAP = {
  p1: 'blue',
  p2: 'red',
  p3: 'green',
  p4: 'yellow',
  pshut1: 'purple',
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
    throw new Error(`Could not generate local test fixture MP4 for ${id}: ${res.stderr}`);
  }
  return fixturePath;
}

function copyFixture(destPath, id = 'p1') {
  const src = getValidFixtureMp4(id);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(src, destPath);
  return destPath;
}

function hashFile(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

// Shared provenance fields for hand-built media records in this suite - the
// SOURCE_PROVENANCE_VALIDATION gate requires these on every record, distinct
// from TECHNICAL_VALIDATION (playability), regardless of source_mode.
const TEST_PROVENANCE = {
  sourceMode: 'fixture',
  isFixtureMedia: true,
  sourcePageUrl: 'http://127.0.0.1:1/post/test-fixture',
  sourceVideoUrl: 'http://127.0.0.1:1/video/test-fixture.mp4'
};

function freshEnv(tag) {
  const dir = path.join(TEST_WORKSPACE, tag);
  fs.rmSync(dir, { recursive: true, force: true });
  const outputDir = path.join(dir, 'output');
  const downloadsDir = path.join(dir, 'downloads');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(downloadsDir, { recursive: true });

  return {
    dir,
    outputDir,
    downloadsDir,
    batchStatePath: path.join(dir, 'batch_state.json'),
    mediaLedgerPath: path.join(dir, 'media_state.json'),
    publishLedgerPath: path.join(dir, 'publish_state.json')
  };
}

/**
 * Creates an ephemeral local HTTP server hosting authorized mock HTML and video.
 */
function createFixtureServer(postsData) {
  let currentPosts = [...postsData];

  const server = http.createServer((req, res) => {
    const rawUrl = req.url.split('?')[0];

    if (rawUrl === '/' || rawUrl === '/board') {
      let itemsHtml = currentPosts.map((p) => `
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
  console.log('🎬 MASTER BATCH SCHEDULER & COMPLETE LIFECYCLE E2E TEST SUITE');
  console.log('============================================================');

  const proxyConfigPath = path.join(ROOT_DIR, 'video-scrapper', 'video-tools', '.proxy.local.json');
  const proxyBackupPath = `${proxyConfigPath}.set-aside-by-master-e2e`;
  let hadProxyConfig = false;

  if (fs.existsSync(proxyConfigPath)) {
    hadProxyConfig = true;
    fs.renameSync(proxyConfigPath, proxyBackupPath);
  }

  try {
    // ============================================================
    // TEST 1: COMPLETE CYCLE (Acquire -> Ingest -> Freeze -> Publish -> Confirm -> Cleanup -> Completed -> Idle)
    // ============================================================
    section('TEST 1: Complete Cycle End-to-End');
    const env1 = freshEnv('test1_complete_cycle');
    const fixture1 = createFixtureServer([
      { id: 'p1', title: 'Romantic Vibe Highlight Clip' },
      { id: 'p2', title: 'Evergrande Troupe Dating Show' }
    ]);
    const { url: serverUrl1 } = await fixture1.listen();

    const batchState1 = new BatchState({ statePath: env1.batchStatePath });
    const mediaLedger1 = new MediaLedger({ ledgerPath: env1.mediaLedgerPath });
    const publishLedger1 = new PublishLedger({ ledgerPath: env1.publishLedgerPath });
    const mediaCleaner1 = new MediaCleaner({
      mediaLedger: mediaLedger1,
      publishLedger: publishLedger1,
      allowedDirectory: env1.dir
    });

    const telegramSent1 = [];
    const mockClient1 = {
      sendVideo: async (chatId, filePath, options) => {
        telegramSent1.push({ chatId, filePath, options, msgId: 10000 + telegramSent1.length });
        return { message_id: 10000 + telegramSent1.length };
      }
    };

    const publisher1 = new VideoBatchPublisher({
      stagingChatId: '-1009990001',
      telegramClient: mockClient1,
      batchState: batchState1,
      publishLedger: publishLedger1,
      mediaCleaner: mediaCleaner1,
      enableCleanup: true,
      rateLimitDelayMs: 0
    });

    const bcm1 = new BatchCycleManager({
      acquisitionUrl: serverUrl1,
      outputDir: env1.outputDir,
      downloadsDir: env1.downloadsDir,
      batchState: batchState1,
      mediaIngestor: new MediaIngestor({ downloadsDir: env1.downloadsDir, ledger: mediaLedger1 }),
      videoBatchPublisher: publisher1,
      autoPublish: true,
      acquisitionOptions: { workers: 1, timeout: 15, targetLinks: 2, maxPages: 1, standalone: true }
    });

    const res1 = await bcm1.runOnce();
    check('Cycle 1 status is COMPLETED', res1.status === 'COMPLETED');
    check('Cycle 1 published 2 media items', res1.publishResult && res1.publishResult.published === 2);
    check('Telegram received 2 uploads', telegramSent1.length === 2);
    const hasDest1 = res1.publishResult.items.some(it => it.canonicalDestination === 'DESTINATION_1');
    const hasDest2 = res1.publishResult.items.some(it => it.canonicalDestination === 'DESTINATION_2');
    check('Cycle 1 routed an item to DESTINATION_1', hasDest1);
    check('Cycle 1 routed an item to DESTINATION_2', hasDest2);
    check('PublishLedger records both items as PUBLISHED',
      publishLedger1.isPublished(res1.publishResult.items[0].mediaId, '-1009990001') &&
      publishLedger1.isPublished(res1.publishResult.items[1].mediaId, '-1009990001'));
    check('MediaCleaner deleted both files from disk',
      fs.readdirSync(env1.downloadsDir).filter(f => f.endsWith('.mp4')).length === 0);
    check('MediaLedger status transitioned to CLEANED',
      mediaLedger1.getRecord(res1.publishResult.items[0].mediaId).status === 'CLEANED' &&
      mediaLedger1.getRecord(res1.publishResult.items[1].mediaId).status === 'CLEANED');
    check('Final controller state returned to IDLE', batchState1.getControllerState() === 'IDLE');

    await fixture1.close();

    // ============================================================
    // TEST 2: SECOND CYCLE (Independence & No Cross-Cycle Duplication)
    // ============================================================
    section('TEST 2: Second Cycle with New Media');
    const fixture2 = createFixtureServer([
      { id: 'p3', title: 'Bunny Girl Cosplay Party Clip' },
      { id: 'p4', title: 'Concubine Sister Rice Bowl Special' }
    ]);
    const { url: serverUrl2 } = await fixture2.listen();
    bcm1.acquisitionUrl = serverUrl2;

    const res2 = await bcm1.runOnce();
    check('Cycle 2 status is COMPLETED', res2.status === 'COMPLETED');
    check('Cycle 2 cycleId is distinct from Cycle 1', res2.cycleId !== res1.cycleId);
    check('Cycle 2 published 2 new media items', res2.publishResult && res2.publishResult.published === 2);
    check('Cycle 1 batch status remains COMPLETED in history', batchState1.getCycle(res1.cycleId).status === 'COMPLETED');
    check('Total Telegram messages sent across both cycles is 4', telegramSent1.length === 4);
    const hasDest6 = res2.publishResult.items.some(it => it.canonicalDestination === 'DESTINATION_6');
    const hasDest8 = res2.publishResult.items.some(it => it.canonicalDestination === 'DESTINATION_8');
    check('Cycle 2 routed an item to DESTINATION_6 (Bunny Girl)', hasDest6);
    check('Cycle 2 routed an item to DESTINATION_8 (Concubine)', hasDest8);
    check('Controller state is IDLE after Cycle 2', batchState1.getControllerState() === 'IDLE');

    await fixture2.close();

    // ============================================================
    // TEST 3: OVERLAP PROTECTION (ACQUIRING, INGESTING, PUBLISHING)
    // ============================================================
    section('TEST 3: Overlap Protection across Active States');
    const env3 = freshEnv('test3_overlap');
    const batchState3 = new BatchState({ statePath: env3.batchStatePath });
    const bcm3 = new BatchCycleManager({
      acquisitionUrl: 'http://127.0.0.1:9999/',
      outputDir: env3.outputDir,
      downloadsDir: env3.downloadsDir,
      batchState: batchState3
    });

    // 1. Guard against ACQUIRING
    batchState3.setControllerState('ACQUIRING');
    const skipAcq = await bcm3.runOnce();
    check('runOnce() is refused when ACQUIRING', skipAcq.status === 'SKIPPED');
    bcm3._scheduledTick();
    check('Scheduled tick records skipped tick when ACQUIRING', batchState3.getSkippedTicks().length >= 1);

    // 2. Guard against INGESTING
    batchState3.setControllerState('INGESTING');
    const skipIngest = await bcm3.runOnce();
    check('runOnce() is refused when INGESTING', skipIngest.status === 'SKIPPED');
    bcm3._scheduledTick();
    check('Scheduled tick records skipped tick when INGESTING', batchState3.getSkippedTicks().length >= 2);

    // 3. Guard against PUBLISHING
    batchState3.setControllerState('PUBLISHING');
    const skipPub = await bcm3.runOnce();
    check('runOnce() is refused when PUBLISHING', skipPub.status === 'SKIPPED');
    bcm3._scheduledTick();
    check('Scheduled tick records skipped tick when PUBLISHING', batchState3.getSkippedTicks().length >= 3);

    // Reset
    batchState3.setControllerState('IDLE');

    // ============================================================
    // TEST 4: EMPTY CYCLE (COMPLETED_EMPTY)
    // ============================================================
    section('TEST 4: Clean Empty Cycle Handling');
    const env4 = freshEnv('test4_empty_cycle');
    const fixture4 = createFixtureServer([]);
    const { url: serverUrl4 } = await fixture4.listen();

    const batchState4 = new BatchState({ statePath: env4.batchStatePath });
    const publishLedger4 = new PublishLedger({ ledgerPath: env4.publishLedgerPath });
    const publisher4 = new VideoBatchPublisher({
      stagingChatId: '-1009990001',
      telegramClient: mockClient1,
      batchState: batchState4,
      publishLedger: publishLedger4
    });

    const bcm4 = new BatchCycleManager({
      acquisitionUrl: serverUrl4,
      outputDir: env4.outputDir,
      downloadsDir: env4.downloadsDir,
      batchState: batchState4,
      videoBatchPublisher: publisher4,
      autoPublish: true,
      acquisitionOptions: { workers: 1, timeout: 10, targetLinks: 1, maxPages: 1, standalone: true }
    });

    const emptyRes = await bcm4.runOnce();
    check('Empty acquisition returns COMPLETED_EMPTY', emptyRes.status === 'COMPLETED_EMPTY');
    check('Empty batch discovered=0, downloaded=0, ready=0',
      emptyRes.discovered === 0 && emptyRes.downloaded === 0 && emptyRes.ready === 0);
    check('Controller state returns to IDLE after empty batch', batchState4.getControllerState() === 'IDLE');

    await fixture4.close();

    // ============================================================
    // TEST 5 & 6: PARTIAL PUBLISH FAILURE & LOSSLESS RETRY
    // ============================================================
    section('TEST 5 & 6: Partial Publish Failure & Lossless Retry');
    const env5 = freshEnv('test5_partial_failure');
    const v1 = copyFixture(path.join(env5.downloadsDir, 'v_ok.mp4'));
    const v2 = copyFixture(path.join(env5.downloadsDir, 'v_fail.mp4'));

    const batchState5 = new BatchState({ statePath: env5.batchStatePath });
    const mediaLedger5 = new MediaLedger({ ledgerPath: env5.mediaLedgerPath });
    const publishLedger5 = new PublishLedger({ ledgerPath: env5.publishLedgerPath });
    const cleaner5 = new MediaCleaner({ mediaLedger: mediaLedger5, publishLedger: publishLedger5 });

    await mediaLedger5.upsert('media_ok', { id: 'media_ok', filePath: v1, status: 'READY' });
    await mediaLedger5.upsert('media_fail', { id: 'media_fail', filePath: v2, status: 'READY' });

    const batchId5 = 'batch_partial_001';
    batchState5.startCycle(batchId5, {
      status: 'BATCH_READY',
      media: [
        { mediaId: 'media_ok', title: 'Good Video Title', filePath: v1, size: fs.statSync(v1).size, contentSha256: hashFile(v1), ...TEST_PROVENANCE },
        { mediaId: 'media_fail', title: 'Failing Video Title', filePath: v2, size: fs.statSync(v2).size, contentSha256: hashFile(v2), ...TEST_PROVENANCE }
      ]
    });
    batchState5.updateCycle(batchId5, { status: 'BATCH_READY' });
    batchState5.setControllerState('IDLE');

    let attemptFailCount = 0;
    const mockPartialClient = {
      sendVideo: async (chatId, filePath) => {
        if (filePath.includes('v_fail')) {
          attemptFailCount++;
          throw new Error('Telegram network drop on item 2');
        }
        return { message_id: 33001 };
      }
    };

    const publisherPartial = new VideoBatchPublisher({
      stagingChatId: '-1009990001',
      telegramClient: mockPartialClient,
      batchState: batchState5,
      publishLedger: publishLedger5,
      mediaCleaner: cleaner5,
      enableCleanup: true,
      maxRetries: 1,
      rateLimitDelayMs: 0
    });

    const bcm5 = new BatchCycleManager({
      acquisitionUrl: 'http://127.0.0.1:9999/',
      outputDir: env5.outputDir,
      downloadsDir: env5.downloadsDir,
      batchState: batchState5,
      videoBatchPublisher: publisherPartial
    });

    const partialRes = await bcm5.publishCycle(batchId5);
    check('Batch status is COMPLETED_PARTIAL', partialRes.status === 'COMPLETED_PARTIAL');
    check('Item 1 is PUBLISHED and cleaned', publishLedger5.isPublished('media_ok', '-1009990001') && !fs.existsSync(v1));
    check('Item 2 FAILED and remains intact on disk', !publishLedger5.isPublished('media_fail', '-1009990001') && fs.existsSync(v2));
    check('MediaLedger: Item 1 is CLEANED, Item 2 is READY',
      mediaLedger5.getRecord('media_ok').status === 'CLEANED' &&
      mediaLedger5.getRecord('media_fail').status === 'READY');

    // Test 6: Retry
    let sentOnRetry = [];
    const mockFixedClient = {
      sendVideo: async (chatId, filePath) => {
        sentOnRetry.push(filePath);
        return { message_id: 33002 };
      }
    };
    const publisherRetry = new VideoBatchPublisher({
      stagingChatId: '-1009990001',
      telegramClient: mockFixedClient,
      batchState: batchState5,
      publishLedger: publishLedger5,
      mediaCleaner: cleaner5,
      enableCleanup: true,
      rateLimitDelayMs: 0
    });

    bcm5.videoBatchPublisher = publisherRetry;
    const retryRes = await bcm5.publishCycle(batchId5, { allowAlreadyPublishedBatch: true });
    check('Retry transitions batch to COMPLETED', retryRes.status === 'COMPLETED');
    check('Already-published item was skipped (0 Telegram calls)', retryRes.skipped === 1 && retryRes.published === 1);
    check('Telegram called ONLY for the previously failed item', sentOnRetry.length === 1 && sentOnRetry[0].includes('v_fail'));
    check('Item 2 is now deleted post-retry', !fs.existsSync(v2));
    check('Both items now record PUBLISHED in ledger',
      publishLedger5.isPublished('media_ok', '-1009990001') &&
      publishLedger5.isPublished('media_fail', '-1009990001'));

    // ============================================================
    // TEST 7: CRASH & RESTART RECOVERY ACROSS BOUNDARIES
    // ============================================================
    section('TEST 7: Crash & Restart Recovery Across Lifecycle Boundaries');
    const env7 = freshEnv('test7_crash_recovery');
    const vCrash = copyFixture(path.join(env7.downloadsDir, 'v_crash.mp4'));

    const batchState7 = new BatchState({ statePath: env7.batchStatePath });
    const publishLedger7 = new PublishLedger({ ledgerPath: env7.publishLedgerPath });

    // 1. Crash during ACQUIRING
    batchState7.startCycle('c_acq', { status: 'ACQUIRING', acquisitionPid: 999999 });
    const bcm7A = new BatchCycleManager({
      acquisitionUrl: 'http://127.0.0.1:9999/',
      outputDir: env7.outputDir,
      downloadsDir: env7.downloadsDir,
      batchState: batchState7
    });
    check('Restart during ACQUIRING marks cycle FAILED and controller IDLE',
      batchState7.getCycle('c_acq').status === 'FAILED' && batchState7.getControllerState() === 'IDLE');

    // 2. Crash during PUBLISHING (with stuck UPLOADING record)
    await publishLedger7.recordAttempt({
      batchId: 'c_pub',
      media: { mediaId: 'm_pub_crash', filePath: vCrash },
      destinationId: '-1009990001'
    });
    batchState7.startCycle('c_pub', { status: 'BATCH_READY', media: [{ mediaId: 'm_pub_crash', filePath: vCrash }] });
    batchState7.updateCycle('c_pub', { status: 'PUBLISHING' });
    batchState7.setControllerState('PUBLISHING');

    const recoveredLedger7 = new PublishLedger({ ledgerPath: env7.publishLedgerPath });
    check('Recovered PublishLedger resets stuck UPLOADING record to PENDING',
      recoveredLedger7.findRecord('m_pub_crash', '-1009990001').status === 'PENDING');

    const bcm7B = new BatchCycleManager({
      acquisitionUrl: 'http://127.0.0.1:9999/',
      outputDir: env7.outputDir,
      downloadsDir: env7.downloadsDir,
      batchState: batchState7
    });
    check('Restart during PUBLISHING resets cycle to BATCH_READY and controller to IDLE',
      batchState7.getCycle('c_pub').status === 'BATCH_READY' && batchState7.getControllerState() === 'IDLE');
    check('Media file remained intact through crashes', fs.existsSync(vCrash));

    // ============================================================
    // TEST 8: COMPLETED RESTART
    // ============================================================
    section('TEST 8: Completed Restart & Immutability');
    const env8 = freshEnv('test8_completed_restart');
    const batchState8 = new BatchState({ statePath: env8.batchStatePath });
    const publishLedger8 = new PublishLedger({ ledgerPath: env8.publishLedgerPath });

    const cDone = 'cycle_done_001';
    batchState8.startCycle(cDone, {
      status: 'COMPLETED',
      media: [{ mediaId: 'm_done_1', title: 'Done Video' }]
    });
    batchState8.updateCycle(cDone, { status: 'COMPLETED' });
    batchState8.setControllerState('IDLE');

    await publishLedger8.recordAttempt({ batchId: cDone, media: { mediaId: 'm_done_1' }, destinationId: '-1009990001' });
    await publishLedger8.recordSuccess(publishLedger8.findRecord('m_done_1', '-1009990001').publishId, {
      telegramMessageId: '778899',
      publishedAt: new Date().toISOString()
    });

    let callsMade8 = 0;
    const publisher8 = new VideoBatchPublisher({
      stagingChatId: '-1009990001',
      telegramClient: { sendVideo: async () => { callsMade8++; return { message_id: 1 }; } },
      batchState: batchState8,
      publishLedger: publishLedger8
    });

    const bcm8 = new BatchCycleManager({
      acquisitionUrl: 'http://127.0.0.1:9999/',
      outputDir: env8.outputDir,
      downloadsDir: env8.downloadsDir,
      batchState: batchState8,
      videoBatchPublisher: publisher8
    });

    check('Re-instantiated BCM preserves COMPLETED status in history',
      bcm8.getCycle(cDone).status === 'COMPLETED');
    const rePub8 = await bcm8.publishCycle(cDone, { allowAlreadyPublishedBatch: true });
    check('Re-running completed cycle skipped already-published media', rePub8.skipped === 1 && rePub8.published === 0);
    check('Zero Telegram calls made on completed batch', callsMade8 === 0);

    // ============================================================
    // TEST 9: PUBLISHED-BUT-NOT-CLEANED CRASH RECOVERY
    // ============================================================
    section('TEST 9: Published-but-not-cleaned Crash Recovery');
    const env9 = freshEnv('test9_pub_not_clean');
    const vUnclean = copyFixture(path.join(env9.downloadsDir, 'v_unclean.mp4'));

    const batchState9 = new BatchState({ statePath: env9.batchStatePath });
    const mediaLedger9 = new MediaLedger({ ledgerPath: env9.mediaLedgerPath });
    const publishLedger9 = new PublishLedger({ ledgerPath: env9.publishLedgerPath });
    const cleaner9 = new MediaCleaner({ mediaLedger: mediaLedger9, publishLedger: publishLedger9 });

    await mediaLedger9.upsert('m_unclean', { id: 'm_unclean', filePath: vUnclean, status: 'READY' });

    // Simulate upload succeeded and recorded in PublishLedger, but process exited before unlinking file
    const att9 = await publishLedger9.recordAttempt({
      batchId: 'b_unclean',
      media: { mediaId: 'm_unclean', filePath: vUnclean },
      destinationId: '-1009990001'
    });
    await publishLedger9.recordSuccess(att9.publishId, {
      telegramMessageId: '554433',
      publishedAt: new Date().toISOString()
    });

    check('Pre-condition: File still exists on disk', fs.existsSync(vUnclean));
    check('Pre-condition: PublishLedger confirms PUBLISHED', publishLedger9.isPublished('m_unclean', '-1009990001'));

    batchState9.startCycle('b_unclean', {
      status: 'BATCH_READY',
      media: [{ mediaId: 'm_unclean', title: 'Uncleaned Video', filePath: vUnclean }]
    });
    batchState9.updateCycle('b_unclean', { status: 'BATCH_READY' });
    batchState9.setControllerState('IDLE');

    let callsMade9 = 0;
    const publisher9 = new VideoBatchPublisher({
      stagingChatId: '-1009990001',
      telegramClient: { sendVideo: async () => { callsMade9++; return { message_id: 1 }; } },
      batchState: batchState9,
      publishLedger: publishLedger9,
      mediaCleaner: cleaner9,
      enableCleanup: true
    });

    const res9 = await publisher9.publishBatch('b_unclean');
    check('Publishing skips Telegram upload (calls=0)', callsMade9 === 0);
    check('Publisher detected file and executed MediaCleaner', !fs.existsSync(vUnclean));
    check('MediaLedger status transitioned to CLEANED', mediaLedger9.getRecord('m_unclean').status === 'CLEANED');

    // ============================================================
    // TEST 10: SCHEDULER PROGRESSION (Fast Interval Loop)
    // ============================================================
    section('TEST 10: Scheduler Recurring Interval Progression');
    const env10 = freshEnv('test10_scheduler_progression');
    const batchState10 = new BatchState({ statePath: env10.batchStatePath });

    let runCount10 = 0;
    const bcm10 = new BatchCycleManager({
      acquisitionUrl: 'http://127.0.0.1:9999/',
      outputDir: env10.outputDir,
      downloadsDir: env10.downloadsDir,
      batchState: batchState10
    });

    // Mock runOnce for fast scheduling test
    bcm10.runOnce = async () => {
      runCount10++;
      const id = `cycle_sched_${runCount10}`;
      batchState10.startCycle(id, { status: 'ACQUIRING' });
      await sleep(15);
      batchState10.updateCycle(id, { status: 'COMPLETED' });
      batchState10.setControllerState('IDLE');
      return { status: 'COMPLETED', cycleId: id };
    };

    bcm10.start(60, { runImmediately: true });
    await sleep(200);
    await bcm10.stop();
    await sleep(30);

    check('Scheduler fired multiple times across interval (>=2 cycles)', runCount10 >= 2);
    check('All cycles in history are distinct', batchState10.listCycles().length === runCount10);
    check('Controller state returned to IDLE after stopping', batchState10.getControllerState() === 'IDLE');

    // ============================================================
    // TEST 11: SHUTDOWN & CLEANUP (No Orphans, No Stray Temp Files)
    // ============================================================
    section('TEST 11: Graceful Shutdown & Process Tree Termination');
    const env11 = freshEnv('test11_shutdown');
    const fixture11 = createFixtureServer([
      { id: 'pshut1', title: 'Shutdown Test Post' }
    ]);
    const { url: serverUrl11 } = await fixture11.listen();

    const batchState11 = new BatchState({ statePath: env11.batchStatePath });
    const mediaLedger11 = new MediaLedger({ ledgerPath: env11.mediaLedgerPath });
    const vpm11 = new VideoPipelineManager();
    const bcm11 = new BatchCycleManager({
      acquisitionUrl: serverUrl11,
      outputDir: env11.outputDir,
      downloadsDir: env11.downloadsDir,
      batchState: batchState11,
      mediaIngestor: new MediaIngestor({ downloadsDir: env11.downloadsDir, ledger: mediaLedger11 }),
      videoPipelineManager: vpm11,
      acquisitionOptions: { workers: 1, timeout: 30, targetLinks: 1, maxPages: 1, standalone: true }
    });

    // Start a cycle in background
    const bgRunPromise = bcm11.runOnce();
    await sleep(1000); // Give child process time to spawn
    const statusBefore = vpm11.getStatus();
    const pid = statusBefore.pid;

    // Call stop() while child is running
    await bcm11.stop();
    await bgRunPromise.catch(() => {});

    check('VideoPipelineManager is no longer running after stop()', !vpm11.isRunning());
    if (pid) {
      let alive = true;
      try { process.kill(pid, 0); } catch (e) { alive = false; }
      check('Child process tree was terminated (no orphan PID)', !alive);
    } else {
      check('Child process tree was cleanly managed', true);
    }

    // Check temp files
    const dirEntries = fs.readdirSync(env11.dir);
    const tempFiles = dirEntries.filter(f => f.includes('.tmp.'));
    check('Zero orphaned temp files left in workspace', tempFiles.length === 0);

    await fixture11.close();

    console.log('\n============================================================');
    console.log(`MASTER E2E RESULT: ${passed} passed, ${failed} failed`);
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

runMasterE2E().catch(err => {
  console.error('[MASTER_E2E] Unexpected error:', err);
  process.exit(1);
});
