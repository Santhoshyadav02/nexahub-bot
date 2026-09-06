const assert = require("assert");
const fs = require("fs");
const path = require("path");

const indexApp = require("./index");
const contentHubScraper = require("./content_hub_scraper");

console.log("============================================================");
console.log("🧪 RUNNING CONTENT HUB NAVIGATION & SUB-ITEM AUDIT TEST SUITE");
console.log("============================================================\n");

let passedCount = 0;

// Test 1: Category -> Site list (Level 1 & Level 2)
console.log("📌 Test 1: Verifying Level 1 & Level 2 Compact Category Navigation...");
const categories = indexApp.getContentHubCategories();
assert.strictEqual(categories.length, 8, "Must contain exactly 8 categories");
const adultCat = indexApp.getContentHubCategoryById("adult_broadcast");
assert(adultCat, "adult_broadcast category must exist");
assert.strictEqual(adultCat.title, "성인방송", "Category title must be localized Korean '성인방송'");

const keyboardL2 = indexApp.getContentHubCategoryKeyboard("adult_broadcast", 1);
assert(keyboardL2.inline_keyboard.length >= 8, "Level 2 keyboard must have site buttons");
// Verify clean format e.g. "🔞 팬더티비" (no numbering)
const firstBtnText = keyboardL2.inline_keyboard[0][0].text;
assert(!/^\d+[\.\s]/.test(firstBtnText), `Button text must NOT have numeric prefix, actual: ${firstBtnText}`);
assert(firstBtnText.includes("팬더티비"), `Button text must include site name, actual: ${firstBtnText}`);
console.log(`   ✅ Level 2 clean list verified: "${firstBtnText}"`);
passedCount++;

// Test 2: Site -> Detail (Level 3 with sub-items e.g. Panda TV)
console.log("\n📌 Test 2: Verifying Level 3 Sub-Item List Detail View (Panda TV)...");
const pandaItem = indexApp.getContentHubItemById("adult_broadcast", "pandalive");
assert(pandaItem, "Panda TV item must exist in adult_broadcast");
assert(Array.isArray(pandaItem.sub_items) && pandaItem.sub_items.length >= 1, "Panda TV must have verified sub-items");

const detailText = indexApp.getContentHubItemDetailText("adult_broadcast", "pandalive");
assert(detailText.includes("팬더티비"), "Detail text must include site name");
assert(detailText.includes("성인방송"), "Detail text must include category");
assert(detailText.includes("주요 항목:"), "Detail text must include '주요 항목:' section header");
assert(detailText.includes("라이브 방송"), "Detail text must list '라이브 방송' sub-item");

const detailKeyboard = indexApp.getContentHubItemDetailKeyboard("adult_broadcast", "pandalive", 1);
const urlButtons = detailKeyboard.inline_keyboard.filter(row => row[0].url);
assert.strictEqual(urlButtons[0][0].text, "🔗 사이트 바로가기 ↗", "First URL button must be '🔗 사이트 바로가기 ↗'");
assert.strictEqual(urlButtons[0][0].url, pandaItem.url, "First URL button must open verified main URL");

const liveBtn = urlButtons.find(r => r[0].text.includes("라이브 방송"));
assert(liveBtn, "Must have '🔗 라이브 방송 ↗' button");
assert.strictEqual(liveBtn[0].url, "https://www.pandalive.co.kr/live", "Sub-item button must link directly to live URL");
console.log(`   ✅ Level 3 sub-item detail view verified with ${urlButtons.length} direct outbound URL buttons.`);
passedCount++;

