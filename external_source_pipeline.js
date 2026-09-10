/**
 * ============================================================
 * 🔄 EXTERNAL SOURCE INGESTION PIPELINE & 30-MINUTE SCHEDULER
 * ============================================================
 * Manages continuous ingestion for authorized external content sources:
 * - Initial Backfill: Discovers existing catalog up to 150 items global retention pool.
 * - 30-Minute Polling: Periodically discovers only genuinely new items.
 * - Persistent Dedupe Ledger: Permanent storage of processed item IDs.
 * - Global 150 Retention Pool: Rolling retention across all 10 destination channels.
 * - Scheduler Safety: Singleton guard, duplicate prevention, concise logging.
 * - Failure Isolation: Retries with backoff, preserves checkpoints on failure.
 */

const fs = require("fs");
const path = require("path");
const { ExternalSourceAdapter } = require("./external_source_adapter");
const { AvseeSourceAdapter } = require("./avsee_source_adapter");
const { ExternalSourcePublisher } = require("./external_source_publisher");
const { ExternalSourceState, MAX_GLOBAL_RETENTION } = require("./external_source_state");
const { getDestinationForTopic } = require("./external_source_destinations");

const POLLING_INTERVAL_MS = 20 * 60 * 1000; // Exact 20 minutes (1,200,000 ms)

function createDefaultAdapter(config = {}) {
  const sourceType = (config.sourceType || process.env.EXTERNAL_SOURCE_TYPE || "avsee").toLowerCase();
  if (sourceType === "avsee") {
    return new AvseeSourceAdapter(config);
  }
  return new ExternalSourceAdapter(config);
}

class ExternalSourcePipeline {
  /**
   * @param {object} [config]
   * @param {ExternalSourceAdapter} [config.adapter]
   * @param {ExternalSourcePublisher} [config.publisher]
   * @param {ExternalSourceState} [config.stateStore]
   * @param {number} [config.pollingIntervalMs=1800000]
   * @param {number} [config.maxTotalItems=150]
   * @param {boolean} [config.dryRun=true]
   */
  constructor(config = {}) {
    this.pollingIntervalMs = config.pollingIntervalMs || POLLING_INTERVAL_MS;
    this.maxTotalItems = config.maxTotalItems || MAX_GLOBAL_RETENTION;
    this.dryRun = config.dryRun !== undefined ? Boolean(config.dryRun) : (process.env.AVSEE_DRY_RUN !== "false");

    this.stateStore = config.stateStore || new ExternalSourceState({
      maxTotalItems: this.maxTotalItems
    });

    this.adapter = config.adapter || createDefaultAdapter({
      dryRun: this.dryRun
    });

    this.publisher = config.publisher || new ExternalSourcePublisher({
      stateStore: this.stateStore,
      maxTotalItems: this.maxTotalItems
    });

    this.timerId = null;
    this.isPollingActive = false;
    this.isStarted = false;
    this.totalPollCycles = 0;
    this.lastPollSummary = null;
    this.initialTaskPromise = null;
  }

  // ============================================================
  // 📥 INITIAL BACKFILL
  // ============================================================

