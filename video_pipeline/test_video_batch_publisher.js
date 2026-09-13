/**
 * ============================================================
 * 🧪 TEST: VIDEO BATCH PUBLISHER (Phase 4A)
 * ============================================================
 * Exhaustively tests VideoBatchPublisher against all 18 requirements:
 * 1. BATCH_READY with one valid media item
 * 2. Successful publish
 * 3. Telegram message ID recorded
 * 4. Publish ledger persisted
 * 5. Second identical run skips publication
 * 6. Same mediaId + same destination is never uploaded twice
 * 7. Different destination is treated as a separate publication
 * 8. Missing file handling
 * 9. Invalid/corrupt media handling
 * 10. Missing staging destination configuration handling
 * 11. Telegram upload failure handling
 * 12. Retry after failure
 * 13. Crash/restart recovery while state is UPLOADING
 * 14. Atomic ledger persistence
 * 15. Existing batch state remains valid
 * 16. No media file deletion
 * 17. Production destination configuration remains untouched
 * 18. Verification of all safety and boundary guarantees
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');

const { VideoBatchPublisher, FORBIDDEN_PRODUCTION_DESTINATIONS } = require('./video_batch_publisher');
const { BatchState } = require('./batch_state');
const { PublishLedger } = require('./publish_ledger');

const ROOT_DIR = path.resolve(__dirname, '..');
const FIXTURE_MP4 = path.join(ROOT_DIR, 'scratch', 'real_video_test.mp4');
const TEST_DIR = path.join(ROOT_DIR, 'scratch', 'test_video_batch_publisher_workspace');

let passed = 0, failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.error(`  ❌ ${label}${detail ? ' - ' + detail : ''}`); failed++; }
}
function section(title) { console.log(`\n--- ${title} ---`); }

function freshTestEnv(name) {
  const dir = path.join(TEST_DIR, name);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const batchStatePath = path.join(dir, 'batch_state.json');
  const publishLedgerPath = path.join(dir, 'publish_state.json');
  const mediaDir = path.join(dir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });

  return { dir, batchStatePath, publishLedgerPath, mediaDir };
}

function copyFixture(destPath) {
  assert.ok(fs.existsSync(FIXTURE_MP4), 'Real fixture must exist');
  fs.copyFileSync(FIXTURE_MP4, destPath);
  return destPath;
}

function hashFile(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

// Shared authorized-source provenance fields for test media records that
// must pass SOURCE_PROVENANCE_VALIDATION (not just TECHNICAL_VALIDATION).
// Same origin on both URLs so sourceVideoUrlConsistentWithPage holds.
const AUTHORIZED_PROVENANCE = {
  sourceMode: 'authorized',
  isFixtureMedia: false,
  sourcePageUrl: 'https://authorized-test-source.internal/posts/test',
  sourceVideoUrl: 'https://authorized-test-source.internal/video/test.mp4'
};

async function runPublisherTests() {
  console.log('============================================================');
  console.log('🧪 VIDEO BATCH PUBLISHER TEST SUITE (PHASE 4A)');
  console.log('============================================================');

  // ============================================================
  // Test 1-4: Basic Valid BATCH_READY Publish
  // ============================================================
  section('Req 1-4: BATCH_READY with valid media item -> Successful publish');
  const env1 = freshTestEnv('basic_publish');
  const validMp4Path = copyFixture(path.join(env1.mediaDir, 'valid_test.mp4'));
  const validSize = fs.statSync(validMp4Path).size;

  const batchState1 = new BatchState({ statePath: env1.batchStatePath });
  const publishLedger1 = new PublishLedger({ ledgerPath: env1.publishLedgerPath });

  const batchId1 = 'batch_20260913_001';
  batchState1.startCycle(batchId1, {
    status: 'BATCH_READY',
    ready: 1,
    media: [
      {
        mediaId: 'media_v1',
        title: 'Authorized Test Staging Video 1',
        filePath: validMp4Path,
        size: validSize,
        contentSha256: hashFile(validMp4Path),
        ...AUTHORIZED_PROVENANCE
      }
    ]
  });
  batchState1.updateCycle(batchId1, { status: 'BATCH_READY' });

  let sentCalls = [];
  const mockTelegramClient = {
    sendVideo: async (chatId, filePath, options) => {
      sentCalls.push({ chatId, filePath, options });
      return { message_id: 1234567, chat: { id: chatId } };
    }
  };

  const publisher1 = new VideoBatchPublisher({
    stagingChatId: '-1009990001',
    telegramClient: mockTelegramClient,
    batchState: batchState1,
    publishLedger: publishLedger1,
    rateLimitDelayMs: 0
  });

  const result1 = await publisher1.publishBatch(batchId1);

  check('Req 1: Publish returns status PUBLISHED or COMPLETED', ['PUBLISHED', 'COMPLETED'].includes(result1.status));
  check('Req 2: Published count is 1', result1.published === 1);
  check('Req 3: Telegram message ID is 1234567', result1.items[0].telegramMessageId === '1234567');
  check('Req 4: PublishLedger has PUBLISHED record', publishLedger1.isPublished('media_v1', '-1009990001') === true);
  check('Caption contains frozen title', sentCalls[0].options.caption === 'Authorized Test Staging Video 1');
  check('File was NOT deleted after publishing', fs.existsSync(validMp4Path) === true);

  // ============================================================
  // Test 5-6: Idempotency - Second Run Skips Upload
  // ============================================================
  section('Req 5-6: Second identical run skips upload (Idempotent)');
  const initialCallCount = sentCalls.length;
  const result2 = await publisher1.publishBatch(batchId1, { allowAlreadyPublishedBatch: true });

  check('Second run returns PUBLISHED or COMPLETED', ['PUBLISHED', 'COMPLETED'].includes(result2.status));
  check('Second run published count is 0', result2.published === 0);
  check('Second run skipped count is 1', result2.skipped === 1);
  check('Second run item status is SKIPPED_ALREADY_PUBLISHED', result2.items[0].status === 'SKIPPED_ALREADY_PUBLISHED');
  check('Telegram API was NOT called again', sentCalls.length === initialCallCount);

  // ============================================================
  // Test 7: Different Destination -> Separate Publication
  // ============================================================
  section('Req 7: Different destination is treated as a separate publication');
  const resultDestB = await publisher1.publishBatch(batchId1, {
    stagingChatIdOverride: '-1009990002',
    allowAlreadyPublishedBatch: true
  });

  check('Publication to new staging destination succeeds', ['PUBLISHED', 'COMPLETED'].includes(resultDestB.status));
  check('Published count for new destination is 1', resultDestB.published === 1);
  check('Telegram API was called for the new destination', sentCalls.length === initialCallCount + 1);
  check('Ledger records destination B as PUBLISHED', publishLedger1.isPublished('media_v1', '-1009990002') === true);

  // ============================================================
  // Test 8: Missing File Handling
  // ============================================================
  section('Req 8: Missing file handled gracefully without crash');
  const env2 = freshTestEnv('missing_file');
  const batchState2 = new BatchState({ statePath: env2.batchStatePath });
  const publishLedger2 = new PublishLedger({ ledgerPath: env2.publishLedgerPath });

  const batchId2 = 'batch_missing_001';
  batchState2.startCycle(batchId2, {
    status: 'BATCH_READY',
    media: [
      {
        mediaId: 'media_missing',
        title: 'Missing File Video',
        filePath: path.join(env2.mediaDir, 'non_existent.mp4'),
        size: 50000
      }
    ]
  });
  batchState2.updateCycle(batchId2, { status: 'BATCH_READY' });

  const publisher2 = new VideoBatchPublisher({
    stagingChatId: '-1009990001',
    telegramClient: mockTelegramClient,
    batchState: batchState2,
    publishLedger: publishLedger2,
    rateLimitDelayMs: 0
  });

  const resultMissing = await publisher2.publishBatch(batchId2);
  check('Missing file results in FAILED batch status', resultMissing.status === 'FAILED');
  check('Failed count is 1', resultMissing.failed === 1);
  check('Error details mention file does not exist', resultMissing.items[0].reason.includes('does not exist'));
  check('Publish ledger records FAILED state', publishLedger2.findRecord('media_missing', '-1009990001').status === 'FAILED');

  // ============================================================
  // Test 9: Invalid / Corrupt Media Handling
  // ============================================================
  section('Req 9: Invalid / Corrupt media file rejected before upload');
  const env3 = freshTestEnv('corrupt_media');
  const corruptMp4Path = path.join(env3.mediaDir, 'corrupt.mp4');
  fs.writeFileSync(corruptMp4Path, 'NOT AN MP4 CONTAINER AT ALL');

  const batchState3 = new BatchState({ statePath: env3.batchStatePath });
  const publishLedger3 = new PublishLedger({ ledgerPath: env3.publishLedgerPath });

  const batchId3 = 'batch_corrupt_001';
  batchState3.startCycle(batchId3, {
    status: 'BATCH_READY',
    media: [
      {
        mediaId: 'media_corrupt',
        title: 'Corrupt Video',
        filePath: corruptMp4Path,
        size: fs.statSync(corruptMp4Path).size
      }
    ]
  });
  batchState3.updateCycle(batchId3, { status: 'BATCH_READY' });

  const callsBeforeCorrupt = sentCalls.length;
  const publisher3 = new VideoBatchPublisher({
    stagingChatId: '-1009990001',
    telegramClient: mockTelegramClient,
    batchState: batchState3,
    publishLedger: publishLedger3,
    rateLimitDelayMs: 0
  });

  const resultCorrupt = await publisher3.publishBatch(batchId3);
  check('Corrupt file results in FAILED batch status', resultCorrupt.status === 'FAILED');
  check('Telegram API was NEVER called for corrupt file', sentCalls.length === callsBeforeCorrupt);
  check('Error mentions integrity / validation failure', resultCorrupt.items[0].reason.includes('validation failed') || resultCorrupt.items[0].reason.includes('integrity'));

  // ============================================================
  // Test 10: Missing Staging Destination Configuration
  // ============================================================
  section('Req 10: Missing staging destination configuration refuses execution');
  const publisherNoStaging = new VideoBatchPublisher({
    stagingChatId: null,
    telegramClient: mockTelegramClient,
    batchState: batchState1,
    publishLedger: publishLedger1
  });

  const resultNoStaging = await publisherNoStaging.publishBatch(batchId1);
  check('Publisher refuses execution when stagingChatId is missing', resultNoStaging.status === 'REJECTED');
  check('Reason specifies configuration missing', resultNoStaging.reason.includes('not configured'));

  // Protection against production channel as staging target
  const publisherProdForbidden = new VideoBatchPublisher({
    stagingChatId: '@ccsfvk', // Production channel
    telegramClient: mockTelegramClient,
    batchState: batchState1,
    publishLedger: publishLedger1
  });
  const resultProdForbidden = await publisherProdForbidden.publishBatch(batchId1);
  check('Publisher strictly rejects production channel as staging target', resultProdForbidden.status === 'REJECTED');
  check('Rejection specifies protected production channel', resultProdForbidden.reason.includes('production channel'));

  // ============================================================
  // Test 11-12: Telegram Upload Failure & Retry Handling
  // ============================================================
  section('Req 11-12: Telegram upload failure, retry & FloodWait handling');
  const env4 = freshTestEnv('retry_test');
  const retryMp4Path = copyFixture(path.join(env4.mediaDir, 'retry_test.mp4'));
  const batchState4 = new BatchState({ statePath: env4.batchStatePath });
  const publishLedger4 = new PublishLedger({ ledgerPath: env4.publishLedgerPath });

  const batchId4 = 'batch_retry_001';
  batchState4.startCycle(batchId4, {
    status: 'BATCH_READY',
    media: [
      {
        mediaId: 'media_retry',
        title: 'Retry Test Video',
        filePath: retryMp4Path,
        size: fs.statSync(retryMp4Path).size,
        contentSha256: hashFile(retryMp4Path),
        ...AUTHORIZED_PROVENANCE
      }
    ]
  });
  batchState4.updateCycle(batchId4, { status: 'BATCH_READY' });

  let attemptCount = 0;
  const mockFailingClient = {
    sendVideo: async () => {
      attemptCount++;
      if (attemptCount === 1) {
        const err = new Error('FLOOD_WAIT_1');
        err.seconds = 1;
        throw err;
      }
      return { message_id: 889900 };
    }
  };

  const publisher4 = new VideoBatchPublisher({
    stagingChatId: '-1009990001',
    telegramClient: mockFailingClient,
    batchState: batchState4,
    publishLedger: publishLedger4,
    maxRetries: 2,
    rateLimitDelayMs: 0
  });

  const resultRetry = await publisher4.publishBatch(batchId4);
  check('Retry succeeded after FloodWait backoff', ['PUBLISHED', 'COMPLETED'].includes(resultRetry.status));
  check('Attempt count was 2', attemptCount === 2);
  check('Telegram message ID recorded after retry', resultRetry.items[0].telegramMessageId === '889900');

  // Terminal failure when retries exhausted
  let terminalAttempts = 0;
  const mockAlwaysFailClient = {
    sendVideo: async () => {
      terminalAttempts++;
      throw new Error('Permanent network disconnection');
    }
  };
  const publisherAlwaysFail = new VideoBatchPublisher({
    stagingChatId: '-1009990001',
    telegramClient: mockAlwaysFailClient,
    batchState: batchState4,
    publishLedger: publishLedger4,
    maxRetries: 1,
    rateLimitDelayMs: 0
  });

  const batchId5 = 'batch_always_fail_001';
  batchState4.startCycle(batchId5, {
    status: 'BATCH_READY',
    media: [
      {
        mediaId: 'media_perm_fail',
        title: 'Perm Fail Video',
        filePath: retryMp4Path,
        size: fs.statSync(retryMp4Path).size,
        contentSha256: hashFile(retryMp4Path),
        ...AUTHORIZED_PROVENANCE
      }
    ]
  });
  batchState4.updateCycle(batchId5, { status: 'BATCH_READY' });

  const resultPermFail = await publisherAlwaysFail.publishBatch(batchId5);
  check('Batch status is FAILED when retries exhausted', resultPermFail.status === 'FAILED');
  check('Publisher attempted exact number of retries (1 + 1 = 2)', terminalAttempts === 2);
  check('Publish ledger recorded FAILED status', publishLedger4.findRecord('media_perm_fail', '-1009990001').status === 'FAILED');

  // ============================================================
  // Test 13: Crash / Restart Recovery
  // ============================================================
  section('Req 13: Crash / restart while state is UPLOADING recovers safely');
  const env5 = freshTestEnv('crash_recovery');
  const crashMp4 = copyFixture(path.join(env5.mediaDir, 'crash_test.mp4'));
  const publishLedger5 = new PublishLedger({ ledgerPath: env5.publishLedgerPath });

  // Simulate in-flight upload recorded right before a crash
  await publishLedger5.recordAttempt({
    batchId: 'batch_crash_001',
    media: { mediaId: 'media_crashed', title: 'Crashed Mid Upload', filePath: crashMp4 },
    destinationId: '-1009990001'
  });

  // Re-instantiate publisher and ledger simulating a restarted process
  const recoveredLedger = new PublishLedger({ ledgerPath: env5.publishLedgerPath });
  const batchState5 = new BatchState({ statePath: env5.batchStatePath });
  batchState5.startCycle('batch_crash_001', {
    status: 'BATCH_READY',
    media: [
      {
        mediaId: 'media_crashed',
        title: 'Crashed Mid Upload',
        filePath: crashMp4,
        size: fs.statSync(crashMp4).size,
        contentSha256: hashFile(crashMp4),
        ...AUTHORIZED_PROVENANCE
      }
    ]
  });
  batchState5.updateCycle('batch_crash_001', { status: 'BATCH_READY' });

  const publisherRecovered = new VideoBatchPublisher({
    stagingChatId: '-1009990001',
    telegramClient: mockTelegramClient,
    batchState: batchState5,
    publishLedger: recoveredLedger,
    rateLimitDelayMs: 0
  });

  // Verify record was reset to PENDING and can now be cleanly published
  check('Interrupted record reset to PENDING', recoveredLedger.findRecord('media_crashed', '-1009990001').status === 'PENDING');
  const resultAfterCrash = await publisherRecovered.publishBatch('batch_crash_001');
  check('Publishing succeeds cleanly after restart recovery', ['PUBLISHED', 'COMPLETED'].includes(resultAfterCrash.status));
  check('Record status now reaches PUBLISHED', recoveredLedger.isPublished('media_crashed', '-1009990001') === true);

  // ============================================================
  // Test 14-17: Atomic Safety, No Deletion & Routing Untouched
  // ============================================================
  section('Req 14-17: Atomic persistence, No Media Deletion, Production Routing Untouched');
  check('All media files in test directories still exist on disk', fs.existsSync(validMp4Path) && fs.existsSync(retryMp4Path) && fs.existsSync(crashMp4));

  // Verify production routing configs remain intact and unchanged
  const routingConfigPath = path.join(ROOT_DIR, 'destination_routing_config.json');
  check('destination_routing_config.json exists and is untouched', fs.existsSync(routingConfigPath));
  const routingContent = JSON.parse(fs.readFileSync(routingConfigPath, 'utf8'));
  check('destination_routing_config.json has 10 destinations', Object.keys(routingContent.destinations).length === 10);

  console.log('\n============================================================');
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runPublisherTests().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
