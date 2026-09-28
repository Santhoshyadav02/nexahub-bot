/**
 * ============================================================
 * 🌟 VIP-2 SERVICE ENTRYPOINT
 * ============================================================
 * Starts the VIP-2 bot (@VIP_2211bot), the multi-channel forwarder,
 * and the automated BJ & AV scraper manager (5-7 daily videos).
 */

const { Vip2ForwarderPipeline } = require('./forwarder_pipeline');
const { Vip2ScraperManager } = require('./scraper_manager');
const { Vip2Bot } = require('./bot');
const config = require('./config.json');

async function main() {
  console.log('====================================================');
  console.log('🚀 Starting VIP-2 Service (DreamTraveleo + BJ/AV Scrapers -> V.I.P 정보공유)');
  console.log('🤖 Bot: @VIP_2211bot');
  console.log('====================================================');

  const pipeline = new Vip2ForwarderPipeline();
  const scraperManager = new Vip2ScraperManager(pipeline);
  const bot = new Vip2Bot(pipeline);

  try {
    // 1. Start bot polling
    bot.start();

    // 2. Start periodic channel sync (every 5 minutes)
    const interval = config.pipeline?.syncIntervalMinutes || 5;
    pipeline.startPeriodicSync(interval);

    // 3. Start BJ & AV scraper engine (checks every 3 hours for 5-7 videos/day)
    scraperManager.startScheduler(3);

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
    scraperManager.stop();
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
