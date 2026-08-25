require("dotenv").config();
const assert = require("assert");
const sourceRegistry = require("../source_registry");
const MTProtoChannelReader = require("../mtproto_reader");

async function runControlledNewMessageTest() {
  console.log("=== CONTROLLED NEW MESSAGE SYNC TEST ===\n");

  // 1. Clean legacy dummy message IDs (> 10000) so rolling retention retains real Telegram messages
  sourceRegistry.posts = sourceRegistry.posts.filter(p => !p.message_id || parseInt(p.message_id, 10) < 10000);
  sourceRegistry.saveData();

  console.log("📌 STEP 1: Sync all live channels to establish baseline state");
  const reader = new MTProtoChannelReader();
  await reader.syncAllChannels(10, true);

  console.log("\n📌 STEP 2: Verify baseline duplicate protection (Second Sync)");
  const baselineResults = await reader.syncAllChannels(10, true);
  let baseNew = 0;
  baselineResults.forEach(r => { baseNew += r.new_posts || 0; });
  console.log(`  - Baseline Second Sync New Posts: ${baseNew}`);
  assert.strictEqual(baseNew, 0, "Baseline sync MUST produce 0 new messages");

  console.log("\n📌 STEP 3: Inject a genuinely new live message into Dating (ID: 37)");
  const datingPostsBefore = sourceRegistry.getPostsForKeyword("Dating");
  const newestDatingIdBefore = Math.max(...datingPostsBefore.map(p => parseInt(p.message_id || 0, 10)), 0);
  const newMsgId = newestDatingIdBefore + 1;

  const dummyNewMsg = {
    message_id: newMsgId,
    date: Math.floor(Date.now() / 1000),
    chat: { id: "-1003786693669", title: "Dating", username: "cccsefk", type: "channel" },
    text: `🎬 🔥 Controlled Test New Post ${newMsgId}`,
    caption: `Controlled Test New Post ${newMsgId}`
  };

  const res = sourceRegistry.processChannelPost(dummyNewMsg, "Dating");
  console.log(`  - Ingested Message ID : ${newMsgId}`);
  console.log(`  - Ingestion Result    : isNew = ${res.isNew}`);
  assert.strictEqual(res.isNew, true, "Genuinely new message MUST return isNew = true");

  console.log("\n📌 STEP 4: Verify post location & canonical URL");
  const datingPostsAfter = sourceRegistry.getPostsForKeyword("Dating");
  const foundPost = datingPostsAfter.find(p => p.message_id === newMsgId);
  assert.ok(foundPost, "New Dating message MUST exist in Dating keyword list");
  assert.strictEqual(foundPost.telegram_url, `https://t.me/cccsefk/${newMsgId}`, "Canonical URL must match");
  console.log(`  - Found Post Title    : "${foundPost.title}"`);
  console.log(`  - Generated URL       : ${foundPost.telegram_url}`);

  console.log("\n📌 STEP 5: Verify Cross-Channel Isolation");
  const OTHER_CHANNELS = ["Romantic Vibe", "Romance", "Crotch", "Mosa", "Bunny Girl Cosplay Date", "Lustful Hostess", "Concubine", "Saki Mizumi", "A Muse"];
  for (const ch of OTHER_CHANNELS) {
    const posts = sourceRegistry.getPostsForKeyword(ch);
    const leaked = posts.some(p => p.message_id === newMsgId);
    assert.strictEqual(leaked, false, `New Dating post MUST NOT leak into ${ch}`);
  }
  console.log("  - Cross-channel isolation verified: 0 leakage across all other 9 channels!");

  console.log("\n🎉 CONTROLLED NEW MESSAGE TEST PASSED!");
}

runControlledNewMessageTest().catch(err => {
  console.error("❌ TEST FAILED:", err);
  process.exit(1);
});
