/**
 * test_telegram_source_router.js
 * 
 * Comprehensive Unit Test Suite for Stage 2 Telegram Source Router
 * 
 * Verifies:
 * 1. Source -> Destination mapping
 * 2. Duplicate message detection
 * 3. Grouped album detection (groupedId)
 * 4. Video filtering (identifying video messages from metadata)
 * 5. Non-video filtering (skipping photos, text, web pages)
 * 6. Missing caption handling (graceful handling of blank text)
 * 7. Unknown source handling (unconfigured source channel)
 * 8. Disabled source handling (enabled: false in config)
 * 9. Invalid destination handling (empty or missing destinationChannelId)
 * 10. Deterministic routing consistency
 * 11. Batch evaluation metrics
 */

const assert = require("assert");
const {
  DEFAULT_ROUTING_CONFIG,
  TelegramSourceRouter,
  generateSourceIdentity,
  extractMediaMetadata
} = require("./telegram_source_router");

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
console.log("🧪 RUNNING TELEGRAM SOURCE ROUTER UNIT TESTS");
console.log("==================================================\n");

// 1. generateSourceIdentity tests
runTest("generateSourceIdentity generates exact 'channelId:messageId' format", () => {
  const identity = generateSourceIdentity("1762071168", "12345");
  assert.strictEqual(identity, "1762071168:12345");
});

runTest("generateSourceIdentity converts numbers to strings safely", () => {
  const identity = generateSourceIdentity(1871127271, 999);
  assert.strictEqual(identity, "1871127271:999");
});

runTest("generateSourceIdentity throws if arguments are missing", () => {
  assert.throws(() => generateSourceIdentity(null, 123), /requires both/);
  assert.throws(() => generateSourceIdentity("123", null), /requires both/);
});

// 2. extractMediaMetadata tests
runTest("extractMediaMetadata identifies native video object", () => {
  const meta = extractMediaMetadata({
    id: 101,
    video: { duration: 120, mimeType: "video/mp4" },
    message: "Great movie preview",
    date: 1693000000
  });
  assert.strictEqual(meta.isVideo, true);
  assert.strictEqual(meta.mediaType, "video");
  assert.strictEqual(meta.hasCaption, true);
  assert.strictEqual(meta.captionPreview, "Great movie preview");
  assert.strictEqual(meta.groupedId, null);
  assert.strictEqual(typeof meta.date, "string");
});

runTest("extractMediaMetadata identifies video document", () => {
  const meta = extractMediaMetadata({
    id: 102,
    document: { mimeType: "video/quicktime", size: 50000000 },
    message: "Apple video"
  });
  assert.strictEqual(meta.isVideo, true);
  assert.strictEqual(meta.mediaType, "video");
});

runTest("extractMediaMetadata identifies photo correctly as non-video", () => {
  const meta = extractMediaMetadata({
    id: 103,
    photo: { id: "p1" },
    message: "Poster photo"
  });
  assert.strictEqual(meta.isVideo, false);
  assert.strictEqual(meta.mediaType, "photo");
});

runTest("extractMediaMetadata handles text-only messages", () => {
  const meta = extractMediaMetadata({
    id: 104,
    message: "Just a text announcement"
  });
  assert.strictEqual(meta.isVideo, false);
  assert.strictEqual(meta.mediaType, "text");
});

runTest("extractMediaMetadata handles missing / empty captions cleanly", () => {
  const meta = extractMediaMetadata({
    id: 105,
    video: { duration: 60 },
    message: ""
  });
  assert.strictEqual(meta.isVideo, true);
  assert.strictEqual(meta.hasCaption, false);
  assert.strictEqual(meta.captionPreview, "");
});

runTest("extractMediaMetadata captures groupedId correctly", () => {
  const meta = extractMediaMetadata({
    id: 106,
    video: { duration: 60 },
    groupedId: "9876543210123"
  });
  assert.strictEqual(meta.groupedId, "9876543210123");
});

