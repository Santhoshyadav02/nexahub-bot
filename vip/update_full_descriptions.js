const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const sessionStr = process.env.TELEGRAM_SESSION_STRING || '';

async function updateCaptionsWithDescription() {
  const client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, {
    connectionRetries: 5
  });

  await client.connect();
  console.log('✅ Connected to Telegram MTProto');

  const destChatId = '-1003845130520';
  const destEntity = await client.getEntity(destChatId);

  const t279Caption = 
    `🔞 <b>【T279的一些续集】</b>\n` +
    `T279续集里更新了些内容，里面涉及我BBW老婆的故事部分，描述得还挺详细的，建议去瞅瞅。\n\n` +
    `✨ <b>VIP-🔞 정보공유</b>`;

  const juruCaption = 
    `🔞 <b>【巨乳骚萌女大】</b>\n` +
    `这妹子穿百褶短裙，蕾丝内裤勒着肥逼，跳蛋塞穴震动。对镜自慰动作越来越骚。巨乳晃荡又软沉，配肥臀肉感足。揉胸低喘腿软，最后高潮喷水近景清楚。\n\n` +
    `✨ <b>VIP-🔞 정보공유</b>`;

  const msgsToUpdate = [
    { ids: [37, 38, 39, 40, 41], caption: t279Caption, title: '【T279的一些续集】' },
    { ids: [33, 34, 35, 36], caption: juruCaption, title: '【巨乳骚萌女大】' }
  ];

  for (const group of msgsToUpdate) {
    for (const msgId of group.ids) {
      try {
        await client.editMessage(destEntity, {
          message: msgId,
          text: group.caption,
          parseMode: 'html'
        });
        console.log(`  ✅ Updated VIP-18 msg #${msgId} with full description for "${group.title}"`);
      } catch (e) {
        console.warn(`  ⚠️ Msg #${msgId} note: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 400));
    }
  }

  await client.disconnect();
  console.log('🎉 All group video captions updated with full descriptions!');
}

updateCaptionsWithDescription().catch(console.error);
