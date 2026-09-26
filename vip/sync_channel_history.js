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
const { Api } = require('telegram');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const { CatalogManager } = require('./catalog_manager');
const config = require('./config.json');

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const sessionStr = process.env.TELEGRAM_SESSION_STRING || '';

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
      // Parse chat entity
      let entity;
      try {
        entity = await client.getEntity(chId);
      } catch (e) {
        // Try BigInt or numeric ID format
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

        const firstLine = (text.split('\n')[0] || (hasMedia ? `${channelConfig.tag} 신규 영상` : '')).trim();
        if (!firstLine) continue;

        const cleanId = String(chId).replace(/^-100/, '').replace(/^-/, '');
        const postLink = `https://t.me/c/${cleanId}/${msg.id}`;

        const added = catalogManager.addVideo(channelConfig.key, {
          messageId: msg.id,
          title: firstLine.length > 90 ? firstLine.substring(0, 87) + '...' : firstLine,
          link: postLink,
          date: new Date((msg.date || Math.floor(Date.now() / 1000)) * 1000).toISOString()
        });

        if (added) addedCount++;
      }

      const currentTotal = (catalogManager.catalogs[channelConfig.key] || []).length;
      console.log(`   ✅ Synced ${addedCount} new videos into catalog (Total in Catalog: ${currentTotal}/40)\n`);
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

module.exports = { syncAllChannels };
