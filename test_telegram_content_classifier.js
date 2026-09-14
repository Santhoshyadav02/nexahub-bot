/**
 * test_telegram_content_classifier.js
 *
 * Unit Test Suite for Stage 3 Telegram Content Classifier & 7->10 Router
 *
 * Verifies:
 * 1. Exact category match
 * 2. Keyword match (multi-word, single-word)
 * 3. Case normalization (uppercase, lowercase, mixed)
 * 4. Punctuation & symbol normalization
 * 5. Multiple matching categories (confidence priority)
 * 6. Deterministic priority resolution
 * 7. No-match handling (UNCLASSIFIED)
 * 8. LOW confidence handling (marked for manual review)
 * 9. Duplicate message detection
 * 10. Grouped album classification inheritance
 * 11. Unknown source handling
 * 12. Disabled destination handling
 * 13. Invalid destination handling
 * 14. Batch classification summary correctness
 */

const assert = require("assert");
const {
  TelegramContentClassifier,
  normalizeText,
  extractTokens,
  loadRoutingConfig
} = require("./telegram_content_classifier");

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
console.log("🧪 RUNNING TELEGRAM CONTENT CLASSIFIER UNIT TESTS");
console.log("==================================================\n");

// 1. Normalization tests
runTest("normalizeText: converts uppercase to lowercase and strips punctuation", () => {
  const norm = normalizeText("【Heartwarming Family Reunion】 (HD 1080p) - Watch Now!");
  assert.strictEqual(norm, "heartwarming family reunion hd 1080p watch now");
});

runTest("normalizeText: preserves Korean, Chinese, and Japanese characters", () => {
  const norm = normalizeText("【한국 드라마】 가족 이야기 청춘 / 비밀 커플 / 일본 드라마");
  assert.strictEqual(norm, "한국 드라마 가족 이야기 청춘 비밀 커플 일본 드라마");
});

runTest("normalizeText: strips URLs and excess whitespace", () => {
  const norm = normalizeText("Click here: https://t.me/example/123    for more videos  \n\n  new post");
  assert.strictEqual(norm, "click here for more videos new post");
});

// 2. Classification tests
runTest("Exact category match: matches 'Korean Drama' with HIGH confidence", () => {
  const classifier = new TelegramContentClassifier();
  const item = {
    sourceChannelId: "1762071168",
    messageId: "101",
    title: "Korean Drama Special Episode",
    caption: "Full HD clip featuring korean drama"
  };
  const decision = classifier.classify(item);

  assert.strictEqual(decision.confidence, "HIGH");
  assert.strictEqual(decision.destinationChannelId, "DESTINATION_1");
  assert.strictEqual(decision.matchedCategory, "Korean Drama");
  assert.ok(decision.matchedKeywords.includes("korean drama"));
});

runTest("Keyword match: matches 'love story' -> Romance Drama (DESTINATION_2) with HIGH confidence", () => {
  const classifier = new TelegramContentClassifier();
  const item = {
    sourceChannelId: "1871127271",
    messageId: "102",
    caption: "A Touching Love Story WATCH FULL VIDEOS"
  };
  const decision = classifier.classify(item);

  assert.strictEqual(decision.confidence, "HIGH");
  assert.strictEqual(decision.destinationChannelId, "DESTINATION_2");
  assert.strictEqual(decision.matchedCategory, "Romance Drama");
  assert.ok(decision.matchedKeywords.includes("love story"));
});

runTest("Case normalization: matches mixed-case 'aCtIoN dRaMa' -> Action Drama (DESTINATION_4)", () => {
  const classifier = new TelegramContentClassifier();
  const item = {
    sourceChannelId: "1871127271",
    messageId: "103",
    caption: "HIGH-OCTANE aCtIoN dRaMa [FULL HD]"
  };
  const decision = classifier.classify(item);

  assert.strictEqual(decision.confidence, "HIGH");
  assert.strictEqual(decision.destinationChannelId, "DESTINATION_4");
  assert.strictEqual(decision.matchedCategory, "Action Drama");
});

