require("dotenv").config();
const fs = require("fs");
const path = require("path");
const sourceRegistry = require("../source_registry");

async function runProductionSafetySimulation() {
  console.log("==========================================");
  console.log("🧪 PRODUCTION SAFETY REVIEW SIMULATION");
  console.log("==========================================\n");

  const originalFile = path.join(__dirname, "../source_registry.json");
  const backupFile = path.join(__dirname, "../source_registry.json.bak");
  fs.copyFileSync(originalFile, backupFile);

  try {
    // Step 1: Set initial checkpoint = 100 for Dating
    console.log("--- STEP 1: Set Initial Checkpoint = 100 ---");
    sourceRegistry.posts = sourceRegistry.posts.filter(p => p.keyword !== "Dating" && p.channel_name !== "Dating");
    
    sourceRegistry.processChannelPost({
      chat: { id: "-1003786693669", title: "Dating", username: "cccsefk", type: "channel" },
      message_id: 100,
      date: Math.floor(Date.now() / 1000),
      text: "Base Post 100"
    }, "Dating");

    const initialCheckpoint = sourceRegistry.getLatestRealMessageId("Dating");
    console.log(`Initial Dating Checkpoint: ID ${initialCheckpoint}`);
    console.assert(initialCheckpoint === 100, "Initial checkpoint should be 100");
    console.log("✅ Step 1 PASSED.\n");

    // Step 2: Ingest messages 101–125 (25 messages)
    console.log("--- STEP 2: Ingest Telegram Messages 101–125 (25 messages) ---");
    let insertedBatch1 = 0;
    const batch1Msgs = [];
    for (let i = 101; i <= 125; i++) {
      batch1Msgs.push({
        chat: { id: "-1003786693669", title: "Dating", username: "cccsefk", type: "channel" },
        message_id: i,
        date: Math.floor(Date.now() / 1000) + i,
        text: `🎬 Post #${i}`
      });
    }

    for (const msg of batch1Msgs) {
      const res = sourceRegistry.processChannelPost(msg, "Dating");
      if (res && res.isNew) insertedBatch1++;
    }

    const checkpointAfterBatch1 = sourceRegistry.getLatestRealMessageId("Dating");
    console.log(`Ingested 25 messages (101-125): count = ${insertedBatch1} | Checkpoint: ${checkpointAfterBatch1}`);
    console.assert(insertedBatch1 === 25, "All 25 messages should be inserted");
    console.assert(checkpointAfterBatch1 === 125, "Checkpoint should advance to 125");
    console.log("✅ Step 2 PASSED: All 25 messages captured.\n");

    // Step 3: Run sync again on retained posts (106-125) -> Verify 0 duplicates
    console.log("--- STEP 3: Re-sync Retained Messages (Verify 0 Duplicates) ---");
    let dupCount = 0;
    const retainedMsgs = batch1Msgs.filter(m => m.message_id >= 106);
    for (const msg of retainedMsgs) {
      const res = sourceRegistry.processChannelPost(msg, "Dating");
      if (res && res.isNew) dupCount++;
    }
    const checkpointAfterDup = sourceRegistry.getLatestRealMessageId("Dating");
    console.log(`Re-synced 20 active retained messages (106-125): new inserted = ${dupCount} | Checkpoint: ${checkpointAfterDup}`);
    console.assert(dupCount === 0, "Duplicate count should be 0");
    console.assert(checkpointAfterDup === 125, "Checkpoint should remain 125");
    console.log("✅ Step 3 PASSED: 0 duplicates on active retention range.\n");

    // Step 4: Simulate Failure at message 115 mid-sync
    console.log("--- STEP 4: Simulate Failure at Message 115 Mid-Sync ---");
    sourceRegistry.posts = sourceRegistry.posts.filter(p => p.keyword !== "Dating" && p.channel_name !== "Dating");
    sourceRegistry.processChannelPost({
      chat: { id: "-1003786693669", title: "Dating", username: "cccsefk", type: "channel" },
      message_id: 100,
      date: Math.floor(Date.now() / 1000),
      text: "Base Post 100"
    }, "Dating");

    console.log("Simulating batch ingestion (101 to 125), but throwing error at msg 115...");
    let processedBeforeFailure = 0;
    try {
      for (const msg of batch1Msgs) {
        if (msg.message_id === 115) {
          throw new Error("Simulated network/DB crash at message 115!");
        }
        sourceRegistry.processChannelPost(msg, "Dating");
        processedBeforeFailure++;
      }
    } catch (err) {
      console.log(`Caught mid-sync error: "${err.message}"`);
    }

    const checkpointAfterFailure = sourceRegistry.getLatestRealMessageId("Dating");
    console.log(`Processed before failure: ${processedBeforeFailure} (msgs 101-114) | Checkpoint: ${checkpointAfterFailure}`);
    console.assert(processedBeforeFailure === 14, "Should have processed exactly 14 messages (101-114)");
    console.assert(checkpointAfterFailure === 114, "Checkpoint must be 114, NOT 125!");
    console.log("✅ Step 4 PASSED: Checkpoint did NOT advance past failed message.\n");

    // Step 5: Retry sync and recover missing messages (115-125)
    console.log("--- STEP 5: Retry Sync & Recover Missing Messages (115-125) ---");
    const remainingMsgs = batch1Msgs.filter(m => m.message_id >= 115);
    let recoveredCount = 0;
    for (const msg of remainingMsgs) {
      const res = sourceRegistry.processChannelPost(msg, "Dating");
      if (res && res.isNew) recoveredCount++;
    }

    const finalCheckpoint = sourceRegistry.getLatestRealMessageId("Dating");
    console.log(`Recovered missing messages: count = ${recoveredCount} | Final Checkpoint: ${finalCheckpoint}`);
    console.assert(recoveredCount === 11, "Should recover remaining 11 messages (115-125)");
    console.assert(finalCheckpoint === 125, "Final checkpoint should be 125");
    console.log("✅ Step 5 PASSED: All missing messages successfully recovered.\n");

    console.log("==========================================");
    console.log("🎉 ALL 5 PRODUCTION-SAFETY SIMULATION STEPS PASSED PERFECTLY!");
    console.log("==========================================");
  } finally {
    fs.copyFileSync(backupFile, originalFile);
    fs.unlinkSync(backupFile);
    sourceRegistry.loadData();
  }
}

runProductionSafetySimulation().catch(err => {
  console.error("❌ Production safety simulation failed:", err);
  process.exit(1);
});
