const assert = require("assert");
const fs = require("fs");
const path = require("path");

console.log("============================================================");
console.log("🧪 RUNNING CONTENT HUB NAVIGATION & REGRESSION TEST SUITE");
console.log("============================================================\n");

// 1. Load Dataset
console.log("📌 Test A-D: Verifying content_hub_dataset.json structure...");
const datasetPath = path.join(__dirname, "content_hub_dataset.json");
assert(fs.existsSync(datasetPath), "content_hub_dataset.json MUST exist");

const dataset = JSON.parse(fs.readFileSync(datasetPath, "utf8"));
assert(dataset.version === "1.0.0", "Dataset version must be 1.0.0");
assert(Array.isArray(dataset.categories), "Categories must be an array");
assert.strictEqual(dataset.categories.length, 8, "Must have exactly 8 categories");

const expectedOrder = [
  { id: "adult_broadcast", title: "성인방송", icon: "🔞" },
  { id: "community", title: "인기커뮤니티", icon: "💬" },
  { id: "ai_tools", title: "AI 도구", icon: "🤖" },
  { id: "utilities", title: "유틸/도구", icon: "🛠️" },
  { id: "overseas_shopping", title: "해외직구", icon: "🛍️" },
  { id: "psychology", title: "심리", icon: "🧠" },
  { id: "dating", title: "미팅/연애", icon: "💘" },
  { id: "korean_diaspora", title: "한인교민", icon: "🌏" }
];

dataset.categories.forEach((cat, idx) => {
  const expected = expectedOrder[idx];
  assert.strictEqual(cat.id, expected.id, `Category #${idx + 1} id must be '${expected.id}'`);
  assert.strictEqual(cat.title, expected.title, `Category #${idx + 1} title must be '${expected.title}'`);
  assert.strictEqual(cat.icon, expected.icon, `Category #${idx + 1} icon must be '${expected.icon}'`);
  assert(Array.isArray(cat.items), `Category '${cat.id}' items must be an array`);
  assert.strictEqual(cat.items.length, 10, `Category '${cat.id}' must have exactly 10 items`);
});
console.log("   ✅ Dataset contains exactly 8 categories in correct order with 10 items each.");

// 2. Validate Item IDs and URLs
console.log("\n📌 Test E-G: Verifying item IDs, URL formats, and uniqueness...");
const allGlobalItemIds = new Set();
dataset.categories.forEach(cat => {
  const categoryUrls = new Set();
  cat.items.forEach((item, itemIdx) => {
    assert(item.id && typeof item.id === "string", `Item #${itemIdx + 1} in '${cat.id}' must have string id`);
    assert(item.name && typeof item.name === "string", `Item '${item.id}' must have name`);
    assert(item.url && (item.url.startsWith("https://") || item.url.startsWith("http://")), `Item '${item.id}' must have valid URL: ${item.url}`);
    assert(item.description && typeof item.description === "string", `Item '${item.id}' must have description`);
    
    // Check uniqueness within category
    assert(!categoryUrls.has(item.url), `Duplicate URL in category '${cat.id}': ${item.url}`);
    categoryUrls.add(item.url);

    // Global unique item ID
    const uniqueKey = `${cat.id}:${item.id}`;
    assert(!allGlobalItemIds.has(uniqueKey), `Duplicate item key '${uniqueKey}'`);
    allGlobalItemIds.add(uniqueKey);
  });
});
console.log("   ✅ All 80 items validated (valid URLs, unique IDs, complete descriptions).");

// 3. Load Bot Module
console.log("\n📌 Test H: Verifying Level 1 Category Hub Keyboard layout...");
const indexApp = require("./index");

