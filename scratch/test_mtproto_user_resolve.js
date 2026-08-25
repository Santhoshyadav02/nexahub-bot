require("D:\\Automation\\hiruboy\\node_modules\\dotenv").config({ path: "D:\\Automation\\hiruboy\\.env" });
const { TelegramClient, Api } = require("D:\\Automation\\hiruboy\\node_modules\\telegram");
const { StringSession } = require("D:\\Automation\\hiruboy\\node_modules\\telegram\\sessions");

const apiId = parseInt(process.env.TELEGRAM_API_ID, 10);
const apiHash = process.env.TELEGRAM_API_HASH;
const sessionString = process.env.TELEGRAM_SESSION_STRING || "";

if (!apiId || !apiHash || !sessionString) {
  console.error("❌ Error: TELEGRAM_API_ID, TELEGRAM_API_HASH, and TELEGRAM_SESSION_STRING must be set in .env!");
  process.exit(1);
}

const TARGET_CHANNELS = [
  { name: "Romantic Vibe", hash: "AGVRDJ6c7M9lMGRh" },
  { name: "Dating", hash: "I3z-vJdRRV8xZDlh" },
  { name: "Romance", hash: "3g-HIjq_KgtkZDE5" },
  { name: "Crotch", hash: "8MHLLZRd1L5jMzhh" },
  { name: "Mosa", hash: "hdaykD30jbdhNzlh" },
  { name: "Bunny Girl Cosplay Date", hash: "5jGUuJ_HWLg5ZWRh" },
  { name: "Lustful Hostess", hash: "IypAk6ypLrM1Y2Rh" },
  { name: "Concubine", hash: "McyWlyEXgEdkY2Jh" },
  { name: "Saki Mizumi", hash: "Kr4JkikOPjtmNTNh" },
  { name: "A Muse", hash: "e-JQoCwT8wMyM2Zh" }
];

async function resolveChannels() {
  console.log("=== TELEGRAM USER MTPROTO INVITE LINK RESOLUTION TEST ===\n");
  console.log("Connecting via User Account StringSession...");

  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 3,
  });

  try {
    await client.connect();
    console.log("✅ Authenticated & Connected to Telegram MTProto API!\n");

    const reports = [];

    for (const ch of TARGET_CHANNELS) {
      let accessible = "NO";
      let resolvedChatId = "N/A";
      let title = "Unknown";

      try {
        const inviteInfo = await client.invoke(
          new Api.messages.CheckChatInvite({ hash: ch.hash })
        );

        if (inviteInfo instanceof Api.ChatInviteAlready) {
          accessible = "YES";
          const chat = inviteInfo.chat;
          title = chat.title || ch.name;
          const rawId = String(chat.id);
          resolvedChatId = rawId.startsWith("-100") ? rawId : `-100${rawId}`;
        } else if (inviteInfo instanceof Api.ChatInvite) {
          accessible = "PREVIEW_OK";
          title = inviteInfo.title || ch.name;
          resolvedChatId = "Pending Join";
        }
      } catch (err) {
        title = `Error: ${err.message}`;
      }

      reports.push({
        name: ch.name,
        accessible,
        resolvedChatId,
        title
      });
    }

    console.log("Channel".padEnd(25) + " | " + "Accessible".padEnd(12) + " | " + "Resolved Chat ID".padEnd(18) + " | " + "Title");
    console.log("-".repeat(80));

    for (const r of reports) {
      console.log(
        r.name.padEnd(25) + " | " +
        r.accessible.padEnd(12) + " | " +
        r.resolvedChatId.padEnd(18) + " | " +
        r.title
      );
    }
    console.log("-".repeat(80));

  } catch (err) {
    console.error("❌ MTProto Error:", err.message);
  } finally {
    await client.disconnect();
  }
}

resolveChannels();
