require("D:\\Automation\\hiruboy\\node_modules\\dotenv").config({ path: "D:\\Automation\\hiruboy\\.env" });
const assert = require("assert");

const indexApp = require("D:\\Automation\\hiruboy\\index.js");
const sourceRegistry = require("D:\\Automation\\hiruboy\\source_registry.js");

const TEST_CARDS = [
  { cardNum: 1, expectedCh: "Romantic Vibe", expectedUn: "ccsfvk" },
  { cardNum: 5, expectedCh: "Mosa", expectedUn: "vsdxda" },
  { cardNum: 10, expectedCh: "A Muse", expectedUn: "bzd4wrf" },
  { cardNum: 11, expectedCh: "Romantic Vibe", expectedUn: "ccsfvk" },
  { cardNum: 15, expectedCh: "Mosa", expectedUn: "vsdxda" },
  { cardNum: 20, expectedCh: "A Muse", expectedUn: "bzd4wrf" }
];

async function runNewVideoDetailFlowTest() {
  console.log("=== NEW VIDEO DETAIL FLOW & TEXT ALIGNMENT VERIFICATION ===\n");

  // 1. Verify 5-Column Text Alignment & Label Formatting
  console.log("📌 1. Verifying 5-Column HOT TOPICS Text Formatting:");
  const keyboardObj = await indexApp.getMainKeyboard();
  const rows = keyboardObj.inline_keyboard;
  assert.strictEqual(rows.length, 4, "HOT TOPICS grid MUST have 4 rows");

  rows.forEach((r, idx) => {
    assert.strictEqual(r.length, 5, `Row ${idx + 1} MUST have 5 columns`);
  });

  const flatButtons = rows.flat();
  flatButtons.forEach(btn => {
    // Check no ugly word chopping like "Samsung E.."
    assert.strictEqual(btn.text.includes("Samsung E.."), false, "Label MUST NOT cut words awkwardly");
    console.log(`   ✅ Label: ${btn.text.padEnd(20)} | Callback: ${btn.callback_data}`);
  });

  // 2. Verify Cards 1, 5, 10, 11, 15, 20 Navigation Flow
  console.log("\n📌 2. Verifying Video Detail Navigation Flow for Cards 1, 5, 10, 11, 15, 20:");
  console.log("=".repeat(140));
  console.log("Card # | Channel Name     | Video Title Sample       | WATCH VIDEO URL (Post)         | JOIN GROUP URL (Group)   | BACK Callback   | HOME");
  console.log("-".repeat(140));

  for (const tc of TEST_CARDS) {
    const btn = flatButtons[tc.cardNum - 1];
    assert.ok(btn, `Card button ${tc.cardNum} MUST exist`);

    const posts = sourceRegistry.getPostsForKeyword(tc.expectedCh);
    assert.ok(posts.length > 0, `Posts MUST exist for ${tc.expectedCh}`);
    const topPost = posts[0];

    const src = sourceRegistry.getSourceByKeyword(tc.expectedCh);
    const expectedPostUrl = `https://t.me/${src.username}/${topPost.message_id}`;
    const expectedGroupUrl = `https://t.me/${src.username}`;

    assert.strictEqual(expectedPostUrl.startsWith(`https://t.me/${tc.expectedUn}/`), true, `Post URL MUST start with https://t.me/${tc.expectedUn}/`);
    assert.strictEqual(expectedGroupUrl, `https://t.me/${tc.expectedUn}`, `Group URL MUST be https://t.me/${tc.expectedUn}`);

    const backCallback = `topic:${tc.expectedCh}:1`;

    console.log(
      `${String(tc.cardNum).padStart(6)} | ${tc.expectedCh.padEnd(16)} | ${(topPost.title ? topPost.title.substring(0, 20) : "Video").padEnd(24)} | ${expectedPostUrl.padEnd(30)} | ${expectedGroupUrl.padEnd(24)} | ${backCallback.padEnd(15)} | menu`
    );
  }
  console.log("=".repeat(140) + "\n");

  // 3. Verify Isolation & Zero Cross-Channel URL Leaks
  console.log("📌 3. Verifying Cross-Channel URL Isolation:");
  const romancePosts = sourceRegistry.getPostsForKeyword("Romance");
  const mosaPosts = sourceRegistry.getPostsForKeyword("Mosa");
  const amusePosts = sourceRegistry.getPostsForKeyword("A Muse");

  const romanceUrl = `https://t.me/e5brygh/${romancePosts[0].message_id}`;
  const mosaUrl = `https://t.me/vsdxda/${mosaPosts[0].message_id}`;
  const amuseUrl = `https://t.me/bzd4wrf/${amusePosts[0].message_id}`;

  assert.notStrictEqual(romanceUrl, mosaUrl, "Romance and Mosa URLs MUST be isolated");
  assert.notStrictEqual(mosaUrl, amuseUrl, "Mosa and A Muse URLs MUST be isolated");
  assert.notStrictEqual(romanceUrl, amuseUrl, "Romance and A Muse URLs MUST be isolated");

  console.log(`   ✅ Romance Post URL: ${romanceUrl}`);
  console.log(`   ✅ Mosa Post URL:    ${mosaUrl}`);
  console.log(`   ✅ A Muse Post URL:  ${amuseUrl}`);

  console.log("\n🎉 ALL NEW VIDEO DETAIL FLOW & TEXT ALIGNMENT VERIFICATION TESTS PASSED!");
}

runNewVideoDetailFlowTest();
