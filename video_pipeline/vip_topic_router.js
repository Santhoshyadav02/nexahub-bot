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
  ALL: '🌐 ALL (전체 6개 채널 종합)',
  BJ: '📺 BJ. (토끼 소녀 코스프레 데이트 · @tfccdet)',
  KR: '🇰🇷 KR (로맨틱한 분위기💥 · @ccsfvk)',
  JP: '🇯🇵 JP (모사 JP · @vsdxda)',
  CN: '🇨🇳 CN (가랑이 CN · @ccdjxc)',
  '18': '🔞 18.. (첩 · @ddkicr)',
  AV: '🎬 AV (사키 미즈미 · @cccddghhgf)'
};

// Exactly 6 Dedicated Channels (1 per Category / Topic)
const TOPIC_PRIMARY_CHANNELS = {
  BJ: { username: 'tfccdet', name: '토끼 소녀 코스프레 데이트(BJ)', threadId: 23, channelId: '-1004416217845' },
  KR: { username: 'ccsfvk', name: '로맨틱한 분위기💥(KR)', threadId: 20, channelId: '-1003780478806' },
  JP: { username: 'vsdxda', name: '모사 JP', threadId: 14, channelId: '-1004486764871' },
  CN: { username: 'ccdjxc', name: '가랑이(CN)', threadId: 17, channelId: '-1004481385613' },
  '18': { username: 'ddkicr', name: '첩(🔞..)', threadId: 8, channelId: '-1004419758275' },
  AV: { username: 'cccddghhgf', name: '사키 미즈미(AV)', threadId: 12, channelId: '-1004384169456' }
};

// Exact 6-Channel Mapping to VIP Category Topics
const CHANNEL_TOPIC_MAPPING = {
  // BJ -> Topic BJ. (@tfccdet)
  '-1004416217845': { category: 'BJ', name: '토끼 소녀 코스프레 데이트(BJ)', username: 'tfccdet' },
  '4416217845': { category: 'BJ', name: '토끼 소녀 코스프레 데이트(BJ)', username: 'tfccdet' },
  'tfccdet': { category: 'BJ', name: '토끼 소녀 코스프레 데이트(BJ)', username: 'tfccdet' },

  // KR -> Topic KR (@ccsfvk)
  '-1003780478806': { category: 'KR', name: '로맨틱한 분위기💥(KR)', username: 'ccsfvk' },
  '3780478806': { category: 'KR', name: '로맨틱한 분위기💥(KR)', username: 'ccsfvk' },
  'ccsfvk': { category: 'KR', name: '로맨틱한 분위기💥(KR)', username: 'ccsfvk' },

  // JP -> Topic JP (@vsdxda)
  '-1004486764871': { category: 'JP', name: '모사 JP', username: 'vsdxda' },
  '4486764871': { category: 'JP', name: '모사 JP', username: 'vsdxda' },
  'vsdxda': { category: 'JP', name: '모사 JP', username: 'vsdxda' },

  // CN -> Topic CN (@ccdjxc)
  '-1004481385613': { category: 'CN', name: '가랑이(CN)', username: 'ccdjxc' },
  '4481385613': { category: 'CN', name: '가랑이(CN)', username: 'ccdjxc' },
  'ccdjxc': { category: 'CN', name: '가랑이(CN)', username: 'ccdjxc' },

  // 18.. -> Topic 18.. (@ddkicr)
  '-1004419758275': { category: '18', name: '첩(🔞..)', username: 'ddkicr' },
  '4419758275': { category: '18', name: '첩(🔞..)', username: 'ddkicr' },
  'ddkicr': { category: '18', name: '첩(🔞..)', username: 'ddkicr' },

  // AV -> Topic AV (@cccddghhgf)
  '-1004384169456': { category: 'AV', name: '사키 미즈미(AV)', username: 'cccddghhgf' },
  '4384169456': { category: 'AV', name: '사키 미즈미(AV)', username: 'cccddghhgf' },
  'cccddghhgf': { category: 'AV', name: '사키 미즈미(AV)', username: 'cccddghhgf' }
};

const ALLOWED_USERNAMES = new Set(['tfccdet', 'ccsfvk', 'vsdxda', 'ccdjxc', 'ddkicr', 'cccddghhgf']);

