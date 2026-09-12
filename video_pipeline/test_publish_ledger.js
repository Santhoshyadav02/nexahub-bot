/**
 * ============================================================
 * 🧪 TEST: PUBLISH LEDGER (Phase 4A)
 * ============================================================
 * Verifies atomic persistence, concurrency locks, state transitions,
 * crash recovery, and idempotency indexing.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { PublishLedger } = require('./publish_ledger');

const ROOT_DIR = path.resolve(__dirname, '..');
const TEST_DIR = path.join(ROOT_DIR, 'scratch', 'test_publish_ledger_workspace');

let passed = 0, failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.error(`  ❌ ${label}${detail ? ' - ' + detail : ''}`); failed++; }
}
function section(title) { console.log(`\n--- ${title} ---`); }

function freshLedgerPath(name) {
  const dir = path.join(TEST_DIR, name);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'publish_state.json');
}

async function runTests() {
  console.log('============================================================');
  console.log('🧪 PUBLISH LEDGER TEST SUITE');
  console.log('============================================================');

  section('Test 1: Initial Empty Ledger');
  const path1 = freshLedgerPath('init');
  const ledger1 = new PublishLedger({ ledgerPath: path1 });
  check('Ledger starts empty', ledger1.listAll().length === 0);
  check('isPublished returns false for unknown item', ledger1.isPublished('m1', 'dest1') === false);

  section('Test 2: Record Attempt -> UPLOADING');
  const attempt1 = await ledger1.recordAttempt({
    batchId: 'batch_001',
    media: { mediaId: 'm1', title: 'Test Video', filePath: '/path/to/vid.mp4', contentSha256: 'sha123' },
    destinationId: '-100999888'
  });
  check('Attempt returns record with UPLOADING status', attempt1.status === 'UPLOADING');
  check('Destination index mapped', ledger1.findRecord('m1', '-100999888') !== null);
  check('isPublished is still false during UPLOADING', ledger1.isPublished('m1', '-100999888') === false);

  section('Test 3: Record Success -> PUBLISHED');
  const success1 = await ledger1.recordSuccess(attempt1.publishId, {
    telegramMessageId: '778899',
    publishedAt: new Date().toISOString()
  });
  check('Status updated to PUBLISHED', success1.status === 'PUBLISHED');
  check('Telegram message ID recorded', success1.telegramMessageId === '778899');
  check('isPublished returns true after success', ledger1.isPublished('m1', '-100999888') === true);

  section('Test 4: Record Failure -> FAILED');
  const path2 = freshLedgerPath('fail');
  const ledger2 = new PublishLedger({ ledgerPath: path2 });
  const attempt2 = await ledger2.recordAttempt({
    batchId: 'batch_002',
    media: { mediaId: 'm2', title: 'Failing Video' },
    destinationId: '-100999888'
  });
  const fail2 = await ledger2.recordFailure(attempt2.publishId, 'Network error');
  check('Status updated to FAILED', fail2.status === 'FAILED');
  check('Error message recorded', fail2.lastError === 'Network error');
  check('isPublished is false for FAILED record', ledger2.isPublished('m2', '-100999888') === false);

  section('Test 5: Same MediaId, Different Destinations -> Independent Records');
  const attemptDestA = await ledger1.recordAttempt({
    batchId: 'batch_001',
    media: { mediaId: 'm3', title: 'Multi Dest Video' },
    destinationId: '-100111'
  });
  await ledger1.recordSuccess(attemptDestA.publishId, { telegramMessageId: '101' });

  const attemptDestB = await ledger1.recordAttempt({
    batchId: 'batch_001',
    media: { mediaId: 'm3', title: 'Multi Dest Video' },
    destinationId: '-100222'
  });

  check('Destination A is PUBLISHED', ledger1.isPublished('m3', '-100111') === true);
  check('Destination B is UPLOADING (not yet published)', ledger1.isPublished('m3', '-100222') === false);
  check('Both records exist in ledger', ledger1.findRecord('m3', '-100111') !== null && ledger1.findRecord('m3', '-100222') !== null);

  section('Test 6: Crash Recovery (UPLOADING -> PENDING on restart)');
  const path3 = freshLedgerPath('recovery');
  const ledger3 = new PublishLedger({ ledgerPath: path3 });
  await ledger3.recordAttempt({
    batchId: 'batch_003',
    media: { mediaId: 'm_stuck', title: 'Interrupted Video' },
    destinationId: '-100999888'
  });

  // Verify file was written
  check('State file exists on disk', fs.existsSync(path3));

  // Instantiate new ledger instance simulating process restart
  const ledger3Recovered = new PublishLedger({ ledgerPath: path3 });
  const recoveredRecord = ledger3Recovered.findRecord('m_stuck', '-100999888');
  check('Recovered record exists', recoveredRecord !== null);
  check('Recovered record status reset from UPLOADING -> PENDING', recoveredRecord.status === 'PENDING');
  check('Recovery summary recorded 1 item', ledger3Recovered.getRecoverySummary().recoveredCount === 1);

  section('Test 7: Atomic Concurrent Writes & Integrity');
  const path4 = freshLedgerPath('concurrent');
  const ledger4 = new PublishLedger({ ledgerPath: path4 });
  const concurrentCount = 25;
  const promises = [];
  for (let i = 0; i < concurrentCount; i++) {
    promises.push(
      ledger4.recordAttempt({
        batchId: 'batch_concurrent',
        media: { mediaId: `m_c_${i}`, title: `Title ${i}` },
        destinationId: '-100999'
      }).then(att => {
        return ledger4.recordSuccess(att.publishId, { telegramMessageId: `${1000 + i}` });
      })
    );
  }

  await Promise.all(promises);
  check('All concurrent writes succeeded', ledger4.listAll().length === concurrentCount);
  const rawJson = fs.readFileSync(path4, 'utf8');
  const parsed = JSON.parse(rawJson);
  check('Persisted state is valid JSON', typeof parsed === 'object' && Object.keys(parsed.records).length === concurrentCount);

  console.log('\n============================================================');
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
