require("dotenv").config();
const assert = require("assert");
const TelegramBot = require("node-telegram-bot-api");

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("No BOT_TOKEN found in .env");
  process.exit(1);
}

async function testMainModulePollingStartup() {
  console.log("=== SAFE TELEGRAM BOT POLLING STARTUP TEST ===");

  const bot = new TelegramBot(token, {
    polling: {
      params: {
        allowed_updates: ["message", "edited_message", "channel_post", "edited_channel_post", "callback_query"]
      }
    }
  });

  console.log("1. Checking bot.isPolling():", bot.isPolling());
  assert.strictEqual(bot.isPolling(), true, "bot.isPolling() MUST return true when polling is enabled!");

  console.log("2. Calling bot.getMe() via HTTP Telegram Bot API...");
  const botInfo = await bot.getMe();
  console.log(`   ✅ getMe Successful! Bot Username: @${botInfo.username} (ID: ${botInfo.id})`);

  console.log("3. Gracefully stopping polling...");
  await bot.stopPolling();
  console.log("   ✅ bot.stopPolling() completed cleanly. bot.isPolling() =", bot.isPolling());
  assert.strictEqual(bot.isPolling(), false, "bot.isPolling() MUST return false after stopPolling!");

  console.log("\n🎉 SAFE TELEGRAM BOT POLLING STARTUP TEST PASSED!");
  process.exit(0);
}

testMainModulePollingStartup().catch(err => {
  console.error("❌ Polling Startup Test Error:", err.message);
  process.exit(1);
});
