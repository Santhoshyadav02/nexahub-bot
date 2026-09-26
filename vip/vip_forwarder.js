/**
 * ============================================================
 * 👑 VIP CHANNEL FORWARDER & TOPIC HUB BOT (@INFINITY_121_bot)
 * ============================================================
 * Automatically monitors 6 VIP Telegram channels, maintains a 40-video catalog (8x5 pages)
 * with blue clickable hyperlinks, and publishes rich notification cards + interactive
 * paginated menus to VIP Group Forum Topics + General / ALL threads and DM private chats.
 * Includes Home, About, and History Clear bottom navigation keyboard + Back button support.
 */

const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const { CatalogManager } = require('./catalog_manager');
const CONFIG_PATH = path.resolve(__dirname, 'config.json');

function getPersistentNavigationKeyboard() {
  return {
    keyboard: [
      [
        { text: '🏠 홈' },
        { text: 'ℹ️ 정보' },
        { text: '🗑️ 기록' }
      ]
    ],
    resize_keyboard: true,
    persistent: true,
    is_persistent: true
  };
}

class VipForwarder {
  constructor(configPath = CONFIG_PATH) {
    this.configPath = configPath;
    this.config = this._loadConfig();
    this.catalogManager = new CatalogManager(path.resolve(__dirname, 'channel_catalogs.json'));
    this.processedPosts = new Set();
    this.userMessageHistory = new Map(); // chatId -> Set(messageIds)
    this.bot = null;
  }

