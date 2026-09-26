/**
 * ============================================================
 * 🔞 VIP CHANNEL SOURCE PIPELINE (@zzkbraxk -> VIP-🔞)
 * ============================================================
 * Secondary pipeline for the "VIP-🔞" category:
 *   1. Scans the public source channel: https://t.me/zzkbraxk (@zzkbraxk).
 *   2. Extracts ONLY valid video messages (strictly skips text ads, photos, stickers).
 *   3. Cleans source text into a clean title and formatted caption (removing source ads/links).
 *   4. Posts natively to VIP-🔞 (-1003845130520) with NO "Forwarded from" header.
 *   5. Automatically registers new posts with CatalogManager for VIP-Bot instant viewing.
 *   6. Tracks processed message IDs in a persistent state file to prevent duplicates.
 */

const fs = require('fs');
const path = require('path');
const { Api } = require('telegram');
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

function cleanVideoTitle(rawText, defaultTitle = 'VIP-🔞 신규 영상') {
  if (!rawText || typeof rawText !== 'string') {
    return defaultTitle;
  }

  // Remove URLs, tg links, mentions, and promotion hashtags
  let text = rawText
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/t\.me\/\S+/gi, '')
    .replace(/@[a-zA-Z0-9_]+/g, '')
    .replace(/#[^\s#]+/g, '')
    .trim();

  // Split lines and pick the first non-empty descriptive line
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) {
    return defaultTitle;
  }

  let title = lines[0];
  // Strip common noisy prefixes/suffixes
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
      console.warn(`${LOG_PREFIX} Could not load processed state, starting fresh: ${e.message}`);
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
    // Check GramJS MessageMediaDocument
    if (msg.media.className === 'MessageMediaDocument' && msg.media.document) {
      const doc = msg.media.document;
      const mime = (doc.mimeType || '').toLowerCase();
      if (mime.startsWith('video/')) return true;

      // Check document attributes for DocumentAttributeVideo
      if (doc.attributes && Array.isArray(doc.attributes)) {
        const isVideoAttr = doc.attributes.some(attr => attr.className === 'DocumentAttributeVideo');
        if (isVideoAttr) return true;
      }
    }
    return false;
  }

  async runSync(limit = 10) {
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
      messages = await client.getMessages(sourceEntity, { limit: Math.max(limit, 10) });
    } catch (e) {
      console.error(`❌ ${LOG_PREFIX} Failed to fetch messages from @${this.sourceUsername}: ${e.message}`);
      return { error: e.message };
    }

    if (!messages || messages.length === 0) {
      console.log(`ℹ️ ${LOG_PREFIX} No messages found in @${this.sourceUsername}.`);
      return { synced: 0, skipped: 0 };
    }

    // Sort ascending (oldest to newest) to post in chronological order
    const sortedMessages = [...messages].reverse();
    let syncedCount = 0;
    let skippedCount = 0;

    for (const msg of sortedMessages) {
      const msgId = msg.id;

      // Deduplication check
      if (this.processedIds.has(msgId)) {
        continue;
      }

      // Video media filter: Strictly ignore photos, text-only ads, stickers
      if (!this.isVideoMessage(msg)) {
        this.processedIds.add(msgId);
        skippedCount++;
        continue;
      }

      const rawText = msg.message || '';
      const cleanTitle = cleanVideoTitle(rawText);
      const caption = formatCleanCaption(cleanTitle);

      console.log(`\n📹 ${LOG_PREFIX} Posting native video from message #${msgId}`);
      console.log(`   📌 Title: "${cleanTitle}"`);

      try {
        // Send file natively using media object (NO "Forwarded from" header)
        const sent = await client.sendFile(destEntity, {
          file: msg.media,
          caption: caption,
          parseMode: 'html',
          supportsStreaming: true
        });

        const newMsgId = sent && sent.id;
        console.log(`   ✅ Successfully posted to VIP-🔞! (New Message ID: ${newMsgId})`);

        // Record in catalog for VIP-Bot instant hyperlink view
        if (newMsgId) {
          const cleanDestId = String(this.destChatId).replace(/^-100/, '').replace(/^-/, '');
          const postLink = `https://t.me/c/${cleanDestId}/${newMsgId}`;
          this.catalogManager.addVideo(this.destKey, {
            messageId: newMsgId,
            title: cleanTitle,
            link: postLink
          });
        }

        this.processedIds.add(msgId);
        this._saveProcessedIds();
        syncedCount++;

        // Small delay between posts to prevent rate-limiting
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
  pipeline.runSync(10)
    .then(res => {
      console.log('Result:', res);
      process.exit(0);
    })
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
