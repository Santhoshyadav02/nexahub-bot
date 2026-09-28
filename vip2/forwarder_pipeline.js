/**
 * ============================================================
 * 🚀 VIP-2 FORWARDER PIPELINE (MULTI-SOURCE + MULTI-DESTINATION)
 * ============================================================
 * - Sources: @DreamTraveleo, @zzkbraxk
 * - Primary Channel: V.I.P 정보공유 (-1004361683750)
 *   - 1 Teaser Preview in Channel + Full Videos in Discussion Thread (-1004442518512)
 * - Extra Groups / Channels: >> V.I.P 정보공유 << (-1003983458986)
 *   - Full native media album/video + Korean translated captions
 * - Multi-layer deduplication (Channel-specific ID + Media Signatures + Content Hashes)
 * - 5-minute strict sync schedule
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { formatVip2Caption } = require('./caption_translator');
const { Vip2CatalogManager } = require('./catalog_manager');

// Load environment variables for VIP-2 (root fallback + local overrides)
dotenv.config({ path: path.resolve(__dirname, '../.env') });
const envPath = path.resolve(__dirname, '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath, override: true });
}

const PROCESSED_PATH = path.resolve(__dirname, 'processed_ids.json');
const SIGNATURES_PATH = path.resolve(__dirname, 'media_signatures.json');
const HASHES_PATH = path.resolve(__dirname, 'content_hashes.json');
const CONFIG_PATH = path.resolve(__dirname, 'config.json');

class Vip2ForwarderPipeline {
  constructor() {
    this.apiId = Number(process.env.TELEGRAM_API_ID || 30473305);
    this.apiHash = process.env.TELEGRAM_API_HASH || '6d91c6c87e7ff45433bb3aa90282e412';
    this.sessionString = process.env.TELEGRAM_SESSION_STRING || '';

    // Multiple source channels
    const rawSources = process.env.VIP2_SOURCE_CHANNELS || 'DreamTraveleo,zzkbraxk';
    this.sourceChannels = rawSources.split(',').map(s => s.trim().replace(/^@/, '')).filter(Boolean);

    // Primary destinations
    this.destChatId = process.env.VIP2_DEST_CHAT_ID || '-1004361683750';
    this.discussionChatId = process.env.VIP2_DISCUSSION_CHAT_ID || '-1004442518512';
    this.destInviteLink = process.env.VIP2_DEST_INVITE_LINK || 'https://t.me/+HKD-EF-iSK5iN2Rh';
    this.channelName = process.env.VIP2_CHANNEL_NAME || 'V.I.P 정보공유 (VIP-2)';

    // Extra destination groups/channels to broadcast to
    const rawExtra = process.env.VIP2_EXTRA_DEST_CHATS || '-1003983458986';
    this.extraDestChats = rawExtra.split(',').map(s => s.trim()).filter(Boolean);

    this.client = null;
    this.catalogManager = new Vip2CatalogManager();

    // Deduplication tracking
    this.processedIds = new Set();
    this.mediaSignatures = new Set();
    this.contentHashes = new Set();

    this.isRunning = false;
    this.isSyncing = false;
    this.lastSyncTime = null;
    this.nextSyncTime = null;
    this.syncIntervalMs = 5 * 60 * 1000; // 5 minutes

    this._loadDeduplicationData();
  }

  _loadDeduplicationData() {
    try {
      if (fs.existsSync(PROCESSED_PATH)) {
        const data = JSON.parse(fs.readFileSync(PROCESSED_PATH, 'utf8'));
        this.processedIds = new Set(data.map(String));
      }
    } catch (e) {
      console.warn('⚠️ [VIP2] Could not load processed_ids.json:', e.message);
      this.processedIds = new Set();
    }

    try {
      if (fs.existsSync(SIGNATURES_PATH)) {
        const data = JSON.parse(fs.readFileSync(SIGNATURES_PATH, 'utf8'));
        this.mediaSignatures = new Set(data.map(String));
      }
    } catch (e) {
      this.mediaSignatures = new Set();
    }

    try {
      if (fs.existsSync(HASHES_PATH)) {
        const data = JSON.parse(fs.readFileSync(HASHES_PATH, 'utf8'));
        this.contentHashes = new Set(data.map(String));
      }
    } catch (e) {
      this.contentHashes = new Set();
    }
  }

  _saveDeduplicationData() {
    try {
      const idsArr = Array.from(this.processedIds).slice(-4000);
      fs.writeFileSync(PROCESSED_PATH, JSON.stringify(idsArr, null, 2), 'utf8');

      const sigsArr = Array.from(this.mediaSignatures).slice(-4000);
      fs.writeFileSync(SIGNATURES_PATH, JSON.stringify(sigsArr, null, 2), 'utf8');

      const hashesArr = Array.from(this.contentHashes).slice(-4000);
      fs.writeFileSync(HASHES_PATH, JSON.stringify(hashesArr, null, 2), 'utf8');
    } catch (e) {
      console.error('❌ [VIP2] Failed to save deduplication records:', e.message);
    }
  }

  _extractMediaSignature(media) {
    if (!media) return null;
    if (media.document) {
      const doc = media.document;
      return `doc_${doc.id}_${doc.size || 0}`;
    }
    if (media.photo) {
      const photo = media.photo;
      return `photo_${photo.id}`;
    }
    return null;
  }

  _computeContentHash(text) {
    if (!text || !text.trim()) return null;
    const normalized = text.trim().replace(/\s+/g, ' ').toLowerCase();
    return crypto.createHash('sha256').update(normalized).digest('hex').substring(0, 16);
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
   * Finds the mirrored message ID in the discussion group for a given channel post ID.
   */
  async _findDiscussionRootMsgId(channelPostId, maxWaitSec = 8) {
    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitSec * 1000) {
      await new Promise(r => setTimeout(r, 1500));
      try {
        const msgs = await this.client.getMessages(this.discussionChatId, { limit: 12 });
        for (const m of msgs) {
          if (m.fwdFrom && Number(m.fwdFrom.channelPost) === Number(channelPostId)) {
            return m.id;
          }
        }
      } catch (e) {
        // retry
      }
    }
    return null;
  }

  /**
   * Performs sync across all configured source channels (@DreamTraveleo, @zzkbraxk)
   * and broadcasts to primary channel + discussion thread + extra groups (>> V.I.P 정보공유 <<).
   */
  async syncRecent({ limit = 20 } = {}) {
    if (this.isSyncing) {
      console.log('⏳ [VIP2] Sync already running in background, skipping trigger.');
      return { count: 0, status: 'busy' };
    }

    this.isSyncing = true;
    this.lastSyncTime = new Date();
    this.nextSyncTime = new Date(Date.now() + this.syncIntervalMs);

    let totalPublished = 0;
    let totalSkipped = 0;

    try {
      await this.init();

      for (const channelName of this.sourceChannels) {
        console.log(`\n🔍 [VIP2] Scanning source @${channelName} (last ${limit} messages)...`);
        
        let messages = [];
        try {
          messages = await this.client.getMessages(channelName, { limit });
        } catch (fetchErr) {
          console.error(`⚠️ [VIP2] Failed to fetch from @${channelName}:`, fetchErr.message);
          continue;
        }

        if (!messages || messages.length === 0) {
          console.log(`ℹ️ [VIP2] No messages in @${channelName}`);
          continue;
        }

        const chronMessages = [...messages].reverse();
        const groups = new Map();

        for (const msg of chronMessages) {
          if (!msg.media) continue;

          const chKey = `${channelName}_${msg.id}`;
          if (this.processedIds.has(chKey) || this.processedIds.has(String(msg.id))) {
            continue;
          }

          const gId = msg.groupedId ? `${channelName}_grp_${msg.groupedId}` : `single_${chKey}`;
          if (!groups.has(gId)) {
            groups.set(gId, []);
          }
          groups.get(gId).push(msg);
        }

        console.log(`📦 [VIP2] [@${channelName}] Found ${groups.size} candidate post group(s).`);

        for (const [groupId, groupMsgs] of groups.entries()) {
          try {
            // Layer 2: Media Signature Deduplication
            let hasDuplicateMedia = false;
            const currentSignatures = [];

            for (const m of groupMsgs) {
              const sig = this._extractMediaSignature(m.media);
              if (sig) {
                currentSignatures.push(sig);
                if (this.mediaSignatures.has(sig)) {
                  hasDuplicateMedia = true;
                  break;
                }
              }
            }

            if (hasDuplicateMedia) {
              console.log(`🚫 [VIP2] [@${channelName}] Skipped duplicate media in group [${groupId}].`);
              for (const m of groupMsgs) {
                this.processedIds.add(`${channelName}_${m.id}`);
                this.processedIds.add(String(m.id));
              }
              this._saveDeduplicationData();
              totalSkipped++;
              continue;
            }

            // Extract caption
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

            // Layer 3: Content Hash Deduplication
            const contentHash = this._computeContentHash(rawCaption);
            if (contentHash && this.contentHashes.has(contentHash)) {
              console.log(`🚫 [VIP2] [@${channelName}] Skipped duplicate content in group [${groupId}].`);
              for (const m of groupMsgs) {
                this.processedIds.add(`${channelName}_${m.id}`);
                this.processedIds.add(String(m.id));
              }
              this._saveDeduplicationData();
              totalSkipped++;
              continue;
            }

            // Korean translation and formatting
            const { title, caption: formattedCaption } = await formatVip2Caption(
              rawCaption,
              this.destInviteLink
            );

            console.log(`\n📤 [VIP2] [@${channelName}] Publishing Teaser Preview to Channel - Title: "${title}"`);

            // Step 1: Post 1 PREVIEW media item to Channel
            const previewMsg = groupMsgs[0];
            const sentChannelMsg = await this.client.sendFile(this.destChatId, {
              file: previewMsg.media,
              caption: formattedCaption,
              parseMode: 'html',
              forceDocument: false
            });

            if (sentChannelMsg) {
              const publishedMsgId = Array.isArray(sentChannelMsg) ? sentChannelMsg[0].id : sentChannelMsg.id;
              const cleanChatId = String(this.destChatId).replace(/^-100/, '').replace(/^-/, '');
              const postLink = `https://t.me/c/${cleanChatId}/${publishedMsgId}`;

              console.log(`✅ [VIP2] Channel Teaser published: ${postLink}`);

              // Step 2: Find Discussion thread root in discussion group
              console.log(`⏳ [VIP2] Waiting for discussion mirror of post #${publishedMsgId}...`);
              const discRootId = await this._findDiscussionRootMsgId(publishedMsgId);

              // Step 3: Post all full videos / remaining media into Discussion Thread
              if (discRootId) {
                console.log(`💬 [VIP2] Replying in discussion thread (root #${discRootId})...`);
                
                if (groupMsgs.length > 1) {
                  const remainingMedia = groupMsgs.slice(1).map(m => m.media);
                  await this.client.sendFile(this.discussionChatId, {
                    file: remainingMedia,
                    replyTo: discRootId,
                    caption: `🎬 <b>[풀버전 전체 영상 모음] ${title}</b>`,
                    parseMode: 'html',
                    forceDocument: false
                  });
                  console.log(`🎉 [VIP2] Posted ${remainingMedia.length} full video/media files into discussion thread!`);
                } else {
                  await this.client.sendMessage(this.discussionChatId, {
                    message: `🎬 <b>[풀버전 안내]</b> 해당 영상의 전체 고화질 파일이 준비되었습니다. 편안하게 시청하세요! 👑`,
                    replyTo: discRootId,
                    parseMode: 'html'
                  });
                }
              }

              // Step 4: Broadcast to Extra Destination Groups (>> V.I.P 정보공유 << / -1003983458986)
              for (const extraChat of this.extraDestChats) {
                try {
                  console.log(`📢 [VIP2] Broadcasting to Extra Group (${extraChat})...`);
                  if (groupMsgs.length === 1) {
                    await this.client.sendFile(extraChat, {
                      file: groupMsgs[0].media,
                      caption: formattedCaption,
                      parseMode: 'html',
                      forceDocument: false
                    });
                  } else {
                    const allMedia = groupMsgs.map(m => m.media);
                    await this.client.sendFile(extraChat, {
                      file: allMedia,
                      caption: formattedCaption,
                      parseMode: 'html',
                      forceDocument: false
                    });
                  }
                  console.log(`✅ [VIP2] Broadcasted to Extra Group (${extraChat}) successfully!`);
                } catch (extraErr) {
                  console.error(`⚠️ [VIP2] Failed to broadcast to extra group ${extraChat}:`, extraErr.message);
                }
              }

              // Catalog update
              this.catalogManager.addVideo({
                messageId: publishedMsgId,
                title: title,
                link: postLink,
                date: new Date().toISOString()
              });

              // Register deduplication signatures
              for (const m of groupMsgs) {
                this.processedIds.add(`${channelName}_${m.id}`);
                this.processedIds.add(String(m.id));
              }
              for (const sig of currentSignatures) {
                this.mediaSignatures.add(sig);
              }
              if (contentHash) {
                this.contentHashes.add(contentHash);
              }

              this._saveDeduplicationData();
              totalPublished++;

              // Rate-limit delay
              await new Promise(r => setTimeout(r, 3000));
            }
          } catch (postErr) {
            console.error(`❌ [VIP2] Error publishing post [${groupId}]:`, postErr.message);
          }
        }
      }

      console.log(`\n🎉 [VIP2] Multi-channel sync complete. Published: ${totalPublished}, Skipped: ${totalSkipped}. Next sync at: ${this.nextSyncTime.toLocaleTimeString()}`);
      this.isSyncing = false;
      return { count: totalPublished, skipped: totalSkipped, status: 'success' };
    } catch (err) {
      console.error('❌ [VIP2] Sync error:', err.message);
      this.isSyncing = false;
      return { count: totalPublished, skipped: totalSkipped, status: 'error', error: err.message };
    }
  }

  /**
   * Starts periodic sync timer (strictly every 5 minutes across all sources).
   */
  startPeriodicSync(intervalMinutes = 5) {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
    }
    this.syncIntervalMs = Math.max(1, intervalMinutes) * 60 * 1000;
    console.log(`⏰ [VIP2] Periodic sync started: Every ${intervalMinutes} min across [${this.sourceChannels.map(s => '@' + s).join(', ')}]`);

    // Run initial sync
    this.syncRecent({ limit: 15 });

    // Recurring 5-minute schedule
    this.syncTimer = setInterval(() => {
      console.log(`\n⏰ [VIP2] 5-minute interval trigger -> Syncing [${this.sourceChannels.map(s => '@' + s).join(', ')}]...`);
      this.syncRecent({ limit: 20 });
    }, this.syncIntervalMs);
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
