/**
 * ============================================================
 * 🔄 VIP CHANNEL HISTORY SYNCHRONIZER (MTProto / Telegram)
 * ============================================================
 * Scans recent messages and videos from all 6 VIP channels:
 *  - VIP-18 (-1003845130520) (with source title resolution from @zzkbraxk)
 *  - VIP-CN (-1004304488687)
 *  - VIP-JP (-1004484964035)
 *  - VIP-KR (-1004435999618)
 *  - VIP-BJ (-1003977934133)
 *  - VIP-AV (-1004352512630)
 *
 * Populates vip/channel_catalogs.json with the latest videos so the 8x5
 * catalog is immediately full and available for all topics.
 */

const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const { CatalogManager } = require('./catalog_manager');
const config = require('./config.json');

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const sessionStr = process.env.TELEGRAM_SESSION_STRING || '';

function cleanCatalogTitle(rawText, defaultTag = '') {
  if (!rawText || typeof rawText !== 'string') {
    return defaultTag ? `${defaultTag} 신규 영상` : '';
  }

  // Filter out promo ads
  if (rawText.includes('月付') || rawText.includes('年付') || rawText.includes('优惠力度') || rawText.includes('中秋狂欢') || rawText.includes('极搜JISOU')) {
    return defaultTag ? `${defaultTag} 신규 영상` : '';
  }

  let cleaned = rawText
    .replace(/<[^>]*>/g, '')
    .replace(/\[REMOVE\]/gi, '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/t\.me\/\S+/gi, '')
    .replace(/@[a-zA-Z0-9_]+/g, '')
    .trim();

  if (/^#[^\s#]+$/.test(cleaned)) {
    cleaned = cleaned.replace(/^#+/, '');
  } else {
    cleaned = cleaned.replace(/#[^\s#]+/g, '').trim();
  }

  const lines = cleaned.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) {
    return defaultTag ? `${defaultTag} 신규 영상` : '';
  }

  let title = lines[0];
  title = title.replace(/^[\s\-_:=*•▶▷►🎬🔞]+/, '').replace(/[\s\-_:=*•]+$/, '').trim();

  if (title.length > 90) {
    title = title.substring(0, 87) + '...';
  }

  return title.length >= 2 ? title : (defaultTag ? `${defaultTag} 신규 영상` : '');
}

async function syncAllChannels() {
  console.log('============================================================');
  console.log('🔄 Syncing Existing Videos from 6 VIP Channels');
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

  // Step 1: Extract album titles from @zzkbraxk for VIP-18 enrichment
  const zzkbraxkTitles = [];
  try {
    const zzkEntity = await client.getEntity('zzkbraxk');
    const zzkMsgs = await client.getMessages(zzkEntity, { limit: 60 });

    const groupTitleMap = new Map();
    const groupVideosMap = new Map();

    for (const m of zzkMsgs) {
      if (m.groupedId) {
        const gid = m.groupedId.toString();
        const t = cleanCatalogTitle(m.message, '');
        if (t && !groupTitleMap.has(gid)) groupTitleMap.set(gid, t);
        const isVid = m.media && m.media.className === 'MessageMediaDocument';
        if (isVid) {
          if (!groupVideosMap.has(gid)) groupVideosMap.set(gid, []);
          groupVideosMap.get(gid).push(m.id);
        }
      }
    }

    for (const m of zzkMsgs) {
      const isVid = m.media && m.media.className === 'MessageMediaDocument';
      if (!isVid) continue;
      let rawT = cleanCatalogTitle(m.message, '');
      let albumT = '';
      let partSuffix = '';
      if (m.groupedId) {
        const gid = m.groupedId.toString();
        albumT = groupTitleMap.get(gid) || '';
        const groupList = (groupVideosMap.get(gid) || []).slice().sort((a, b) => a - b);
        if (groupList.length > 1) {
          const idx = groupList.indexOf(m.id);
          if (idx >= 0) partSuffix = ` (${idx + 1}/${groupList.length})`;
        }
      }
      let finalT = rawT || albumT || 'VIP-18 신규 영상';
      if (partSuffix && !finalT.includes('(')) {
        finalT = `${finalT}${partSuffix}`;
      }
      zzkbraxkTitles.push(finalT);
    }
  } catch (e) {
    console.warn('Could not prefetch zzkbraxk titles:', e.message);
  }

  // Step 2: Sync each of the 6 VIP channels
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

      const messages = await client.getMessages(entity, { limit: 40 });
      console.log(`   Found ${messages.length} recent messages in ${channelConfig.name}`);

      catalogManager.catalogs[channelConfig.key] = [];

      let addedCount = 0;
      let zzkIndex = 0;

      for (const msg of messages) {
        const text = (msg.message || '').trim();
        const hasMedia = Boolean(msg.media);

        if (!text && !hasMedia) continue;

        let title = cleanCatalogTitle(text, channelConfig.tag);

        // If title is generic default for 18+, replace with real title from zzkbraxk source list
        if (channelConfig.key === '18' && (title.includes('신규 영상') || title.length < 3)) {
          if (zzkIndex < zzkbraxkTitles.length) {
            title = zzkbraxkTitles[zzkIndex++];
          }
        }

        const cleanId = String(chId).replace(/^-100/, '').replace(/^-/, '');
        const postLink = `https://t.me/c/${cleanId}/${msg.id}`;

        const added = catalogManager.addVideo(channelConfig.key, {
          messageId: msg.id,
          title: title,
          link: postLink,
          date: new Date((msg.date || Math.floor(Date.now() / 1000)) * 1000).toISOString()
        });

        if (added) addedCount++;
      }

      const currentTotal = (catalogManager.catalogs[channelConfig.key] || []).length;
      console.log(`   ✅ Synced ${addedCount} videos into catalog (Total in Catalog: ${currentTotal}/40)\n`);
    } catch (err) {
      console.error(`   ❌ Failed to sync channel ${channelConfig.name}:`, err.message);
    }
  }

  await client.disconnect();
  console.log('============================================================');
  console.log('🎉 CHANNEL SYNC COMPLETE');
  console.log('============================================================\n');
}

if (require.main === module) {
  syncAllChannels().then(() => process.exit(0)).catch(e => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  syncAllChannels,
  cleanCatalogTitle
};
