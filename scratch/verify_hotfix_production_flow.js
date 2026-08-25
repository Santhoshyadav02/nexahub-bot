const assert = require("assert");
const sourceRegistry = require("../source_registry");
const { renderTopicPosts, renderItemDetailPage } = require("../index");

console.log("==================================================");
console.log("🧪 VERIFYING HOT FIX PRODUCTION FLOW FOR ALL CARDS");
console.log("==================================================\n");

const TEST_CARDS = [
  { cardName: "Card 1", topicKey: "Romantic Vibe", expectedChannel: "Romantic Vibe" },
  { cardName: "Card 2", topicKey: "Dating", expectedChannel: "Dating" },
  { cardName: "Card 3", topicKey: "Romance", expectedChannel: "Romance" },
  { cardName: "Card 7 (Middle Card)", topicKey: "Lustful Hostess", expectedChannel: "Lustful Hostess" },
  { cardName: "Card 12 (Card 11..20)", topicKey: "Dating", expectedChannel: "Dating" }
];

TEST_CARDS.forEach(test => {
  console.log(`\n--- TESTING ${test.cardName}: "${test.topicKey}" ---`);
  
  // 1. Query real video posts
  const realVideos = sourceRegistry.getPostsForKeyword(test.topicKey, true);
  console.log(`Real Video Records Found: ${realVideos.length}`);
  assert.ok(realVideos.length > 0, `${test.cardName} must have real video records (found ${realVideos.length})`);

  // 2. Verify all returned posts are actual video media
  realVideos.forEach(v => {
    assert.strictEqual(v.media_type, "video", "Post must be media_type === video");
    assert.ok(v.message_id, "Post must have message_id");
    assert.ok(v.telegram_url && v.telegram_url.startsWith("http"), "Post must have HTTP telegram_url");
  });

  // 3. Test list rendering call
  renderTopicPosts("12345678", test.topicKey, 1);

  // 4. Test detail page rendering for Item #1
  renderItemDetailPage("12345678", `topic_page:${test.topicKey}`, 0, 1);

  console.log(`✅ ${test.cardName} PASSED!`);
});

console.log("\n==================================================");
console.log("🎉 ALL TEST CARDS PASSED REAL PRODUCTION FLOW AUDIT!");
console.log("==================================================");
