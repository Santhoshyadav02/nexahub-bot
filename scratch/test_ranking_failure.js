const rankingScraper = require('../ranking_scraper');
const fs = require('fs');

console.log("==================================================");
console.log("🧪 RUNNING RANKING FAILURE & LAST-KNOWN-GOOD TEST SUITE");
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
  console.log("--- 1. Pre-condition: Ensure valid ranking.json exists ---");
  const initialData = await rankingScraper.scrapeRealtimeRankings();
  assert(initialData !== null && initialData.rankings.length === 10, "Initial valid ranking.json created with 10 items");

  console.log("\n--- 2. Validation Function Test under Malformed Inputs ---");
  assert(rankingScraper.validateRankings(null) === false, "null input returns false");
  assert(rankingScraper.validateRankings([]) === false, "empty array returns false");
  assert(rankingScraper.validateRankings(new Array(5)) === false, "array with < 10 items returns false");

  const invalidItems = [
    { rank: 1, keyword: "[object Object]", url: "https://example.com" },
    { rank: 2, keyword: "Valid", url: "invalid-url" }
  ];
  assert(rankingScraper.validateRankings(invalidItems) === false, "array with invalid items returns false");

  console.log("\n--- 3. Simulate API Failure / Network Timeout Fallback ---");
  // Temporarily force invalid signal URL
  const https = require('https');
  const originalGet = https.get;
  https.get = (url, opts, cb) => {
    const EventEmitter = require('events');
    const req = new EventEmitter();
    req.destroy = () => {};
    setImmediate(() => req.emit('error', new Error("Simulated Network Timeout 500 Error")));
    return req;
  };

  const fallbackData = await rankingScraper.scrapeRealtimeRankings();

  // Restore https.get
  https.get = originalGet;

  assert(fallbackData !== null, "scrapeRealtimeRankings() safely returned fallback data on API error");
  assert(fallbackData.rankings.length === 10, "Fallback data contains 10 valid rankings");
  assert(fs.existsSync("ranking.json"), "ranking.json was NOT deleted or overwritten with invalid data");

  console.log("\n==================================================");
  console.log(`📊 RANKING FAILURE TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("==================================================");

  if (failed > 0) process.exit(1);
}

runTests();
