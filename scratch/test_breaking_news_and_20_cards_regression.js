const index = require('../index');

console.log("==================================================");
console.log("🧪 RUNNING BREAKING NEWS & 12 CARDS REGRESSION SUITE (KOREAN LABELS)");
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

async function runRegressionTests() {
  // 1. Audit 12 HOT TOPICS Cards Korean Display Labels on Popular Screen
  console.log("--- 1. 12 HOT TOPICS Cards Korean Display Labels Audit ---");
  const mainKb = await index.getMainKeyboard();
  const allButtons = mainKb.inline_keyboard.flat();

  assert(allButtons.length === 12, `Grid contains exactly 12 buttons (found ${allButtons.length})`);

  let correctLabelsCount = 0;
  let objectStringCount = 0;

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

  allButtons.forEach((btn, idx) => {
    const text = btn.text;
    if (text.includes("[object Object]")) {
      objectStringCount++;
    }
    if (text === expectedKoreanLabels[idx]) {
      correctLabelsCount++;
    }
  });

  assert(correctLabelsCount === 12, `All 12 cards have exact Korean display labels (${correctLabelsCount}/12)`);
  assert(objectStringCount === 0, `Zero [object Object] found in main keyboard (${objectStringCount})`);

  // 2. Audit Breaking News Screen & Keyboard
  console.log("\n--- 2. Breaking News & Keyboard Audit ---");
  const breakingKb = await index.getBreakingNewsKeyboard();
  const breakingButtons = breakingKb.inline_keyboard.flat();

  let objectInTrending = 0;
  breakingButtons.forEach(btn => {
    if (btn.text && btn.text.includes("[object Object]")) {
      objectInTrending++;
    }
  });

  assert(objectInTrending === 0, `Zero [object Object] found in Breaking News keyboard (${objectInTrending})`);

  // 3. Direct Original URL Flow Verification
  console.log("\n--- 3. Direct Original URL Flow Verification ---");
  const newsButtons = breakingButtons.filter(b => b.text && b.text.startsWith("📰 ") && b.text !== "📰 속보");

  assert(newsButtons.length > 0, `Breaking News items present on Breaking screen (found ${newsButtons.length})`);

  let validOriginalUrlCount = 0;
  let googleTranslateUrlCount = 0;
  let hasCallbackQueryCount = 0;

  newsButtons.forEach(btn => {
    if (btn.url && btn.url.startsWith("http")) {
      validOriginalUrlCount++;
    }
    if (btn.url && btn.url.includes("translate.google.com")) {
      googleTranslateUrlCount++;
    }
    if (btn.callback_data && btn.callback_data !== "none") {
      hasCallbackQueryCount++;
    }
  });

  assert(validOriginalUrlCount === newsButtons.length, `All Breaking News buttons use valid direct URLs (${validOriginalUrlCount}/${newsButtons.length})`);
  assert(googleTranslateUrlCount === 0, `Zero Breaking News buttons use Google Translate URL wrappers (${googleTranslateUrlCount})`);
  assert(hasCallbackQueryCount === 0, `Zero Breaking News buttons use callback_data for intermediate page (${hasCallbackQueryCount})`);

  // 4. Callback & MTProto Target Mappings Unchanged
  console.log("\n--- 4. Target Channels & Callback Mappings Verification ---");
  const expectedCallbacks = [
    "Myanmar", "Evergrande Troupe", "Myanmar Women", "Sister Snake", "Has Work",
    "Bullying & Sex", "Da Ci Ge", "Senior Year Love Story", "Sichuan Mother & Son",
    "Hu Siyuan", "Kept Lover", "Didi Proxy Operation"
  ];

  expectedCallbacks.forEach((cb, idx) => {
    assert(allButtons[idx].callback_data === `topic:${cb}`, `Card ${idx + 1} callback data preserved: "topic:${cb}"`);
  });

  console.log("\n==================================================");
  console.log(`📊 REGRESSION TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("==================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runRegressionTests();
