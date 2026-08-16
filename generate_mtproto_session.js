require("dotenv").config();
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input");

const apiId = parseInt(process.env.TELEGRAM_API_ID, 10);
const apiHash = process.env.TELEGRAM_API_HASH;

if (!apiId || !apiHash) {
  console.error("❌ Error: TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in .env!");
  process.exit(1);
}

const stringSession = new StringSession("");

(async () => {
  console.log("=== TELEGRAM MTPROTO USER ACCOUNT SESSION GENERATOR ===\n");
  console.log(`Connecting to Telegram MTProto API (API_ID: ${apiId})...\n`);

  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await input.text("📱 Enter your Telegram phone number (international format e.g. +1234567890): "),
    password: async () => await input.password("🔒 Enter your 2FA password (if enabled, press Enter to skip): "),
    phoneCode: async () => await input.text("💬 Enter the Telegram login verification code sent to your app: "),
    onError: (err) => console.error("Login Error:", err.message),
  });

  console.log("\n✅ Authenticated successfully as Telegram User Account!");
  console.log("\n🔑 YOUR TELEGRAM_SESSION_STRING:\n");
  console.log(client.session.save());
  console.log("\n📋 Copy the above session string and add it to D:\\Automation\\hiruboy\\.env as:");
  console.log("TELEGRAM_SESSION_STRING=<your_generated_session_string>\n");

  await client.disconnect();
})();
