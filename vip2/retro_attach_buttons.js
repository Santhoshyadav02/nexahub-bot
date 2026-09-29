const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const apiId = Number(process.env.TELEGRAM_API_ID || 30473305);
const apiHash = process.env.TELEGRAM_API_HASH || '6d91c6c87e7ff45433bb3aa90282e412';
const sessionString = process.env.TELEGRAM_SESSION_STRING;

const discInvite = 'https://t.me/+i2suOv8XvPI4MTUx';
const chanInvite = 'https://t.me/+HKD-EF-iSK5iN2Rh';

async function updateAllPastPosts() {
  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, { connectionRetries: 5 });
  await client.connect();
  console.log('Connected to Telegram MTProto.');

  const keyboard = new Api.ReplyInlineMarkup({
    rows: [
      new Api.KeyboardButtonRow({
        buttons: [
          new Api.KeyboardButtonUrl({
            text: '💬 풀버전 시청 및 토론 (Discussion) ↗️',
            url: discInvite
          })
        ]
      }),
      new Api.KeyboardButtonRow({
        buttons: [
          new Api.KeyboardButtonUrl({
            text: '👑 VIP 정보공유 채널 입장 ↗️',
            url: chanInvite
          })
        ]
      })
    ]
  });

  const chats = [
    { id: '-1004361683750', name: 'Channel (V.I.P 정보공유)' },
    { id: '-1003983458986', name: 'Extra Group (>> V.I.P 정보공유 <<)' }
  ];

  for (const target of chats) {
    console.log(`\n🔄 Updating past posts in ${target.name}...`);
    try {
      const msgs = await client.getMessages(target.id, { limit: 50 });
      let updatedCount = 0;
      for (const m of msgs) {
        if (!m.media) continue;
        try {
          await client.editMessage(target.id, {
            message: m.id,
            text: m.message,
            buttons: keyboard
          });
          updatedCount++;
          console.log(`  ✅ Attached Discussion button to [${target.name}] message #${m.id}`);
          await new Promise(r => setTimeout(r, 600));
        } catch (err) {
          // If already has buttons or cannot edit, continue
          if (!err.message.includes('MESSAGE_NOT_MODIFIED')) {
            console.log(`  ℹ️ Message #${m.id}: ${err.message}`);
          }
        }
      }
      console.log(`🎉 Finished ${target.name}: ${updatedCount} posts updated with Discussion buttons.`);
    } catch (e) {
      console.error(`❌ Failed updating ${target.name}:`, e.message);
    }
  }

  await client.disconnect();
}

updateAllPastPosts();
