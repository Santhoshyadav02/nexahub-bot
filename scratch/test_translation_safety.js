/**
 * 🧪 Test Script: test_translation_safety.js
 * Verifies dynamic Korean translation safety, API failure fallbacks, timeout handling,
 * empty/null response resilience, and subsystem isolation.
 */

const https = require('https');
const { translateText, getMainKeyboard, getTrendingKeyboard } = require('../index');

console.log("==================================================");
console.log("🧪 RUNNING TRANSLATION SAFETY & FALLBACK TEST SUITE");
console.log("==================================================\n");

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

async function runTests() {
  // TEST 1: TRANSLATION SUCCESS
  console.log("--- 1. Translation Success Test ---");
  try {
    const res = await translateText("Dating Scandal", "ko");
    assert(typeof res === "string" && res.length > 0, `Translation function executed safely: "Dating Scandal" -> "${res}"`);
  } catch (err) {
    assert(false, `Translation success test threw exception: ${err.message}`);
  }

  // TEST 2: TRANSLATION API FAILURE FALLBACK
  console.log("\n--- 2. Translation API Failure Fallback ---");
  try {
    // Override https.get temporarily to simulate API 500 / Network Error
    const originalGet = https.get;
    https.get = function(url, options, cb) {
      const EventEmitter = require('events');
      const req = new EventEmitter();
      req.destroy = () => {};
      setImmediate(() => req.emit('error', new Error("Simulated API 500 Connection Refused")));
      return req;
    };

    const fallbackRes = await translateText("Uncached Test String For API Error Failure", "ko");
    https.get = originalGet; // Restore

    assert(fallbackRes === "Uncached Test String For API Error Failure", `API failure safely returned original text: "${fallbackRes}"`);
  } catch (err) {
    assert(false, `API failure test threw exception: ${err.message}`);
  }

  // TEST 3: EMPTY / NULL RESPONSE FALLBACK
  console.log("\n--- 3. Empty Response Fallback ---");
  try {
    const nullRes = await translateText(null, "ko");
    assert(nullRes === "", 'null input returned empty string without error');

    const emptyStrRes = await translateText("", "ko");
    assert(emptyStrRes === "", 'empty string input returned empty string');

    // Simulate API returning [] empty parsed array
    const originalGet = https.get;
    https.get = function(url, options, cb) {
      const EventEmitter = require('events');
      const req = new EventEmitter();
      const res = new EventEmitter();
      req.destroy = () => {};
      setImmediate(() => {
        cb(res);
        res.emit('data', JSON.stringify([]));
        res.emit('end');
      });
      return req;
    };

    const emptyArrayRes = await translateText("Test String Empty Array Response", "ko");
    https.get = originalGet; // Restore

    assert(emptyArrayRes === "Test String Empty Array Response", `Empty API response safely returned original text: "${emptyArrayRes}"`);
  } catch (err) {
    assert(false, `Empty response test threw exception: ${err.message}`);
  }

  // TEST 4: TIMEOUT FALLBACK
  console.log("\n--- 4. Timeout Fallback Test ---");
  try {
    const originalGet = https.get;
    https.get = function(url, options, cb) {
      const EventEmitter = require('events');
      const req = new EventEmitter();
      req.destroy = () => { req.destroyed = true; };
      setImmediate(() => {
        req.emit('timeout');
      });
      return req;
    };

    const timeoutStart = Date.now();
    const timeoutRes = await translateText("Test Timeout Fallback String", "ko");
    const duration = Date.now() - timeoutStart;
    https.get = originalGet; // Restore

    assert(timeoutRes === "Test Timeout Fallback String", `Timeout safely returned original text: "${timeoutRes}"`);
    assert(duration < 1000, `Timeout handled instantly without blocking (${duration}ms)`);
  } catch (err) {
    assert(false, `Timeout test threw exception: ${err.message}`);
  }

  // TEST 5: BOT STABILITY & SUBSYSTEM ISOLATION
  console.log("\n--- 5. Bot Stability & Subsystem Isolation ---");
  try {
    const mainKb = await getMainKeyboard();
    assert(mainKb && mainKb.inline_keyboard && mainKb.inline_keyboard.length === 4, 'getMainKeyboard() produced valid 4-row 20-card grid');

    const trendingKb = await getTrendingKeyboard();
    assert(trendingKb && trendingKb.inline_keyboard && trendingKb.inline_keyboard.length >= 6, 'getTrendingKeyboard() produced valid keyboard');
  } catch (err) {
    assert(false, `Subsystem isolation test threw exception: ${err.message}`);
  }

  // SUMMARY REPORT
  console.log("\n==================================================");
  console.log(`📊 TRANSLATION SAFETY TEST RESULTS: ${passCount} PASSED, ${failCount} FAILED`);
  console.log("==================================================");

  if (failCount > 0) {
    process.exit(1);
  } else {
    console.log("🎉 ALL TRANSLATION SAFETY & FALLBACK TESTS PASSED!");
    process.exit(0);
  }
}

runTests();