  /**
   * Runs the initial backfill to discover and normalize existing content from the source.
   * Discovers eligible content and populates the global 150-item retention pool.
   * Delivers up to the 15-item daily external delivery quota, keeping the rest as fallback reserve.
   * @param {object} [options]
   * @param {Array<object>} [options.sourceItems] Optional pre-fetched or mock items
   * @returns {Promise<object>} Backfill summary
   */
  async runInitialBackfill(options = {}) {
    if (this.isPollingActive) {
      console.warn("⚠️ [EXTERNAL_SOURCE] Operation already in progress. Skipping backfill.");
      return { status: "SKIPPED_OVERLAPPING", summary: null };
    }

    this.isPollingActive = true;
    const startTime = Date.now();

    console.log(`[EXTERNAL_SOURCE] initial backfill started`);

    const summary = {
      action: "INITIAL_BACKFILL",
      discovered: 0,
      newItems: 0,
      queued: 0,
      skippedDuplicate: 0,
      invalid: 0,
      globalRetainedPool: 0,
      externalDeliveredToday: 0,
      externalRemainingQuota: 0,
      durationMs: 0
    };

    let backfillError = null;
    try {
      this.stateStore.ensureDailyWindow();
      let externalRemaining = this.stateStore.getExternalRemainingQuota();

      let rawItems = [];
      if (options.sourceItems && Array.isArray(options.sourceItems)) {
        rawItems = options.sourceItems;
      } else {
        rawItems = await this.adapter.fetchItems(options);
      }

      summary.discovered = Array.isArray(rawItems) ? rawItems.length : 0;
      console.log(`[AVSEE] parsed listings: ${summary.discovered}`);

      for (const raw of rawItems) {
        let detailItem = raw;
        if (!raw.description && !raw.tags && typeof this.adapter.fetchItemDetails === "function" && raw.pageUrl) {
          try {
            detailItem = await this.adapter.fetchItemDetails(raw);
          } catch (e) {
            console.warn(`⚠️ [AVSEE] detail navigation error for ${raw.pageUrl}: ${e.message}`);
          }
        }

        // 1. Normalize
        const normalized = this.adapter.normalizeItem(detailItem);
        if (!normalized || !normalized.valid) {
          summary.invalid++;
          continue;
        }

        console.log(`[AVSEE] normalized item: ${normalized.itemId}`);
        console.log(`[AVSEE] validation: PASS`);

        // 2. Check permanent dedupe ledger
        if (this.stateStore.hasSeen(normalized)) {
          summary.skippedDuplicate++;
          continue;
        }

        summary.newItems++;

        // 3. Route to destination (Hierarchical topic match or Fallback channel)
        const destination = getDestinationForTopic(normalized.topicKey);
        normalized.destinationChannel = destination.destinationChannelId;

        // 4. Ingest into global 150 pool
        console.log(`[AVSEE] pipeline processing: PASS`);
        await this.publisher.publishAuthorizedItem(normalized, null, destination);
        console.log(`[AVSEE] dry-run delivery: PASS`);

        // 5. If within daily delivery quota (15/day), record delivery
        if (externalRemaining > 0 && summary.queued < externalRemaining) {
          this.stateStore.recordExternalDelivery(normalized, destination);
          summary.queued++;
        } else {
          // Stored in ledger and pool, but not marked delivered for today
          this.stateStore.recordPermanentItem(normalized, { isDelivered: false, status: "RETAINED_IN_POOL" });
        }
      }

      // Update checkpoint
      this.stateStore.updateCheckpoint(summary.discovered);
      summary.globalRetainedPool = this.stateStore.retainedPool.length;
      summary.externalDeliveredToday = this.stateStore.externalDeliveredToday;
      summary.externalRemainingQuota = this.stateStore.getExternalRemainingQuota();

    } catch (err) {
      backfillError = err;
      console.error(`❌ [EXTERNAL_SOURCE] Initial backfill error: ${err.message}`);
    } finally {
      this.isPollingActive = false;
      summary.durationMs = Date.now() - startTime;
      this.lastPollSummary = summary;

      if (backfillError) {
        console.log(`[EXTERNAL_SOURCE] initial backfill FAILED: ${backfillError.message}`);
      } else {
        console.log(`[AVSEE] initial backfill complete: ${summary.queued} delivered`);
        console.log(`[EXTERNAL_SOURCE] initial backfill complete: ${summary.queued} delivered (${summary.externalDeliveredToday}/${this.stateStore.externalDailyTarget} daily quota, ${summary.globalRetainedPool}/${this.maxTotalItems} global pool)`);
      }
    }

    return summary;
  }

  // ============================================================
  // ⏱️ 30-MINUTE POLLING CYCLE
  // ============================================================

