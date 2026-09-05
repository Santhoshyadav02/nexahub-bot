/**
 * telegram_pipeline_publisher.js
 * 
 * NexaHub Telegram Publisher & 30-Minute Ingestion Pipeline (Stage 8)
 * 
 * Connects 8 authorized source channels to the 10 destination channels
 * using the Stage 5 classification/fallback router and Stage 7 300-caption pool.
 * 
 * FEATURES:
 * - Persistent ledger deduplication (sourceChannelId + ":" + messageId)
 * - Anti-flood rate limiting delays between destination posts
 * - Graceful failure recovery (failures are NOT recorded as successes)
 * - Safe integration with source_registry for 12-card bot flow
 * - Controlled Phase A smoke test (max 1 video per destination, max 10 total)
 */

const fs = require("fs");
const path = require("path");
const { SOURCE_ROUTING_CONFIG, SOURCE_CHANNELS_LIST } = require("./telegram_source_router");
const { SourceFallbackRouter } = require("./source_fallback_routing");
const { GlobalRoundRobinRouter } = require("./global_round_robin_router");
const { loadRoutingConfig } = require("./telegram_content_classifier");
const { generateKoreanCaptionAsync } = require("./korean_caption_generator");
const MTProtoChannelReader = require("./mtproto_reader");

const LEDGER_PATH = path.join(__dirname, "published_ledger.json");
const CONFIG_PATH = path.join(__dirname, "pipeline_config.json");

function loadPipelineConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const raw = fs.readFileSync(CONFIG_PATH, "utf8");
      return JSON.parse(raw);
    } catch (e) {
      console.warn("⚠️ Could not parse pipeline_config.json, using defaults.");
    }
  }
  return {
    schedulerIntervalMs: 900000, // 15 minutes (Stage 10)
    initialHistoryLimit: 10,
    maxPublishPerCycle: 10,
    rateLimitDelayMs: 1500,
    dryRun: false,
    smokeTestMode: true,
    maxPerDestinationInSmokeTest: 1
  };
}

class PublishedLedger {
  /**
   * @param {string} [filePath] 
   */
  constructor(filePath = LEDGER_PATH) {
    this.filePath = filePath;
    this.records = [];
    this.publishedIdentities = new Set();
    this.assignedDestinations = new Map();
    this.nextRoundRobinIndex = 0;
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf8");
        const parsed = JSON.parse(raw);
        this.records = Array.isArray(parsed.records) ? parsed.records : [];
        this.publishedIdentities = new Set();
        this.assignedDestinations = new Map();
        let successCount = 0;

        for (const r of this.records) {
          if (r.sourceIdentity && r.destinationChannelId) {
            this.assignedDestinations.set(r.sourceIdentity, r.destinationChannelId);
          }
          if (r.status === "SUCCESS" && r.sourceIdentity) {
            this.publishedIdentities.add(r.sourceIdentity);
            successCount++;
          }
        }

        // Authoritative load or deterministic one-time migration for legacy ledgers
        if (typeof parsed.nextRoundRobinIndex === "number" && !isNaN(parsed.nextRoundRobinIndex)) {
          this.nextRoundRobinIndex = ((parsed.nextRoundRobinIndex % 10) + 10) % 10;
        } else {
          // One-time legacy migration: compute initial index once and persist
          this.nextRoundRobinIndex = successCount % 10;
          this.save();
        }
      } else {
        this.nextRoundRobinIndex = 0;
        this.save();
      }
    } catch (err) {
      console.warn("⚠️ Error loading published ledger, initializing empty:", err.message);
      this.records = [];
      this.publishedIdentities = new Set();
      this.assignedDestinations = new Map();
      this.nextRoundRobinIndex = 0;
    }
  }

  save() {
    try {
      const payload = {
        version: "1.1.0",
        updatedAt: new Date().toISOString(),
        totalPublished: this.publishedIdentities.size,
        nextRoundRobinIndex: this.nextRoundRobinIndex,
        records: this.records
      };
      fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), "utf8");
    } catch (err) {
      console.error("❌ Error writing published ledger:", err.message);
    }
  }

  isPublished(sourceIdentity) {
    return this.publishedIdentities.has(sourceIdentity);
  }

  getAssignedDestination(sourceIdentity) {
    return this.assignedDestinations.get(sourceIdentity) || null;
  }

  getNextRoundRobinIndex() {
    return this.nextRoundRobinIndex;
  }

  advanceRoundRobinIndex() {
    const prev = this.nextRoundRobinIndex;
    this.nextRoundRobinIndex = (this.nextRoundRobinIndex + 1) % 10;
    this.save();
    return prev;
  }

  setNextRoundRobinIndex(idx) {
    this.nextRoundRobinIndex = ((idx % 10) + 10) % 10;
    this.save();
  }

  recordPublication(entry) {
    const record = {
      sourceIdentity: entry.sourceIdentity,
      sourceChannelId: entry.sourceChannelId,
      sourceMessageId: entry.sourceMessageId,
      destinationChannelId: entry.destinationChannelId,
      destinationUsername: entry.destinationUsername,
      destinationMessageId: entry.destinationMessageId,
      publishedAt: entry.publishedAt || new Date().toISOString(),
      captionSource: entry.captionSource,
      caption: entry.caption,
      matchedCategory: entry.matchedCategory,
      confidence: entry.confidence,
      status: "SUCCESS"
    };

    this.records.push(record);
    this.publishedIdentities.add(entry.sourceIdentity);
    this.assignedDestinations.set(entry.sourceIdentity, entry.destinationChannelId);
    this.save();
    return record;
  }

  recordFailure(entry, errorMsg) {
    const record = {
      sourceIdentity: entry.sourceIdentity,
      sourceChannelId: entry.sourceChannelId,
      sourceMessageId: entry.sourceMessageId,
      destinationChannelId: entry.destinationChannelId,
      destinationUsername: entry.destinationUsername,
      failedAt: new Date().toISOString(),
      error: errorMsg,
      status: "FAILED"
    };

    this.records.push(record);
    if (entry.destinationChannelId) {
      this.assignedDestinations.set(entry.sourceIdentity, entry.destinationChannelId);
    }
    this.save();
    return record;
  }
}

