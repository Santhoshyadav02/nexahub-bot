/**
 * korean_caption_generator.js
 * 
 * NexaHub Korean Caption Generator & Routing Pipeline (Stage 4 - DRY RUN ONLY)
 * 
 * Generates concise 1-2 line Korean captions using only available metadata.
 * If metadata is missing or blank, safely uses generic Korean fallback captions
 * without hallucinating scene details, actors, or actions.
 * 
 * SAFETY CONSTRAINTS:
 * - 100% DRY RUN ONLY.
 * - No media downloading.
 * - No publishing, sending, or copying to Telegram channels.
 * - No modifications to production files (index.js, scraper.js, etc.).
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const { TelegramContentClassifier } = require("./telegram_content_classifier");

const captionTranslationCache = new Map();

const FALLBACK_FILE = path.join(__dirname, "korean_fallback_captions.json");

function loadFallbackCaptions() {
  if (fs.existsSync(FALLBACK_FILE)) {
    try {
      const raw = fs.readFileSync(FALLBACK_FILE, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.captions) && parsed.captions.length > 0) {
        return parsed.captions;
      }
    } catch (e) {
      console.warn("⚠️ Could not parse korean_fallback_captions.json, using built-in defaults.");
    }
  }
  return [
    "🎬 새로운 영상이 업데이트되었습니다.\n📌 지금 바로 감상해보세요.",
    "🎬 신규 추천 영상입니다.\n📌 고화질로 감상해보세요.",
    "🎬 업데이트된 영상 콘텐츠입니다.\n📌 지금 확인해보세요."
  ];
}

const GENERIC_KOREAN_FALLBACKS = loadFallbackCaptions();

class FallbackCaptionSelector {
  constructor(captions = GENERIC_KOREAN_FALLBACKS) {
    this.captions = captions && captions.length > 0 ? captions : GENERIC_KOREAN_FALLBACKS;
    this.lastSelected = null;
    this.recentHistory = [];
    this.maxHistory = 15;
  }

  /**
   * Deterministic / seeded selection based on key string or messageId
   * @param {string|number} [seedKey] 
   * @returns {string}
   */
  selectCaption(seedKey = null) {
    if (!this.captions || this.captions.length === 0) {
      return "🎬 새로운 영상이 업데이트되었습니다.\n📌 지금 확인해보세요.";
    }

    let idx = 0;
    if (seedKey !== null && seedKey !== undefined) {
      let hash = 0;
      const str = String(seedKey);
      for (let i = 0; i < str.length; i++) {
        hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
      }
      idx = hash % this.captions.length;
    } else {
      idx = Math.floor(Math.random() * this.captions.length);
    }

    let selected = this.captions[idx];

    // Avoid consecutive repeats
    if (selected === this.lastSelected && this.captions.length > 1) {
      idx = (idx + 1) % this.captions.length;
      selected = this.captions[idx];
    }

    this.lastSelected = selected;
    this.recentHistory.push(selected);
    if (this.recentHistory.length > this.maxHistory) {
      this.recentHistory.shift();
    }

    return selected;
  }
}

const defaultSelector = new FallbackCaptionSelector(GENERIC_KOREAN_FALLBACKS);

/**
 * Detect language of raw text
 * @param {string} text 
 * @returns {"ko"|"ja"|"zh"|"en"}
 */
function detectSourceLanguage(text) {
  if (!text || typeof text !== "string") return "en";
  if (/[\uAC00-\uD7AF\u1100-\u11FF]/.test(text)) return "ko";
  if (/[\u1000-\u109F]/.test(text)) return "my";
  if (/[\u0E00-\u0E7F]/.test(text)) return "th";
  if (/[\u1780-\u17FF]/.test(text)) return "km";
  if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) return "ja";
  if (/[\u4E00-\u9FFF]/.test(text)) return "zh";
  return "en";
}

/**
 * Cleans boilerplate promo text and external URLs from raw captions
 * NEVER deletes multilingual content (English, Chinese, Japanese, Korean, Burmese, Thai, etc.)
 * @param {string} rawText 
 * @returns {string}
 */
