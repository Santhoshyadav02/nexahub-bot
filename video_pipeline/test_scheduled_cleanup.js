/**
 * ============================================================
 * 🧪 TEST: SCHEDULED DISK CLEANUP (every VIDEO_PIPELINE_CLEANUP_INTERVAL_MS)
 * ============================================================
 *  1. Idle: expired orphan, finished (published/failed) media and stale temp files removed; pending READY kept
 *  2. Cycle active: not-yet-ingested and VALIDATING media kept; finished media still removed
 *  3. Upload part leftovers removed when idle, kept while a cycle runs
 *  4. Recent files never removed; bookkeeping files never removed
 *  5. start() arms the cleanup timer, stop() clears it; interval 0 or cleanup disabled -> no timer
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { BatchCycleManager } = require('./batch_cycle_manager');
const { MediaLedger } = require('./media_ledger');
const { PublishLedger } = require('./publish_ledger');

const ROOT_DIR = path.resolve(__dirname, '..');
const TEST_DIR = path.join(ROOT_DIR, 'scratch', 'test_scheduled_cleanup_workspace');

let passed = 0, failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.error(`  ❌ ${label}${detail ? ' - ' + detail : ''}`); failed++; }
}
function section(title) { console.log(`\n--- ${title} ---`); }

const mediaIdFor = (p) => crypto.createHash('sha256').update(path.resolve(p)).digest('hex');
const OLD = new Date(Date.now() - 5 * 3600 * 1000);

function writeOld(p, bytes = 100) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes));
  fs.utimesSync(p, OLD, OLD);
  return p;
}

async function setup(name) {
  const dir = path.join(TEST_DIR, name);
  const downloads = path.join(dir, 'downloads');
  const parts = path.join(dir, 'upload_parts');
  fs.mkdirSync(path.join(dir, 'output'), { recursive: true });
  const mediaLedger = new MediaLedger({ ledgerPath: path.join(dir, 'media_state.json') });
  const publishLedger = new PublishLedger({ ledgerPath: path.join(dir, 'publish_state.json') });
  const DEST = 'me';

  const files = {
    orphan: writeOld(path.join(downloads, 'orphan.mp4')),
    validating: writeOld(path.join(downloads, 'validating.mp4')),
    pending: writeOld(path.join(downloads, 'pending.mp4')),
    published: writeOld(path.join(downloads, 'published.mp4')),
    failed: writeOld(path.join(downloads, 'failed.mp4')),
    staleTemp: writeOld(path.join(downloads, 'video_x.mp4.part.123.tmp')),
    report: writeOld(path.join(downloads, 'download_report.json')),
    recent: path.join(downloads, 'recent.mp4')
  };
  fs.writeFileSync(files.recent, Buffer.alloc(100));
  await mediaLedger.upsert(mediaIdFor(files.validating), { filePath: files.validating, status: 'VALIDATING' });
  await mediaLedger.upsert(mediaIdFor(files.pending), { filePath: files.pending, status: 'READY' });
  await mediaLedger.upsert(mediaIdFor(files.published), { filePath: files.published, status: 'READY' });
  await mediaLedger.upsert(mediaIdFor(files.failed), { filePath: files.failed, status: 'FAILED' });
  const attempt = await publishLedger.recordAttempt({ batchId: 'b', media: { mediaId: mediaIdFor(files.published) }, destinationId: DEST });
  await publishLedger.recordSuccess(attempt.publishId, { telegramMessageId: '1' });

  const partDir = path.join(parts, 'm_123');
  writeOld(path.join(partDir, 'part_000.mp4'));
  fs.utimesSync(partDir, OLD, OLD);

  const mgr = new BatchCycleManager({
    acquisitionUrl: 'http://127.0.0.1:1/unused',
    outputDir: path.join(dir, 'output'),
    downloadsDir: downloads,
    uploadPartsDir: parts,
    batchStatePath: path.join(dir, 'batch_state.json'),
    videoPipelineManager: { isRunning: () => false, stop: async () => {} },
    mediaIngestor: { ledger: mediaLedger, processSingleFile: async () => ({ status: 'SKIPPED' }) },
    videoBatchPublisher: { stagingChatId: DEST, publishLedger },
    autoPublish: true,
    enableCleanup: true,
    downloadRetentionHours: 3,
    downloadMaxBytes: 0,
    cleanupIntervalMs: 3 * 60 * 60 * 1000
  });
  return { mgr, files, partDir };
}

async function main() {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });

  section('1, 3, 4. Idle cleanup');
  {
    const { mgr, files, partDir } = await setup('idle');
    const res = await mgr.runScheduledCleanup();
    check('expired orphan removed', !fs.existsSync(files.orphan));
    check('published media removed', !fs.existsSync(files.published));
    check('failed media removed', !fs.existsSync(files.failed));
    check('stale temp removed', !fs.existsSync(files.staleTemp));
    check('pending READY media kept', fs.existsSync(files.pending));
    check('recent file kept', fs.existsSync(files.recent));
    check('bookkeeping file kept', fs.existsSync(files.report));
    check('upload part leftover removed', !fs.existsSync(partDir));
    check('summary counts', res.deleted >= 5 && res.partDirsDeleted === 1, JSON.stringify(res));
  }

  section('2, 3. Cleanup while a cycle is active');
  {
    const { mgr, files, partDir } = await setup('active');
    mgr.batchState.setControllerState('ACQUIRING');
    await mgr.runScheduledCleanup();
    check('not-yet-ingested download kept', fs.existsSync(files.orphan));
    check('VALIDATING media kept', fs.existsSync(files.validating));
    check('pending READY media kept', fs.existsSync(files.pending));
    check('published media still removed', !fs.existsSync(files.published));
    check('failed media still removed', !fs.existsSync(files.failed));
    check('upload part dir kept while cycle runs', fs.existsSync(partDir));
  }

  section('5. Timer lifecycle');
  {
    const { mgr } = await setup('timer');
    mgr.startupDelayMs = 60 * 60 * 1000;
    mgr.start(24 * 60 * 60 * 1000);
    check('start() arms cleanup timer', mgr._cleanupTimerId !== null);
    await mgr.stop();
    check('stop() clears cleanup timer', mgr._cleanupTimerId === null);

    const { mgr: off } = await setup('timer_off');
    off.cleanupIntervalMs = 0;
    off.startupDelayMs = 60 * 60 * 1000;
    off.start(24 * 60 * 60 * 1000);
    check('interval 0 -> no cleanup timer', off._cleanupTimerId === null);
    await off.stop();

    const { mgr: disabled } = await setup('timer_disabled');
    disabled.enableCleanup = false;
    disabled.startupDelayMs = 60 * 60 * 1000;
    disabled.start(24 * 60 * 60 * 1000);
    check('cleanup disabled -> no cleanup timer', disabled._cleanupTimerId === null);
    const res = await disabled.runScheduledCleanup();
    check('cleanup disabled -> runScheduledCleanup is a no-op', res.skipped === true);
    await disabled.stop();
  }

  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('Test crashed:', err);
  process.exit(1);
});
