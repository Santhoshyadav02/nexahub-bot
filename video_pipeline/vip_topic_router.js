/**
 * ============================================================
 * 👑 VIP TOPIC ROUTER & DIRECT CHANNEL CARD GENERATOR
 * ============================================================
 * Connects the 10 storage channels to the VIP Supergroup topics:
 * (BJ., KR, JP, CN, 18..., AV, General, All)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

try {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
} catch (e) {}

const LOG_PREFIX = '[VIP_TOPIC_ROUTER]';

// Target VIP Group Configuration
const DEFAULT_VIP_CHAT_ID = '-1003983458986';

// Exact Verified Topic Thread IDs mapped in >> V.I.P 정보공유 <<
const TOPIC_THREAD_IDS = {
  ALL: null, // Main group stream / All feed
  BJ: 23,
  KR: 20,
  JP: 14,
  CN: 17,
  '18': 8,
  AV: 12
};

const CATEGORY_DISPLAY_TITLES = {
  ALL: '🌐 All',
  BJ: '📺 BJ.',
  KR: '🇰🇷 KR',
  JP: '🇯🇵 JP',
  CN: '🇨🇳 CN',
  '18': '🔞 18..',
  AV: '🎬 AV'
};

// Exactly 6 Dedicated Channels (1 per Category / Topic) from Scraper 2
const TOPIC_PRIMARY_CHANNELS = {
  BJ: { channelId: '-1004416217845', username: 'tfccdet', name: '토끼 소녀 코스프레 데이트(BJ)', threadId: 23 },
  KR: { channelId: '-1003780478806', username: 'ccsfvk', name: '로맨틱한 분위기💥(KR)', threadId: 20 },
  JP: { channelId: '-1003725861834', username: 'vsdxda', name: '모사 JP', threadId: 14 },
  CN: { channelId: '-1004419758275', username: 'ccdjxc', name: '가랑이(CN)', threadId: 17 },
  '18': { channelId: '-1004481385613', username: 'ddkicr', name: '첩(🔞..)', threadId: 8 },
  AV: { channelId: '-1004483241550', username: 'cccddghhgf', name: '사키 미즈미(AV)', threadId: 12 }
};

// Exact 6-Channel Mapping to VIP Category Topics (Only Scraper 2 channels connected)
const CHANNEL_TOPIC_MAPPING = {
  '-1004416217845': { category: 'BJ', name: '토끼 소녀 코스프레 데이트(BJ)', threadId: 23, username: 'tfccdet' },
  '-1003780478806': { category: 'KR', name: '로맨틱한 분위기💥(KR)', threadId: 20, username: 'ccsfvk' },
  '-1003725861834': { category: 'JP', name: '모사 JP', threadId: 14, username: 'vsdxda' },
  '-1004419758275': { category: 'CN', name: '가랑이(CN)', threadId: 17, username: 'ccdjxc' },
  '-1004481385613': { category: '18', name: '첩(🔞..)', threadId: 8, username: 'ddkicr' },
  '-1004483241550': { category: 'AV', name: '사키 미즈미(AV)', threadId: 12, username: 'cccddghhgf' }
};

const ALLOWED_USERNAMES = new Set(['tfccdet', 'ccsfvk', 'vsdxda', 'ccdjxc', 'ddkicr', 'cccddghhgf']);
const ALLOWED_CHANNEL_IDS = new Set([
  '-1004416217845', '4416217845',
  '-1003780478806', '3780478806',
  '-1003725861834', '3725861834',
  '-1004419758275', '4419758275',
  '-1004481385613', '4481385613',
  '-1004483241550', '4483241550'
]);

function isStrictlyAllowedChannel(item) {
  if (!item) return false;
  const chId = String(item.channelId || '').trim();
  const cleanId = chId.replace(/^-100/, '').replace(/^-/, '');
  if (chId && !ALLOWED_CHANNEL_IDS.has(chId) && !ALLOWED_CHANNEL_IDS.has(cleanId)) {
    return false;
  }
  const link = (item.directLink || item.url || '').toLowerCase();
  if (
    link.includes('bzd4wrf') || link.includes('cccsefk') ||
    link.includes('e5brygh') || link.includes('sfgfem') ||
    link.includes('4464504918') || link.includes('4486764871') ||
    link.includes('4384169456') || link.includes('3786693669')
  ) {
    return false;
  }
  const uMatch = link.match(/t\.me\/([a-z0-9_]+)\//i);
  if (uMatch && uMatch[1] && uMatch[1] !== 'c') {
    if (!ALLOWED_USERNAMES.has(uMatch[1].toLowerCase())) {
      return false;
    }
  }
  return true;
}

const sharedHttpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 25,
  timeout: 10000
});

class VipTopicRouter {
  constructor(options = {}) {
    this.vipChatId = options.vipChatId || process.env.VIP_SUPERGROUP_CHAT_ID || DEFAULT_VIP_CHAT_ID;
    this.botToken = options.botToken || process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
    this.stateDir = options.stateDir || '/var/lib/nexahub/video_pipeline/state';
    this.cardsStateFile = path.join(this.stateDir, 'vip_topic_cards.json');
    this.cardsData = this._loadCardsData();
  }

  _loadCardsData() {
    try {
      if (fs.existsSync(this.cardsStateFile)) {
        const data = JSON.parse(fs.readFileSync(this.cardsStateFile, 'utf8'));
        if (data && data.categories) {
          for (const cat of Object.keys(data.categories)) {
            data.categories[cat] = (data.categories[cat] || []).filter(isStrictlyAllowedChannel);
          }
          return data;
        }
      }
    } catch (e) {
      console.warn(`${LOG_PREFIX} Could not load cards data:`, e.message);
    }
    return {
      categories: {
        BJ: [],
        KR: [],
        JP: [],
        CN: [],
        '18': [],
        AV: [],
        ALL: []
      },
      updatedAt: new Date().toISOString()
    };
  }

  _saveCardsData() {
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      const tmpFile = `${this.cardsStateFile}.tmp.${Date.now()}`;
      fs.writeFileSync(tmpFile, JSON.stringify(this.cardsData, null, 2), 'utf8');
      fs.renameSync(tmpFile, this.cardsStateFile);
    } catch (e) {
      console.error(`${LOG_PREFIX} Error saving cards data:`, e.message);
    }
  }

  async _botApi(method, payload) {
    if (!this.botToken) {
      console.warn(`${LOG_PREFIX} Bot token not set.`);
      return { ok: false, error: 'NO_BOT_TOKEN' };
    }

    return new Promise((resolve) => {
      const postData = JSON.stringify(payload);
      const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${this.botToken}/${method}`,
        method: 'POST',
        agent: sharedHttpsAgent,
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            resolve({ ok: false, error: body });
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, error: 'REQUEST_TIMEOUT' });
      });

      req.on('error', (err) => {
        resolve({ ok: false, error: err.message });
      });

      req.write(postData);
      req.end();
    });
  }

  buildDirectChannelLink(channelId, messageId, username) {
    if (username && username.trim()) {
      return `https://t.me/${username.replace('@', '')}/${messageId}`;
    }
    const cleanId = String(channelId).replace(/^-100/, '').replace(/^-/, '');
    return `https://t.me/c/${cleanId}/${messageId}`;
  }

  buildTopicFooterKeyboard(category = null) {
    const cleanGid = this.vipChatId.replace(/^-100/, '');
    const buttons = [
      { text: '🌐 All', url: `https://t.me/c/${cleanGid}` }
    ];

    if (category && category !== 'ALL') {
      const threadId = TOPIC_THREAD_IDS[category];
      const title = CATEGORY_DISPLAY_TITLES[category] || `📺 ${category}`;
      if (threadId) {
        buttons.push({ text: title, url: `https://t.me/c/${cleanGid}/${threadId}` });
      }
    }

    return {
      inline_keyboard: [buttons]
    };
  }

  /**
   * Formats a paginated category navigation card matching user requested style:
   * Only Forward [다음 ➡️] and Backward [⬅️ 이전] buttons (Home button removed).
   */
  formatCategoryCard(category, page = 1, pageSize = 8) {
    let items = (this.cardsData.categories[category] || []).filter(isStrictlyAllowedChannel);

    // Ensure 1 dedicated channel per topic (except ALL)
    if (category !== 'ALL' && TOPIC_PRIMARY_CHANNELS[category]) {
      const primary = TOPIC_PRIMARY_CHANNELS[category];
      const primaryId = String(primary.channelId);
      const primaryUser = (primary.username || '').toLowerCase();
      items = items.filter(it =>
        String(it.channelId) === primaryId ||
        (it.directLink && primaryUser && it.directLink.toLowerCase().includes(`/${primaryUser}/`))
      );
    }

    const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const startIndex = (safePage - 1) * pageSize;
    const pageItems = items.slice(startIndex, startIndex + pageSize);

    const displayTitle = CATEGORY_DISPLAY_TITLES[category] || `📺 ${category}`;
    let text = `<b>${displayTitle}</b>\n이 채널의 최신 동영상 목록입니다.\n\n`;

    if (pageItems.length === 0) {
      text += `<i>현재 등록된 최신 동영상이 없습니다.</i>\n\n`;
    } else {
      pageItems.forEach((item, idx) => {
        const num = startIndex + idx + 1;
        const link = item.directLink || item.url || '#';
        const title = (item.title || '동영상').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        text += `${num}. <a href="${link}">${title}</a>\n\n`;
      });
    }

    text += `페이지 ${safePage}/${totalPages}`;

    const navRow = [];
    if (safePage > 1) {
      navRow.push({ text: '⬅️ 이전', callback_data: `vip_card:${category}:${safePage - 1}` });
    }
    if (safePage < totalPages) {
      navRow.push({ text: '다음 ➡️', callback_data: `vip_card:${category}:${safePage + 1}` });
    }

    const keyboard = {
      inline_keyboard: navRow.length ? [navRow] : []
    };

    return { text, keyboard };
  }

  async onVideoPublished({ channelId, messageId, title, duration, size, channelUsername }) {
    try {
      const channelInfo = CHANNEL_TOPIC_MAPPING[String(channelId)];
      if (!channelInfo) {
        // Not one of the 6 Scraper 2 channels (e.g. A Muse, Dating, Romance, Lustful Hostess) - DO NOT POST TO VIP
        return { ok: false, reason: 'CHANNEL_NOT_CONNECTED_TO_VIP' };
      }

      const directLink = this.buildDirectChannelLink(channelId, messageId, channelInfo.username || channelUsername);
      const record = {
        title: title || '동영상',
        channelId: String(channelId),
        messageId,
        directLink,
        category: channelInfo.category,
        publishedAt: new Date().toISOString()
      };

      // 1. Add to specific Category Topic list (unshifted to top: newest at top #1)
      if (channelInfo.category && channelInfo.category !== 'ALL') {
        if (!this.cardsData.categories[channelInfo.category]) {
          this.cardsData.categories[channelInfo.category] = [];
        }
        this.cardsData.categories[channelInfo.category].unshift(record);
        this.cardsData.categories[channelInfo.category] = this.cardsData.categories[channelInfo.category].slice(0, 100);
      }

      // 2. Add to ALL master feed (unshifted to top: newest at top #1)
      if (!this.cardsData.categories.ALL) {
        this.cardsData.categories.ALL = [];
      }
      this.cardsData.categories.ALL.unshift(record);
      this.cardsData.categories.ALL = this.cardsData.categories.ALL.slice(0, 200);

      this._saveCardsData();

      // 3. Send update to specific Category Topic
      if (channelInfo.threadId) {
        const safeTitle = (title || '동영상').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const topicMsg = `🎬 <b>[${channelInfo.category}] 신규 동영상 등록</b>\n\n` +
          `📌 <a href="${directLink}"><b>${safeTitle}</b></a>\n\n` +
          `📥 <i>위 파란색 제목 링크를 누르면 채널의 동영상으로 바로 이동합니다.</i>`;

        await this._botApi('sendMessage', {
          chat_id: this.vipChatId,
          message_thread_id: channelInfo.threadId,
          text: topicMsg,
          parse_mode: 'HTML',
          reply_markup: this.buildTopicFooterKeyboard(channelInfo.category)
        });
      }

      // 4. Send update to "ALL" master feed
      const safeTitleAll = (title || '동영상').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const allMsg = `🌐 <b>[ALL / 전체] 신규 업데이트 (${channelInfo.category})</b>\n\n` +
        `📌 <a href="${directLink}"><b>${safeTitleAll}</b></a>\n\n` +
        `👉 <i>제목을 탭하여 채널에서 바로 시청하세요.</i>`;

      await this._botApi('sendMessage', {
        chat_id: this.vipChatId,
        text: allMsg,
        parse_mode: 'HTML',
        reply_markup: this.buildTopicFooterKeyboard(channelInfo.category)
      });

      return { ok: true, directLink, category: channelInfo.category };
    } catch (e) {
      console.error(`${LOG_PREFIX} Error in onVideoPublished:`, e);
      return { ok: false, error: e.message };
    }
  }
}

module.exports = {
  VipTopicRouter,
  TOPIC_THREAD_IDS,
  CATEGORY_DISPLAY_TITLES,
  TOPIC_PRIMARY_CHANNELS,
  CHANNEL_TOPIC_MAPPING
};
