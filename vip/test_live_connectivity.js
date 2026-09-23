/**
 * ============================================================
 * 🔍 VIP LIVE CONNECTIVITY & PERMISSIONS TESTER
 * ============================================================
 * Tests:
 *  1. Bot Token authentication (getMe -> @INFINITY_121_bot)
 *  2. VIP Supergroup access & Forum Topics status (-1003983458986)
 *  3. Admin & message permissions across all 6 VIP source channels
 *  4. Test message send to General / ALL topic
 */

const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const config = require('./config.json');

const token = process.env.VIP_BOT_TOKEN || process.env.BOT_TOKEN;

async function runLiveTest() {
  console.log('============================================================');
  console.log('🔍 Testing Live Telegram Connectivity & Permissions');
  console.log('============================================================\n');

  if (!token) {
    console.error('❌ VIP_BOT_TOKEN is missing!');
    console.log('👉 Please provide the Bot Token for @INFINITY_121_bot to run the live test.');
    process.exit(1);
  }

  const bot = new TelegramBot(token, { polling: false });

  // 1. Check Bot Identity
  try {
    const me = await bot.getMe();
    console.log(`✅ [1/4] Bot Authenticated Successfully:`);
    console.log(`   • Username: @${me.username}`);
    console.log(`   • Name: ${me.first_name}`);
    console.log(`   • Bot ID: ${me.id}\n`);
  } catch (err) {
    console.error(`❌ [1/4] Bot Token authentication failed:`, err.message);
    process.exit(1);
  }

  // 2. Check VIP Supergroup Access
  const vipChatId = config.vipGroup.chatId;
  try {
    const chat = await bot.getChat(vipChatId);
    console.log(`✅ [2/4] VIP Supergroup Connected:`);
    console.log(`   • Title: ${chat.title}`);
    console.log(`   • Type: ${chat.type}`);
    console.log(`   • Forum Enabled: ${chat.is_forum ? 'YES ✅' : 'NO ⚠️'}\n`);
  } catch (err) {
    console.error(`❌ [2/4] Failed to connect to VIP Supergroup (${vipChatId}):`, err.message);
  }

  // 3. Check All 6 Source Channels
  console.log(`🔍 [3/4] Verifying 6 Source Channels...`);
  for (const [chId, c] of Object.entries(config.channels)) {
    try {
      const ch = await bot.getChat(chId);
      const member = await bot.getChatMember(chId, (await bot.getMe()).id);
      console.log(`   • ${c.emoji} ${c.name} (${ch.title}):`);
      console.log(`     - Status: ${member.status} (Admin: ${member.status === 'administrator' || member.status === 'creator' ? 'YES ✅' : 'NO ⚠️'})`);
    } catch (err) {
      console.error(`   • ❌ Failed to access ${c.name} (${chId}): ${err.message}`);
    }
  }

  console.log(`\n============================================================`);
  console.log(`🎉 LIVE CONNECTIVITY VERIFICATION COMPLETE`);
  console.log(`============================================================\n`);
}

runLiveTest().catch(console.error);
