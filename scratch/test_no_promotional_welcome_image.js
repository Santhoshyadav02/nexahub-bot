const assert = require("assert");
const index = require("../index");

console.log("==================================================");
console.log("🧪 RUNNING NO PROMOTIONAL WELCOME MESSAGE REGRESSION TEST");
console.log("==================================================\n");

let passed = 0;
let failed = 0;

function check(condition, testName) {
  if (condition) {
    console.log(`✅ [TEST PASSED] ${testName}`);
    passed++;
  } else {
    console.error(`❌ [TEST FAILED] ${testName}`);
    failed++;
  }
}

async function testNoPromotionalWelcome() {
  // TEST 1: Check main keyboard 3x4 layout
  const mainKb = await index.getMainKeyboard();
  const buttons = mainKb.inline_keyboard.flat();
  check(buttons.length === 12, "TEST 1: 12 Popular Topic cards keyboard present (3x4 grid)");

  // TEST 2: Verify /start does not send WELCOME_IMAGE or Russian promotional content
  const fs = require("fs");
  const indexSrc = fs.readFileSync("./index.js", "utf8");

  const includesWelcomeImageInStart = indexSrc.includes("sendPhotoSafe(chatId, WELCOME_IMAGE");
  check(!includesWelcomeImageInStart, "TEST 2: /start handler no longer calls sendPhotoSafe with WELCOME_IMAGE banner");

  const includesRussianPromotionalText = indexSrc.includes("Добро пожаловать") || indexSrc.includes("Нажмите по кнопке снизу") || indexSrc.includes("КЛИК");
  check(!includesRussianPromotionalText, "TEST 3: Zero Russian promotional text present in /start handler or codebase");

  console.log("\n==================================================");
  console.log(`📊 REGRESSION TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("==================================================");

  if (failed > 0) process.exit(1);
}

testNoPromotionalWelcome().catch(err => {
  console.error("❌ Test Runner Error:", err);
  process.exit(1);
});
