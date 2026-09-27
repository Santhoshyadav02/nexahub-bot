/**
 * ============================================================
 * 🚀 VIP-2 FORWARDER PIPELINE & MEDIA TRANSLATION ENGINE
 * ============================================================
 * Fetches media & captions from source (@DreamTraveleo),
 * translates Chinese hashtags/descriptions into natural Korean,
 * posts to destination channel (V.I.P 정보공유 / -1004361683750),
 * and updates the interactive VIP-2 catalog.
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { formatVip2Caption } = require('./caption_translator');
const { Vip2CatalogManager } = require('./catalog_manager');

// Load environment variables for VIP-2
const envPath = path.resolve(__dirname, '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

const PROCESSED_PATH = path.resolve(__dirname, 'processed_ids.json');
const CONFIG_PATH = path.resolve(__dirname, 'config.json');

class Vip2ForwarderPipeline {
  constructor() {
    this.apiId = Number(process.env.TELEGRAM_API_ID || 30473305);
    this.apiHash = process.env.TELEGRAM_API_HASH || '6d91c6c87e7ff45433bb3aa90282e412';
    this.sessionString = process.env.TELEGRAM_SESSION_STRING || '';
    
    this.sourceChannel = process.env.VIP2_SOURCE_CHANNEL || 'DreamTraveleo';
    this.destChatId = process.env.VIP2_DEST_CHAT_ID || '-1004361683750';
    this.destInviteLink = process.env.VIP2_DEST_INVITE_LINK || 'https://t.me/+HKD-EF-iSK5iN2Rh';
    this.channelName = process.env.VIP2_CHANNEL_NAME || 'V.I.P 정보공유 (VIP-2)';

    this.client = null;
    this.catalogManager = new Vip2CatalogManager();
    this.processedIds = new Set();
    this.isRunning = false;
    this.isSyncing = false;

    this._loadProcessedIds();
  }

  _loadProcessedIds() {
    try {
      if (fs.existsSync(PROCESSED_PATH)) {
        const data = JSON.parse(fs.readFileSync(PROCESSED_PATH, 'utf8'));
        this.processedIds = new Set(data.map(String));
      }
    } catch (e) {
      console.warn('⚠️ [VIP2] Could not load processed_ids.json:', e.message);
      this.processedIds = new Set();
    }
  }

  _saveProcessedIds() {
    try {
      const arr = Array.from(this.processedIds).slice(-3000); // keep last 3000
      fs.writeFileSync(PROCESSED_PATH, JSON.stringify(arr, null, 2), 'utf8');
    } catch (e) {
      console.error('❌ [VIP2] Failed to save processed_ids.json:', e.message);
    }
  }

  async init() {
    if (this.client) return this.client;

    console.log('🔄 [VIP2] Connecting Telegram MTProto client...');
    this.client = new TelegramClient(
      new StringSession(this.sessionString),
      this.apiId,
      this.apiHash,
      {
        connectionRetries: 5,
        useWSS: false,
        timeout: 30000
      }
    );

    await this.client.connect();
    console.log('✅ [VIP2] Telegram MTProto client connected.');
    return this.client;
  }

  /**
   * Performs a synchronization scan of the source channel.
   */
  async syncRecent({ limit = 25 } = {}) {
    if (this.isSyncing) {
      console.log('⏳ [VIP2] Sync already in progress, skipping.');
      return { count: 0, status: 'busy' };
    }

    this.isSyncing = true;
    let publishedCount = 0;

    try {
      await this.init();

      console.log(`🔍 [VIP2] Fetching last ${limit} messages from @${this.sourceChannel}...`);
      const messages = await this.client.getMessages(this.sourceChannel, { limit });

      if (!messages || messages.length === 0) {
        console.log('ℹ️ [VIP2] No messages retrieved from source channel.');
        this.isSyncing = false;
        return { count: 0, status: 'empty' };
      }

      // Group messages by groupedId or process singles in chronological order (oldest to newest)
      const chronMessages = [...messages].reverse();
      const groups = new Map(); // key: groupedId or msgId -> array of messages

      for (const msg of chronMessages) {
        if (!msg.media) continue; // Skip text-only announcements
        
        // Check if already processed
        if (this.processedIds.has(String(msg.id))) {
          continue;
        }

        const gId = msg.groupedId ? String(msg.groupedId) : `single_${msg.id}`;
        if (!groups.has(gId)) {
          groups.set(gId, []);
        }
        groups.get(gId).push(msg);
      }

      console.log(`📦 [VIP2] Found ${groups.size} new media post(s) to process.`);

      for (const [groupId, groupMsgs] of groups.entries()) {
        try {
          // Find text/caption across the group
          let rawCaption = '';
          for (const m of groupMsgs) {
            if (m.text && m.text.trim()) {
              rawCaption = m.text.trim();
              break;
            } else if (m.message && m.message.trim()) {
              rawCaption = m.message.trim();
              break;
            }
          }

          // Format and translate Korean caption
          const { title, caption: formattedCaption } = await formatVip2Caption(
            rawCaption,
            this.destInviteLink
          );

          console.log(`\n📤 [VIP2] Forwarding Post [${groupId}] - Title: "${title}"`);

          let sentMsg = null;

          if (groupMsgs.length === 1) {
            // Single media post
            const targetMsg = groupMsgs[0];
            sentMsg = await this.client.sendFile(this.destChatId, {
              file: targetMsg.media,
              caption: formattedCaption,
              parseMode: 'html',
              forceDocument: false
            });
          } else {
            // Album group: send media with caption on the first item
            const mediaFiles = groupMsgs.map(m => m.media);
            sentMsg = await this.client.sendFile(this.destChatId, {
              file: mediaFiles,
              caption: formattedCaption,
              parseMode: 'html',
              forceDocument: false
            });
          }

          if (sentMsg) {
            // sentMsg can be a single message or an array of messages
            const publishedMsgId = Array.isArray(sentMsg) ? sentMsg[0].id : sentMsg.id;
            
            // Channel link: https://t.me/c/<stripped_chat_id>/<msg_id>
            const cleanChatId = String(this.destChatId).replace(/^-100/, '').replace(/^-/, '');
            const postLink = `https://t.me/c/${cleanChatId}/${publishedMsgId}`;

            // Add to VIP-2 interactive catalog
            this.catalogManager.addVideo({
              messageId: publishedMsgId,
              title: title,
              link: postLink,
              date: new Date().toISOString()
            });

            // Mark all items in this group as processed
            for (const m of groupMsgs) {
              this.processedIds.add(String(m.id));
            }
            this._saveProcessedIds();
            publishedCount++;

            console.log(`✅ [VIP2] Published successfully: ${postLink}`);

            // Brief pause to prevent rate limiting
            await new Promise(r => setTimeout(r, 2500));
          }
        } catch (postErr) {
          console.error(`❌ [VIP2] Error publishing post [${groupId}]:`, postErr.message);
        }
      }

      console.log(`\n🎉 [VIP2] Sync complete. Published ${publishedCount} new post(s).`);
      this.isSyncing = false;
      return { count: publishedCount, status: 'success' };
    } catch (err) {
      console.error('❌ [VIP2] Sync error:', err.message);
      this.isSyncing = false;
      return { count: publishedCount, status: 'error', error: err.message };
    }
  }

  /**
   * Starts periodic sync timer.
   */
  startPeriodicSync(intervalMinutes = 5) {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
    }
    const ms = Math.max(1, intervalMinutes) * 60 * 1000;
    console.log(`⏰ [VIP2] Starting periodic sync every ${intervalMinutes} minute(s).`);
    
    // Initial run
    this.syncRecent({ limit: 15 });

    this.syncTimer = setInterval(() => {
      console.log(`⏰ [VIP2] Running scheduled sync...`);
      this.syncRecent({ limit: 20 });
    }, ms);
  }

  stop() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
  }
}

module.exports = {
  Vip2ForwarderPipeline
};