function cleanRawCaption(rawText) {
  if (!rawText || typeof rawText !== "string") return "";

  let cleaned = rawText
    // Remove URLs
    .replace(/https?:\/\/[^\s]+/gi, "")
    .replace(/t\.me\/[^\s]+/gi, "")
    // Remove Telegram badges, channel promos & decorative elements
    .replace(/🔰[^🔰\r\n]*🔰/gi, "")
    .replace(/[▰▱■□▲▼▶►★☆✦✧»«]+/g, "")
    .replace(/\bHD\b/gi, "")
    // Remove joining / external instructions
    .replace(/To join.*$/gim, "")
    .replace(/WATCH FULL VIDEOS.*$/gim, "")
    .replace(/📱\s*[\w\d_]+/g, "")
    .replace(/👉.*$/gim, "")
    .replace(/👇.*$/gim, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned;
}

/**
 * Translates source text into natural Korean
 * @param {string} text 
 * @returns {Promise<string>}
 */
async function translateToKorean(text) {
  if (!text || typeof text !== "string") return "";
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";

  const lang = detectSourceLanguage(trimmed);
  if (lang === "ko") return trimmed;

  const cacheKey = `ko:${trimmed}`;
  if (captionTranslationCache.has(cacheKey)) {
    return captionTranslationCache.get(cacheKey);
  }

  // Truncate to reasonable title length for translation APIs
  const cleanForTranslation = trimmed.length > 180 ? trimmed.substring(0, 180).trim() : trimmed;

  // Helper to validate clean translated text
  const isValidTranslation = (t) => {
    if (!t || typeof t !== "string") return false;
    const upper = t.toUpperCase();
    if (upper.includes("MYMEMORY") || upper.includes("QUERY LENGTH") || upper.includes("LIMIT EXCEEDED") ||
        upper.includes("INVALID") || upper.includes("QUOTA") || upper.includes("NO QUERY SPECIFIED") ||
        upper.includes("PLEASE SELECT") || upper.includes("FAILED TO")) {
      return false;
    }
    return t !== cleanForTranslation;
  };

  // Tier 1: Google translation endpoint (handles all languages including Burmese, Thai, Chinese, Japanese, English)
  try {
    const gUrl = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=ko&q=${encodeURIComponent(cleanForTranslation)}`;
    const gRes = await new Promise((resolve) => {
      const req = https.get(gUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
        timeout: 4000
      }, (r) => {
        let data = "";
        r.on("data", c => (data += c));
        r.on("end", () => {
          try {
            const p = JSON.parse(data);
            if (Array.isArray(p) && p[0] && typeof p[0] === "string") {
              const t = p[0].trim();
              if (isValidTranslation(t)) {
                resolve(t);
                return;
              }
            } else if (typeof p === "string" && isValidTranslation(p.trim())) {
              resolve(p.trim());
              return;
            }
            resolve(null);
          } catch (e) {
            resolve(null);
          }
        });
      });
      req.on("error", () => resolve(null));
      req.on("timeout", () => {
        req.destroy();
        resolve(null);
      });
    });

    if (gRes && gRes.length > 0 && gRes !== cleanForTranslation) {
      captionTranslationCache.set(cacheKey, gRes);
      return gRes;
    }
  } catch (err) {}

  // Tier 2: MyMemory API with source language pair
  try {
    const pair = `${lang}|ko`;
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(cleanForTranslation)}&langpair=${pair}`;
    const res = await new Promise((resolve) => {
      const req = https.get(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
        timeout: 4000
      }, (r) => {
        let data = "";
        r.on("data", c => (data += c));
        r.on("end", () => {
          try {
            const p = JSON.parse(data);
            if (p && p.responseData && p.responseData.translatedText) {
              const t = p.responseData.translatedText.trim();
              if (isValidTranslation(t)) {
                resolve(t);
                return;
              }
            }
            resolve(null);
          } catch (e) {
            resolve(null);
          }
        });
      });
      req.on("error", () => resolve(null));
      req.on("timeout", () => {
        req.destroy();
        resolve(null);
      });
    });

    if (res && res.length > 0) {
      captionTranslationCache.set(cacheKey, res);
      return res;
    }
  } catch (err) {}

  // Fallback: Cache and return clean original text
  captionTranslationCache.set(cacheKey, cleanForTranslation);
  return cleanForTranslation;
}

/**
 * Translates/formats clean title into a concise 1-2 line Korean caption
 * @param {string} cleanTitle 
 * @param {string} [categoryName] 
 * @returns {string}
 */
function formatKoreanCaptionFromMetadata(cleanTitle, categoryName = "") {
  if (!cleanTitle || cleanTitle.length < 2) {
    return defaultSelector.selectCaption();
  }

  // Truncate title if overly long
  const maxTitleLen = 65;
  let truncatedTitle = cleanTitle.length > maxTitleLen 
    ? cleanTitle.substring(0, maxTitleLen - 3) + "..." 
    : cleanTitle;

  const categoryTag = categoryName && categoryName !== "UNCLASSIFIED" ? `[${categoryName}] ` : "";

  return `🎬 ${categoryTag}${truncatedTitle}\n📌 고화질 영상으로 감상해보세요.`;
}

