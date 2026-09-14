/**
 * ============================================================
 * 🧪 STALE CYCLE LIFECYCLE TEST SUITE
 * ============================================================
 * Reproduces and verifies the fix for the production incident where an
 * acquisition child process died mid-cycle while batch_state.json stayed
 * wedged in an active state (ACQUIRING/PROCESSING/PUBLISHING), causing the
 * scheduler to skip every subsequent tick forever.
 *
 * Local-only: fake VideoPipelineManager (no Playwright/network), fake
 * MediaIngestor (no ffprobe dependency - that path is already covered by
 * test_media_ingestor.js/test_media_validator.js), and a real
 * VideoBatchPublisher + real PublishLedger with a mocked Telegram client and
 * mocked mediaValidator (no ffmpeg, no network, no real chat IDs) for the
 * publish-side lifecycle checks. No adult/explicit content anywhere.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { BatchCycleManager } = require('./batch_cycle_manager');
const { BatchState } = require('./batch_state');
const { VideoBatchPublisher } = require('./video_batch_publisher');
const { PublishLedger } = require('./publish_ledger');
const { MediaCleaner } = require('./media_cleaner');

let passed = 0, failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.error(`  ❌ ${label}${detail ? ' - ' + detail : ''}`); failed++; }
}
function section(t) { console.log(`\n--- ${t} ---`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** A fake VideoPipelineManager whose "running" window is fully scripted. */
function makeFakeAcquisition({ pid = 999999, runForMs = 150 } = {}) {
  let running = false;
  return {
    pid,
    start() {
      running = true;
      if (runForMs > 0) setTimeout(() => { running = false; }, runForMs);
      return { status: 'STARTED', pid };
    },
    isRunning() { return running; },
    async stop() { running = false; return { status: 'STOPPED' }; },
    getStatus() { return { running, pid: running ? pid : null }; },
    forceStop() { running = false; }
  };
}

/**
 * A fake MediaIngestor: reports READY exactly once per distinct filePath
 * (matching real MediaIngestor's "already processed" semantics), never
 * touches ffprobe/ffmpeg.
 */
function makeFakeIngestor() {
  const seen = new Map();
  return {
    ledger: { getRecord: () => null },
    async processSingleFile(filePath, options = {}) {
      const abs = path.resolve(filePath);
      if (seen.has(abs)) {
        return { filePath: abs, id: seen.get(abs), status: 'READY', alreadyProcessed: true };
      }
      const id = crypto.createHash('sha256').update(abs).digest('hex');
      seen.set(abs, id);
      return {
        filePath: abs,
        id,
        status: 'READY',
        size: 12,
        contentSha256: `sha_${id.slice(0, 12)}`,
        sourceKeyHash: `src_${id.slice(0, 12)}`,
        title: options.title || ''
      };
    }
  };
}

