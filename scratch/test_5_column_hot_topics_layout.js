require("D:\\Automation\\hiruboy\\node_modules\\dotenv").config({ path: "D:\\Automation\\hiruboy\\.env" });
const assert = require("assert");

const indexApp = require("D:\\Automation\\hiruboy\\index.js");

async function runTest() {
  console.log("=== HOT TOPICS 5-COLUMN LAYOUT VERIFICATION ===\n");

  const keyboardObj = await indexApp.getMainKeyboard();
  const rows = keyboardObj.inline_keyboard;

  assert.strictEqual(rows.length, 4, "HOT TOPICS grid MUST have 4 rows");
  rows.forEach((r, idx) => {
    assert.strictEqual(r.length, 5, `Row ${idx + 1} MUST have exactly 5 columns`);
  });

  console.log("✅ HOT TOPICS grid rendered as 4 rows x 5 columns = 20 buttons!");
  console.log("\n🎉 5-COLUMN LAYOUT VERIFICATION PASSED!");
}

runTest().catch(err => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
