/**
 * ============================================================
 * 🤖 VIP-2 TELEGRAM BOT CONTROLLER (@VIP_2211bot)
 * ============================================================
 * Interactive Telegram Bot handling:
 *   1. Latest Channel Video Catalog (8 items x 5 pages)
 *   2. BJ Scraped Video Catalog
 *   3. AV Scraped Video Catalog
 *   4. Channel links, real-time sync, and multi-destination status.
 */

const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const { Vip2CatalogManager } = require('./catalog_manager');
const { Vip2ScraperManager } = require('./scraper_manager');

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../.env') });
const envPath = path.resolve(__dirname, '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath, override: true });
}

const BOT_TOKEN = process.env.VIP2_BOT_TOKEN || '8605895356:AAElK1U46g65T2u4u4x8qOZp72_uzHkfh8A';
const CHANNEL_NAME = process.env.VIP2_CHANNEL_NAME || 'V.I.P 정보공유';
const INVITE_LINK = process.env.VIP2_DEST_INVITE_LINK || 'https://t.me/+HKD-EF-iSK5iN2Rh';

class Vip2Bot {
  constructor(pipeline = null) {
    this.token = BOT_TOKEN;
    this.pipeline = pipeline;
    this.catalogManager = new Vip2CatalogManager();
    this.scraperManager = new Vip2ScraperManager(pipeline);
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
          { text: '🎬 최신 채널 영상 목록 바로보기', callback_data: 'vip2_pg:1' }
        ],
        [
          { text: '🔞 BJ 전용 영상 목록', callback_data: 'vip2_bj:1' },
          { text: '🎬 AV 전용 영상 목록', callback_data: 'vip2_av:1' }
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
    return `👑 <b>VIP-2 전용 채널 & 스크래퍼 안내 봇</b>\n━━━━━━━━━━━━━━━━━━━━\n\n` +
      `안녕하세요! <b>${CHANNEL_NAME}</b> 공식 안내 봇입니다.\n\n` +
      `최신 채널 영상 및 <b>BJ / AV</b> 전용 영상 목록을 확인하고 원하는 영상으로 바로 이동하실 수 있습니다.\n\n` +
      `• <b>자동 동기화 주기:</b> 5분마다 자동 실행\n` +
      `• <b>스크래퍼 연결:</b> BJ & AV 고화질 스크래퍼\n` +
      `• <b>중복 방지:</b> 3단계 필터링 적용 중\n\n` +
      `아래 버튼을 눌러 목록을 탐색하세요:`;
  }

  _getStatusText() {
    const total = this.catalogManager.items.length;
    const bjCount = this.scraperManager.getScrapedItems('BJ').length;
    const avCount = this.scraperManager.getScrapedItems('AV').length;
    const sourcesList = this.pipeline && this.pipeline.sourceChannels
      ? this.pipeline.sourceChannels.map(s => '@' + s).join(', ')
      : '@DreamTraveleo, @zzkbraxk';
    const processedCount = this.pipeline ? this.pipeline.processedIds.size : 0;
    const nextSync = this.pipeline && this.pipeline.nextSyncTime
      ? this.pipeline.nextSyncTime.toLocaleTimeString()
      : '5분 이내';

    return `📊 <b>VIP-2 시스템 & 동기화 상태</b>\n━━━━━━━━━━━━━━━━━━━━\n` +
      `• <b>소스 채널:</b> ${sourcesList}\n` +
      `• <b>스크래퍼:</b> BJ (${bjCount}개), AV (${avCount}개)\n` +
      `• <b>대상 채널:</b> ${CHANNEL_NAME} (-1004361683750)\n` +
      `• <b>카탈로그 등록 영상:</b> ${total}개\n` +
      `• <b>중복 방지 추적 기록:</b> ${processedCount}건\n` +
      `• <b>동기화 주기:</b> 매 5분 자동 동기화\n` +
      `• <b>다음 예정 동기화:</b> ${nextSync}\n` +
      `• <b>시스템 상태:</b> 정상 작동 중 🟢`;
  }

