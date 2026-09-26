/**
 * ============================================================
 * 🔄 VIP-🔞 TELEGRAM CHANNEL INGESTION PIPELINE (@zzkbraxk)
 * ============================================================
 * Dual-pipeline for VIP-🔞:
 * Ingests latest video posts from source channel https://t.me/zzkbraxk,
 * filters spam/ads, generates clean title & Korean captions, and forwards/posts
 * to the VIP-18 channel (-1003845130520).
 *
 * Persists processed message IDs in vip/state/zzkbraxk_ledger.json.
 */

const fs = require('fs');
const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const LEDGER_PATH = path.resolve(__dirname, 'state', 'zzkbraxk_ledger.json');
const SOURCE_CHANNEL = 'zzkbraxk';
const DEST_CHANNEL_ID = '-1003845130520'; // VIP-18

class ZzkbraxkPipeline {
  constructor(options = {}) {
    this.sourceChannel = options.sourceChannel || SOURCE_CHANNEL;
    this.destChannelId = options.destChannelId || DEST_CHANNEL_ID;
    this.ledgerPath = options.ledgerPath || LEDGER_PATH;
    this.apiId = Number(process.env.TELEGRAM_API_ID);
    this.apiHash = process.env.TELEGRAM_API_HASH;
    this.sessionString = process.env.TELEGRAM_SESSION_STRING || '';
    this.ledger = this._loadLedger();
    this.client = null;
  }

