const crypto = require("crypto");
const VideoPipeline = require("./video_pipeline");
const { ChannelPublisher } = require("./channel_publisher");

/**
 * Normalized Content Ingestion Item Schema:
 * {
 *   sourceId: string,          // Identifier of the authorized source/provider
 *   externalId: string,        // Unique item ID in provider's system
 *   topic: string,             // Topic / Category name (e.g. "Romantic Vibe", "Dating", "미얀마")
 *   category: string,          // Optional category classification
 *   title: string,             // Clean sanitized video title
 *   content: string,           // FULL source content / article (retained internally)
 *   channelCaption: string,    // EXACT 1–2 lines concise Telegram-facing caption
 *   videoUrl: string,          // Direct video stream / MP4 URL (must be valid HTTP/HTTPS)
 *   duration: string|null,     // Duration formatted e.g. "2:30"
 *   publishedAt: string        // ISO timestamp
 * }
 */

class ContentIngestionService {
  constructor(options = {}) {
    this.dryRun = options.dryRun !== undefined ? Boolean(options.dryRun) : true;
    this.pipeline = new VideoPipeline({ dryRun: this.dryRun });
    this.publisher = new ChannelPublisher({ dryRun: this.dryRun });
  }

  /**
   * Generates a strict 1–2 line concise Telegram-facing caption.
   * Line 1: 🎬 [Title / Headline]
   * Line 2: [1 concise sentence of relevant context]
   */
  generateChannelCaption(title, content) {
    const line1 = title ? `🎬 ${title.trim()}` : "🎬 관련 주요 영상";

    let line2 = "";
    if (content && typeof content === "string") {
      const cleanContent = content.replace(/<[^>]*>/g, " ").replace(/[\r\n]+/g, " ").trim();
      const firstSentence = cleanContent.split(/[.!?]\s+/)[0] || "";
      if (firstSentence && firstSentence.length > 5 && firstSentence !== title) {
        line2 = firstSentence.length > 90 ? firstSentence.substring(0, 87) + "..." : firstSentence;
        if (!line2.endsWith(".")) line2 += ".";
      }
    }

    if (!line2) {
      line2 = "영상과 함께 주요 내용을 확인해보세요.";
    }

    return `${line1}\n${line2}`.trim();
  }

  /**
   * Normalizes and validates a raw ingested item into the strict unified schema.
   * Preserves full content internally while creating a 1–2 line Telegram-facing caption.
   */
  normalizeItem(raw) {
    const errors = [];
    if (!raw || typeof raw !== "object") {
      return { isValid: false, item: null, errors: ["Raw input must be a non-null object"] };
    }

    // 1. Source and External IDs
    const sourceId = String(raw.sourceId || raw.source_id || raw.provider || "authorized_source").trim();
    const externalId = String(raw.externalId || raw.external_id || raw.id || `item_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`).trim();

    // 2. Video URL Validation
    const videoUrl = String(raw.videoUrl || raw.video_url || raw.url || raw.mediaUrl || raw.media_url || "").trim();
    if (!videoUrl || (!videoUrl.startsWith("http://") && !videoUrl.startsWith("https://"))) {
      errors.push("Invalid or missing videoUrl (must start with http:// or https://)");
    }

    // 3. Title Sanitation
    let title = String(raw.title || raw.name || "제목 없음").trim().replace(/[\r\n]+/g, " ");
    if (title.length > 120) {
      title = title.substring(0, 117) + "...";
    }

    // 4. Content / Full Article (Preserved internally for search, indexing, deduplication, auditing)
    const content = String(raw.content || raw.caption || raw.description || raw.text || "").trim();

    // 5. Telegram-Facing Caption: Strictly 1–2 concise lines
    const channelCaption = raw.channelCaption || raw.channel_caption || this.generateChannelCaption(title, content);

    // 6. Topic and Category
    const topic = raw.topic ? String(raw.topic).trim() : null;
    const category = raw.category ? String(raw.category).trim() : null;
    const targetChannel = raw.targetChannel || raw.target_channel || null;
    const channelIndex = (raw.channelIndex !== undefined && raw.channelIndex !== null) 
      ? parseInt(raw.channelIndex, 10) 
      : ((raw.channel_index !== undefined && raw.channel_index !== null) ? parseInt(raw.channel_index, 10) : null);

    // 7. Duration Formatting
    let duration = null;
    if (raw.duration) {
      if (typeof raw.duration === "number") {
        const mins = Math.floor(raw.duration / 60);
        const secs = Math.floor(raw.duration % 60);
        duration = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
      } else {
        duration = String(raw.duration).trim();
      }
    }

    // 8. Timestamp
    const publishedAt = raw.publishedAt || raw.published_at || new Date().toISOString();

    // 9. Deterministic Hash (sourceId + externalId + videoUrl)
    const hashBase = `${sourceId}_${externalId}_${videoUrl}`;
    const hash = crypto.createHash("sha256").update(hashBase).digest("hex");

    if (errors.length > 0) {
      return { isValid: false, item: null, errors };
    }

    const normalized = {
      sourceId,
      externalId,
      hash,
      topic,
      category,
      targetChannel,
      channelIndex,
      title,
      content,           // Full content preserved internally
      channelCaption,    // Strictly 1-2 lines for Telegram publishing
      videoUrl,
      duration,
      publishedAt
    };

    return { isValid: true, item: normalized, errors: [] };
  }

