/**
 * ============================================================
 * 🤖 VIP-2 TELEGRAM BOT CONTROLLER (@VIP_2211bot)
 * ============================================================
 * Interactive Telegram Bot handling user commands, inline paginated
 * video catalog browsing (8 items x 5 pages), channel links, and sync controls.
 */

const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const { Vip2CatalogManager } = require('./catalog_manager');

// Load environment variables
const envPath = path.resolve(__dirname, '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

const BOT_TOKEN = process.env.VIP2_BOT_TOKEN || '8605895356:AAElK1U46g65T2u4u4x8qOZp72_uzHkfh8A';
const CHANNEL_NAME = process.env.VIP2_CHANNEL_NAME || 'V.I.P 정보공유';
const INVITE_LINK = process.env.VIP2_DEST_INVITE_LINK || 'https://t.me/+HKD-EF-iSK5iN2Rh';

class Vip2Bot {
  constructor(pipeline = null) {
    this.token = BOT_TOKEN;
    this.pipeline = pipeline;
    this.catalogManager = new Vip2CatalogManager();
    this.bot = null;
  }

  start() {
    console.log('🤖 [VIP2_BOT] Initializing Telegram Bot polling...');
    this.bot = new TelegramBot(this.token, { polling: true });

    this._registerHandlers();
    console.log('✅ [VIP2_BOT] Bot listening for events.');
    return this.bot;
  }

  _getMainMenuKeyboard() {
    return {
      inline_keyboard: [
        [
          { text: '🎬 최신 동영상 목록 바로보기', callback_data: 'vip2_pg:1' }
        ],
        [
          { text: '📢 V.I.P 정보공유 채널 입장 ↗️', url: INVITE_LINK }
        ],
        [
          { text: '🔄 실시간 동기화', callback_data: 'vip2_sync' },
          { text: '📊 봇 상태', callback_data: 'vip2_status' }
        ]
      ]
    };
  }

  _getMainMenuText() {
    return `👑 <b>VIP-2 전용 채널 안내 봇</b>\n━━━━━━━━━━━━━━━━━━━━\n\n` +
      `안녕하세요! <b>${CHANNEL_NAME}</b> 공식 안내 봇입니다.\n\n` +
      `최신 업로드된 고화질 영상 목록을 확인하고 원하는 영상으로 바로 이동하실 수 있습니다.\n\n` +
      `아래 버튼을 눌러 목록을 탐색하세요:`;
  }

  _registerHandlers() {
    // /start command
    this.bot.onText(/\/start/, async (msg) => {
      const chatId = msg.chat.id;
      await this.bot.sendMessage(chatId, this._getMainMenuText(), {
        parse_mode: 'HTML',
        reply_markup: this._getMainMenuKeyboard()
      });
    });

    // /catalog or /list command
    this.bot.onText(/\/(catalog|list|videos)/, async (msg) => {
      const chatId = msg.chat.id;
      const pageData = this.catalogManager.getPage(1);
      const text = this.catalogManager.formatCatalogText(pageData, CHANNEL_NAME);
      const keyboard = this.catalogManager.buildPaginationKeyboard(pageData, INVITE_LINK);

      await this.bot.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: keyboard
      });
    });

    // /sync command
    this.bot.onText(/\/sync/, async (msg) => {
      const chatId = msg.chat.id;
      if (!this.pipeline) {
        return this.bot.sendMessage(chatId, '⚠️ 동기화 파이프라인이 연결되지 않았습니다.');
      }

      const statusMsg = await this.bot.sendMessage(chatId, '🔄 <b>동기화를 시작합니다...</b>', { parse_mode: 'HTML' });
      
      try {
        const res = await this.pipeline.syncRecent({ limit: 30 });
        await this.bot.editMessageText(
          `✅ <b>동기화 완료!</b>\n새로 등록된 영상: <b>${res.count}개</b>`,
          {
            chat_id: chatId,
            message_id: statusMsg.message_id,
            parse_mode: 'HTML'
          }
        );
      } catch (e) {
        await this.bot.editMessageText(
          `❌ <b>동기화 실패:</b> ${e.message}`,
          {
            chat_id: chatId,
            message_id: statusMsg.message_id,
            parse_mode: 'HTML'
          }
        );
      }
    });

    // /status command
    this.bot.onText(/\/status/, async (msg) => {
      const chatId = msg.chat.id;
      const total = this.catalogManager.items.length;
      const text = `📊 <b>VIP-2 시스템 상태</b>\n━━━━━━━━━━━━━━━━━━━━\n` +
        `• <b>소스 채널:</b> @DreamTraveleo\n` +
        `• <b>대상 채널:</b> ${CHANNEL_NAME} (-1004361683750)\n` +
        `• <b>등록된 동영상:</b> ${total}개\n` +
        `• <b>상태:</b> 정상 작동 중 🟢`;

      await this.bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
    });

    // Callback Query Handler
    this.bot.on('callback_query', async (query) => {
      const data = query.data;
      const chatId = query.message.chat.id;
      const messageId = query.message.message_id;

      try {
        if (data.startsWith('vip2_pg:')) {
          const page = parseInt(data.split(':')[1], 10) || 1;
          const pageData = this.catalogManager.getPage(page);
          const text = this.catalogManager.formatCatalogText(pageData, CHANNEL_NAME);
          const keyboard = this.catalogManager.buildPaginationKeyboard(pageData, INVITE_LINK);

          await this.bot.editMessageText(text, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            reply_markup: keyboard
          });
          await this.bot.answerCallbackQuery(query.id);
        } else if (data === 'vip2_home') {
          await this.bot.editMessageText(this._getMainMenuText(), {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'HTML',
            reply_markup: this._getMainMenuKeyboard()
          });
          await this.bot.answerCallbackQuery(query.id);
        } else if (data === 'vip2_sync') {
          await this.bot.answerCallbackQuery(query.id, { text: '동기화를 실행 중입니다...' });
          if (this.pipeline) {
            const res = await this.pipeline.syncRecent({ limit: 20 });
            const pageData = this.catalogManager.getPage(1);
            const text = this.catalogManager.formatCatalogText(pageData, CHANNEL_NAME);
            const keyboard = this.catalogManager.buildPaginationKeyboard(pageData, INVITE_LINK);

            await this.bot.editMessageText(
              `✅ <b>동기화 완료 (${res.count}개 업데이트됨)</b>\n\n${text}`,
              {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                reply_markup: keyboard
              }
            );
          }
        } else if (data === 'vip2_status') {
          const total = this.catalogManager.items.length;
          await this.bot.answerCallbackQuery(query.id);
          await this.bot.sendMessage(
            chatId,
            `📊 <b>VIP-2 시스템 상태</b>\n━━━━━━━━━━━━━━━━━━━━\n` +
            `• <b>소스 채널:</b> @DreamTraveleo\n` +
            `• <b>대상 채널:</b> ${CHANNEL_NAME}\n` +
            `• <b>등록된 동영상:</b> ${total}개\n` +
            `• <b>상태:</b> 정상 작동 중 🟢`,
            { parse_mode: 'HTML' }
          );
        }
      } catch (err) {
        // Ignore "message is not modified" error
        if (!err.message || !err.message.includes('message is not modified')) {
          console.error('❌ [VIP2_BOT] Callback error:', err.message);
        }
        try {
          await this.bot.answerCallbackQuery(query.id);
        } catch (_) {}
      }
    });

    // Error handler
    this.bot.on('polling_error', (error) => {
      console.error('⚠️ [VIP2_BOT] Polling error:', error.code, error.message);
    });
  }

  stop() {
    if (this.bot) {
      this.bot.stopPolling();
      this.bot = null;
    }
  }
}

module.exports = {
  Vip2Bot
};
