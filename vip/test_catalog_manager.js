const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { CatalogManager } = require('./catalog_manager');

console.log('============================================================');
console.log('🔍 Testing VIP 40-Video Catalog & 8x5 Pagination Manager');
console.log('============================================================');

const testDbPath = path.resolve(__dirname, 'test_catalogs.json');
if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

const catalogManager = new CatalogManager(testDbPath);

// Test 1: Add 40 simulated videos to KR channel
console.log('\n[Test 1] Adding 40 simulated videos to "KR" channel...');
for (let i = 1; i <= 45; i++) {
  catalogManager.addVideo('KR', {
    messageId: i,
    title: `FC2PPV-TEST-VIDEO-TITLE-#${i}`,
    link: `https://t.me/c/4435999618/${i}`
  });
}

// Check capping at 40
const krList = catalogManager.catalogs['KR'];
assert.strictEqual(krList.length, 40, 'Should cap at exactly 40 items');
assert.strictEqual(krList[0].messageId, 45, 'Newest item should be at the top (FIFO)');
console.log('  ✅ Successfully capped at 40 newest items');

// Test 2: Page 1 (8 items)
console.log('\n[Test 2] Verifying Page 1 (8 items per page)...');
const page1 = catalogManager.getPage('KR', 1);
assert.strictEqual(page1.currentPage, 1);
assert.strictEqual(page1.totalPages, 5, '40 items / 8 per page = 5 pages total');
assert.strictEqual(page1.items.length, 8, 'Page 1 must contain exactly 8 items');
assert.strictEqual(page1.hasPrev, false, 'Page 1 has no previous button');
assert.strictEqual(page1.hasNext, true, 'Page 1 has next button');
console.log(`  ✅ Page 1: ${page1.items.length} items, Total Pages: ${page1.totalPages}`);

// Test 3: HTML formatting with blue hyperlinks
console.log('\n[Test 3] Verifying HTML Blue Clickable Hyperlink Formatting...');
const channelConfig = {
  name: 'VIP-KR',
  buttonLabel: '🇰🇷 KR (로맨틱한 분위기 💥)',
  emoji: '📺'
};
const formattedText = catalogManager.formatCatalogText(channelConfig, page1);
assert(formattedText.includes('📺 <b>VIP-KR</b>'), 'Should contain header');
assert(formattedText.includes('이 채널의 최신 동영상 목록입니다.'), 'Should contain subheader');
assert(formattedText.includes('1. <a href="https://t.me/c/4435999618/45">FC2PPV-TEST-VIDEO-TITLE-#45</a>'), 'Item 1 should be a clickable link');
assert(formattedText.includes('8. <a href="https://t.me/c/4435999618/38">FC2PPV-TEST-VIDEO-TITLE-#38</a>'), 'Item 8 should be a clickable link');
assert(formattedText.includes('<b>페이지 1/5</b>'), 'Should contain page footer 1/5');

console.log('  ✅ Rendered Card Preview:\n');
console.log(formattedText.split('\n').map(l => '     ' + l).join('\n'));

// Test 4: Pagination Keyboard
console.log('\n[Test 4] Verifying Pagination Navigation Keyboard...');
const kbdPage1 = catalogManager.buildPaginationKeyboard('KR', page1);
assert.strictEqual(kbdPage1.inline_keyboard[0][0].text, '다음 ➡️');
assert.strictEqual(kbdPage1.inline_keyboard[0][0].callback_data, 'cat_pg:KR:2');
console.log('  ✅ Page 1 Keyboard: [ ' + kbdPage1.inline_keyboard[0][0].text + ' ]');

const page3 = catalogManager.getPage('KR', 3);
const kbdPage3 = catalogManager.buildPaginationKeyboard('KR', page3);
assert.strictEqual(kbdPage3.inline_keyboard[0][0].text, '⬅️ 이전');
assert.strictEqual(kbdPage3.inline_keyboard[0][1].text, '다음 ➡️');
console.log('  ✅ Page 3 Keyboard: [ ' + kbdPage3.inline_keyboard[0][0].text + ' ] [ ' + kbdPage3.inline_keyboard[0][1].text + ' ]');

const page5 = catalogManager.getPage('KR', 5);
const kbdPage5 = catalogManager.buildPaginationKeyboard('KR', page5);
assert.strictEqual(kbdPage5.inline_keyboard[0][0].text, '⬅️ 이전');
assert.strictEqual(kbdPage5.inline_keyboard[0].length, 1);
console.log('  ✅ Page 5 (Last) Keyboard: [ ' + kbdPage5.inline_keyboard[0][0].text + ' ]');

// Clean up
if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

console.log('\n============================================================');
console.log('🎉 ALL CATALOG TESTS PASSED! 8x5 PAGINATION READY');
console.log('============================================================\n');
