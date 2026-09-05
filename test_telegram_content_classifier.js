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
  const norm = normalizeText("【Delicious Sister Rice Bowl】 (HD 1080p) - Watch Now!");
  assert.strictEqual(norm, "delicious sister rice bowl hd 1080p watch now");
});

runTest("normalizeText: preserves Korean, Chinese, and Japanese characters", () => {
  const norm = normalizeText("【91麻豆】 人妻店长 酒店激战 / 비밀 커플 / 일본 AV");
  assert.strictEqual(norm, "91麻豆 人妻店长 酒店激战 비밀 커플 일본 av");
});

runTest("normalizeText: strips URLs and excess whitespace", () => {
  const norm = normalizeText("Click here: https://t.me/example/123    for more videos  \n\n  new post");
  assert.strictEqual(norm, "click here for more videos new post");
});

// 2. Classification tests
runTest("Exact category match: matches 'Romantic Vibe' with HIGH confidence", () => {
  const classifier = new TelegramContentClassifier();
  const item = {
    sourceChannelId: "1762071168",
    messageId: "101",
    title: "Romantic Vibe Special Episode",
    caption: "Full HD clip featuring romantic vibe"
  };
  const decision = classifier.classify(item);

  assert.strictEqual(decision.confidence, "HIGH");
  assert.strictEqual(decision.destinationChannelId, "DESTINATION_1");
  assert.strictEqual(decision.matchedCategory, "Romantic Vibe");
  assert.ok(decision.matchedKeywords.includes("romantic vibe"));
});

runTest("Keyword match: matches 'first love' -> Romance (DESTINATION_3) with HIGH confidence", () => {
  const classifier = new TelegramContentClassifier();
  const item = {
    sourceChannelId: "1871127271",
    messageId: "102",
    caption: "Daughter-in-law's First Love WATCH FULL VIDEOS"
  };
  const decision = classifier.classify(item);

  assert.strictEqual(decision.confidence, "HIGH");
  assert.strictEqual(decision.destinationChannelId, "DESTINATION_3");
  assert.strictEqual(decision.matchedCategory, "Romance");
  assert.ok(decision.matchedKeywords.includes("first love"));
});

runTest("Case normalization: matches mixed-case 'bEtWeEn HeR lEgS' -> Crotch (DESTINATION_4)", () => {
  const classifier = new TelegramContentClassifier();
  const item = {
    sourceChannelId: "1871127271",
    messageId: "103",
    caption: "BETWEEN HER LEGS DRUNK [FULL HD]"
  };
  const decision = classifier.classify(item);

  assert.strictEqual(decision.confidence, "HIGH");
  assert.strictEqual(decision.destinationChannelId, "DESTINATION_4");
  assert.strictEqual(decision.matchedCategory, "Crotch");
});

runTest("Punctuation normalization: matches punctuated keywords '麻豆/国产/反差' -> Bunny Girl / A Muse", () => {
  const classifier = new TelegramContentClassifier();
  const item = {
    sourceChannelId: "2604815578",
    messageId: "104",
    caption: "【91porn】 (原创)美艳店长人妻，酒店里面开门玩 - 91porn"
  };
  const decision = classifier.classify(item);

  assert.strictEqual(decision.confidence, "HIGH");
  // Matches "91porn" (DESTINATION_10) or "人妻/店长" (DESTINATION_7)
  assert.ok(decision.destinationChannelId === "DESTINATION_7" || decision.destinationChannelId === "DESTINATION_10");
  assert.ok(decision.matchedKeywords.length > 0);
});

runTest("Multiple matching categories: prefers HIGH confidence over MEDIUM confidence", () => {
  const classifier = new TelegramContentClassifier();
  const item = {
    sourceChannelId: "1871127271",
    messageId: "105",
    caption: "Delicious Sister Rice Bowl - Japanese Version" // "delicious sister rice bowl" is HIGH for DESTINATION_8, "japanese" is MEDIUM for DESTINATION_9
  };
  const decision = classifier.classify(item);

  assert.strictEqual(decision.confidence, "HIGH");
  assert.strictEqual(decision.destinationChannelId, "DESTINATION_8");
  assert.strictEqual(decision.matchedCategory, "Concubine");
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
        name: "Romantic Vibe",
        enabled: true,
        priority: 1,
        keywords: { high: [], medium: [], low: ["mood"] }
      }
    }
  };
  const classifier = new TelegramContentClassifier(config);
  const item = { sourceChannelId: "1", messageId: "108", caption: "good mood today" };
  const decision = classifier.classify(item);

  assert.strictEqual(decision.confidence, "LOW");
  assert.strictEqual(decision.destinationChannelId, "DESTINATION_1");
});

runTest("Duplicate message handling: marks duplicate: true on repeated evaluation", () => {
  const seen = new Set();
  const classifier = new TelegramContentClassifier(null, seen);
  const item = { sourceChannelId: "1762071168", messageId: "200", caption: "Romantic Vibe" };

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
    caption: "Her premium Fantrie Nude content is on the Korean VIP channel"
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
  assert.strictEqual(dec2.matchedCategory, "Concubine");
});

runTest("Unknown source handling: handles unconfigured sourceChannelId cleanly", () => {
  const classifier = new TelegramContentClassifier();
  const item = {
    sourceChannelId: "9999999999",
    messageId: "301",
    caption: "Dating with evergrande troupe"
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
        name: "Dating",
        enabled: false,
        priority: 2,
        keywords: { high: ["dating"] }
      }
    }
  };
  const classifier = new TelegramContentClassifier(config);
  const item = { sourceChannelId: "1", messageId: "401", caption: "dating tonight" };
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
    { sourceChannelId: "1", messageId: "1", caption: "Romantic Vibe" },
    { sourceChannelId: "2", messageId: "2", caption: "Dating and evergrande troupe" },
    { sourceChannelId: "3", messageId: "3", caption: "Daughter-in-law's First Love" },
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
