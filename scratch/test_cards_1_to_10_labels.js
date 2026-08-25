require("dotenv").config();
const assert = require("assert");
const { getMainKeyboard } = require("../index");

const EXPECTED_CARD_1_TO_10_LABELS = [
  "🔥 K-Pop 열애설",
  "💋 비밀 연애",
  "👀 아이돌 열애 루머",
  "💔 연예인 결별",
  "🚨 열애 논란",
  "❤️ 비밀 커플",
  "😳 바이럴 로맨스",
  "🔥 럽스타그램",
  "💍 결혼 루머",
  "👀 연예계 스캔들"
];

async function runTest() {
  console.log("=== CARDS 1-10 KOREAN LABELS VERIFICATION ===\n");

  const mainKb = await getMainKeyboard();
  const buttons = mainKb.inline_keyboard.flat();

  for (let i = 0; i < 10; i++) {
    assert.strictEqual(buttons[i].text, EXPECTED_CARD_1_TO_10_LABELS[i], `Card ${i + 1} label MUST be "${EXPECTED_CARD_1_TO_10_LABELS[i]}"`);
    console.log(`✅ Card ${i + 1}: ${buttons[i].text}`);
  }

  console.log("\n🎉 ALL CARDS 1-10 LABEL CHECKS PASSED!");
}

runTest().catch(err => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
