const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const apiId = Number(process.env.TELEGRAM_API_ID || 30473305);
const apiHash = process.env.TELEGRAM_API_HASH || '6d91c6c87e7ff45433bb3aa90282e412';
const sessionString = process.env.TELEGRAM_SESSION_STRING;

async function checkAccess() {
  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, { connectionRetries: 5 });
  await client.connect();
  console.log('Connected to Telegram MTProto.');

  const chats = [
    { id: '-1004361683750', name: 'Channel (V.I.P 정보공유)' },
    { id: '-1004442518512', name: 'Discussion Group (V.I.P 정보공유 chat)' },
    { id: '-1003983458986', name: 'Extra Group (>> V.I.P 정보공유 <<)' }
  ];

  for (const c of chats) {
    try {
      const entity = await client.getEntity(c.id);
      console.log(`✅ Access OK for ${c.name} (${c.id}) -> Title: "${entity.title || entity.username}"`);
    } catch (e) {
      console.error(`❌ Failed access for ${c.name} (${c.id}):`, e.message);
    }
  }

  await client.disconnect();
}

checkAccess();
