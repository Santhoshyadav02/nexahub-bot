/**
 * telegram_content_classifier.js
 * 
 * NexaHub Telegram Content Classifier & 7->10 Router (Stage 3 - DRY RUN ONLY)
 * 
 * Analyzes Telegram message metadata (captions, titles, source handles) and
 * calculates deterministic destination channel classification across the 10 target channels.
 * 
 * SAFETY CONSTRAINTS:
 * - 100% DRY RUN ONLY.
 * - No media downloading.
 * - No publishing, sending, or copying to Telegram channels.
 * - No modifications to production files (index.js, scraper.js, etc.).
 */

const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "destination_routing_config.json");

function loadRoutingConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const raw = fs.readFileSync(CONFIG_PATH, "utf8");
      return JSON.parse(raw);
    } catch (e) {
      console.warn("⚠️ Warning: Could not parse destination_routing_config.json, using fallback.");
    }
  }
  return { destinations: {} };
}

/**
 * Normalizes input text: lowercase, strip punctuation, clean whitespace
 * Preserves English, numbers, Korean (Hangul), Chinese (CJK), Japanese (Kana).
 * @param {string} text 
 * @returns {string}
 */
function normalizeText(text) {
  if (!text || typeof text !== "string") return "";
  return text
    .toLowerCase()
    .replace(/[\r\n\t]+/g, " ")
    // Remove symbols, URLs, punctuation, but keep multilingual alphanumeric tokens
    .replace(/https?:\/\/[^\s]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract tokens and n-grams from normalized text
 * @param {string} normText 
 * @returns {Array<string>}
 */
function extractTokens(normText) {
  if (!normText) return [];
  return normText.split(" ").filter(t => t.length > 0);
}

class TelegramContentClassifier {
  /**
   * @param {object} [config] 
   * @param {Set<string>} [seenIdentities] 
   */
  constructor(config = null, seenIdentities = new Set()) {
    this.config = config || loadRoutingConfig();
    this.seenIdentities = seenIdentities;
    this.albumClassifications = new Map(); // groupedId -> classification decision
  }

  /**
   * Classify a single video message based on metadata only
   * @param {object} item 
   * @returns {object}
   */
  classify(item) {
    if (!item || typeof item !== "object") {
      return {
        sourceChannelId: "unknown",
        messageId: "unknown",
        title: "",
        matchedKeywords: [],
        matchedCategory: "UNCLASSIFIED",
        destinationChannelId: null,
        confidence: "UNCLASSIFIED",
        reason: "Invalid or empty item metadata",
        status: "INVALID_INPUT"
      };
    }

    const sourceChannelId = String(item.sourceChannelId || item.chatId || "unknown");
    const messageId = String(item.messageId || item.id || "0");
    const sourceIdentity = `${sourceChannelId}:${messageId}`;
    const groupedId = item.groupedId ? String(item.groupedId) : null;

    // Check Duplicate
    if (this.seenIdentities.has(sourceIdentity)) {
      return {
        sourceChannelId,
        messageId,
        title: item.title || "",
        matchedKeywords: [],
        matchedCategory: "UNCLASSIFIED",
        destinationChannelId: null,
        confidence: "UNCLASSIFIED",
        reason: `Duplicate message identity ${sourceIdentity}`,
        status: "SKIPPED_DUPLICATE",
        duplicate: true
      };
    }

    // Check if another message in the same grouped album was already classified with high/medium confidence
    if (groupedId && this.albumClassifications.has(groupedId)) {
      const albumDec = this.albumClassifications.get(groupedId);
      if (albumDec.confidence === "HIGH" || albumDec.confidence === "MEDIUM") {
        this.seenIdentities.add(sourceIdentity);
        return {
          sourceChannelId,
          messageId,
          title: item.title || albumDec.title || "",
          matchedKeywords: [...albumDec.matchedKeywords],
          matchedCategory: albumDec.matchedCategory,
          destinationChannelId: albumDec.destinationChannelId,
          confidence: albumDec.confidence,
          reason: `Inherited from grouped album [${groupedId}] (${albumDec.reason})`,
          status: "CLASSIFIED_ALBUM_MEMBER",
          duplicate: false
        };
      }
    }

    const rawTitle = item.title || "";
    const rawCaption = item.caption || item.text || item.captionPreview || "";
    const combinedText = `${rawTitle} ${rawCaption}`.trim();
    const norm = normalizeText(combinedText);

    if (!norm) {
      this.seenIdentities.add(sourceIdentity);
      return {
        sourceChannelId,
        messageId,
        title: rawTitle,
        matchedKeywords: [],
        matchedCategory: "UNCLASSIFIED",
        destinationChannelId: null,
        confidence: "UNCLASSIFIED",
        reason: "Blank or unparseable metadata text",
        status: "UNCLASSIFIED",
        duplicate: false
      };
    }

    const destinations = this.config.destinations || {};
    const candidates = [];

    // Evaluate each destination
    for (const destKey of Object.keys(destinations)) {
      const dest = destinations[destKey];
      if (!dest) continue;

      if (!dest.id || !dest.name) {
        return {
          sourceChannelId,
          messageId,
          title: rawTitle,
          matchedKeywords: [],
          matchedCategory: "UNCLASSIFIED",
          destinationChannelId: null,
          confidence: "UNCLASSIFIED",
          reason: `Destination configuration ${destKey} is corrupt or missing id/name`,
          status: "ERROR_INVALID_DESTINATION",
          duplicate: false
        };
      }

      const keywords = dest.keywords || {};
      const highKws = keywords.high || [];
      const medKws = keywords.medium || [];
      const lowKws = keywords.low || [];

      const matchedHigh = [];
      const matchedMed = [];
      const matchedLow = [];

      for (const kw of highKws) {
        const normKw = normalizeText(kw);
        if (normKw && (norm.includes(normKw) || norm.includes(kw.toLowerCase()))) {
          matchedHigh.push(kw);
        }
      }

      for (const kw of medKws) {
        const normKw = normalizeText(kw);
        if (normKw && (norm.includes(normKw) || norm.includes(kw.toLowerCase()))) {
          matchedMed.push(kw);
        }
      }

      for (const kw of lowKws) {
        const normKw = normalizeText(kw);
        if (normKw && (norm.includes(normKw) || norm.includes(kw.toLowerCase()))) {
          matchedLow.push(kw);
        }
      }

      if (matchedHigh.length > 0) {
        candidates.push({
          destination: dest,
          confidence: "HIGH",
          confidenceScore: 300 + matchedHigh.length * 10 + matchedMed.length * 2,
          matchedKeywords: [...matchedHigh, ...matchedMed],
          priority: dest.priority || 99
        });
      } else if (matchedMed.length > 0) {
        candidates.push({
          destination: dest,
          confidence: "MEDIUM",
          confidenceScore: 200 + matchedMed.length * 10 + matchedLow.length,
          matchedKeywords: [...matchedMed, ...matchedLow],
          priority: dest.priority || 99
        });
      } else if (matchedLow.length > 0) {
        candidates.push({
          destination: dest,
          confidence: "LOW",
          confidenceScore: 100 + matchedLow.length,
          matchedKeywords: matchedLow,
          priority: dest.priority || 99
        });
      }
    }

    this.seenIdentities.add(sourceIdentity);

    if (candidates.length === 0) {
      const decision = {
        sourceChannelId,
        messageId,
        title: rawTitle,
        matchedKeywords: [],
        matchedCategory: "UNCLASSIFIED",
        destinationChannelId: null,
        confidence: "UNCLASSIFIED",
        reason: "No matching topic keywords found in metadata",
        status: "UNCLASSIFIED",
        duplicate: false
      };
      if (groupedId) {
        this.albumClassifications.set(groupedId, decision);
      }
      return decision;
    }

    // Sort candidates:
    // 1. Highest confidence score (HIGH > MEDIUM > LOW)
    // 2. Highest number of matched keywords
    // 3. Lowest deterministic priority number (1 before 2)
    candidates.sort((a, b) => {
      if (b.confidenceScore !== a.confidenceScore) {
        return b.confidenceScore - a.confidenceScore;
      }
      if (b.matchedKeywords.length !== a.matchedKeywords.length) {
        return b.matchedKeywords.length - a.matchedKeywords.length;
      }
      return a.priority - b.priority;
    });

    const best = candidates[0];

    if (!best.destination.enabled) {
      return {
        sourceChannelId,
        messageId,
        title: rawTitle,
        matchedKeywords: best.matchedKeywords,
        matchedCategory: best.destination.name,
        destinationChannelId: best.destination.id,
        confidence: best.confidence,
        reason: `Matched destination ${best.destination.id} (${best.destination.name}) is disabled`,
        status: "IGNORED_DISABLED_DESTINATION",
        duplicate: false
      };
    }

    const decision = {
      sourceChannelId,
      messageId,
      title: rawTitle || (rawCaption ? rawCaption.slice(0, 60) : ""),
      matchedKeywords: best.matchedKeywords,
      matchedCategory: best.destination.name,
      destinationChannelId: best.destination.id,
      confidence: best.confidence,
      reason: `Matched ${best.confidence} keywords: [${best.matchedKeywords.join(", ")}]`,
      status: "CLASSIFIED",
      duplicate: false
    };

    if (groupedId) {
      this.albumClassifications.set(groupedId, decision);
    }

    return decision;
  }

  /**
   * Process a batch of video items
   * @param {Array<object>} items 
   * @returns {object}
   */
  classifyBatch(items = []) {
    const summary = {
      totalVideos: items.length,
      high: 0,
      medium: 0,
      low: 0,
      unclassified: 0,
      duplicates: 0,
      disabled: 0,
      destinationDistribution: {},
      topKeywords: {},
      decisions: [],
      unmatchedExamples: [],
      ambiguousExamples: [],
      sourceToDestinationCounts: {}
    };

    // Initialize distribution for all destinations
    if (this.config && this.config.destinations) {
      for (const destKey of Object.keys(this.config.destinations)) {
        summary.destinationDistribution[destKey] = 0;
      }
    }

    for (const item of items) {
      const decision = this.classify(item);
      summary.decisions.push(decision);

      if (decision.duplicate) {
        summary.duplicates++;
        continue;
      }

      if (decision.status === "IGNORED_DISABLED_DESTINATION") {
        summary.disabled++;
      }

      if (decision.confidence === "HIGH") {
        summary.high++;
      } else if (decision.confidence === "MEDIUM") {
        summary.medium++;
      } else if (decision.confidence === "LOW") {
        summary.low++;
      } else {
        summary.unclassified++;
      }

      if (decision.destinationChannelId && summary.destinationDistribution[decision.destinationChannelId] !== undefined) {
        summary.destinationDistribution[decision.destinationChannelId]++;
      }

      // Track source -> destination counts
      const srcKey = item.sourceUsername || item.sourceChannelId || "unknown_source";
      const dstKey = decision.destinationChannelId || "UNCLASSIFIED";
      if (!summary.sourceToDestinationCounts[srcKey]) {
        summary.sourceToDestinationCounts[srcKey] = {};
      }
      summary.sourceToDestinationCounts[srcKey][dstKey] = (summary.sourceToDestinationCounts[srcKey][dstKey] || 0) + 1;

      // Track matched keywords
      for (const kw of decision.matchedKeywords) {
        summary.topKeywords[kw] = (summary.topKeywords[kw] || 0) + 1;
      }

      // Collect unmatched examples
      if (decision.confidence === "UNCLASSIFIED" && summary.unmatchedExamples.length < 5) {
        summary.unmatchedExamples.push({
          source: srcKey,
          messageId: decision.messageId,
          text: item.caption || item.title || "(blank)"
        });
      }

      // Collect ambiguous examples (multiple keywords or LOW confidence)
      if ((decision.confidence === "LOW" || decision.matchedKeywords.length > 2) && summary.ambiguousExamples.length < 5) {
        summary.ambiguousExamples.push({
          source: srcKey,
          messageId: decision.messageId,
          matchedCategory: decision.matchedCategory,
          confidence: decision.confidence,
          matchedKeywords: decision.matchedKeywords
        });
      }
    }

    return summary;
  }
}

/**
 * Execute live Stage 3 classification dry run using MTProto discovery data
 */
async function runLiveStage3Classification() {
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
  console.log("🚀 NEXAHUB — STAGE 3 CLASSIFIER & 7->10 ROUTING DRY RUN");
  console.log("==================================================");
  console.log("📡 Connecting MTProto client (READ-ONLY)...");
  await client.connect();
  console.log("✅ MTProto client: CONNECTED\n");

  const classifier = new TelegramContentClassifier();
  const allVideoItems = [];

  for (const src of SOURCE_CHANNELS_LIST) {
    try {
      const entity = await client.getEntity(src.username);
      const actualId = entity.id ? entity.id.toString() : src.id;
      const messages = await client.getMessages(entity, { limit: 40 });

      for (const msg of messages) {
        let isVideo = false;
        let mediaType = "none";

        if (msg.video) {
          isVideo = true;
          mediaType = "video";
        } else if (msg.document) {
          const mime = (msg.document.mimeType || "").toLowerCase();
          if (mime.includes("video") || mime.endsWith("/mp4") || mime.endsWith("/mkv") || mime.endsWith("/quicktime")) {
            isVideo = true;
            mediaType = "video";
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
            date: msg.date ? new Date(msg.date * 1000).toISOString() : null,
            mediaType: mediaType
          });
        }
      }
    } catch (err) {
      console.warn(`⚠️ Error reading from source @${src.username}: ${err.message}`);
    }
  }

  await client.disconnect();
  console.log("📡 MTProto client disconnected.\n");

  const summary = classifier.classifyBatch(allVideoItems);
  return { summary, totalVideos: allVideoItems.length };
}

if (require.main === module) {
  runLiveStage3Classification().then(({ summary, totalVideos }) => {
    console.log("==================================================");
    console.log("📊 STAGE 3 CLASSIFICATION & ROUTING DRY RUN REPORT");
    console.log("==================================================");
    console.log(`TOTAL VIDEOS:     ${totalVideos}`);
    console.log(`HIGH:             ${summary.high}`);
    console.log(`MEDIUM:           ${summary.medium}`);
    console.log(`LOW:              ${summary.low}`);
    console.log(`UNCLASSIFIED:     ${summary.unclassified}`);
    console.log("--------------------------------------------------");
    console.log("DESTINATION DISTRIBUTION:");
    for (const [dest, count] of Object.entries(summary.destinationDistribution)) {
      console.log(`  ${dest}: ${count}`);
    }
    console.log("--------------------------------------------------");
    console.log("TOP MATCHED KEYWORDS:");
    const sortedKws = Object.entries(summary.topKeywords).sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [kw, cnt] of sortedKws) {
      console.log(`  • "${kw}": ${cnt}`);
    }
    console.log("--------------------------------------------------");
    console.log("SOURCE -> DESTINATION BREAKDOWN:");
    for (const [src, dstMap] of Object.entries(summary.sourceToDestinationCounts)) {
      const parts = Object.entries(dstMap).map(([d, c]) => `${d}=${c}`).join(", ");
      console.log(`  • @${src} -> ${parts}`);
    }
    console.log("==================================================\n");
  }).catch(err => {
    console.error("Stage 3 execution error:", err.message);
    process.exit(1);
  });
}

module.exports = {
  TelegramContentClassifier,
  normalizeText,
  extractTokens,
  loadRoutingConfig,
  runLiveStage3Classification
};
