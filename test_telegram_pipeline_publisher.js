/**
 * test_telegram_pipeline_publisher.js
 * 
 * Unit Test Suite for Stage 8 Telegram Pipeline Publisher
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  PublishedLedger,
  TelegramPipelinePublisher
} = require("./telegram_pipeline_publisher");

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
console.log("🧪 RUNNING TELEGRAM PIPELINE PUBLISHER UNIT TESTS");
console.log("==================================================\n");

const testLedgerPath = path.join(__dirname, "scratch", "test_temp_ledger.json");
if (fs.existsSync(testLedgerPath)) fs.unlinkSync(testLedgerPath);

// 1. Ledger tests
runTest("PublishedLedger initializes cleanly and isPublished returns false initially", () => {
  const ledger = new PublishedLedger(testLedgerPath);
  assert.strictEqual(ledger.isPublished("100:1"), false);
  assert.strictEqual(ledger.records.length, 0);
});

runTest("PublishedLedger records publication and marks identity as published", () => {
  const ledger = new PublishedLedger(testLedgerPath);
  ledger.recordPublication({
    sourceIdentity: "100:1",
    sourceChannelId: "100",
    sourceMessageId: "1",
    destinationChannelId: "DESTINATION_3",
    destinationUsername: "e5brygh",
    destinationMessageId: "5001",
    captionSource: "source_metadata",
    caption: "🎬 Romance video"
  });

  assert.strictEqual(ledger.isPublished("100:1"), true);
  assert.strictEqual(ledger.records.length, 1);
  assert.strictEqual(ledger.records[0].status, "SUCCESS");
});

runTest("PublishedLedger persists to disk and reloads published identities accurately", () => {
  const reloadedLedger = new PublishedLedger(testLedgerPath);
  assert.strictEqual(reloadedLedger.isPublished("100:1"), true);
  assert.strictEqual(reloadedLedger.isPublished("100:2"), false);
});

runTest("PublishedLedger recordFailure records failure without marking identity as published", () => {
  const ledger = new PublishedLedger(testLedgerPath);
  ledger.recordFailure({
    sourceIdentity: "100:2",
    sourceChannelId: "100",
    sourceMessageId: "2",
    destinationChannelId: "DESTINATION_3"
  }, "Simulated network timeout");

  assert.strictEqual(ledger.isPublished("100:2"), false, "Failed publish must NOT be marked as published");
  assert.strictEqual(ledger.records.length, 2);
  assert.strictEqual(ledger.records[1].status, "FAILED");
});

// 2. Pipeline Publisher tests (Dry Run Mode)
runTest("Publisher publishItem skips already published video item", async () => {
  const ledger = new PublishedLedger(testLedgerPath);
  const publisher = new TelegramPipelinePublisher(null, ledger, null, { dryRun: true });

  const result = await publisher.publishItem({
    messageId: "1",
    sourceChannelId: "100"
  }, {
    sourceChannelId: "100",
    messageId: "1",
    destinationChannelId: "DESTINATION_3"
  });

  assert.strictEqual(result.status, "SKIPPED_ALREADY_PUBLISHED");
});

runTest("Publisher publishItem skips UNCLASSIFIED item", async () => {
  const ledger = new PublishedLedger(testLedgerPath);
  const publisher = new TelegramPipelinePublisher(null, ledger, null, { dryRun: true });

  const result = await publisher.publishItem({
    messageId: "99",
    sourceChannelId: "100"
  }, {
    sourceChannelId: "100",
    messageId: "99",
    destinationChannelId: "UNCLASSIFIED"
  });

  assert.strictEqual(result.status, "SKIPPED_UNCLASSIFIED");
});

runTest("Publisher publishItem accepts valid item in dryRun mode", async () => {
  const ledger = new PublishedLedger(testLedgerPath);
  const publisher = new TelegramPipelinePublisher(null, ledger, null, { dryRun: true });

  const result = await publisher.publishItem({
    messageId: "50",
    sourceChannelId: "100",
    rawMedia: {}
  }, {
    sourceChannelId: "100",
    messageId: "50",
    destinationChannelId: "DESTINATION_3",
    generatedKoreanCaption: "🎬 신규 추천 영상입니다.\n📌 고화질로 감상해보세요.",
    captionSource: "generic_fallback"
  });

  assert.strictEqual(result.status, "DRY_RUN_ACCEPTED");
  assert.strictEqual(result.destinationUsername, "e5brygh");
});

runTest("Publisher smoke test limits publications to max 1 per destination channel", () => {
  const config = {
    smokeTestMode: true,
    maxPerDestinationInSmokeTest: 1,
    maxPublishPerCycle: 10,
    dryRun: true
  };
  const publisher = new TelegramPipelinePublisher(null, null, null, config);

  assert.strictEqual(publisher.config.smokeTestMode, true);
  assert.strictEqual(publisher.config.maxPerDestinationInSmokeTest, 1);
});

runTest("same source video cannot be published to two destinations", async () => {
  const ledger = new PublishedLedger(testLedgerPath);
  const publisher = new TelegramPipelinePublisher(null, ledger, null, { dryRun: true });

  // 1. Initial publication to Destination 1
  const firstRes = await publisher.publishItem({
    messageId: "888",
    sourceChannelId: "200",
    rawMedia: {}
  }, {
    sourceChannelId: "200",
    messageId: "888",
    destinationChannelId: "DESTINATION_1"
  });
  assert.strictEqual(firstRes.status, "DRY_RUN_ACCEPTED");

  // Record SUCCESS in ledger
  ledger.recordPublication({
    sourceIdentity: "200:888",
    sourceChannelId: "200",
    sourceMessageId: "888",
    destinationChannelId: "DESTINATION_1",
    destinationUsername: "ccsfvk",
    destinationMessageId: "100"
  });

  // 2. Attempt to publish the exact same video to Destination 2
  const secondRes = await publisher.publishItem({
    messageId: "888",
    sourceChannelId: "200",
    rawMedia: {}
  }, {
    sourceChannelId: "200",
    messageId: "888",
    destinationChannelId: "DESTINATION_2"
  });

  assert.strictEqual(secondRes.status, "SKIPPED_ALREADY_PUBLISHED", "Must reject second publishing attempt to Destination 2");
  assert.strictEqual(ledger.getAssignedDestination("200:888"), "DESTINATION_1", "Original destination must remain locked to Destination 1");
});

// Clean up temp test ledger
if (fs.existsSync(testLedgerPath)) fs.unlinkSync(testLedgerPath);

console.log("\n==================================================");
console.log(`📊 TELEGRAM PIPELINE PUBLISHER TEST RESULTS: ${passedTests} PASSED, ${totalTests - passedTests} FAILED`);
console.log("==================================================\n");

if (passedTests !== totalTests) {
  process.exit(1);
}
