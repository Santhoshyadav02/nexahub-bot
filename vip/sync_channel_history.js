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

function cleanCatalogTitle(raw, defaultTag = 'VIP') {
  if (!raw) return `${defaultTag} 신규 영상`;

  let clean = String(raw)
    .replace(/<[^>]*>/g, '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/t\.me\/\S+/gi, '')
    .replace(/@[a-zA-Z0-9_]+/g, '')
    .replace(/\[REMOVE\]/gi, '')
    .replace(/📌\s*Channel:[^\n]*/gi, '')
    .replace(/✨\s*VIP[^\n]*/gi, '')
    .replace(/#[^\s#]+/g, '')
    .trim();

  const lines = clean.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) return `${defaultTag} 신규 영상`;

  let title = lines[0]
    .replace(/^[\s\-_:=*•▶▷►🎬🔞📺🇨🇳🇯🇵🇰🇷]+/, '')
    .replace(/[\s\-_:=*•]+$/, '')
    .trim();

  if (lines.length > 1) {
    const desc = lines.slice(1).join(' ').trim();
    if (desc) {
      title = `${title} ${desc}`;
    }
  }

  title = title.replace(/\s+/g, ' ').trim();
  return title.length > 120 ? title.substring(0, 117) + '...' : (title || `${defaultTag} 신규 영상`);
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

      let addedCount = 0;
      for (const msg of messages) {
        const text = (msg.message || '').trim();
        const hasMedia = Boolean(msg.media);

        if (!text && !hasMedia) continue;

        const rawTitle = cleanCatalogTitle(text || (hasMedia ? `${channelConfig.tag} 신규 영상` : ''), channelConfig.tag);
        if (!rawTitle) continue;

        const cleanId = String(chId).replace(/^-100/, '').replace(/^-/, '');
        const postLink = `https://t.me/c/${cleanId}/${msg.id}`;

        const added = catalogManager.addVideo(channelConfig.key, {
          messageId: msg.id,
          title: rawTitle,
          link: postLink,
          date: new Date((msg.date || Math.floor(Date.now() / 1000)) * 1000).toISOString()
        });

        if (added) addedCount++;
      }

      const currentTotal = (catalogManager.catalogs[channelConfig.key] || []).length;
      console.log(`   ✅ Synced ${addedCount} new/updated videos into catalog (Total in Catalog: ${currentTotal}/40)\n`);
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
  syncAllChannels().catch(console.error);
}

module.exports = {
  syncAllChannels,
  cleanCatalogTitle
};