class TelegramPipelinePublisher {
  /**
   * @param {object} [client] GramJS client
   * @param {PublishedLedger} [ledger] 
   * @param {GlobalRoundRobinRouter|SourceFallbackRouter} [router] 
   * @param {object} [config] 
   */
  constructor(client = null, ledger = null, router = null, config = null, reader = null) {
    this.reader = reader || new MTProtoChannelReader();
    this.client = client || (this.reader ? this.reader.client : null);
    this.ledger = ledger || new PublishedLedger();
    this.router = router || new GlobalRoundRobinRouter({ ledger: this.ledger });
    this.fallbackRouter = this.router; // Backwards-compatible alias
    this.config = config || loadPipelineConfig();
    this.routingConfig = loadRoutingConfig();
    this.resolvedDestinations = new Map(); // username -> entity
  }

  /**
   * Sleep helper for rate limiting
   * @param {number} ms 
   */
  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Resolve destination channel entity
   * @param {string} destinationKey e.g. "DESTINATION_1"
   * @returns {Promise<object>}
   */
  async resolveDestination(destinationKey) {
    const destInfo = this.routingConfig.destinations[destinationKey];
    if (!destInfo || !destInfo.username) {
      throw new Error(`Destination ${destinationKey} not found in destination_routing_config.json`);
    }

    if (this.resolvedDestinations.has(destInfo.username)) {
      return { entity: this.resolvedDestinations.get(destInfo.username), info: destInfo };
    }

    if (!this.client || !this.client.connected) {
      return { entity: { id: destInfo.username, username: destInfo.username }, info: destInfo };
    }

    const entity = await this.client.getEntity(destInfo.username);
    this.resolvedDestinations.set(destInfo.username, entity);
    return { entity, info: destInfo };
  }

