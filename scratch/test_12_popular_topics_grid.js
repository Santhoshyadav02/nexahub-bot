const assert = require("assert");
const index = require("../index");

console.log("==================================================");
console.log("🧪 TESTING 12 POPULAR TOPICS (3x4 GRID) UI LAYOUT");
console.log("==================================================\n");

async function runTest() {
  const mainKb = await index.getMainKeyboard();
  assert(mainKb && mainKb.inline_keyboard, "getMainKeyboard() returns inline_keyboard");

  const rows = mainKb.inline_keyboard;
  console.log(`Total rows in Popular Topics grid: ${rows.length} (Expected: 4)`);
  assert.strictEqual(rows.length, 4, "Popular Topics grid must have exactly 4 rows");

  let totalButtons = 0;
  rows.forEach((row, rowIdx) => {
    console.log(`Row ${rowIdx + 1} button count: ${row.length} (Expected: 3)`);
    assert.strictEqual(row.length, 3, `Row ${rowIdx + 1} must contain exactly 3 buttons`);
    row.forEach((btn, colIdx) => {
      totalButtons++;
      console.log(`  Row ${rowIdx + 1}, Col ${colIdx + 1} [Card ${totalButtons}]: "${btn.text}" -> callback: "${btn.callback_data}"`);
      assert.ok(btn.text && btn.text.length > 0, `Button ${totalButtons} must have display text`);
      assert.ok(btn.callback_data && btn.callback_data.startsWith("topic:"), `Button ${totalButtons} must have valid topic callback_data`);
    });
  });

  console.log(`\nTotal visible Popular Topics buttons: ${totalButtons} (Expected: 12)`);
  assert.strictEqual(totalButtons, 12, "Total visible Popular Topics buttons must be exactly 12");

  console.log("\n==================================================");
  console.log("🎉 12 POPULAR TOPICS (3x4 GRID) TEST PASSED!");
  console.log("==================================================");
}

runTest().catch(err => {
  console.error("❌ Test Failed:", err);
  process.exit(1);
});
