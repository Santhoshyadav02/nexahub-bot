/**
 * telegram_source_router.js
 * 
 * NexaHub Telegram Source Routing Engine (Stage 2 - DRY RUN ONLY)
 * 
 * Inspects Telegram message metadata from source channels and calculates
 * deterministic routing decisions to destination placeholders (DESTINATION_1 ... DESTINATION_10).
 * 
 * SAFETY CONSTRAINTS:
 * - 100% DRY-RUN ONLY.
 * - No media downloading.
 * - No publishing or forwarding to destination channels.
 * - No modifications to production bot files or UI.
 */

const DEFAULT_ROUTING_CONFIG = {
  sources: {
    "1762071168": {
      destinationChannelId: "DESTINATION_1",
      enabled: true,
      username: "korea18movie",
      name: "korea 18+ movie"
    },
    "1871127271": {
      destinationChannelId: "DESTINATION_2",
      enabled: true,
      username: "Korea_Japanese_Adult",
      name: "Korean Japanese 18 Adult movies"
    },
    "1518888395": {
      destinationChannelId: "DESTINATION_3",
      enabled: true,
      username: "koreannarchive",
      name: "Korean Archive 🔞 🇰🇷"
    },
    "2182873758": {
      destinationChannelId: "DESTINATION_4",
      enabled: true,
      username: "koreannarchivereal",
      name: "Korean Archive 🇰🇷"
    },
    "3674181298": {
      destinationChannelId: "DESTINATION_5",
      enabled: true,
      username: "DSDSZY4",
      name: "袋鼠大叔-国产丨探花丨主播"
    },
    "1521978999": {
      destinationChannelId: "DESTINATION_6",
      enabled: true,
      username: "xuexiziliao2",
      name: "onlyfans推特分享"
    },
    "2604815578": {
      destinationChannelId: "DESTINATION_7",
      enabled: true,
      username: "madougirl",
      name: "🫦91|麻豆|国产|反差|海角🫦"
    },
    "3832681538": {
      destinationChannelId: "PENDING_CLASSIFICATION",
      enabled: false,
      username: "wanwu5555",
      name: "玩物直播❤️悄玩圈❤️调教分享",
      protected: true
    },
    "2692321761": {
      destinationChannelId: "DYNAMIC_ROUND_ROBIN",
      enabled: true,
      username: "sarte",
      name: "你有一条新的资源"
    },
    "1488881373": {
      destinationChannelId: "DYNAMIC_ROUND_ROBIN",
      enabled: true,
      username: "AV688",
      name: "AV收藏|优质精选|无码破解|中文字幕|番号磁力大全"
    },
    "3660280317": {
      destinationChannelId: "DYNAMIC_ROUND_ROBIN",
      enabled: true,
      username: "haosheba",
      name: "好色吧️🔥投稿反差母狗少萝"
    },
    "1221817437": {
      destinationChannelId: "DYNAMIC_ROUND_ROBIN",
      enabled: true,
      username: "rb666",
      name: "马来西亚吉隆坡修车好评榜"
    },
    "3863302915": {
      destinationChannelId: "DYNAMIC_ROUND_ROBIN",
      enabled: true,
      username: "xgjdads",
      name: "性感丝袜无码绿帽人妻足控"
    },
    "1843566426": {
      destinationChannelId: "DYNAMIC_ROUND_ROBIN",
      enabled: true,
      username: "anji88188",
      name: "湖州妙妙屋甄选中心"
    }
  }
};

const SOURCE_CHANNELS_LIST = [
  { num: 1, id: "1762071168", username: "korea18movie", url: "https://t.me/korea18movie" },
  { num: 2, id: "1871127271", username: "Korea_Japanese_Adult", url: "https://t.me/Korea_Japanese_Adult" },
  { num: 3, id: "1518888395", username: "koreannarchive", url: "https://t.me/koreannarchive" },
  { num: 4, id: "2182873758", username: "koreannarchivereal", url: "https://t.me/koreannarchivereal" },
  { num: 5, id: "3674181298", username: "DSDSZY4", url: "https://t.me/DSDSZY4" },
  { num: 6, id: "1521978999", username: "xuexiziliao2", url: "https://t.me/xuexiziliao2" },
  { num: 7, id: "2604815578", username: "madougirl", url: "https://t.me/madougirl" },
  { num: 8, id: "3832681538", username: "wanwu5555", url: "https://t.me/wanwu5555" },
  { num: 9, id: "2692321761", username: "sarte", url: "https://t.me/sarte" },
  { num: 10, id: "1488881373", username: "AV688", url: "https://t.me/AV688" },
  { num: 11, id: "3660280317", username: "haosheba", url: "https://t.me/haosheba" },
  { num: 12, id: "1221817437", username: "rb666", url: "https://t.me/rb666" },
  { num: 13, id: "3863302915", username: "xgjdads", url: "https://t.me/xgjdads" },
  { num: 14, id: "1843566426", username: "anji88188", url: "https://t.me/anji88188" }
];

