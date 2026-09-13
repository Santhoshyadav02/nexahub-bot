/**
 * ============================================================
 * 🧪 TELEGRAM PIPELINE SCHEDULER - FAIL-CLOSED SAFETY TEST
 * ============================================================
 * Proves the TELEGRAM_PIPELINE_SCHEDULER_ENABLED gate added to
 * telegram_pipeline_publisher.js's startPipelineScheduler():
 *   A. Default (no env, no options)      -> DISABLED, zero activity
 *   B. Explicit env "false"               -> DISABLED
 *   C. Explicit schedulerEnabled: true    -> can initialize (mocks only,
 *                                            stopped before its 15s initial
 *                                            cycle timer could ever fire -
 *                                            NO real MTProto/Telegram call
 *                                            is made at any point in this file)
 *   D. Disabled call does not mutate runtime state (isPublishingActive stays false)
 *   E. Enabled path still logs/schedules exactly as before (unchanged behavior)
 *
 * No real Telegram send, no real MTProto connection, no live network call of
 * any kind happens anywhere in this file.
 */
const assert = require('assert');
const {
  startPipelineScheduler,
  stopPipelineScheduler,
  isPublishingActive
} = require('./telegram_pipeline_publisher');

let passed = 0, failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`✅ ${label}`); passed++; }
  else { console.error(`❌ ${label}${detail ? ' - ' + detail : ''}`); failed++; }
}

function captureConsole(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); orig(...args); };
  try {
    const result = fn();
    return { result, lines };
  } finally {
    console.log = orig;
  }
}

function main() {
  const savedEnv = process.env.TELEGRAM_PIPELINE_SCHEDULER_ENABLED;

  try {
    // ------------------------------------------------------------
    // A. Default (no env var set at all) -> DISABLED
    // ------------------------------------------------------------
    delete process.env.TELEGRAM_PIPELINE_SCHEDULER_ENABLED;
    const { result: resA, lines: linesA } = captureConsole(() => startPipelineScheduler());
    check('A. Default (no env): status is DISABLED', resA.status === 'DISABLED', JSON.stringify(resA));
    check('A. Default (no env): logs the DISABLED message', linesA.some(l => l.includes('[TELEGRAM_PIPELINE] Scheduler is DISABLED')));
    check('A. Default (no env): does NOT log the RUNNING/starting message', !linesA.some(l => l.includes('Starting Telegram Video Pipeline scheduler')));
    check('A. Default (no env): no publish cycle became active', isPublishingActive() === false);
    stopPipelineScheduler();

    // ------------------------------------------------------------
    // B. Explicit env "false" -> DISABLED
    // ------------------------------------------------------------
    process.env.TELEGRAM_PIPELINE_SCHEDULER_ENABLED = 'false';
    const { result: resB, lines: linesB } = captureConsole(() => startPipelineScheduler());
    check('B. TELEGRAM_PIPELINE_SCHEDULER_ENABLED=false: status is DISABLED', resB.status === 'DISABLED', JSON.stringify(resB));
    check('B. logs the DISABLED message', linesB.some(l => l.includes('[TELEGRAM_PIPELINE] Scheduler is DISABLED')));
    stopPipelineScheduler();

    // Also confirm an arbitrary non-"true" value is still treated as disabled
    process.env.TELEGRAM_PIPELINE_SCHEDULER_ENABLED = 'TRUE'; // wrong case must NOT enable
    const resBCase = startPipelineScheduler();
    check('B. Only the exact lowercase string "true" enables - "TRUE" stays DISABLED', resBCase.status === 'DISABLED', JSON.stringify(resBCase));
    stopPipelineScheduler();
    delete process.env.TELEGRAM_PIPELINE_SCHEDULER_ENABLED;

    // ------------------------------------------------------------
    // D. Disabled call does not mutate runtime state
    // ------------------------------------------------------------
    check('D. isPublishingActive() is false before any enabled call', isPublishingActive() === false);
    startPipelineScheduler({ schedulerEnabled: false });
    check('D. isPublishingActive() remains false after a disabled call', isPublishingActive() === false);
    // stopPipelineScheduler() on a never-started scheduler must be a safe no-op (no throw, no "stopped" log)
    const { lines: stopLines } = captureConsole(() => stopPipelineScheduler());
    check('D. stopPipelineScheduler() on a disabled/never-started scheduler does not log "stopped"', !stopLines.some(l => l.includes('scheduler stopped')));

    // ------------------------------------------------------------
    // C / E. Explicit true -> initializes exactly like the pre-existing
    // behavior (timer scheduled, RUNNING status), then stopped immediately -
    // well before its 15s initial-cycle timer could ever fire, so no real
    // MTProto connection or Telegram send happens.
    // ------------------------------------------------------------
    const { result: resC, lines: linesC } = captureConsole(() =>
      startPipelineScheduler({ schedulerEnabled: true, enabled: true, intervalMs: 3600000 })
    );
    check('C/E. schedulerEnabled: true -> status is RUNNING (unchanged existing behavior)', resC.status === 'RUNNING', JSON.stringify(resC));
    check('C/E. logs the exact pre-existing "Starting Telegram Video Pipeline scheduler" message', linesC.some(l => l.includes('Starting Telegram Video Pipeline scheduler')));
    check('C/E. does NOT log the DISABLED message', !linesC.some(l => l.includes('Scheduler is DISABLED')));

    // Prove the timer really was scheduled this time (unlike the disabled
    // cases above) by confirming stop() now finds something to stop -
    // stopped immediately, long before the 15s initial-cycle delay, so
    // runCycle() (the function that would open a real MTProto connection)
    // never executes at any point in this test.
    const { lines: stopLinesEnabled } = captureConsole(() => stopPipelineScheduler());
    check('C/E. stopPipelineScheduler() now logs "scheduler stopped" (timer was genuinely active)', stopLinesEnabled.some(l => l.includes('scheduler stopped')));
    check('C/E. no publish cycle ever became active (stopped before the 15s initial-cycle timer)', isPublishingActive() === false);

    console.log(`\n============================================================`);
    console.log(`TELEGRAM PIPELINE SCHEDULER SAFETY RESULT: ${passed} passed, ${failed} failed`);
    console.log(`============================================================`);
  } finally {
    stopPipelineScheduler();
    if (savedEnv === undefined) delete process.env.TELEGRAM_PIPELINE_SCHEDULER_ENABLED;
    else process.env.TELEGRAM_PIPELINE_SCHEDULER_ENABLED = savedEnv;
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
