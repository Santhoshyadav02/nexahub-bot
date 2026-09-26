/**
 * ============================================================
 * 🔄 VIP CHANNEL HISTORY SYNCHRONIZER (MTProto / Telegram)
 * ============================================================
 * Scans recent messages and videos from all 6 VIP channels:
 *  - VIP-18 (-1003845130520)
 *  - VIP-CN (-1004304488687)
 *  - VIP-JP (-1004484964035)
 *  - VIP-KR (-1004435999618)
 *  - VIP-BJ (-1003977934133)
 *  - VIP-AV (-1004352512630)
 *
 * Populates vip/channel_catalogs.json with the latest 40 videos
 * (8 items x 5 pages = 40 videos), sorted latest-on-top.
 */

const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const { CatalogManager } = require('./catalog_manager');
const { translateToKorean } = require('../korean_caption_generator');
const { extractTitleAndDescription } = require('./vip_channel_source_pipeline');
const config = require('./config.json');

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const sessionStr = process.env.TELEGRAM_SESSION_STRING || '';

async function syncAllChannels() {
  console.log('============================================================');
  console.log('🔄 Syncing Latest 40 Videos from 6 VIP Channels');
  console.log('============================================================\n');

  if (!apiId || !apiHash || !sessionStr) {
    console.error('❌ MTProto credentials missing in root .env');
    return;
  }

  const client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, {
    connectionRetries: 5
  });

  await client.connect();
  console.log('✅ MTProto Client Connected Successfully.\n');

  const catalogManager = new CatalogManager(path.resolve(__dirname, 'channel_catalogs.json'));

  for (const [chId, channelConfig] of Object.entries(config.channels)) {
    console.log(`🔍 Scanning channel: ${channelConfig.name} (${channelConfig.tag}) [${chId}]...`);

    try {
      let entity;
      try {
        entity = await client.getEntity(chId);
      } catch (e) {
        const cleanNumeric = chId.replace(/^-100/, '-').replace(/^-/, '');
        entity = await client.getEntity(cleanNumeric);
      }

      // Fetch up to 100 messages to ensure we get 40 videos
      const messages = await client.getMessages(entity, { limit: 100 });
      console.log(`   Found ${messages.length} recent messages in ${channelConfig.name}`);

      // Pass 1: Build album grouped map for shared captions
      const groupCaptionMap = new Map();
      for (const msg of messages) {
        if (msg.groupedId && msg.message) {
          const gid = msg.groupedId.toString();
          if (!groupCaptionMap.has(gid)) {
            groupCaptionMap.set(gid, msg.message.trim());
          }
        }
      }

      // Pass 2: Extract videos and their clean Korean titles
      const channelVideos = [];
      for (const msg of messages) {
        const hasMedia = Boolean(msg.media);
        let rawText = (msg.message || '').trim();

        // If message in group has no caption, borrow from groupedId
        if (!rawText && msg.groupedId) {
          const gid = msg.groupedId.toString();
          rawText = groupCaptionMap.get(gid) || '';
        }

        if (!rawText && !hasMedia) continue;

        let title = '';
        if (channelConfig.key === '18') {
          const ext = extractTitleAndDescription(rawText);
          title = ext.title;
          if (ext.description && ext.description !== title) {
            title = `${title} ${ext.description}`;
          }
        } else {
          title = rawText.split('\n')[0] || '';
        }

        if (!title || title === `${channelConfig.tag} 신규 영상`) {
          if (rawText) {
            title = rawText.split('\n')[0];
          } else {
            title = `${channelConfig.name} 신규 영상 (#${msg.id})`;
          }
        }

        title = title
          .replace(/<[^>]*>/g, '')
          .replace(/\[REMOVE\]/gi, '')
          .replace(/#\w+/g, '')
          .replace(/✨\s*VIP-.*$/gi, '')
          .trim();

        if (!title) {
          title = `${channelConfig.name} 신규 영상 (#${msg.id})`;
        }

        // Translate to Korean if foreign characters detected
        if (/[\u4e00-\u9fa5\u3040-\u30ff]/.test(title) || /^[A-Za-z0-9\s,.:;'"!?-]{5,}$/.test(title)) {
          try {
            const tr = await translateToKorean(title);
            if (tr) title = tr;
          } catch (e) {}
        }

        const cleanId = String(chId).replace(/^-100/, '').replace(/^-/, '');
        const postLink = `https://t.me/c/${cleanId}/${msg.id}`;

        channelVideos.push({
          messageId: Number(msg.id),
          title: title.length > 120 ? title.substring(0, 117) + '...' : title,
          link: postLink,
          date: new Date((msg.date || Math.floor(Date.now() / 1000)) * 1000).toISOString()
        });
      }

      // Sort descending (latest message ID on top)
      channelVideos.sort((a, b) => b.messageId - a.messageId);

      // Keep up to 40 unique videos
      const final40 = [];
      const seenIds = new Set();
      for (const v of channelVideos) {
        if (!seenIds.has(v.messageId)) {
          seenIds.add(v.messageId);
          final40.push(v);
          if (final40.length >= 40) break;
        }
      }

      catalogManager.catalogs[channelConfig.key] = final40;
      catalogManager._save();

      console.log(`   ✅ Synced ${final40.length}/40 videos into catalog for ${channelConfig.name}\n`);
    } catch (err) {
      console.error(`   ❌ Failed to sync channel ${channelConfig.name}:`, err.message);
    }
  }

  await client.disconnect();
  console.log('============================================================');
  console.log('🎉 CHANNEL SYNC COMPLETE: ALL 6 CHANNELS UPDATED (40 ITEMS/EACH)');
  console.log('============================================================\n');
}

if (require.main === module) {
  syncAllChannels().catch(console.error);
}

module.exports = { syncAllChannels };