(async () => {
  const hubKeyboard = await indexApp.getCategoryHubKeyboard();
  assert(hubKeyboard && Array.isArray(hubKeyboard.inline_keyboard), "getCategoryHubKeyboard must return inline_keyboard");

  // 4 rows x 2 cols + 1 row for main menu = 5 rows total
  assert.strictEqual(hubKeyboard.inline_keyboard.length, 5, "Category Hub keyboard must have exactly 5 rows (4x2 grid + menu)");

  // Check 4 rows of category pairs
  const pairs = [
    ["ch_cat:adult_broadcast", "ch_cat:community"],
    ["ch_cat:ai_tools", "ch_cat:utilities"],
    ["ch_cat:overseas_shopping", "ch_cat:psychology"],
    ["ch_cat:dating", "ch_cat:korean_diaspora"]
  ];

  pairs.forEach((pair, rIdx) => {
    const row = hubKeyboard.inline_keyboard[rIdx];
    assert.strictEqual(row.length, 2, `Row ${rIdx + 1} must contain exactly 2 buttons`);
    assert.strictEqual(row[0].callback_data, pair[0], `Button [${rIdx}][0] callback_data must be ${pair[0]}`);
    assert.strictEqual(row[1].callback_data, pair[1], `Button [${rIdx}][1] callback_data must be ${pair[1]}`);
  });

  // Check Row 5 (Main Menu)
  const lastRow = hubKeyboard.inline_keyboard[4];
  assert.strictEqual(lastRow.length, 1, "Last row must contain 1 button");
  assert.strictEqual(lastRow[0].text, "🏠 메인 메뉴", "Last button text must be '🏠 메인 메뉴'");
  assert.strictEqual(lastRow[0].callback_data, "menu", "Last button callback_data must be 'menu'");

  console.log("   ✅ Level 1 Category Hub keyboard 4x2 grid layout and callback naming verified.");

  // 4. Test Level 2 Category Item List & Pagination
  console.log("\n📌 Test I-L: Verifying Level 2 Category Item List Pagination...");

  // Test Page 1 for AI tools
  const p1Text = indexApp.getContentHubCategoryListText("ai_tools", 1);
  assert(p1Text.includes("콘텐츠 허브 > AI 도구"), "Header must mention category title");
  assert(p1Text.includes("페이지 1/2"), "Header must show pagination (페이지 1/2)");
  
  const p1KeyboardObj = indexApp.getContentHubCategoryKeyboard("ai_tools", 1);
  const p1Keyboard = p1KeyboardObj.inline_keyboard;
  assert.strictEqual(p1Keyboard.length, 10, "Page 1 keyboard must have 10 rows (8 items + 1 nav + 1 footer)");
  
  // Verify 8 items on Page 1
  for (let i = 0; i < 8; i++) {
    const itemRow = p1Keyboard[i];
    assert.strictEqual(itemRow.length, 1, `Item row ${i + 1} must have 1 button`);
    assert(itemRow[0].callback_data.startsWith("ch_item:ai_tools:"), `Item button callback must start with ch_item:ai_tools:`);
    assert(itemRow[0].callback_data.endsWith(":1"), `Item button on page 1 must have page context ':1'`);
  }

  // Verify pagination buttons on Page 1: [ ◀️ 이전 ] [ 1 / 2 ] [ 다음 ▶️ ]
  const p1NavRow = p1Keyboard[8];
  assert.strictEqual(p1NavRow.length, 3, "Pagination row must have 3 buttons");
  assert.strictEqual(p1NavRow[0].callback_data, "none", "Previous button on page 1 should be disabled ('none')");
  assert.strictEqual(p1NavRow[1].text, "[ 1 / 2 ]", "Middle button must show '[ 1 / 2 ]'");
  assert.strictEqual(p1NavRow[2].callback_data, "ch_page:ai_tools:2", "Next button on page 1 must point to 'ch_page:ai_tools:2'");

  // Test Page 2 for AI tools
  const p2Text = indexApp.getContentHubCategoryListText("ai_tools", 2);
  assert(p2Text.includes("페이지 2/2"), "Header must show pagination (페이지 2/2)");
  
  const p2KeyboardObj = indexApp.getContentHubCategoryKeyboard("ai_tools", 2);
  const p2Keyboard = p2KeyboardObj.inline_keyboard;
  assert.strictEqual(p2Keyboard.length, 4, "Page 2 keyboard must have 4 rows (2 items + 1 nav + 1 footer)");
  
  // Verify 2 items on Page 2
  assert.strictEqual(p2Keyboard[0][0].callback_data, "ch_item:ai_tools:copy_ai:2", "Item 9 callback must be ch_item:ai_tools:copy_ai:2");
  assert.strictEqual(p2Keyboard[1][0].callback_data, "ch_item:ai_tools:midjourney:2", "Item 10 callback must be ch_item:ai_tools:midjourney:2");

  // Verify pagination buttons on Page 2:
  const p2NavRow = p2Keyboard[2];
  assert.strictEqual(p2NavRow[0].callback_data, "ch_page:ai_tools:1", "Previous button on page 2 must point to 'ch_page:ai_tools:1'");
  assert.strictEqual(p2NavRow[1].text, "[ 2 / 2 ]", "Middle button must show '[ 2 / 2 ]'");
  assert.strictEqual(p2NavRow[2].callback_data, "none", "Next button on page 2 should be disabled ('none')");

  console.log("   ✅ Level 2 Pagination verified (10 items = Page 1 [8 items] + Page 2 [2 items]).");

  // 5. Test Level 3 Site Detail View
  console.log("\n📌 Test M-Q: Verifying Level 3 Detail View, Outbound URL, and Back navigation...");
  
  // Open Midjourney from Page 2
  const detailText = indexApp.getContentHubItemDetailText("ai_tools", "midjourney");
  assert(detailText.includes("Midjourney"), "Detail must contain item name");
  assert(detailText.includes("카테고리: AI 도구") || detailText.includes("AI 도구"), "Detail must contain category name");
  assert(detailText.includes("프롬프트 기반 초고화질 AI 이미지 생성 도구"), "Detail must contain Korean description");

  const detailKeyboardObj = indexApp.getContentHubItemDetailKeyboard("ai_tools", "midjourney", 2);
  const detailKeyboard = detailKeyboardObj.inline_keyboard;
  assert.strictEqual(detailKeyboard.length, 2, "Detail keyboard must have 2 rows");

  // Row 1: External URL button
  const urlBtn = detailKeyboard[0][0];
  assert.strictEqual(urlBtn.text, "🔗 사이트 바로가기", "URL button text must be '🔗 사이트 바로가기'");
  assert.strictEqual(urlBtn.url, "https://www.midjourney.com/home", "URL must match dataset URL");
  assert(!urlBtn.callback_data, "URL button must NOT contain callback_data");

  // Row 2: Back navigation preserving Page 2 context
  const backRow = detailKeyboard[1];
  assert.strictEqual(backRow.length, 2, "Back row must have 2 buttons");
  assert.strictEqual(backRow[0].text, "🔙 목록으로", "Back button text must be '🔙 목록으로'");
  assert.strictEqual(backRow[0].callback_data, "ch_page:ai_tools:2", "Back button must preserve Page 2 context ('ch_page:ai_tools:2')");
  assert.strictEqual(backRow[1].text, "📁 전체 카테고리", "Category Hub button text must be '📁 전체 카테고리'");
  assert.strictEqual(backRow[1].callback_data, "ch_hub", "Category Hub callback must be 'ch_hub'");

  console.log("   ✅ Level 3 Detail View verified with direct outbound URL button and Page 2 context preservation.");

  // 6. Test Korean Diaspora entries specifically
  console.log("\n📌 Verifying Korean Diaspora entries detail views...");
  const dailyNlText = indexApp.getContentHubItemDetailText("korean_diaspora", "dailynl");
  assert(dailyNlText.includes("[네덜란드] 데일리NL"), "Must display DailyNL name");
  const dailyNlKeyboardObj = indexApp.getContentHubItemDetailKeyboard("korean_diaspora", "dailynl", 1);
  const dailyNlUrlBtn = dailyNlKeyboardObj.inline_keyboard[0][0];
  assert.strictEqual(dailyNlUrlBtn.url, "https://dailynl.net/", "DailyNL URL must be https://dailynl.net/");
  console.log("   ✅ Korean diaspora [네덜란드] 데일리NL verified.");

  // 7. Regression Checks
  console.log("\n📌 Test R-U: Verifying isolation & regression protection...");
  
  // Check 12 popular topic cards in main keyboard
  const mainKeys = await indexApp.getMainKeyboard();
  assert.strictEqual(mainKeys.inline_keyboard.length, 4, "Main keyboard must retain 4 rows of topic cards");
  assert.strictEqual(mainKeys.inline_keyboard.reduce((acc, r) => acc + r.length, 0), 12, "Main keyboard must retain exactly 12 cards");
  console.log("   ✅ 12 Popular Topic cards intact.");

  // Check Trending keyboard includes Topic cards, Breaking news, and Content Hub
  const trendKeys = await indexApp.getTrendingKeyboard();
  assert(trendKeys.inline_keyboard.length >= 10, "Trending keyboard must retain all major sections");
  console.log("   ✅ Trending Keyboard navigation intact.");

  // Check published_ledger.json
  const ledger = JSON.parse(fs.readFileSync(path.join(__dirname, "published_ledger.json"), "utf8"));
  const successCount = ledger.records.filter(r => r.status === "SUCCESS").length;
  assert.strictEqual(successCount, 88, "published_ledger.json MUST retain exactly 88 SUCCESS records");
  assert.strictEqual(ledger.nextRoundRobinIndex, 1, "nextRoundRobinIndex MUST remain 1");
  console.log("   ✅ published_ledger.json intact (88 SUCCESS records, index 1).");

  console.log("\n============================================================");
  console.log("🎉 ALL CONTENT HUB NAVIGATION & REGRESSION TESTS PASSED!");
  console.log("============================================================\n");
})();
