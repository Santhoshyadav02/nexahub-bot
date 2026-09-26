/**
 * ============================================================
 * 🔞 VIP CHANNEL SOURCE PIPELINE (@zzkbraxk -> VIP-🔞)
 * ============================================================
 * Secondary pipeline for the "VIP-🔞" category:
 *   1. Scans the public source channel: https://t.me/zzkbraxk (@zzkbraxk).
 *   2. Extracts ONLY valid video messages (strictly skips text ads, photos, stickers).
 *   3. Resolves album/groupedId titles from media groups so multi-part videos inherit the real title.
 *   4. Formats clean title & caption with exact title from source (no spam ads/links).
 *   5. Posts natively to VIP-🔞 (-1003845130520) with NO "Forwarded from" header.
 *   6. Automatically updates CatalogManager so VIP-Bot immediately shows real titles.
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const { CatalogManager } = require('./catalog_manager');
const MTProtoChannelReader = require('../mtproto_reader');

const SOURCE_CHANNEL_USERNAME = 'zzkbraxk';
const DEST_CHANNEL_KEY = '18';
const DEST_CHAT_ID = '-1003845130520';

const STATE_DIR = path.resolve(__dirname, 'state');
const PROCESSED_FILE = path.join(STATE_DIR, 'zzkbraxk_processed.json');
const LOG_PREFIX = '[ZZKBRAXK_PIPELINE]';

function cleanVideoTitle(rawText, defaultTitle = '') {
  if (!rawText || typeof rawText !== 'string') {
    return defaultTitle;
  }

  // Filter out promo ads
  if (rawText.includes('月付') || rawText.includes('年付') || rawText.includes('优惠力度') || rawText.includes('中秋狂欢') || rawText.includes('极搜JISOU')) {
    return defaultTitle;
  }

  // Remove URLs, tg links, mentions
  let text = rawText
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/t\.me\/\S+/gi, '')
    .replace(/@[a-zA-Z0-9_]+/g, '')
    .trim();

  // If text is only hashtags, clean '#'
  if (/^#[^\s#]+$/.test(text)) {
    text = text.replace(/^#+/, '');
  } else {
    text = text.replace(/#[^\s#]+/g, '').trim();
  }

  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) {
    return defaultTitle;
  }

  let title = lines[0];
  title = title.replace(/^[\s\-_:=*•▶▷►]+/, '').replace(/[\s\-_:=*•]+$/, '').trim();

  if (title.length > 90) {
    title = title.substring(0, 87) + '...';
  }

  return title.length >= 2 ? title : defaultTitle;
}

function formatCleanCaption(title) {
  return `🔞 <b>${escapeHTML(title)}</b>\n\n✨ <b>VIP-🔞 정보공유</b>`;
}

function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

class ZzkbraxkPipeline {
  constructor(options = {}) {
    this.sourceUsername = options.sourceUsername || SOURCE_CHANNEL_USERNAME;
    this.destChatId = options.destChatId || DEST_CHAT_ID;
    this.destKey = options.destKey || DEST_CHANNEL_KEY;
    this.reader = options.reader || new MTProtoChannelReader();
    this.catalogManager = options.catalogManager || new CatalogManager(path.resolve(__dirname, 'channel_catalogs.json'));
    this.processedFile = options.processedFile || PROCESSED_FILE;
    this.processedIds = this._loadProcessedIds();
  }

  _loadProcessedIds() {
    try {
      if (!fs.existsSync(STATE_DIR)) {
        fs.mkdirSync(STATE_DIR, { recursive: true });
      }
      if (fs.existsSync(this.processedFile)) {
        const data = JSON.parse(fs.readFileSync(this.processedFile, 'utf8'));
        return new Set(Array.isArray(data) ? data : (data.processedIds || []));
      }
    } catch (e) {
      console.warn(`${LOG_PREFIX} Could not load processed state: ${e.message}`);
    }
    return new Set();
  }

  _saveProcessedIds() {
    try {
      if (!fs.existsSync(STATE_DIR)) {
        fs.mkdirSync(STATE_DIR, { recursive: true });
      }
      const data = {
        updatedAt: new Date().toISOString(),
        totalProcessed: this.processedIds.size,
        processedIds: Array.from(this.processedIds)
      };
      fs.writeFileSync(this.processedFile, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
      console.error(`${LOG_PREFIX} Failed to save processed state: ${e.message}`);
    }
  }

  isVideoMessage(msg) {
    if (!msg || !msg.media) return false;
    if (msg.media.className === 'MessageMediaDocument' && msg.media.document) {
      const doc = msg.media.document;
      const mime = (doc.mimeType || '').toLowerCase();
      if (mime.startsWith('video/')) return true;

      if (doc.attributes && Array.isArray(doc.attributes)) {
        const isVideoAttr = doc.attributes.some(attr => attr.className === 'DocumentAttributeVideo');
        if (isVideoAttr) return true;
      }
    }
    return false;
  }

  async runSync(limit = 40) {
    console.log(`\n🔞 ${LOG_PREFIX} Starting sync from @${this.sourceUsername} -> VIP-🔞 (${this.destChatId})...`);

    if (!this.reader.hasCredentials()) {
      console.warn(`⚠️ ${LOG_PREFIX} MTProto credentials not configured. Skipping source sync.`);
      return { synced: 0, skipped: 0 };
    }

    try {
      await this.reader.connect();
    } catch (err) {
      console.error(`❌ ${LOG_PREFIX} Failed to connect MTProto reader: ${err.message}`);
      return { error: err.message };
    }

    const client = this.reader.client;
    if (!client) {
      console.error(`❌ ${LOG_PREFIX} GramJS client unavailable.`);
      return { error: 'GramJS client unavailable' };
    }

    let sourceEntity;
    let destEntity;
    try {
      sourceEntity = await this.reader.getCachedEntity(this.sourceUsername);
      destEntity = await this.reader.getCachedEntity(this.destChatId);
    } catch (e) {
      console.error(`❌ ${LOG_PREFIX} Entity resolution failed: ${e.message}`);
      return { error: e.message };
    }

    let messages = [];
    try {
      messages = await client.getMessages(sourceEntity, { limit: Math.max(limit, 40) });
    } catch (e) {
      console.error(`❌ ${LOG_PREFIX} Failed to fetch messages from @${this.sourceUsername}: ${e.message}`);
      return { error: e.message };
    }

    if (!messages || messages.length === 0) {
      console.log(`ℹ️ ${LOG_PREFIX} No messages found in @${this.sourceUsername}.`);
      return { synced: 0, skipped: 0 };
    }

    // Step 1: Build Album/Group Map to inherit titles for multi-part video albums
    const groupTitleMap = new Map();
    const groupVideosMap = new Map(); // groupedId -> [msgId, ...]

    for (const msg of messages) {
      if (msg.groupedId) {
        const gid = msg.groupedId.toString();
        const cleanT = cleanVideoTitle(msg.message);
        if (cleanT && !groupTitleMap.has(gid)) {
          groupTitleMap.set(gid, cleanT);
        }
        if (this.isVideoMessage(msg)) {
          if (!groupVideosMap.has(gid)) groupVideosMap.set(gid, []);
          groupVideosMap.get(gid).push(msg.id);
        }
      }
    }

    // Sort ascending (oldest to newest)
    const sortedMessages = [...messages].reverse();
    let syncedCount = 0;
    let skippedCount = 0;

    for (const msg of sortedMessages) {
      const msgId = msg.id;

      if (this.processedIds.has(msgId)) {
        continue;
      }

      if (!this.isVideoMessage(msg)) {
        this.processedIds.add(msgId);
        skippedCount++;
        continue;
      }

      // Step 2: Resolve accurate title from single message or album
      let rawTitle = cleanVideoTitle(msg.message);
      let albumTitle = '';
      let partSuffix = '';

      if (msg.groupedId) {
        const gid = msg.groupedId.toString();
        albumTitle = groupTitleMap.get(gid) || '';
        const groupList = (groupVideosMap.get(gid) || []).slice().sort((a, b) => a - b);
        if (groupList.length > 1) {
          const idx = groupList.indexOf(msgId);
          if (idx >= 0) {
            partSuffix = ` (${idx + 1}/${groupList.length})`;
          }
        }
      }

      let finalTitle = rawTitle || albumTitle;
      if (!finalTitle) {
        finalTitle = 'VIP-🔞 신규 영상';
      } else if (partSuffix && !finalTitle.includes('(')) {
        finalTitle = `${finalTitle}${partSuffix}`;
      }

      const caption = formatCleanCaption(finalTitle);

      console.log(`\n📹 ${LOG_PREFIX} Posting native video from @${this.sourceUsername} msg #${msgId}`);
      console.log(`   📌 Title: "${finalTitle}"`);

      try {
        const sent = await client.sendFile(destEntity, {
          file: msg.media,
          caption: caption,
          parseMode: 'html',
          supportsStreaming: true
        });

        const newMsgId = sent && sent.id;
        console.log(`   ✅ Successfully posted to VIP-🔞! (New Message ID: ${newMsgId})`);

        if (newMsgId) {
          const cleanDestId = String(this.destChatId).replace(/^-100/, '').replace(/^-/, '');
          const postLink = `https://t.me/c/${cleanDestId}/${newMsgId}`;
          this.catalogManager.addVideo(this.destKey, {
            messageId: newMsgId,
            title: finalTitle,
            link: postLink
          });
        }

        this.processedIds.add(msgId);
        this._saveProcessedIds();
        syncedCount++;

        await new Promise(r => setTimeout(r, 2000));
      } catch (postErr) {
        console.error(`   ❌ Failed to send video #${msgId}: ${postErr.message}`);
        this.reader.noteFloodWait(postErr);
        break;
      }
    }

    console.log(`\n🎉 ${LOG_PREFIX} Sync completed: ${syncedCount} videos posted, ${skippedCount} non-videos skipped.`);
    this._saveProcessedIds();
    return { synced: syncedCount, skipped: skippedCount };
  }
}

module.exports = {
  ZzkbraxkPipeline,
  cleanVideoTitle,
  formatCleanCaption
};

if (require.main === module) {
  const pipeline = new ZzkbraxkPipeline();
  pipeline.runSync(40)
    .then(res => {
      console.log('Result:', res);
      process.exit(0);
    })
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
