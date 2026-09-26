const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const sessionStr = process.env.TELEGRAM_SESSION_STRING || '';

async function inspectSource() {
  const client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, {
    connectionRetries: 5
  });

  await client.connect();
  console.log('✅ Connected to Telegram MTProto');

  const sourceEntity = await client.getEntity('zzkbraxk');
  console.log('Source Channel Entity:', sourceEntity.title, 'Username:', sourceEntity.username);

  const messages = await client.getMessages(sourceEntity, { limit: 25 });
  console.log(`Fetched ${messages.length} messages from @zzkbraxk:\n`);

  for (const m of messages) {
    const hasMedia = Boolean(m.media);
    const mediaClass = hasMedia ? m.media.className : 'None';
    let docAttr = '';
    let fileName = '';
    if (m.media && m.media.document) {
      if (m.media.document.attributes) {
        for (const attr of m.media.document.attributes) {
          if (attr.className === 'DocumentAttributeFilename') fileName = attr.fileName;
          if (attr.className === 'DocumentAttributeVideo') docAttr = `Video (${attr.duration}s, ${attr.w}x${attr.h})`;
        }
      }
    }

    console.log(`--- [MSG ID ${m.id}] ---`);
    console.log(`Text/Caption:\n"""\n${m.message || ''}\n"""`);
    console.log(`Media: ${mediaClass} | Filename: ${fileName} | Attr: ${docAttr}`);
    console.log(`Date: ${new Date(m.date * 1000).toISOString()}`);
    console.log('--------------------------------------------------\n');
  }

  await client.disconnect();
}

inspectSource().catch(console.error);
