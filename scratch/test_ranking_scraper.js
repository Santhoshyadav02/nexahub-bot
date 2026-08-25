const rankingScraper = require('../ranking_scraper');
const fs = require('fs');

console.log("==================================================");
console.log("🧪 RUNNING RANKING SCRAPER TEST SUITE");
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
  console.log("--- 1. Ranking Source Fetching & JSON Creation ---");
  const result = await rankingScraper.scrapeRealtimeRankings();
  assert(result !== null, "scrapeRealtimeRankings() returned a valid result object");
  assert(Array.isArray(result.rankings), "result.rankings is an array");
  assert(result.rankings.length === 10, `result.rankings contains exactly 10 items (found ${result.rankings.length})`);

  console.log("\n--- 2. Ranking Item Structure & Fields Validation ---");
  result.rankings.forEach((item, idx) => {
    assert(item.rank === idx + 1, `Item ${idx + 1} has rank === ${idx + 1}`);
    assert(typeof item.keyword === "string" && item.keyword.trim().length > 0, `Item ${idx + 1} keyword is non-empty string ("${item.keyword}")`);
    assert(typeof item.url === "string" && item.url.startsWith("http"), `Item ${idx + 1} url is valid HTTP URL`);
    assert(!item.keyword.includes("[object Object]"), `Item ${idx + 1} keyword does not contain [object Object]`);
    assert(!item.url.includes("[object Object]"), `Item ${idx + 1} url does not contain [object Object]`);
  });

  console.log("\n--- 3. Persistent ranking.json Verification ---");
  assert(fs.existsSync("ranking.json"), "ranking.json file exists on disk");
  const localData = rankingScraper.getLocalRankings();
  assert(localData !== null, "getLocalRankings() successfully reads local ranking.json");
  assert(localData.rankings.length === 10, "getLocalRankings() returns 10 valid rankings");

  console.log("\n==================================================");
  console.log(`📊 RANKING SCRAPER TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("==================================================");

  if (failed > 0) process.exit(1);
}

runTests();
