/**
 * test_global_round_robin_router.js
 * 
 * Stage 10.1 Global Round-Robin Router Comprehensive Test Suite
 * Validates authoritative persisted round-robin state, retry locks,
 * duplicate handling, legacy migration, 1,000-video balance, and 15m intervals.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { GlobalRoundRobinRouter, DESTINATION_KEYS, DESTINATIONS_META } = require("./global_round_robin_router");
const { PublishedLedger, TelegramPipelinePublisher, loadPipelineConfig } = require("./telegram_pipeline_publisher");

let totalTests = 0;
let passedTests = 0;

function runTest(description, testFn) {
  totalTests++;
  try {
    testFn();
    console.log(`✅ [PASS] ${totalTests}. ${description}`);
    passedTests++;
  } catch (err) {
    console.error(`❌ [FAIL] ${totalTests}. ${description}`);
    console.error(`   Error: ${err.message}`);
  }
}

console.log("==================================================");
console.log("🧪 RUNNING STAGE 10.1 STATE-HARDENED ROUND-ROBIN TESTS");
console.log("==================================================\n");

const testLedgerPath = path.join(__dirname, "scratch", "test_stage10_1_ledger.json");
if (fs.existsSync(testLedgerPath)) fs.unlinkSync(testLedgerPath);

// TEST 1 — 10 VIDEO ROUND ROBIN
runTest("TEST 1: 10 unique videos route sequentially 1->D1 ... 10->D10 and advance persisted index to 0", () => {
  const ledger = new PublishedLedger(testLedgerPath);
  ledger.setNextRoundRobinIndex(0);
  const router = new GlobalRoundRobinRouter({ ledger });

  const items = Array.from({ length: 10 }, (_, i) => ({
    sourceChannelId: "src_1",
    messageId: String(i + 1),
    title: `Video ${i + 1}`
  }));

  const expectedDestinations = [
    "DESTINATION_1", "DESTINATION_2", "DESTINATION_3", "DESTINATION_4", "DESTINATION_5",
    "DESTINATION_6", "DESTINATION_7", "DESTINATION_8", "DESTINATION_9", "DESTINATION_10"
  ];

  for (let i = 0; i < items.length; i++) {
    const decision = router.routeItem(items[i]);
    assert.strictEqual(decision.destinationChannelId, expectedDestinations[i], `Video #${i + 1} must route to ${expectedDestinations[i]}`);
    assert.strictEqual(decision.roundRobinNumber, i + 1);
  }

  // Persisted index must now be 0 (ready for video #11 -> DESTINATION_1)
  assert.strictEqual(ledger.getNextRoundRobinIndex(), 0);
});

// TEST 2 — 20 VIDEO ROUND ROBIN
runTest("TEST 2: 20 unique videos distribute exactly 2 per destination across D1..D10", () => {
  const ledger2Path = path.join(__dirname, "scratch", "test_20_ledger.json");
  if (fs.existsSync(ledger2Path)) fs.unlinkSync(ledger2Path);
  const ledger = new PublishedLedger(ledger2Path);
  ledger.setNextRoundRobinIndex(0);
  const router = new GlobalRoundRobinRouter({ ledger });

  const items = Array.from({ length: 20 }, (_, i) => ({
    sourceChannelId: "src_1",
    messageId: String(i + 1),
    title: `Video ${i + 1}`
  }));

  const batchResult = router.routeBatch(items);
  assert.strictEqual(batchResult.routed, 20);

  for (let i = 1; i <= 10; i++) {
    const key = `DESTINATION_${i}`;
    assert.strictEqual(batchResult.destinationCounts[key], 2, `${key} must have exactly 2 videos`);
  }

  assert.strictEqual(ledger.getNextRoundRobinIndex(), 0);
  if (fs.existsSync(ledger2Path)) fs.unlinkSync(ledger2Path);
});

// TEST 3 — 1,000 VIDEO BALANCE
runTest("TEST 3: 1,000 unique videos balance EXACTLY to 100 per destination (D1..D10 = 100)", () => {
  const ledger1000Path = path.join(__dirname, "scratch", "test_1000_ledger.json");
  if (fs.existsSync(ledger1000Path)) fs.unlinkSync(ledger1000Path);
  const ledger = new PublishedLedger(ledger1000Path);
  ledger.setNextRoundRobinIndex(0);
  const router = new GlobalRoundRobinRouter({ ledger });

  const items = [];
  for (let i = 1; i <= 1000; i++) {
    const srcNum = ((i - 1) % 8) + 1;
    items.push({
      sourceChannelId: `src_${srcNum}`,
      sourceUsername: `source_${srcNum}`,
      messageId: String(Math.floor((i - 1) / 8) + 100),
      title: `Multi-Source Video ${i}`
    });
  }

  const batchResult = router.routeBatch(items);
  assert.strictEqual(batchResult.routed, 1000);

  for (let i = 1; i <= 10; i++) {
    const key = `DESTINATION_${i}`;
    assert.strictEqual(batchResult.destinationCounts[key], 100, `${key} must have EXACTLY 100 videos out of 1000`);
  }

  assert.strictEqual(ledger.getNextRoundRobinIndex(), 0);
  if (fs.existsSync(ledger1000Path)) fs.unlinkSync(ledger1000Path);
});

// TEST 4 — CROSS-SOURCE GLOBAL ROUND ROBIN
runTest("TEST 4: Global round-robin sequence is continuous across multiple source channels", () => {
  const crossLedgerPath = path.join(__dirname, "scratch", "test_cross_ledger.json");
  if (fs.existsSync(crossLedgerPath)) fs.unlinkSync(crossLedgerPath);
  const ledger = new PublishedLedger(crossLedgerPath);
  ledger.setNextRoundRobinIndex(0);
  const router = new GlobalRoundRobinRouter({ ledger });

  const sourceA = [
    { sourceChannelId: "A", messageId: "1", title: "A1" },
    { sourceChannelId: "A", messageId: "2", title: "A2" },
    { sourceChannelId: "A", messageId: "3", title: "A3" }
  ];
  const sourceB = [
    { sourceChannelId: "B", messageId: "1", title: "B1" },
    { sourceChannelId: "B", messageId: "2", title: "B2" },
    { sourceChannelId: "B", messageId: "3", title: "B3" }
  ];
  const sourceC = [
    { sourceChannelId: "C", messageId: "1", title: "C1" },
    { sourceChannelId: "C", messageId: "2", title: "C2" },
    { sourceChannelId: "C", messageId: "3", title: "C3" }
  ];

  const combined = [...sourceA, ...sourceB, ...sourceC];
  const decisions = combined.map(item => router.routeItem(item));

  const expected = [
    "DESTINATION_1", "DESTINATION_2", "DESTINATION_3", // Source A
    "DESTINATION_4", "DESTINATION_5", "DESTINATION_6", // Source B
    "DESTINATION_7", "DESTINATION_8", "DESTINATION_9"  // Source C
  ];

  for (let i = 0; i < decisions.length; i++) {
    assert.strictEqual(decisions[i].destinationChannelId, expected[i], `Item ${i} must route to ${expected[i]}`);
  }

  assert.strictEqual(ledger.getNextRoundRobinIndex(), 9);
  if (fs.existsSync(crossLedgerPath)) fs.unlinkSync(crossLedgerPath);
});

// TEST 5 — SAME VIDEO CANNOT GO TO TWO DESTINATIONS & SUCCESS DUPLICATE DOES NOT ADVANCE COUNTER
runTest("TEST 5: Same source video cannot go to two destinations; SUCCESS duplicate DOES NOT advance counter", () => {
  const dupLedgerPath = path.join(__dirname, "scratch", "test_dup_ledger.json");
  if (fs.existsSync(dupLedgerPath)) fs.unlinkSync(dupLedgerPath);
  const ledger = new PublishedLedger(dupLedgerPath);
  ledger.setNextRoundRobinIndex(0);
  const router = new GlobalRoundRobinRouter({ ledger });

  const item = { sourceChannelId: "100", messageId: "777", title: "Unique Video" };

  // First routing -> DESTINATION_1, counter advances from 0 to 1
  const firstDecision = router.routeItem(item);
  assert.strictEqual(firstDecision.destinationChannelId, "DESTINATION_1");
  assert.strictEqual(ledger.getNextRoundRobinIndex(), 1);

  // Record successful publication in ledger
  ledger.recordPublication({
    sourceIdentity: "100:777",
    sourceChannelId: "100",
    sourceMessageId: "777",
    destinationChannelId: firstDecision.destinationChannelId,
    destinationUsername: firstDecision.destinationUsername,
    destinationMessageId: "9001",
    caption: firstDecision.generatedKoreanCaption
  });

  // Second routing attempt for the exact same video
  const secondDecision = router.routeItem(item);
  assert.strictEqual(secondDecision.alreadyPublished, true);
  assert.strictEqual(secondDecision.status, "SKIPPED_ALREADY_PUBLISHED");
  assert.strictEqual(secondDecision.destinationChannelId, "DESTINATION_1", "Must preserve original destination");

  // Counter MUST NOT advance on duplicate!
  assert.strictEqual(ledger.getNextRoundRobinIndex(), 1, "Counter MUST NOT advance when evaluating duplicate published video");

  if (fs.existsSync(dupLedgerPath)) fs.unlinkSync(dupLedgerPath);
});

// TEST 6 — RESTART PERSISTENCE (DIRECT LOAD OF PERSISTED COUNTER)
runTest("TEST 6: Authoritative next round-robin counter loads directly from disk upon restart", () => {
  const restartLedgerPath = path.join(__dirname, "scratch", "test_restart_authoritative.json");
  if (fs.existsSync(restartLedgerPath)) fs.unlinkSync(restartLedgerPath);

  // Initialize ledger and assign 7 items (advances counter to index 7 -> DESTINATION_8)
  const ledger1 = new PublishedLedger(restartLedgerPath);
  ledger1.setNextRoundRobinIndex(0);
  const router1 = new GlobalRoundRobinRouter({ ledger: ledger1 });

  for (let i = 1; i <= 7; i++) {
    router1.routeItem({ sourceChannelId: "src_init", messageId: String(i) });
  }

  assert.strictEqual(ledger1.getNextRoundRobinIndex(), 7, "Persisted index must be 7");

  // Reinitialize from disk (simulating restart)
  const ledger2 = new PublishedLedger(restartLedgerPath);
  assert.strictEqual(ledger2.getNextRoundRobinIndex(), 7, "Direct load from disk must preserve index 7");

  const router2 = new GlobalRoundRobinRouter({ ledger: ledger2 });
  assert.strictEqual(router2.getCurrentIndex(), 7);

  const nextDecision = router2.routeItem({ sourceChannelId: "src_init", messageId: "8" });
  assert.strictEqual(nextDecision.destinationChannelId, "DESTINATION_8");
  assert.strictEqual(ledger2.getNextRoundRobinIndex(), 8);

  if (fs.existsSync(restartLedgerPath)) fs.unlinkSync(restartLedgerPath);
});

// TEST 7 — FAILED RETRY DOES NOT ADVANCE COUNTER
runTest("TEST 7: Retrying a failed publication preserves destination and DOES NOT advance the global counter", () => {
  const failLedgerPath = path.join(__dirname, "scratch", "test_fail_ledger.json");
  if (fs.existsSync(failLedgerPath)) fs.unlinkSync(failLedgerPath);
  const ledger = new PublishedLedger(failLedgerPath);
  ledger.setNextRoundRobinIndex(4); // Start at index 4 (DESTINATION_5)
  const router = new GlobalRoundRobinRouter({ ledger });

  const failItem = { sourceChannelId: "src_fail", messageId: "999", title: "Failed Video" };
  const firstDecision = router.routeItem(failItem);
  assert.strictEqual(firstDecision.destinationChannelId, "DESTINATION_5");
  assert.strictEqual(ledger.getNextRoundRobinIndex(), 5, "Counter advanced to 5 after initial assignment");

  // Record failure in ledger
  ledger.recordFailure({
    sourceIdentity: "src_fail:999",
    sourceChannelId: "src_fail",
    sourceMessageId: "999",
    destinationChannelId: "DESTINATION_5"
  }, "400: CHAT_FORWARDS_RESTRICTED");

  // Re-route on retry cycle
  const retryDecision = router.routeItem(failItem);
  assert.strictEqual(retryDecision.destinationChannelId, "DESTINATION_5", "Retry MUST lock to DESTINATION_5");
  assert.strictEqual(retryDecision.isRetry, true);

  // Counter MUST NOT advance on retry!
  assert.strictEqual(ledger.getNextRoundRobinIndex(), 5, "Counter MUST remain 5 after retrying failed video");

  if (fs.existsSync(failLedgerPath)) fs.unlinkSync(failLedgerPath);
});

// TEST 8 — DUPLICATE INPUTS DO NOT ADVANCE COUNTER
runTest("TEST 8: In-batch duplicate input items are skipped and DO NOT advance the global counter", () => {
  const batchLedgerPath = path.join(__dirname, "scratch", "test_batch_dup_ledger.json");
  if (fs.existsSync(batchLedgerPath)) fs.unlinkSync(batchLedgerPath);
  const ledger = new PublishedLedger(batchLedgerPath);
  ledger.setNextRoundRobinIndex(0);
  const router = new GlobalRoundRobinRouter({ ledger });

  const items = [
    { sourceChannelId: "S1", messageId: "1", title: "Video 1" },
    { sourceChannelId: "S1", messageId: "1", title: "Video 1 (Duplicate)" },
    { sourceChannelId: "S1", messageId: "2", title: "Video 2" },
    { sourceChannelId: "S1", messageId: "2", title: "Video 2 (Duplicate)" },
    { sourceChannelId: "S1", messageId: "3", title: "Video 3" }
  ];

  const batchResult = router.routeBatch(items);
  assert.strictEqual(batchResult.routed, 3);
  assert.strictEqual(batchResult.skippedDuplicates, 2);
  assert.strictEqual(batchResult.destinationCounts["DESTINATION_1"], 1);
  assert.strictEqual(batchResult.destinationCounts["DESTINATION_2"], 1);
  assert.strictEqual(batchResult.destinationCounts["DESTINATION_3"], 1);

  // Counter should be at 3 (for 3 unique items)
  assert.strictEqual(ledger.getNextRoundRobinIndex(), 3, "Counter must be 3 for 3 unique items");

  if (fs.existsSync(batchLedgerPath)) fs.unlinkSync(batchLedgerPath);
});

// TEST 9 — SAFE DETERMINISTIC LEGACY MIGRATION
runTest("TEST 9: Legacy ledger lacking nextRoundRobinIndex derives initial index once, persists it, and uses persisted counter thereafter", () => {
  const legacyLedgerPath = path.join(__dirname, "scratch", "test_legacy_migration_ledger.json");
  if (fs.existsSync(legacyLedgerPath)) fs.unlinkSync(legacyLedgerPath);

  // Create legacy format ledger payload (without nextRoundRobinIndex)
  const legacyPayload = {
    version: "1.0.0",
    updatedAt: "2026-09-01T00:00:00.000Z",
    totalPublished: 23,
    records: Array.from({ length: 23 }, (_, i) => ({
      sourceIdentity: `legacy:${i + 1}`,
      sourceChannelId: "legacy",
      sourceMessageId: String(i + 1),
      destinationChannelId: `DESTINATION_${(i % 10) + 1}`,
      status: "SUCCESS"
    }))
  };
  fs.writeFileSync(legacyLedgerPath, JSON.stringify(legacyPayload, null, 2), "utf8");

  // Load into PublishedLedger -> migration triggers: 23 % 10 = 3
  const ledger = new PublishedLedger(legacyLedgerPath);
  assert.strictEqual(ledger.getNextRoundRobinIndex(), 3, "Migration must derive index 3 (23 % 10)");

  // Verify it was persisted to disk with version 1.1.0 and nextRoundRobinIndex = 3
  const persistedRaw = JSON.parse(fs.readFileSync(legacyLedgerPath, "utf8"));
  assert.strictEqual(persistedRaw.nextRoundRobinIndex, 3, "Migration must write nextRoundRobinIndex: 3 to disk");

  // Route 1 new item -> DESTINATION_4 (index 3), counter advances to 4
  const router = new GlobalRoundRobinRouter({ ledger });
  const decision = router.routeItem({ sourceChannelId: "new_src", messageId: "1" });
  assert.strictEqual(decision.destinationChannelId, "DESTINATION_4");
  assert.strictEqual(ledger.getNextRoundRobinIndex(), 4);

  if (fs.existsSync(legacyLedgerPath)) fs.unlinkSync(legacyLedgerPath);
});

// TEST 10 — 15-MINUTE INTERVAL & UNTOUCHED SCRAPER.JS
runTest("TEST 10: Pipeline configuration interval is exactly 900000 ms (15 minutes) and scraper.js is untouched", () => {
  const config = loadPipelineConfig();
  assert.strictEqual(config.schedulerIntervalMs, 900000, "schedulerIntervalMs in pipeline_config.json must be 900000 ms");

  const publisher = new TelegramPipelinePublisher();
  assert.strictEqual(publisher.config.schedulerIntervalMs, 900000, "Publisher instance interval must be 900000 ms");

  // Verify scraper.js intervals remain untouched
  const scraperCode = fs.readFileSync(path.join(__dirname, "scraper.js"), "utf8");
  assert.ok(scraperCode.includes("10 * 60 * 1000"), "Trending scraper interval in scraper.js must remain 10m");
  assert.ok(scraperCode.includes("3 * 60 * 1000"), "Breaking news interval in scraper.js must remain 3m");
  assert.ok(scraperCode.includes("5 * 60 * 1000"), "Telegram refresh interval in scraper.js must remain 5m");
});

// Clean up scratch test ledger
if (fs.existsSync(testLedgerPath)) fs.unlinkSync(testLedgerPath);

console.log("\n==================================================");
console.log(`📊 STAGE 10.1 ROUND-ROBIN RESULTS: ${passedTests} PASSED, ${totalTests - passedTests} FAILED`);
console.log("==================================================\n");

if (passedTests !== totalTests) {
  process.exit(1);
}