/**
 * Generate a deterministic stable source identity
 * @param {string|number} sourceChannelId 
 * @param {string|number} messageId 
 * @returns {string}
 */
function generateSourceIdentity(sourceChannelId, messageId) {
  if (!sourceChannelId || !messageId) {
    throw new Error("generateSourceIdentity requires both sourceChannelId and messageId");
  }
  return `${String(sourceChannelId)}:${String(messageId)}`;
}

/**
 * Extract media metadata from raw Telegram message object
 * @param {object} msg 
 * @returns {object}
 */
function extractMediaMetadata(msg) {
  if (!msg || typeof msg !== "object") {
    return {
      isVideo: false,
      mediaType: "none",
      hasCaption: false,
      captionPreview: "",
      groupedId: null,
      date: null
    };
  }

  let mediaType = "none";
  let isVideo = false;

  if (msg.video) {
    mediaType = "video";
    isVideo = true;
  } else if (msg.photo) {
    mediaType = "photo";
    isVideo = false;
  } else if (msg.document) {
    const mime = (msg.document.mimeType || "").toLowerCase();
    if (mime.includes("video") || mime.endsWith("/mp4") || mime.endsWith("/mkv") || mime.endsWith("/quicktime")) {
      mediaType = "video";
      isVideo = true;
    } else {
      mediaType = "document";
      isVideo = false;
    }
  } else if (msg.webPage) {
    mediaType = "webpage";
    isVideo = false;
  } else if (msg.media) {
    mediaType = "other_media";
    isVideo = false;
  } else {
    mediaType = "text";
    isVideo = false;
  }

  const rawText = msg.message || msg.text || "";
  const hasCaption = Boolean(rawText && rawText.trim().length > 0);
  const captionPreview = hasCaption ? rawText.replace(/[\r\n]+/g, " ").trim().slice(0, 60) : "";

  let isoDate = null;
  if (msg.date) {
    if (typeof msg.date === "number") {
      isoDate = new Date(msg.date * 1000).toISOString();
    } else if (msg.date instanceof Date) {
      isoDate = msg.date.toISOString();
    } else if (typeof msg.date === "string") {
      isoDate = new Date(msg.date).toISOString();
    }
  }

  const groupedId = msg.groupedId ? String(msg.groupedId) : (msg.grouped_id ? String(msg.grouped_id) : null);

  return {
    isVideo,
    mediaType,
    hasCaption,
    captionPreview,
    groupedId,
    date: isoDate
  };
}

class TelegramSourceRouter {
  /**
   * @param {object} [config] 
   * @param {Set<string>} [seenIdentities] 
   */
  constructor(config = DEFAULT_ROUTING_CONFIG, seenIdentities = new Set()) {
    this.config = config && config.sources ? config : DEFAULT_ROUTING_CONFIG;
    this.seenIdentities = seenIdentities;
  }

