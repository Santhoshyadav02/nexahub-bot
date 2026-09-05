/**
 * test_korean_fallback_captions.js
 * 
 * Unit Test Suite for Stage 7 300 Korean Fallback Captions
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
console.log("🧪 RUNNING 300 KOREAN FALLBACK CAPTIONS UNIT TESTS");
console.log("==================================================\n");

const filePath = path.join(__dirname, "korean_fallback_captions.json");
const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
const captions = data.captions;

// 1. Exactly 300 captions
runTest("korean_fallback_captions.json contains exactly 300 captions", () => {
  assert.strictEqual(Array.isArray(captions), true);
  assert.strictEqual(captions.length, 300);
});

// 2. All captions unique
runTest("All 300 fallback captions are 100% unique", () => {
  const uniqueSet = new Set(captions);
  assert.strictEqual(uniqueSet.size, 300);
});

// 3. Korean text present and length <= 2 lines
runTest("Every caption contains natural Korean text and is 1-2 lines", () => {
  const koreanRegex = /[\uAC00-\uD7AF]/;
  for (let i = 0; i < captions.length; i++) {
    const c = captions[i];
    assert.ok(koreanRegex.test(c), `Caption ${i} must contain Korean characters`);
    const lines = c.split("\n");
    assert.ok(lines.length <= 2, `Caption ${i} has ${lines.length} lines, expected <= 2`);
    assert.ok(c.length > 5, `Caption ${i} is too short`);
  }
});

// 4. Blank-caption video gets a fallback
runTest("Blank-caption video receives a fallback caption from the 300 pool", () => {
  const selector = new FallbackCaptionSelector(captions);
  const result = generateKoreanCaption({ sourceChannelId: "1", messageId: "101", caption: "" }, null, selector);

  assert.strictEqual(result.captionSource, "generic_fallback");
  assert.ok(captions.includes(result.generatedKoreanCaption));
});

// 5. Existing-caption video keeps source caption
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

// 6. Consecutive fallback captions differ
runTest("Consecutive fallback selections are guaranteed not to be identical", () => {
  const selector = new FallbackCaptionSelector(captions);
  let previous = null;

  for (let i = 0; i < 50; i++) {
    // Repeatedly select with same seed to test anti-repetition
    const selected = selector.selectCaption("constant_seed_test");
    if (previous !== null) {
      assert.notStrictEqual(selected, previous, `Consecutive caption repeat detected at iteration ${i}`);
    }
    previous = selected;
  }
});

// 7. Seeded / random selection works deterministically when seeded
runTest("Deterministic seeded selection returns reproducible output for identical seeds", () => {
  const selector1 = new FallbackCaptionSelector(captions);
  const selector2 = new FallbackCaptionSelector(captions);

  const seed = "channel123:msg456";
  const pick1 = selector1.selectCaption(seed);
  const pick2 = selector2.selectCaption(seed);

  assert.strictEqual(pick1, pick2);
  assert.ok(captions.includes(pick1));
});

// 8. Duplicate source message remains deduplicated
runTest("Duplicate source message remains deduplicated in pipeline", () => {
  const pipeline = new KoreanCaptionPipeline();
  const item = { sourceChannelId: "1521978999", messageId: "906500", caption: "" };

  const first = pipeline.processVideo(item);
  assert.strictEqual(first.duplicate, false);
  assert.strictEqual(first.captionSource, "generic_fallback");

  const second = pipeline.processVideo(item);
  assert.strictEqual(second.duplicate, true);
});

console.log("\n==================================================");
console.log(`📊 300 FALLBACK CAPTIONS TEST RESULTS: ${passedTests} PASSED, ${totalTests - passedTests} FAILED`);
console.log("==================================================\n");

if (passedTests !== totalTests) {
  process.exit(1);
}
