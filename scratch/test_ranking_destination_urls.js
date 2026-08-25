const rankingScraper = require('../ranking_scraper');
const index = require('../index');

console.log("==================================================");
console.log("🧪 RUNNING STRICT PUBLISHER ARTICLE DESTINATION URL TEST SUITE");
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
  console.log("--- 1. Scrape & Validate Strict Publisher Article URLs ---");
  const data = await rankingScraper.scrapeRealtimeRankings();
  assert(data !== null, "Scrape returned valid data object");
  assert(Array.isArray(data.rankings) && data.rankings.length === 10, "Contains exactly 10 ranking items");

  data.rankings.forEach((item, idx) => {
    assert(item.rank === idx + 1, `Rank ${idx + 1} has correct rank index ${idx + 1}`);
    assert(typeof item.keyword === "string" && item.keyword.trim().length > 0, `Rank ${idx + 1} has valid non-empty keyword ("${item.keyword}")`);
    assert(typeof item.url === "string" && item.url.startsWith("http"), `Rank ${idx + 1} has valid HTTP destination URL`);
    
    // Strict Rejections
    assert(!item.url.includes("search.naver.com"), `Rank ${idx + 1} URL is NOT Naver search URL`);
    assert(!item.url.includes("news.google.com/rss/articles"), `Rank ${idx + 1} URL is NOT Google News RSS redirect URL ("${item.url.substring(0, 60)}...")`);
    assert(!item.url.includes("google.com/search"), `Rank ${idx + 1} URL is NOT Google search URL`);
    assert(!item.url.includes("translate.google.com"), `Rank ${idx + 1} URL is NOT Google Translate URL`);
    assert(!item.keyword.includes("[object Object]") && !item.url.includes("[object Object]"), `Rank ${idx + 1} has zero [object Object] string`);
    
    const isPublisherUrl = item.url.includes("n.news.naver.com") || item.url.includes("v.daum.net") || (!item.url.includes("google.com") && !item.url.includes("search.naver.com"));
    assert(isPublisherUrl, `Rank ${idx + 1} is verified direct publisher article page (${item.url})`);
  });

  console.log("\n--- 2. Verify Cards 1–20 Regression Lock ---");
  const mainKb = await index.getMainKeyboard();
  const cardButtons = mainKb.inline_keyboard.flat();
  assert(mainKb.inline_keyboard.length === 4, "Cards 1–20 grid has 4 rows");
  assert(cardButtons.length === 20, "Cards 1–20 grid has 20 buttons");
  cardButtons.forEach((btn, idx) => {
    assert(btn.callback_data.startsWith("topic:"), `Card ${idx + 1} callback_data locked ("${btn.callback_data}")`);
    assert(/[가-힯]/.test(btn.text), `Card ${idx + 1} has Korean label ("${btn.text}")`);
  });

  console.log("\n==================================================");
  console.log(`📊 STRICT PUBLISHER URL TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("==================================================");

  if (failed > 0) process.exit(1);
}

runTests();