  _loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf8');
        return JSON.parse(raw);
      }
    } catch (err) {
      console.error('❌ [VIP_FORWARDER] Failed to load config:', err.message);
    }
    return { vipGroup: {}, channels: {}, settings: {} };
  }

  _saveConfig() {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
      console.log('💾 [VIP_FORWARDER] Configuration saved successfully.');
    } catch (err) {
      console.error('❌ [VIP_FORWARDER] Failed to save config:', err.message);
    }
  }

  trackMessage(chatId, messageId) {
    const key = String(chatId);
    if (!this.userMessageHistory.has(key)) {
      this.userMessageHistory.set(key, new Set());
    }
    this.userMessageHistory.get(key).add(messageId);
  }

  async clearUserMessages(chatId) {
    const key = String(chatId);
    const msgIds = this.userMessageHistory.get(key);
    if (msgIds && msgIds.size > 0) {
      for (const msgId of Array.from(msgIds)) {
        try {
          await this.bot.deleteMessage(chatId, msgId);
        } catch (e) {
          // Ignore if message is older than 48h or already deleted
        }
      }
      this.userMessageHistory.set(key, new Set());
    }
  }

  getChannelPostLink(chatId, messageId, username = null) {
    if (username) {
      const cleanUser = username.replace(/^@/, '');
      return `https://t.me/${cleanUser}/${messageId}`;
    }
    const cleanId = String(chatId).replace(/^-100/, '').replace(/^-/, '');
    return `https://t.me/c/${cleanId}/${messageId}`;
  }

  getVipGroupAllLink() {
    const vipChatId = this.config.vipGroup.chatId;
    const cleanId = String(vipChatId).replace(/^-100/, '').replace(/^-/, '');
    const threadId = this.config.vipGroup.allTopicThreadId || 1;
    return `https://t.me/c/${cleanId}/${threadId}`;
  }

  extractTitle(msg) {
    const raw = (msg.caption || msg.text || (msg.video && msg.video.file_name) || (msg.document && msg.document.file_name) || '신규 동영상 콘텐츠').trim();
    const firstLine = raw.split('\n')[0].trim();
    return firstLine.length > 90 ? firstLine.substring(0, 87) + '...' : firstLine;
  }

  formatAllCard(channelConfig, title) {
    return (
      `🌐 <b>[ALL / 전체] 신규 업데이트 (${channelConfig.tag})</b>\n\n` +
      `📌 <b>${this._escapeHTML(title)}</b>\n\n` +
      `👉 <i>제목을 탭하여 채널에서 바로 시청하세요.</i>`
    );
  }

  formatCategoryCard(channelConfig, title) {
    return (
      `${channelConfig.emoji} <b>[${channelConfig.tag} / 전용] 신규 업데이트</b>\n\n` +
      `📌 <b>${this._escapeHTML(title)}</b>\n\n` +
      `👉 <i>제목을 탭하여 채널에서 바로 시청하세요.</i>`
    );
  }

  buildKeyboard(channelConfig, postLink) {
    const allLink = this.getVipGroupAllLink();
    const keyboard = [
      [
        { text: '🌐 All ↗️', url: allLink },
        { text: '🎬 영상 바로보기 ↗️', url: postLink }
      ]
    ];

    if (channelConfig.inviteLink) {
      keyboard.push([
        { text: `📢 ${channelConfig.buttonLabel || channelConfig.tag} 채널 입장하기 ↗️`, url: channelConfig.inviteLink }
      ]);
    }

    return { inline_keyboard: keyboard };
  }

  /**
   * Main Menu Layout (Clean text + 6 Group Cards)
   */
  formatMainMenuText() {
    return (
      `👑 <b>V.I.P 정보공유!</b>\n\n` +
      `프리미엄 정보와 최신 소식을 확인하세요.\n` +
      `✨ <b>V.I.P 정보공유와 함께하세요!</b>\n\n` +
      `👇 아래 버튼을 눌러주세요.`
    );
  }

  buildMainMenuKeyboard() {
    return {
      inline_keyboard: [
        [
          { text: '🔞 18+', callback_data: 'cat_pg:18:1' },
          { text: '🇨🇳 CN', callback_data: 'cat_pg:CN:1' }
        ],
        [
          { text: '🇯🇵 JP', callback_data: 'cat_pg:JP:1' },
          { text: '🇰🇷 KR', callback_data: 'cat_pg:KR:1' }
        ],
        [
          { text: '📺 BJ.', callback_data: 'cat_pg:BJ:1' },
          { text: '🎬 AV', callback_data: 'cat_pg:AV:1' }
        ]
      ]
    };
  }

  /**
   * About Screen Layout
   */
  formatAboutText() {
    let text =
      `👑 <b>V.I.P 정보공유 안내</b>\n\n` +
      `프리미엄 정보와 최신 비디오 콘텐츠를 실시간으로 제공하는 VIP 전용 봇입니다.\n\n` +
      `📌 <b>지원 카테고리 (총 6개):</b>\n`;

    const channelKeys = ['18', 'CN', 'JP', 'KR', 'BJ', 'AV'];
    for (const key of channelKeys) {
      const ch = Object.values(this.config.channels).find(c => c.key.toLowerCase() === key.toLowerCase());
      if (ch) {
        const count = (this.catalogManager.catalogs[ch.key] || []).length;
        text += `• ${ch.emoji} <b>${ch.name || ch.buttonLabel}</b> (최신 영상 ${count}개 수집됨)\n`;
      }
    }

    text +=
      `\n✨ <b>주요 기능:</b>\n` +
      `• 실시간 6채널 신규 비디오 포워딩\n` +
      `• 40개 최신 영상 8x5 페이징 카탈로그\n` +
      `• Telegram 내 다이렉트 동영상 바로 재생\n\n` +
      `👇 <i>아래 버튼을 눌러 홈으로 이동하세요.</i>`;

    return text;
  }

  /**
   * Core Handler: Triggered on every channel post event.
   */
  async handleChannelPost(msg) {
    const chatIdStr = String(msg.chat.id);
    const channelConfig = this.config.channels[chatIdStr];

    if (!channelConfig) {
      return false;
    }

    const postKey = `${chatIdStr}:${msg.message_id}`;
    if (this.processedPosts.has(postKey)) {
      console.log(`ℹ️ [VIP_FORWARDER] Post already processed: ${postKey}`);
      return false;
    }
    this.processedPosts.add(postKey);

    const title = this.extractTitle(msg);
    const postLink = this.getChannelPostLink(msg.chat.id, msg.message_id, msg.chat.username);
    const vipChatId = this.config.vipGroup.chatId;

    // Save to channel catalog (40-video rolling history)
    this.catalogManager.addVideo(channelConfig.key, {
      messageId: msg.message_id,
      title: title,
      link: postLink
    });

    console.log(`\n📢 [VIP_FORWARDER] New Update Detected from [${channelConfig.name}] (${channelConfig.tag})`);
    console.log(`   📌 Title: ${title}`);
    console.log(`   🔗 Post Link: ${postLink}`);

    const keyboard = this.buildKeyboard(channelConfig, postLink);

    // 1. Post to Dedicated Category Topic
    if (this.config.settings.postToCategoryTopic && channelConfig.topicThreadId) {
      try {
        const catText = this.formatCategoryCard(channelConfig, title);
        await this.bot.sendMessage(vipChatId, catText, {
          parse_mode: 'HTML',
          message_thread_id: channelConfig.topicThreadId,
          reply_markup: keyboard,
          disable_web_page_preview: true
        });
        console.log(`   ✅ Posted to [${channelConfig.topicName || channelConfig.tag}] Topic (Thread: ${channelConfig.topicThreadId})`);
      } catch (err) {
        console.error(`   ❌ Failed to post to [${channelConfig.tag}] topic:`, err.message);
      }
    }

    // 2. Post to General / ALL Topic
    if (this.config.settings.postToGeneralTopic || this.config.settings.postToAllTopic) {
      try {
        const allText = this.formatAllCard(channelConfig, title);
        const sendOpts = {
          parse_mode: 'HTML',
          reply_markup: keyboard,
          disable_web_page_preview: true
        };
        const allThreadId = this.config.vipGroup.allTopicThreadId;
        if (allThreadId && allThreadId !== 1) {
          sendOpts.message_thread_id = allThreadId;
        }

        await this.bot.sendMessage(vipChatId, allText, sendOpts);
        console.log(`   ✅ Posted to General / ALL Feed (VIP Group: ${vipChatId})`);
      } catch (err) {
        console.error(`   ❌ Failed to post to General/ALL topic:`, err.message);
      }
    }

    return true;
  }

  /**
   * Handles interactive callback queries for pagination, main menu, and clear history.
   */
  async handleCallbackQuery(query) {
    if (!query.data) return;

    if (query.data === 'vip_main_menu') {
      try {
        await this.bot.answerCallbackQuery(query.id);
        const text = this.formatMainMenuText();
        const replyMarkup = this.buildMainMenuKeyboard();

        await this.bot.editMessageText(text, {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          parse_mode: 'HTML',
          reply_markup: replyMarkup,
          disable_web_page_preview: true
        });
      } catch (err) {
        if (!err.message.includes('message is not modified')) {
          console.error('❌ [VIP_FORWARDER] Failed to return to main menu:', err.message);
        }
      }
      return;
    }

    if (query.data === 'confirm_clear_history') {
      try {
        await this.bot.answerCallbackQuery(query.id, { text: '대화 기록이 정리되었습니다.' });
        await this.clearUserMessages(query.message.chat.id);
        try {
          await this.bot.deleteMessage(query.message.chat.id, query.message.message_id);
        } catch (e) {}

        const menuText = this.formatMainMenuText();
        const menuMarkup = this.buildMainMenuKeyboard();
        const sent = await this.bot.sendMessage(query.message.chat.id, menuText, {
          parse_mode: 'HTML',
          reply_markup: menuMarkup,
          disable_web_page_preview: true
        });
        if (sent && sent.message_id) {
          this.trackMessage(query.message.chat.id, sent.message_id);
        }
      } catch (err) {
        console.error('❌ [VIP_FORWARDER] Failed to clear history:', err.message);
      }
      return;
    }

    if (query.data === 'cancel_clear_history') {
      try {
        await this.bot.answerCallbackQuery(query.id, { text: '기록 삭제가 취소되었습니다.' });
        try {
          await this.bot.deleteMessage(query.message.chat.id, query.message.message_id);
        } catch (e) {}
      } catch (err) {}
      return;
    }

    if (query.data.startsWith('cat_pg:')) {
      const parts = query.data.split(':');
      const channelKey = parts[1];
      const page = parseInt(parts[2], 10) || 1;

      // Find channel configuration
      const channelConfig = Object.values(this.config.channels).find(
        c => c.key.toLowerCase() === channelKey.toLowerCase()
      );

      if (!channelConfig) {
        try {
          await this.bot.answerCallbackQuery(query.id, { text: '채널을 찾을 수 없습니다.' });
        } catch (e) {}
        return;
      }

      const pageData = this.catalogManager.getPage(channelConfig.key, page);
      const text = this.catalogManager.formatCatalogText(channelConfig, pageData);
      const replyMarkup = this.catalogManager.buildPaginationKeyboard(channelConfig, pageData);

      try {
        await this.bot.answerCallbackQuery(query.id);
        await this.bot.editMessageText(text, {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          parse_mode: 'HTML',
          reply_markup: replyMarkup,
          disable_web_page_preview: true
        });
      } catch (err) {
        if (!err.message.includes('message is not modified')) {
          console.error('❌ [VIP_FORWARDER] Failed to edit catalog page:', err.message);
        }
      }
    }
  }

  /**
   * Message handler for both Direct Messages (Private) and Group / Topics.
   */
  async handleIncomingMessage(msg) {
    if (!msg.text) return;
    const text = msg.text.trim();
    const chatIdStr = String(msg.chat.id);
    const chatType = msg.chat.type; // 'private', 'group', 'supergroup', 'channel'
    const vipChatId = this.config.vipGroup.chatId;

    // 1. Private Chat / DM Interaction:
    if (chatType === 'private') {
      this.trackMessage(msg.chat.id, msg.message_id);

      // Command: /start (Activates persistent navigation keyboard + clean greeting)
      if (text === '/start') {
        const initSent = await this.bot.sendMessage(msg.chat.id,
          `👑 <b>V.I.P 정보공유에 오신 것을 환영합니다!</b>`,
          {
            parse_mode: 'HTML',
            reply_markup: getPersistentNavigationKeyboard()
          }
        );
        if (initSent && initSent.message_id) {
          this.trackMessage(msg.chat.id, initSent.message_id);
        }

        const menuText = this.formatMainMenuText();
        const menuMarkup = this.buildMainMenuKeyboard();
        const sent = await this.bot.sendMessage(msg.chat.id, menuText, {
          parse_mode: 'HTML',
          reply_markup: menuMarkup,
          disable_web_page_preview: true
        });
        if (sent && sent.message_id) {
          this.trackMessage(msg.chat.id, sent.message_id);
        }
        return;
      }

      // Button: 🏠 홈 (Home)
      if (text === '🏠 홈' || text === '홈' || text === '/menu' || text === '/home') {
        const menuText = this.formatMainMenuText();
        const menuMarkup = this.buildMainMenuKeyboard();

        const sent = await this.bot.sendMessage(msg.chat.id, menuText, {
          parse_mode: 'HTML',
          reply_markup: menuMarkup,
          disable_web_page_preview: true
        });
        if (sent && sent.message_id) {
          this.trackMessage(msg.chat.id, sent.message_id);
        }
        return;
      }

      // Button: ℹ️ 정보 (About)
      if (text === 'ℹ️ 정보' || text === '정보' || text === 'ℹ️ About' || text === 'About' || text === '/about') {
        const aboutText = this.formatAboutText();
        const sent = await this.bot.sendMessage(msg.chat.id, aboutText, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔙 뒤로가기', callback_data: 'vip_main_menu' }]
            ]
          },
          disable_web_page_preview: true
        });
        if (sent && sent.message_id) {
          this.trackMessage(msg.chat.id, sent.message_id);
        }
        return;
      }

      // Button: 🗑️ 기록 (Clear History)
      if (text === '🗑️ 기록' || text === '기록' || text === '🗑️ History' || text === 'History' || text === '/clear') {
        const confirmText =
          `⚠️ <b>대화 기록을 삭제하시겠습니까?</b>\n\n` +
          `최근 봇 메시지 기록을 삭제하고 새 세션을 시작합니다.\n\n` +
          `진행하시겠습니까?`;

        const sent = await this.bot.sendMessage(msg.chat.id, confirmText, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ 예, 삭제합니다', callback_data: 'confirm_clear_history' },
                { text: '❌ 취소', callback_data: 'cancel_clear_history' }
              ]
            ]
          }
        });
        if (sent && sent.message_id) {
          this.trackMessage(msg.chat.id, sent.message_id);
        }
        return;
      }

      // Default message in DM -> Show main menu
      const menuText = this.formatMainMenuText();
      const menuMarkup = this.buildMainMenuKeyboard();
      const sent = await this.bot.sendMessage(msg.chat.id, menuText, {
        parse_mode: 'HTML',
        reply_markup: menuMarkup,
        disable_web_page_preview: true
      });
      if (sent && sent.message_id) {
        this.trackMessage(msg.chat.id, sent.message_id);
      }
      return;
    }

    // 2. VIP Group / Supergroup Interaction:
    if (chatIdStr === String(vipChatId)) {
      const threadId = msg.message_thread_id || null;

      // Command: /start or /menu in group
      if (text.startsWith('/start') || text.startsWith('/menu')) {
        const menuText = this.formatMainMenuText();
        const menuMarkup = this.buildMainMenuKeyboard();
        await this.bot.sendMessage(msg.chat.id, menuText, {
          parse_mode: 'HTML',
          message_thread_id: threadId,
          reply_markup: menuMarkup,
          disable_web_page_preview: true
        });
        return;
      }

      // Command: /catalog or /list (Shows 8x5 paginated list for this topic)
      if (text.startsWith('/catalog') || text.startsWith('/list') || text.startsWith('/videos')) {
        const parts = text.split(/\s+/);
        let requestedKey = parts[1];

        let channelConfig = null;
        if (requestedKey) {
          channelConfig = Object.values(this.config.channels).find(
            c => c.key.toLowerCase() === requestedKey.toLowerCase() || c.tag.toLowerCase() === requestedKey.toLowerCase()
          );
        } else if (threadId) {
          channelConfig = Object.values(this.config.channels).find(
            c => c.topicThreadId === threadId
          );
        }

        if (!channelConfig) {
          channelConfig = Object.values(this.config.channels)[0];
        }

        const pageData = this.catalogManager.getPage(channelConfig.key, 1);
        const catalogText = this.catalogManager.formatCatalogText(channelConfig, pageData);
        const replyMarkup = this.catalogManager.buildPaginationKeyboard(channelConfig, pageData);

        await this.bot.sendMessage(msg.chat.id, catalogText, {
          parse_mode: 'HTML',
          message_thread_id: threadId,
          reply_markup: replyMarkup,
          disable_web_page_preview: true
        });
        return;
      }

      // Command: /settopic <key>
      if (text.startsWith('/settopic')) {
        const parts = text.split(/\s+/);
        const key = parts[1];
        if (!key) {
          await this.bot.sendMessage(msg.chat.id,
            `⚠️ 사용법: <code>/settopic &lt;KEY&gt;</code>\n` +
            `사용 가능한 KEY: <code>18</code>, <code>CN</code>, <code>JP</code>, <code>KR</code>, <code>BJ</code>, <code>AV</code>, <code>ALL</code>`,
            { parse_mode: 'HTML', message_thread_id: threadId }
          );
          return;
        }

        if (key.toUpperCase() === 'ALL' || key.toUpperCase() === 'GENERAL') {
          this.config.vipGroup.allTopicThreadId = threadId || 1;
          this.config.vipGroup.generalTopicThreadId = threadId || 1;
          this._saveConfig();
          await this.bot.sendMessage(msg.chat.id,
            `✅ General / ALL 토픽 스레드 ID가 <code>${threadId || 1}</code>번으로 설정되었습니다.`,
            { parse_mode: 'HTML', message_thread_id: threadId }
          );
          return;
        }

        const res = this.bindTopicThread(key, threadId);
        if (res.success) {
          await this.bot.sendMessage(msg.chat.id,
            `✅ <b>[${res.channel.name}] (${res.channel.tag})</b> 채널이 이 토픽(Thread ID: <code>${threadId}</code>)에 성공적으로 연결되었습니다!\n\n` +
            `📌 이제 이 토픽에서 유저가 메시지를 보내면 최신 8x5 동영상 목록이 자동으로 표시됩니다.`,
            { parse_mode: 'HTML', message_thread_id: threadId }
          );

          // Post initial 8-item catalog immediately
          const pageData = this.catalogManager.getPage(res.channel.key, 1);
          const catalogText = this.catalogManager.formatCatalogText(res.channel, pageData);
          const replyMarkup = this.catalogManager.buildPaginationKeyboard(res.channel, pageData);
          await this.bot.sendMessage(msg.chat.id, catalogText, {
            parse_mode: 'HTML',
            message_thread_id: threadId,
            reply_markup: replyMarkup,
            disable_web_page_preview: true
          });
        } else {
          await this.bot.sendMessage(msg.chat.id,
            `❌ 알 수 없는 채널 키: <code>${key}</code>\n사용 가능한 키: 18, CN, JP, KR, BJ, AV`,
            { parse_mode: 'HTML', message_thread_id: threadId }
          );
        }
        return;
      }

      // Command: /topics or /status
      if (text === '/topics' || text === '/status') {
        let statusMsg =
          `👑 <b>VIP 포워더 & 카탈로그 현황</b>\n` +
          `━━━━━━━━━━━━━━━━\n` +
          `🌐 <b>VIP Group:</b> <code>${vipChatId}</code>\n` +
          `📌 <b>General / ALL Topic Thread:</b> <code>${this.config.vipGroup.allTopicThreadId || 1}</code>\n` +
          `━━━━━━━━━━━━━━━━\n` +
          `<b>연결된 6개 채널 목록 및 카탈로그 현황:</b>\n\n`;

        for (const [chId, c] of Object.entries(this.config.channels)) {
          const boundThread = c.topicThreadId ? `Thread ID: <code>${c.topicThreadId}</code>` : `<i>⚠️ 미지정 (/settopic ${c.key})</i>`;
          const count = (this.catalogManager.catalogs[c.key] || []).length;
          statusMsg += `• ${c.emoji} <b>${c.name} (${c.tag})</b> [${count}/40개 수집됨]\n  ID: <code>${chId}</code> ➔ ${boundThread}\n`;
        }

        await this.bot.sendMessage(msg.chat.id, statusMsg, { parse_mode: 'HTML', message_thread_id: threadId });
        return;
      }

      // General message in a topic thread:
      // Auto-reply with the channel's 8x5 paginated video list
      if (threadId) {
        const channelConfig = Object.values(this.config.channels).find(
          c => c.topicThreadId === threadId
        );

        if (channelConfig) {
          const pageData = this.catalogManager.getPage(channelConfig.key, 1);
          const catalogText = this.catalogManager.formatCatalogText(channelConfig, pageData);
          const replyMarkup = this.catalogManager.buildPaginationKeyboard(channelConfig, pageData);

          await this.bot.sendMessage(msg.chat.id, catalogText, {
            parse_mode: 'HTML',
            message_thread_id: threadId,
            reply_markup: replyMarkup,
            disable_web_page_preview: true
          });
        }
      }
    }
  }

  bindTopicThread(channelKey, threadId) {
    for (const [chId, conf] of Object.entries(this.config.channels)) {
      if (conf.key.toLowerCase() === channelKey.toLowerCase() || conf.tag.toLowerCase() === channelKey.toLowerCase()) {
        conf.topicThreadId = Number(threadId);
        this._saveConfig();
        return { success: true, channel: conf };
      }
    }
    return { success: false, error: 'CHANNEL_KEY_NOT_FOUND' };
  }

  _escapeHTML(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  start() {
    const token = process.env.VIP_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!token) {
      console.error('❌ [VIP_FORWARDER] VIP_BOT_TOKEN is missing in vip/.env!');
      return;
    }

    this.bot = new TelegramBot(token, { polling: true });

    // Ensure bot commands are registered
    this.bot.setMyCommands([
      { command: 'start', description: '메인 메뉴 열기' },
      { command: 'menu', description: '6개 카테고리 카드 보기' },
      { command: 'about', description: 'VIP 봇 정보 및 안내' },
      { command: 'clear', description: '대화 기록 삭제' }
    ]).catch(() => {});

    this.bot.on('polling_error', (error) => {
      // Ignore routine network timeouts/502 Bad Gateways from Telegram servers
      if (error && error.code === 'EFATAL') {
        console.warn('⚠️ [VIP_FORWARDER] Telegram polling fatal error:', error.message);
      }
    });

    this.bot.on('channel_post', (msg) => {
      this.handleChannelPost(msg).catch(err => {
        console.error('❌ [VIP_FORWARDER] Error in handleChannelPost:', err.message);
      });
    });

    this.bot.on('message', (msg) => {
      this.handleIncomingMessage(msg).catch(err => {
        console.error('❌ [VIP_FORWARDER] Error in handleIncomingMessage:', err.message);
      });
    });

    this.bot.on('callback_query', (query) => {
      this.handleCallbackQuery(query).catch(err => {
        console.error('❌ [VIP_FORWARDER] Error in handleCallbackQuery:', err.message);
      });
    });

    console.log('🚀 [VIP_FORWARDER] VIP Channel Forwarder & Topic Hub is LIVE!');
  }
}

if (require.main === module) {
  const forwarder = new VipForwarder();
  forwarder.start();
}

module.exports = {
  VipForwarder,
  getPersistentNavigationKeyboard
};
