require("dotenv").config();
const assert = require("assert");
const sourceRegistry = require("../source_registry");
const MTProtoChannelReader = require("../mtproto_reader");
const { refreshTelegramPosts } = require("../scraper");

async function runPeriodicMTProtoSyncTest() {
  console.log("=== COMPREHENSIVE MTPROTO PERIODIC SYNC TEST ===\n");

  // -------------------------------------------------------------
  // TEST 1: Controlled Message Ingestion & URL Generation
  // -------------------------------------------------------------
  console.log("📌 TEST 1: Controlled Test Post Ingestion & Canonical URL Generation");
  const testMsgId = 998877;
  const datingChatId = "-1005362445410"; // Dating chat ID
  const testPostTitle = "SYNC_TEST_20260821_01";

  const dummyMessage = {
    message_id: testMsgId,
    date: Math.floor(Date.now() / 1000),
    chat: {
      id: datingChatId,
      title: "Dating",
      username: "cccsefk",
      type: "channel"
    },
    text: testPostTitle,
    caption: testPostTitle
  };

  const firstIngestRes = sourceRegistry.processChannelPost(dummyMessage, "Dating");
  assert.ok(firstIngestRes, "Post ingestion must return a result object");
  assert.strictEqual(firstIngestRes.isNew, true, "First ingestion MUST be marked as isNew = true");

  const datingPosts = sourceRegistry.getPostsForKeyword("Dating");
  const ingestedPost = datingPosts.find(p => p.message_id === testMsgId);
  assert.ok(ingestedPost, "Controlled test post must exist in Dating keyword list");
  assert.strictEqual(ingestedPost.telegram_url, `https://t.me/cccsefk/${testMsgId}`, "URL MUST be canonical public URL https://t.me/cccsefk/998877");
  console.log(`   ✅ Ingested controlled post: "${testPostTitle}"`);
  console.log(`   ✅ Generated canonical URL: ${ingestedPost.telegram_url}`);

  // -------------------------------------------------------------
  // TEST 2: Cross-Channel Isolation
  // -------------------------------------------------------------
  console.log("\n📌 TEST 2: Cross-Channel Isolation Verification");
  const mosaPosts = sourceRegistry.getPostsForKeyword("Mosa");
  const aMusePosts = sourceRegistry.getPostsForKeyword("A Muse");
  const romanticVibePosts = sourceRegistry.getPostsForKeyword("Romantic Vibe");

  const foundInMosa = mosaPosts.some(p => p.message_id === testMsgId || p.title.includes("SYNC_TEST_20260821_01"));
  const foundInAMuse = aMusePosts.some(p => p.message_id === testMsgId || p.title.includes("SYNC_TEST_20260821_01"));
  const foundInRomantic = romanticVibePosts.some(p => p.message_id === testMsgId || p.title.includes("SYNC_TEST_20260821_01"));

  assert.strictEqual(foundInMosa, false, "Dating post MUST NOT leak into Mosa");
  assert.strictEqual(foundInAMuse, false, "Dating post MUST NOT leak into A Muse");
  assert.strictEqual(foundInRomantic, false, "Dating post MUST NOT leak into Romantic Vibe");
  console.log("   ✅ Confirmed zero cross-channel leakage! Dating post appears ONLY under Dating.");

  // -------------------------------------------------------------
  // TEST 3: Duplicate Protection & Idempotency
  // -------------------------------------------------------------
  console.log("\n📌 TEST 3: Duplicate Protection & Idempotency Verification");
  const secondIngestRes = sourceRegistry.processChannelPost(dummyMessage, "Dating");
  assert.strictEqual(secondIngestRes.isNew, false, "Second ingestion of identical message MUST be marked as isNew = false");
  console.log("   ✅ Duplicate message correctly detected and skipped (isNew = false).");

  // -------------------------------------------------------------
  // TEST 4: Full Channel Periodic Synchronization Simulation
  // -------------------------------------------------------------
  console.log("\n📌 TEST 4: Full Periodic Channel Synchronization Execution");
  
  if (process.env.TELEGRAM_SESSION_STRING) {
    console.log("📡 TELEGRAM_SESSION_STRING present. Executing live refreshTelegramPosts()...\n");
    await refreshTelegramPosts();
  } else {
    console.log("ℹ️ Mocking MTProto reader for 10 channels verification...");
    const reader = new MTProtoChannelReader();
    // Stub getEntity / invoke for dry run testing if session is missing
    const results = await reader.syncAllChannels(5, false);
    assert.strictEqual(results.length, 10, "Must check exactly 10 channels");
    console.log(`   ✅ Checked ${results.length} channels successfully.`);
  }

  console.log("\n🎉 COMPREHENSIVE MTPROTO PERIODIC SYNC TEST PASSED!");
}

runPeriodicMTProtoSyncTest().catch(err => {
  console.error("❌ TEST FAILED:", err);
  process.exit(1);
});
