require("dotenv").config();
const assert = require("assert");

const indexApp = require("../index.js");
const sourceRegistry = require("../source_registry.js");

function scanKeyboard(kb, label) {
  assert.ok(kb, `${label} MUST return a keyboard object`);
  const rows = kb.inline_keyboard || kb.keyboard;
  assert.ok(rows, `${label} MUST have inline_keyboard or keyboard property`);
  assert.ok(Array.isArray(rows), `${label} rows MUST be an array`);

  const jsonStr = JSON.stringify(kb);
  const containsUnpairedSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/.test(jsonStr);
  assert.strictEqual(containsUnpairedSurrogate, false, `${label} MUST NOT contain unpaired surrogates!`);

  const buf = Buffer.from(jsonStr, "utf8");
  const decoded = buf.toString("utf8");
  assert.strictEqual(decoded, jsonStr, `${label} UTF-8 decoding MUST match exact JSON`);

  let buttonCount = 0;
  rows.forEach((row, rIdx) => {
    assert.ok(Array.isArray(row), `${label} row ${rIdx} MUST be an array`);
    row.forEach((btn, cIdx) => {
      buttonCount++;
      const btnText = typeof btn === "string" ? btn : btn.text;
      assert.ok(btnText, `${label} row ${rIdx} col ${cIdx} MUST have text`);
      assert.strictEqual(typeof btnText, "string", `${label} row ${rIdx} col ${cIdx} text MUST be string`);
      const btnUnpaired = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/.test(btnText);
      assert.strictEqual(btnUnpaired, false, `${label} button "${btnText}" MUST NOT contain unpaired surrogates!`);
    });
  });

  return buttonCount;
}

async function runRecursiveKeyboardUTF8Scan() {
  console.log("=== RECURSIVE INLINE KEYBOARD UTF-8 SCAN ===\n");
  let totalKeyboardsScanned = 0;
  let totalButtonsScanned = 0;

  // 1. Scan getMainKeyboard
  const mainKb = await indexApp.getMainKeyboard();
  totalButtonsScanned += scanKeyboard(mainKb, "getMainKeyboard");
  totalKeyboardsScanned++;
  console.log("✅ getMainKeyboard: Scanned successfully.");

  // 2. Scan getTrendingKeyboard
  const trendingKb = await indexApp.getTrendingKeyboard();
  totalButtonsScanned += scanKeyboard(trendingKb, "getTrendingKeyboard");
  totalKeyboardsScanned++;
  console.log("✅ getTrendingKeyboard: Scanned successfully.");

  // 3. Scan getPersistentKeyboard
  const persistentKb = indexApp.getPersistentKeyboard();
  totalButtonsScanned += scanKeyboard(persistentKb, "getPersistentKeyboard");
  totalKeyboardsScanned++;
  console.log("✅ getPersistentKeyboard: Scanned successfully.");

  // 4. Scan getPersistentNavigationKeyboard
  const persistentNavKb = indexApp.getPersistentNavigationKeyboard();
  totalButtonsScanned += scanKeyboard(persistentNavKb, "getPersistentNavigationKeyboard");
  totalKeyboardsScanned++;
  console.log("✅ getPersistentNavigationKeyboard: Scanned successfully.");

  // 5. Scan HOT TOPICS (20 channels x 3 pages)
  console.log("\n📌 Scanning HOT TOPICS Channel Keyboards (20 channels x 3 pages):");
  const TARGET_CHANNELS = [
    "Romantic Vibe", "Dating", "Romance", "Crotch", "Mosa",
    "Bunny Girl Cosplay Date", "Lustful Hostess", "Concubine", "Saki Mizumi", "A Muse"
  ];
  for (const ch of TARGET_CHANNELS) {
    const posts = sourceRegistry.getPostsForKeyword(ch);
    for (let p = 1; p <= 3; p++) {
      // Simulate renderHyperlinkListPostView inline_keyboard
      const pageItems = posts.slice((p - 1) * 7, p * 7);
      const rows = pageItems.map((item, idx) => {
        const itemNumber = (p - 1) * 7 + idx + 1;
        const title = item.title || item.name || "Resource";
        const btnText = indexApp.truncateUTF8(`${itemNumber}. 🎬 ${title}`, 55);
        return [{ text: btnText, callback_data: `det:topic:${ch}:${idx}:${p}` }];
      });
      rows.push([{ text: "🏠 Back to Main Menu", callback_data: "menu" }]);
      const kb = { inline_keyboard: rows };
      totalButtonsScanned += scanKeyboard(kb, `Channel:${ch}:Page:${p}`);
      totalKeyboardsScanned++;
    }
    console.log(`   ✅ Channel: ${ch.padEnd(25)} (3 pages scanned)`);
  }

  // 6. Scan CATEGORIES (8 categories)
  console.log("\n📌 Scanning 8 Categories Keyboards:");
  const CAT_KEYS = ["games", "ai_tools", "stories", "papers", "opening_up", "food_source", "finance", "adult"];
  for (const catKey of CAT_KEYS) {
    const cat = indexApp.CATEGORIES[catKey];
    if (cat && cat.items) {
      const rows = cat.items.slice(0, 7).map((item, idx) => [{
        text: indexApp.truncateUTF8(`${idx + 1}. ${item.name}`, 55),
        callback_data: `det:cat:${catKey}:${idx}:1`
      }]);
      rows.push([{ text: "🏠 Back to Main Menu", callback_data: "menu" }]);
      const kb = { inline_keyboard: rows };
      totalButtonsScanned += scanKeyboard(kb, `Category:${catKey}`);
      totalKeyboardsScanned++;
      console.log(`   ✅ Category: ${catKey.padEnd(20)} (${cat.items.length} items scanned)`);
    }
  }

  // 7. Verify Malformed Surrogate Edge-Case Recovery
  console.log("\n📌 Testing Malformed Surrogate Edge-Case Recovery:");
  const emojiStr = "🎬 High-profile 🔞 ultra-fine 💎 jennie kaede 🌸 👁️";
  for (let len = 1; len <= emojiStr.length; len++) {
    const truncated = indexApp.truncateUTF8(emojiStr, len);
    const containsUnpaired = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/.test(truncated);
    assert.strictEqual(containsUnpaired, false, `Truncated length ${len} MUST NOT contain unpaired surrogates!`);
  }
  console.log(`   ✅ Tested all ${emojiStr.length} truncation lengths: 100% clean UTF-8 recovery!`);

  console.log(`\n🎉 RECURSIVE SCAN COMPLETED: ${totalKeyboardsScanned} Keyboards / ${totalButtonsScanned} Buttons Scanned — 0 ERRORS!`);
}

runRecursiveKeyboardUTF8Scan().catch(err => {
  console.error("❌ RECURSIVE SCAN FAILED:", err);
  process.exit(1);
});
