/**
 * ============================================================
 * 👑 VIP CHANNEL FORWARDER & TOPIC HUB BOT (@INFINITY_121_bot)
 * ============================================================
 * Automatically monitors 6 VIP Telegram channels, maintains a 40-video catalog (8x5 pages)
 * with blue clickable hyperlinks, and publishes rich notification cards + interactive
 * paginated menus to VIP Group Forum Topics + General / ALL threads.
 */

const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const { CatalogManager } = require('./catalog_manager');
const CONFIG_PATH = path.resolve(__dirname, 'config.json');

class VipForwarder {
  constructor(configPath = CONFIG_PATH) {
    this.configPath = configPath;
    this.config = this._loadConfig();
    this.catalogManager = new CatalogManager(path.resolve(__dirname, 'channel_catalogs.json'));
    this.processedPosts = new Set();
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
    const channelBtnText = `${channelConfig.buttonLabel || channelConfig.tag} ↗️`;

    return {
      inline_keyboard: [
        [
          { text: '🌐 All ↗️', url: allLink },
          { text: channelBtnText, url: postLink }
        ]
      ]
    };
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
   * Handles interactive callback queries for pagination (e.g. cat_pg:KR:2).
   */
  async handleCallbackQuery(query) {
    if (!query.data || !query.data.startsWith('cat_pg:')) return;

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
    const replyMarkup = this.catalogManager.buildPaginationKeyboard(channelConfig.key, pageData);

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
      // Ignore if content is identical on refresh
      if (!err.message.includes('message is not modified')) {
        console.error('❌ [VIP_FORWARDER] Failed to edit catalog page:', err.message);
      }
    }
  }

  /**
   * Helper command handlers for topic management and catalog display.
   */
  async handleGroupMessage(msg) {
    if (!msg.text) return;
    const text = msg.text.trim();
    const chatIdStr = String(msg.chat.id);
    const vipChatId = this.config.vipGroup.chatId;

    if (chatIdStr === String(vipChatId)) {
      const threadId = msg.message_thread_id || null;

      // Command: /catalog or /list (Shows 8x5 paginated list for this topic)
      if (text.startsWith('/catalog') || text.startsWith('/list') || text.startsWith('/videos')) {
        const parts = text.split(/\s+/);
        let requestedKey = parts[1];

        // If no key provided, detect from bound threadId
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
          // Default to first channel or show selector
          channelConfig = Object.values(this.config.channels)[0];
        }

        const pageData = this.catalogManager.getPage(channelConfig.key, 1);
        const catalogText = this.catalogManager.formatCatalogText(channelConfig, pageData);
        const replyMarkup = this.catalogManager.buildPaginationKeyboard(channelConfig.key, pageData);

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
          const replyMarkup = this.catalogManager.buildPaginationKeyboard(res.channel.key, pageData);
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

      // General message from any user in a topic thread:
      // Auto-reply with the channel's 8x5 paginated video list!
      if (threadId) {
        const channelConfig = Object.values(this.config.channels).find(
          c => c.topicThreadId === threadId
        );

        if (channelConfig) {
          const pageData = this.catalogManager.getPage(channelConfig.key, 1);
          const catalogText = this.catalogManager.formatCatalogText(channelConfig, pageData);
          const replyMarkup = this.catalogManager.buildPaginationKeyboard(channelConfig.key, pageData);

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
      this.handleGroupMessage(msg).catch(err => {
        console.error('❌ [VIP_FORWARDER] Error in handleGroupMessage:', err.message);
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
  VipForwarder
};
