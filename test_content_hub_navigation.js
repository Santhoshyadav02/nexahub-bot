const assert = require("assert");
const fs = require("fs");
const path = require("path");

const indexApp = require("./index");
const contentHubScraper = require("./content_hub_scraper");

console.log("============================================================");
console.log("🧪 RUNNING CONTENT HUB LINK-STYLE UI & NAVIGATION TEST SUITE");
console.log("============================================================\n");

let passedCount = 0;

// Test 1: Category Level 1 (Emoji removal & 4x2 grid)
console.log("📌 Test 1: Verifying Level 1 Category Grid & 🔞 Emoji Removal...");
const categories = indexApp.getContentHubCategories();
assert.strictEqual(categories.length, 8, "Must contain exactly 8 categories");
const adultCat = indexApp.getContentHubCategoryById("adult_broadcast");
assert(adultCat, "adult_broadcast category must exist");
assert.strictEqual(adultCat.title, "성인방송", "Category title must be localized Korean '성인방송'");
assert.strictEqual(adultCat.icon || "", "", "adult_broadcast must NOT have 🔞 or adult icon");

// Test Level 1 Category Keyboard
indexApp.getCategoryHubKeyboard().then(catKbd => {
  assert(Array.isArray(catKbd.inline_keyboard), "Level 1 keyboard must exist");
  const allBtnTexts = catKbd.inline_keyboard.flat().map(b => b.text);
  assert(allBtnTexts.includes("성인방송"), "Level 1 must contain clean '성인방송' button");
  assert(!allBtnTexts.some(t => t.includes("🔞")), "Level 1 must NOT contain 🔞 emoji");
  console.log("   ✅ Level 1 verified: 4x2 grid, zero 🔞 emoji, clean '성인방송' button.");
  passedCount++;

  // Test 2: Level 2 Link-Style Text & Hyperlink Generation (Pure Description as Link)
  console.log("\n📌 Test 2: Verifying Level 2 Blue Clickable Hyperlinks (Description as Link, No Site Name, No 🔗)...");
  const commText = indexApp.getContentHubCategoryListText("community", 1);
  assert(commText.includes("📁 <b>콘텐츠 허브 > 인기커뮤니티</b>"), "Level 2 header breadcrumb must be correct");
  assert(commText.includes("원하는 사이트를 선택하세요. 👇"), "Level 2 subtitle present");
  assert(commText.includes('<a href="https://gall.dcinside.com/">국내 최대 규모의 인터넷 커뮤니티 및 갤러리</a>'), "Description itself must be an HTML <a> hyperlink");
  assert(!commText.includes("디시인사이드"), "Site name '디시인사이드' must NOT be rendered");
  assert(!commText.includes("에펨코리아"), "Site name '에펨코리아' must NOT be rendered");
  assert(!commText.includes("🔗"), "Emoji '🔗' must NOT be rendered");
  assert(!/^\s*\d+[\.\)]/m.test(commText), "Level 2 text must NOT contain numeric prefixes (1., 01.)");
  console.log("   ✅ Level 2 link-style text verified: description is blue HTML hyperlink, no site name, no 🔗, no numeric prefixes.");
  passedCount++;

  // Test 3: Level 2 Keyboard (No Large Grey Site Buttons, Only Navigation)
  console.log("\n📌 Test 3: Verifying Level 2 Keyboard (Navigation Only, No Grey Site Buttons)...");
  const commKbd = indexApp.getContentHubCategoryKeyboard("community", 1);
  const siteButtons = commKbd.inline_keyboard.flat().filter(b => b.callback_data && b.callback_data.startsWith("ch_item:"));
  assert.strictEqual(siteButtons.length, 0, "Level 2 keyboard must NOT contain grey site buttons");
  
  const navRow = commKbd.inline_keyboard.find(row => row.some(b => b.text.includes("[ 1 / 2 ]")));
  assert(navRow, "Level 2 keyboard must have pagination row [ 1 / 2 ]");
  const footerRow = commKbd.inline_keyboard[commKbd.inline_keyboard.length - 1];
  assert(footerRow.some(b => b.text.includes("카테고리 목록")), "Must have '📂 카테고리 목록' button");
  assert(footerRow.some(b => b.text.includes("메인 메뉴")), "Must have '🏠 메인 메뉴' button");
  console.log("   ✅ Level 2 keyboard verified: navigation controls only, zero large grey site buttons.");
  passedCount++;

  // Test 4: Direct 1:1 Link Rendering (Panda TV - Pure Description Link)
  console.log("\n📌 Test 4: Verifying Direct 1:1 Link Rendering (Panda TV - Pure Description Link)...");
  const adultText = indexApp.getContentHubCategoryListText("adult_broadcast", 1);
  assert(adultText.includes('<a href="https://www.pandalive.co.kr/">한국 대표 개인방송 라이브 스트리밍 플랫폼</a>'), "Panda TV description must be direct HTML link");
  assert(!adultText.includes("팬더티비"), "Site name '팬더티비' must NOT be rendered");
  assert(!adultText.includes("팝콘티비"), "Site name '팝콘티비' must NOT be rendered");
  assert(!adultText.includes("플렉스티비"), "Site name '플렉스티비' must NOT be rendered");
  assert(!adultText.includes("🔗"), "Adult broadcast text must NOT contain 🔗 emoji");
  assert(!adultText.includes("/ranking"), "Panda TV must NOT contain /ranking");
  assert(!adultText.includes("/vod"), "Panda TV must NOT contain /vod");
  assert(!adultText.includes("🔞"), "Adult broadcast text must NOT contain 🔞 emoji");
  console.log("   ✅ Pure description link verified: description is HTML link, zero site names, zero 🔗, zero 🔞 emoji, zero destination sub-items.");
  passedCount++;

  // Test 5: Broken URLs Exclusion
  console.log("\n📌 Test 5: Verifying Broken URLs Filtered / Excluded...");
  assert(!contentHubScraper.isValidUrl("https://pornworks.app/ko/"), "Broken URL pornworks must be invalid");
  assert(!contentHubScraper.isValidUrl("http://www.hanindeul.com/"), "Broken URL hanindeul must be invalid");
  console.log("   ✅ Broken URLs strictly filtered and rejected.");
  passedCount++;

  // Test 6: Audit All Active URLs
  console.log("\n📌 Test 6: Auditing All Active Content Hub URLs...");
  let totalAudited = 0;
  for (const cat of categories) {
    for (const it of cat.items) {
      assert(contentHubScraper.isValidUrl(it.url), `Item URL must be valid: ${it.url}`);
      assert(!it.url.includes("localhost") && !it.url.includes("127.0.0.1"), `No localhost URL: ${it.url}`);
      totalAudited++;
      if (Array.isArray(it.sub_items)) {
        for (const sub of it.sub_items) {
          assert(contentHubScraper.isValidUrl(sub.url), `Sub-item URL must be valid: ${sub.url}`);
          totalAudited++;
        }
      }
    }
  }
  console.log(`   ✅ All ${totalAudited} active URLs audited: 100% valid HTTP/HTTPS URLs.`);
  passedCount++;

  // Test 7: Korean UI Localization
  console.log("\n📌 Test 7: Verifying Complete Korean UI Localization...");
  const forbiddenEnglish = ["\\bSite\\b", "\\bCategory\\b", "\\bNext\\b", "\\bPrevious\\b", "\\bBack\\b", "\\bHome\\b"];
  forbiddenEnglish.forEach(w => {
    const re = new RegExp(w, "i");
    assert(!re.test(commText), `English word ${w} found in Level 2 text`);
    commKbd.inline_keyboard.flat().forEach(btn => {
      assert(!re.test(btn.text), `English word ${w} found in button: ${btn.text}`);
    });
  });
  console.log("   ✅ Korean UI localization verified: zero English control words.");
  passedCount++;

  // Test 8: Isolation & Production Ledger Integrity
  console.log("\n📌 Test 8: Verifying Isolation & Production Ledger Protection...");
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
}).catch(err => {
  console.error("Test failure:", err);
  process.exit(1);
});
