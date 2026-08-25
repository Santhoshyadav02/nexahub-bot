require("D:\\Automation\\hiruboy\\node_modules\\dotenv").config({ path: "D:\\Automation\\hiruboy\\.env" });
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const sourceRegistry = require("D:\\Automation\\hiruboy\\source_registry.js");
const MTProtoChannelReader = require("D:\\Automation\\hiruboy\\mtproto_reader.js");

const TARGET_CHANNELS = [
  "Romantic Vibe", "Dating", "Romance", "Crotch", "Mosa",
  "Bunny Girl Cosplay Date", "Lustful Hostess", "Concubine", "Saki Mizumi", "A Muse"
];

async function runMTProtoStartupSyncIntegrationTest() {
  console.log("=== MTPROTO STARTUP SYNC INTEGRATION TEST ===\n");

  // Reset sourceRegistry to clear any legacy mock test data
  sourceRegistry.posts = [];
  sourceRegistry.saveData();

  const reader = new MTProtoChannelReader();
  assert.strictEqual(reader.authMode, "USER_SESSION", "MUST authenticate as USER_SESSION");

  // 1. Run Initial Sync across all 10 channels (saveToDisk = true)
  console.log("📌 1. Running MTProto Initial Sync for all 10 channels (1st Run)...");
  const results1 = await reader.syncAllChannels(10, true);

  console.log("\n" + "=".repeat(110));
  console.log(
    "Channel Name".padEnd(25) + " | " +
    "Fetched".padEnd(8) + " | " +
    "Stored".padEnd(8) + " | " +
    "Latest Msg ID".padEnd(14) + " | " +
    "Latest Media Type".padEnd(17) + " | " +
    "Index 0 Title"
  );
  console.log("-".repeat(110));

  const stats = [];

  for (const chName of TARGET_CHANNELS) {
    const report = results1.find(r => r.channel_name === chName);
    const storedPosts = sourceRegistry.getPostsForKeyword(chName);

    assert.ok(report, `Report MUST exist for ${chName}`);
    if (report.access !== "YES" || report.posts_found === 0) {
      console.log(`⚠️ Channel ${chName}: access = ${report.access}, posts_found = ${report.posts_found}, error = ${report.error || 'None'}`);
      continue;
    }

    assert.ok(storedPosts.length > 0, `Stored posts MUST exist for ${chName}`);

    // Verify position 0 is newest post (highest message_id)
    const topPost = storedPosts[0];
    const maxMsgId = Math.max(...report.posts.map(p => p.message_id));
    assert.strictEqual(topPost.message_id, maxMsgId, `Top post for ${chName} MUST be highest message_id (${maxMsgId})`);

    // Verify all posts belong ONLY to this channel
    storedPosts.forEach(p => {
      assert.strictEqual(p.keyword, chName, `Post keyword MUST equal ${chName}`);
    });

    const statObj = {
      channel_name: chName,
      fetched: report.posts_found,
      stored: storedPosts.length,
      latest_msg_id: topPost.message_id,
      media_type: topPost.media_type,
      top_title: topPost.title
    };
    stats.push(statObj);

    console.log(
      statObj.channel_name.padEnd(25) + " | " +
      String(statObj.fetched).padEnd(8) + " | " +
      String(statObj.stored).padEnd(8) + " | " +
      String(statObj.latest_msg_id).padEnd(14) + " | " +
      statObj.media_type.padEnd(17) + " | " +
      (topPost.title || "").substring(0, 30)
    );
  }
  console.log("=".repeat(110) + "\n");

  // 2. Test Idempotency (2nd Run - Duplicate Sync)
  console.log("📌 2. Testing Idempotency (Running MTProto Sync 2nd time)...");
  const totalPostsBefore = sourceRegistry.posts.length;
  await reader.syncAllChannels(10, true);
  const totalPostsAfter = sourceRegistry.posts.length;

  console.log(`   • Total Posts Before 2nd Sync: ${totalPostsBefore}`);
  console.log(`   • Total Posts After 2nd Sync:  ${totalPostsAfter}`);
  assert.strictEqual(totalPostsBefore, totalPostsAfter, "2nd sync MUST NOT create duplicate posts!");
  console.log("   ✅ IDEMPOTENCY VERIFIED (0 Duplicate Posts Created)!");

  // 3. Test Cross-Channel Isolation
  console.log("\n📌 3. Testing Cross-Channel Isolation across all 10 channels:");
  for (const chName of TARGET_CHANNELS) {
    const posts = sourceRegistry.getPostsForKeyword(chName);
    const uniqueChatIds = new Set(posts.map(p => p.chat_id));
    assert.strictEqual(uniqueChatIds.size, 1, `Channel ${chName} MUST contain posts from exactly 1 chat_id`);
    console.log(`   • Channel ${chName.padEnd(24)}: ${posts.length} posts | Isolated Chat ID: ${[...uniqueChatIds][0]}`);
  }
  console.log("   ✅ CROSS-CHANNEL ISOLATION VERIFIED!");

  console.log("\n🎉 ALL MTPROTO STARTUP SYNC INTEGRATION TESTS PASSED!");
}

runMTProtoStartupSyncIntegrationTest();
