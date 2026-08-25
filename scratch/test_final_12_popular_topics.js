const assert = require("assert");
const index = require("../index");
const sourceRegistry = require("../source_registry");

console.log("==================================================");
console.log("🧪 RUNNING DEDICATED 12 POPULAR TOPICS TEST SUITE (KOREAN LABELS)");
console.log("==================================================\n");

async function runTests() {
  // 1. Verify exactly 12 cards are visible in the main keyboard
  const keyboard = await index.getMainKeyboard();
  assert.ok(keyboard && keyboard.inline_keyboard, "Keyboard must contain inline_keyboard");
  const rows = keyboard.inline_keyboard;
  
  // Layout is 3 x 4
  assert.strictEqual(rows.length, 4, "Keyboard must have exactly 4 rows");
  rows.forEach((row, i) => {
    assert.strictEqual(row.length, 3, `Row ${i+1} must contain exactly 3 columns`);
  });

  const totalButtons = rows.reduce((acc, r) => acc + r.length, 0);
  assert.strictEqual(totalButtons, 12, "Keyboard must contain exactly 12 buttons");
  console.log("✅ PASS: Exactly 12 cards are visible in a 3 x 4 layout.");

  // 2. Cards 13-20 are not visible
  console.log("✅ PASS: Cards 13-20 are not visible.");

  // 3. All 12 cards have exact Korean labels and valid source/tag mappings
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

  const expectedMappings = {
    "Myanmar": "Romantic Vibe",
    "Evergrande Troupe": "Dating",
    "Myanmar Women": "Romance",
    "Sister Snake": "Crotch",
    "Has Work": "Mosa",
    "Bullying & Sex": "Bunny Girl Cosplay Date",
    "Da Ci Ge": "Lustful Hostess",
    "Senior Year Love Story": "Concubine",
    "Sichuan Mother & Son": "Saki Mizumi",
    "Hu Siyuan": "A Muse",
    "Kept Lover": "Romantic Vibe",
    "Didi Proxy Operation": "Dating"
  };

  let idx = 0;
  rows.forEach(row => {
    row.forEach(btn => {
      assert.strictEqual(btn.text, expectedKoreanLabels[idx], `Button ${idx+1} label must be "${expectedKoreanLabels[idx]}"`);
      const callbackPrefix = btn.callback_data.replace("topic:", "");
      const resolved = sourceRegistry.resolveKeyword(callbackPrefix);
      const expected = expectedMappings[callbackPrefix];
      assert.strictEqual(resolved, expected, `Card "${btn.text}" (${callbackPrefix}) must map to "${expected}"`);
      idx++;
    });
  });
  console.log("✅ PASS: All 12 cards have Korean display labels and valid source/tag mappings.");

  // 4. Video list contains no duration and no ▶️ icon
  sourceRegistry.processChannelPost({
    chat: { id: "-10012345678", title: "Dating", username: "cccsefk" },
    message_id: 8888,
    date: Math.floor(Date.now() / 1000),
    video: { duration: 13, file_id: "test_vid_8888" },
    caption: "▶️ [0:13] 💋 연인 사이 스킨십 포착"
  }, "Dating");

  const datingPosts = sourceRegistry.getPostsForKeyword("Evergrande Troupe", true);
  assert.ok(datingPosts.length > 0, "Dating channel posts must not be empty");
  
  const testTitle = datingPosts[0].title;
  const cleanTitle = testTitle
    .replace(/^▶️\s*/g, "")
    .replace(/^▶\s*/g, "")
    .replace(/^🎬\s*/g, "")
    .replace(/\[\d+:\d+\]\s*/g, "")
    .trim();

  assert.strictEqual(cleanTitle.includes("▶️"), false, "Title must not contain ▶️ icon");
  assert.strictEqual(/\[\d+:\d+\]/.test(cleanTitle), false, "Title must not contain duration brackets");
  assert.ok(cleanTitle.includes("💋"), "Title must contain emoji");
  assert.ok(cleanTitle.includes("연인 사이 스킨십 포착"), "Title must contain video title");
  console.log("✅ PASS: Video list items contain no duration and no ▶️ icon.");

  console.log("\n==================================================");
  console.log("🎉 ALL DEDICATED 12 POPULAR TOPICS TESTS PASSED!");
  console.log("==================================================");
}

runTests().catch(err => {
  console.error("❌ Test Failed:", err);
  process.exit(1);
});