  /**
   * Evaluates routing decision for a single message without downloading or sending
   * @param {string|number} sourceChannelId 
   * @param {string} sourceUsername 
   * @param {object} rawMessage 
   * @returns {object}
   */
  evaluateMessage(sourceChannelId, sourceUsername, rawMessage) {
    if (!rawMessage || !rawMessage.id) {
      return {
        status: "INVALID_MESSAGE",
        action: "SKIP",
        reason: "Message object missing or lacks id",
        record: null
      };
    }

    const channelKey = String(sourceChannelId);
    const sourceConfig = this.config.sources[channelKey];

    const messageId = String(rawMessage.id);
    const sourceIdentity = generateSourceIdentity(channelKey, messageId);
    const meta = extractMediaMetadata(rawMessage);

    // 1. Unknown Source Check
    if (!sourceConfig) {
      return {
        status: "IGNORED_UNKNOWN_SOURCE",
        action: "SKIP",
        reason: `Source channel ID ${channelKey} is not in routing configuration`,
        sourceIdentity,
        record: null
      };
    }

    // 2. Disabled Source Check
    if (!sourceConfig.enabled) {
      return {
        status: "IGNORED_DISABLED_SOURCE",
        action: "SKIP",
        reason: `Source channel ID ${channelKey} is disabled in routing configuration`,
        sourceIdentity,
        record: null
      };
    }

    // 3. Invalid Destination Check
    if (!sourceConfig.destinationChannelId || typeof sourceConfig.destinationChannelId !== "string" || !sourceConfig.destinationChannelId.trim()) {
      return {
        status: "ERROR_INVALID_DESTINATION",
        action: "ERROR",
        reason: `Source channel ID ${channelKey} has an invalid destinationChannelId`,
        sourceIdentity,
        record: null
      };
    }

    // 4. Media Type Filter (Videos only)
    if (!meta.isVideo) {
      return {
        status: "SKIPPED_NON_VIDEO",
        action: "SKIP",
        reason: `Media type is ${meta.mediaType}, not video`,
        sourceIdentity,
        mediaType: meta.mediaType,
        record: null
      };
    }

    // 5. Duplicate Detection
    if (this.seenIdentities.has(sourceIdentity)) {
      const duplicateRecord = {
        sourceChannelId: channelKey,
        sourceUsername: sourceUsername || sourceConfig.username || "",
        messageId: messageId,
        groupedId: meta.groupedId,
        date: meta.date,
        mediaType: meta.mediaType,
        hasCaption: meta.hasCaption,
        captionPreview: meta.captionPreview,
        destinationChannelId: sourceConfig.destinationChannelId,
        duplicate: true
      };

      return {
        status: "SKIPPED_DUPLICATE",
        action: "SKIP",
        reason: `Source identity ${sourceIdentity} has already been processed`,
        sourceIdentity,
        record: duplicateRecord
      };
    }

    // Register identity
    this.seenIdentities.add(sourceIdentity);

    // 6. Valid Video Normalized Record
    const normalizedRecord = {
      sourceChannelId: channelKey,
      sourceUsername: sourceUsername || sourceConfig.username || "",
      messageId: messageId,
      groupedId: meta.groupedId,
      date: meta.date,
      mediaType: meta.mediaType,
      hasCaption: meta.hasCaption,
      captionPreview: meta.captionPreview,
      destinationChannelId: sourceConfig.destinationChannelId,
      duplicate: false
    };

    return {
      status: "ROUTED_DRY_RUN",
      action: "DRY_RUN_ONLY",
      sourceIdentity,
      destination: sourceConfig.destinationChannelId,
      record: normalizedRecord
    };
  }

  /**
   * Processes a batch of raw messages for a source channel
   * @param {string|number} sourceChannelId 
   * @param {string} sourceUsername 
   * @param {Array<object>} messages 
   * @returns {object}
   */
  processBatch(sourceChannelId, sourceUsername, messages = []) {
    const results = {
      sourceChannelId: String(sourceChannelId),
      sourceUsername: sourceUsername || "",
      totalMessages: messages.length,
      videoMessages: 0,
      nonVideoMessages: 0,
      duplicates: 0,
      groupedAlbums: new Set(),
      groupedMessageCount: 0,
      routedRecords: [],
      evaluations: []
    };

    for (const msg of messages) {
      const evalResult = this.evaluateMessage(sourceChannelId, sourceUsername, msg);
      results.evaluations.push(evalResult);

      const meta = extractMediaMetadata(msg);
      if (meta.groupedId) {
        results.groupedAlbums.add(meta.groupedId);
        results.groupedMessageCount++;
      }

      if (evalResult.status === "ROUTED_DRY_RUN") {
        results.videoMessages++;
        results.routedRecords.push(evalResult.record);
      } else if (evalResult.status === "SKIPPED_DUPLICATE") {
        results.duplicates++;
      } else if (evalResult.status === "SKIPPED_NON_VIDEO") {
        results.nonVideoMessages++;
      }
    }

    results.groupedAlbumsCount = results.groupedAlbums.size;
    results.groupedAlbums = Array.from(results.groupedAlbums);

    return results;
  }
}

/**
 * Execute live dry-run against the 7 Telegram source channels
 */
