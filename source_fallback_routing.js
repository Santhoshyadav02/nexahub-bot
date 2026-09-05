/**
 * source_fallback_routing.js
 * 
 * NexaHub Source-Based Fallback Routing Engine (Stage 5 - DRY RUN ONLY)
 * 
 * Implements strict hierarchical routing:
 * 1. Explicit topic/category match (HIGH)
 * 2. Strong keyword match (MEDIUM)
 * 3. Source-specific deterministic fallback (based on verified channel metadata)
 * 4. UNCLASSIFIED (for low confidence or ambiguous cases)
 * 
 * SAFETY CONSTRAINTS:
 * - 100% DRY RUN ONLY.
 * - No media downloading.
 * - No publishing, sending, or copying to Telegram channels.
 * - No modifications to production files (index.js, scraper.js, etc.).
 */

const { TelegramContentClassifier } = require("./telegram_content_classifier");
const { KoreanCaptionPipeline } = require("./korean_caption_generator");

const SOURCE_FALLBACK_CONFIG = {
  // 1. @korea18movie: Korean 18+ adult melodrama & romance movies
  "1762071168": {
    username: "korea18movie",
    enabled: true,
    fallbackDestination: "DESTINATION_3", // Romance
    fallbackCategory: "Romance",
    reason: "Source is dedicated to Korean 18+ adult movies with romantic/melodrama themes",
    confidence: "MEDIUM"
  },
  // 2. @Korea_Japanese_Adult: Japanese & Korean-Japanese adult movies
  "1871127271": {
    username: "Korea_Japanese_Adult",
    enabled: true,
    fallbackDestination: "DESTINATION_9", // Saki Mizumi (Japanese Adult)
    fallbackCategory: "Saki Mizumi",
    reason: "Source is dedicated to Japanese and Korean-Japanese adult movies and JAV releases",
    confidence: "HIGH"
  },
  // 3. @koreannarchive: Korean VIP & Fantrie creator content
  "1518888395": {
    username: "koreannarchive",
    enabled: true,
    fallbackDestination: "DESTINATION_8", // Concubine (VIP / Fantrie)
    fallbackCategory: "Concubine",
    reason: "Source is dedicated to Korean VIP channel creator archives and Fantrie sets",
    confidence: "HIGH"
  },
  // 4. @koreannarchivereal: Korean Archive sister channel (creator clips)
  "2182873758": {
    username: "koreannarchivereal",
    enabled: true,
    fallbackDestination: "DESTINATION_8", // Concubine (VIP / Fantrie)
    fallbackCategory: "Concubine",
    reason: "Sister channel to koreannarchive sharing the same Korean VIP creator archive catalog",
    confidence: "MEDIUM"
  },
  // 5. @DSDSZY4: Chinese TanHua & Live Streamer content
  "3674181298": {
    username: "DSDSZY4",
    enabled: true,
    fallbackDestination: "DESTINATION_5", // Mosa (TanHua / Streamer)
    fallbackCategory: "Mosa",
    reason: "Channel title and content specialize in domestic Chinese TanHua (探花) and live streamer material",
    confidence: "HIGH"
  },
  // 6. @xuexiziliao2: OnlyFans & Twitter model shares
  "1521978999": {
    username: "xuexiziliao2",
    enabled: true,
    fallbackDestination: "DESTINATION_10", // A Muse (OnlyFans / Model)
    fallbackCategory: "A Muse",
    reason: "Channel entity title 'onlyfans推特分享' explicitly designates OnlyFans & Twitter creator video stream",
    confidence: "HIGH"
  },
  // 7. @madougirl: 91porn / Madou model releases
  "2604815578": {
    username: "madougirl",
    enabled: true,
    fallbackDestination: "DESTINATION_10", // A Muse (Madou / 91porn / Model)
    fallbackCategory: "A Muse",
    reason: "Source is dedicated to 91porn and Madou creator video productions",
    confidence: "HIGH"
  },
  // 8. @wanwu5555: Specialized live streamer/fetish sharing
  "3832681538": {
    username: "wanwu5555",
    enabled: true,
    fallbackDestination: "UNCLASSIFIED",
    fallbackCategory: "UNCLASSIFIED",
    reason: "Specialized live streamer/fetish content pending official destination assignment; kept UNCLASSIFIED.",
    confidence: "LOW"
  }
};

class SourceFallbackRouter {
  /**
   * @param {object} [fallbackConfig] 
   * @param {object} [classifier] 
   */
  constructor(fallbackConfig = SOURCE_FALLBACK_CONFIG, classifier = null) {
    this.fallbackConfig = fallbackConfig || SOURCE_FALLBACK_CONFIG;
    this.classifier = classifier || new TelegramContentClassifier();
    this.captionPipeline = new KoreanCaptionPipeline(this.classifier);
  }