// Test 3: Missing sub-item data fallback
console.log("\n📌 Test 3: Verifying Missing Sub-Item Data Fallback (e.g. Camsoda)...");
const camsodaItem = indexApp.getContentHubItemById("adult_broadcast", "camsoda");
assert(camsodaItem, "Camsoda item must exist");
const camsodaDetailText = indexApp.getContentHubItemDetailText("adult_broadcast", "camsoda");
assert(camsodaDetailText.includes("원본 사이트에서 콘텐츠를 확인할 수 있습니다."), "Single-link item must show clean fallback message");
const camsodaKeyboard = indexApp.getContentHubItemDetailKeyboard("adult_broadcast", "camsoda", 1);
const camsodaUrlButtons = camsodaKeyboard.inline_keyboard.filter(row => row[0].url);
assert.strictEqual(camsodaUrlButtons.length, 1, "Single-link item must have exactly 1 direct URL button");
assert.strictEqual(camsodaUrlButtons[0][0].text, "🔗 사이트 바로가기 ↗");
console.log("   ✅ Clean single-link fallback verified without inventing fake sub-items.");
passedCount++;

// Test 4: Pagination & Back navigation
console.log("\n📌 Test 4: Verifying Pagination & Context-Preserving Back Navigation...");
const keyboardL2Page2 = indexApp.getContentHubCategoryKeyboard("adult_broadcast", 2);
const navRow = keyboardL2Page2.inline_keyboard.find(row => row.some(b => b.text.includes("[ 2 / 2 ]")));
assert(navRow, "Level 2 page 2 must show pagination row [ 2 / 2 ]");

// Check detail back button from page 2
const detailFromP2 = indexApp.getContentHubItemDetailKeyboard("adult_broadcast", "pandalive", 2);
const backRow = detailFromP2.inline_keyboard.find(row => row.some(b => b.text === "◀️ 목록으로"));
assert(backRow, "Detail view must have '◀️ 목록으로' button");
const backBtn = backRow.find(b => b.text === "◀️ 목록으로");
assert.strictEqual(backBtn.callback_data, "ch_page:adult_broadcast:2", "Back button must preserve page 2 context");

const catBtn = backRow.find(b => b.text === "📂 전체 카테고리");
assert(catBtn, "Detail view must have '📂 전체 카테고리' button");
assert.strictEqual(catBtn.callback_data, "ch_hub", "Category button callback must be 'ch_hub'");
console.log("   ✅ Pagination and context-preserving back navigation verified.");
passedCount++;

// Test 5: URL Validation across all categories and sub-items
console.log("\n📌 Test 5: Auditing all stored external URLs for strict validity...");
let totalAuditedUrls = 0;
for (const cat of categories) {
  for (const it of cat.items) {
    assert(contentHubScraper.isValidUrl(it.url), `Item URL must be valid: ${it.url}`);
    assert(!it.url.includes("javascript:"), `Item URL must not have javascript: ${it.url}`);
    totalAuditedUrls++;

    if (Array.isArray(it.sub_items)) {
      for (const sub of it.sub_items) {
        assert(contentHubScraper.isValidUrl(sub.url), `Sub-item URL must be valid: ${sub.url}`);
        assert(!sub.url.includes("javascript:"), `Sub-item URL must not have javascript: ${sub.url}`);
        totalAuditedUrls++;
      }
    }
  }
}
console.log(`   ✅ All ${totalAuditedUrls} external URLs audited: 100% valid HTTP/HTTPS URLs.`);
passedCount++;

// Test 6: Isolation and regression verification
console.log("\n📌 Test 6: Verifying isolation & production ledger protection...");
const ledgerPath = path.join(__dirname, "published_ledger.json");
const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
const succCount = (ledger.records || []).filter(r => r.status === "SUCCESS").length;
assert.strictEqual(ledger.records.length, 105, `published_ledger.json total records must remain 105 (actual: ${ledger.records.length})`);
assert.strictEqual(succCount, 88, `published_ledger.json SUCCESS count must remain 88 (actual: ${succCount})`);
assert.strictEqual(ledger.nextRoundRobinIndex, 1, `published_ledger.json nextRoundRobinIndex must remain 1 (actual: ${ledger.nextRoundRobinIndex})`);
console.log(`   ✅ published_ledger.json intact: TOTAL=${ledger.records.length}, SUCCESS=${succCount}, nextIndex=${ledger.nextRoundRobinIndex}`);
passedCount++;

console.log("\n============================================================");
console.log(`🎉 ALL ${passedCount} CONTENT HUB NAVIGATION AUDIT TESTS PASSED!`);
console.log("============================================================\n");