  _loadLedger() {
    try {
      const dir = path.dirname(this.ledgerPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (fs.existsSync(this.ledgerPath)) {
        return JSON.parse(fs.readFileSync(this.ledgerPath, 'utf8'));
      }
    } catch (e) {
      console.warn('⚠️ [ZZKBRAXK_PIPELINE] Could not load ledger:', e.message);
    }
    return { processedIds: [], lastCheck: null, totalForwarded: 0 };
  }

  _saveLedger() {
    try {
      const dir = path.dirname(this.ledgerPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.ledgerPath, JSON.stringify(this.ledger, null, 2), 'utf8');
    } catch (e) {
      console.error('❌ [ZZKBRAXK_PIPELINE] Failed to save ledger:', e.message);
    }
  }

  async getClient() {
    if (this.client && this.client.connected) {
      return this.client;
    }
    this.client = new TelegramClient(
      new StringSession(this.sessionString),
      this.apiId,
      this.apiHash,
      { connectionRetries: 5 }
    );
    await this.client.connect();
    return this.client;
  }

  isSpamOrAd(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    // Filter membership promo texts, price lists, payment instructions
    const adKeywords = [
      '月付', '年付', '永久', '会员优惠', '低价', '微信', '加微信', '价格',
      '88元', '188元', '228元', '中秋', '折扣', '群主'
    ];
    return adKeywords.some(kw => lower.includes(kw));
  }

  cleanTitle(text, msgId) {
    if (!text || text.trim() === '') {
      return `🔞 18+ 코스프레 / 섹시 비디오 #${msgId}`;
    }

    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    let title = lines[0] || `🔞 18+ 코스프레 / 섹시 비디오 #${msgId}`;

    // Clean tags or promo handles
    title = title
      .replace(/https?:\/\/\S+/gi, '')
      .replace(/@[a-zA-Z0-9_]+/gi, '')
      .replace(/【|】|\[|\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (title.length > 80) {
      title = title.substring(0, 77) + '...';
    }

    return title || `🔞 18+ 프리미엄 영상 #${msgId}`;
  }

  /**
   * Scans @zzkbraxk for new media posts and forwards them to VIP-18.
   */
  async runSync(limit = 10) {
    console.log(`\n=======================================================`);
    console.log(`🔄 [ZZKBRAXK_PIPELINE] Checking @${this.sourceChannel} for New Posts`);
    console.log(`=======================================================`);

    if (!this.apiId || !this.apiHash || !this.sessionString) {
      console.error('❌ [ZZKBRAXK_PIPELINE] Missing Telegram MTProto API credentials!');
      return { success: false, error: 'MISSING_CREDENTIALS' };
    }

    const client = await this.getClient();
    let sourceEntity, destEntity;

    try {
      sourceEntity = await client.getEntity(this.sourceChannel);
      destEntity = await client.getEntity(this.destChannelId);
    } catch (err) {
      console.error('❌ [ZZKBRAXK_PIPELINE] Entity resolution failed:', err.message);
      return { success: false, error: err.message };
    }

    const messages = await client.getMessages(sourceEntity, { limit });
    console.log(`   Fetched ${messages.length} recent messages from @${this.sourceChannel}.`);

    let newPostsCount = 0;
    // Process messages in chronological order (oldest to newest)
    const reversedMsgs = messages.slice().reverse();

    for (const msg of reversedMsgs) {
      if (this.ledger.processedIds.includes(msg.id)) {
        continue;
      }

      // Check if message has media (Video, Document, or Photo)
      const hasMedia = Boolean(msg.media);
      const text = (msg.message || '').trim();

      // Skip ad texts without media or pure promo ads
      if (this.isSpamOrAd(text)) {
        console.log(`   ⏭️ Skipping ad post ID ${msg.id}`);
        this.ledger.processedIds.push(msg.id);
        this._saveLedger();
        continue;
      }

      if (!hasMedia && !text) {
        this.ledger.processedIds.push(msg.id);
        this._saveLedger();
        continue;
      }

      console.log(`\n   📥 Found New Post [ID: ${msg.id}]`);
      const title = this.cleanTitle(text, msg.id);
      const sourcePostLink = `https://t.me/${this.sourceChannel}/${msg.id}`;
      console.log(`      Title: ${title}`);
      console.log(`      Source Link: ${sourcePostLink}`);

      try {
        // Forward message to destination channel VIP-18
        if (hasMedia) {
          // Forward the actual media post
          await client.forwardMessages(destEntity, {
            messages: [msg.id],
            fromPeer: sourceEntity
          });
          console.log(`      ✅ Successfully forwarded video post [ID: ${msg.id}] to VIP-18!`);
        } else {
          // If text-only with video link, send formatted card
          const caption =
            `🔞 <b>[18+ / 신규 업데이트]</b>\n\n` +
            `📌 <b>${title}</b>\n\n` +
            `🔗 <a href="${sourcePostLink}">동영상 바로보기</a>\n\n` +
            `👉 <i>위 링크를 탭하여 시청하세요.</i>`;

          await client.sendMessage(destEntity, {
            message: caption,
            parseMode: 'html',
            linkPreview: true
          });
          console.log(`      ✅ Successfully posted update card [ID: ${msg.id}] to VIP-18!`);
        }

        this.ledger.processedIds.push(msg.id);
        if (this.ledger.processedIds.length > 500) {
          this.ledger.processedIds = this.ledger.processedIds.slice(-500);
        }
        this.ledger.totalForwarded = (this.ledger.totalForwarded || 0) + 1;
        this.ledger.lastCheck = new Date().toISOString();
        this._saveLedger();
        newPostsCount++;

        // Rate pacing: 2.5s between forwards
        await new Promise(r => setTimeout(r, 2500));
      } catch (postErr) {
        console.error(`      ❌ Failed to forward post ID ${msg.id}:`, postErr.message);
      }
    }

    console.log(`\n🎉 [ZZKBRAXK_PIPELINE] Cycle Complete: ${newPostsCount} new post(s) forwarded.`);
    console.log(`=======================================================\n`);
    return { success: true, newPostsCount };
  }
}

if (require.main === module) {
  const pipeline = new ZzkbraxkPipeline();
  pipeline.runSync(5).then(res => {
    console.log('Result:', res);
    process.exit(0);
  }).catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = {
  ZzkbraxkPipeline
};