  /**
   * Evaluates routing for a single item using hierarchical decision tree:
   * 1. Direct High Keyword Match
   * 2. Direct Medium Keyword Match
   * 3. Source Fallback (if source enabled and confidence != LOW)
   * 4. UNCLASSIFIED
   * 
   * @param {object} item 
   * @returns {object}
   */
  routeItem(item) {
    // 1 & 2. Run primary content classification & caption pipeline
    const record = this.captionPipeline.processVideo(item);

    // If already classified with HIGH or MEDIUM confidence, preserve direct match
    if (record.confidence === "HIGH" || record.confidence === "MEDIUM") {
      return {
        ...record,
        routingStage: "DIRECT_KEYWORD_MATCH",
        fallbackApplied: false,
        fallbackReason: null
      };
    }

    // 3. Check Source Fallback
    const sourceChannelId = String(item.sourceChannelId || "unknown");
    const fallbackRule = this.fallbackConfig[sourceChannelId] || Object.values(this.fallbackConfig).find(
      r => r.username && item.sourceUsername && r.username.toLowerCase() === item.sourceUsername.toLowerCase()
    );

    if (fallbackRule && fallbackRule.enabled) {
      if (fallbackRule.confidence === "LOW") {
        // LOW confidence fallback must remain UNCLASSIFIED per specification
        return {
          ...record,
          routingStage: "REJECTED_LOW_CONFIDENCE_FALLBACK",
          fallbackApplied: false,
          fallbackReason: `Fallback rule for ${sourceChannelId} has LOW confidence; marked UNCLASSIFIED for review.`
        };
      }

      return {
        ...record,
        destinationChannelId: fallbackRule.fallbackDestination,
        matchedCategory: fallbackRule.fallbackCategory,
        confidence: fallbackRule.confidence,
        routingStage: "SOURCE_LEVEL_FALLBACK",
        fallbackApplied: true,
        fallbackReason: fallbackRule.reason
      };
    }

    // 4. UNCLASSIFIED
    return {
      ...record,
      routingStage: "UNCLASSIFIED",
      fallbackApplied: false,
      fallbackReason: "No direct keyword match and no valid source fallback rule."
    };
  }

  /**
   * Process a batch of video items comparing before and after fallback metrics
   * @param {Array<object>} items 
   * @returns {object}
   */
  processBatch(items = []) {
    const summary = {
      totalVideos: items.length,
      beforeFallback: {
        classified: 0,
        unclassified: 0,
        destinationDistribution: {}
      },
      afterFallback: {
        classified: 0,
        unclassified: 0,
        newlyClassified: 0,
        destinationDistribution: {}
      },
      sourceRoutingBreakdown: {},
      fallbackAppliedCount: 0,
      decisions: []
    };

    // Initialize 10 destinations
    for (let i = 1; i <= 10; i++) {
      summary.beforeFallback.destinationDistribution[`DESTINATION_${i}`] = 0;
      summary.afterFallback.destinationDistribution[`DESTINATION_${i}`] = 0;
    }

    // Separate clean classifier for baseline comparison
    const baselineClassifier = new TelegramContentClassifier();

    for (const item of items) {
      // Step A: Evaluate baseline before fallback
      const baseline = baselineClassifier.classify(item);
      const isBaselineClassified = baseline.confidence === "HIGH" || baseline.confidence === "MEDIUM";

      if (isBaselineClassified) {
        summary.beforeFallback.classified++;
        if (baseline.destinationChannelId && summary.beforeFallback.destinationDistribution[baseline.destinationChannelId] !== undefined) {
          summary.beforeFallback.destinationDistribution[baseline.destinationChannelId]++;
        }
      } else {
        summary.beforeFallback.unclassified++;
      }

      // Step B: Evaluate with source fallback
      const decision = this.routeItem(item);
      summary.decisions.push(decision);

      const isFinalClassified = decision.destinationChannelId && (decision.confidence === "HIGH" || decision.confidence === "MEDIUM");

      if (isFinalClassified) {
        summary.afterFallback.classified++;
        if (summary.afterFallback.destinationDistribution[decision.destinationChannelId] !== undefined) {
          summary.afterFallback.destinationDistribution[decision.destinationChannelId]++;
        }
      } else {
        summary.afterFallback.unclassified++;
      }

      if (!isBaselineClassified && isFinalClassified) {
        summary.afterFallback.newlyClassified++;
      }

      if (decision.fallbackApplied) {
        summary.fallbackAppliedCount++;
      }

      // Track Source -> Destination Breakdown
      const src = item.sourceUsername || item.sourceChannelId || "unknown";
      if (!summary.sourceRoutingBreakdown[src]) {
        summary.sourceRoutingBreakdown[src] = {
          total: 0,
          directMatches: 0,
          fallbackMatches: 0,
          unclassified: 0,
          destinations: {}
        };
      }

      summary.sourceRoutingBreakdown[src].total++;
      if (decision.routingStage === "DIRECT_KEYWORD_MATCH") {
        summary.sourceRoutingBreakdown[src].directMatches++;
      } else if (decision.routingStage === "SOURCE_LEVEL_FALLBACK") {
        summary.sourceRoutingBreakdown[src].fallbackMatches++;
      } else {
        summary.sourceRoutingBreakdown[src].unclassified++;
      }

      const dst = decision.destinationChannelId || "UNCLASSIFIED";
      summary.sourceRoutingBreakdown[src].destinations[dst] = (summary.sourceRoutingBreakdown[src].destinations[dst] || 0) + 1;
    }

    return summary;
  }
}