  /**
   * Publishes an eligible video message to its target destination channel
   * @param {object} item 
   * @param {object} decision 
   * @returns {Promise<object>}
   */
  async publishItem(item, decision) {
    const sourceIdentity = `${decision.sourceChannelId}:${decision.messageId}`;

    if (this.ledger.isPublished(sourceIdentity)) {
      return {
        status: "SKIPPED_ALREADY_PUBLISHED",
        sourceIdentity,
        destination: decision.destinationChannelId
      };
    }

    if (!decision.destinationChannelId || decision.destinationChannelId === "UNCLASSIFIED") {
      return {
        status: "SKIPPED_UNCLASSIFIED",
        sourceIdentity,
        reason: "Item has no valid destination mapping."
      };
    }

    const { entity, info } = await this.resolveDestination(decision.destinationChannelId);

    if (decision.captionSource === "source_metadata" && typeof generateKoreanCaptionAsync === "function") {
      try {
        const catName = decision.destinationName || decision.matchedCategory || "";
        const capAsync = await generateKoreanCaptionAsync(item, { matchedCategory: catName });
        if (capAsync && capAsync.generatedKoreanCaption) {
          decision.generatedKoreanCaption = capAsync.generatedKoreanCaption;
        }
      } catch (e) {}
    }

    if (this.config.dryRun) {
      return {
        status: "DRY_RUN_ACCEPTED",
        sourceIdentity,
        destinationChannelId: decision.destinationChannelId,
        destinationUsername: info.username,
        caption: decision.generatedKoreanCaption,
        captionSource: decision.captionSource
      };
    }

    try {
      if (!this.client) {
        throw new Error("MTProto client not initialized for production publishing.");
      }

      // Forward/send media with custom Korean caption to destination channel without downloading bytes
      const mediaToSend = item.rawMedia || item.media;
      if (!mediaToSend) {
        throw new Error(`Item ${sourceIdentity} lacks Telegram media object.`);
      }

      const sentMessage = await this.client.sendFile(entity, {
        file: mediaToSend,
        caption: decision.generatedKoreanCaption
      });

      const destMessageId = sentMessage ? String(sentMessage.id) : "unknown";

      const ledgerEntry = this.ledger.recordPublication({
        sourceIdentity,
        sourceChannelId: decision.sourceChannelId,
        sourceMessageId: decision.messageId,
        destinationChannelId: decision.destinationChannelId,
        destinationUsername: info.username,
        destinationMessageId: destMessageId,
        captionSource: decision.captionSource,
        caption: decision.generatedKoreanCaption,
        matchedCategory: decision.matchedCategory || decision.destinationName,
        confidence: decision.confidence || "HIGH"
      });

      // Update source_registry safely if available in environment
      try {
        const sourceRegistry = require("./source_registry");
        if (sourceRegistry && typeof sourceRegistry.processChannelPost === "function") {
          sourceRegistry.processChannelPost({
            chat: { id: entity.id ? entity.id.toString() : info.username, title: info.name, username: info.username },
            message_id: destMessageId,
            caption: decision.generatedKoreanCaption,
            video: { file_id: destMessageId, duration: 60 },
            media_type: "video",
            date: Math.floor(Date.now() / 1000)
          }, info.name, true);
        }
      } catch (regErr) {
        // Non-blocking: registry sync is supplemental
      }

      return {
        status: "SUCCESS",
        sourceIdentity,
        destinationChannelId: decision.destinationChannelId,
        destinationUsername: info.username,
        destinationMessageId: destMessageId,
        ledgerEntry
      };

    } catch (publishErr) {
      console.error(`❌ Publish error for ${sourceIdentity}:`, publishErr.message);
      this.ledger.recordFailure({
        sourceIdentity,
        sourceChannelId: decision.sourceChannelId,
        sourceMessageId: decision.messageId,
        destinationChannelId: decision.destinationChannelId,
        destinationUsername: info.username
      }, publishErr.message);

      return {
        status: "FAILED",
        sourceIdentity,
        error: publishErr.message
      };
    }
  }

