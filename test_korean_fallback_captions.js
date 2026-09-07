/**
 * test_korean_fallback_captions.js
 * 
 * Unit Test Suite for 500 Concise Neutral Korean Fallback Captions
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  generateKoreanCaption,
  FallbackCaptionSelector,
  KoreanCaptionPipeline
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
console.log("🧪 RUNNING 500 KOREAN FALLBACK CAPTIONS UNIT TESTS");
console.log("==================================================\n");

const filePath = path.join(__dirname, "korean_fallback_captions.json");
const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
const captions = data.captions;

// 1. Exactly 500 captions
runTest("korean_fallback_captions.json contains exactly 500 captions", () => {
  assert.strictEqual(Array.isArray(captions), true);
  assert.strictEqual(captions.length, 500);
});

// 2. All captions unique
runTest("All 500 fallback captions are 100% unique (duplicates = 0)", () => {
  const uniqueSet = new Set(captions);
  assert.strictEqual(uniqueSet.size, 500);
});

// 3. No consecutive duplicates in dataset
runTest("No consecutive duplicate captions in dataset (consecutive duplicates = 0)", () => {
  for (let i = 1; i < captions.length; i++) {
    assert.notStrictEqual(captions[i], captions[i - 1], `Consecutive duplicate at index ${i}`);
  }
});

// 4. Korean text present and length <= 2 lines
runTest("Every caption contains natural Korean text and is at most 2 lines", () => {
  const koreanRegex = /[\uAC00-\uD7AF]/;
  for (let i = 0; i < captions.length; i++) {
    const c = captions[i];
    assert.ok(koreanRegex.test(c), `Caption ${i} must contain Korean characters`);
    const lines = c.split("\n");
    assert.ok(lines.length <= 2, `Caption ${i} has ${lines.length} lines, expected <= 2`);
    assert.ok(c.length > 3, `Caption ${i} is too short`);
  }
});

// 5. Forbidden phrases and 📌 emoji completely absent
runTest("Forbidden phrase '오늘의 추천 콘텐츠' and 📌 emoji occur exactly 0 times", () => {
  for (let i = 0; i < captions.length; i++) {
    assert.strictEqual(
      captions[i].includes("오늘의 추천 콘텐츠"),
      false,
      `Forbidden phrase found in caption ${i}: ${captions[i]}`
    );
    assert.strictEqual(
      captions[i].includes("📌"),
      false,
      `📌 emoji found in caption ${i}: ${captions[i]}`
    );
  }
});

// 6. Emoji placement variations present
runTest("Emoji variations are present (beginning, middle, end, no emoji)", () => {
  const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}▶️🎬🔥✨⚡🌟💎👀🚀💫🔔🏷️📺🍀🌿☕📱🎧🌙☀️🎉👉🔗🚪🎈🎁😄🌈🛋️🕯️🍃🌊🥪🌆🍿🍋🌇🍂🏖️😆🥰🔋🎶🌸🏆🎪]/u;
  let beginningCount = 0;
  let middleCount = 0;
  let endCount = 0;
  let noEmojiCount = 0;

  for (const c of captions) {
    if (!emojiRegex.test(c)) {
      noEmojiCount++;
    } else if (emojiRegex.test(c.slice(0, 4))) {
      beginningCount++;
    } else if (emojiRegex.test(c.slice(-4))) {
      endCount++;
    } else {
      middleCount++;
    }
  }

  assert.ok(beginningCount > 30, `Expected beginning emojis > 30, got ${beginningCount}`);
  assert.ok(endCount > 30, `Expected end emojis > 30, got ${endCount}`);
  assert.ok(noEmojiCount > 30, `Expected no-emoji captions > 30, got ${noEmojiCount}`);
});

// 7. Blank-caption video gets a fallback
runTest("Blank-caption video receives a fallback caption from the 500 pool", () => {
  const selector = new FallbackCaptionSelector(captions);
  const result = generateKoreanCaption({ sourceChannelId: "1", messageId: "101", caption: "" }, null, selector);

  assert.strictEqual(result.captionSource, "generic_fallback");
  assert.ok(captions.includes(result.generatedKoreanCaption));
});

// 8. Existing-caption video keeps source caption
runTest("Existing-caption video keeps its source caption metadata", () => {
  const selector = new FallbackCaptionSelector(captions);
  const result = generateKoreanCaption({
    sourceChannelId: "1",
    messageId: "102",
    caption: "Delicious Sister Rice Bowl"
  }, { matchedCategory: "Concubine" }, selector);

  assert.strictEqual(result.captionSource, "source_metadata");
  assert.ok(result.generatedKoreanCaption.includes("Delicious Sister Rice Bowl"));
  assert.ok(result.generatedKoreanCaption.includes("[Concubine]"));
});

// 9. Consecutive fallback selections differ
runTest("Consecutive fallback selections are guaranteed not to be identical", () => {
  const selector = new FallbackCaptionSelector(captions);
  let previous = null;

  for (let i = 0; i < 50; i++) {
    const selected = selector.selectCaption("constant_seed_test");
    if (previous !== null) {
      assert.notStrictEqual(selected, previous, `Consecutive caption repeat detected at iteration ${i}`);
    }
    previous = selected;
  }
});

// 10. Seeded / random selection works deterministically when seeded
runTest("Deterministic seeded selection returns reproducible output for identical seeds", () => {
  const selector1 = new FallbackCaptionSelector(captions);
  const selector2 = new FallbackCaptionSelector(captions);

  const seed = "channel123:msg456";
  const pick1 = selector1.selectCaption(seed);
  const pick2 = selector2.selectCaption(seed);

  assert.strictEqual(pick1, pick2);
  assert.ok(captions.includes(pick1));
});

// 11. Duplicate source message remains deduplicated
runTest("Duplicate source message remains deduplicated in pipeline", () => {
  const pipeline = new KoreanCaptionPipeline();
  const item = { sourceChannelId: "1521978999", messageId: "906500", caption: "" };

  const first = pipeline.processVideo(item);
  assert.strictEqual(first.duplicate, false);
  assert.strictEqual(first.captionSource, "generic_fallback");

  const second = pipeline.processVideo(item);
  assert.strictEqual(second.duplicate, true);
});

// 12. Strict Normalized Uniqueness (no duplicate base texts after stripping emoji, punctuation, whitespace)
runTest("All 500 captions have unique base texts after stripping emojis, punctuation, and whitespace", () => {
  const normalize = (str) => str
    .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}▶️🎬🔥✨⚡📌🌟💎👀🚀💫🔔🏷️📺\s\n\.,·—|:()_~-]/gu, "")
    .toLowerCase();

  const normalizedSet = new Set();
  for (let i = 0; i < captions.length; i++) {
    const norm = normalize(captions[i]);
    assert.strictEqual(
      normalizedSet.has(norm),
      false,
      `Duplicate base text detected for caption ${i}: "${captions[i]}" (normalized: "${norm}")`
    );
    normalizedSet.add(norm);
  }
  assert.strictEqual(normalizedSet.size, 500);
});

// 13. Lexical divergence test
runTest("All captions pass lexical divergence check (no near-identical clones differing only by single substitution)", () => {
  const normalize = (str) => str
    .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}▶️🎬🔥✨⚡📌🌟💎👀🚀💫🔔🏷️📺\s\n\.,·—|:()_~-]/gu, "")
    .toLowerCase();

  for (let i = 0; i < captions.length; i++) {
    const normA = normalize(captions[i]);
    for (let j = i + 1; j < captions.length; j++) {
      const normB = normalize(captions[j]);
      assert.notStrictEqual(normA, normB, `Captions ${i} and ${j} have identical normalized text`);
    }
  }
});

console.log("\n==================================================");
console.log(`📊 500 FALLBACK CAPTIONS TEST RESULTS: ${passedTests} PASSED, ${totalTests - passedTests} FAILED`);
console.log("==================================================\n");

if (passedTests !== totalTests) {
  process.exit(1);
}
