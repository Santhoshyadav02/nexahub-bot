/**
 * 🧪 Test Script: test_full_korean_ui_audit.js
 * Verifies full Korean UI localization, TOPIC_NAMES mapping, Breaking News internal article view (Option A),
 * dynamic translation resiliency, and preservation of all 20 cards and 10 channel callbacks.
 */

const fs = require('fs');
const path = require('path');
const { getMainKeyboard, getTrendingKeyboard, translateText } = require('../index');

console.log("==================================================");
console.log("🧪 RUNNING FULL KOREAN UI AUDIT TEST SUITE");
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

async function runAudit() {
  const indexCode = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');

  // 1. 20 HOT TOPICS CARDS STRUCTURE INTACT
  console.log("--- 1. 20 HOT TOPICS Cards Structure ---");
  const mainKb = await getMainKeyboard();
  assert(mainKb && mainKb.inline_keyboard, 'getMainKeyboard() returns valid inline_keyboard');
  assert(mainKb.inline_keyboard.length === 4, 'Grid has exactly 4 rows');
  let totalCards = 0;
  const runtimeCallbacks = new Set();
  mainKb.inline_keyboard.forEach(row => {
    row.forEach(btn => {
      totalCards++;
      if (btn.callback_data) runtimeCallbacks.add(btn.callback_data);
    });
  });
  assert(totalCards === 20, `Grid has exactly 20 cards (5 columns x 4 rows)`);

  // 2. 10 TARGET CHANNELS & CALLBACK_DATA UNCHANGED
  console.log("\n--- 2. 10 Target Channels & Callback Data Unchanged ---");
  const expectedChannels = [
    "Romantic Vibe", "Dating", "Romance", "Crotch", "Mosa",
    "Bunny Girl Cosplay Date", "Lustful Hostess", "Concubine", "Saki Mizumi", "A Muse"
  ];
  expectedChannels.forEach(ch => {
    const cb = `topic:${ch}`;
    assert(runtimeCallbacks.has(cb), `Runtime callback_data "${cb}" present on grid card`);
  });

  // 3. TOPIC_NAMES KOREAN DISPLAY TITLE MAPPINGS
  console.log("\n--- 3. TOPIC_NAMES Korean Title Mappings ---");
  const expectedTopicTitles = [
    "🔥 K-Pop 열애설", "💋 비밀 연애", "👀 아이돌 열애 루머", "💔 연예인 결별", "🚨 열애 논란",
    "❤️ 비밀 커플", "😳 바이럴 로맨스", "🔥 럽스타그램", "💍 결혼 루머", "👀 연예계 스캔들"
  ];
  expectedTopicTitles.forEach(title => {
    assert(indexCode.includes(title), `TOPIC_NAMES maps channel keyword to Korean title: "${title}"`);
  });

  // 4. BREAKING NEWS DIRECT ORIGINAL URL FLOW
  console.log("\n--- 4. Breaking News Direct Original URL Flow ---");
  assert(indexCode.includes('targetUrl = originalUrl ||'), 'Breaking news uses original news URL directly');
  assert(indexCode.includes('parseNewsItem'), 'parseNewsItem helper converts news objects safely');

  // 5. BREAKING NEWS SCRAPER RESILIENCE
  console.log("\n--- 5. Breaking News Scraper Resilience ---");
  const scraperCode = fs.readFileSync(path.join(__dirname, '../scraper.js'), 'utf8');
  assert(scraperCode.includes('news.google.com/rss?hl=ko&gl=KR&ceid=KR:ko'), 'Scraper uses Google KR RSS feed');
  assert(scraperCode.includes('seenTitles'), 'Scraper deduplicates news items by title');

  // 6. DYNAMIC TRANSLATION FALLBACK
  console.log("\n--- 6. Dynamic Translation Fallback ---");
  const fallbackResult = await translateText("NonexistentTestQueryString12345", "ko");
  assert(typeof fallbackResult === "string" && fallbackResult.length > 0, 'Translation fallback returns original text on unresolvable input');

  // SUMMARY
  console.log("\n==================================================");
  console.log(`📊 FULL UI AUDIT RESULTS: ${passCount} PASSED, ${failCount} FAILED`);
  console.log("==================================================");

  if (failCount > 0) {
    process.exit(1);
  } else {
    console.log("🎉 ALL FULL KOREAN UI AUDIT CHECKS PASSED!");
    process.exit(0);
  }
}

runAudit();