// 3. Routing & Evaluation tests
runTest("Source -> Destination mapping: evaluates valid video message to configured destination", () => {
  const router = new TelegramSourceRouter(DEFAULT_ROUTING_CONFIG);
  const rawMsg = {
    id: 318,
    video: { duration: 500 },
    message: "Sample Movie Title",
    date: 1692769112
  };
  const result = router.evaluateMessage("1762071168", "korea18movie", rawMsg);

  assert.strictEqual(result.status, "ROUTED_DRY_RUN");
  assert.strictEqual(result.action, "DRY_RUN_ONLY");
  assert.strictEqual(result.destination, "DESTINATION_1");
  assert.strictEqual(result.record.sourceChannelId, "1762071168");
  assert.strictEqual(result.record.sourceUsername, "korea18movie");
  assert.strictEqual(result.record.messageId, "318");
  assert.strictEqual(result.record.destinationChannelId, "DESTINATION_1");
  assert.strictEqual(result.record.mediaType, "video");
  assert.strictEqual(result.record.hasCaption, true);
  assert.strictEqual(result.record.duplicate, false);
});

runTest("Duplicate message detection: second evaluation of identical identity marks duplicate", () => {
  const seen = new Set();
  const router = new TelegramSourceRouter(DEFAULT_ROUTING_CONFIG, seen);
  const rawMsg = {
    id: 318,
    video: { duration: 500 },
    message: "Sample Movie Title"
  };

  const eval1 = router.evaluateMessage("1762071168", "korea18movie", rawMsg);
  assert.strictEqual(eval1.status, "ROUTED_DRY_RUN");
  assert.strictEqual(eval1.record.duplicate, false);

  const eval2 = router.evaluateMessage("1762071168", "korea18movie", rawMsg);
  assert.strictEqual(eval2.status, "SKIPPED_DUPLICATE");
  assert.strictEqual(eval2.action, "SKIP");
  assert.strictEqual(eval2.record.duplicate, true);
});

runTest("Non-video filtering: skips photo message from routing", () => {
  const router = new TelegramSourceRouter(DEFAULT_ROUTING_CONFIG);
  const rawMsg = {
    id: 319,
    photo: { id: "abc" },
    message: "Cover photo"
  };
  const result = router.evaluateMessage("1762071168", "korea18movie", rawMsg);

  assert.strictEqual(result.status, "SKIPPED_NON_VIDEO");
  assert.strictEqual(result.action, "SKIP");
  assert.strictEqual(result.mediaType, "photo");
  assert.strictEqual(result.record, null);
});

runTest("Non-video filtering: skips text message from routing", () => {
  const router = new TelegramSourceRouter(DEFAULT_ROUTING_CONFIG);
  const rawMsg = {
    id: 320,
    message: "Announcement text"
  };
  const result = router.evaluateMessage("1762071168", "korea18movie", rawMsg);

  assert.strictEqual(result.status, "SKIPPED_NON_VIDEO");
  assert.strictEqual(result.mediaType, "text");
});

runTest("Unknown source handling: ignores channel not present in configuration", () => {
  const router = new TelegramSourceRouter(DEFAULT_ROUTING_CONFIG);
  const rawMsg = {
    id: 500,
    video: { duration: 100 }
  };
  const result = router.evaluateMessage("9999999999", "unregistered_channel", rawMsg);

  assert.strictEqual(result.status, "IGNORED_UNKNOWN_SOURCE");
  assert.strictEqual(result.action, "SKIP");
  assert.strictEqual(result.record, null);
});

runTest("Disabled source handling: skips channel when enabled is false in configuration", () => {
  const customConfig = {
    sources: {
      "1762071168": {
        destinationChannelId: "DESTINATION_1",
        enabled: false,
        username: "korea18movie"
      }
    }
  };
  const router = new TelegramSourceRouter(customConfig);
  const rawMsg = {
    id: 318,
    video: { duration: 100 }
  };
  const result = router.evaluateMessage("1762071168", "korea18movie", rawMsg);

  assert.strictEqual(result.status, "IGNORED_DISABLED_SOURCE");
  assert.strictEqual(result.action, "SKIP");
  assert.strictEqual(result.record, null);
});

runTest("Invalid destination handling: flags error when destinationChannelId is missing or empty", () => {
  const invalidConfig = {
    sources: {
      "1762071168": {
        destinationChannelId: "",
        enabled: true,
        username: "korea18movie"
      }
    }
  };
  const router = new TelegramSourceRouter(invalidConfig);
  const rawMsg = {
    id: 318,
    video: { duration: 100 }
  };
  const result = router.evaluateMessage("1762071168", "korea18movie", rawMsg);

  assert.strictEqual(result.status, "ERROR_INVALID_DESTINATION");
  assert.strictEqual(result.action, "ERROR");
});

