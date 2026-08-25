require("dotenv").config();
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const sourceRegistry = require("../source_registry");

const TARGET_CHANNELS = [
  { name: "Romantic Vibe", username: "ccsfvk", chat_id: "-1005563024409" },
  { name: "Dating", username: "cccsefk", chat_id: "-1005362445410" },
  { name: "Romance", username: "e5brygh", chat_id: "-1005491187683" },
  { name: "Crotch", username: "ccdjxc", chat_id: "-1005296875877" },
  { name: "Mosa", username: "vsdxda", chat_id: "-1005427855016" },
  { name: "Bunny Girl Cosplay Date", username: "tfccdet", chat_id: "-1005353472623" },
  { name: "Lustful Hostess", username: "sfgfem", chat_id: "-1005591987853" },
  { name: "Concubine", username: "ddkicr", chat_id: "-1005394162064" },
  { name: "Saki Mizumi", username: "cccddghhgf", chat_id: "-1005356656249" },
  { name: "A Muse", username: "bzd4wrf", chat_id: "-1005476708057" }
];

async function diagnoseLiveMessages() {
  console.log("=== LIVE GRAMJS TELEGRAM MESSAGES DIAGNOSTIC ===\n");

  const apiId = parseInt(process.env.TELEGRAM_API_ID || "0", 10);
  const apiHash = process.env.TELEGRAM_API_HASH || "";
  const sessionString = process.env.TELEGRAM_SESSION_STRING || "";
  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 3,
  });

  await client.connect();
  console.log("📡 GramJS connected successfully.\n");

  for (const ch of TARGET_CHANNELS) {
    console.log(`====================================================`);
    console.log(`📌 CHANNEL: ${ch.name} (@${ch.username})`);
    console.log(`====================================================`);

    // 1. Get stored posts from source_registry.json
    const storedPosts = sourceRegistry.getPostsForKeyword(ch.name);
    const storedIds = storedPosts.map(p => p.message_id).filter(Boolean);
    const newestStoredId = Math.max(...storedIds.map(id => parseInt(id, 10)), 0);
    console.log(`Stored Posts Count in Registry : ${storedPosts.length}`);
    console.log(`Newest Stored Message ID       : ${newestStoredId}`);
    console.log(`All Stored Message IDs         : [${storedIds.slice(0, 10).join(", ")}]`);

    // 2. Fetch live messages from Telegram API via GramJS
    let entity = null;
    try {
      entity = await client.getEntity(ch.username);
    } catch (e) {
      console.error(`  ⚠️ getEntity failed for ${ch.username}:`, e.message);
    }

    if (entity) {
      const history = await client.invoke(
        new Api.messages.GetHistory({
          peer: entity,
          limit: 15,
        })
      );

      const msgs = history.messages || [];
      const liveIds = msgs.map(m => m.id);
      const newestLiveId = Math.max(...liveIds, 0);

      console.log(`Live Fetched Messages Count    : ${msgs.length}`);
      console.log(`Newest Live Message ID         : ${newestLiveId}`);
      console.log(`All Live Message IDs           : [${liveIds.join(", ")}]`);

      const liveDates = msgs.slice(0, 5).map(m => `${m.id}: ${new Date(m.date * 1000).toISOString().substr(11, 8)}`);
      console.log(`Live Message Dates (UTC)       : [${liveDates.join(", ")}]`);

      // Check if there are live message IDs > newestStoredId
      const newLiveMsgs = msgs.filter(m => m.id > newestStoredId);
      console.log(`Genuinely New Live Messages    : ${newLiveMsgs.length}`);
      if (newLiveMsgs.length > 0) {
        newLiveMsgs.forEach(m => console.log(`  ✨ NEW: ID ${m.id} | Date: ${new Date(m.date * 1000).toISOString()} | Title: "${(m.message || '').split('\n')[0].substr(0, 50)}"`));
      }
    }
    console.log("\n");
  }

  await client.disconnect();
}

diagnoseLiveMessages().catch(err => {
  console.error("❌ DIAGNOSTIC FAILED:", err);
  process.exit(1);
});