  /**
   * Discovers and evaluates new eligible video items across all 8 sources
   * @param {number} [historyLimit]
   * @returns {Promise<Array<object>>}
   */
  async scanSourceChannels(historyLimit = null) {
    const limit = historyLimit || this.config.initialHistoryLimit || 10;
    const rawDiscovered = [];

    if (!this.client) {
      return [];
    }

    // Scan only enabled, unrestricted channels
    const activeSources = SOURCE_CHANNELS_LIST.filter(src => {
      const cfg = SOURCE_ROUTING_CONFIG && SOURCE_ROUTING_CONFIG.sources ? SOURCE_ROUTING_CONFIG.sources[src.id] : null;
      if (cfg && cfg.enabled === false) return false;
      return src.username !== "koreannarchive" && src.username !== "koreannarchivereal" && src.username !== "wanwu5555";
    });

    for (const src of activeSources) {
      try {
        const entity = await this.client.getEntity(src.username);
        const actualId = entity.id ? entity.id.toString() : src.id;
        const messages = await this.client.getMessages(entity, { limit });

        for (const msg of messages) {
          let isVideo = false;

          if (msg.video) {
            isVideo = true;
          } else if (msg.document) {
            const mime = (msg.document.mimeType || "").toLowerCase();
            if (mime.includes("video") || mime.endsWith("/mp4") || mime.endsWith("/mkv") || mime.endsWith("/quicktime")) {
              isVideo = true;
            }
          }

          if (isVideo) {
            const sourceIdentity = `${actualId}:${msg.id}`;
            const rawText = msg.message || msg.text || "";

            const item = {
              sourceChannelId: actualId,
              sourceUsername: src.username,
              channelName: entity.title || src.username,
              messageId: String(msg.id),
              groupedId: msg.groupedId ? String(msg.groupedId) : null,
              caption: rawText,
              title: rawText ? rawText.split("\n")[0].trim().slice(0, 80) : "",
              date: msg.date ? new Date(msg.date * 1000).toISOString() : null,
              rawMedia: msg.media,
              media: msg.media
            };

            rawDiscovered.push({
              item,
              sourceIdentity,
              alreadyPublished: this.ledger.isPublished(sourceIdentity)
            });
          }
        }
      } catch (err) {
        console.warn(`⚠️ Error reading from @${src.username}: ${err.message}`);
      }
    }

    // Deduplicate discovered items globally by sourceIdentity
    const seenIdentities = new Set();
    const uniqueCandidates = [];
    for (const cand of rawDiscovered) {
      if (!seenIdentities.has(cand.sourceIdentity)) {
        seenIdentities.add(cand.sourceIdentity);
        uniqueCandidates.push(cand);
      }
    }

    // Deterministic global ordering across sources
    uniqueCandidates.sort((a, b) => {
      const srcA = SOURCE_CHANNELS_LIST.findIndex(s => s.username === a.item.sourceUsername);
      const srcB = SOURCE_CHANNELS_LIST.findIndex(s => s.username === b.item.sourceUsername);
      if (srcA !== srcB) return srcA - srcB;
      return parseInt(b.item.messageId, 10) - parseInt(a.item.messageId, 10);
    });

    // Assign destinations sequentially using global round-robin router
    const results = [];
    for (const cand of uniqueCandidates) {
      const decision = this.router.routeItem(cand.item);
      if (decision.captionSource === "source_metadata" && typeof generateKoreanCaptionAsync === "function") {
        try {
          const catName = decision.destinationName || decision.matchedCategory || "";
          const capAsync = await generateKoreanCaptionAsync(cand.item, { matchedCategory: catName });
          if (capAsync && capAsync.generatedKoreanCaption) {
            decision.generatedKoreanCaption = capAsync.generatedKoreanCaption;
          }
        } catch (e) {}
      }
      results.push({
        item: cand.item,
        decision,
        sourceIdentity: cand.sourceIdentity,
        alreadyPublished: this.ledger.isPublished(cand.sourceIdentity)
      });
    }

    return results;
  }

