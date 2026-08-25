require("dotenv").config();
const assert = require("assert");

const indexApp = require("../index.js");

async function run20EnglishTrendingCardsTest() {
  console.log("=== 20 CARDS SEMANTIC UI VERIFICATION ===\n");

  // 1. Fetch main keyboard containing the 20 cards
  const keyboardObj = await indexApp.getMainKeyboard();
  assert.ok(keyboardObj && keyboardObj.inline_keyboard, "Main keyboard MUST exist");
  const rows = keyboardObj.inline_keyboard;

  // Flatten all buttons in Cards 1-20 grid
  const buttons = rows.flat();
  assert.strictEqual(buttons.length, 20, "Cards 1-20 grid MUST contain exactly 20 buttons");

  buttons.forEach((btn, idx) => {
    assert.ok(btn.text, `Card ${idx + 1} MUST have text`);
    assert.ok(btn.callback_data && btn.callback_data.startsWith("topic:"), `Card ${idx + 1} MUST have a topic: callback_data`);
    console.log(`   ✅ Card ${idx + 1}: ${btn.text} -> ${btn.callback_data}`);
  });

  console.log("\n🎉 20 CARDS SEMANTIC UI VERIFICATION PASSED!");
}

run20EnglishTrendingCardsTest().catch(err => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
