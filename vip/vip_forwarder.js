/**
 * ============================================================
 * 👑 VIP CHANNEL FORWARDER & TOPIC HUB BOT (@INFINITY_121_bot)
 * ============================================================
 * Automatically monitors 6 VIP Telegram channels and forwards / publishes
 * rich notification cards to corresponding VIP Group Forum Topics + General / ALL threads.
 *
 * Source Channels (6):
 *  1. VIP-18 (-1003845130520) ➔ VIP Forum Topic: 18+ (🔞) & General/ALL
 *  2. VIP-CN (-1004304488687) ➔ VIP Forum Topic: CN (🇨🇳) & General/ALL
 *  3. VIP-JP (-1004484964035) ➔ VIP Forum Topic: JP (🇯🇵) & General/ALL
 *  4. VIP-KR (-1004435999618) ➔ VIP Forum Topic: KR (🇰🇷) & General/ALL
 *  5. VIP-BJ (-1003977934133) ➔ VIP Forum Topic: BJ (📺) & General/ALL
 *  6. VIP-AV (-1004352512630) ➔ VIP Forum Topic: AV (🎬) & General/ALL
 *
 * Target Supergroup:
 *  - VIP Group (-1003983458986) with Forum Topics enabled
 */

const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const CONFIG_PATH = path.resolve(__dirname, 'config.json');