/**
 * Execute live Stage 5 Source Fallback Routing Dry Run via MTProto
 */
async function runLiveStage5Pipeline() {
  const { SOURCE_CHANNELS_LIST } = require("./telegram_source_router");
  const { TelegramClient } = require("telegram");
  const { StringSession } = require("telegram/sessions");

  const apiId = parseInt(process.env.TELEGRAM_API_ID || "0", 10);
  const apiHash = process.env.TELEGRAM_API_HASH || "";
  const sessionStr = (process.env.TELEGRAM_SESSION_STRING || "").trim();

  if (!apiId || !apiHash || !sessionStr) {
    throw new Error("MTProto credentials missing from environment.");
  }

  const session = new StringSession(sessionStr);
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
    timeout: 10000
  });

  console.log("==================================================");
  console.log("🚀 NEXAHUB — STAGE 5 SOURCE FALLBACK ROUTING DRY RUN");
  console.log("==================================================");
  console.log("📡 Connecting MTProto client (READ-ONLY)...");
  await client.connect();
  console.log("✅ MTProto client: CONNECTED\n");

  const fallbackRouter = new SourceFallbackRouter();
  const allVideoItems = [];

  for (const src of SOURCE_CHANNELS_LIST) {
    try {
      const entity = await client.getEntity(src.username);
      const actualId = entity.id ? entity.id.toString() : src.id;
      const messages = await client.getMessages(entity, { limit: 40 });

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
          const rawText = msg.message || msg.text || "";
          allVideoItems.push({
            sourceChannelId: actualId,
            sourceUsername: src.username,
            channelName: entity.title || src.username,
            messageId: String(msg.id),
            groupedId: msg.groupedId ? String(msg.groupedId) : null,
            caption: rawText,
            title: rawText ? rawText.split("\n")[0].trim().slice(0, 80) : "",
            date: msg.date ? new Date(msg.date * 1000).toISOString() : null
          });
        }
      }
    } catch (err) {
      console.warn(`⚠️ Error reading from source @${src.username}: ${err.message}`);
    }
  }

  await client.disconnect();
  console.log("📡 MTProto client disconnected.\n");

  const summary = fallbackRouter.processBatch(allVideoItems);
  return summary;
}

if (require.main === module) {
  runLiveStage5Pipeline().then(summary => {
    console.log("==================================================");
    console.log("📊 STAGE 5 SOURCE-BASED FALLBACK ROUTING REPORT");
    console.log("==================================================");
    console.log(`TOTAL VIDEOS:            ${summary.totalVideos}`);
    console.log("--------------------------------------------------");
    console.log("BEFORE FALLBACK:");
    console.log(`  Classified:            ${summary.beforeFallback.classified}`);
    console.log(`  Unclassified:          ${summary.beforeFallback.unclassified}`);
    console.log("--------------------------------------------------");
    console.log("AFTER FALLBACK:");
    console.log(`  Classified:            ${summary.afterFallback.classified}`);
    console.log(`  Unclassified:          ${summary.afterFallback.unclassified}`);
    console.log(`  Newly Classified:      ${summary.afterFallback.newlyClassified}`);
    console.log("--------------------------------------------------");
    console.log("DESTINATION DISTRIBUTION:");
    for (const [dest, count] of Object.entries(summary.afterFallback.destinationDistribution)) {
      console.log(`  ${dest}: ${count}`);
    }
    console.log("--------------------------------------------------");
    console.log("SOURCE -> DESTINATION BREAKDOWN:");
    for (const [src, data] of Object.entries(summary.sourceRoutingBreakdown)) {
      const parts = Object.entries(data.destinations).map(([d, c]) => `${d}=${c}`).join(", ");
      console.log(`  • @${src} -> ${parts} (Direct: ${data.directMatches}, Fallback: ${data.fallbackMatches}, Unclass: ${data.unclassified})`);
    }
    console.log("==================================================\n");
  }).catch(err => {
    console.error("Stage 5 execution error:", err.message);
    process.exit(1);
  });
}

module.exports = {
  SOURCE_FALLBACK_CONFIG,
  SourceFallbackRouter,
  runLiveStage5Pipeline
};
