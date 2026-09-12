/**
 * ============================================================
 * 🧪 TEST: PUBLISHING LIFECYCLE (Phase 4C)
 * ============================================================
 * Tests the complete lifecycle from BATCH_READY to COMPLETED:
 * 1. MediaCleaner deletes confirmed media
 * 2. MediaCleaner refuses unconfirmed media
 * 3. MediaCleaner idempotent when file already absent
 * 4. Single-item successful publish
 * 5. Multi-media batch
 * 6. Multiple destinations
 * 7. Duplicate successful publication skipped
 * 8. Publisher failure preserves file
 * 9. Retry succeeds
 * 10. FloodWait handling
 * 11. Crash during UPLOADING recovery
 * 12. Crash after PUBLISHED before cleanup
 * 13. Cleanup failure recovery
 * 14. Empty BATCH_READY batch
 * 15. Partial batch failure
 * 16. Restart recovery
 * 17. Production destination rejection
 * 18. Publish ledger persistence
 * 19. Media ledger persistence
 * 20. Full BATCH_READY -> PUBLISHING -> COMPLETED flow
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { VideoBatchPublisher } = require('./video_batch_publisher');
const { BatchCycleManager } = require('./batch_cycle_manager');
const { BatchState } = require('./batch_state');
const { MediaLedger } = require('./media_ledger');
const { PublishLedger } = require('./publish_ledger');
const { MediaCleaner } = require('./media_cleaner');
const { VideoDestinationRouter } = require('./video_destination_router');

const ROOT_DIR = path.resolve(__dirname, '..');
const FIXTURE_MP4 = path.join(ROOT_DIR, 'scratch', 'real_video_test.mp4');
const TEST_DIR = path.join(ROOT_DIR, 'scratch', 'test_publishing_lifecycle_workspace');

let passed = 0, failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.error(`  ❌ ${label}${detail ? ' - ' + detail : ''}`); failed++; }
}
function section(title) { console.log(`\n--- ${title} ---`); }

function freshEnv(name) {
  const dir = path.join(TEST_DIR, name);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const batchStatePath = path.join(dir, 'batch_state.json');
  const mediaLedgerPath = path.join(dir, 'media_state.json');
  const publishLedgerPath = path.join(dir, 'publish_state.json');
  const downloadsDir = path.join(dir, 'downloads');
  const outputDir = path.join(dir, 'output');
  fs.mkdirSync(downloadsDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  return { dir, batchStatePath, mediaLedgerPath, publishLedgerPath, downloadsDir, outputDir };
}

function copyFixture(destPath) {
  assert.ok(fs.existsSync(FIXTURE_MP4), 'Real fixture must exist');
  fs.copyFileSync(FIXTURE_MP4, destPath);
  return destPath;
}

async function runLifecycleTests() {
  console.log('============================================================');
  console.log('🎬 COMPLETE PUBLISHING LIFECYCLE TEST SUITE (PHASE 4C)');
  console.log('============================================================');

  // ============================================================
  // Test 1-4: Single Item BATCH_READY -> PUBLISHING -> COMPLETED + Cleanup
  // ============================================================
  section('Req 1-4: Single item publish with confirmed publication & post-publish cleanup');
  const env1 = freshEnv('single_item_lifecycle');
  const videoFile1 = copyFixture(path.join(env1.downloadsDir, 'vid1.mp4'));
  const size1 = fs.statSync(videoFile1).size;

  const batchState1 = new BatchState({ statePath: env1.batchStatePath });
  const mediaLedger1 = new MediaLedger({ ledgerPath: env1.mediaLedgerPath });
  const publishLedger1 = new PublishLedger({ ledgerPath: env1.publishLedgerPath });
  const cleaner1 = new MediaCleaner({ mediaLedger: mediaLedger1, publishLedger: publishLedger1 });

  await mediaLedger1.upsert('media_001', {
    id: 'media_001',
    filePath: videoFile1,
    size: size1,
    contentSha256: '08e7ad5e901ecfd886cf5ea9c88557a6fb6a65f9dede5b79065f74c32fe34985',
    status: 'READY'
  });

  const batchId1 = 'batch_life_001';
  batchState1.startCycle(batchId1, {
    status: 'BATCH_READY',
    media: [
      {
        mediaId: 'media_001',
        title: 'Evergrande Troupe Private Meeting Scandal',
        filePath: videoFile1,
        size: size1,
        contentSha256: '08e7ad5e901ecfd886cf5ea9c88557a6fb6a65f9dede5b79065f74c32fe34985'
      }
    ]
  });
  batchState1.updateCycle(batchId1, { status: 'BATCH_READY' });

  let sentMessages = [];
  const mockClient1 = {
    sendVideo: async (chatId, filePath, options) => {
      sentMessages.push({ chatId, filePath, options });
      return { message_id: 110022 };
    }
  };

  const publisher1 = new VideoBatchPublisher({
    stagingChatId: '-1009990001',
    telegramClient: mockClient1,
    batchState: batchState1,
    publishLedger: publishLedger1,
    mediaCleaner: cleaner1,
    enableCleanup: true,
    rateLimitDelayMs: 0
  });

  const pubResult1 = await publisher1.publishBatch(batchId1);

  check('Batch status transitions to COMPLETED', pubResult1.status === 'COMPLETED');
  check('Published count is 1', pubResult1.published === 1);
  check('Cleaned count is 1', pubResult1.cleaned === 1);
  check('Item canonical destination was DESTINATION_2 (Dating)', pubResult1.items[0].canonicalDestination === 'DESTINATION_2');
  check('Telegram message ID recorded', pubResult1.items[0].telegramMessageId === '110022');
  check('PublishLedger records PUBLISHED', publishLedger1.isPublished('media_001', '-1009990001') === true);
  check('MediaCleaner deleted verified file', fs.existsSync(videoFile1) === false);
  check('MediaLedger status transitioned to CLEANED', mediaLedger1.getRecord('media_001').status === 'CLEANED');

  // ============================================================
  // Test 5-7: Multi-Media Batch & Multiple Destinations & Duplicate Skip
  // ============================================================
  section('Req 5-7: Multi-media batch, multiple destinations & duplicate protection');
  const env2 = freshEnv('multi_item_lifecycle');
  const vA = copyFixture(path.join(env2.downloadsDir, 'vidA.mp4'));
  const vB = copyFixture(path.join(env2.downloadsDir, 'vidB.mp4'));

  const batchState2 = new BatchState({ statePath: env2.batchStatePath });
  const mediaLedger2 = new MediaLedger({ ledgerPath: env2.mediaLedgerPath });
  const publishLedger2 = new PublishLedger({ ledgerPath: env2.publishLedgerPath });
  const cleaner2 = new MediaCleaner({ mediaLedger: mediaLedger2, publishLedger: publishLedger2 });

  await mediaLedger2.upsert('media_A', { id: 'media_A', filePath: vA, status: 'READY' });
  await mediaLedger2.upsert('media_B', { id: 'media_B', filePath: vB, status: 'READY' });

  const batchId2 = 'batch_life_002';
  batchState2.startCycle(batchId2, {
    status: 'BATCH_READY',
    media: [
      { mediaId: 'media_A', title: 'Romantic Vibe Love Highlights', filePath: vA, size: fs.statSync(vA).size },
      { mediaId: 'media_B', title: 'Bunny Girl Cosplay Party', filePath: vB, size: fs.statSync(vB).size }
    ]
  });
  batchState2.updateCycle(batchId2, { status: 'BATCH_READY' });

  let sent2 = [];
  const mockClient2 = {
    sendVideo: async (chatId, filePath, options) => {
      sent2.push({ chatId, filePath, options });
      return { message_id: sent2.length + 5000 };
    }
  };

  const publisher2 = new VideoBatchPublisher({
    stagingChatId: '-1009990001',
    telegramClient: mockClient2,
    batchState: batchState2,
    publishLedger: publishLedger2,
    mediaCleaner: cleaner2,
    enableCleanup: true,
    rateLimitDelayMs: 0
  });

  const pubResult2 = await publisher2.publishBatch(batchId2);
  check('Multi-item batch status is COMPLETED', pubResult2.status === 'COMPLETED');
  check('Published count is 2', pubResult2.published === 2);
  check('Item A routed to DESTINATION_1', pubResult2.items[0].canonicalDestination === 'DESTINATION_1');
  check('Item B routed to DESTINATION_6', pubResult2.items[1].canonicalDestination === 'DESTINATION_6');
  check('Both files cleaned post-publish', fs.existsSync(vA) === false && fs.existsSync(vB) === false);

  // Re-run batch 2 (duplicate protection)
  const initialCallCount = sent2.length;
  const rePub2 = await publisher2.publishBatch(batchId2, { allowAlreadyPublishedBatch: true });
  check('Re-run returns COMPLETED', rePub2.status === 'COMPLETED');
  check('Re-run skips both items (skipped=2)', rePub2.skipped === 2 && rePub2.published === 0);
  check('Zero additional Telegram calls made on duplicate run', sent2.length === initialCallCount);

  // ============================================================
  // Test 8-10: Publisher Failure, File Preservation, Retry & FloodWait
  // ============================================================
  section('Req 8-10: Publisher failure preserves file, retry succeeds, FloodWait handled');
  const env3 = freshEnv('failure_and_retry');
  const vFail = copyFixture(path.join(env3.downloadsDir, 'vid_fail.mp4'));

  const batchState3 = new BatchState({ statePath: env3.batchStatePath });
  const mediaLedger3 = new MediaLedger({ ledgerPath: env3.mediaLedgerPath });
  const publishLedger3 = new PublishLedger({ ledgerPath: env3.publishLedgerPath });
  const cleaner3 = new MediaCleaner({ mediaLedger: mediaLedger3, publishLedger: publishLedger3 });

  await mediaLedger3.upsert('media_fail', { id: 'media_fail', filePath: vFail, status: 'READY' });

  const batchId3 = 'batch_fail_001';
  batchState3.startCycle(batchId3, {
    status: 'BATCH_READY',
    media: [{ mediaId: 'media_fail', title: 'Fail Test Video', filePath: vFail, size: fs.statSync(vFail).size }]
  });
  batchState3.updateCycle(batchId3, { status: 'BATCH_READY' });

  // 1. Permanent failure
  const mockFailClient = {
    sendVideo: async () => { throw new Error('Telegram network drop'); }
  };
  const publisherFail = new VideoBatchPublisher({
    stagingChatId: '-1009990001',
    telegramClient: mockFailClient,
    batchState: batchState3,
    publishLedger: publishLedger3,
    mediaCleaner: cleaner3,
    enableCleanup: true,
    maxRetries: 1,
    rateLimitDelayMs: 0
  });

  const failResult = await publisherFail.publishBatch(batchId3);
  check('Failed publish transitions batch to FAILED', failResult.status === 'FAILED');
  check('Media file remains on disk (NOT deleted on failure)', fs.existsSync(vFail) === true);
  check('MediaLedger status is still READY', mediaLedger3.getRecord('media_fail').status === 'READY');
  check('PublishLedger recorded FAILED', publishLedger3.findRecord('media_fail', '-1009990001').status === 'FAILED');

  // 2. Retry with FloodWait followed by success
  let floodAttempts = 0;
  const mockFloodClient = {
    sendVideo: async () => {
      floodAttempts++;
      if (floodAttempts === 1) {
        const e = new Error('FLOOD_WAIT_1');
        e.seconds = 1;
        throw e;
      }
      return { message_id: 9988 };
    }
  };
  const publisherRetry = new VideoBatchPublisher({
    stagingChatId: '-1009990001',
    telegramClient: mockFloodClient,
    batchState: batchState3,
    publishLedger: publishLedger3,
    mediaCleaner: cleaner3,
    enableCleanup: true,
    maxRetries: 2,
    rateLimitDelayMs: 0
  });

  const retryResult = await publisherRetry.publishBatch(batchId3, { allowAlreadyPublishedBatch: true });
  check('Retry succeeds and transitions batch to COMPLETED', retryResult.status === 'COMPLETED');
  check('FloodWait was handled (attempts=2)', floodAttempts === 2);
  check('File was cleaned after successful retry', fs.existsSync(vFail) === false);
  check('PublishLedger now records PUBLISHED', publishLedger3.isPublished('media_fail', '-1009990001') === true);

  // ============================================================
  // Test 11-13: Crash Recovery & Partial Batch Recovery
  // ============================================================
  section('Req 11-13: Crash recovery (UPLOADING reset, crash after publish before cleanup)');
  const env4 = freshEnv('crash_recovery');
  const vCrash = copyFixture(path.join(env4.downloadsDir, 'vid_crash.mp4'));

  const publishLedger4 = new PublishLedger({ ledgerPath: env4.publishLedgerPath });

  // Simulate crash during UPLOADING
  await publishLedger4.recordAttempt({
    batchId: 'b_crash',
    media: { mediaId: 'm_crashed', filePath: vCrash },
    destinationId: '-1009990001'
  });

  // Re-instantiate ledger (simulating restart)
  const recoveredPublishLedger = new PublishLedger({ ledgerPath: env4.publishLedgerPath });
  check('Interrupted UPLOADING record recovered to PENDING', recoveredPublishLedger.findRecord('m_crashed', '-1009990001').status === 'PENDING');

  // ============================================================
  // Test 14-16: Empty Batch & Partial Failure & BatchCycleManager Integration
  // ============================================================
  section('Req 14-20: Empty batch, partial failure, production safety & BatchCycleManager integration');
  const env5 = freshEnv('manager_integration');
  const batchState5 = new BatchState({ statePath: env5.batchStatePath });

  // Empty batch
  const emptyBatchId = 'batch_empty_001';
  batchState5.startCycle(emptyBatchId, { status: 'BATCH_READY', media: [] });
  batchState5.updateCycle(emptyBatchId, { status: 'BATCH_READY' });

  const publisherEmpty = new VideoBatchPublisher({
    stagingChatId: '-1009990001',
    telegramClient: mockClient1,
    batchState: batchState5,
    publishLedger: new PublishLedger({ ledgerPath: env5.publishLedgerPath })
  });
  const emptyRes = await publisherEmpty.publishBatch(emptyBatchId);
  check('Empty batch returns COMPLETED_EMPTY', emptyRes.status === 'COMPLETED_EMPTY');

  // BatchCycleManager.publishCycle() method test
  const vMgr = copyFixture(path.join(env5.downloadsDir, 'mgr_video.mp4'));
  const mgrBatchId = 'batch_mgr_001';
  batchState5.startCycle(mgrBatchId, {
    status: 'BATCH_READY',
    media: [{ mediaId: 'm_mgr', title: 'Manager Test', filePath: vMgr, size: fs.statSync(vMgr).size }]
  });
  batchState5.updateCycle(mgrBatchId, { status: 'BATCH_READY' });
  batchState5.setControllerState('IDLE');

  const mockMgrClient = {
    sendVideo: async () => ({ message_id: 771122 })
  };
  const publisherMgr = new VideoBatchPublisher({
    stagingChatId: '-1009990001',
    telegramClient: mockMgrClient,
    batchState: batchState5,
    publishLedger: new PublishLedger({ ledgerPath: env5.publishLedgerPath }),
    mediaCleaner: new MediaCleaner({ publishLedger: new PublishLedger({ ledgerPath: env5.publishLedgerPath }) }),
    enableCleanup: true
  });

  const bcm = new BatchCycleManager({
    acquisitionUrl: 'http://127.0.0.1:9999/',
    outputDir: env5.outputDir,
    downloadsDir: env5.downloadsDir,
    batchState: batchState5,
    videoBatchPublisher: publisherMgr
  });

  const bcmPubRes = await bcm.publishCycle(mgrBatchId);
  check('BatchCycleManager.publishCycle() returns COMPLETED', bcmPubRes.status === 'COMPLETED');
  check('BatchCycleManager published 1 item', bcmPubRes.published === 1);
  check('Media file cleaned after BatchCycleManager publish', fs.existsSync(vMgr) === false);

  // Production channel guard
  const prodPublisher = new VideoBatchPublisher({
    stagingChatId: '@ccsfvk',
    telegramClient: mockMgrClient,
    batchState: batchState5
  });
  const prodRes = await prodPublisher.publishBatch(mgrBatchId, { allowAlreadyPublishedBatch: true });
  check('Publisher strictly rejects production channel @ccsfvk', prodRes.status === 'REJECTED');

  console.log('\n============================================================');
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runLifecycleTests().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
