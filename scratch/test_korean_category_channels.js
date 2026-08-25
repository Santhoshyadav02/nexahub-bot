/**
 * 🧪 Test Script: test_korean_category_channels.js
 * Verifies category channel list integrity, URL & username format, duplicate checks,
 * category metadata, preservation of 20 HOT TOPICS cards, and 10 MTProto channel mappings.
 */

const fs = require('fs');
const path = require('path');
const { CATEGORIES, getMainKeyboard, getTrendingKeyboard } = require('../index');

console.log("==================================================");
console.log("🧪 RUNNING KOREAN CATEGORY CHANNELS VERIFICATION");
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
  const allUrls = new Set();
  const allUsernames = new Set();
  let totalChannels = 0;

  console.log("--- 1. Category Channels Integrity & Metadata ---");
  for (const [catKey, catData] of Object.entries(CATEGORIES)) {
    assert(catData && catData.title, `Category [${catKey}] has valid title: "${catData.title}"`);
    assert(Array.isArray(catData.items) && catData.items.length > 0, `Category [${catKey}] has non-empty items array (${catData.items.length} channels)`);

    for (const item of catData.items) {
      totalChannels++;
      // Name
      assert(typeof item.name === 'string' && item.name.length > 0, `Item has valid name: "${item.name}"`);
      // URL format
      assert(typeof item.url === 'string' && item.url.startsWith('https://t.me/'), `Item "${item.name}" has valid t.me URL: ${item.url}`);
      // Username format
      assert(typeof item.username === 'string' && item.username.startsWith('@'), `Item "${item.name}" has valid username format: ${item.username}`);
      // Metadata
      assert(item.category === catKey, `Item "${item.name}" metadata category matches key: ${item.category}`);
      assert(item.language === 'ko', `Item "${item.name}" language metadata is 'ko'`);

      // Duplicate checks
      assert(!allUrls.has(item.url), `No duplicate URL: ${item.url}`);
      allUrls.add(item.url);

      assert(!allUsernames.has(item.username), `No duplicate username: ${item.username}`);
      allUsernames.add(item.username);
    }
  }

  console.log(`\nTotal category channels verified across all categories: ${totalChannels}`);

  // 2. PRESERVATION OF 20 HOT TOPICS CARDS & 10 MTPROTO CHANNELS
  console.log("\n--- 2. Preservation of 20 HOT TOPICS & 10 MTProto Channels ---");
  const mainKb = await getMainKeyboard();
  assert(mainKb && mainKb.inline_keyboard && mainKb.inline_keyboard.length === 4, 'getMainKeyboard() produces 4 rows');
  let cardCount = 0;
  const topicCallbacks = new Set();
  mainKb.inline_keyboard.forEach(row => {
    row.forEach(btn => {
      cardCount++;
      if (btn.callback_data) topicCallbacks.add(btn.callback_data);
    });
  });
  assert(cardCount === 20, '20 HOT TOPICS cards strictly preserved');

  const targetChannels = [
    "Romantic Vibe", "Dating", "Romance", "Crotch", "Mosa",
    "Bunny Girl Cosplay Date", "Lustful Hostess", "Concubine", "Saki Mizumi", "A Muse"
  ];
  targetChannels.forEach(ch => {
    assert(topicCallbacks.has(`topic:${ch}`), `10 MTProto channel callback "topic:${ch}" preserved`);
  });

  // SUMMARY
  console.log("\n==================================================");
  console.log(`📊 CATEGORY VERIFICATION RESULTS: ${passCount} PASSED, ${failCount} FAILED`);
  console.log("==================================================");

  if (failCount > 0) {
    process.exit(1);
  } else {
    console.log("🎉 ALL CATEGORY CHANNEL VERIFICATION CHECKS PASSED!");
    process.exit(0);
  }
}

runTests();
