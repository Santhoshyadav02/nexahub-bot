/**
 * test_round_robin_isolated_instrumented_e2e.js
 *
 * PHASE 5 (10-destination round-robin) VERIFICATION - instrumented, isolated.
 *
 * Scope, per explicit user approval: test the EXISTING legacy
 * GlobalRoundRobinRouter algorithm in isolation. Does NOT touch Playwright,
 * video_pipeline/ content, or any real Telegram network call. Does NOT use
 * the real 10 production destination identities (DESTINATION_KEYS /
 * DESTINATIONS_META in global_round_robin_router.js) - uses a synthetic,
 * clearly-labeled safe destination array instead, and a genuinely empty,
 * isolated ledger file (explicitly created empty so PublishedLedger's
 * baseline-copy-from-real-ledger behavior never triggers).
 *
 * Proves the round-robin sequence from ACTUAL instrumented send calls
 * (an in-memory array every mock "sendVideo(media, destination)" call
 * pushes to), never from log labels or from re-deriving the expected
 * sequence mathematically without checking real call records.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { GlobalRoundRobinRouter } = require('./global_round_robin_router');
const { PublishedLedger } = require('./telegram_pipeline_publisher');

let passed = 0, failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`✅ ${label}`); passed++; }
  else { console.error(`❌ ${label}${detail ? ' - ' + detail : ''}`); failed++; }
}

// Synthetic, non-production destination labels - never the real channel
// usernames/identities from global_round_robin_router.js's DESTINATIONS_META.
const SAFE_TEST_DESTINATIONS = [
  'TEST_DEST_1', 'TEST_DEST_2', 'TEST_DEST_3', 'TEST_DEST_4', 'TEST_DEST_5',
  'TEST_DEST_6', 'TEST_DEST_7', 'TEST_DEST_8', 'TEST_DEST_9', 'TEST_DEST_10'
];

function makeIsolatedLedger(name) {
  const ledgerPath = path.join(__dirname, 'scratch', `test_rr_isolated_${name}.json`);
  if (fs.existsSync(ledgerPath)) fs.unlinkSync(ledgerPath);
  // Write a genuinely empty ledger BEFORE construction so PublishedLedger's
  // "seed from real published_ledger.json baseline" branch never fires -
  // this ledger starts from zero real-world state, guaranteed.
  fs.writeFileSync(ledgerPath, JSON.stringify({
    version: '1.1.0',
    updatedAt: new Date().toISOString(),
    totalPublished: 0,
    nextRoundRobinIndex: 0,
    records: []
  }, null, 2), 'utf8');
  const ledger = new PublishedLedger(ledgerPath);
  return { ledger, ledgerPath };
}

function makeInstrumentedSender(behavior) {
  // behavior: array of 'success' | 'fail', indexed by call number (0-based).
  // Defaults to 'success' once the array is exhausted.
  const calls = [];
  return {
    calls,
    // Mirrors the real integration point: client.sendFile(entity, {file, caption})
    // is called with (mediaIdentifier, destination) as far as this test cares.
    async sendVideo(media, destination) {
      const callIndex = calls.length;
      const outcome = (behavior && behavior[callIndex]) || 'success';
      calls.push({ mediaId: media.mediaId, destination, outcome });
      if (outcome === 'fail') {
        throw new Error(`Simulated Telegram send failure for ${media.mediaId} -> ${destination}`);
      }
      return { message_id: 900000 + callIndex, chat: { id: destination } };
    }
  };
}

async function testTwentySuccessfulPublicationsSequence() {
  console.log('\n=== TEST: >=20 successful publications follow exact 1->10,1->10 sequence (instrumented, not log-inferred) ===');
  const { ledger, ledgerPath } = makeIsolatedLedger('twenty_seq');
  const router = new GlobalRoundRobinRouter({ ledger, destinations: SAFE_TEST_DESTINATIONS });
  const sender = makeInstrumentedSender();

  const TOTAL_ITEMS = 23; // > 20 required minimum
  const items = Array.from({ length: TOTAL_ITEMS }, (_, i) => ({
    mediaId: `media_${i + 1}`,
    sourceChannelId: 'isolated_test_source',
    messageId: String(i + 1),
    title: `Isolated RR Test Video ${i + 1}`
  }));

  let confirmedCount = 0;
  for (const item of items) {
    const decision = router.assignDestination(item);
    assert.ok(!decision.duplicate, `item ${item.mediaId} unexpectedly flagged duplicate`);
    // The actual instrumented send call - this is what proves the real
    // destination used, not the router's internal bookkeeping alone.
    await sender.sendVideo(item, decision.destinationChannelId);
    router.confirmSuccess(decision.sourceIdentity, decision.destinationChannelId);
    ledger.recordPublication({
      sourceIdentity: decision.sourceIdentity,
      sourceChannelId: item.sourceChannelId,
      sourceMessageId: item.messageId,
      destinationChannelId: decision.destinationChannelId,
      destinationUsername: decision.destinationUsername,
      destinationMessageId: String(900000 + confirmedCount),
      caption: decision.generatedKoreanCaption
    });
    confirmedCount++;
  }

  check('Exactly 23 send calls were actually made (instrumented)', sender.calls.length === TOTAL_ITEMS, `calls=${sender.calls.length}`);

  const actualSequence = sender.calls.map(c => c.destination);
  const expectedSequence = Array.from({ length: TOTAL_ITEMS }, (_, i) => SAFE_TEST_DESTINATIONS[i % 10]);
  const sequenceMatches = JSON.stringify(actualSequence) === JSON.stringify(expectedSequence);

  console.log(`ACTUAL SEQUENCE:   ${actualSequence.join(', ')}`);
  console.log(`EXPECTED SEQUENCE: ${expectedSequence.join(', ')}`);
  console.log(`SEQUENCE MATCH: ${sequenceMatches}`);

  check('Actual instrumented send-call sequence exactly matches expected 1->10,1->10,1->3 pattern', sequenceMatches);
  check('Persisted round-robin index after 23 confirms is 3 (23 % 10)', ledger.getNextRoundRobinIndex() === 3, `index=${ledger.getNextRoundRobinIndex()}`);

  // Cross-check every mediaId only appears once and only ever went to ONE destination.
  const destByMedia = new Map();
  for (const c of sender.calls) {
    if (destByMedia.has(c.mediaId)) {
      check(`mediaId ${c.mediaId} never routed to two different destinations`, destByMedia.get(c.mediaId) === c.destination);
    }
    destByMedia.set(c.mediaId, c.destination);
  }
  check('No destination received more than ceil(23/10)=3 items', Object.values(
    actualSequence.reduce((acc, d) => { acc[d] = (acc[d] || 0) + 1; return acc; }, {})
  ).every(count => count <= 3));

  if (fs.existsSync(ledgerPath)) fs.unlinkSync(ledgerPath);
}

async function testFailureDoesNotAdvanceCounterOrConsumeDestination() {
  console.log('\n=== TEST: failed send does NOT advance round-robin counter; retry locks to same destination ===');
  const { ledger, ledgerPath } = makeIsolatedLedger('failure_no_advance');
  const router = new GlobalRoundRobinRouter({ ledger, destinations: SAFE_TEST_DESTINATIONS });
  // Call #1 (item A) fails; call #2 (retry of item A) succeeds.
  const sender = makeInstrumentedSender(['fail', 'success']);

  const itemA = { mediaId: 'media_fail_A', sourceChannelId: 'isolated_test_source', messageId: '501', title: 'Failure Test A' };

  const decision1 = router.assignDestination(itemA);
  check('First assignment goes to TEST_DEST_1 (fresh isolated ledger)', decision1.destinationChannelId === 'TEST_DEST_1');

  let firstCallFailed = false;
  try {
    await sender.sendVideo(itemA, decision1.destinationChannelId);
    router.confirmSuccess(decision1.sourceIdentity, decision1.destinationChannelId);
  } catch (e) {
    firstCallFailed = true;
    ledger.recordFailure({
      sourceIdentity: decision1.sourceIdentity,
      sourceChannelId: itemA.sourceChannelId,
      sourceMessageId: itemA.messageId,
      destinationChannelId: decision1.destinationChannelId
    }, e.message);
  }
  check('First send call actually failed (instrumented)', firstCallFailed === true);
  check('Round-robin counter did NOT advance after failure', ledger.getNextRoundRobinIndex() === 0, `index=${ledger.getNextRoundRobinIndex()}`);

  // Retry: must lock to the SAME destination, not consume the next one.
  const decision2 = router.assignDestination(itemA);
  check('Retry locks to the SAME destination (TEST_DEST_1), does not consume TEST_DEST_2', decision2.destinationChannelId === 'TEST_DEST_1');
  check('Retry decision is flagged isRetry=true', decision2.isRetry === true);

  await sender.sendVideo(itemA, decision2.destinationChannelId);
  router.confirmSuccess(decision2.sourceIdentity, decision2.destinationChannelId);
  ledger.recordPublication({
    sourceIdentity: decision2.sourceIdentity,
    sourceChannelId: itemA.sourceChannelId,
    sourceMessageId: itemA.messageId,
    destinationChannelId: decision2.destinationChannelId,
    destinationUsername: decision2.destinationUsername,
    destinationMessageId: '999001',
    caption: decision2.generatedKoreanCaption
  });

  check('Counter advances to 1 only AFTER the retry actually succeeds', ledger.getNextRoundRobinIndex() === 1, `index=${ledger.getNextRoundRobinIndex()}`);
  check('Exactly 2 instrumented send calls were made total (1 fail + 1 success retry)', sender.calls.length === 2);
  check('Both calls targeted the same destination (TEST_DEST_1)', sender.calls.every(c => c.destination === 'TEST_DEST_1'));

  // A fresh, different item now correctly gets the NEXT destination (TEST_DEST_2),
  // proving the failed/retried item did not skip or double-consume a slot.
  const itemB = { mediaId: 'media_after_retry_B', sourceChannelId: 'isolated_test_source', messageId: '502', title: 'After Retry B' };
  const decisionB = router.assignDestination(itemB);
  check('Next fresh item after the retry-recovered failure goes to TEST_DEST_2', decisionB.destinationChannelId === 'TEST_DEST_2');

  if (fs.existsSync(ledgerPath)) fs.unlinkSync(ledgerPath);
}

async function main() {
  console.log('============================================================');
  console.log('🧪 ISOLATED ROUND-ROBIN INSTRUMENTATION E2E (PHASE 5)');
  console.log('============================================================');

  await testTwentySuccessfulPublicationsSequence();
  await testFailureDoesNotAdvanceCounterOrConsumeDestination();

  console.log('\n============================================================');
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log('============================================================');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('CRASHED:', err);
  process.exit(1);
});