function isStrictlyAllowedChannel(item) {
  if (!item) return false;
  const link = (item.directLink || item.url || '').toLowerCase();
  
  // Explicitly block the 4 removed channels
  if (
    link.includes('bzd4wrf') || link.includes('cccsefk') ||
    link.includes('e5brygh') || link.includes('sfgfem')
  ) {
    return false;
  }

  if (item.username && ALLOWED_USERNAMES.has(item.username.toLowerCase())) {
    return true;
  }

  const uMatch = link.match(/t\.me\/([a-z0-9_]+)\//i);
  if (uMatch && uMatch[1] && uMatch[1] !== 'c') {
    return ALLOWED_USERNAMES.has(uMatch[1].toLowerCase());
  }

  const chId = String(item.channelId || '').trim();
  if (chId && CHANNEL_TOPIC_MAPPING[chId]) {
    return true;
  }

  return false;
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
    this.stateDir = this._resolveStateDir(options.stateDir);
    this.cardsStateFile = path.join(this.stateDir, 'vip_topic_cards.json');
    this.threadsStateFile = path.join(this.stateDir, 'vip_topic_threads.json');
    this._threadMemoryMap = {};
    this.cardsData = this._loadCardsData();
  }

  _resolveStateDir(preferred) {
    if (preferred) {
      try {
        fs.mkdirSync(preferred, { recursive: true });
        return preferred;
      } catch (_) {}
    }
    const primary = process.platform === 'win32'
      ? path.resolve(__dirname, 'state')
      : '/var/lib/nexahub/video_pipeline/state';
    try {
      fs.mkdirSync(primary, { recursive: true });
      return primary;
    } catch (_) {
      const fallback = path.resolve(__dirname, 'state');
      try { fs.mkdirSync(fallback, { recursive: true }); } catch (__) {}
      return fallback;
    }
  }

  _loadCardsData() {
    let data = null;
    const categoryUserMap = {
      BJ: 'tfccdet',
      KR: 'ccsfvk',
      JP: 'vsdxda',
      CN: 'ccdjxc',
      '18': 'ddkicr',
      AV: 'cccddghhgf'
    };

    try {
      if (fs.existsSync(this.cardsStateFile)) {
        data = JSON.parse(fs.readFileSync(this.cardsStateFile, 'utf8'));
        if (data && data.categories) {
          for (const [cat, expectedUser] of Object.entries(categoryUserMap)) {
            data.categories[cat] = (data.categories[cat] || []).filter(it => {
              if (!isStrictlyAllowedChannel(it)) return false;
              const link = (it.directLink || it.url || '').toLowerCase();
              return (it.username && it.username.toLowerCase() === expectedUser) || link.includes(`/${expectedUser}/`);
            });
          }
          if (data.categories.ALL) {
            data.categories.ALL = data.categories.ALL.filter(isStrictlyAllowedChannel);
          }
        }
      }
    } catch (e) {
      console.warn(`${LOG_PREFIX} Could not load cards data:`, e.message);
    }

    if (!data || !data.categories) {
      data = {
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

    // Auto-seed from source_registry.json if any category is empty
    const isAnyCategoryEmpty = Object.keys(categoryUserMap).some(cat => {
      return !data.categories[cat] || data.categories[cat].length < 10;
    });

    if (isAnyCategoryEmpty || (data.categories.ALL || []).length < 40) {
      const candidatePaths = [
        path.join(this.stateDir, '..', 'source_registry.json'),
        path.join('/var/lib/nexahub', 'source_registry.json'),
        path.resolve(__dirname, '..', 'source_registry.json')
      ];
      for (const p of candidatePaths) {
        if (fs.existsSync(p)) {
          try {
            const reg = JSON.parse(fs.readFileSync(p, 'utf8'));
            const userMap = {
              tfccdet: 'BJ',
              ccsfvk: 'KR',
              vsdxda: 'JP',
              ccdjxc: 'CN',
              ddkicr: '18',
              cccddghhgf: 'AV'
            };
            if (Array.isArray(reg.posts)) {
              for (const post of reg.posts) {
                const cat = userMap[post.username];
                if (cat) {
                  const rec = {
                    title: post.title || post.name || '동영상',
                    channelId: String(post.chat_id || ''),
                    messageId: post.message_id,
                    directLink: post.telegram_url || `https://t.me/${post.username}/${post.message_id}`,
                    username: post.username,
                    category: cat,
                    publishedAt: post.published_at || new Date().toISOString()
                  };
                  if (!data.categories[cat]) data.categories[cat] = [];
                  const exists = data.categories[cat].some(x => x.directLink === rec.directLink);
                  if (!exists) {
                    data.categories[cat].push(rec);
                    data.categories.ALL.push(rec);
                  }
                }
              }
              console.log(`${LOG_PREFIX} Seeded ${data.categories.ALL.length} items from ${p}`);
              break;
            }
          } catch (err) {
            console.warn(`${LOG_PREFIX} Failed to seed from ${p}:`, err.message);
          }
        }
      }
    }

    // Ensure default thread map file exists
    try {
      if (!fs.existsSync(this.threadsStateFile)) {
        const defaultMap = {
          '23': 'BJ',
          '20': 'KR',
          '14': 'JP',
          '17': 'CN',
          '8': '18',
          '12': 'AV'
        };
        fs.writeFileSync(this.threadsStateFile, JSON.stringify(defaultMap, null, 2), 'utf8');
      }
    } catch (_) {}

    return data;
  }

  registerThreadMapping(threadId, category) {
    if (!threadId || !category) return;
    this._threadMemoryMap = this._threadMemoryMap || {};
    this._threadMemoryMap[String(threadId)] = category;
    try {
      let map = {};
      if (fs.existsSync(this.threadsStateFile)) {
        map = JSON.parse(fs.readFileSync(this.threadsStateFile, 'utf8'));
      }
      map[String(threadId)] = category;
      fs.writeFileSync(this.threadsStateFile, JSON.stringify(map, null, 2), 'utf8');
      console.log(`${LOG_PREFIX} Dynamic topic thread mapped: Thread ${threadId} -> Category ${category}`);
    } catch (e) {
      console.warn(`${LOG_PREFIX} Failed to save thread mapping:`, e.message);
    }
  }

  getCategoryForThread(threadId) {
    if (!threadId) return null;
    if (this._threadMemoryMap && this._threadMemoryMap[String(threadId)]) {
      return this._threadMemoryMap[String(threadId)];
    }
    try {
      if (fs.existsSync(this.threadsStateFile)) {
        const map = JSON.parse(fs.readFileSync(this.threadsStateFile, 'utf8'));
        if (map[String(threadId)]) {
          this._threadMemoryMap = this._threadMemoryMap || {};
          this._threadMemoryMap[String(threadId)] = map[String(threadId)];
          return map[String(threadId)];
        }
      }
    } catch (_) {}
    return null;
  }

  formatTopicChooser(threadId) {
    const text = `📌 <b>VIP 토픽 채널 연결</b>\n\n이 토픽에 연결할 채널 카테고리를 선택해주세요.\n아래 버튼을 1회 누르면 이 토픽이 해당 채널 전용으로 영구 저장됩니다.`;
    const keyboard = {
      inline_keyboard: [
        [
          { text: '📺 BJ. (@tfccdet)', callback_data: `vip_bind:BJ:${threadId}` },
          { text: '🇰🇷 KR (@ccsfvk)', callback_data: `vip_bind:KR:${threadId}` }
        ],
        [
          { text: '🇯🇵 JP (@vsdxda)', callback_data: `vip_bind:JP:${threadId}` },
          { text: '🇨🇳 CN (@ccdjxc)', callback_data: `vip_bind:CN:${threadId}` }
        ],
        [
          { text: '🔞 18.. (@ddkicr)', callback_data: `vip_bind:18:${threadId}` },
          { text: '🎬 AV (@cccddghhgf)', callback_data: `vip_bind:AV:${threadId}` }
        ],
        [
          { text: '🌐 ALL (전체 채널 종합)', callback_data: `vip_bind:ALL:${threadId}` }
        ]
      ]
    };
    return { text, keyboard };
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
    let items = [];

    if (category === 'ALL') {
      // Interleave all 6 channels in balanced round-robin order (BJ, CN, KR, JP, 18.., AV)
      const cats = ['BJ', 'CN', 'KR', 'JP', '18', 'AV'];
      const catItems = {};
      let maxLen = 0;
      for (const c of cats) {
        catItems[c] = (this.cardsData.categories[c] || []).filter(isStrictlyAllowedChannel);
        if (catItems[c].length > maxLen) maxLen = catItems[c].length;
      }
      const interleaved = [];
      for (let i = 0; i < maxLen; i++) {
        for (const c of cats) {
          if (catItems[c][i]) {
            interleaved.push(catItems[c][i]);
          }
        }
      }
      items = interleaved.length > 0 ? interleaved : (this.cardsData.categories.ALL || []).filter(isStrictlyAllowedChannel);
    } else if (TOPIC_PRIMARY_CHANNELS[category]) {
      const primary = TOPIC_PRIMARY_CHANNELS[category];
      const primaryUser = (primary.username || '').toLowerCase();
      items = (this.cardsData.categories[category] || []).filter(it => {
        if (!isStrictlyAllowedChannel(it)) return false;
        const link = (it.directLink || it.url || '').toLowerCase();
        return (it.username && it.username.toLowerCase() === primaryUser) || link.includes(`/${primaryUser}/`);
      });
    } else {
      items = (this.cardsData.categories[category] || []).filter(isStrictlyAllowedChannel);
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
        const badge = (category === 'ALL' && item.category) ? `<b>[${item.category}]</b> ` : '';
        text += `${num}. ${badge}<a href="${link}">${title}</a>\n\n`;
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

    const keyboardRows = [];
    if (navRow.length > 0) {
      keyboardRows.push(navRow);
    }

    // Category quick switch buttons
    keyboardRows.push([
      { text: category === 'BJ' ? '🔘 BJ.' : '📺 BJ.', callback_data: 'vip_card:BJ:1' },
      { text: category === 'KR' ? '🔘 KR' : '🇰🇷 KR', callback_data: 'vip_card:KR:1' },
      { text: category === 'JP' ? '🔘 JP' : '🇯🇵 JP', callback_data: 'vip_card:JP:1' }
    ]);
    keyboardRows.push([
      { text: category === 'CN' ? '🔘 CN' : '🇨🇳 CN', callback_data: 'vip_card:CN:1' },
      { text: category === '18' ? '🔘 18..' : '🔞 18..', callback_data: 'vip_card:18:1' },
      { text: category === 'AV' ? '🔘 AV' : '🎬 AV', callback_data: 'vip_card:AV:1' }
    ]);
    if (category !== 'ALL') {
      keyboardRows.push([
        { text: '🌐 ALL (전체 채널 모아보기)', callback_data: 'vip_card:ALL:1' }
      ]);
    }

    const keyboard = {
      inline_keyboard: keyboardRows
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
