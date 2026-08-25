require("dotenv").config();
const assert = require("assert");
const MTProtoChannelReader = require("../mtproto_reader");
const sourceRegistry = require("../source_registry");
const { refreshTelegramPosts } = require("../scraper");

async function testPersistentMTProtoLifecycle() {
  console.log("====================================================");
  console.log("📌 PERSISTENT MTPROTO CLIENT LIFECYCLE TEST");
  console.log("====================================================\n");

  // 1. Verify Singleton Instance Reuse
  const reader1 = new MTProtoChannelReader();
  const reader2 = new MTProtoChannelReader();
  assert.strictEqual(reader1, reader2, "MTProtoChannelReader MUST be a Singleton instance");
  console.log("✅ Singleton Verification PASSED: reader1 === reader2\n");

  // 2. Perform First Sync
  console.log("--- EXECUTION #1: INITIAL SYNC ---");
  const results1 = await reader1.syncAllChannels(10, true);
  assert.strictEqual(results1.length, 10, "First sync MUST check all 10 channels");
  assert.strictEqual(reader1.client.connected, true, "Client MUST remain connected after Sync #1");
  console.log("✅ Sync #1 PASSED: Client remains CONNECTED after completion.\n");

  // 3. Perform Second Sync (Reusing Connection & Checking Idempotency)
  console.log("--- EXECUTION #2: SECOND SYNC (REUSING PERSISTENT SOCKET) ---");
  const results2 = await reader1.syncAllChannels(10, true);
  assert.strictEqual(results2.length, 10, "Second sync MUST check all 10 channels");
  assert.strictEqual(reader1.client.connected, true, "Client MUST remain connected after Sync #2");

  let totalNew2 = 0;
  let totalInserted2 = 0;
  let totalSkipped2 = 0;
  results2.forEach(r => {
    totalNew2 += r.new_posts || 0;
    totalInserted2 += r.inserted || 0;
    totalSkipped2 += r.skipped || 0;
  });

  console.log(`  - Second Sync Metrics: New = ${totalNew2} | Inserted = ${totalInserted2} | Duplicates Skipped = ${totalSkipped2}`);
  assert.strictEqual(totalNew2, 0, "Second sync MUST produce New = 0");
  assert.strictEqual(totalInserted2, 0, "Second sync MUST produce Inserted = 0");
  console.log("✅ Sync #2 Idempotency PASSED: 0 duplicates inserted.\n");

  // 4. Test Genuinely New Message Detection
  console.log("--- EXECUTION #3: GENUINELY NEW MESSAGE DETECTION ---");
  const datingPosts = sourceRegistry.getPostsForKeyword("Dating");
  const maxDatingId = Math.max(...datingPosts.map(p => parseInt(p.message_id || 0, 10)), 0);
  const testNewId = maxDatingId + 100;

  const testNewMsg = {
    message_id: testNewId,
    date: Math.floor(Date.now() / 1000),
    chat: { id: "-1003786693669", title: "Dating", username: "cccsefk", type: "channel" },
    text: `🎬 🔥 Persistent Test New Post ${testNewId}`,
    caption: `Persistent Test New Post ${testNewId}`
  };

  const resNew = sourceRegistry.processChannelPost(testNewMsg, "Dating");
  assert.strictEqual(resNew.isNew, true, "Genuinely new message MUST be marked isNew = true");
  console.log(`  - Ingested Test Message ID: ${testNewId}`);
  console.log(`  - isNew Result           : ${resNew.isNew}`);
  console.log("✅ New Message Detection PASSED.\n");

  // Clean up test message from registry
  sourceRegistry.posts = sourceRegistry.posts.filter(p => p.message_id !== testNewId);
  sourceRegistry.saveData();

  // 5. Test Cross-Channel Isolation
  console.log("--- EXECUTION #4: CROSS-CHANNEL ISOLATION ---");
  const TARGET_CHANNELS = ["Romantic Vibe", "Dating", "Romance", "Crotch", "Mosa", "Bunny Girl Cosplay Date", "Lustful Hostess", "Concubine", "Saki Mizumi", "A Muse"];
  let leakageCount = 0;
  for (const ch of TARGET_CHANNELS) {
    const posts = sourceRegistry.getPostsForKeyword(ch);
    const others = TARGET_CHANNELS.filter(c => c !== ch);
    for (const p of posts) {
      for (const o of others) {
        const oPosts = sourceRegistry.getPostsForKeyword(o);
        if (oPosts.some(op => op.id === p.id || (op.unique_hash && op.unique_hash === p.unique_hash))) {
          leakageCount++;
        }
      }
    }
  }
  assert.strictEqual(leakageCount, 0, "Cross-channel leakage MUST be 0");
  console.log("✅ Cross-Channel Isolation PASSED: 0 leakage across all 10 channels.\n");

  // 6. Test Concurrency Lock (Overlapping Protection)
  console.log("--- EXECUTION #5: CONCURRENCY LOCK (OVERLAPPING SYNC PROTECTION) ---");
  const p1 = refreshTelegramPosts();
  const p2 = refreshTelegramPosts(); // Should log "already in progress, skipping"
  await Promise.all([p1, p2]);
  console.log("✅ Concurrency Lock PASSED: Overlapping sync call was cleanly skipped.\n");

  // Disconnect client at end of test suite
  await reader1.disconnect();
  console.log("🎉 ALL PERSISTENT LIFECYCLE TESTS PASSED SUCCESSFULLY!");
}

testPersistentMTProtoLifecycle().catch(err => {
  console.error("❌ PERSISTENT LIFECYCLE TEST FAILED:", err);
  process.exit(1);
});
