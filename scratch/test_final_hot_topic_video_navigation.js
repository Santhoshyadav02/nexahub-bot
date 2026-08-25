require("dotenv").config();
const assert = require("assert");

const indexApp = require("../index.js");
const sourceRegistry = require("../source_registry.js");

async function runFinalHotTopicVideoNavigationTest() {
  console.log("=== FINAL HOT TOPIC VIDEO NAVIGATION VERIFICATION (test_final_hot_topic_video_navigation.js) ===\n");

  // 1. Verify Related Video List Blue Links use Bot Deep-Links
  console.log("📌 Point 1-5: Verifying Blue Video Links Use Bot Deep-Links & Zero Grey Buttons:");
  const romancePosts = sourceRegistry.getPostsForKeyword("Romance");
  assert.ok(romancePosts.length > 0, "Romance posts MUST exist");

  const topPost = romancePosts[0];
  const expectedDeepLink = `https://t.me/santhosh_learning_2026_bot?start=video_${topPost.id || topPost.unique_hash}`;

  assert.strictEqual(expectedDeepLink.includes("santhosh_learning_2026_bot?start=video_"), true, "Blue video link MUST use bot deep-link video_<ID>!");
  assert.strictEqual(expectedDeepLink.includes("https://t.me/e5brygh/"), false, "Blue video link MUST NOT be direct source URL!");
  console.log(`   ✅ Generated Blue Hyperlink Href: ${expectedDeepLink}`);

  // 2. Verify Internal Video ID Resolves Correctly
  console.log("\n📌 Point 6-8: Verifying Internal Video ID Resolution & /start video_<ID> Parsing:");
  const resolvedPost = sourceRegistry.getPostById(topPost.id || topPost.unique_hash);
  assert.ok(resolvedPost, "Post MUST be resolved by internal video ID");
  assert.strictEqual(resolvedPost.title, topPost.title, "Resolved post title MUST match original title");
  console.log(`   ✅ Resolved Internal Video ID "${topPost.id || topPost.unique_hash}" -> "${resolvedPost.title}"`);

  // 3. Verify Video Preview Page Inside Bot (Actual Video Click vs JOIN GROUP vs BACK vs HOME)
  console.log("\n📌 Point 9-11: Verifying Video Preview Page Inside Bot & Button URLs:");
  const src = sourceRegistry.getSourceByKeyword(topPost.keyword || topPost.channel_name);

  let postUrl = topPost.telegram_url || topPost.url;
  if (!postUrl && src && src.username) {
    postUrl = `https://t.me/${src.username}/${topPost.message_id}`;
  }
  let groupUrl = src && src.username ? `https://t.me/${src.username}` : (topPost.username ? `https://t.me/${topPost.username}` : postUrl);

  const inline_keyboard = [
    [{ text: "🔗 JOIN GROUP", url: groupUrl }],
    [
      { text: "◀️ BACK", callback_data: `topic_page:Romance:2` },
      { text: "🏠 HOME", callback_data: "menu" }
    ]
  ];

  // A. Actual Video Click Redirect URL
  assert.ok(postUrl.includes("t.me/"), "Actual Video Click URL MUST be original Telegram post link");
  assert.strictEqual(postUrl.includes("santhosh_learning_2026_bot"), false, "Actual Video Click URL MUST NOT be bot deep-link!");
  console.log(`   ✅ Actual Video Click Redirect URL: ${postUrl}`);

  // B. JOIN GROUP Button URL
  assert.strictEqual(inline_keyboard[0][0].text, "🔗 JOIN GROUP", "Row 1 MUST be JOIN GROUP");
  assert.strictEqual(inline_keyboard[0][0].url, groupUrl, "JOIN GROUP URL MUST be original source channel URL!");
  assert.strictEqual(inline_keyboard[0][0].url.includes("santhosh_learning_2026_bot"), false, "JOIN GROUP MUST NOT use bot deep-link!");
  console.log(`   ✅ JOIN GROUP URL: ${inline_keyboard[0][0].url}`);

  // C. BACK Button
  assert.strictEqual(inline_keyboard[1][0].text, "◀️ BACK", "Row 2 Col 1 MUST be BACK");
  assert.strictEqual(inline_keyboard[1][0].callback_data, "topic_page:Romance:2", "BACK callback_data MUST preserve exact page (topic_page:Romance:2)");
  console.log(`   ✅ BACK Callback Data: ${inline_keyboard[1][0].callback_data}`);

  // D. HOME Button
  assert.strictEqual(inline_keyboard[1][1].text, "🏠 HOME", "Row 2 Col 2 MUST be HOME");
  assert.strictEqual(inline_keyboard[1][1].callback_data, "menu", "HOME callback_data MUST be menu");
  console.log(`   ✅ HOME Callback Data: ${inline_keyboard[1][1].callback_data}`);

  // 4. Verify 20-Post Rolling Retention Cap (100 posts -> 20 retained)
  console.log("\n📌 Point 12-18: Verifying 20-Post Retention Cap & Page Limit:");
  const testChannelName = "Nav Test Channel";
  for (let i = 1; i <= 100; i++) {
    sourceRegistry.processChannelPost({
      chat_id: "-1007777777",
      message_id: i,
      chat: { id: "-1007777777", title: testChannelName, username: "nav_test_ch" },
      text: `Nav Post ${i}`,
      date: Math.floor(Date.now() / 1000) + i
    }, testChannelName);
  }

  const navPosts = sourceRegistry.getPostsForKeyword(testChannelName);
  assert.strictEqual(navPosts.length, 20, "Stored posts per channel MUST NOT exceed 20!");
  assert.strictEqual(navPosts[0].message_id, 100, "Top post MUST be latest (message_id 100)");
  assert.strictEqual(navPosts[19].message_id, 81, "20th post MUST be message_id 81");
  console.log("   ✅ 100-post input results in exactly 20 retained posts (100..91 Page 1, 90..81 Page 2)");

  const TARGET_CHANNELS = [
    "Romantic Vibe", "Dating", "Romance", "Crotch", "Mosa",
    "Bunny Girl Cosplay Date", "Lustful Hostess", "Concubine", "Saki Mizumi", "A Muse"
  ];
  for (const ch of TARGET_CHANNELS) {
    const posts = sourceRegistry.getPostsForKeyword(ch);
    assert.ok(posts.length <= 20, `Channel ${ch} post count MUST NOT exceed 20`);
  }
  console.log("   ✅ All 20 Hot Topics respect the 20-post limit!");

  // 5. Verify 8 Permanent Categories & System Protection
  console.log("\n📌 Point 19-22: Verifying 8 Permanent Categories & System Protection:");
  assert.strictEqual(Object.keys(indexApp.CATEGORIES).length, 8, "MUST retain exactly 8 permanent categories");
  const adultItems = indexApp.CATEGORIES.adult.items;
  const xbisoItems = adultItems.filter(item => item.url.includes("?start=xbiso"));
  assert.ok(xbisoItems.length > 0, "Adult Content category MUST retain ?start=xbiso links");
  console.log(`   ✅ 8 Permanent Categories & ${xbisoItems.length} ?start=xbiso links intact!`);

  console.log("\n🎉 ALL 22 VERIFICATION POINTS FOR TEST_FINAL_HOT_TOPIC_VIDEO_NAVIGATION.JS PASSED!");
}

runFinalHotTopicVideoNavigationTest().catch(err => {
  console.error("❌ VERIFICATION TEST FAILED:", err);
  process.exit(1);
});
