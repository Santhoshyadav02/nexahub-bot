require("dotenv").config();
const assert = require("assert");
const sourceRegistry = require("../source_registry");
const MTProtoChannelReader = require("../mtproto_reader");

const TARGET_CHANNELS = [
  { name: "Romantic Vibe", username: "ccsfvk" },
  { name: "Dating", username: "cccsefk" },
  { name: "Romance", username: "e5brygh" },
  { name: "Crotch", username: "ccdjxc" },
  { name: "Mosa", username: "vsdxda" },
  { name: "Bunny Girl Cosplay Date", username: "tfccdet" },
  { name: "Lustful Hostess", username: "sfgfem" },
  { name: "Concubine", username: "ddkicr" },
  { name: "Saki Mizumi", username: "cccddghhgf" },
  { name: "A Muse", username: "bzd4wrf" }
];

async function runRealMTProtoEndToEndTest() {
  console.log("====================================================");
  console.log("📌 REAL MTPROTO SYNC EXECUTION #1 (LIVE TELEGRAM FETCH)");
  console.log("====================================================\n");

  const reader1 = new MTProtoChannelReader();
  const firstSyncResults = await reader1.syncAllChannels(10, true);

  console.log("--- FIRST SYNC RESULTS ---");
  for (const r of firstSyncResults) {
    const channelName = r.channel_name;
    const fetchedCount = r.fetched || 0;
    const newestFetchedId = r.latest_msg_id || "None";

    const storedPosts = sourceRegistry.getPostsForKeyword(channelName);
    const newestStoredId = storedPosts.length > 0 ? storedPosts[0].message_id : "None";

    console.log(`[Channel] ${channelName}`);
    console.log(`  - Fetched Messages  : ${fetchedCount}`);
    console.log(`  - Newest Fetched ID : ${newestFetchedId}`);
    console.log(`  - Newest Stored ID  : ${newestStoredId}`);
    console.log(`  - Retained in DB    : ${storedPosts.length} posts`);

    assert.ok(storedPosts.length > 0, `Registry MUST retain posts for ${channelName}`);
    if (newestFetchedId !== "None" && typeof newestFetchedId === "number") {
      assert.strictEqual(storedPosts[0].message_id, newestFetchedId, `Newest fetched ID ${newestFetchedId} MUST be at top of retained registry for ${channelName}`);
    }
    console.log(`  ✅ Newest real Telegram message [ID ${newestFetchedId}] successfully retained at top of registry!\n`);
  }

  console.log("====================================================");
  console.log("📌 REAL MTPROTO SYNC EXECUTION #2 (IDEMPOTENCY VERIFICATION)");
  console.log("====================================================\n");

  const reader2 = new MTProtoChannelReader();
  const secondSyncResults = await reader2.syncAllChannels(10, true);

  let secondNewTotal = 0;
  let secondInsertedTotal = 0;
  let secondSkippedTotal = 0;

  secondSyncResults.forEach(r => {
    secondNewTotal += r.new_posts || 0;
    secondInsertedTotal += r.inserted || 0;
    secondSkippedTotal += r.skipped || 0;
  });

  console.log(`SECOND SYNC SUMMARY: New = ${secondNewTotal} | Inserted = ${secondInsertedTotal} | Duplicates Skipped = ${secondSkippedTotal}`);
  assert.strictEqual(secondNewTotal, 0, "Second sync MUST produce New = 0");
  assert.strictEqual(secondInsertedTotal, 0, "Second sync MUST produce Inserted = 0");
  console.log("   ✅ SECOND SYNC IDEMPOTENCY PASSED: New = 0, Inserted = 0, Duplicates Skipped = All fetched.\n");

  console.log("====================================================");
  console.log("📌 CROSS-CHANNEL ISOLATION VERIFICATION");
  console.log("====================================================\n");

  let crossChannelLeakage = 0;
  for (const ch of TARGET_CHANNELS) {
    const posts = sourceRegistry.getPostsForKeyword(ch.name);
    const otherChannels = TARGET_CHANNELS.filter(c => c.name !== ch.name);

    for (const p of posts) {
      for (const other of otherChannels) {
        const otherPosts = sourceRegistry.getPostsForKeyword(other.name);
        const leaked = otherPosts.some(op => op.id === p.id || (op.unique_hash && op.unique_hash === p.unique_hash));
        if (leaked) {
          console.error(`❌ LEAKAGE DETECTED: Post [${p.unique_hash}] from "${ch.name}" found in "${other.name}"!`);
          crossChannelLeakage++;
        }
      }
    }
  }

  assert.strictEqual(crossChannelLeakage, 0, "Cross-channel leakage MUST be 0!");
  console.log("   ✅ CROSS-CHANNEL ISOLATION PASSED: 0 leakage across all 10 channels!\n");

  console.log("====================================================");
  console.log("📌 BOT RELATED-VIDEO LIST READINESS VERIFICATION");
  console.log("====================================================\n");

  for (const ch of TARGET_CHANNELS) {
    const videoList = sourceRegistry.getPostsForKeyword(ch.name);
    console.log(`[Bot List] ${ch.name}: ${videoList.length} items available`);
    assert.ok(videoList.length > 0, `Bot related-video list MUST contain posts for ${ch.name}`);
    console.log(`  - Top Item Title: "${videoList[0].title}"`);
    console.log(`  - Top Item URL  : ${videoList[0].telegram_url}`);
  }

  console.log("\n🎉 ALL REAL MTPROTO END-TO-END VERIFICATION TESTS PASSED!");
  console.log("\nREADY FOR DEPLOYMENT");
}

runRealMTProtoEndToEndTest().catch(err => {
  console.error("❌ E2E TEST FAILED:", err);
  process.exit(1);
});
