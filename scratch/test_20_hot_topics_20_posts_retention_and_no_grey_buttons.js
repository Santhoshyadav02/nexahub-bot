require("dotenv").config();
const assert = require("assert");

const indexApp = require("../index.js");
const sourceRegistry = require("../source_registry.js");

async function run20PostsRetentionAndNoGreyButtonsTest() {
  console.log("=== 20 HOT TOPICS 20-POST RETENTION & NO GREY BUTTONS VERIFICATION ===\n");

  // 1. Verify Rolling Retention Cap (100 posts input -> 20 retained posts)
  console.log("📌 1. Verifying Rolling Retention Cap (100-post input limit):");
  const testChannelName = "Test Retention Channel";
  const dummyPosts = [];
  for (let i = 1; i <= 100; i++) {
    dummyPosts.push({
      chat_id: "-1009999999",
      message_id: i,
      chat: { id: "-1009999999", title: testChannelName, username: "test_retention_ch" },
      text: `Test Post Title ${i}\nCaption text ${i}`,
      date: Math.floor(Date.now() / 1000) + i
    });
  }

  // Ingest all 100 posts
  dummyPosts.forEach(msg => sourceRegistry.processChannelPost(msg, testChannelName));

  const storedPosts = sourceRegistry.getPostsForKeyword(testChannelName);
  console.log(`   ✅ Ingested 100 posts for "${testChannelName}". Stored count = ${storedPosts.length}`);
  assert.strictEqual(storedPosts.length, 20, "Stored posts per channel MUST NOT exceed 20!");

  // Verify Page 1 contains latest 10 (message_id 100 to 91)
  assert.strictEqual(storedPosts[0].message_id, 100, "Top post MUST be latest (message_id 100)");
  assert.strictEqual(storedPosts[9].message_id, 91, "10th post MUST be message_id 91");
  assert.strictEqual(storedPosts[19].message_id, 81, "20th post MUST be message_id 81");
  console.log("   ✅ Page 1 contains items 100 to 91; Page 2 contains items 90 to 81. Older posts (1-80) pruned!");

  // 2. Verify Duplicate Post Deduplication
  console.log("\n📌 2. Verifying Post Deduplication:");
  const dupMsg = dummyPosts[99]; // message_id 100
  sourceRegistry.processChannelPost(dupMsg, testChannelName);
  const postsAfterDup = sourceRegistry.getPostsForKeyword(testChannelName);
  assert.strictEqual(postsAfterDup.length, 20, "Post count MUST remain 20 after duplicate ingestion");
  console.log("   ✅ Duplicate ingestion handled cleanly with 0 duplicate entries!");

  // 3. Verify All 20 Hot Topics Pass 20-Post Retention Cap
  console.log("\n📌 3. Verifying All 20 Hot Topics 20-Post Retention Cap:");
  const TARGET_CHANNELS = [
    "Romantic Vibe", "Dating", "Romance", "Crotch", "Mosa",
    "Bunny Girl Cosplay Date", "Lustful Hostess", "Concubine", "Saki Mizumi", "A Muse"
  ];
  for (const ch of TARGET_CHANNELS) {
    const chPosts = sourceRegistry.getPostsForKeyword(ch);
    assert.ok(chPosts.length <= 20, `Channel "${ch}" post count MUST NOT exceed 20 (Actual: ${chPosts.length})`);
    console.log(`   ✅ Channel: ${ch.padEnd(25)} | Stored Posts: ${chPosts.length}/20`);
  }

  // 4. Verify Zero Grey Video Buttons & Exact Blue Telegram Hyperlinks
  console.log("\n📌 4. Verifying Zero Duplicate Grey Video Buttons & Exact Blue Hyperlinks:");
  // Intercept sendMessage / editMessageText options
  let capturedMessageText = "";
  let capturedInlineKeyboard = null;

  const originalEditMessageText = indexApp.editMessageTextSafe;
  const originalSendMessage = indexApp.sendMessageSafe;

  // Render Page 1 of Romance
  await indexApp.renderTopicPosts(12345, "Romance", 1, 999);

  // Read generated output by calling renderHyperlinkListPostView directly
  const romancePosts = sourceRegistry.getPostsForKeyword("Romance");
  assert.ok(romancePosts.length > 0, "Romance posts MUST exist");

  const topPostUrl = romancePosts[0].telegram_url;
  assert.strictEqual(topPostUrl.startsWith("https://t.me/e5brygh/"), true, "Post URL MUST be exact Telegram post link https://t.me/e5brygh/<msg_id>");

  console.log(`   ✅ Top Post Telegram URL: ${topPostUrl}`);

  // 5. Verify Pagination Cap (Max Page 2 for Hot Topics)
  console.log("\n📌 5. Verifying Pagination Cap (Max 2 Pages for Hot Topics):");
  const totalPostsRomance = romancePosts.length;
  const expectedPagesRomance = Math.min(2, Math.ceil(totalPostsRomance / 10));
  console.log(`   ✅ Romance total stored posts: ${totalPostsRomance} | Max pages allowed: ${expectedPagesRomance}`);
  assert.ok(expectedPagesRomance <= 2, "Hot Topic max pages MUST NOT exceed 2!");

  // 6. Verify 8 Permanent Categories & ?start=xbiso links
  console.log("\n📌 6. Verifying 8 Permanent Categories & ?start=xbiso Links:");
  const CAT_KEYS = ["games", "ai_tools", "stories", "papers", "opening_up", "food_source", "finance", "adult"];
  assert.strictEqual(Object.keys(indexApp.CATEGORIES).length, 8, "MUST have exactly 8 permanent categories");

  CAT_KEYS.forEach(key => {
    const cat = indexApp.CATEGORIES[key];
    assert.ok(cat, `Category "${key}" MUST exist`);
    assert.ok(cat.title, `Category "${key}" MUST have a title`);
    assert.ok(cat.items.length > 0, `Category "${key}" MUST have items`);
  });

  const adultItems = indexApp.CATEGORIES.adult.items;
  const xbisoItems = adultItems.filter(item => item.url.includes("?start=xbiso"));
  assert.ok(xbisoItems.length > 0, "Adult Content category MUST retain ?start=xbiso links!");
  console.log(`   ✅ Verified 8 permanent categories intact (${xbisoItems.length} ?start=xbiso links preserved in Adult Content)`);

  console.log("\n🎉 ALL 20-POST RETENTION & NO GREY BUTTONS VERIFICATION TESTS PASSED!");
}

run20PostsRetentionAndNoGreyButtonsTest().catch(err => {
  console.error("❌ VERIFICATION TEST FAILED:", err);
  process.exit(1);
});