runTest("Deterministic routing: routing decisions are 100% deterministic across multiple runs", () => {
  const router1 = new TelegramSourceRouter(DEFAULT_ROUTING_CONFIG, new Set());
  const router2 = new TelegramSourceRouter(DEFAULT_ROUTING_CONFIG, new Set());

  const sampleMessages = [
    { id: 100, video: { duration: 60 }, message: "Movie 1" },
    { id: 101, photo: { id: "p" }, message: "Photo 1" },
    { id: 102, video: { duration: 120 }, message: "Movie 2" }
  ];

  const batch1 = router1.processBatch("1871127271", "Korea_Japanese_Adult", sampleMessages);
  const batch2 = router2.processBatch("1871127271", "Korea_Japanese_Adult", sampleMessages);

  assert.strictEqual(batch1.videoMessages, batch2.videoMessages);
  assert.strictEqual(batch1.nonVideoMessages, batch2.nonVideoMessages);
  assert.strictEqual(batch1.routedRecords.length, batch2.routedRecords.length);
  assert.strictEqual(batch1.routedRecords[0].destinationChannelId, "DESTINATION_2");
  assert.strictEqual(batch2.routedRecords[0].destinationChannelId, "DESTINATION_2");
  assert.deepStrictEqual(batch1.routedRecords, batch2.routedRecords);
});

runTest("Batch processing: accurately aggregates grouped albums and duplicate counts", () => {
  const router = new TelegramSourceRouter(DEFAULT_ROUTING_CONFIG);
  const albumId = "555123456789";

  const batchMessages = [
    { id: 1, video: { duration: 60 }, groupedId: albumId, message: "Part 1" },
    { id: 2, photo: { id: "p1" }, groupedId: albumId },
    { id: 3, video: { duration: 90 }, groupedId: albumId, message: "Part 2" },
    { id: 1, video: { duration: 60 }, groupedId: albumId, message: "Part 1 Duplicate" }, // Duplicate id
    { id: 4, message: "Text only" }
  ];

  const result = router.processBatch("1518888395", "koreannarchive", batchMessages);

  assert.strictEqual(result.totalMessages, 5);
  assert.strictEqual(result.videoMessages, 2); // IDs 1 and 3
  assert.strictEqual(result.nonVideoMessages, 2); // IDs 2 (photo) and 4 (text)
  assert.strictEqual(result.duplicates, 1); // ID 1 second time
  assert.strictEqual(result.groupedAlbumsCount, 1);
  assert.strictEqual(result.groupedMessageCount, 4);
  assert.strictEqual(result.routedRecords[0].destinationChannelId, "DESTINATION_3");
});

runTest("Destination placeholders check: all configured sources have valid routing entries", () => {
  const { SOURCE_CHANNELS_LIST } = require("./telegram_source_router");
  const router = new TelegramSourceRouter(DEFAULT_ROUTING_CONFIG);

  assert.strictEqual(SOURCE_CHANNELS_LIST.length, 14, "Configured sources must equal exactly 14 (8 existing + 6 new authorized)");

  const seenIds = new Set();
  const seenUsernames = new Set();

  SOURCE_CHANNELS_LIST.forEach((src) => {
    assert.ok(!seenIds.has(src.id), `Duplicate channel ID detected: ${src.id}`);
    assert.ok(!seenUsernames.has(src.username.toLowerCase()), `Duplicate username detected: ${src.username}`);
    seenIds.add(src.id);
    seenUsernames.add(src.username.toLowerCase());

    const rawMsg = { id: 1000 + src.num, video: { duration: 60 } };
    const evalRes = router.evaluateMessage(src.id, src.username, rawMsg);
    if (evalRes.status === "ROUTED_DRY_RUN") {
      assert.ok(evalRes.destination, `Destination must exist for ${src.username}`);
    } else {
      assert.strictEqual(evalRes.status, "IGNORED_DISABLED_SOURCE", `Disabled source ${src.username} must return IGNORED_DISABLED_SOURCE`);
    }
  });
});

console.log("\n==================================================");
console.log(`📊 TELEGRAM SOURCE ROUTER TEST RESULTS: ${passedTests} PASSED, ${totalTests - passedTests} FAILED`);
console.log("==================================================\n");

if (passedTests !== totalTests) {
  process.exit(1);
}