/**
 * Generate Korean caption for a video item (Synchronous fallback)
 * @param {object} item 
 * @param {object} [classificationDecision] 
 * @param {FallbackCaptionSelector} [selector]
 * @returns {object}
 */
function generateKoreanCaption(item, classificationDecision = null, selector = defaultSelector) {
  const rawCaption = item.caption || item.text || item.captionPreview || "";
  const rawTitle = item.title || "";
  
  let combined = rawCaption;
  if (rawTitle && !rawCaption.includes(rawTitle)) {
    combined = `${rawTitle} ${rawCaption}`.trim();
  } else if (!rawCaption && rawTitle) {
    combined = rawTitle;
  }

  const cleaned = cleanRawCaption(combined);
  const categoryName = classificationDecision ? classificationDecision.matchedCategory : "";

  // Check if meaningful metadata exists after stripping promo text/URLs
  const hasSubstantialText = cleaned.length >= 2 && !/^(hd|1080p|mp4|video|720p|vip)$/i.test(cleaned);

  if (hasSubstantialText) {
    // Check if translated text exists in cache
    const cacheKey = `ko:${cleaned}`;
    const displayTitle = captionTranslationCache.has(cacheKey) ? captionTranslationCache.get(cacheKey) : cleaned;
    const koreanCaption = formatKoreanCaptionFromMetadata(displayTitle, categoryName);
    return {
      generatedKoreanCaption: koreanCaption,
      captionSource: "source_metadata",
      cleanedMetadata: cleaned,
      translatedMetadata: displayTitle
    };
  } else {
    // Select from 300 fallback captions pool with anti-consecutive duplicate prevention
    const seed = `${item.sourceChannelId || "0"}:${item.messageId || item.id || "0"}`;
    const fallbackCaption = selector.selectCaption(seed);

    return {
      generatedKoreanCaption: fallbackCaption,
      captionSource: "generic_fallback",
      cleanedMetadata: "",
      translatedMetadata: ""
    };
  }
}

/**
 * Asynchronously generates natural Korean caption with online translation
 * @param {object} item 
 * @param {object} [classificationDecision] 
 * @param {FallbackCaptionSelector} [selector]
 * @returns {Promise<object>}
 */
async function generateKoreanCaptionAsync(item, classificationDecision = null, selector = defaultSelector) {
  const rawCaption = item.caption || item.text || item.captionPreview || "";
  const rawTitle = item.title || "";
  
  let combined = rawCaption;
  if (rawTitle && !rawCaption.includes(rawTitle)) {
    combined = `${rawTitle} ${rawCaption}`.trim();
  } else if (!rawCaption && rawTitle) {
    combined = rawTitle;
  }

  const cleaned = cleanRawCaption(combined);
  const categoryName = classificationDecision ? classificationDecision.matchedCategory : "";

  const hasSubstantialText = cleaned.length >= 2 && !/^(hd|1080p|mp4|video|720p|vip)$/i.test(cleaned);

  if (hasSubstantialText) {
    const translatedText = await translateToKorean(cleaned);
    const koreanCaption = formatKoreanCaptionFromMetadata(translatedText, categoryName);
    return {
      generatedKoreanCaption: koreanCaption,
      captionSource: "source_metadata",
      cleanedMetadata: cleaned,
      translatedMetadata: translatedText
    };
  } else {
    const seed = `${item.sourceChannelId || "0"}:${item.messageId || item.id || "0"}`;
    const fallbackCaption = selector.selectCaption(seed);

    return {
      generatedKoreanCaption: fallbackCaption,
      captionSource: "generic_fallback",
      cleanedMetadata: "",
      translatedMetadata: ""
    };
  }
}

class KoreanCaptionPipeline {
  /**
   * @param {object} [classifier] 
   * @param {FallbackCaptionSelector} [selector]
   */
  constructor(classifier = null, selector = null) {
    this.classifier = classifier || new TelegramContentClassifier();
    this.selector = selector || new FallbackCaptionSelector();
  }