  /**
   * Executes a controlled publishing cycle (Smoke test or Stage 9 historical run)
   * @returns {Promise<object>}
   */
  async runPublishCycle() {
    const candidates = await this.scanSourceChannels();
    const isSmokeTest = Boolean(this.config.smokeTestMode);
    const maxPerDest = isSmokeTest ? (this.config.maxPerDestinationInSmokeTest || 1) : 100;
    const maxPerSource = this.config.maxPublishPerSource || 10;
    const maxTotal = this.config.maxPublishPerCycle || 80;

    const destinationCounts = {};
    const sourceCounts = {};
    const plannedOperations = [];

    let unclassifiedCount = 0;
    let duplicateSkippedCount = 0;

    for (const cand of candidates) {
      if (cand.alreadyPublished) {
        duplicateSkippedCount++;
        continue;
      }
      if (!cand.decision.destinationChannelId || cand.decision.destinationChannelId === "UNCLASSIFIED") {
        unclassifiedCount++;
        continue;
      }

      const srcKey = cand.item.sourceUsername || cand.item.sourceChannelId;
      sourceCounts[srcKey] = sourceCounts[srcKey] || 0;

      if (isSmokeTest) {
        const dest = cand.decision.destinationChannelId;
        destinationCounts[dest] = destinationCounts[dest] || 0;
        if (destinationCounts[dest] < maxPerDest && sourceCounts[srcKey] < maxPerSource && plannedOperations.length < maxTotal) {
          destinationCounts[dest]++;
          sourceCounts[srcKey]++;
          plannedOperations.push(cand);
        }
      } else {
        if (sourceCounts[srcKey] < maxPerSource && plannedOperations.length < maxTotal) {
          sourceCounts[srcKey]++;
          plannedOperations.push(cand);
        }
      }
    }

    console.log(`📋 [Pipeline Cycle Plan] Discovered: ${candidates.length}, Already Published: ${duplicateSkippedCount}, Unclassified: ${unclassifiedCount}, Planned: ${plannedOperations.length}`);
    for (let i = 0; i < plannedOperations.length; i++) {
      const op = plannedOperations[i];
      const catOrName = op.decision.matchedCategory || op.decision.destinationName || "Round Robin";
      console.log(`   [${i + 1}/${plannedOperations.length}] @${op.item.sourceUsername}:${op.item.messageId} -> ${op.decision.destinationChannelId} (${catOrName}) [${op.decision.captionSource}]`);
    }

    const results = {
      totalDiscovered: candidates.length,
      totalSelected: plannedOperations.length,
      published: 0,
      failed: 0,
      skippedDuplicates: duplicateSkippedCount,
      unclassified: unclassifiedCount,
      fallbackCaptions: 0,
      sourceCaptions: 0,
      destinationBreakdown: {},
      publishedRecords: []
    };

    for (let i = 0; i < plannedOperations.length; i++) {
      const op = plannedOperations[i];
      console.log(`🚀 [Publishing ${i + 1}/${plannedOperations.length}] ${op.sourceIdentity} -> ${op.decision.destinationChannelId}...`);

      const pubRes = await this.publishItem(op.item, op.decision);

      if (pubRes.status === "SUCCESS" || pubRes.status === "DRY_RUN_ACCEPTED") {
        results.published++;
        results.publishedRecords.push(pubRes);
        if (op.decision.captionSource === "generic_fallback") {
          results.fallbackCaptions++;
        } else {
          results.sourceCaptions++;
        }
        results.destinationBreakdown[op.decision.destinationChannelId] = (results.destinationBreakdown[op.decision.destinationChannelId] || 0) + 1;
        console.log(`   ✅ Success: Dest Msg ID ${pubRes.destinationMessageId || "DRY_RUN"}`);
      } else {
        results.failed++;
        console.error(`   ❌ Failed: ${pubRes.error || pubRes.reason}`);
      }

      // Rate limit delay between posts
      if (i < plannedOperations.length - 1) {
        const delay = this.config.rateLimitDelayMs || 2500;
        await this.sleep(delay);
      }
    }

    console.log(`📊 [Pipeline Cycle Summary] Published: ${results.published}, Failed: ${results.failed}, Skipped: ${results.skippedDuplicates}, Unclassified: ${results.unclassified}\n`);
    return results;
  }
}

let pipelineSchedulerTimer = null;
let initialCycleTimer = null;
let isPublishingCycleActive = false;

/**
 * Starts the Telegram Video Pipeline recurring scheduler inside the main process
 * @param {object} [options]
 * @returns {object}
 */
function startPipelineScheduler(options = {}) {
  const config = loadPipelineConfig();
  if (options.enabled !== undefined) {
    config.enabled = options.enabled;
  }

  const intervalMs = options.intervalMs || config.schedulerIntervalMs || 900000;

  if (config.enabled === false) {
    console.log("ℹ️ Telegram Video Pipeline scheduler is currently DISABLED (enabled: false in pipeline_config.json).");
    return {
      status: "DISABLED",
      intervalMs,
      stop: stopPipelineScheduler
    };
  }

  console.log(`🚀 Starting Telegram Video Pipeline scheduler (interval: ${intervalMs / 1000}s)...`);

  const runCycle = async () => {
    if (isPublishingCycleActive) {
      console.log("ℹ️ Pipeline publish cycle already in progress. Skipping overlapping run.");
      return;
    }
    isPublishingCycleActive = true;
    try {
      const reader = new MTProtoChannelReader();
      const connected = await reader.connect();
      if (!connected) {
        console.warn("⚠️ Cannot run pipeline publish cycle: MTProto client not connected.");
        return;
      }
      const currentConfig = loadPipelineConfig();
      const publisher = new TelegramPipelinePublisher(reader.client, null, null, currentConfig, reader);
      await publisher.runPublishCycle();
    } catch (err) {
      console.error("❌ Error in pipeline publish cycle:", err.message);
    } finally {
      isPublishingCycleActive = false;
    }
  };

  // Schedule recurring cycle
  if (pipelineSchedulerTimer) {
    clearInterval(pipelineSchedulerTimer);
  }
  pipelineSchedulerTimer = setInterval(runCycle, intervalMs);

  // Trigger initial publish cycle after brief startup delay
  if (initialCycleTimer) {
    clearTimeout(initialCycleTimer);
  }
  initialCycleTimer = setTimeout(runCycle, 2500);

  return {
    status: "RUNNING",
    intervalMs,
    stop: stopPipelineScheduler
  };
}

