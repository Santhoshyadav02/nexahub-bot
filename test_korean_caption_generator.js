/**
 * test_korean_caption_generator.js
 * 
 * Unit Test Suite for Stage 4 Korean Caption Generator & Routing Pipeline
 */

const assert = require("assert");
const {
  KoreanCaptionPipeline,
  generateKoreanCaption,
  cleanRawCaption,
  formatKoreanCaptionFromMetadata,
  GENERIC_KOREAN_FALLBACKS
} = require("./korean_caption_generator");

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
console.log("🧪 RUNNING KOREAN CAPTION GENERATOR UNIT TESTS");
console.log("==================================================\n");

// 1. Korean text & line limit tests
runTest("All generated captions contain Korean characters", () => {
  const result1 = generateKoreanCaption({ messageId: "1", caption: "Delicious Sister Rice Bowl" });
  const result2 = generateKoreanCaption({ messageId: "2", caption: "" });

  const koreanRegex = /[\uAC00-\uD7AF]/;
  assert.ok(koreanRegex.test(result1.generatedKoreanCaption), "Should contain Korean");
  assert.ok(koreanRegex.test(result2.generatedKoreanCaption), "Fallback should contain Korean");
});

runTest("Generated captions are maximum 1-2 lines (at most 1 newline)", () => {
  const result1 = generateKoreanCaption({ messageId: "1", caption: "Between Her Legs Drunk" });
  const lines1 = result1.generatedKoreanCaption.split("\n");
  assert.ok(lines1.length <= 2, `Expected <= 2 lines, got ${lines1.length}`);

  const result2 = generateKoreanCaption({ messageId: "2", caption: "" });
  const lines2 = result2.generatedKoreanCaption.split("\n");
  assert.ok(lines2.length <= 2, `Expected <= 2 lines, got ${lines2.length}`);
});

// 2. Metadata cleaning & source_metadata vs generic_fallback
runTest("cleanRawCaption: strips external URLs and VIP promotion boilerplate", () => {
  const raw = "Delicious Sister Rice Bowl WATCH FULL VIDEOS: HD » https://terabox.com/s/12345 To join VIP channel";
  const cleaned = cleanRawCaption(raw);
  assert.strictEqual(cleaned, "Delicious Sister Rice Bowl");
});

runTest("generateKoreanCaption: sets captionSource to 'source_metadata' when metadata exists", () => {
  const result = generateKoreanCaption({
    messageId: "101",
    caption: "Daughter-in-law's First Love WATCH FULL VIDEOS: 1080p » http://link.com"
  }, { matchedCategory: "Romance" });

  assert.strictEqual(result.captionSource, "source_metadata");
  assert.ok(result.generatedKoreanCaption.includes("Daughter-in-law's First Love"));
  assert.ok(result.generatedKoreanCaption.includes("[Romance]"));
});

runTest("generateKoreanCaption: sets captionSource to 'generic_fallback' when metadata is blank", () => {
  const result = generateKoreanCaption({
    messageId: "102",
    caption: ""
  });

  assert.strictEqual(result.captionSource, "generic_fallback");
  assert.ok(GENERIC_KOREAN_FALLBACKS.includes(result.generatedKoreanCaption));
  assert.ok(!result.generatedKoreanCaption.includes("undefined"));
});

// 3. Special Case: @xuexiziliao2
runTest("Special Case: @xuexiziliao2 blank caption generates safe Korean fallback preserving messageId", () => {
  const pipeline = new KoreanCaptionPipeline();
  const item = {
    sourceChannelId: "1521978999",
    sourceUsername: "xuexiziliao2",
    messageId: "906415",
    caption: ""
  };
  const record = pipeline.processVideo(item);

  assert.strictEqual(record.sourceUsername, "xuexiziliao2");
  assert.strictEqual(record.messageId, "906415");
  assert.strictEqual(record.captionSource, "generic_fallback");
  assert.ok(/[\uAC00-\uD7AF]/.test(record.generatedKoreanCaption));
  assert.strictEqual(record.confidence, "UNCLASSIFIED");
});

// 4. Grouped albums & deduplication
runTest("Grouped albums: processes child items and handles deduplication", () => {
  const pipeline = new KoreanCaptionPipeline();
  const albumId = "888999111";

  const item1 = {
    sourceChannelId: "1518888395",
    sourceUsername: "koreannarchive",
    messageId: "5247",
    groupedId: albumId,
    caption: "Her premium Fantrie Nude content is on the Korean VIP channel"
  };

  const item2 = {
    sourceChannelId: "1518888395",
    sourceUsername: "koreannarchive",
    messageId: "5248",
    groupedId: albumId,
    caption: ""
  };

  const record1 = pipeline.processVideo(item1);
  const record2 = pipeline.processVideo(item2);

  assert.strictEqual(record1.captionSource, "source_metadata");
  assert.strictEqual(record1.destinationChannelId, "DESTINATION_8");

  assert.strictEqual(record2.groupedId, albumId);
  assert.strictEqual(record2.destinationChannelId, "DESTINATION_8");
});

// 5. Batch processing metrics
runTest("Batch processing: accurately counts caption sources and distribution", () => {
  const pipeline = new KoreanCaptionPipeline();
  const batch = [
    { sourceChannelId: "1", sourceUsername: "korea18movie", messageId: "1", caption: "Intimacy 2001" },
    { sourceChannelId: "2", sourceUsername: "xuexiziliao2", messageId: "2", caption: "" },
    { sourceChannelId: "3", sourceUsername: "madougirl", messageId: "3", caption: "91porn 人妻店长" }
  ];

  const summary = pipeline.processBatch(batch);

  assert.strictEqual(summary.totalVideos, 3);
  assert.strictEqual(summary.captionFromSource, 2);
  assert.strictEqual(summary.genericFallback, 1);
  assert.strictEqual(summary.koreanGenerated, 3);
});

console.log("\n==================================================");
console.log(`📊 KOREAN CAPTION GENERATOR TEST RESULTS: ${passedTests} PASSED, ${totalTests - passedTests} FAILED`);
console.log("==================================================\n");

if (passedTests !== totalTests) {
  process.exit(1);
}
