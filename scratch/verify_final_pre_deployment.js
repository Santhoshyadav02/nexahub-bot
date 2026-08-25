require("dotenv").config();
const assert = require("assert");
const fs = require("fs");
const sourceRegistry = require("../source_registry");
const MTProtoChannelReader = require("../mtproto_reader");

const TARGET_CHANNELS = [
  "Romantic Vibe", "Dating", "Romance", "Crotch", "Mosa",
  "Bunny Girl Cosplay Date", "Lustful Hostess", "Concubine", "Saki Mizumi", "A Muse"
];

async function runFinalPreDeploymentCheck() {
  console.log("====================================================");
  console.log("📌 FIRST SYNC EXECUTION");
  console.log("====================================================\n");

  const reader1 = new MTProtoChannelReader();
  const firstSyncResults = await reader1.syncAllChannels(10, true);

  let fetched1 = 0, new1 = 0, inserted1 = 0, skipped1 = 0, errors1 = 0;
  firstSyncResults.forEach(r => {
    fetched1 += r.fetched || 0;
    new1 += r.new_posts || 0;
    inserted1 += r.inserted || 0;
    skipped1 += r.skipped || 0;
    if (r.history_status === "ERROR") errors1++;
  });

  console.log("FIRST SYNC:");
  console.log(`Fetched: ${fetched1}`);
  console.log(`New: ${new1}`);
  console.log(`Inserted: ${inserted1}`);
  console.log(`Duplicates: ${skipped1}`);
  console.log(`Errors: ${errors1}\n`);

  console.log("====================================================");
  console.log("📌 SECOND SYNC EXECUTION (IDEMPOTENCY VERIFICATION)");
  console.log("====================================================\n");

  const reader2 = new MTProtoChannelReader();
  const secondSyncResults = await reader2.syncAllChannels(10, true);

  let fetched2 = 0, new2 = 0, inserted2 = 0, skipped2 = 0, errors2 = 0;
  secondSyncResults.forEach(r => {
    fetched2 += r.fetched || 0;
    new2 += r.new_posts || 0;
    inserted2 += r.inserted || 0;
    skipped2 += r.skipped || 0;
    if (r.history_status === "ERROR") errors2++;
  });

  console.log("SECOND SYNC:");
  console.log(`Fetched: ${fetched2}`);
  console.log(`New: ${new2}`);
  console.log(`Inserted: ${inserted2}`);
  console.log(`Duplicates: ${skipped2}`);
  console.log(`Errors: ${errors2}\n`);

  assert.strictEqual(new2, 0, "Second sync MUST have New = 0");
  assert.strictEqual(inserted2, 0, "Second sync MUST have Inserted = 0");

  console.log("====================================================");
  console.log("📌 CROSS-CHANNEL ISOLATION & CANONICAL URL CHECK");
  console.log("====================================================\n");

  for (const ch of TARGET_CHANNELS) {
    const posts = sourceRegistry.getPostsForKeyword(ch);
    posts.forEach(p => {
      if (p.username) {
        assert.ok(p.telegram_url.startsWith(`https://t.me/${p.username}/`), `URL format invalid for post ${p.id}`);
      }
      // Check cross-channel isolation
      const otherChannels = TARGET_CHANNELS.filter(c => c !== ch);
      otherChannels.forEach(oc => {
        const otherPosts = sourceRegistry.getPostsForKeyword(oc);
        const match = otherPosts.some(op => op.id === p.id);
        assert.strictEqual(match, false, `Post ${p.id} from ${ch} leaked into ${oc}`);
      });
    });
  }
  console.log("✅ All public URLs match canonical https://t.me/<username>/<message_id>");
  console.log("✅ Cross-channel isolation 100% verified across all 10 channels!");
}

runFinalPreDeploymentCheck().catch(err => {
  console.error("❌ VERIFICATION FAILED:", err);
  process.exit(1);
});
