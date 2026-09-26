/**
 * ============================================================
 * 🤖 VIP PIPELINE CONTINUOUS DAEMON (PM2 Process)
 * ============================================================
 * Runs continuously in the background on VPS:
 *   - Scrapes fresh dynamic stream tokens every 3 hours.
 *   - Performs round-robin downloading & uploading (2 parallel workers) to 6 channels.
 *   - Syncs VIP-18 source channel (@zzkbraxk) every 10 minutes.
 *   - Synchronizes & translates 6 VIP channels catalog every 10 minutes.
 *   - Enforces 5 uploads/day per channel quota.
 *   - Sweeps old/stale downloads every 1 hour.
 */

const { VipPipelineOrchestrator } = require('./vip_pipeline_orchestrator');
const { ZzkbraxkPipeline } = require('./vip_channel_source_pipeline');
const { syncAllChannels } = require('./sync_channel_history');

const SCRAPE_INTERVAL_MS = 3 * 60 * 60 * 1000;      // 3 Hours
const PIPELINE_INTERVAL_MS = 15 * 60 * 1000;         // 15 Minutes
const ZZKBRAXK_INTERVAL_MS = 10 * 60 * 1000;        // 10 Minutes
const SYNC_CHANNELS_INTERVAL_MS = 10 * 60 * 1000;   // 10 Minutes
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;          // 1 Hour

async function startDaemon() {
  console.log(`\n=======================================================`);
  console.log(`👑 VIP PIPELINE DAEMON INITIALIZING`);
  console.log(`=======================================================`);
  console.log(`• Scrape Link Refresh:     Every 3 Hours`);
  console.log(`• Download & Upload:       Every 15 Minutes (2 Parallel Workers)`);
  console.log(`• VIP-18 Channel Sync:     Every 10 Minutes (@zzkbraxk)`);
  console.log(`• 6-Channel Catalog Sync:  Every 10 Minutes (Live Telegram -> Bot)`);
  console.log(`• Quota Limit:             5 Videos / Channel / Day`);
  console.log(`• Auto Disk Cleanup:       Every 1 Hour (Stale files > 1h)`);
  console.log(`=======================================================\n`);

  const orchestrator = new VipPipelineOrchestrator();
  const zzkbraxkPipeline = new ZzkbraxkPipeline();

  let isScraping = false;
  let isProcessing = false;
  let isZzkbraxkSyncing = false;
  let isChannelSyncing = false;

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

  async function triggerZzkbraxk() {
    if (isZzkbraxkSyncing) return;
    isZzkbraxkSyncing = true;
    try {
      await zzkbraxkPipeline.runSync(20);
    } catch (e) {
      console.error(`[VIP_DAEMON] Zzkbraxk sync error:`, e.message);
    } finally {
      isZzkbraxkSyncing = false;
    }
  }

  async function triggerChannelSync() {
    if (isChannelSyncing) return;
    isChannelSyncing = true;
    try {
      await syncAllChannels();
    } catch (e) {
      console.error(`[VIP_DAEMON] Live channel sync error:`, e.message);
    } finally {
      isChannelSyncing = false;
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

  // Initial execution: run pipeline dispatch immediately
  console.log(`[VIP_DAEMON] Running initial pipeline dispatch...`);
  triggerPipeline().catch(e => console.error(`[VIP_DAEMON] Pipeline error:`, e.message));

  // Run initial VIP-18 source channel sync
  triggerZzkbraxk().catch(e => console.error(`[VIP_DAEMON] Zzkbraxk sync error:`, e.message));

  // Run initial live channel catalog sync
  triggerChannelSync().catch(e => console.error(`[VIP_DAEMON] Channel sync error:`, e.message));

  // Run initial full scraper in background without blocking pipeline
  triggerScraper().catch(e => console.error(`[VIP_DAEMON] Background scraper error:`, e.message));

  // Set recurring timers
  setInterval(triggerPipeline, PIPELINE_INTERVAL_MS);
  setInterval(triggerZzkbraxk, ZZKBRAXK_INTERVAL_MS);
  setInterval(triggerChannelSync, SYNC_CHANNELS_INTERVAL_MS);
  setInterval(triggerScraper, SCRAPE_INTERVAL_MS);
  setInterval(triggerCleanup, CLEANUP_INTERVAL_MS);

  // Graceful shutdown handling
  const shutdown = (signal) => {
    console.log(`\n🛑 [VIP_DAEMON] Graceful shutdown signal (${signal}) received. Stopping daemon...`);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason, promise) => {
    console.error(`⚠️ [VIP_DAEMON] Unhandled Rejection at:`, promise, `reason:`, reason);
  });

  process.on('uncaughtException', (err) => {
    console.error(`💥 [VIP_DAEMON] Uncaught Exception:`, err);
  });

  console.log(`[VIP_DAEMON] All recurring background timers active.`);
}

if (require.main === module) {
  startDaemon().catch(err => {
    console.error(`[VIP_DAEMON] Fatal daemon crash:`, err);
    process.exit(1);
  });
}

module.exports = { startDaemon };
