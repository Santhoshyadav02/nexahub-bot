/**
 * 🧪 Test Script: test_korean_localization.js
 * Verifies that all user-facing strings are cleanly localized into Korean
 * while 100% preserving UI layout, card mappings, callbacks, and navigation flow.
 */

const fs = require('fs');
const path = require('path');

console.log("==================================================");
console.log("🧪 RUNNING KOREAN LOCALIZATION VERIFICATION SUITE");
console.log("==================================================\n");

// Read index.js source code to inspect static strings and layout
const indexPath = path.join(__dirname, '../index.js');
const indexCode = fs.readFileSync(indexPath, 'utf8');

let passCount = 0;
let failCount = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`✅ PASS: ${message}`);
    passCount++;
  } else {
    console.error(`❌ FAIL: ${message}`);
    failCount++;
  }
}

// 1. CARDS 1-10 KOREAN LABELS VERIFICATION
console.log("--- 1. Cards 1–10 Korean Display Labels ---");
const expectedCard1to10 = [
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

expectedCard1to10.forEach((label, idx) => {
  assert(indexCode.includes(label), `Card ${idx + 1} contains exact Korean label: "${label}"`);
});

// 2. PERMANENT CATEGORY BUTTONS VERIFICATION
console.log("\n--- 2. Permanent Category Buttons ---");
const expectedCategories = [
  { key: "cat:games", text: "🎮 게임 플레이" },
  { key: "cat:ai_tools", text: "🤖 AI" },
  { key: "cat:stories", text: "📚 단편 소설" },
  { key: "cat:papers", text: "🔬 학술 논문" },
  { key: "cat:opening_up", text: "🔓 콘텐츠" },
  { key: "cat:food_source", text: "🍴 미식 레시피" },
  { key: "cat:finance", text: "💰 재테크 & 투자" },
  { key: "cat:adult", text: "🔞 성인 콘텐츠" }
];

expectedCategories.forEach(cat => {
  assert(indexCode.includes(cat.text) && indexCode.includes(cat.key), `Category [${cat.key}] has Korean label: "${cat.text}"`);
});

// 3. PERSISTENT KEYBOARD VERIFICATION
console.log("\n--- 3. Persistent Navigation Keyboard ---");
assert(indexCode.includes('text: "🏠 홈"'), 'Navigation keyboard includes "🏠 홈"');
assert(indexCode.includes('text: "ℹ️ 정보"'), 'Navigation keyboard includes "ℹ️ 정보"');
assert(indexCode.includes('text: "🗑️ 기록"'), 'Navigation keyboard includes "🗑️ 기록"');

// 4. REFRESH & BREAKING NEWS VERIFICATION
console.log("\n--- 4. Refresh & Breaking News ---");
assert(indexCode.includes('🔄 순위 새로고침') || indexCode.includes('🔄 새로고침'), 'Refresh button uses Korean label ("🔄 새로고침")');
assert(indexCode.includes('📰 속보'), 'Breaking news header uses "📰 속보"');

// 5. VIDEO DETAIL PAGE LABELS & BUTTONS VERIFICATION
console.log("\n--- 5. Video Detail Page Labels & Buttons ---");
assert(indexCode.includes('[ 동영상 미리보기 ]'), 'Detail page header uses "[ 동영상 미리보기 ]"');
assert(indexCode.includes('▶️  화면이나 버튼을 누르면 동영상을 시청할 수 있습니다'), 'Detail subtext in Korean');
assert(indexCode.includes('<b>채널:</b>'), 'Field label "<b>채널:</b>" present');
assert(indexCode.includes('<b>유형:</b>'), 'Field label "<b>유형:</b>" present');
assert(indexCode.includes('<b>재생 시간:</b>'), 'Field label "<b>재생 시간:</b>" present');
assert(indexCode.includes('<b>조회수:</b>'), 'Field label "<b>조회수:</b>" present');
assert(indexCode.includes('<b>설명:</b>'), 'Field label "<b>설명:</b>" present');
assert(indexCode.includes('🔗 그룹 가입'), 'Button "🔗 그룹 가입" present');
assert(indexCode.includes('◀️ 뒤로가기'), 'Button "◀️ 뒤로가기" present');
assert(indexCode.includes('🏠 홈'), 'Button "🏠 홈" present');

// 6. LIST VIEW & PAGINATION LABELS
console.log("\n--- 6. List View & Pagination Buttons ---");
assert(indexCode.includes('이 채널의 최신 동영상 목록입니다.'), 'List subtext in Korean');
assert(indexCode.includes('이 채널에 이용 가능한 게시물이 없습니다.'), 'Empty list message in Korean');
assert(indexCode.includes('페이지 ${currentPage}/${totalPages}'), 'Page indicator format');
assert(indexCode.includes('⬅️ 이전'), 'Pagination button "⬅️ 이전"');
assert(indexCode.includes('다음 ➡️'), 'Pagination button "다음 ➡️"');
assert(indexCode.includes('🏠 메인 메뉴로 돌아가기'), 'Back button "🏠 메인 메뉴로 돌아가기"');

// 7. ABOUT & HISTORY PAGES VERIFICATION
console.log("\n--- 7. About & History Pages ---");
assert(indexCode.includes('ℹ️ <b>NexaHub 정보</b>'), 'About page title in Korean');
assert(indexCode.includes('⚠️ <b>대화 기록을 삭제하시겠습니까?</b>'), 'History confirmation prompt in Korean');
assert(indexCode.includes('✅ 예, 삭제합니다'), 'History confirm button in Korean');
assert(indexCode.includes('❌ 취소'), 'History cancel button in Korean');
assert(indexCode.includes('✨ <b>새로운 세션이 시작되었습니다!</b>'), 'History clear success message');

// 8. TARGET CHANNELS & CALLBACK MAPPINGS UNTOUCHED VERIFICATION
console.log("\n--- 8. Target Channels & Callback Mappings Verification ---");
const targetChannels = [
  "Romantic Vibe",
  "Dating",
  "Romance",
  "Crotch",
  "Mosa",
  "Bunny Girl Cosplay Date",
  "Lustful Hostess",
  "Concubine",
  "Saki Mizumi",
  "A Muse"
];

targetChannels.forEach(ch => {
  assert(indexCode.includes(`"${ch}"`), `Target channel preserved: "${ch}"`);
});

assert(indexCode.includes("refresh_trending"), 'Callback "refresh_trending" preserved');
assert(indexCode.includes("confirm_clear_history"), 'Callback "confirm_clear_history" preserved');
assert(indexCode.includes("cancel_clear_history"), 'Callback "cancel_clear_history" preserved');

// SUMMARY REPORT
console.log("\n==================================================");
console.log(`📊 LOCALIZATION TEST RESULTS: ${passCount} PASSED, ${failCount} FAILED`);
console.log("==================================================");

if (failCount > 0) {
  process.exit(1);
} else {
  console.log("🎉 ALL KOREAN LOCALIZATION VERIFICATIONS PASSED SUCCESSFULLY!");
}
