const index = require('../index');
const rankingScraper = require('../ranking_scraper');

console.log("==================================================");
console.log("🧪 RUNNING UX SEPARATE POPULAR & BREAKING SCREENS TEST SUITE");
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

  console.log("--- 1. Home Screen (getTrendingKeyboard) UX Structure ---");
  const trendingKb = await index.getTrendingKeyboard();
  const homeRows = trendingKb.inline_keyboard;

  // Top 10 Ranking section on Home
  assert(homeRows[0] && homeRows[0][0].text.includes("실시간 검색어 TOP 10"), "Home top row contains '실시간 검색어 TOP 10'");
  assert(homeRows[11] && homeRows[11][0].text === "🔄 순위 새로고침", "Row 12 is '🔄 순위 새로고침'");

  // Navigation Buttons on Home
  const homeButtonsFlat = homeRows.flat();
  const popularBtn = homeButtonsFlat.find(b => b.text === "🔥 인기 콘텐츠" || (b.callback_data && b.callback_data === "screen:popular"));
  assert(!popularBtn, "Home screen does NOT contain '🔥 인기 콘텐츠' button");

  assert(homeRows[17] && homeRows[17][0].text === "📰 속보", "Row 18 contains '📰 속보' navigation button");
  assert(homeRows[17] && homeRows[17][1].text === "📂 콘텐츠 허브", "Row 18 contains '📂 콘텐츠 허브' navigation button");
  assert(homeRows[17][1].callback_data === "screen:categories", "'📂 콘텐츠 허브' callback_data is 'screen:categories'");

  // Verify 20 cards ARE rendered directly on Home screen
  const topicCardsOnHome = homeButtonsFlat.filter(b => b.callback_data && b.callback_data.startsWith("topic:"));
  assert(topicCardsOnHome.length === 20, "Home screen renders all 20 HOT TOPICS cards directly (20 found)");

  // Verify Breaking News list and category buttons are NOT rendered on Home directly
  const newsArticleButtonsOnHome = homeButtonsFlat.filter(b => b.text && b.text.startsWith("📰 ") && b.url);
  assert(newsArticleButtonsOnHome.length === 0, "Home screen does NOT render breaking news list directly (0 found)");

  const catButtonsOnHome = homeButtonsFlat.filter(b => b.callback_data && b.callback_data.startsWith("cat:"));
  assert(catButtonsOnHome.length === 0, "Home screen does NOT render category buttons directly (0 found)");

  console.log("\n--- 2. Direct 20 HOT TOPICS Cards Verification on Home ---");
  const expectedChannels = ["Romantic Vibe", "Dating", "Romance", "Crotch", "Mosa", "Bunny Girl Cosplay Date", "Lustful Hostess", "Concubine", "Saki Mizumi", "A Muse"];
  for (let i = 0; i < 10; i++) {
    const ch = expectedChannels[i];
    assert(topicCardsOnHome[i].callback_data === `topic:${ch}`, `Card ${i + 1} callback_data locked ("topic:${ch}")`);
    assert(topicCardsOnHome[i + 10].callback_data === `topic:${ch}`, `Card ${i + 11} callback_data locked ("topic:${ch}")`);
  }


  console.log("\n--- 3. Dedicated Breaking News Screen (getBreakingNewsKeyboard) ---");
  const breakingKb = await index.getBreakingNewsKeyboard();
  const breakingRows = breakingKb.inline_keyboard;

  assert(breakingRows.length >= 2, "Breaking News screen has news items + action rows");
  const breakingNewsButtons = breakingRows.slice(0, breakingRows.length - 2).flat();

  breakingNewsButtons.forEach((btn, idx) => {
    assert(btn.text.startsWith("📰 "), `News item ${idx + 1} starts with '📰 '`);
    assert(typeof btn.url === "string" && btn.url.startsWith("http"), `News item ${idx + 1} is direct browser URL button`);
    assert(!btn.url.includes("translate.google.com"), `News item ${idx + 1} does NOT use Google Translate`);
  });

  const bottomRefresh = breakingRows[breakingRows.length - 2][0];
  const bottomHome = breakingRows[breakingRows.length - 1][0];

  assert(bottomRefresh.text === "🔄 새로고침" && bottomRefresh.callback_data === "screen:breaking", "Breaking screen has '🔄 새로고침' button");
  assert(bottomHome.text === "🏠 홈으로 돌아가기" && bottomHome.callback_data === "menu", "Breaking screen has '🏠 홈으로 돌아가기' button");


  console.log("\n--- 4. Persistent Navigation Keyboard Verification ---");
  const persistentKb = index.getPersistentNavigationKeyboard();
  const navButtons = persistentKb.keyboard.flat();
  assert(navButtons.some(b => b.text === "🏠 홈"), "Persistent keyboard includes '🏠 홈'");
  assert(navButtons.some(b => b.text === "ℹ️ 정보"), "Persistent keyboard includes 'ℹ️ 정보'");
  assert(navButtons.some(b => b.text === "🗑️ 기록"), "Persistent keyboard includes '🗑️ 기록'");


  console.log("\n==================================================");
  console.log(`📊 UX SEPARATE SCREENS TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("==================================================");

  if (failed > 0) process.exit(1);
}

runTests();
