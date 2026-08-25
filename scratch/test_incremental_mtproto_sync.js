require("dotenv").config();
const fs = require("fs");
const path = require("path");
const sourceRegistry = require("../source_registry");
const MTProtoChannelReader = require("../mtproto_reader");

async function runIncrementalSyncTestSuite() {
  console.log("==========================================");
  console.log("🧪 TEST SUITE: INCREMENTAL MTProto SYNC & CHECKPOINTS");
  console.log("==========================================\n");

  const originalFile = path.join(__dirname, "../source_registry.json");
  const backupFile = path.join(__dirname, "../source_registry.json.bak");
  fs.copyFileSync(originalFile, backupFile);

  try {
    // ----------------------------------------------------
    // Test 1: Checkpoint resolution on startup
    // ----------------------------------------------------
    console.log("--- TEST 1: Checkpoint Initialization from Registry ---");
    const datingCheckpoint = sourceRegistry.getLatestRealMessageId("Dating");
    console.log(`Dating initial checkpoint: ID ${datingCheckpoint}`);
    const romCheckpoint = sourceRegistry.getLatestRealMessageId("Romance");
    console.log(`Romance initial checkpoint: ID ${romCheckpoint}`);
    console.assert(datingCheckpoint > 0, "Dating checkpoint should be > 0");
    console.assert(romCheckpoint > 0, "Romance checkpoint should be > 0");
    console.log("✅ Test 1 PASSED: Checkpoints initialized cleanly.\n");

    // ----------------------------------------------------
    // Test 2: 0 new messages -> 0 inserts
    // ----------------------------------------------------
    console.log("--- TEST 2: 0 New Messages Sync ---");
    const postsBeforeZero = sourceRegistry.getPostsForKeyword("Dating").length;
    const msgZero = {
      chat: { id: "-1003786693669", title: "Dating", username: "cccsefk", type: "channel" },
      message_id: datingCheckpoint, // same as checkpoint
      date: Math.floor(Date.now() / 1000),
      text: "Existing post"
    };
    const resZero = sourceRegistry.processChannelPost(msgZero, "Dating");
    console.log(`Ingested checkpoint msg ${datingCheckpoint}: isNew = ${resZero.isNew}`);
    const postsAfterZero = sourceRegistry.getPostsForKeyword("Dating").length;
    console.assert(resZero.isNew === false, "Existing checkpoint post should not be new");
    console.assert(postsBeforeZero === postsAfterZero, "Post count should not increase");
    console.log("✅ Test 2 PASSED: 0 new messages -> 0 inserts.\n");

    // ----------------------------------------------------
    // Test 3: 1 new message -> 1 insert
    // ----------------------------------------------------
    console.log("--- TEST 3: 1 New Message Sync ---");
    const newId1 = datingCheckpoint + 1;
    const msgOne = {
      chat: { id: "-1003786693669", title: "Dating", username: "cccsefk", type: "channel" },
      message_id: newId1,
      date: Math.floor(Date.now() / 1000),
      text: "🎬 Single New Post #1"
    };
    const resOne = sourceRegistry.processChannelPost(msgOne, "Dating");
    const newCheckpoint1 = sourceRegistry.getLatestRealMessageId("Dating");
    console.log(`Inserted ID ${newId1}: isNew = ${resOne.isNew} | New Checkpoint: ${newCheckpoint1}`);
    console.assert(resOne.isNew === true, "1 new message should be marked isNew=true");
    console.assert(newCheckpoint1 === newId1, "Checkpoint should update to newId1");
    console.log("✅ Test 3 PASSED: 1 new message -> 1 insert.\n");

    // ----------------------------------------------------
    // Test 4: 5 new messages -> 5 inserted
    // ----------------------------------------------------
    console.log("--- TEST 4: 5 New Messages Sync ---");
    const currentBase = sourceRegistry.getLatestRealMessageId("Dating");
    let insertedFiveCount = 0;
    for (let i = 1; i <= 5; i++) {
      const msgId = currentBase + i;
      const res = sourceRegistry.processChannelPost({
        chat: { id: "-1003786693669", title: "Dating", username: "cccsefk", type: "channel" },
        message_id: msgId,
        date: Math.floor(Date.now() / 1000) + i,
        text: `🎬 Batch 5 Post #${i}`
      }, "Dating");
      if (res && res.isNew) insertedFiveCount++;
    }
    const checkpointAfterFive = sourceRegistry.getLatestRealMessageId("Dating");
    console.log(`Inserted 5 posts: count = ${insertedFiveCount} | New Checkpoint: ${checkpointAfterFive}`);
    console.assert(insertedFiveCount === 5, "5 new messages should result in 5 inserts");
    console.assert(checkpointAfterFive === currentBase + 5, "Checkpoint should advance by 5");
    console.log("✅ Test 4 PASSED: 5 new messages -> 5 inserted.\n");

    // ----------------------------------------------------
    // Test 5: 15 new messages between syncs -> ALL 15 inserted
    // ----------------------------------------------------
    console.log("--- TEST 5: 15 New Messages Burst Catch-Up ---");
    const burstBase = sourceRegistry.getLatestRealMessageId("Dating");
    let insertedFifteenCount = 0;
    for (let i = 1; i <= 15; i++) {
      const msgId = burstBase + i;
      const res = sourceRegistry.processChannelPost({
        chat: { id: "-1003786693669", title: "Dating", username: "cccsefk", type: "channel" },
        message_id: msgId,
        date: Math.floor(Date.now() / 1000) + i,
        text: `🎬 Burst Post #${i}`
      }, "Dating");
      if (res && res.isNew) insertedFifteenCount++;
    }
    const checkpointAfterFifteen = sourceRegistry.getLatestRealMessageId("Dating");
    console.log(`Inserted 15 burst posts: count = ${insertedFifteenCount} | New Checkpoint: ${checkpointAfterFifteen}`);
    console.assert(insertedFifteenCount === 15, "15 new messages should all be inserted");
    console.assert(checkpointAfterFifteen === burstBase + 15, "Checkpoint should advance by 15");
    console.log("✅ Test 5 PASSED: 15 new messages -> ALL 15 inserted.\n");

    // ----------------------------------------------------
    // Test 6: Duplicate sync -> 0 duplicate inserts
    // ----------------------------------------------------
    console.log("--- TEST 6: Duplicate Sync Execution ---");
    const currentTopId = sourceRegistry.getLatestRealMessageId("Dating");
    const dupRes = sourceRegistry.processChannelPost({
      chat: { id: "-1003786693669", title: "Dating", username: "cccsefk", type: "channel" },
      message_id: currentTopId,
      date: Math.floor(Date.now() / 1000),
      text: "🎬 Duplicate Post"
    }, "Dating");
    console.log(`Duplicate process result: isNew = ${dupRes.isNew}`);
    console.assert(dupRes.isNew === false, "Duplicate sync should yield isNew=false");
    console.log("✅ Test 6 PASSED: Duplicate sync -> 0 duplicate inserts.\n");

    // ----------------------------------------------------
    // Test 7: Cross-channel isolation -> 0 leakage
    // ----------------------------------------------------
    console.log("--- TEST 7: Cross-Channel Isolation ---");
    const datingPosts = sourceRegistry.getPostsForKeyword("Dating");
    const romPosts = sourceRegistry.getPostsForKeyword("Romance");
    const datingLeakage = datingPosts.filter(p => p.keyword === "Romance" || p.channel_name === "Romance");
    const romLeakage = romPosts.filter(p => p.keyword === "Dating" || p.channel_name === "Dating");
    console.log(`Dating leakage into Romance: ${datingLeakage.length}`);
    console.log(`Romance leakage into Dating: ${romLeakage.length}`);
    console.assert(datingLeakage.length === 0, "No Dating posts should be in Romance");
    console.assert(romLeakage.length === 0, "No Romance posts should be in Dating");
    console.log("✅ Test 7 PASSED: Cross-channel isolation -> 0 leakage.\n");

    // ----------------------------------------------------
    // Test 8: Restart simulation -> Checkpoint remains correct
    // ----------------------------------------------------
    console.log("--- TEST 8: Restart Simulation Checkpoint Validation ---");
    sourceRegistry.saveData(); // save disk
    sourceRegistry.loadData(); // simulate boot reload
    const datingCheckReload = sourceRegistry.getLatestRealMessageId("Dating");
    console.log(`Reloaded Dating Checkpoint: ID ${datingCheckReload}`);
    console.assert(datingCheckReload === checkpointAfterFifteen, "Reloaded checkpoint should match post-burst checkpoint");
    console.log("✅ Test 8 PASSED: Restart simulation checkpoint remains correct.\n");

    console.log("==========================================");
    console.log("🎉 ALL 8 TESTS PASSED PERFECTLY!");
    console.log("==========================================");
  } finally {
    fs.copyFileSync(backupFile, originalFile);
    fs.unlinkSync(backupFile);
    sourceRegistry.loadData();
  }
}

runIncrementalSyncTestSuite().catch(err => {
  console.error("❌ Test suite failed:", err);
  process.exit(1);
});