  /**
   * Ingests a single item or an array of raw items, validates, normalizes,
   * routes them via topic-locked priority, and records them in dry-run simulation.
   */
  async ingestContent(rawItems, options = {}) {
    const items = Array.isArray(rawItems) ? rawItems : [rawItems];
    const results = [];

    console.log(`\n==================================================`);
    console.log(`📥 INGESTION LAYER: PROCESSING ${items.length} RAW ITEMS (DRY-RUN: ${this.dryRun})`);
    console.log(`==================================================`);

    for (let i = 0; i < items.length; i++) {
      const raw = items[i];
      const { isValid, item, errors } = this.normalizeItem(raw);

      if (!isValid || !item) {
        console.warn(`⚠️ [INGESTION REJECTED #${i + 1}] Validation Failed: ${errors.join(", ")}`);
        results.push({
          itemIndex: i + 1,
          success: false,
          status: "INVALID_FORMAT",
          errors: errors,
          raw: raw
        });
        continue;
      }

      // Check duplicate against ledger before pipeline dispatch
      if (this.publisher.isAlreadyPublished(item.hash)) {
        console.log(`ℹ️ [INGESTION DUPLICATE #${i + 1}] "${item.title}": Already in ledger (Hash: ${item.hash.substring(0, 8)}).`);
        results.push({
          itemIndex: i + 1,
          externalId: item.externalId,
          title: item.title,
          success: false,
          status: "SKIPPED_DUPLICATE",
          hash: item.hash,
          message: "Item already published in ledger"
        });
        continue;
      }

      // Convert normalized schema to pipeline format with 1-2 line channel caption
      const pipelineItem = {
        source_id: `${item.sourceId}_${item.externalId}`,
        hash: item.hash,
        title: item.title,
        full_content: item.content,
        caption: item.channelCaption, // Exact 1-2 lines for Telegram channel
        video_url: item.videoUrl,
        duration: item.duration,
        target_channel: item.targetChannel,
        channel_index: item.channelIndex,
        category: item.category,
        topic: item.topic
      };

      const dispatchResult = await this.pipeline.processAndDispatch([pipelineItem], {
        dryRun: options.dryRun !== undefined ? options.dryRun : this.dryRun
      });

      const res = dispatchResult[0];
      results.push({
        itemIndex: i + 1,
        sourceId: item.sourceId,
        externalId: item.externalId,
        title: item.title,
        videoUrl: item.videoUrl,
        channelCaption: item.channelCaption,
        topic: item.topic || item.category || "N/A",
        assignedChannel: res.assignedChannel || null,
        channelIndex: res.channelIndex || null,
        channelUsername: res.channelUsername || null,
        success: res.success,
        status: res.status,
        result: res.result
      });
    }

    const acceptedCount = results.filter(r => r.success).length;
    const dupCount = results.filter(r => r.status === "SKIPPED_DUPLICATE").length;
    const unroutableCount = results.filter(r => r.status === "UNROUTABLE").length;
    const invalidCount = results.filter(r => r.status === "INVALID_FORMAT").length;

    console.log(`==================================================`);
    console.log(`📊 INGESTION SUMMARY: ${acceptedCount} accepted/simulated, ${dupCount} duplicates, ${unroutableCount} unroutable, ${invalidCount} invalid format`);
    console.log(`==================================================\n`);

    return results;
  }
}

const instance = new ContentIngestionService();
module.exports = {
  ContentIngestionService,
  instance
};