runTest("Punctuation normalization: matches punctuated keyword 'Rom-Com' -> Comedy Drama", () => {
  const classifier = new TelegramContentClassifier();
  const item = {
    sourceChannelId: "2604815578",
    messageId: "104",
    caption: "【New Release】 (Original) Rom-Com Comedy Special - Watch Now"
  };
  const decision = classifier.classify(item);

  assert.strictEqual(decision.confidence, "HIGH");
  assert.strictEqual(decision.destinationChannelId, "DESTINATION_3");
  assert.ok(decision.matchedKeywords.length > 0);
});

runTest("Multiple matching categories: prefers HIGH confidence over MEDIUM confidence", () => {
  const classifier = new TelegramContentClassifier();
  const item = {
    sourceChannelId: "1871127271",
    messageId: "105",
    caption: "Family Drama Reunion - Historical Edition" // "family drama" is HIGH for DESTINATION_9, "historical" is MEDIUM for DESTINATION_6
  };
  const decision = classifier.classify(item);

  assert.strictEqual(decision.confidence, "HIGH");
  assert.strictEqual(decision.destinationChannelId, "DESTINATION_9");
  assert.strictEqual(decision.matchedCategory, "Family Drama");
});

runTest("Deterministic priority: resolves tied confidence scores deterministically by priority", () => {
  const config = {
    destinations: {
      "DEST_A": { id: "DEST_A", name: "Cat A", enabled: true, priority: 1, keywords: { high: ["shared keyword"] } },
      "DEST_B": { id: "DEST_B", name: "Cat B", enabled: true, priority: 2, keywords: { high: ["shared keyword"] } }
    }
  };
  const classifier = new TelegramContentClassifier(config);
  const item = { sourceChannelId: "1", messageId: "106", caption: "contains shared keyword" };
  const decision = classifier.classify(item);

  assert.strictEqual(decision.destinationChannelId, "DEST_A");
  assert.strictEqual(decision.matchedCategory, "Cat A");
});

runTest("No-match handling: returns UNCLASSIFIED without random assignment", () => {
  const classifier = new TelegramContentClassifier();
  const item = {
    sourceChannelId: "1",
    messageId: "107",
    caption: "Completely unrelated random video sequence xyz 12345"
  };
  const decision = classifier.classify(item);

  assert.strictEqual(decision.confidence, "UNCLASSIFIED");
  assert.strictEqual(decision.matchedCategory, "UNCLASSIFIED");
  assert.strictEqual(decision.destinationChannelId, null);
  assert.strictEqual(decision.status, "UNCLASSIFIED");
});

runTest("LOW confidence handling: matches weak keyword and flags as LOW", () => {
  const config = {
    destinations: {
      "DESTINATION_1": {
        id: "DESTINATION_1",
        name: "Korean Drama",
        enabled: true,
        priority: 1,
        keywords: { high: [], medium: [], low: ["episode"] }
      }
    }
  };
  const classifier = new TelegramContentClassifier(config);
  const item = { sourceChannelId: "1", messageId: "108", caption: "new episode today" };
  const decision = classifier.classify(item);

  assert.strictEqual(decision.confidence, "LOW");
  assert.strictEqual(decision.destinationChannelId, "DESTINATION_1");
});

runTest("Duplicate message handling: marks duplicate: true on repeated evaluation", () => {
  const seen = new Set();
  const classifier = new TelegramContentClassifier(null, seen);
  const item = { sourceChannelId: "1762071168", messageId: "200", caption: "Korean Drama" };

  const dec1 = classifier.classify(item);
  assert.strictEqual(dec1.confidence, "HIGH");
  assert.strictEqual(dec1.duplicate, false);

  const dec2 = classifier.classify(item);
  assert.strictEqual(dec2.status, "SKIPPED_DUPLICATE");
  assert.strictEqual(dec2.duplicate, true);
});