function freshDir(base, name) {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFixtureFile(downloadsDir, name) {
  const filePath = path.join(downloadsDir, name);
  fs.writeFileSync(filePath, `local fixture bytes ${name} ${Date.now()}`);
  return filePath;
}

/** Real publisher, mocked Telegram client + mocked validator, no network. */
function makePublisher(dir, { failAlways = false, throwAlways = false, batchState = null } = {}) {
  const publishLedger = new PublishLedger({ ledgerPath: path.join(dir, 'publish_state.json') });
  const telegramClient = {
    async sendVideo(chatId) {
      if (throwAlways) throw new Error('injected unexpected transport exception');
      if (failAlways) throw new Error('injected transport failure');
      return { message_id: Math.floor(Math.random() * 1000000) };
    }
  };
  const publisher = new VideoBatchPublisher({
    telegramClient,
    publishLedger,
    batchState: batchState || undefined,
    mediaCleaner: new MediaCleaner({ publishLedger, allowedDirectory: dir }),
    mediaValidator: async () => ({ valid: true }),
    maxRetries: 0,
    rateLimitDelayMs: 0
  });
  return { publisher, publishLedger };
}

function makeManager(dir, { acquisition, ingestor, publisher, minSuccessfulVideos = 1, maxSuccessfulVideos = 25 } = {}) {
  const outputDir = freshDir(dir, 'output');
  const downloadsDir = freshDir(dir, 'downloads');
  return new BatchCycleManager({
    acquisitionUrl: 'http://127.0.0.1:1/unused-fake-url',
    outputDir,
    downloadsDir,
    batchStatePath: path.join(dir, 'batch_state.json'),
    videoPipelineManager: acquisition,
    mediaIngestor: ingestor,
    videoBatchPublisher: publisher || null,
    autoPublish: Boolean(publisher),
    minSuccessfulVideos,
    maxSuccessfulVideos,
    acquisitionTimeoutMs: 5000
  });
}

// ============================================================
// A. Normal acquisition -> publication -> completion
// ============================================================
async function testNormalLifecycle(root) {
  section('A. Normal acquisition -> publication -> completion');
  const dir = freshDir(root, 'A_normal');
  const acquisition = makeFakeAcquisition({ pid: 12345, runForMs: 400 });
  const ingestor = makeFakeIngestor();
  const { publisher } = makePublisher(dir);

  const mgr = makeManager(dir, { acquisition, ingestor, publisher });
  writeFixtureFile(mgr.downloadsDir, 'video1.mp4');

  const summary = await mgr.runOnce();
  check('A: cycle reaches COMPLETED', summary.status === 'COMPLETED', summary.status);
  check('A: exactly 1 published item', summary.published === 1, `got ${summary.published}`);
  check('A: controller state is IDLE after completion', mgr.getStatus().state === 'IDLE');
  check('A: cycle record status is COMPLETED', mgr.getCycle(summary.cycleId).status === 'COMPLETED');
}

// ============================================================
// B. Acquisition process disappears / publish throws mid-cycle
// (this is the exact production incident's root cause: an unexpected
// exception during immediate publish must never strand the controller state
// at PUBLISHING forever)
// ============================================================
async function testPublishExceptionDoesNotStrandState(root) {
  section('B. Unexpected exception during immediate publish does not strand controller state');
  const dir = freshDir(root, 'B_publish_throws');
  const acquisition = makeFakeAcquisition({ pid: 12346, runForMs: 400 });
  const ingestor = makeFakeIngestor();
  const { publisher } = makePublisher(dir, { throwAlways: true });

  const mgr = makeManager(dir, { acquisition, ingestor, publisher });
  writeFixtureFile(mgr.downloadsDir, 'video1.mp4');

  const summary = await mgr.runOnce();
  check('B: cycle still reaches a terminal state (not stuck)',
    ['FAILED', 'PARTIAL', 'COMPLETED_EMPTY'].includes(summary.status), summary.status);
  check('B: controller state is IDLE, never left at PUBLISHING', mgr.getStatus().state === 'IDLE');
  check('B: the failed publish attempt was counted as a failure', summary.failed >= 1, `failed=${summary.failed}`);
  check('B: completedAt was actually recorded (loop did not hang)',
    !!mgr.getCycle(summary.cycleId).completedAt);
}

// ============================================================
// C. Stale acquisition-phase cycle (dead PID) is detected and finalized safely
// ============================================================
async function testStaleAcquisitionDetectedAndFinalized(root) {
  section('C. Stale acquisition cycle (dead PID) is detected and finalized safely');
  const dir = freshDir(root, 'C_stale_acquiring');
  const acquisition = makeFakeAcquisition({ pid: 1, runForMs: 0 });
  const ingestor = makeFakeIngestor();
  const mgr = makeManager(dir, { acquisition, ingestor });

  // Simulate a process that died mid-acquisition: hand-craft the persisted
  // state exactly like the production incident (ACQUIRING, dead PID,
  // completedAt still null, discovered/downloaded/ready still 0).
  const DEAD_PID = 999999;
  mgr.batchState.data.state = 'ACQUIRING';
  mgr.batchState.data.currentCycleId = 'cycle_stale_incident';
  mgr.batchState.data.cycles['cycle_stale_incident'] = {
    cycleId: 'cycle_stale_incident', status: 'ACQUIRING', startedAt: new Date().toISOString(),
    completedAt: null, acquisitionPid: DEAD_PID, discovered: 0, downloaded: 0, ready: 0,
    duplicates: 0, failed: 0, media: [], lastError: null
  };
  mgr.batchState.save();

  mgr._reconcileStaleCycle('scheduled-tick');

  check('C: stale cycle was marked FAILED', mgr.getCycle('cycle_stale_incident').status === 'FAILED');
  check('C: completedAt was set on the finalized cycle', !!mgr.getCycle('cycle_stale_incident').completedAt);
  check('C: controller was reset to IDLE', mgr.getStatus().state === 'IDLE');
  check('C: no media was touched (media list untouched, empty as it started)',
    Array.isArray(mgr.getCycle('cycle_stale_incident').media) && mgr.getCycle('cycle_stale_incident').media.length === 0);
}

// ============================================================
// D. Scheduler can start a new cycle after stale recovery
// ============================================================
async function testSchedulerResumesAfterStaleRecovery(root) {
  section('D. Scheduler starts a new cycle after stale cycle is reconciled');
  const dir = freshDir(root, 'D_scheduler_resumes');
  // The fake acquisition's own "running" window is kept well shorter than
  // the tick interval, so the fresh cycle that starts once the stale one is
  // reconciled has time to finish before any later tick could observe it as
  // still active - isolating this test to exactly one tick's behavior.
  const acquisition = makeFakeAcquisition({ pid: 2, runForMs: 50 });
  const ingestor = makeFakeIngestor();
  const { publisher } = makePublisher(dir);
  const mgr = makeManager(dir, { acquisition, ingestor, publisher });

  const DEAD_PID = 999998;
  mgr.batchState.data.state = 'PROCESSING';
  mgr.batchState.data.currentCycleId = 'cycle_stale_before_tick';
  mgr.batchState.data.cycles['cycle_stale_before_tick'] = {
    cycleId: 'cycle_stale_before_tick', status: 'PROCESSING', startedAt: new Date().toISOString(),
    completedAt: null, acquisitionPid: DEAD_PID, discovered: 0, downloaded: 0, ready: 0,
    duplicates: 0, failed: 0, media: [], lastError: null
  };
  mgr.batchState.save();

  writeFixtureFile(mgr.downloadsDir, 'video1.mp4');

  mgr._scheduledTick();
  await sleep(300);
  await mgr.stop();

  check('D: the first tick did not skip (stale cycle was reconciled first, not left blocking)',
    mgr.batchState.getSkippedTicks().length === 0, JSON.stringify(mgr.batchState.getSkippedTicks()));
  check('D: the stale cycle was finalized to FAILED', mgr.getCycle('cycle_stale_before_tick').status === 'FAILED');
  const cycles = mgr.listCycles();
  const newCycle = cycles.find(c => c.cycleId !== 'cycle_stale_before_tick');
  check('D: a genuinely new cycle ran and reached COMPLETED', !!newCycle && newCycle.status === 'COMPLETED', newCycle && newCycle.status);
}

// ============================================================
// E/F. Already-successful publications remain PUBLISHED and are not resent
// after a stale-cycle recovery elsewhere in the same publish ledger.
// ============================================================
async function testPublishedPreservedAndNotResent(root) {
  section('E/F. Previously PUBLISHED media stays PUBLISHED and is never resent after recovery');
  const dir = freshDir(root, 'EF_published_preserved');
  const { publisher, publishLedger } = makePublisher(dir);

  const filePath = path.join(dir, 'already_published.mp4');
  fs.writeFileSync(filePath, 'already published fixture');
  const media = { mediaId: 'already-published-item', title: 'Episode already sent', filePath };

  const firstResult = await publisher.publishSingleItem('cycle_prior', media);
  check('E: first publish succeeds', firstResult.status === 'PUBLISHED');
  const publishedId = firstResult.telegramMessageId;

  // Simulate a stale-cycle recovery event happening elsewhere (batch_state
  // reconciliation) - it must never touch the PublishLedger at all.
  const acquisition = makeFakeAcquisition({ pid: 3, runForMs: 0 });
  const ingestor = makeFakeIngestor();
  const mgr = makeManager(dir, { acquisition, ingestor });
  mgr.batchState.data.state = 'ACQUIRING';
  mgr.batchState.data.currentCycleId = 'cycle_unrelated_stale';
  mgr.batchState.data.cycles['cycle_unrelated_stale'] = {
    cycleId: 'cycle_unrelated_stale', status: 'ACQUIRING', startedAt: new Date().toISOString(),
    completedAt: null, acquisitionPid: 999997, discovered: 0, downloaded: 0, ready: 0,
    duplicates: 0, failed: 0, media: [], lastError: null
  };
  mgr.batchState.save();
  mgr._reconcileStaleCycle('scheduled-tick');

  check('E: the earlier PUBLISHED record is still PUBLISHED after an unrelated recovery',
    publishLedger.isPublished('already-published-item', firstResult.destinationId));

  // F: retry-publishing the same media must skip, never resend.
  const secondResult = await publisher.publishSingleItem('cycle_retry', media);
  check('F: re-publishing the same already-published media is skipped, not resent',
    secondResult.status === 'SKIPPED_ALREADY_PUBLISHED');
  check('F: the Telegram message ID is unchanged (no new send occurred)',
    secondResult.telegramMessageId === publishedId);
}

// ============================================================
// G. READY media remains available for retry (never cleaned pre-publish,
// never lost across a stale-cycle recovery)
// ============================================================
async function testReadyMediaSurvivesRecovery(root) {
  section('G. READY media remains intact and available for retry after recovery');
  const dir = freshDir(root, 'G_ready_survives');
  const acquisition = makeFakeAcquisition({ pid: 4, runForMs: 0 });
  const ingestor = makeFakeIngestor();
  const mgr = makeManager(dir, { acquisition, ingestor });

  const readyFilePath = writeFixtureFile(freshDir(dir, 'downloads_precreated'), 'ready_not_yet_published.mp4');

  mgr.batchState.data.state = 'ACQUIRING';
  mgr.batchState.data.currentCycleId = 'cycle_with_ready_media';
  mgr.batchState.data.cycles['cycle_with_ready_media'] = {
    cycleId: 'cycle_with_ready_media', status: 'ACQUIRING', startedAt: new Date().toISOString(),
    completedAt: null, acquisitionPid: 999996, discovered: 1, downloaded: 1, ready: 1,
    duplicates: 0, failed: 0,
    media: [{ mediaId: 'ready-item-1', title: 'Ready item', filePath: readyFilePath }],
    lastError: null
  };
  mgr.batchState.save();

  mgr._reconcileStaleCycle('scheduled-tick');

  const cycle = mgr.getCycle('cycle_with_ready_media');
  check('G: cycle was finalized (FAILED) without touching its media list', cycle.status === 'FAILED');
  check('G: the READY media record is still present in the frozen cycle', cycle.media.length === 1 && cycle.media[0].mediaId === 'ready-item-1');
  check('G: the underlying media file on disk was never deleted', fs.existsSync(readyFilePath));
}

// ============================================================
// H. Restart during acquisition (fresh process constructs a new manager)
// ============================================================
async function testRestartDuringAcquisition(root) {
  section('H. Restart during acquisition is recovered at construction time');
  const dir = freshDir(root, 'H_restart_acquiring');
  const batchStatePath = path.join(dir, 'batch_state.json');

  const preCrash = new BatchState({ statePath: batchStatePath });
  preCrash.data.state = 'ACQUIRING';
  preCrash.data.currentCycleId = 'cycle_crashed_acquiring';
  preCrash.data.cycles['cycle_crashed_acquiring'] = {
    cycleId: 'cycle_crashed_acquiring', status: 'ACQUIRING', startedAt: new Date().toISOString(),
    completedAt: null, acquisitionPid: 999995, discovered: 0, downloaded: 0, ready: 0,
    duplicates: 0, failed: 0, media: [], lastError: null
  };
  preCrash.save();

  // "Restart": construct a fresh BatchCycleManager pointed at the same
  // persisted state file - its constructor must recover the crashed cycle.
  const outputDir = freshDir(dir, 'output');
  const downloadsDir = freshDir(dir, 'downloads');
  const mgr = new BatchCycleManager({
    acquisitionUrl: 'http://127.0.0.1:1/unused-fake-url',
    outputDir, downloadsDir,
    batchStatePath,
    videoPipelineManager: makeFakeAcquisition({ pid: 5, runForMs: 0 }),
    mediaIngestor: makeFakeIngestor()
  });

  check('H: restart recovery marked the crashed cycle FAILED', mgr.getCycle('cycle_crashed_acquiring').status === 'FAILED');
  check('H: controller reset to IDLE on restart', mgr.getStatus().state === 'IDLE');
}

// ============================================================
// I. Restart during publishing (fresh process recovers PUBLISHING -> BATCH_READY)
// ============================================================
async function testRestartDuringPublishing(root) {
  section('I. Restart during PUBLISHING resets to BATCH_READY without losing media');
  const dir = freshDir(root, 'I_restart_publishing');
  const batchStatePath = path.join(dir, 'batch_state.json');
  const filePath = path.join(dir, 'mid_publish.mp4');
  fs.writeFileSync(filePath, 'mid publish fixture');

  const preCrash = new BatchState({ statePath: batchStatePath });
  preCrash.data.state = 'PUBLISHING';
  preCrash.data.currentCycleId = 'cycle_crashed_publishing';
  preCrash.data.cycles['cycle_crashed_publishing'] = {
    cycleId: 'cycle_crashed_publishing', status: 'PROCESSING', startedAt: new Date().toISOString(),
    completedAt: null, acquisitionPid: null, discovered: 1, downloaded: 1, ready: 1,
    duplicates: 0, failed: 0,
    media: [{ mediaId: 'mid-publish-item', title: 'Mid publish item', filePath }],
    lastError: null
  };
  preCrash.save();

  // Publisher and manager must share the exact same BatchState instance -
  // VideoBatchPublisher.publishBatch() looks the cycle up by ID in its own
  // this.batchState, so a "restart" here means both are reconstructed
  // pointed at (and sharing) the one already-persisted state.
  const outputDir = freshDir(dir, 'output');
  const downloadsDir = freshDir(dir, 'downloads');
  const { publisher } = makePublisher(dir, { batchState: preCrash });
  const mgr = new BatchCycleManager({
    acquisitionUrl: 'http://127.0.0.1:1/unused-fake-url',
    outputDir, downloadsDir,
    batchState: preCrash,
    videoPipelineManager: makeFakeAcquisition({ runForMs: 0 }),
    mediaIngestor: makeFakeIngestor(),
    videoBatchPublisher: publisher
  });

  check('I: restart reset PUBLISHING cycle to BATCH_READY', mgr.getCycle('cycle_crashed_publishing').status === 'BATCH_READY');
  check('I: controller reset to IDLE on restart', mgr.getStatus().state === 'IDLE');
  check('I: the frozen media record was not lost', mgr.getCycle('cycle_crashed_publishing').media.length === 1);

  const pubResult = await mgr.publishCycle('cycle_crashed_publishing');
  check('I: the recovered batch can still be published successfully', pubResult.status === 'COMPLETED', JSON.stringify(pubResult));
  check('I: exactly 1 item was published (no duplication)', pubResult.published === 1, `published=${pubResult.published}`);
}

// ============================================================
// J. Scheduler tick while a cycle is genuinely active (live PID) is skipped
// and NOT reconciled away.
// ============================================================
async function testTickWhileGenuinelyActive(root) {
  section('J. Scheduler tick while a cycle is genuinely active leaves it untouched');
  const dir = freshDir(root, 'J_tick_active');
  const acquisition = makeFakeAcquisition({ pid: 6, runForMs: 900 });
  const ingestor = makeFakeIngestor();
  const { publisher } = makePublisher(dir);
  const mgr = makeManager(dir, { acquisition, ingestor, publisher });

  // Use this test process's own PID - guaranteed alive - as the "acquisition"
  // PID for a hand-planted active-looking cycle, to prove liveness (not mere
  // process continuity) is what protects a genuinely active cycle.
  mgr.batchState.data.state = 'ACQUIRING';
  mgr.batchState.data.currentCycleId = 'cycle_genuinely_active';
  mgr.batchState.data.cycles['cycle_genuinely_active'] = {
    cycleId: 'cycle_genuinely_active', status: 'ACQUIRING', startedAt: new Date().toISOString(),
    completedAt: null, acquisitionPid: process.pid, discovered: 0, downloaded: 0, ready: 0,
    duplicates: 0, failed: 0, media: [], lastError: null
  };
  mgr.batchState.save();

  mgr._reconcileStaleCycle('scheduled-tick');

  check('J: a cycle with a live PID is left completely untouched', mgr.getCycle('cycle_genuinely_active').status === 'ACQUIRING');
  check('J: controller state is unchanged (still ACQUIRING, not IDLE)', mgr.getStatus().state === 'ACQUIRING');

  mgr._scheduledTick();
  await sleep(50);
  check('J: a scheduled tick against a genuinely active (live-PID) cycle is skipped, not run',
    mgr.batchState.getSkippedTicks().length > 0);
}

// ============================================================
// K. Scheduler tick after stale cycle recovery: the SAME tick that reconciles
// a stale cycle is immediately able to run a fresh one (no extra tick needed).
// ============================================================
async function testTickImmediatelyResumesAfterRecovery(root) {
  section('K. The same tick that recovers a stale cycle can immediately run a new one');
  const dir = freshDir(root, 'K_tick_resumes_same_pass');
  const acquisition = makeFakeAcquisition({ pid: 7, runForMs: 150 });
  const ingestor = makeFakeIngestor();
  const { publisher } = makePublisher(dir);
  const mgr = makeManager(dir, { acquisition, ingestor, publisher });

  mgr.batchState.data.state = 'ACQUIRING';
  mgr.batchState.data.currentCycleId = 'cycle_stale_for_k';
  mgr.batchState.data.cycles['cycle_stale_for_k'] = {
    cycleId: 'cycle_stale_for_k', status: 'ACQUIRING', startedAt: new Date().toISOString(),
    completedAt: null, acquisitionPid: 999994, discovered: 0, downloaded: 0, ready: 0,
    duplicates: 0, failed: 0, media: [], lastError: null
  };
  mgr.batchState.save();
  writeFixtureFile(mgr.downloadsDir, 'video1.mp4');

  mgr._scheduledTick();
  await sleep(400);

  check('K: the stale cycle was reconciled to FAILED', mgr.getCycle('cycle_stale_for_k').status === 'FAILED');
  const newCycle = mgr.listCycles().find(c => c.cycleId !== 'cycle_stale_for_k');
  check('K: a brand new cycle ran to completion in the very same tick pass', !!newCycle && newCycle.status === 'COMPLETED', newCycle && newCycle.status);
  check('K: no skipped tick was recorded for this pass', mgr.batchState.getSkippedTicks().length === 0);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexahub-lifecycle-'));
  try {
    await testNormalLifecycle(root);
    await testPublishExceptionDoesNotStrandState(root);
    await testStaleAcquisitionDetectedAndFinalized(root);
    await testSchedulerResumesAfterStaleRecovery(root);
    await testPublishedPreservedAndNotResent(root);
    await testReadyMediaSurvivesRecovery(root);
    await testRestartDuringAcquisition(root);
    await testRestartDuringPublishing(root);
    await testTickWhileGenuinelyActive(root);
    await testTickImmediatelyResumesAfterRecovery(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log('\n============================================================');
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log('============================================================');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test suite crashed:', err.stack || err);
  process.exit(1);
});
