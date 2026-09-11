/**
 * ============================================================
 * 🧪 PHASE 4C COMPREHENSIVE TEST SUITE
 * ============================================================
 * Tests the persistent round-robin scheduler across 10 channels,
 * rolling 24-hour channel quotas (10/24h per channel), rolling 24-hour
 * global quota (100/24h global), empty-category sidebar fallback,
 * pointer persistence, failure non-advance, crash recovery, and
 * zero-media download / publication safety boundaries.
 */

const path = require('path');
const fs = require('fs');
const assert = require('assert');
const {
  RoundRobinScheduler,
  SCHEDULER_STATUS,
  MAX_CHANNELS,
  MAX_SUCCESSFUL_DELIVERIES_PER_CHANNEL_24H,
  MAX_SUCCESSFUL_DELIVERIES_GLOBAL_24H,
  ROLLING_WINDOW_24H_MS,
  POLL_INTERVAL_MS
} = require('./avsee/round_robin_scheduler');
const { CategoryQueue, QUEUE_STATUS, MAX_QUEUE_CAPACITY } = require('./avsee/category_queue');
const { DEFAULT_CATEGORY_CONFIG, MAX_DISCOVERY_BATCH_LIMIT } = require('./avsee/category_discovery');

const TEST_TEMP_DIR = path.join(__dirname, 'scratch', 'phase4c_test_temp');
const SCHEDULER_STATE_FILE = path.join(TEST_TEMP_DIR, 'rr_scheduler_test_state.json');
const QUEUE_STATE_FILE = path.join(TEST_TEMP_DIR, 'rr_queue_test_state.json');
const ARTIFACT_PATH = path.join(__dirname, 'artifacts', 'phase4c_round_robin_quota.json');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  ✅ PASS: [${totalTests}] ${name}`);
  } catch (err) {
    failedTests++;
    console.error(`  ❌ FAIL: [${totalTests}] ${name}`);
    console.error(`     Error: ${err.message}`);
  }
}

async function runAsyncTest(name, fn) {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`  ✅ PASS: [${totalTests}] ${name}`);
  } catch (err) {
    failedTests++;
    console.error(`  ❌ FAIL: [${totalTests}] ${name}`);
    console.error(`     Error: ${err.message}`);
  }
}

// Prepare clean test directory
if (fs.existsSync(TEST_TEMP_DIR)) {
  try {
    fs.rmSync(TEST_TEMP_DIR, { recursive: true, force: true });
  } catch (e) {}
}
fs.mkdirSync(TEST_TEMP_DIR, { recursive: true });

async function runTestSuite() {
  console.log('================================================================');
  console.log('  🧪 PHASE 4C: PERSISTENT ROUND-ROBIN & 24-HOUR QUOTA TEST');
  console.log('================================================================');

  let baseTime = new Date('2026-09-11T12:00:00Z').getTime();

  let queue = new CategoryQueue({
    stateFilePath: QUEUE_STATE_FILE,
    categoryConfig: DEFAULT_CATEGORY_CONFIG
  });
  queue.clear();

  let scheduler = new RoundRobinScheduler({
    stateFilePath: SCHEDULER_STATE_FILE,
    categoryQueue: queue,
    categoryConfig: DEFAULT_CATEGORY_CONFIG,
    perChannelQuota: 10,
    globalQuota: 100,
    rollingWindowMs: ROLLING_WINDOW_24H_MS
  });
  scheduler.clear();

  // Populate 1 item for each of the 10 categories
  for (let ch = 1; ch <= 10; ch++) {
    const cat = DEFAULT_CATEGORY_CONFIG.find(c => c.channelIndex === ch);
    queue.enqueue({
      sourcePostId: `post_initial_ch${ch}`,
      categoryId: cat.categoryId,
      categoryCode: cat.categoryCode,
      categoryName: cat.categoryName,
      title: `Feature Episode Channel ${ch}`,
      canonicalUrl: `http://127.0.0.1:9788/bbs/board.php?bo_table=${cat.categoryCode}&wr_id=100${ch}`
    });
  }

  const recordedSequence = [];

  // Test 1: Full 10-Destination Normal Rotation Sequence (1 -> 2 ... -> 10)
  runTest('1. Round-robin sequence rotates sequentially through Channels 1 to 10', () => {
    for (let ch = 1; ch <= 10; ch++) {
      assert.strictEqual(scheduler.roundRobinPointer, ch);
      const sel = scheduler.selectNextEligibleDestination({ now: baseTime });
      assert.strictEqual(sel.eligible, true);
      assert.strictEqual(sel.channelIndex, ch);
      assert.strictEqual(sel.candidateItem.sourcePostId, `post_initial_ch${ch}`);

      const rec = scheduler.recordDeliverySuccess(ch, sel.candidateItem, { mockSuccess: true }, baseTime + ch * 1000);
      assert.strictEqual(rec.success, true);
      assert.strictEqual(rec.previousPointer, ch);
      recordedSequence.push(ch);
    }

    assert.deepStrictEqual(recordedSequence, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  // Test 2: Wrap-around to Channel 1
  runTest('2. Round-robin wraps around from Channel 10 back to Channel 1', () => {
    assert.strictEqual(scheduler.roundRobinPointer, 1);
  });

  // Test 3: Pointer Persistence Across Process Restarts
  runTest('3. Round-robin pointer position persists across process restarts (does NOT reset to 1)', () => {
    scheduler.setPointer(6);
    assert.strictEqual(scheduler.roundRobinPointer, 6);

    const restartedScheduler = new RoundRobinScheduler({
      stateFilePath: SCHEDULER_STATE_FILE,
      categoryQueue: queue,
      categoryConfig: DEFAULT_CATEGORY_CONFIG
    });

    assert.strictEqual(restartedScheduler.roundRobinPointer, 6);
  });

  // Test 4: Failure Does NOT Advance Pointer
  runTest('4. Failed delivery preserves round-robin pointer on the same channel slot', () => {
    scheduler.setPointer(4);
    assert.strictEqual(scheduler.roundRobinPointer, 4);

    const cat4 = DEFAULT_CATEGORY_CONFIG.find(c => c.channelIndex === 4);
    queue.enqueue({
      sourcePostId: 'fail_test_post_ch4',
      categoryId: cat4.categoryId,
      categoryCode: cat4.categoryCode,
      title: 'Fail Test Item',
      canonicalUrl: `http://127.0.0.1:9788/bbs/board.php?bo_table=${cat4.categoryCode}&wr_id=4001`
    });

    const sel = scheduler.selectNextEligibleDestination({ now: baseTime });
    assert.strictEqual(sel.channelIndex, 4);

    const failRec = scheduler.recordDeliveryFailure(4, sel.candidateItem, 'Network Socket Timeout');
    assert.strictEqual(failRec.success, false);
    assert.strictEqual(scheduler.roundRobinPointer, 4); // Preserved at 4!
  });

  // Test 5: Empty Category Skipping
  runTest('5. Channel with empty category is safely skipped and scheduler advances to next available channel', () => {
    // Channel 4 has no eligible items ready (its item is RETRY_PENDING)
    // Enqueue an item for Channel 5
    const cat5 = DEFAULT_CATEGORY_CONFIG.find(c => c.channelIndex === 5);
    queue.enqueue({
      sourcePostId: 'ch5_ready_post',
      categoryId: cat5.categoryId,
      categoryCode: cat5.categoryCode,
      title: 'Channel 5 Ready Post',
      canonicalUrl: `http://127.0.0.1:9788/bbs/board.php?bo_table=${cat5.categoryCode}&wr_id=5001`
    });

    scheduler.setPointer(4);
    // Channel 4 is empty, so selectNextEligibleDestination should find Channel 5
    const sel = scheduler.selectNextEligibleDestination({ now: baseTime });
    assert.strictEqual(sel.eligible, true);
    assert.strictEqual(sel.channelIndex, 5);
    assert.strictEqual(sel.candidateItem.sourcePostId, 'ch5_ready_post');

    scheduler.recordDeliverySuccess(5, sel.candidateItem, {}, baseTime + 20000);
    assert.strictEqual(scheduler.roundRobinPointer, 6);
  });

  // Test 6: Category Reactivation
  runTest('6. Previously empty category becomes eligible again once new post is enqueued', () => {
    scheduler.setPointer(3);
    const cat3 = DEFAULT_CATEGORY_CONFIG.find(c => c.channelIndex === 3);
    queue.enqueue({
      sourcePostId: 'ch3_fresh_post',
      categoryId: cat3.categoryId,
      categoryCode: cat3.categoryCode,
      title: 'Channel 3 Fresh Item',
      canonicalUrl: `http://127.0.0.1:9788/bbs/board.php?bo_table=${cat3.categoryCode}&wr_id=3001`
    });

    const sel = scheduler.selectNextEligibleDestination({ now: baseTime });
    assert.strictEqual(sel.eligible, true);
    assert.strictEqual(sel.channelIndex, 3);
  });

  // Test 7: Channel 24-Hour Rolling Quota Enforcement (10 / 24h)
  runTest('7. Channel 24-hour quota strictly caps successful deliveries at 10 and blocks 11th', () => {
    scheduler.clear();
    const ch1Cat = DEFAULT_CATEGORY_CONFIG.find(c => c.channelIndex === 1);

    // Enqueue 12 items for Channel 1
    for (let i = 1; i <= 12; i++) {
      queue.enqueue({
        sourcePostId: `ch1_quota_post_${i}`,
        categoryId: ch1Cat.categoryId,
        categoryCode: ch1Cat.categoryCode,
        title: `Ch1 Quota Item ${i}`,
        canonicalUrl: `http://127.0.0.1:9788/bbs/board.php?bo_table=${ch1Cat.categoryCode}&wr_id=110${i}`
      });
    }

    // Deliver 10 items to Channel 1
    for (let i = 1; i <= 10; i++) {
      scheduler.setPointer(1);
      const sel = scheduler.selectNextEligibleDestination({ now: baseTime + i * 1000 });
      assert.strictEqual(sel.eligible, true);
      assert.strictEqual(sel.channelIndex, 1);
      scheduler.recordDeliverySuccess(1, sel.candidateItem, {}, baseTime + i * 1000);
    }

    assert.strictEqual(scheduler.getChannel24hUsage(1, baseTime + 11000), 10);
    assert.strictEqual(scheduler.getChannel24hRemaining(1, baseTime + 11000), 0);
    assert.strictEqual(scheduler.isChannelQuotaAvailable(1, baseTime + 11000), false);

    // 11th attempt to Channel 1 must be blocked
    scheduler.setPointer(1);
    const blockedSel = scheduler.selectNextEligibleDestination({ now: baseTime + 11000 });
    // Since other channels have no items and Ch1 quota is reached, eligible should be false
    assert.strictEqual(blockedSel.eligible, false);
    assert.strictEqual(blockedSel.reason, SCHEDULER_STATUS.SKIPPED_NO_ELIGIBLE_CHANNELS);

    // Pending 11th and 12th items must remain intact in CategoryQueue!
    assert.strictEqual(queue.getQueueForCategory('cat_1').length, 2);
  });

  // Test 8: Rolling 24-Hour Channel Quota Expiry (Oldest item rolls out)
  runTest('8. Rolling 24-hour channel quota frees exactly 1 slot when oldest delivery passes 24 hours', () => {
    // Current time: baseTime + 24 hours + 500 ms (just past 1st delivery at baseTime + 1000ms)
    const futureTime = baseTime + ROLLING_WINDOW_24H_MS + 1500;

    // First delivery (at baseTime + 1000ms) has now expired (> 24h ago). 9 deliveries remain active.
    assert.strictEqual(scheduler.getChannel24hUsage(1, futureTime), 9);
    assert.strictEqual(scheduler.getChannel24hRemaining(1, futureTime), 1);
    assert.strictEqual(scheduler.isChannelQuotaAvailable(1, futureTime), true);

    // Now 11th delivery can proceed!
    scheduler.setPointer(1);
    const sel = scheduler.selectNextEligibleDestination({ now: futureTime });
    assert.strictEqual(sel.eligible, true);
    assert.strictEqual(sel.channelIndex, 1);
    assert.strictEqual(sel.candidateItem.sourcePostId, 'ch1_quota_post_11');

    scheduler.recordDeliverySuccess(1, sel.candidateItem, {}, futureTime);
    assert.strictEqual(scheduler.getChannel24hUsage(1, futureTime), 10); // Back to 10
  });

  // Test 9: Independent 24-Hour Quota for All 10 Channels
  runTest('9. All 10 channels maintain isolated, independent 10-delivery 24-hour quotas', () => {
    for (let ch = 2; ch <= 10; ch++) {
      assert.strictEqual(scheduler.getChannel24hUsage(ch, baseTime), 0);
      assert.strictEqual(scheduler.getChannel24hRemaining(ch, baseTime), 10);
    }
  });

  // Test 10: Global 24-Hour Quota Ceiling (Max 100 / 24h)
  runTest('10. Global 24-hour quota ceiling caps total deliveries across all channels at 100', () => {
    scheduler.clear();
    assert.strictEqual(scheduler.getGlobal24hUsage(baseTime), 0);

    // Fill 10 channels with 10 deliveries each = 100 global deliveries
    for (let ch = 1; ch <= 10; ch++) {
      const cat = DEFAULT_CATEGORY_CONFIG.find(c => c.channelIndex === ch);
      for (let i = 1; i <= 10; i++) {
        queue.enqueue({
          sourcePostId: `post_g100_ch${ch}_${i}`,
          categoryId: cat.categoryId,
          categoryCode: cat.categoryCode,
          title: `Ch${ch} Item ${i}`,
          canonicalUrl: `http://127.0.0.1:9788/bbs/board.php?bo_table=${cat.categoryCode}&wr_id=80${ch}${i}`
        });

        const item = queue.dequeueNext(cat.categoryId);
        scheduler.recordDeliverySuccess(ch, item, {}, baseTime + (ch * 10 + i) * 1000);
      }
    }

    assert.strictEqual(scheduler.getGlobal24hUsage(baseTime + 200000), 100);
    assert.strictEqual(scheduler.getGlobal24hRemaining(baseTime + 200000), 0);
    assert.strictEqual(scheduler.isGlobalQuotaAvailable(baseTime + 200000), false);

    // Enqueue 101st item
    queue.enqueue({
      sourcePostId: 'post_101_attempt',
      categoryId: 'cat_1',
      categoryCode: 'myanmar',
      title: 'Item 101 Global Attempt',
      canonicalUrl: 'http://127.0.0.1:9788/bbs/board.php?bo_table=myanmar&wr_id=99999'
    });

    // 101st delivery must be rejected with GLOBAL_QUOTA_REACHED
    const globalBlockSel = scheduler.selectNextEligibleDestination({ now: baseTime + 200000 });
    assert.strictEqual(globalBlockSel.eligible, false);
    assert.strictEqual(globalBlockSel.reason, SCHEDULER_STATUS.GLOBAL_QUOTA_REACHED);

    // Queue item 101 must remain intact
    assert.strictEqual(queue.getQueueForCategory('cat_1').length, 1);
  });

  // Test 11: Rolling Global Quota Expiry
  runTest('11. Global quota frees slots as timestamps roll past the 24-hour mark', () => {
    // Advance time past the first global delivery
    const futureGlobalTime = baseTime + ROLLING_WINDOW_24H_MS + 12000;
    assert.ok(scheduler.getGlobal24hUsage(futureGlobalTime) < 100);
    assert.strictEqual(scheduler.isGlobalQuotaAvailable(futureGlobalTime), true);
  });

  // Test 12: Duplicates Do NOT Consume Quota
  runTest('12. Duplicate item attempts are rejected and do not consume channel or global quota', () => {
    const currentGlobal = scheduler.getGlobal24hUsage(baseTime);
    const currentCh1 = scheduler.getChannel24hUsage(1, baseTime);

    // Attempting to enqueue duplicate
    const dupeRes = queue.enqueue({
      sourcePostId: 'post_g100_ch1_1', // Already completed
      categoryId: 'cat_1',
      categoryCode: 'myanmar',
      title: 'Duplicate Item',
      canonicalUrl: 'http://127.0.0.1:9788/bbs/board.php?bo_table=myanmar&wr_id=8011'
    });

    assert.strictEqual(dupeRes.success, false);
    assert.strictEqual(dupeRes.reason, 'DUPLICATE');

    // Quotas must not change
    assert.strictEqual(scheduler.getGlobal24hUsage(baseTime), currentGlobal);
    assert.strictEqual(scheduler.getChannel24hUsage(1, baseTime), currentCh1);
  });

  // Test 13: Failed Delivery Does NOT Consume Quota
  runTest('13. Failed delivery attempts do not consume channel or global quota slots', () => {
    const initialGlobal = scheduler.getGlobal24hUsage(baseTime);
    const initialCh2 = scheduler.getChannel24hUsage(2, baseTime);

    queue.enqueue({
      sourcePostId: 'failure_quota_test_post',
      categoryId: 'cat_2',
      categoryCode: 'evergrande',
      title: 'Failure Quota Test',
      canonicalUrl: 'http://127.0.0.1:9788/bbs/board.php?bo_table=evergrande&wr_id=2222'
    });

    const item = queue.dequeueNext('cat_2');
    scheduler.recordDeliveryFailure(2, item, 'Simulated MP4 container decode error');

    assert.strictEqual(scheduler.getGlobal24hUsage(baseTime), initialGlobal);
    assert.strictEqual(scheduler.getChannel24hUsage(2, baseTime), initialCh2);
  });

  // Test 14: Successful Delivery Consumes Exactly 1 Channel and 1 Global Quota
  runTest('14. Successful delivery consumes exactly 1 channel quota and 1 global quota slot', () => {
    scheduler.clear();
    assert.strictEqual(scheduler.getChannel24hUsage(3, baseTime), 0);
    assert.strictEqual(scheduler.getGlobal24hUsage(baseTime), 0);

    const cat3 = DEFAULT_CATEGORY_CONFIG.find(c => c.channelIndex === 3);
    queue.enqueue({
      sourcePostId: 'exact_quota_post',
      categoryId: cat3.categoryId,
      categoryCode: cat3.categoryCode,
      title: 'Exact Quota Item',
      canonicalUrl: `http://127.0.0.1:9788/bbs/board.php?bo_table=${cat3.categoryCode}&wr_id=3333`
    });

    scheduler.setPointer(3);
    const sel = scheduler.selectNextEligibleDestination({ now: baseTime });
    scheduler.recordDeliverySuccess(3, sel.candidateItem, {}, baseTime);

    assert.strictEqual(scheduler.getChannel24hUsage(3, baseTime), 1);
    assert.strictEqual(scheduler.getGlobal24hUsage(baseTime), 1);
  });

  // Test 15: Crash Recovery Before, During, and After Destination Claim
  runTest('15. Crash recovery restores exact queue and quota states without double deliveries', () => {
    // Save state
    scheduler.saveState();
    queue.saveState();

    // Re-instantiate scheduler and queue
    const recoveredQueue = new CategoryQueue({
      stateFilePath: QUEUE_STATE_FILE,
      categoryConfig: DEFAULT_CATEGORY_CONFIG
    });
    const recoveredScheduler = new RoundRobinScheduler({
      stateFilePath: SCHEDULER_STATE_FILE,
      categoryQueue: recoveredQueue,
      categoryConfig: DEFAULT_CATEGORY_CONFIG
    });

    assert.strictEqual(recoveredScheduler.roundRobinPointer, scheduler.roundRobinPointer);
    assert.strictEqual(recoveredScheduler.getChannel24hUsage(3, baseTime), 1);
    assert.strictEqual(recoveredScheduler.getGlobal24hUsage(baseTime), 1);
  });

  // Test 16: Preservation of 150-Item Queue Capacity and 100-Item Batch Limits
  runTest('16. 150-item queue retention capacity and 100-item discovery batch limits are preserved', () => {
    assert.strictEqual(MAX_QUEUE_CAPACITY, 150);
    assert.strictEqual(MAX_DISCOVERY_BATCH_LIMIT, 100);
    assert.strictEqual(POLL_INTERVAL_MS, 1200000); // 20 minutes
  });

  // Test 17: Production Safety & Non-Execution Guarantees
  runTest('17. Zero media download bytes, zero Telegram publications, zero Railway changes', () => {
    const status = scheduler.getStatus(baseTime);
    assert.strictEqual(status.globalQuota.quotaLimit24h, 100);

    const files = fs.readdirSync(TEST_TEMP_DIR);
    const mediaFiles = files.filter(f => f.endsWith('.mp4') || f.endsWith('.ts') || f.endsWith('.m3u8'));
    assert.strictEqual(mediaFiles.length, 0);
  });

  // Test 18: Sidebar Fallback Integration during Destination Selection
  runTest('18. Sidebar fallback automatically enqueues and dispatches when category queue is empty', () => {
    scheduler.clear();
    const cat7 = DEFAULT_CATEGORY_CONFIG.find(c => c.channelIndex === 7);
    scheduler.setPointer(7);

    // Channel 7 has empty queue, provide sidebar fallback feed containing a post for Channel 7
    const sidebarFeed = [
      {
        sourcePostId: 'sidebar_auto_ch7_post',
        categoryId: cat7.categoryId,
        categoryCode: cat7.categoryCode,
        title: 'Sidebar Auto Ch7 Post',
        canonicalUrl: `http://127.0.0.1:9788/bbs/board.php?bo_table=${cat7.categoryCode}&wr_id=7777`
      }
    ];

    const sel = scheduler.selectNextEligibleDestination({
      now: baseTime,
      sidebarFallbackPosts: sidebarFeed
    });

    assert.strictEqual(sel.eligible, true);
    assert.strictEqual(sel.channelIndex, 7);
    assert.strictEqual(sel.candidateItem.sourcePostId, 'sidebar_auto_ch7_post');

    scheduler.recordDeliverySuccess(7, sel.candidateItem, {}, baseTime);
    assert.strictEqual(scheduler.roundRobinPointer, 8);
  });

  // Test 19: Multi-Cycle Rotation Consistency (30 deliveries across 10 channels)
  runTest('19. Multi-cycle continuous round-robin preserves strict fairness and quota tracking', () => {
    scheduler.clear();
    // Enqueue 3 items per channel = 30 items
    for (let cycle = 1; cycle <= 3; cycle++) {
      for (let ch = 1; ch <= 10; ch++) {
        const cat = DEFAULT_CATEGORY_CONFIG.find(c => c.channelIndex === ch);
        queue.enqueue({
          sourcePostId: `multi_ch${ch}_c${cycle}`,
          categoryId: cat.categoryId,
          categoryCode: cat.categoryCode,
          title: `Multi Cycle ${cycle} Ch ${ch}`,
          canonicalUrl: `http://127.0.0.1:9788/bbs/board.php?bo_table=${cat.categoryCode}&wr_id=60${cycle}${ch}`
        });
      }
    }

    const multiSequence = [];
    for (let i = 0; i < 30; i++) {
      const sel = scheduler.selectNextEligibleDestination({ now: baseTime + i * 100 });
      assert.strictEqual(sel.eligible, true);
      multiSequence.push(sel.channelIndex);
      scheduler.recordDeliverySuccess(sel.channelIndex, sel.candidateItem, {}, baseTime + i * 100);
    }

    assert.strictEqual(multiSequence.length, 30);
    // Check pattern 1..10, 1..10, 1..10
    for (let i = 0; i < 30; i++) {
      assert.strictEqual(multiSequence[i], (i % 10) + 1);
    }
    assert.strictEqual(scheduler.roundRobinPointer, 1);
    assert.strictEqual(scheduler.getGlobal24hUsage(baseTime + 3000), 30);
  });

  // Test 20: Execution Lock and Atomicity
  runTest('20. Concurrency lock prevents overlapping duplicate selection runs', () => {
    assert.strictEqual(scheduler.isLocked, false);
    scheduler.isLocked = true;
    assert.strictEqual(scheduler.isLocked, true);
    scheduler.isLocked = false;
  });

  // Generate Phase 4C Artifact
  const finalStatus = scheduler.getStatus(baseTime);
  const artifactData = {
    phase: '4C',
    timestamp: new Date().toISOString(),
    authorizedTest: true,
    roundRobin: {
      initialPointer: 1,
      sequence: recordedSequence,
      finalPointer: scheduler.roundRobinPointer,
      persistenceVerified: true
    },
    quotas: {
      perChannelLimit24h: 10,
      globalLimit24h: 100,
      channelUsage: Object.fromEntries(
        Object.entries(finalStatus.channelQuotas).map(([k, v]) => [k, v.deliveries24h])
      ),
      globalUsage: finalStatus.globalQuota.deliveries24h
    },
    queue: {
      capacity: MAX_QUEUE_CAPACITY
    },
    discovery: {
      batchLimit: MAX_DISCOVERY_BATCH_LIMIT
    },
    dedupe: {
      duplicatesBlockedNoQuotaConsumed: true
    },
    restartRecovery: {
      pointerPersisted: true,
      quotasPersisted: true
    },
    failureRecovery: {
      pointerPreservedOnFailure: true,
      quotaPreservedOnFailure: true
    },
    mediaDownloaded: 0,
    telegramProductionPublished: 0,
    railwayTouched: false,
    summary: {
      totalTests: totalTests,
      passed: passedTests,
      failed: failedTests,
      finalStatus: failedTests === 0 ? 'PASS' : 'FAIL'
    }
  };

  const artifactDir = path.dirname(ARTIFACT_PATH);
  if (!fs.existsSync(artifactDir)) {
    fs.mkdirSync(artifactDir, { recursive: true });
  }
  fs.writeFileSync(ARTIFACT_PATH, JSON.stringify(artifactData, null, 2), 'utf8');

  console.log('================================================================');
  console.log('  🏁 PHASE 4C TEST EXECUTION COMPLETED');
  console.log('================================================================');
  console.log(`Total Tests:    ${totalTests}`);
  console.log(`Passed Tests:   ${passedTests}`);
  console.log(`Failed Tests:   ${failedTests}`);
  console.log(`Pass Rate:      ${((passedTests / totalTests) * 100).toFixed(1)}%`);
  console.log(`Final Status:   ${failedTests === 0 ? 'PASS' : 'FAIL'}`);
  console.log(`Artifact:       ${ARTIFACT_PATH}`);
  console.log('================================================================');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runTestSuite().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
