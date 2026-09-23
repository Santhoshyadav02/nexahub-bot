const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const config = require('./config.json');

const token = process.env.VIP_BOT_TOKEN;
const bot = new TelegramBot(token, { polling: false });

async function sendTestToGeneral() {
  const vipChatId = config.vipGroup.chatId;
  const generalThreadId = config.vipGroup.allTopicThreadId || 1;

  console.log(`Sending live test card to VIP Group (${vipChatId}) in General Topic (Thread: ${generalThreadId})...`);

  const cardHtml =
    `🌐 <b>[ALL / 전체] 신규 업데이트 (시스템 연결 테스트)</b>\n\n` +
    `📌 <b>VIP 포워더 및 카탈로그 시스템 연동 완료</b>\n\n` +
    `👉 <i>제목을 탭하여 채널에서 바로 시청하세요.</i>`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '🌐 All ↗️', url: `https://t.me/c/${String(vipChatId).replace(/^-100/, '')}/1` },
        { text: '🇰🇷 KR (로맨틱한 분위기 💥) ↗️', url: `https://t.me/c/4435999618/1` }
      ]
    ]
  };

  try {
    const res = await bot.sendMessage(vipChatId, cardHtml, {
      parse_mode: 'HTML',
      message_thread_id: generalThreadId,
      reply_markup: keyboard,
      disable_web_page_preview: true
    });
    console.log(`✅ Live Test Card sent successfully! Message ID: ${res.message_id}`);
  } catch (err) {
    console.error(`❌ Failed to send test card:`, err.message);
  }
}

sendTestToGeneral().catch(console.error);