  _formatScraperCatalogText(category, items, page = 1) {
    const pageSize = 8;
    const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
    const safePage = Math.max(1, Math.min(page, totalPages));
    const start = (safePage - 1) * pageSize;
    const pageItems = items.slice(start, start + pageSize);

    const titleTag = category.toUpperCase() === 'AV' ? '🎬 VIP-AV 전용 영상' : '🔞 VIP-BJ 전용 영상';
    let text = `👑 <b>${titleTag}</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;

    if (pageItems.length === 0) {
      text += `<i>현재 등록된 영상이 없습니다.</i>\n\n`;
    } else {
      pageItems.forEach((item, idx) => {
        const itemNumber = start + idx + 1;
        const cleanTitle = (item.title || `${category} 영상 #${itemNumber}`)
          .replace(/<[^>]*>/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        const safeTitle = cleanTitle.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const link = item.post_url || item.mp4_download_url || INVITE_LINK;
        text += `${itemNumber}. <a href="${link}">${safeTitle}</a>\n\n`;
      });
    }

    text += `<b>페이지 ${safePage}/${totalPages}</b>`;
    return { text, safePage, totalPages };
  }

  _buildScraperKeyboard(category, safePage, totalPages) {
    const prefix = category.toLowerCase();
    const navRow = [];

    if (safePage > 1) {
      navRow.push({ text: '⬅️ 이전', callback_data: `vip2_${prefix}:${safePage - 1}` });
    }
    if (safePage < totalPages) {
      navRow.push({ text: '다음 ➡️', callback_data: `vip2_${prefix}:${safePage + 1}` });
    }

    const keyboard = [];
    if (navRow.length > 0) keyboard.push(navRow);

    keyboard.push([
      { text: '🔄 새로고침', callback_data: `vip2_${prefix}:${safePage}` },
      { text: '📢 채널 입장', url: INVITE_LINK }
    ]);
    keyboard.push([
      { text: '🏠 메인 메뉴', callback_data: 'vip2_home' }
    ]);

    return { inline_keyboard: keyboard };
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

    // /bj command
    this.bot.onText(/\/bj/, async (msg) => {
      const chatId = msg.chat.id;
      const items = this.scraperManager.getScrapedItems('BJ');
      const { text, safePage, totalPages } = this._formatScraperCatalogText('BJ', items, 1);
      const keyboard = this._buildScraperKeyboard('BJ', safePage, totalPages);

      await this.bot.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: keyboard
      });
    });

    // /av command
    this.bot.onText(/\/av/, async (msg) => {
      const chatId = msg.chat.id;
      const items = this.scraperManager.getScrapedItems('AV');
      const { text, safePage, totalPages } = this._formatScraperCatalogText('AV', items, 1);
      const keyboard = this._buildScraperKeyboard('AV', safePage, totalPages);

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
          `✅ <b>동기화 완료!</b>\n` +
          `• 새로 등록된 영상: <b>${res.count}개</b>\n` +
          `• 중복으로 건너뛴 항목: <b>${res.skipped || 0}개</b>`,
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
      await this.bot.sendMessage(chatId, this._getStatusText(), { parse_mode: 'HTML' });
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
        } else if (data.startsWith('vip2_bj:')) {
          const page = parseInt(data.split(':')[1], 10) || 1;
          const items = this.scraperManager.getScrapedItems('BJ');
          const { text, safePage, totalPages } = this._formatScraperCatalogText('BJ', items, page);
          const keyboard = this._buildScraperKeyboard('BJ', safePage, totalPages);

          await this.bot.editMessageText(text, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            reply_markup: keyboard
          });
          await this.bot.answerCallbackQuery(query.id);
        } else if (data.startsWith('vip2_av:')) {
          const page = parseInt(data.split(':')[1], 10) || 1;
          const items = this.scraperManager.getScrapedItems('AV');
          const { text, safePage, totalPages } = this._formatScraperCatalogText('AV', items, page);
          const keyboard = this._buildScraperKeyboard('AV', safePage, totalPages);

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
          await this.bot.answerCallbackQuery(query.id, { text: '실시간 동기화 실행 중...' });
          if (this.pipeline) {
            const res = await this.pipeline.syncRecent({ limit: 25 });
            const pageData = this.catalogManager.getPage(1);
            const text = this.catalogManager.formatCatalogText(pageData, CHANNEL_NAME);
            const keyboard = this.catalogManager.buildPaginationKeyboard(pageData, INVITE_LINK);

            await this.bot.editMessageText(
              `✅ <b>동기화 완료 (신규 ${res.count}개 / 중복제외 ${res.skipped || 0}개)</b>\n\n${text}`,
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
          await this.bot.answerCallbackQuery(query.id);
          await this.bot.sendMessage(chatId, this._getStatusText(), { parse_mode: 'HTML' });
        }
      } catch (err) {
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