/**
 * Stops the Telegram Video Pipeline recurring scheduler
 */
function stopPipelineScheduler() {
  if (pipelineSchedulerTimer) {
    clearInterval(pipelineSchedulerTimer);
    pipelineSchedulerTimer = null;
    console.log("⏹️ Telegram Video Pipeline scheduler stopped.");
  }
  if (initialCycleTimer) {
    clearTimeout(initialCycleTimer);
    initialCycleTimer = null;
  }
  isPublishingCycleActive = false;
}

/**
 * Controlled runner reusing MTProtoChannelReader singleton
 */
async function runUnifiedPublisherSmokeTest(customConfig = null) {
  const reader = new MTProtoChannelReader();
  const connected = await reader.connect();
  if (!connected) {
    throw new Error("MTProto client could not connect via MTProtoChannelReader singleton.");
  }

  const config = customConfig || loadPipelineConfig();
  const publisher = new TelegramPipelinePublisher(reader.client, null, null, config, reader);
  const results = await publisher.runPublishCycle();
  return results;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const isDryRun = args.includes("--dry-run");
  const isForce = args.includes("--force");

  console.log("==================================================");
  console.log("📡 TELEGRAM PIPELINE PUBLISHER (UNIFIED MTPROTO)");
  console.log("==================================================");

  if (!isDryRun && !isForce) {
    console.log("ℹ️ Standalone execution notice:");
    console.log("   Production publishing runs inside the main 'node index.js' process");
    console.log("   to prevent 406: AUTH_KEY_DUPLICATED errors with MTProto.");
    console.log("");
    console.log("   To run a safe standalone dry-run: node telegram_pipeline_publisher.js --dry-run");
    console.log("   To test using the unified MTProto singleton: node telegram_pipeline_publisher.js --dry-run --force");
    console.log("==================================================");
    process.exit(0);
  }

  const config = loadPipelineConfig();
  if (isDryRun) config.dryRun = true;

  runUnifiedPublisherSmokeTest(config).then(results => {
    const freshLedger = new PublishedLedger();
    console.log("\n==================================================");
    console.log("📊 STAGE 10 PRODUCTION SUMMARY");
    console.log("==================================================");
    console.log(`VIDEOS DISCOVERED:       ${results.totalDiscovered}`);
    console.log(`VIDEOS SELECTED:         ${results.totalSelected}`);
    console.log(`VIDEOS PUBLISHED:        ${results.published}`);
    console.log(`PUBLISHING FAILURES:     ${results.failed}`);
    console.log(`DUPLICATES SKIPPED:      ${results.skippedDuplicates}`);
    console.log(`FALLBACK KOREAN CAPTIONS:${results.fallbackCaptions}`);
    console.log(`SOURCE CAPTIONS:         ${results.sourceCaptions}`);
    console.log(`TOTAL PUBLISHED IN LEDGER: ${freshLedger.publishedIdentities.size}`);
    console.log(`NEXT ROUND-ROBIN INDEX:  ${freshLedger.getNextRoundRobinIndex()}`);
    console.log("==================================================\n");
    process.exit(0);
  }).catch(err => {
    console.error("Publisher execution error:", err.message);
    process.exit(1);
  });
}

const publisherInstance = new TelegramPipelinePublisher();

module.exports = {
  PublishedLedger,
  TelegramPipelinePublisher,
  loadPipelineConfig,
  startPipelineScheduler,
  stopPipelineScheduler,
  runUnifiedPublisherSmokeTest,
  isPublishingActive: () => isPublishingCycleActive
};