async function runLiveDryRunDiscovery() {
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
  console.log("🚀 NEXAHUB — STAGE 2 SOURCE ROUTING DRY RUN");
  console.log("==================================================");
  console.log("📡 Connecting MTProto client (READ-ONLY)...");
  await client.connect();
  console.log("✅ MTProto client: CONNECTED\n");

  const router = new TelegramSourceRouter(DEFAULT_ROUTING_CONFIG);
  const overallSummary = {
    totalSourceChannels: SOURCE_CHANNELS_LIST.length,
    accessibleSources: 0,
    totalMessagesChecked: 0,
    totalVideoMessages: 0,
    totalNonVideoMessages: 0,
    totalGroupedAlbums: 0,
    totalDuplicates: 0,
    routingDecisions: [],
    channelReports: []
  };

  const allAlbumIds = new Set();

  for (const src of SOURCE_CHANNELS_LIST) {
    console.log(`--------------------------------------------------`);
    console.log(`[${src.num}/7] Evaluating Source: @${src.username} (ID: ${src.id})`);
    console.log(`--------------------------------------------------`);

    try {
      const entity = await client.getEntity(src.username);
      const actualId = entity.id ? entity.id.toString() : src.id;
      const messages = await client.getMessages(entity, { limit: 40 });

      overallSummary.accessibleSources++;
      overallSummary.totalMessagesChecked += messages.length;

      const batchResult = router.processBatch(actualId, src.username, messages);

      overallSummary.totalVideoMessages += batchResult.videoMessages;
      overallSummary.totalNonVideoMessages += batchResult.nonVideoMessages;
      overallSummary.totalDuplicates += batchResult.duplicates;

      for (const alb of batchResult.groupedAlbums) {
        allAlbumIds.add(alb);
      }

      const dest = DEFAULT_ROUTING_CONFIG.sources[actualId]
        ? DEFAULT_ROUTING_CONFIG.sources[actualId].destinationChannelId
        : "UNKNOWN_DESTINATION";

      console.log(`   ✅ Accessible: YES | Messages: ${messages.length}`);
      console.log(`   🎬 Videos: ${batchResult.videoMessages} | Non-Videos: ${batchResult.nonVideoMessages} | Albums: ${batchResult.groupedAlbumsCount}`);
      console.log(`   🎯 Routing Target: ${dest}`);
      console.log(`   ⚡ Action: DRY_RUN_ONLY (0 published, 0 downloaded)`);

      // Print first 2 routed samples
      const samples = batchResult.routedRecords.slice(0, 2);
      for (const sample of samples) {
        console.log(`      • SOURCE @${src.username} msg ${sample.messageId} | video: YES | destination: ${sample.destinationChannelId} | action: DRY_RUN_ONLY`);
      }

      overallSummary.routingDecisions.push({
        sourceNumber: src.num,
        sourceUsername: src.username,
        sourceChannelId: actualId,
        destinationChannelId: dest,
        videosRouted: batchResult.videoMessages,
        nonVideosSkipped: batchResult.nonVideoMessages,
        status: "ROUTED_DRY_RUN"
      });

      overallSummary.channelReports.push(batchResult);

    } catch (err) {
      console.warn(`   ⚠️ Channel evaluation error: ${err.message}`);
      overallSummary.routingDecisions.push({
        sourceNumber: src.num,
        sourceUsername: src.username,
        sourceChannelId: src.id,
        destinationChannelId: "ERROR",
        videosRouted: 0,
        nonVideosSkipped: 0,
        status: `ERROR: ${err.message}`
      });
    }
  }

  overallSummary.totalGroupedAlbums = allAlbumIds.size;

  await client.disconnect();
  console.log("\n📡 MTProto client disconnected.");

  return overallSummary;
}

if (require.main === module) {
  runLiveDryRunDiscovery().then(summary => {
    console.log("\n==================================================");
    console.log("📊 STAGE 2 SOURCE ROUTING DRY RUN SUMMARY");
    console.log("==================================================");
    console.log(`Total source channels:   ${summary.totalSourceChannels}`);
    console.log(`Accessible:              ${summary.accessibleSources}`);
    console.log(`Total messages scanned:  ${summary.totalMessagesChecked}`);
    console.log(`Video messages routed:   ${summary.totalVideoMessages}`);
    console.log(`Non-video messages:      ${summary.totalNonVideoMessages}`);
    console.log(`Grouped albums detected: ${summary.totalGroupedAlbums}`);
    console.log(`Duplicates detected:     ${summary.totalDuplicates}`);
    console.log("--------------------------------------------------");
    console.log("Telegram Publishing:     0");
    console.log("Media Downloads:         0");
    console.log("==================================================\n");
  }).catch(err => {
    console.error("Dry run execution error:", err.message);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_ROUTING_CONFIG,
  SOURCE_CHANNELS_LIST,
  TelegramSourceRouter,
  generateSourceIdentity,
  extractMediaMetadata,
  runLiveDryRunDiscovery
};
