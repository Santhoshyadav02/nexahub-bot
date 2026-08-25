const index = require('../index');
const rankingScraper = require('../ranking_scraper');

console.log("==================================================");
console.log("🧪 RUNNING RANKING UI & POSITIONING TEST SUITE");
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
  await rankingScraper.scrapeRealtimeRankings();
  const trendingKb = await index.getTrendingKeyboard();
  const rows = trendingKb.inline_keyboard;

  console.log("--- 1. UI Section Order & Header Verification ---");
  assert(rows[0] && rows[0][0].text.includes("실시간 검색어 TOP 10"), "First row is ranking header: '🔥 실시간 검색어 TOP 10 ⚡'");

  // Ranks 1 to 10 rows (rows 1 to 10)
  const rankEmojis = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
  for (let i = 0; i < 10; i++) {
    const rowBtn = rows[i + 1][0];
    assert(rowBtn.text.startsWith(rankEmojis[i]), `Row ${i + 2} starts with rank emoji '${rankEmojis[i]}'`);
    assert(typeof rowBtn.url === "string" && rowBtn.url.startsWith("http"), `Row ${i + 2} is an inline URL button to direct browser page`);
    assert(!rowBtn.url.includes("translate.google.com"), `Row ${i + 2} URL does NOT contain Google Translate wrapper`);
  }

  // Row 11: Refresh Rankings button
  assert(rows[11] && rows[11][0].text === "🔄 순위 새로고침", "Row 12 is '🔄 순위 새로고침' button");
  assert(rows[11][0].callback_data === "refresh_rankings", "'🔄 순위 새로고침' has callback_data: 'refresh_rankings'");

  // Row 12: HOT TOPICS Header
  assert(rows[12] && rows[12][0].text === "🔥 HOT TOPICS", "Row 13 is '🔥 HOT TOPICS' header button");

  // 20 HOT TOPICS Cards directly on Home Keyboard (Rows 13..16)
  const cardGridRows = rows.slice(13, 17);
  assert(cardGridRows.length === 4, "Cards 1–20 grid directly on Home has exactly 4 rows");
  const cardButtons = cardGridRows.flat();
  assert(cardButtons.length === 20, `Cards 1–20 grid directly on Home has exactly 20 buttons (found ${cardButtons.length})`);

  // Row 17: Side-by-Side Breaking News & Content Hub Navigation Row
  assert(rows[17] && rows[17][0].text === "📰 속보", "Row 18 contains '📰 속보' navigation button");
  assert(rows[17][0].callback_data === "screen:breaking", "'📰 속보' has callback_data: 'screen:breaking'");
  assert(rows[17] && rows[17][1].text === "📂 콘텐츠 허브", "Row 18 contains '📂 콘텐츠 허브' navigation button");
  assert(rows[17][1].callback_data === "screen:categories", "'📂 콘텐츠 허브' has callback_data: 'screen:categories'");

  console.log("\n==================================================");
  console.log(`📊 RANKING UI TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("==================================================");

  if (failed > 0) process.exit(1);
}

runTests();