class VipForwarder {
  constructor(configPath = CONFIG_PATH) {
    this.configPath = configPath;
    this.config = this._loadConfig();
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

  /**
   * Generates clean direct jump link to a Telegram channel post.
   * e.g. -1004435999618 -> https://t.me/c/4435999618/123
   */
  getChannelPostLink(chatId, messageId, username = null) {
    if (username) {
      const cleanUser = username.replace(/^@/, '');
      return `https://t.me/${cleanUser}/${messageId}`;
    }
    const cleanId = String(chatId).replace(/^-100/, '').replace(/^-/, '');
    return `https://t.me/c/${cleanId}/${messageId}`;
  }

  /**
   * Generates jump link to VIP group General / ALL topic.
   */
  getVipGroupAllLink() {
    const vipChatId = this.config.vipGroup.chatId;
    const cleanId = String(vipChatId).replace(/^-100/, '').replace(/^-/, '');
    const threadId = this.config.vipGroup.allTopicThreadId || 1;
    return `https://t.me/c/${cleanId}/${threadId}`;
  }

  /**
   * Extracts clean display title from a Telegram message or video caption.
   */
  extractTitle(msg) {
    const raw = (msg.caption || msg.text || (msg.video && msg.video.file_name) || (msg.document && msg.document.file_name) || '신규 동영상 콘텐츠').trim();
    const firstLine = raw.split('\n')[0].trim();
    return firstLine.length > 90 ? firstLine.substring(0, 87) + '...' : firstLine;
  }

  /**
   * Formats the rich notification card for the General / ALL feed.
   */
  formatAllCard(channelConfig, title) {
    return (
      `🌐 <b>[ALL / 전체] 신규 업데이트 (${channelConfig.tag})</b>\n\n` +
      `📌 <b>${this._escapeHTML(title)}</b>\n\n` +
      `👉 <i>제목을 탭하여 채널에서 바로 시청하세요.</i>`
    );
  }

  /**
   * Formats the rich notification card for the dedicated topic.
   */
  formatCategoryCard(channelConfig, title) {
    return (
      `${channelConfig.emoji} <b>[${channelConfig.tag} / 전용] 신규 업데이트</b>\n\n` +
      `📌 <b>${this._escapeHTML(title)}</b>\n\n` +
      `👉 <i>제목을 탭하여 채널에서 바로 시청하세요.</i>`
    );
  }

  /**
   * Builds the dual action buttons (All & Dedicated Channel jump links).
   */
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
      // Not one of the 6 tracked VIP channels
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

    console.log(`\n📢 [VIP_FORWARDER] New Update Detected from [${channelConfig.name}] (${channelConfig.tag})`);
    console.log(`   📌 Title: ${title}`);
    console.log(`   🔗 Post Link: ${postLink}`);

    const keyboard = this.buildKeyboard(channelConfig, postLink);

    // 1. Post to Dedicated Category Topic (if thread ID is bound)
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
        const allThreadId = this.config.vipGroup.allTopicThreadId || 1;
        await this.bot.sendMessage(vipChatId, allText, {
          parse_mode: 'HTML',
          message_thread_id: allThreadId,
          reply_markup: keyboard,
          disable_web_page_preview: true
        });
        console.log(`   ✅ Posted to General / ALL Topic (Thread: ${allThreadId})`);
      } catch (err) {
        console.error(`   ❌ Failed to post to General/ALL topic:`, err.message);
      }
    }

    return true;
  }

  /**
   * Binds a topic thread ID to a specific channel key (e.g. KR, AV, 18, BJ, JP, CN).
   */
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

  /**
   * Helper command handlers for topic management in VIP group.
   */
  async handleGroupMessage(msg) {
    if (!msg.text) return;
    const text = msg.text.trim();
    const chatIdStr = String(msg.chat.id);
    const vipChatId = this.config.vipGroup.chatId;

    // Check if command is issued in VIP group
    if (chatIdStr === String(vipChatId)) {
      const threadId = msg.message_thread_id || null;

      // Command: /settopic <key> (e.g. /settopic KR, /settopic AV, /settopic 18)
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
            `✅ <b>[${res.channel.name}] (${res.channel.tag})</b> 채널이 이 토픽(Thread ID: <code>${threadId}</code>)에 성공적으로 연결되었습니다!`,
            { parse_mode: 'HTML', message_thread_id: threadId }
          );
        } else {
          await this.bot.sendMessage(msg.chat.id,
            `❌ 알 수 없는 채널 키: <code>${key}</code>\n사용 가능한 키: 18, CN, JP, KR, BJ, AV`,
            { parse_mode: 'HTML', message_thread_id: threadId }
          );
        }
      }

      // Command: /topics or /status
      if (text === '/topics' || text === '/status') {
        let statusMsg =
          `👑 <b>VIP 포워더 토픽 연결 현황</b>\n` +
          `━━━━━━━━━━━━━━━━\n` +
          `🌐 <b>VIP Group:</b> <code>${vipChatId}</code>\n` +
          `📌 <b>General / ALL Topic Thread:</b> <code>${this.config.vipGroup.allTopicThreadId || 1}</code>\n` +
          `━━━━━━━━━━━━━━━━\n` +
          `<b>연결된 6개 채널 목록:</b>\n\n`;

        for (const [chId, c] of Object.entries(this.config.channels)) {
          const boundThread = c.topicThreadId ? `Thread ID: <code>${c.topicThreadId}</code>` : `<i>⚠️ 미지정 (토픽에서 /settopic ${c.key} 입력)</i>`;
          statusMsg += `• ${c.emoji} <b>${c.name} (${c.tag})</b>\n  ID: <code>${chId}</code> ➔ ${boundThread}\n`;
        }

        await this.bot.sendMessage(msg.chat.id, statusMsg, { parse_mode: 'HTML', message_thread_id: threadId });
      }
    }
  }

  _escapeHTML(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Start the VIP bot listener.
   */
  start() {
    const token = process.env.VIP_BOT_TOKEN || process.env.BOT_TOKEN;
    if (!token) {
      console.error('❌ [VIP_FORWARDER] VIP_BOT_TOKEN is missing in vip/.env!');
      console.log('ℹ️ Please set VIP_BOT_TOKEN in vip/.env to start live forwarding.');
      return;
    }

    this.bot = new TelegramBot(token, { polling: true });

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

    console.log('🚀 [VIP_FORWARDER] VIP Channel Forwarder & Topic Hub is LIVE!');
    console.log(`   Tracking 6 channels -> Target VIP Supergroup: ${this.config.vipGroup.chatId}`);
  }
}

if (require.main === module) {
  const forwarder = new VipForwarder();
  forwarder.start();
}

module.exports = {
  VipForwarder
};
