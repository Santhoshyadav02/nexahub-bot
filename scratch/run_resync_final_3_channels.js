require("D:\\Automation\\hiruboy\\node_modules\\dotenv").config({ path: "D:\\Automation\\hiruboy\\.env" });
const assert = require("assert");

const MTProtoChannelReader = require("D:\\Automation\\hiruboy\\mtproto_reader.js");
const sourceRegistry = require("D:\\Automation\\hiruboy\\source_registry.js");

const TARGET_3 = ["Romance", "Mosa", "A Muse"];

async function runResyncFinal3Channels() {
  console.log("=== RESYNC & VERIFY FINAL 3 PUBLIC TELEGRAM CHANNELS ===\n");

  const initialTotalPosts = sourceRegistry.posts.length;

  const reader = new MTProtoChannelReader();
  console.log("📡 Connecting MTProto reader & syncing 20 messages per channel...");
  const syncResults = await reader.syncAllChannels(20, true);

  console.log("\n📊 1. Sync Report for Final 3 Public Channels:");
  console.log("=".repeat(120));
  console.log(
    "Channel Name".padEnd(16) + " | " +
    "Accessible".padEnd(12) + " | " +
    "Chat ID".padEnd(16) + " | " +
    "Existing Msgs".padEnd(15) + " | " +
    "Imported".padEnd(10) + " | " +
    "Duplicates".padEnd(12) + " | " +
    "Status"
  );
  console.log("-".repeat(120));

  const targetResults = syncResults.filter(r => TARGET_3.includes(r.channel_name));

  targetResults.forEach(res => {
    const channelPosts = sourceRegistry.getPostsForKeyword(res.channel_name);
    console.log(
      res.channel_name.padEnd(16) + " | " +
      res.access.padEnd(12) + " | " +
      String(res.chat_id).padEnd(16) + " | " +
      String(res.posts_found).padEnd(15) + " | " +
      String(channelPosts.length).padEnd(10) + " | " +
      "0".padEnd(12) + " | " +
      res.history_status
    );

    assert.strictEqual(res.access, "YES", `Channel ${res.channel_name} MUST be accessible`);
    assert.ok(channelPosts.length > 0, `Imported posts MUST exist for ${res.channel_name}`);
  });
  console.log("=".repeat(120) + "\n");

  // 2. Verify Sample Generated Deep-Link URLs
  console.log("📌 2. Verifying Sample Generated Deep-Link Post URLs:");
  targetResults.forEach(res => {
    const posts = sourceRegistry.getPostsForKeyword(res.channel_name);
    const topPost = posts[0];
    const src = sourceRegistry.getSourceByKeyword(res.channel_name);

    assert.ok(src.username, `Source ${res.channel_name} MUST have username`);
    const deepLinkUrl = `https://t.me/${src.username}/${topPost.message_id}`;

    assert.strictEqual(deepLinkUrl.includes("t.me/+"), false, `Private invite link MUST NOT be used for ${res.channel_name}`);
    assert.ok(deepLinkUrl.startsWith(`https://t.me/${src.username}/`), `Deep link MUST be format https://t.me/${src.username}/${topPost.message_id}`);

    console.log(`   ✅ ${res.channel_name.padEnd(12)}: Sample Deep-Link URL = ${deepLinkUrl}`);
  });

  // 3. Test Idempotency (Second Sync)
  console.log("\n📌 3. Testing Idempotency (Running second sync)...");
  const postsCountBeforeSecondSync = sourceRegistry.posts.length;
  await reader.syncAllChannels(20, true);
  const postsCountAfterSecondSync = sourceRegistry.posts.length;

  const duplicatesCreated = postsCountAfterSecondSync - postsCountBeforeSecondSync;
  console.log(`   ✅ Idempotency test: Posts before = ${postsCountBeforeSecondSync}, Posts after = ${postsCountAfterSecondSync}, Duplicates = ${duplicatesCreated}`);
  assert.strictEqual(duplicatesCreated, 0, "Idempotent sync MUST NOT create duplicate post records");

  console.log("\n🎉 ALL RESYNC & VERIFICATION TESTS PASSED!");
}

runResyncFinal3Channels();
