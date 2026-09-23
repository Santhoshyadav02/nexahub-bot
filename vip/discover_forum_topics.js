/**
 * ============================================================
 * 🔍 AUTO-DISCOVER FORUM TOPICS FROM VIP SUPERGROUP (MTProto)
 * ============================================================
 * Queries Telegram for all active Forum Topics in >> V.I.P 정보공유 << (-1003983458986)
 * and automatically matches and binds their message_thread_ids in vip/config.json!
 */

const path = require('path');
const fs = require('fs');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const config = require('./config.json');

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const sessionStr = process.env.TELEGRAM_SESSION_STRING || '';

async function discoverForumTopics() {
  console.log('============================================================');
  console.log('🔍 Auto-Discovering Forum Topics from VIP Supergroup');
  console.log('============================================================\n');

  if (!apiId || !apiHash || !sessionStr) {
    console.error('❌ MTProto credentials missing in root .env');
    return;
  }

  const client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, {
    connectionRetries: 5
  });

  await client.connect();
  console.log('✅ MTProto Client Connected.\n');

  const vipChatId = config.vipGroup.chatId;
  let entity;
  try {
    entity = await client.getEntity(vipChatId);
  } catch (e) {
    const cleanNumeric = vipChatId.replace(/^-100/, '-').replace(/^-/, '');
    entity = await client.getEntity(cleanNumeric);
  }

  console.log(`📡 Fetching Forum Topics for: ${entity.title || vipChatId}...`);

  try {
    const result = await client.invoke(new Api.channels.GetForumTopics({
      channel: entity,
      offsetDate: 0,
      offsetId: 0,
      offsetTopic: 0,
      limit: 50
    }));

    const topics = result.topics || [];
    console.log(`Found ${topics.length} Forum Topics:\n`);

    const matchedBindings = {};

    for (const t of topics) {
      const topicId = t.id;
      const title = t.title || '';
      console.log(`   📌 Topic ID: ${topicId} | Title: "${title}" | Icon Color: ${t.iconColor}`);

      // Try matching to our 6 channel keys: 18, CN, JP, KR, BJ, AV
      for (const [chId, c] of Object.entries(config.channels)) {
        const cleanTag = c.tag.toLowerCase().replace(/[^a-z0-9]/g, '');
        const cleanTitle = title.toLowerCase().replace(/[^a-z0-9]/g, '');

        if (
          cleanTitle.includes(cleanTag) ||
          cleanTitle.includes(c.key.toLowerCase()) ||
          (c.key === '18' && (title.includes('18') || title.includes('🔞'))) ||
          (c.key === 'BJ' && title.toLowerCase().includes('bj')) ||
          (c.key === 'AV' && title.toLowerCase().includes('av')) ||
          (c.key === 'KR' && title.toLowerCase().includes('kr')) ||
          (c.key === 'JP' && title.toLowerCase().includes('jp')) ||
          (c.key === 'CN' && title.toLowerCase().includes('cn'))
        ) {
          if (!matchedBindings[c.key]) {
            c.topicThreadId = topicId;
            c.topicName = title;
            matchedBindings[c.key] = topicId;
            console.log(`      ↳ ✅ Matched to Channel [${c.name}] (${c.tag})!`);
          }
        }
      }

      if (title.toLowerCase().includes('general') || title.toLowerCase().includes('all') || title.toLowerCase().includes('전체')) {
        config.vipGroup.allTopicThreadId = topicId;
        config.vipGroup.generalTopicThreadId = topicId;
        console.log(`      ↳ ✅ Matched to General / ALL Topic!`);
      }
    }

    // Save updated config
    fs.writeFileSync(path.resolve(__dirname, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
    console.log('\n💾 Updated vip/config.json with discovered topicThreadIds successfully!');
  } catch (err) {
    console.error('❌ Failed to get forum topics:', err.message);
  }

  await client.disconnect();
  console.log('\n============================================================');
  console.log('🎉 TOPIC DISCOVERY COMPLETE');
  console.log('============================================================\n');
}

if (require.main === module) {
  discoverForumTopics().catch(console.error);
}

module.exports = { discoverForumTopics };