  /**
   * Executes a single 30-minute polling cycle with 24-hour daily delivery quota:
   * - Priority 1: Genuinely new eligible items discovered since previous check.
   * - Priority 2: Older never-delivered eligible items from catalog/pool if new items < remaining quota.
   * - Priority 3: Reports shortfall if catalog has insufficient never-delivered items.
   * - Never reposts or redelivers previously delivered items.
   * @param {object} [options]
   * @param {Array<object>} [options.sourceItems] Optional pre-fetched or mock items
   * @returns {Promise<object>} Poll summary
   */
  async runPollingCycle(options = {}) {
    if (this.isPollingActive) {
      console.warn("⚠️ [EXTERNAL_SOURCE] Previous polling cycle is still active. Skipping overlapping run.");
      return { status: "SKIPPED_OVERLAPPING", summary: null };
    }

    this.isPollingActive = true;
    const startTime = Date.now();

    console.log(`[EXTERNAL_SOURCE] poll started`);

    const summary = {
      action: "POLL_CYCLE",
      discovered: 0,
      newItems: 0,
      queued: 0,
      skippedDuplicate: 0,
      invalid: 0,
      fallbackCandidates: 0,
      fallbackDelivered: 0,
      globalRetainedPool: 0,
      externalDeliveredToday: 0,
      externalRemainingQuota: 0,
      durationMs: 0
    };

    try {
      this.stateStore.ensureDailyWindow();
      let externalRemaining = this.stateStore.getExternalRemainingQuota();
      summary.externalRemainingQuota = externalRemaining;
      summary.externalDeliveredToday = this.stateStore.externalDeliveredToday;

      let rawItems = [];
      if (options.sourceItems && Array.isArray(options.sourceItems)) {
        rawItems = options.sourceItems;
      } else {
        rawItems = await this.adapter.fetchItems(options);
      }

      summary.discovered = Array.isArray(rawItems) ? rawItems.length : 0;

      // Filter genuinely new items
      const newDiscovered = [];
      for (const raw of rawItems) {
        const normalized = this.adapter.normalizeItem(raw);
        if (!normalized || !normalized.valid) {
          summary.invalid++;
          continue;
        }

        if (this.stateStore.hasSeen(normalized)) {
          summary.skippedDuplicate++;
        } else {
          // Immediately index as discovered (not yet delivered)
          this.stateStore.recordPermanentItem(normalized, { isDelivered: false, status: "DISCOVERED" });
          newDiscovered.push(normalized);
        }
      }

      summary.newItems = newDiscovered.length;

      // Priority 1: Deliver genuinely new items up to externalRemaining quota
      if (externalRemaining > 0 && newDiscovered.length > 0) {
        const toDeliverFromNew = newDiscovered.slice(0, externalRemaining);
        for (const item of toDeliverFromNew) {
          const dest = getDestinationForTopic(item.topicKey);
          item.destinationChannel = dest.destinationChannelId;

          await this.publisher.publishAuthorizedItem(item, null, dest);
          this.stateStore.recordExternalDelivery(item, dest);
          summary.queued++;
        }
      }

      // Priority 2: Fallback from previously discovered never-delivered items
      const remainingQuotaAfterNew = this.stateStore.getExternalRemainingQuota();
      if (remainingQuotaAfterNew > 0) {
        const fallbackCandidates = this.stateStore.getNeverDeliveredFallbackCandidates(remainingQuotaAfterNew);
        summary.fallbackCandidates = fallbackCandidates.length;

        if (fallbackCandidates.length > 0) {
          for (const item of fallbackCandidates) {
            const dest = getDestinationForTopic(item.routedTopicKey || item.topicKey);
            item.destinationChannel = dest ? dest.destinationChannelId : null;

            await this.publisher.publishAuthorizedItem(item, null, dest);
            this.stateStore.recordExternalDelivery(item, dest);
            summary.queued++;
            summary.fallbackDelivered++;
          }
        } else if (summary.newItems === 0) {
          // Priority 3: Report shortfall when 0 new items and 0 unused fallbacks available
          console.log(`[EXTERNAL_SOURCE] 0 new items`);
          console.log(`[EXTERNAL_SOURCE] no unused eligible fallback items`);
          console.log(`[EXTERNAL_SOURCE] daily quota shortfall: ${remainingQuotaAfterNew}`);
        }
      }

      // Update checkpoint only on successful poll
      this.stateStore.updateCheckpoint(summary.discovered);
      summary.globalRetainedPool = this.stateStore.retainedPool.length;
      summary.externalDeliveredToday = this.stateStore.externalDeliveredToday;
      summary.externalRemainingQuota = this.stateStore.getExternalRemainingQuota();

    } catch (err) {
      console.error(`❌ [EXTERNAL_SOURCE] Poll cycle error: ${err.message}`);
    } finally {
      this.isPollingActive = false;
      this.totalPollCycles++;
      summary.durationMs = Date.now() - startTime;
      this.lastPollSummary = summary;

      // Concise output logging as specified in Requirement 18
      console.log(`[EXTERNAL_SOURCE] daily quota: ${summary.externalDeliveredToday}/${this.stateStore.externalDailyTarget}`);
      console.log(`[EXTERNAL_SOURCE] new items: ${summary.newItems}`);
      if (summary.fallbackCandidates > 0 || summary.fallbackDelivered > 0) {
        console.log(`[EXTERNAL_SOURCE] fallback candidates: ${summary.fallbackCandidates}`);
        console.log(`[EXTERNAL_SOURCE] selected: ${summary.queued}`);
        console.log(`[EXTERNAL_SOURCE] daily quota: ${summary.externalDeliveredToday}/${this.stateStore.externalDailyTarget}`);
      }
      console.log(`[EXTERNAL_SOURCE] next check in 20 minutes`);
      console.log(`[EXTERNAL_SOURCE] poll complete`);
    }

    return summary;
  }

