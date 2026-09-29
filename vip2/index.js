/**
 * ============================================================
 * 🌟 VIP-2 SERVICE ENTRYPOINT
 * ============================================================
 * Starts the VIP-2 bot (@VIP_2211bot) and the automated forwarding
 * pipeline from @DreamTraveleo -> V.I.P 정보공유 (-1004361683750).
 */

const { Vip2ForwarderPipeline } = require('./forwarder_pipeline');
const { Vip2Bot } = require('./bot');
const config = require('./config.json');

async function main() {
  console.log('====================================================');
  console.log('🚀 Starting VIP-2 Service (DreamTraveleo -> V.I.P 정보공유)');
  console.log('🤖 Bot: @VIP_2211bot');
  console.log('====================================================');

  const pipeline = new Vip2ForwarderPipeline();
  const bot = new Vip2Bot(pipeline);

  try {
    // Start bot polling
    bot.start();

    // Start background sync
    const interval = config.pipeline?.syncIntervalMinutes || 5;
    pipeline.startPeriodicSync(interval);

    console.log('🌟 [VIP2] Service is fully operational and listening.');
  } catch (err) {
    console.error('❌ [VIP2] Fatal error on startup:', err);
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n🛑 [VIP2] Shutting down VIP-2 service...');
    bot.stop();
    pipeline.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch(err => {
    console.error('❌ [VIP2] Unhandled error:', err);
    process.exit(1);
  });
}

module.exports = { main };
