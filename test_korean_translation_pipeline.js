/**
 * test_korean_translation_pipeline.js
 * 
 * Unit and integration tests for source language detection and natural Korean translation
 */

const assert = require("assert");
const {
  detectSourceLanguage,
  translateToKorean,
  cleanRawCaption,
  generateKoreanCaptionAsync,
  generateKoreanCaption,
  formatKoreanCaptionFromMetadata
} = require("./korean_caption_generator");

let totalTests = 0;
let passedTests = 0;

async function it(desc, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`✅ [PASS] ${totalTests}. ${desc}`);
    passedTests++;
  } catch (err) {
    console.error(`❌ [FAIL] ${totalTests}. ${desc}`);
    console.error(`   Error: ${err.message}`);
  }
}

async function runAllTests() {
  console.log("==================================================");
  console.log("🧪 RUNNING KOREAN SOURCE TRANSLATION PIPELINE TESTS");
  console.log("==================================================\n");

  // Test 1: English source -> output is Korean and does not equal English
  await it("Test 1: English source 'Romantic Vibe One Bed Two Couple (2021)' translates to Korean", async () => {
    const item = {
      sourceChannelId: "1762071168",
      messageId: "298",
      caption: "Romantic Vibe One Bed Two Couple (2021) HD » ▰▱▱▱▱▱▱▱▱▱▱▱▱▰ 🔰BACK UP CHANNEL🔰"
    };
    const res = await generateKoreanCaptionAsync(item, { matchedCategory: "Romantic Vibe" });
    assert.strictEqual(res.captionSource, "source_metadata");
    assert.notStrictEqual(res.translatedMetadata, "Romantic Vibe One Bed Two Couple (2021)");
    assert.ok(/[\uAC00-\uD7AF]/.test(res.generatedKoreanCaption), "Generated caption must contain Korean characters");
    assert.ok(res.generatedKoreanCaption.includes("2021"), "Year information 2021 must be preserved");
    console.log(`      EN: "${item.caption.substring(0, 45)}..."`);
    console.log(`      KO: "${res.generatedKoreanCaption.replace(/\n/g, ' ')}"`);
  });

  // Test 2: Chinese source -> output is Korean and does not remain Chinese
  await it("Test 2: Chinese source caption translates to natural Korean", async () => {
    const item = {
      sourceChannelId: "1871127271",
      messageId: "72",
      caption: "美味的姐姐饭碗 HD » ▰▱▱▱▱▱▱▱▱▱▱▱▱▰ 🔰BACK UP CHANNEL🔰"
    };
    const res = await generateKoreanCaptionAsync(item, { matchedCategory: "Concubine" });
    assert.strictEqual(res.captionSource, "source_metadata");
    assert.ok(/[\uAC00-\uD7AF]/.test(res.translatedMetadata), "Translated metadata must contain Korean characters");
    assert.ok(res.generatedKoreanCaption.includes("🎬"), "Caption must include movie icon");
    console.log(`      ZH: "${item.caption.substring(0, 45)}..."`);
    console.log(`      KO: "${res.generatedKoreanCaption.replace(/\n/g, ' ')}"`);
  });

  // Test 3: Japanese source -> output is Korean
  await it("Test 3: Japanese source caption translates to natural Korean", async () => {
    const item = {
      sourceChannelId: "1871127271",
      messageId: "52",
      caption: "新人女子社員が変態上司にからかわれる (2023)"
    };
    const res = await generateKoreanCaptionAsync(item, { matchedCategory: "Saki Mizumi" });
    assert.strictEqual(res.captionSource, "source_metadata");
    assert.ok(/[\uAC00-\uD7AF]/.test(res.translatedMetadata), "Translated metadata must contain Korean characters");
    assert.ok(res.generatedKoreanCaption.includes("2023"), "Year information 2023 must be preserved");
    console.log(`      JA: "${item.caption}"`);
    console.log(`      KO: "${res.generatedKoreanCaption.replace(/\n/g, ' ')}"`);
  });

  // Test 4: Korean source -> remains Korean / cleaned without unnecessary translation
  await it("Test 4: Korean source caption remains preserved and cleaned", async () => {
    const item = {
      sourceChannelId: "1762071168",
      messageId: "100",
      caption: "최신 한국 로맨스 명작 (2024) » ▰▱▱▱▱▱▱▱▱▱▱▱▱▰ 🔰BACK UP CHANNEL🔰"
    };
    const res = await generateKoreanCaptionAsync(item, { matchedCategory: "Romance" });
    assert.strictEqual(res.captionSource, "source_metadata");
    assert.ok(res.generatedKoreanCaption.includes("최신 한국 로맨스 명작 (2024)"), "Original Korean title must be preserved");
    console.log(`      KO (Orig): "${item.caption.substring(0, 45)}..."`);
    console.log(`      KO (Clean): "${res.generatedKoreanCaption.replace(/\n/g, ' ')}"`);
  });

  // Test 5: Blank source caption -> uses existing 300-caption fallback
  await it("Test 5: Blank source caption triggers generic 300 fallback caption", async () => {
    const item = {
      sourceChannelId: "1521978999",
      messageId: "906692",
      caption: ""
    };
    const res = await generateKoreanCaptionAsync(item, { matchedCategory: "Saki Mizumi" });
    assert.strictEqual(res.captionSource, "generic_fallback");
    assert.ok(/[\uAC00-\uD7AF]/.test(res.generatedKoreanCaption), "Fallback caption must be Korean");
    console.log(`      Blank input -> Fallback: "${res.generatedKoreanCaption.replace(/\n/g, ' ')}"`);
  });

  // Test 6: Non-empty source caption -> NEVER uses generic fallback caption
  await it("Test 6: Non-empty source caption NEVER uses generic fallback caption", async () => {
    const item = {
      sourceChannelId: "1871127271",
      messageId: "57",
      caption: "Good Mother (2019)"
    };
    const res = await generateKoreanCaptionAsync(item, { matchedCategory: "Crotch" });
    assert.strictEqual(res.captionSource, "source_metadata", "Must use source_metadata when title exists");
    assert.notStrictEqual(res.captionSource, "generic_fallback", "Must never use generic_fallback for titled video");
  });

  // Test 7: Translation preserves important source title & metadata details
  await it("Test 7: Translation preserves numbers, years, and core movie title components", async () => {
    const item = {
      sourceChannelId: "1871127271",
      messageId: "54",
      caption: "Adult Sport 2 (2022)"
    };
    const res = await generateKoreanCaptionAsync(item, { matchedCategory: "Lustful Hostess" });
    assert.strictEqual(res.captionSource, "source_metadata");
    assert.ok(res.generatedKoreanCaption.includes("2022") || res.translatedMetadata.includes("2022"), "Must preserve year");
    console.log(`      Source: "${item.caption}" -> Caption: "${res.generatedKoreanCaption.replace(/\n/g, ' ')}"`);
  });

  console.log("\n==================================================");
  console.log(`📊 TRANSLATION PIPELINE RESULTS: ${passedTests}/${totalTests} PASSED`);
  console.log("==================================================");

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

if (require.main === module) {
  runAllTests().catch(err => {
    console.error("Test execution error:", err);
    process.exit(1);
  });
}

module.exports = { runAllTests };
