/**
 * ============================================================
 * 🚀 PUBLISH 8x5 TOPIC CATALOGS TO ALL 6 VIP TOPIC THREADS
 * ============================================================
 * Posts the initial 8-item catalog (Page 1/5) with blue clickable hyperlinks
 * into each of the 6 forum topic threads in >> V.I.P 정보공유 << (-1003983458986).
 */

const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const { CatalogManager } = require('./catalog_manager');
const config = require('./config.json');

const token = process.env.VIP_BOT_TOKEN;

async function publishAllTopicCatalogs() {
  console.log('============================================================');
  console.log('🚀 Publishing 8x5 Interactive Catalogs to 6 VIP Topics');
  console.log('============================================================\n');

  if (!token) {
    console.error('❌ VIP_BOT_TOKEN missing in vip/.env');
    return;
  }

  const bot = new TelegramBot(token, { polling: false });
  const catalogManager = new CatalogManager(path.resolve(__dirname, 'channel_catalogs.json'));
  const vipChatId = config.vipGroup.chatId;

  for (const [chId, c] of Object.entries(config.channels)) {
    if (!c.topicThreadId) {
      console.warn(`⚠️ Skipping ${c.name}: No topicThreadId configured.`);
      continue;
    }

    const pageData = catalogManager.getPage(c.key, 1);
    const catalogText = catalogManager.formatCatalogText(c, pageData);
    const replyMarkup = catalogManager.buildPaginationKeyboard(c.key, pageData);

    console.log(`📤 Sending Catalog to [${c.name}] (${c.tag}) in Topic (Thread ID: ${c.topicThreadId})...`);

    try {
      const res = await bot.sendMessage(vipChatId, catalogText, {
        parse_mode: 'HTML',
        message_thread_id: c.topicThreadId,
        reply_markup: replyMarkup,
        disable_web_page_preview: true
      });
      console.log(`   ✅ Success! Message ID: ${res.message_id} in Topic ID: ${c.topicThreadId}\n`);
    } catch (err) {
      console.error(`   ❌ Failed to send to ${c.name} in Topic ${c.topicThreadId}:`, err.message);
    }
  }

  console.log('============================================================');
  console.log('🎉 ALL 6 TOPIC CATALOGS PUBLISHED SUCCESSFULLY');
  console.log('============================================================\n');
}

if (require.main === module) {
  publishAllTopicCatalogs().catch(console.error);
}

module.exports = { publishAllTopicCatalogs };