runTest("Grouped albums: inherits classification across album items", () => {
  const classifier = new TelegramContentClassifier();
  const albumId = "777888999111";

  // Item 1 has caption with strong keyword
  const item1 = {
    sourceChannelId: "1518888395",
    messageId: "501",
    groupedId: albumId,
    caption: "Her new Slice of Life everyday story is out on the channel"
  };
  const dec1 = classifier.classify(item1);
  assert.strictEqual(dec1.confidence, "HIGH");
  assert.strictEqual(dec1.destinationChannelId, "DESTINATION_8");

  // Item 2 has NO caption, but belongs to same album
  const item2 = {
    sourceChannelId: "1518888395",
    messageId: "502",
    groupedId: albumId,
    caption: ""
  };
  const dec2 = classifier.classify(item2);
  assert.strictEqual(dec2.status, "CLASSIFIED_ALBUM_MEMBER");
  assert.strictEqual(dec2.destinationChannelId, "DESTINATION_8");
  assert.strictEqual(dec2.matchedCategory, "Slice of Life");
});

runTest("Unknown source handling: handles unconfigured sourceChannelId cleanly", () => {
  const classifier = new TelegramContentClassifier();
  const item = {
    sourceChannelId: "9999999999",
    messageId: "301",
    caption: "Romance drama love story premiere"
  };
  const decision = classifier.classify(item);

  assert.strictEqual(decision.confidence, "HIGH");
  assert.strictEqual(decision.destinationChannelId, "DESTINATION_2");
});

runTest("Disabled destination handling: flags IGNORED_DISABLED_DESTINATION", () => {
  const config = {
    destinations: {
      "DESTINATION_2": {
        id: "DESTINATION_2",
        name: "Romance Drama",
        enabled: false,
        priority: 2,
        keywords: { high: ["romance drama"] }
      }
    }
  };
  const classifier = new TelegramContentClassifier(config);
  const item = { sourceChannelId: "1", messageId: "401", caption: "romance drama tonight" };
  const decision = classifier.classify(item);

  assert.strictEqual(decision.status, "IGNORED_DISABLED_DESTINATION");
  assert.strictEqual(decision.destinationChannelId, "DESTINATION_2");
});

runTest("Invalid destination handling: catches corrupt destination config gracefully", () => {
  const config = {
    destinations: {
      "CORRUPT_DEST": { priority: 1, keywords: { high: ["broken"] } } // missing id and name
    }
  };
  const classifier = new TelegramContentClassifier(config);
  const item = { sourceChannelId: "1", messageId: "402", caption: "broken config test" };
  const decision = classifier.classify(item);

  assert.strictEqual(decision.status, "ERROR_INVALID_DESTINATION");
  assert.strictEqual(decision.confidence, "UNCLASSIFIED");
});

runTest("Batch processing: aggregates distribution, top keywords, and breakdown accurately", () => {
  const classifier = new TelegramContentClassifier();
  const items = [
    { sourceChannelId: "1", messageId: "1", caption: "Korean Drama" },
    { sourceChannelId: "2", messageId: "2", caption: "Romance drama love story" },
    { sourceChannelId: "3", messageId: "3", caption: "Comedy drama rom-com special" },
    { sourceChannelId: "4", messageId: "4", caption: "Unmatched random string 999" }
  ];

  const summary = classifier.classifyBatch(items);

  assert.strictEqual(summary.totalVideos, 4);
  assert.strictEqual(summary.high, 3);
  assert.strictEqual(summary.unclassified, 1);
  assert.strictEqual(summary.destinationDistribution["DESTINATION_1"], 1);
  assert.strictEqual(summary.destinationDistribution["DESTINATION_2"], 1);
  assert.strictEqual(summary.destinationDistribution["DESTINATION_3"], 1);
  assert.strictEqual(summary.destinationDistribution["DESTINATION_4"], 0);
});

console.log("\n==================================================");
console.log(`📊 TELEGRAM CONTENT CLASSIFIER TEST RESULTS: ${passedTests} PASSED, ${totalTests - passedTests} FAILED`);
console.log("==================================================\n");

if (passedTests !== totalTests) {
  process.exit(1);
}
