/**
 * ============================================================
 * 🤖 VIP PIPELINE CONTINUOUS DAEMON (PM2 Process)
 * ============================================================
 * Runs continuously in the background on VPS:
 *   - Scrapes fresh dynamic stream tokens every 3 hours.
 *   - Performs round-robin downloading & uploading (2 parallel workers) to 6 channels.
 *   - Enforces 5 uploads/day per channel quota.
 *   - Sweeps old/stale downloads every 1 hour.
 */

const { VipPipelineOrchestrator } = require('./vip_pipeline_orchestrator');

const SCRAPE_INTERVAL_MS = 3 * 60 * 60 * 1000;   // 3 Hours
const PIPELINE_INTERVAL_MS = 15 * 60 * 1000;      // 15 Minutes
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;       // 1 Hour

async function startDaemon() {
  console.log(`\n=======================================================`);
  console.log(`👑 VIP PIPELINE DAEMON INITIALIZING`);
  console.log(`=======================================================`);
  console.log(`• Scrape Link Refresh:  Every 3 Hours`);
  console.log(`• Download & Upload:    Every 15 Minutes (2 Parallel Workers)`);
  console.log(`• Quota Limit:          5 Videos / Channel / Day`);
  console.log(`• Auto Disk Cleanup:    Every 1 Hour (Stale files > 1h)`);
  console.log(`=======================================================\n`);

  const orchestrator = new VipPipelineOrchestrator();

  let isScraping = false;
  let isProcessing = false;

  async function triggerScraper() {
    if (isScraping) return;
    isScraping = true;
    try {
      await orchestrator.runAllScrapers({ pages: 1, refresh: true });
    } catch (e) {
      console.error(`[VIP_DAEMON] Scraper cycle error:`, e.message);
    } finally {
      isScraping = false;
    }
  }

  async function triggerPipeline() {
    if (isProcessing) return;
    isProcessing = true;
    try {
      await orchestrator.executeRoundRobinStep();
    } catch (e) {
      console.error(`[VIP_DAEMON] Pipeline step error:`, e.message);
    } finally {
      isProcessing = false;
    }
  }

  function triggerCleanup() {
    try {
      const deleted = orchestrator.cleanupOldDownloads(1);
      if (deleted > 0) {
        console.log(`[VIP_DAEMON] Auto-cleanup removed ${deleted} stale file(s).`);
      }
    } catch (e) {
      console.error(`[VIP_DAEMON] Cleanup error:`, e.message);
    }
  }

  // Initial execution: refresh scrapers first so we have fresh valid tokens, then start pipeline
  console.log(`[VIP_DAEMON] Performing startup scraper refresh to fetch fresh stream tokens...`);
  await triggerScraper();
  console.log(`[VIP_DAEMON] Startup scraper refresh complete. Running initial pipeline dispatch...`);
  await triggerPipeline();

  // Set recurring timers
  setInterval(triggerPipeline, PIPELINE_INTERVAL_MS);
  setInterval(triggerScraper, SCRAPE_INTERVAL_MS);
  setInterval(triggerCleanup, CLEANUP_INTERVAL_MS);

  // Graceful shutdown handling
  const shutdown = () => {
    console.log(`\n🛑 [VIP_DAEMON] Graceful shutdown signal received. Stopping timers...`);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`[VIP_DAEMON] All recurring background timers active.`);
}

if (require.main === module) {
  startDaemon().catch(err => {
    console.error(`[VIP_DAEMON] Fatal daemon crash:`, err);
    process.exit(1);
  });
}

module.exports = { startDaemon };
