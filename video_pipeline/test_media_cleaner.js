/**
 * ============================================================
 * 🧪 TEST: MEDIA CLEANER (Phase 4C)
 * ============================================================
 * Verifies verified post-publish deletion, refusal of unconfirmed media,
 * idempotency, MediaLedger updates, and error handling.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { MediaCleaner } = require('./media_cleaner');
const { MediaLedger } = require('./media_ledger');
const { PublishLedger } = require('./publish_ledger');

const ROOT_DIR = path.resolve(__dirname, '..');
const FIXTURE_MP4 = path.join(ROOT_DIR, 'scratch', 'real_video_test.mp4');
const TEST_DIR = path.join(ROOT_DIR, 'scratch', 'test_media_cleaner_workspace');

let passed = 0, failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.error(`  ❌ ${label}${detail ? ' - ' + detail : ''}`); failed++; }
}
function section(title) { console.log(`\n--- ${title} ---`); }

function freshWorkspace(name) {
  const dir = path.join(TEST_DIR, name);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const mediaLedgerPath = path.join(dir, 'media_state.json');
  const publishLedgerPath = path.join(dir, 'publish_state.json');
  const mediaDir = path.join(dir, 'downloads');
  fs.mkdirSync(mediaDir, { recursive: true });

  return { dir, mediaLedgerPath, publishLedgerPath, mediaDir };
}

function copyFixture(destPath) {
  assert.ok(fs.existsSync(FIXTURE_MP4), 'Real fixture must exist');
  fs.copyFileSync(FIXTURE_MP4, destPath);
  return destPath;
}

async function runMediaCleanerTests() {
  console.log('============================================================');
  console.log('🧹 MEDIA CLEANER TEST SUITE (PHASE 4C)');
  console.log('============================================================');

  // ============================================================
  // Test 1: Verified Deletion of Confirmed Media
  // ============================================================
  section('Test 1: Deletes media file after confirmed publication in PublishLedger');
  const env1 = freshWorkspace('confirmed_cleanup');
  const mediaFile1 = copyFixture(path.join(env1.mediaDir, 'video1.mp4'));

  const mediaLedger1 = new MediaLedger({ ledgerPath: env1.mediaLedgerPath });
  const publishLedger1 = new PublishLedger({ ledgerPath: env1.publishLedgerPath });

  const mediaId1 = 'm_001';
  const destId1 = '-1009990001';

  await mediaLedger1.upsert(mediaId1, {
    id: mediaId1,
    filePath: mediaFile1,
    status: 'READY'
  });

  const attempt1 = await publishLedger1.recordAttempt({
    batchId: 'b1',
    media: { mediaId: mediaId1, filePath: mediaFile1 },
    destinationId: destId1
  });
  await publishLedger1.recordSuccess(attempt1.publishId, { telegramMessageId: '112233' });

  check('Pre-condition: PublishLedger confirms PUBLISHED', publishLedger1.isPublished(mediaId1, destId1) === true);
  check('Pre-condition: Media file exists before cleanup', fs.existsSync(mediaFile1) === true);

  const cleaner1 = new MediaCleaner({
    mediaLedger: mediaLedger1,
    publishLedger: publishLedger1,
    allowedDirectory: env1.dir
  });

  const cleanRes1 = await cleaner1.cleanMedia({
    mediaId: mediaId1,
    destinationId: destId1,
    filePath: mediaFile1
  });

  check('cleanMedia returns CLEANED status', cleanRes1.status === 'CLEANED');
  check('File was physically removed from disk', fs.existsSync(mediaFile1) === false);
  const updatedML1 = mediaLedger1.getRecord(mediaId1);
  check('MediaLedger status transitioned to CLEANED', updatedML1.status === 'CLEANED');
  check('MediaLedger records cleanedAt timestamp', Boolean(updatedML1.cleanedAt));

  // ============================================================
  // Test 2: Refusal of Unconfirmed Media
  // ============================================================
  section('Test 2: Refuses deletion when publication is NOT confirmed');
  const env2 = freshWorkspace('unconfirmed_refusal');
  const mediaFile2 = copyFixture(path.join(env2.mediaDir, 'video2.mp4'));

  const mediaLedger2 = new MediaLedger({ ledgerPath: env2.mediaLedgerPath });
  const publishLedger2 = new PublishLedger({ ledgerPath: env2.publishLedgerPath });

  const mediaId2 = 'm_002';
  const destId2 = '-1009990001';

  await mediaLedger2.upsert(mediaId2, {
    id: mediaId2,
    filePath: mediaFile2,
    status: 'READY'
  });

  // Attempt without success (UPLOADING / not published)
  await publishLedger2.recordAttempt({
    batchId: 'b2',
    media: { mediaId: mediaId2, filePath: mediaFile2 },
    destinationId: destId2
  });

  check('Pre-condition: PublishLedger isPublished is FALSE', publishLedger2.isPublished(mediaId2, destId2) === false);

  const cleaner2 = new MediaCleaner({
    mediaLedger: mediaLedger2,
    publishLedger: publishLedger2
  });

  const cleanRes2 = await cleaner2.cleanMedia({
    mediaId: mediaId2,
    destinationId: destId2,
    filePath: mediaFile2
  });

  check('cleanMedia returns REFUSED_UNCONFIRMED', cleanRes2.status === 'REFUSED_UNCONFIRMED');
  check('File remains intact on disk (NOT deleted)', fs.existsSync(mediaFile2) === true);
  check('MediaLedger status remains READY (untouched)', mediaLedger2.getRecord(mediaId2).status === 'READY');

  // ============================================================
  // Test 3: Idempotency (Already Removed File)
  // ============================================================
  section('Test 3: Idempotency when media file was already deleted');
  const cleanRes3 = await cleaner1.cleanMedia({
    mediaId: mediaId1,
    destinationId: destId1,
    filePath: mediaFile1
  });

  check('Second cleanup returns ALREADY_CLEANED', cleanRes3.status === 'ALREADY_CLEANED');
  check('MediaLedger remains CLEANED', mediaLedger1.getRecord(mediaId1).status === 'CLEANED');

  // ============================================================
  // Test 4: Path Safety Enforcement
  // ============================================================
  section('Test 4: Path safety boundary enforcement');
  const outOfBoundsFile = path.resolve(ROOT_DIR, 'scratch', 'some_outside_file.mp4');
  const cleanResOutOfBounds = await cleaner1.cleanMedia({
    mediaId: mediaId1,
    destinationId: destId1,
    filePath: outOfBoundsFile
  });

  check('Cleanup outside allowedDirectory returns FAILED', cleanResOutOfBounds.status === 'FAILED');
  check('Reason specifies path safety violation', cleanResOutOfBounds.reason.includes('Path safety violation'));

  // ============================================================
  // Test 5: Batch Cleaning (cleanBatch)
  // ============================================================
  section('Test 5: Batch cleaning multiple media items');
  const env5 = freshWorkspace('batch_cleaning');
  const fA = copyFixture(path.join(env5.mediaDir, 'vidA.mp4'));
  const fB = copyFixture(path.join(env5.mediaDir, 'vidB.mp4'));

  const mL5 = new MediaLedger({ ledgerPath: env5.mediaLedgerPath });
  const pL5 = new PublishLedger({ ledgerPath: env5.publishLedgerPath });

  await mL5.upsert('mA', { id: 'mA', filePath: fA, status: 'READY' });
  await mL5.upsert('mB', { id: 'mB', filePath: fB, status: 'READY' });

  // Publish item A only
  const attA = await pL5.recordAttempt({ batchId: 'b5', media: { mediaId: 'mA' }, destinationId: '-1001' });
  await pL5.recordSuccess(attA.publishId, { telegramMessageId: '1001' });

  const cleaner5 = new MediaCleaner({ mediaLedger: mL5, publishLedger: pL5 });
  const batchCleanSummary = await cleaner5.cleanBatch([
    { mediaId: 'mA', destinationId: '-1001', filePath: fA },
    { mediaId: 'mB', destinationId: '-1001', filePath: fB }
  ]);

  check('Batch clean total is 2', batchCleanSummary.total === 2);
  check('Cleaned count is 1 (item A)', batchCleanSummary.cleaned === 1);
  check('Refused count is 1 (item B unconfirmed)', batchCleanSummary.refused === 1);
  check('File A was deleted', fs.existsSync(fA) === false);
  check('File B was preserved', fs.existsSync(fB) === true);

  console.log('\n============================================================');
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runMediaCleanerTests().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
