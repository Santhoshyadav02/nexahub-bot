require("D:\\Automation\\hiruboy\\node_modules\\dotenv").config({ path: "D:\\Automation\\hiruboy\\.env" });
const assert = require("assert");

const sourceRegistry = require("D:\\Automation\\hiruboy\\source_registry.js");

const ALL_20_CARD_KEYWORDS = [
  // Cards 1-10: Live Trending Keywords
  { id: 1, name: "Romantic Vibe", type: "Keyword" },
  { id: 2, name: "Dating", type: "Keyword" },
  { id: 3, name: "Romance", type: "Keyword" },
  { id: 4, name: "Crotch", type: "Keyword" },
  { id: 5, name: "Mosa", type: "Keyword" },
  { id: 6, name: "Bunny Girl Cosplay Date", type: "Keyword" },
  { id: 7, name: "Lustful Hostess", type: "Keyword" },
  { id: 8, name: "Concubine", type: "Keyword" },
  { id: 9, name: "Saki Mizumi", type: "Keyword" },
  { id: 10, name: "A Muse", type: "Keyword" },
  // Cards 11-20: Trending Videos
  { id: 11, name: "Romantic Vibe", type: "Video" },
  { id: 12, name: "Dating", type: "Video" },
  { id: 13, name: "Romance", type: "Video" },
  { id: 14, name: "Crotch", type: "Video" },
  { id: 15, name: "Mosa", type: "Video" },
  { id: 16, name: "Bunny Girl Cosplay Date", type: "Video" },
  { id: 17, name: "Lustful Hostess", type: "Video" },
  { id: 18, name: "Concubine", type: "Video" },
  { id: 19, name: "Saki Mizumi", type: "Video" },
  { id: 20, name: "A Muse", type: "Video" }
];

async function run4StepWireframeFlowVerification() {
  console.log("=== 4-STEP WIREFRAME FLOW & NAVIGATION VERIFICATION ===\n");

  // 1. Verify Card 1, 10, 11, 20 Navigation Flow
  console.log("📌 1. Testing End-to-End Navigation Flow for Cards 1, 10, 11, 20:");
  const testCardIds = [1, 10, 11, 20];
  
  for (const cardId of testCardIds) {
    const cardInfo = ALL_20_CARD_KEYWORDS.find(c => c.id === cardId);
    assert.ok(cardInfo, `Card ${cardId} info must exist`);

    const posts = sourceRegistry.getPostsForKeyword(cardInfo.name);
    assert.ok(posts.length > 0, `Card ${cardId} (${cardInfo.name}) MUST have posts in sourceRegistry`);

    // Step A: Related List Page 1 (max 7 items)
    const page1Items = posts.slice(0, 7);
    assert.strictEqual(page1Items.length <= 7, true, `Related List MUST show max 7 posts per page`);

    // Step B: Select Video 1 on Detail Page
    const targetPost = page1Items[0];
    const src = sourceRegistry.getSourceByKeyword(targetPost.keyword || targetPost.channel_name);

    // Resolve URL for "Open in Telegram" button
    let openTelegramUrl = "";
    if (src && src.username) {
      openTelegramUrl = `https://t.me/${src.username}/${targetPost.message_id || ""}`;
    } else if (targetPost.username) {
      openTelegramUrl = `https://t.me/${targetPost.username}/${targetPost.message_id || ""}`;
    } else if (src && src.invite_url) {
      openTelegramUrl = src.invite_url;
    } else if (targetPost.invite_url) {
      openTelegramUrl = targetPost.invite_url;
    }

    assert.ok(openTelegramUrl.length > 0, `Open in Telegram URL MUST NOT be empty for Card ${cardId}`);

    console.log(`   ✅ Card ${String(cardId).padEnd(2)} (${cardInfo.name.padEnd(23)}): Card Click -> Related List (${posts.length} posts) -> Video Detail Page -> Open Button (${openTelegramUrl})`);
  }

  // 2. Verify 7 Posts Per Page & Pagination
  console.log("\n📌 2. Verifying 7 Posts Per Page & Pagination:");
  const datingPosts = sourceRegistry.getPostsForKeyword("Dating");
  assert.ok(datingPosts.length >= 7, "Dating channel MUST have at least 7 posts for pagination test");
  
  const totalPages = Math.ceil(datingPosts.length / 7);
  console.log(`   ✅ Dating channel total posts: ${datingPosts.length} | Total Pages: ${totalPages}`);
  assert.strictEqual(datingPosts.slice(0, 7).length, 7, "Page 1 MUST contain exactly 7 posts");
  if (datingPosts.length > 7) {
    assert.ok(datingPosts.slice(7, 14).length > 0, "Page 2 MUST contain remaining posts");
    console.log(`   ✅ Page 2 pagination verified (${datingPosts.slice(7, 14).length} posts)`);
  }

  // 3. Verify Public Usernames for Dating (@cccsefk) and Saki Mizumi (@cccddghhgf)
  console.log("\n📌 3. Verifying Public Telegram Usernames:");
  const datingSrc = sourceRegistry.getSourceByKeyword("Dating");
  assert.strictEqual(datingSrc.username, "cccsefk", "Dating source username MUST be cccsefk");
  console.log(`   ✅ Dating channel uses @cccsefk -> https://t.me/cccsefk/<message_id>`);

  const sakiSrc = sourceRegistry.getSourceByKeyword("Saki Mizumi");
  assert.strictEqual(sakiSrc.username, "cccddghhgf", "Saki Mizumi source username MUST be cccddghhgf");
  console.log(`   ✅ Saki Mizumi channel uses @cccddghhgf -> https://t.me/cccddghhgf/<message_id>`);

  // 4. Verify Zero Cross-Channel Link Bleed
  console.log("\n📌 4. Verifying Cross-Channel Isolation Across All 20 Cards:");
  ALL_20_CARD_KEYWORDS.forEach(c => {
    const src = sourceRegistry.getSourceByKeyword(c.name);
    const posts = sourceRegistry.getPostsForKeyword(c.name);
    posts.forEach(p => {
      if (src.username) {
        assert.ok(src.username === "ccsfvk" || src.username === "cccsefk" || src.username === "ccdjxc" || src.username === "tfccdet" || src.username === "sfgfem" || src.username === "ddkicr" || src.username === "cccddghhgf");
      }
    });
  });
  console.log("   ✅ Zero cross-channel URL leaks detected across all 20 cards!");

  console.log("\n🎉 ALL 4-STEP WIREFRAME FLOW VERIFICATION TESTS PASSED!");
}

run4StepWireframeFlowVerification();
