const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const config = require('./config.json');

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const sessionStr = process.env.TELEGRAM_SESSION_STRING || '';

async function inspectChannels() {
  if (!apiId || !apiHash || !sessionStr) {
    console.error('Missing credentials');
    return;
  }

  const client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, {
    connectionRetries: 5
  });

  await client.connect();
  console.log('✅ Connected to MTProto\n');

  for (const [chId, conf] of Object.entries(config.channels)) {
    console.log(`====================================================`);
    console.log(`Channel: ${conf.name} (${conf.tag}) [${chId}]`);
    console.log(`====================================================`);

    try {
      const entity = await client.getEntity(chId);
      const messages = await client.getMessages(entity, { limit: 15 });

      console.log(`Total messages fetched: ${messages.length}`);
      for (const m of messages) {
        const text = m.message || '';
        const mediaType = m.media ? m.media.className : 'NoMedia';
        const date = new Date(m.date * 1000).toISOString();
        const firstLine = text.split('\n')[0];
        console.log(`  [ID: ${m.id}] (${date}) Media: ${mediaType} | Title: "${firstLine}"`);
      }
    } catch (e) {
      console.error(`  ❌ Error: ${e.message}`);
    }
    console.log('\n');
  }

  await client.disconnect();
}

inspectChannels().catch(console.error);
