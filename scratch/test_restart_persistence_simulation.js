require("dotenv").config();
const fs = require("fs");
const path = require("path");
const sourceRegistry = require("../source_registry");

function runRestartSimulationTest() {
  console.log("=== SIMULATION: RAILWAY RESTART & RUNTIME PERSISTENCE ===\n");

  const originalFile = path.join(__dirname, "../source_registry.json");
  const backupFile = path.join(__dirname, "../source_registry.json.bak");
  fs.copyFileSync(originalFile, backupFile);

  try {
    // 1. Ingest a runtime post into Dating
    const datingBefore = sourceRegistry.getPostsForKeyword("Dating");
    const maxId = Math.max(...datingBefore.map(p => parseInt(p.message_id || 0, 10)), 0);
    const runtimeMsgId = maxId + 999;

    const runtimeMsg = {
      message_id: runtimeMsgId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: "-1003786693669", title: "Dating", username: "cccsefk", type: "channel" },
      text: "🎬 🔥 Runtime Only Post (Uncommitted)"
    };

    sourceRegistry.processChannelPost(runtimeMsg, "Dating");
    console.log(`1. Runtime Post Ingested: ID ${runtimeMsgId}`);

    const datingWithRuntime = sourceRegistry.getPostsForKeyword("Dating");
    const foundInRuntime = datingWithRuntime.some(p => p.message_id === runtimeMsgId);
    console.log(`   Exists in active runtime memory: ${foundInRuntime}`);

    // 2. Simulate Railway Container Restart / Redeployment by restoring original committed Git file
    fs.copyFileSync(backupFile, originalFile);
    sourceRegistry.loadData();
    console.log("\n2. Simulated Container Restart (Restored Git committed disk state)");

    const datingAfterRestart = sourceRegistry.getPostsForKeyword("Dating");
    const foundAfterRestart = datingAfterRestart.some(p => p.message_id === runtimeMsgId);
    console.log(`   Exists after container restart: ${foundAfterRestart}`);

    console.log("\n📌 RESULT: Runtime-added posts written ONLY to ephemeral disk do NOT survive container restart unless re-fetched from Telegram API on boot.");
  } finally {
    fs.copyFileSync(backupFile, originalFile);
    fs.unlinkSync(backupFile);
  }
}

runRestartSimulationTest();
