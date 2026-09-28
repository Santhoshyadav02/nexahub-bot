/**
 * ============================================================
 * 🌟 VIP-2 SERVICE ENTRYPOINT
 * ============================================================
 * Starts:
 *   1. VIP-2 Telegram Bot (@VIP_2211bot)
 *   2. Multi-channel Forwarding Pipeline (@DreamTraveleo, @zzkbraxk)
 *   3. Automated BJ & AV Scraper & Video Downloader/Uploader
 *   4. Multi-destination distribution (Channel + Discussion + Group)
 */

const { Vip2ForwarderPipeline } = require('./forwarder_pipeline');
const { Vip2Bot } = require('./bot');
const config = require('./config.json');

async function main() {
  console.log('====================================================');
  console.log('🚀 Starting VIP-2 Service (Channel Forwarder + BJ/AV Scrapers)');
  console.log('🤖 Bot: @VIP_2211bot');
  console.log('====================================================');

  const pipeline = new Vip2ForwarderPipeline();
  const bot = new Vip2Bot(pipeline);

  try {
    // 1. Start bot polling
    bot.start();

    // 2. Start 5-minute Telegram source channel sync (@DreamTraveleo, @zzkbraxk)
    const syncInterval = config.pipeline?.syncIntervalMinutes || 5;
    pipeline.startPeriodicSync(syncInterval);

    // 3. Start automated BJ & AV scraper scheduler (downloads & uploads 5-7 videos/day)
    bot.scraperManager.startPeriodicScraper(4);

    console.log('🌟 [VIP2] Service is fully operational and listening.');
  } catch (err) {
    console.error('❌ [VIP2] Fatal error on startup:', err);
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n🛑 [VIP2] Shutting down VIP-2 service...');
    bot.stop();
    bot.scraperManager.stop();
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
