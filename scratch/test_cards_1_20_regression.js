const index = require('../index');

console.log("==================================================");
console.log("🧪 RUNNING CARDS 1–12 REGRESSION SUITE (KOREAN LABELS)");
console.log("==================================================\n");

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`✅ PASS: ${message}`);
    passed++;
  } else {
    console.error(`❌ FAIL: ${message}`);
    failed++;
  }
}

async function runTests() {
  console.log("--- 1. Cards 1–12 Count & Layout Audit ---");
  const mainKb = await index.getMainKeyboard();
  assert(mainKb.inline_keyboard.length === 4, "getMainKeyboard() grid has exactly 4 rows");
  const allButtons = mainKb.inline_keyboard.flat();
  assert(allButtons.length === 12, `getMainKeyboard() grid has exactly 12 buttons (found ${allButtons.length})`);

  console.log("\n--- 2. Cards 1–12 Target Channels & Callback Data Lock ---");
  const expectedCallbacks = [
    "Myanmar",
    "Evergrande Troupe",
    "Myanmar Women",
    "Sister Snake",
    "Has Work",
    "Bullying & Sex",
    "Da Ci Ge",
    "Senior Year Love Story",
    "Sichuan Mother & Son",
    "Hu Siyuan",
    "Kept Lover",
    "Didi Proxy Operation"
  ];
  for (let i = 0; i < 12; i++) {
    const cb = expectedCallbacks[i];
    assert(allButtons[i].callback_data === `topic:${cb}`, `Card ${i + 1} callback_data locked: "topic:${cb}"`);
  }

  console.log("\n--- 3. Cards 1–12 Korean Display Labels Audit ---");
  const expectedKoreanLabels = [
    "미얀마",
    "헝다 가무단",
    "미얀마 여성",
    "뱀 누나",
    "일거리 있음",
    "괴롭힘과 성관계",
    "다츠거",
    "고3 사랑 이야기",
    "쓰촨 모자",
    "후쓰위안",
    "애인으로 부양",
    "디디 대리운영"
  ];
  let correctLabelsCount = 0;
  let objectCount = 0;
  allButtons.forEach((btn, idx) => {
    const text = btn.text;
    if (text.includes("[object Object]")) objectCount++;
    if (text === expectedKoreanLabels[idx]) correctLabelsCount++;
  });
  assert(correctLabelsCount === 12, `All 12 cards have exact expected Korean display labels (${correctLabelsCount}/12)`);
  assert(objectCount === 0, `Zero [object Object] in Cards 1–12 (${objectCount})`);

  console.log("\n==================================================");
  console.log(`📊 CARDS 1–12 REGRESSION TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("==================================================");

  if (failed > 0) process.exit(1);
}

runTests();