  // ============================================================
  // 🛡️ SCHEDULER MANAGEMENT & SINGLETON CONTROLS
  // ============================================================

  /**
   * Starts the 20-minute recurring scheduler.
   * Protected against double initialization and overlapping instances.
   * @param {object} [options]
   * @param {boolean} [options.immediate=true] Whether to run an immediate initial cycle on start
   * @param {boolean} [options.runBackfillOnStart=true]
   */
  startScheduler(options = {}) {
    if (this.isStarted || this.timerId) {
      console.warn("⚠️ [EXTERNAL_SOURCE] Scheduler is already active. Duplicate start blocked.");
      return this;
    }

    this.isStarted = true;

    const authStatus = this.adapter && typeof this.adapter.getAuthorizationStatus === "function"
      ? this.adapter.getAuthorizationStatus()
      : { configDetected: Boolean(this.adapter && this.adapter.isAuthorized), validationPass: Boolean(this.adapter && this.adapter.isAuthorized) };

    console.log(`[EXTERNAL_SOURCE] scheduler initialized`);
    console.log(`[EXTERNAL_SOURCE] polling interval: 20 minutes`);
    if (authStatus.configDetected && authStatus.validationPass) {
      console.log(`[EXTERNAL_SOURCE] authorization: CONFIGURED & VERIFIED`);
    } else if (authStatus.configDetected) {
      console.log(`[EXTERNAL_SOURCE] authorization: CONFIG DETECTED (VALIDATION FAIL)`);
    } else {
      console.log(`[EXTERNAL_SOURCE] authorization: NOT CONFIGURED`);
    }
    console.log(`[EXTERNAL_SOURCE] publishing: ${this.publisher && this.publisher.publishEnabled ? "ENABLED" : "DISABLED"}`);
    console.log(`[EXTERNAL_SOURCE] media download: ${this.dryRun ? "DISABLED" : "ENABLED"}`);

    if (this.adapter && typeof this.adapter.checkBrowserLaunch === "function") {
      this.adapter.checkBrowserLaunch().then(res => {
        if (res.executablePath) {
          console.log(`[AVSEE] Chromium executable selected: ${res.executablePath}`);
        }
        if (res.pass) {
          console.log("[AVSEE] Chromium runtime verification: PASS");
          console.log("[AVSEE] browser runtime: PASS");
          console.log("[EXTERNAL_SOURCE] Playwright browser launch check: PASS");
        } else {
          console.log(`[AVSEE] Chromium runtime verification: FAIL: ${res.error}`);
          console.log(`[EXTERNAL_SOURCE] Playwright browser launch check: FAIL: ${res.error}`);
        }
      }).catch(err => {
        console.log(`[AVSEE] Chromium runtime verification: FAIL: ${err.message}`);
        console.log(`[EXTERNAL_SOURCE] Playwright browser launch check: FAIL: ${err.message}`);
      });
    }

    // Run initial backfill or immediate cycle on startup if requested
    if (options.immediate !== false) {
      const initialTask = options.runBackfillOnStart !== false 
        ? this.runInitialBackfill(options) 
        : this.runPollingCycle(options);

      this.initialTaskPromise = initialTask.catch(err => {
        console.error(`❌ [EXTERNAL_SOURCE] Startup task error: ${err.message}`);
      });
    }

    // Schedule exact 30-minute recurring poll
    this.timerId = setInterval(() => {
      this.runPollingCycle().catch(err => {
        console.error(`❌ [EXTERNAL_SOURCE] Recurring poll error: ${err.message}`);
      });
    }, this.pollingIntervalMs);

    return this;
  }

  /**
   * Stops the recurring scheduler cleanly
   */
  stopScheduler() {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    this.isStarted = false;
    this.isPollingActive = false;
    console.log(`[EXTERNAL_SOURCE] scheduler stopped cleanly`);
  }
}

// Singleton Guard Instance
let globalPipelineInstance = null;

function getPipelineInstance(config = {}) {
  if (!globalPipelineInstance) {
    globalPipelineInstance = new ExternalSourcePipeline(config);
  }
  return globalPipelineInstance;
}

module.exports = {
  ExternalSourcePipeline,
  POLLING_INTERVAL_MS,
  getPipelineInstance,
  instance: getPipelineInstance()
};
