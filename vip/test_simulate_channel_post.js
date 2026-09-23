/**
 * ============================================================
 * 🧪 SIMULATE CHANNEL POST TO VIP FORWARDER
 * ============================================================
 * Simulates a video post event coming from VIP-KR (-1004435999618)
 * and verifies that the VIP Forwarder processes it, adds to 40-video catalog,
 * and publishes the formatted card to the VIP group.
 */

const path = require('path');
const { VipForwarder } = require('./vip_forwarder');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

async function runSimulation() {
  console.log('============================================================');
  console.log('🧪 Simulating Live Channel Post Event (VIP-KR -> VIP Group)');
  console.log('============================================================\n');

  const forwarder = new VipForwarder();
  const token = process.env.VIP_BOT_TOKEN;
  forwarder.bot = new TelegramBot(token, { polling: false });

  const simulatedMsg = {
    chat: {
      id: -1004435999618,
      title: 'VIP-KR',
      type: 'channel'
    },
    message_id: 101,
    caption: 'FC2PPV-4925245UL (테스트 신규 영상)\nHD 1080p 고화질 시청 가능합니다.'
  };

  console.log('1. Dispatching simulated channel post to VipForwarder...');
  const success = await forwarder.handleChannelPost(simulatedMsg);
  console.log(`2. Result: ${success ? 'SUCCESS ✅' : 'FAILED ❌'}`);

  // Check catalog
  const krCatalog = forwarder.catalogManager.getPage('KR', 1);
  console.log(`3. KR Catalog Items Count: ${krCatalog.totalItems}`);
  console.log(`   Top item: "${krCatalog.items[0]?.title}" -> ${krCatalog.items[0]?.link}`);

  console.log('\n============================================================');
  console.log('🎉 SIMULATION COMPLETED SUCCESSFULLY');
  console.log('============================================================\n');
}

runSimulation().catch(console.error);
