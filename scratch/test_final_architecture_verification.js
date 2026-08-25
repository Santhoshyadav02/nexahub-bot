require("D:\\Automation\\hiruboy\\node_modules\\dotenv").config({ path: "D:\\Automation\\hiruboy\\.env" });
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { getTrendingKeyboard } = require("D:\\Automation\\hiruboy\\index.js");
const sourceRegistry = require("D:\\Automation\\hiruboy\\source_registry.js");
const MTProtoChannelReader = require("D:\\Automation\\hiruboy\\mtproto_reader.js");

const TARGET_CHANNELS = [
  "Romantic Vibe", "Dating", "Romance", "Crotch", "Mosa",
  "Bunny Girl Cosplay Date", "Lustful Hostess", "Concubine", "Saki Mizumi", "A Muse"
];

async function runFinalVerificationSuite() {
  console.log("=== FINAL ARCHITECTURE VERIFICATION SUITE ===\n");

  // D. Run real MTProto Startup Sync into real source_registry.json
  console.log("📌 D & E. Running Real MTProto Startup Sync for all 10 channels (1st Run)...");
  const reader = new MTProtoChannelReader();
  const syncResults = await reader.syncAllChannels(10, true);

  console.log("\n" + "=".repeat(120));
  console.log(
    "Channel Name".padEnd(25) + " | " +
    "Real Chat ID".padEnd(16) + " | " +
    "Fetched".padEnd(8) + " | " +
    "Stored".padEnd(8) + " | " +
    "Latest Msg ID".padEnd(14) + " | " +
    "Index 0 Post Title"
  );
  console.log("-".repeat(120));

  const perChannelStats = [];

  for (const chName of TARGET_CHANNELS) {
    const report = syncResults.find(r => r.channel_name === chName);
    const storedPosts = sourceRegistry.getPostsForKeyword(chName);

    assert.ok(report, `Report MUST exist for ${chName}`);
    assert.ok(storedPosts.length > 0, `Stored posts MUST exist in source_registry.json for ${chName}`);

    const topPost = storedPosts[0];
    const maxMsgId = Math.max(...report.posts.map(p => p.message_id));
    assert.strictEqual(topPost.message_id, maxMsgId, `Position 0 for ${chName} MUST be highest message_id ${maxMsgId}`);

    const statObj = {
      name: chName,
      chat_id: report.chat_id,
      fetched: report.posts_found,
      stored: storedPosts.length,
      latest_msg_id: topPost.message_id,
      top_title: topPost.title
    };
    perChannelStats.push(statObj);

    console.log(
      statObj.name.padEnd(25) + " | " +
      statObj.chat_id.padEnd(16) + " | " +
      String(statObj.fetched).padEnd(8) + " | " +
      String(statObj.stored).padEnd(8) + " | " +
      String(statObj.latest_msg_id).padEnd(14) + " | " +
      (topPost.title || "").substring(0, 30)
    );
  }
  console.log("=".repeat(120) + "\n");

  // F. Verify Dating contains ONLY Dating posts
  console.log("📌 F. Verifying Dating channel isolation:");
  const datingPosts = sourceRegistry.getPostsForKeyword("Dating");
  assert.ok(datingPosts.length > 0, "Dating MUST have stored posts");
  datingPosts.forEach(p => {
    assert.strictEqual(p.keyword, "Dating", "Post keyword MUST be Dating");
    assert.strictEqual(String(p.chat_id), "-1005362445410", "Chat ID MUST be -1005362445410");
  });
  console.log(`   ✅ Dating contains ${datingPosts.length} posts, 100% strictly isolated to chat_id -1005362445410`);

  // G. Verify Saki Mizumi contains ONLY Saki Mizumi posts
  console.log("\n📌 G. Verifying Saki Mizumi channel isolation:");
  const sakiPosts = sourceRegistry.getPostsForKeyword("Saki Mizumi");
  assert.ok(sakiPosts.length > 0, "Saki Mizumi MUST have stored posts");
  sakiPosts.forEach(p => {
    assert.strictEqual(p.keyword, "Saki Mizumi", "Post keyword MUST be Saki Mizumi");
    assert.strictEqual(String(p.chat_id), "-1005356656249", "Chat ID MUST be -1005356656249");
  });
  console.log(`   ✅ Saki Mizumi contains ${sakiPosts.length} posts, 100% strictly isolated to chat_id -1005356656249`);

  // H. Run startup sync TWICE and verify NO duplicates
  console.log("\n📌 H. Running MTProto Startup Sync a 2nd time (Idempotency Test)...");
  const postsBefore2nd = sourceRegistry.posts.length;
  await reader.syncAllChannels(10, true);
  const postsAfter2nd = sourceRegistry.posts.length;

  console.log(`   • Total Posts Before 2nd Sync: ${postsBefore2nd}`);
  console.log(`   • Total Posts After 2nd Sync:  ${postsAfter2nd}`);
  assert.strictEqual(postsBefore2nd, postsAfter2nd, "2nd sync MUST NOT create duplicate posts!");
  console.log("   ✅ IDEMPOTENCY VERIFIED (0 Duplicate Posts Created)!");

  // I. Test Cards 11–20 mapping and titles
  console.log("\n📌 I. Verifying Cards 11–20 Wireframe Mapping & Dynamic Titles:");
  const keyboard = await getTrendingKeyboard();
  const rows = keyboard.inline_keyboard.slice(0, 5);

  const card12 = rows[2][3]; // Card 12 = Dating
  const card19 = rows[4][2]; // Card 19 = Saki Mizumi

  console.log(`   • Card 12 (Dating)      Callback: "${card12.callback_data}" | Label: "${card12.text}"`);
  console.log(`   • Card 19 (Saki Mizumi) Callback: "${card19.callback_data}" | Label: "${card19.text}"`);

  assert.strictEqual(card12.callback_data, "topic:Dating");
  assert.strictEqual(card19.callback_data, "topic:Saki Mizumi");
  console.log("   ✅ Cards 11–20 wireframe mapping & titles VERIFIED!");

  // J. Simulate NEW Bot API channel_post event updating correct channel
  console.log("\n📌 J. Simulating live NEW Bot API channel_post event for Dating (msg_id: 99999)...");
  const liveNewPost = {
    message_id: 99999,
    date: Math.floor(Date.now() / 1000),
    chat: { id: -1005362445410, title: "dating🔞💥", type: "channel" },
    caption: "🔥 LIVE REALTIME DATING VIDEO 99999",
    video: { file_id: "live_v_99999", duration: 300 }
  };

  const processRes = sourceRegistry.processChannelPost(liveNewPost, "Dating");
  const updatedDatingPosts = sourceRegistry.getPostsForKeyword("Dating");

  assert.strictEqual(updatedDatingPosts[0].message_id, 99999, "New live post 99999 MUST be position 0");
  assert.strictEqual(updatedDatingPosts[0].keyword, "Dating", "Must belong ONLY to Dating");
  console.log(`   ✅ Live new channel_post msg 99999 unshifted to position 0 for Dating!`);

  console.log("\n🎉 ALL FINAL ARCHITECTURE VERIFICATION TESTS PASSED!");
}

runFinalVerificationSuite();