  /**
   * Process a single video item: classify and generate Korean caption
   * @param {object} item 
   * @returns {object}
   */
  processVideo(item) {
    const classification = this.classifier.classify(item);
    const captionResult = generateKoreanCaption(item, classification, this.selector);

    return {
      sourceChannelId: String(item.sourceChannelId || "unknown"),
      sourceUsername: item.sourceUsername || "",
      messageId: String(item.messageId || item.id || "0"),
      groupedId: item.groupedId ? String(item.groupedId) : null,
      originalCaption: item.caption || item.text || "",
      generatedKoreanCaption: captionResult.generatedKoreanCaption,
      captionSource: captionResult.captionSource,
      destinationChannelId: classification.destinationChannelId,
      matchedCategory: classification.matchedCategory,
      confidence: classification.confidence,
      duplicate: Boolean(classification.duplicate)
    };
  }

  /**
   * Process a batch of video items
   * @param {Array<object>} items 
   * @returns {object}
   */
  processBatch(items = []) {
    const summary = {
      totalVideos: items.length,
      captionFromSource: 0,
      genericFallback: 0,
      koreanGenerated: 0,
      unclassifiedRouting: 0,
      destinationDistribution: {
        DESTINATION_1: 0,
        DESTINATION_2: 0,
        DESTINATION_3: 0,
        DESTINATION_4: 0,
        DESTINATION_5: 0,
        DESTINATION_6: 0,
        DESTINATION_7: 0,
        DESTINATION_8: 0,
        DESTINATION_9: 0,
        DESTINATION_10: 0
      },
      channelBreakdown: {},
      decisions: []
    };

    for (const item of items) {
      const record = this.processVideo(item);
      summary.decisions.push(record);

      if (record.duplicate) continue;

      summary.koreanGenerated++;

      if (record.captionSource === "source_metadata") {
        summary.captionFromSource++;
      } else {
        summary.genericFallback++;
      }

      if (!record.destinationChannelId || record.confidence === "UNCLASSIFIED") {
        summary.unclassifiedRouting++;
      } else if (summary.destinationDistribution[record.destinationChannelId] !== undefined) {
        summary.destinationDistribution[record.destinationChannelId]++;
      }

      const src = record.sourceUsername || record.sourceChannelId;
      if (!summary.channelBreakdown[src]) {
        summary.channelBreakdown[src] = {
          total: 0,
          fromSource: 0,
          generic: 0,
          destinations: {}
        };
      }
      summary.channelBreakdown[src].total++;
      if (record.captionSource === "source_metadata") {
        summary.channelBreakdown[src].fromSource++;
      } else {
        summary.channelBreakdown[src].generic++;
      }

      const dst = record.destinationChannelId || "UNCLASSIFIED";
      summary.channelBreakdown[src].destinations[dst] = (summary.channelBreakdown[src].destinations[dst] || 0) + 1;
    }

    return summary;
  }
}

/**
 * Execute live Stage 4 caption generation dry run
 */
async function runLiveStage4Pipeline() {
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
  console.log("🚀 NEXAHUB — STAGE 4 KOREAN CAPTION & ROUTING DRY RUN");
  console.log("==================================================");
  console.log("📡 Connecting MTProto client (READ-ONLY)...");
  await client.connect();
  console.log("✅ MTProto client: CONNECTED\n");

  const pipeline = new KoreanCaptionPipeline();
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

  const summary = pipeline.processBatch(allVideoItems);
  return summary;
}

if (require.main === module) {
  runLiveStage4Pipeline().then(summary => {
    console.log("==================================================");
    console.log("📊 STAGE 4 DRY RUN REPORT");
    console.log("==================================================");
    console.log(`TOTAL VIDEOS:            ${summary.totalVideos}`);
    console.log(`CAPTION FROM SOURCE:     ${summary.captionFromSource}`);
    console.log(`KOREAN GENERATED:        ${summary.koreanGenerated}`);
    console.log(`GENERIC FALLBACK:        ${summary.genericFallback}`);
    console.log(`UNCLASSIFIED ROUTING:    ${summary.unclassifiedRouting}`);
    console.log("--------------------------------------------------");
    console.log("DESTINATION DISTRIBUTION:");
    for (const [dest, count] of Object.entries(summary.destinationDistribution)) {
      console.log(`  ${dest}: ${count}`);
    }
    console.log("==================================================\n");
  }).catch(err => {
    console.error("Stage 4 execution error:", err.message);
    process.exit(1);
  });
}

module.exports = {
  KoreanCaptionPipeline,
  generateKoreanCaption,
  generateKoreanCaptionAsync,
  translateToKorean,
  detectSourceLanguage,
  cleanRawCaption,
  formatKoreanCaptionFromMetadata,
  FallbackCaptionSelector,
  loadFallbackCaptions,
  GENERIC_KOREAN_FALLBACKS,
  runLiveStage4Pipeline
};
