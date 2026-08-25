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

async function runFullDiagnostics() {
  console.log("====================================================");
  console.log("📌 REAL DIAGNOSTIC REPORT FOR ALL 10 CHANNELS");
  console.log("====================================================\n");

  const reader = new MTProtoChannelReader();
  const results = await reader.syncAllChannels(10, true);

  console.log("CHANNEL DIAGNOSTIC RESULTS:\n");
  for (const r of results) {
    const src = sourceRegistry.sources.find(s => s.name === r.channel_name);
    const existingBefore = r.existing_before || 0;
    const fetched = r.fetched || 0;
    const newPosts = r.new_posts || 0;
    const inserted = r.inserted || 0;
    const duplicates = r.skipped || 0;
    const existingAfter = r.existing_after || 0;
    const username = src ? src.username : "unknown";
    const chatId = r.chat_id || (src ? src.chat_id : "unknown");

    console.log(`[Channel] ${r.channel_name}`);
    console.log(`  - Username       : @${username}`);
    console.log(`  - Telegram ChatID: ${chatId}`);
    console.log(`  - Existing Before: ${existingBefore}`);
    console.log(`  - Fetched        : ${fetched}`);
    console.log(`  - New Posts      : ${newPosts}`);
    console.log(`  - Inserted       : ${inserted}`);
    console.log(`  - Duplicates     : ${duplicates}`);
    console.log(`  - Existing After : ${existingAfter}\n`);
  }

  console.log("====================================================");
  console.log("📌 CROSS-CHANNEL ISOLATION TEST");
  console.log("====================================================\n");

  let totalCrossChannelLeakage = 0;
  for (const chObj of TARGET_CHANNELS) {
    const chName = chObj.name;
    const posts = sourceRegistry.getPostsForKeyword(chName);
    const otherChannels = TARGET_CHANNELS.filter(c => c.name !== chName);

    for (const p of posts) {
      for (const other of otherChannels) {
        const otherPosts = sourceRegistry.getPostsForKeyword(other.name);
        const leaked = otherPosts.some(op => op.id === p.id || (op.unique_hash && op.unique_hash === p.unique_hash));
        if (leaked) {
          console.error(`❌ LEAKAGE DETECTED: Post [${p.unique_hash}] from "${chName}" found in "${other.name}"!`);
          totalCrossChannelLeakage++;
        }
      }
    }
  }

  assert.strictEqual(totalCrossChannelLeakage, 0, "Cross-channel leakage MUST be 0!");
  console.log("✅ Cross-channel isolation test PASSED: 0 leakage detected across all 10 channels!\n");

  console.log("====================================================");
  console.log("📌 DUPLICATE PROTECTION TEST (SECOND SYNC)");
  console.log("====================================================\n");

  const secondSyncResults = await reader.syncAllChannels(10, true);
  let secondNew = 0;
  let secondInserted = 0;
  let secondDuplicates = 0;

  secondSyncResults.forEach(r => {
    secondNew += r.new_posts || 0;
    secondInserted += r.inserted || 0;
    secondDuplicates += r.skipped || 0;
  });

  console.log(`Second Sync Metrics: New = ${secondNew} | Inserted = ${secondInserted} | Duplicates Skipped = ${secondDuplicates}`);
  assert.strictEqual(secondNew, 0, "Second sync MUST produce 0 new messages");
  assert.strictEqual(secondInserted, 0, "Second sync MUST produce 0 inserted messages");
  console.log("✅ Duplicate protection test PASSED: 0 duplicates inserted!\n");

  console.log("🎉 ALL DIAGNOSTIC & VERIFICATION TESTS PASSED!");
}

runFullDiagnostics().catch(err => {
  console.error("❌ DIAGNOSTIC FAILED:", err);
  process.exit(1);
});
