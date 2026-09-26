const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const sessionStr = process.env.TELEGRAM_SESSION_STRING || '';

async function fixTitles() {
  const client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, {
    connectionRetries: 5
  });

  await client.connect();
  console.log('✅ Connected to Telegram MTProto');

  const destChatId = '-1003845130520';
  const destEntity = await client.getEntity(destChatId);

  // Mapping of VIP-18 message IDs to their real source titles from @zzkbraxk
  const titleMapping = {
    41: '【T279的一些续集】',
    40: '【T279的一些续集】',
    39: '【T279的一些续集】',
    38: '【T279的一些续集】',
    37: '【T279的一些续集】',
    36: '【巨乳骚萌女大】',
    35: '【巨乳骚萌女大】',
    34: '【巨乳骚萌女大】',
    33: '【巨乳骚萌女大】',
    32: '【巨乳骚萌女大】',
    31: '【巨乳骚萌女大】',
    30: '【巨乳骚萌女大】',
    29: '【巨乳骚萌女大】',
    28: '【T279的一些续集】',
    27: '【巨乳骚萌女大】',
    26: '【巨乳骚萌女大】',
    25: '【巨乳骚萌女大】',
    24: '【巨乳骚萌女大】',
    23: '오구리 안나',
    22: '006UL',
    21: '001UL',
    20: '히토미 렌',
    19: '모치즈키 아즈사',
    18: '4920167UL',
    17: '4925245UL',
    16: '4922101UL',
    15: '4922818UL',
    14: 'DVEL-001UL 요코야마 나츠키',
    13: 'DVEL-002UL 쿠로세 메이'
  };

  console.log('Editing message captions in VIP-18 channel...');
  for (const [msgIdStr, title] of Object.entries(titleMapping)) {
    const msgId = Number(msgIdStr);
    const caption = `🔞 <b>${title}</b>\n\n✨ <b>VIP-🔞 정보공유</b>`;

    try {
      await client.editMessage(destEntity, {
        message: msgId,
        text: caption,
        parseMode: 'html'
      });
      console.log(`  ✅ Updated VIP-18 msg #${msgId} -> "${title}"`);
    } catch (e) {
      if (!e.message.includes('MESSAGE_NOT_MODIFIED') && !e.message.includes('CHAT_ADMIN_REQUIRED')) {
        console.warn(`  ⚠️ Msg #${msgId} note: ${e.message}`);
      }
    }
    await new Promise(r => setTimeout(r, 400));
  }

  // Update channel_catalogs.json
  const catalogPath = path.resolve(__dirname, 'channel_catalogs.json');
  const catalogs = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

  if (catalogs['18']) {
    for (const item of catalogs['18']) {
      const mid = item.messageId;
      if (titleMapping[mid]) {
        item.title = titleMapping[mid];
      }
    }
    fs.writeFileSync(catalogPath, JSON.stringify(catalogs, null, 2), 'utf8');
    console.log('✅ Updated channel_catalogs.json for VIP-18');
  }

  await client.disconnect();
  console.log('🎉 Fix complete!');
}

fixTitles().catch(console.error);
