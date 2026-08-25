const indexModule = require("../index.js");
const rankingScraper = require("../ranking_scraper.js");

async function runTest() {
  console.log("==================================================");
  console.log("🧪 RUNNING CONTENT HUB UX OPTIMIZATION TEST SUITE");
  console.log("==================================================\n");

  let passed = 0;
  let failed = 0;

  function assert(condition, msg) {
    if (condition) {
      console.log(`✅ PASS: ${msg}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${msg}`);
      failed++;
    }
  }

  // Ensure rankings are populated for Home keyboard test
  await rankingScraper.scrapeRealtimeRankings();

  // 1. Home Screen (getTrendingKeyboard) Verification
  console.log("--- 1. Home Screen (getTrendingKeyboard) Verification ---");
  const homeKb = await indexModule.getTrendingKeyboard();
  const homeRows = homeKb.inline_keyboard;

  assert(homeRows[0][0].text.includes("실시간 검색어 상위 10"), "Home top row contains '실시간 검색어 상위 10'");

  // Check navigation buttons on Home
  const allHomeButtons = homeRows.flat();
  const popularBtn = allHomeButtons.find(b => b.text === "🔥 인기 콘텐츠" || (b.callback_data && b.callback_data === "screen:popular"));
  assert(!popularBtn, "Home screen does NOT have '🔥 인기 콘텐츠' button");

  const breakingBtn = allHomeButtons.find(b => b.text === "📰 속보");
  assert(!!breakingBtn && breakingBtn.callback_data === "screen:breaking", "Home has '📰 속보' button with callback 'screen:breaking'");

  const hubBtn = allHomeButtons.find(b => b.text === "📂 콘텐츠 허브");
  assert(!!hubBtn && hubBtn.callback_data === "screen:categories", "Home has '📂 콘텐츠 허브' button with callback 'screen:categories'");

  // Verify 20 cards ARE rendered directly on Home
  const topicCardsOnHome = allHomeButtons.filter(b => b.callback_data && b.callback_data.startsWith("topic:"));
  assert(topicCardsOnHome.length === 20, "Home screen renders all 20 HOT TOPICS cards directly (20 found)");

  // 2. Content Hub Screen (getCategoryHubKeyboard) Verification
  console.log("\n--- 2. Content Hub Screen (getCategoryHubKeyboard) Verification ---");
  const hubKb = await indexModule.getCategoryHubKeyboard();
  const hubRows = hubKb.inline_keyboard;
  const allHubButtons = hubRows.flat();

  assert(allHubButtons.some(b => b.callback_data === "cat:games"), "Content Hub contains 'cat:games'");
  assert(allHubButtons.some(b => b.callback_data === "cat:ai_tools"), "Content Hub contains 'cat:ai_tools'");
  assert(allHubButtons.some(b => b.callback_data === "cat:stories"), "Content Hub contains 'cat:stories'");
  assert(allHubButtons.some(b => b.callback_data === "cat:papers"), "Content Hub contains 'cat:papers'");
  assert(allHubButtons.some(b => b.callback_data === "cat:opening_up"), "Content Hub contains 'cat:opening_up'");
  assert(allHubButtons.some(b => b.callback_data === "cat:food_source"), "Content Hub contains 'cat:food_source'");
  assert(allHubButtons.some(b => b.callback_data === "cat:finance"), "Content Hub contains 'cat:finance'");
  assert(allHubButtons.some(b => b.callback_data === "cat:adult"), "Content Hub contains 'cat:adult'");

  // Verify Back & Home navigation buttons
  const backBtn = allHubButtons.find(b => b.text === "🔙 뒤로");
  assert(!!backBtn && backBtn.callback_data === "menu", "Content Hub contains '🔙 뒤로' button");

  const homeBackBtn = allHubButtons.find(b => b.text === "🏠 홈으로 돌아가기");
  assert(!!homeBackBtn && homeBackBtn.callback_data === "menu", "Content Hub contains '🏠 홈으로 돌아가기' button");

  // 3. Subsystem Locks Verification
  console.log("\n--- 3. Subsystem Locks Verification ---");
  const mainKb = await indexModule.getMainKeyboard();
  const mainCards = mainKb.inline_keyboard.flat();
  assert(mainCards.length === 20, "getMainKeyboard() retains 20 HOT TOPICS cards");

  console.log("\n==================================================");
  console.log(`📊 CONTENT HUB UX TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("==================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runTest().catch(err => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
