/**
 * ============================================================
 * 💾 EXTERNAL SOURCE PERSISTENT STATE & DEDUPE STORE
 * ============================================================
 * Manages persistent state for the isolated external-source pipeline:
 * - Permanent dedupe ledger (never deleted on queue eviction).
 * - Global 150-item rolling retention pool across all 10 channels.
 * - Polling checkpoint timestamps and metrics.
 * - Survives process restarts and deployments via atomic disk persistence.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MAX_GLOBAL_RETENTION = 150;
const DEFAULT_CHANNEL_DAILY_TARGET = 100;
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

class ExternalSourceState {
  /**
   * @param {object} [config]
   * @param {string} [config.stateFilePath] Path to persistent JSON state store
   * @param {number} [config.maxTotalItems=150] Max items in global retention pool
   */
  constructor(config = {}) {
    this.stateFilePath = config.stateFilePath || config.retentionStorePath || path.join(__dirname, "external_source_state.json");
    this.maxTotalItems = config.maxTotalItems || config.maxRetentionPerTopic || MAX_GLOBAL_RETENTION;
    this.externalDailyTarget = config.externalDailyTarget !== undefined ? config.externalDailyTarget : Infinity; // Default: No daily video limit for external source
    this.channelDailyTarget = config.channelDailyTarget || DEFAULT_CHANNEL_DAILY_TARGET;

    // In-memory data structures
    this.records = new Map(); // primary key: sourceItemId, uniqueHash, or deliveryKey -> record object
    this.deliveryLedger = new Map(); // primary key: `${sourcePostId}:${destinationChannelId}` -> delivery record
    this.urlIndex = new Map(); // canonicalUrl -> uniqueHash
    this.retainedPool = []; // Global newest-first retained items (max 150)
    this.candidateQueue = []; // Persistent candidate FIFO queue: [{ sourcePostId, itemId, title, pageUrl, mediaUrl, topicKey, cardNum, channelIndex, destinationChannelId, destinationUsername, discoveredAt, retryCount, nextRetryAt, status }]
    this.roundRobinPointer = 1; // 1 to 10
    this.lastSuccessfulPollAt = null;
    this.lastDiscoveredCount = 0;
    this.totalProcessedCount = 0;
    this.lastSuccessfulDeliveryAt = null;

    // 24-Hour Delivery Quota State (Telegram channels tracking)
    this.windowStartAt = null;
    this.externalDeliveredToday = 0;
    this.channelDeliveriesToday = {}; // { [channelKey]: count }

    this.loadState();
  }

  /**
   * Ensures the 24-hour daily quota window is active and valid.
   * If 24h have passed since windowStartAt, starts a new window and resets daily counters
   * while strictly preserving all historical dedupe records and delivery histories.
   * @param {Date} [now=new Date()]
   * @returns {boolean} Whether a new window was initiated
   */
  ensureDailyWindow(now = new Date()) {
    const currentTime = now.getTime();
    if (!this.windowStartAt) {
      this.windowStartAt = now.toISOString();
      this.externalDeliveredToday = 0;
      this.channelDeliveriesToday = {};
      this.saveState();
      return true;
    }

    const windowStartTime = new Date(this.windowStartAt).getTime();
    if (isNaN(windowStartTime) || (currentTime - windowStartTime >= DAILY_WINDOW_MS)) {
      this.windowStartAt = now.toISOString();
      this.externalDeliveredToday = 0;
      this.channelDeliveriesToday = {};
      this.saveState();
      return true;
    }

    return false;
  }

  /**
   * Returns remaining external quota for the current 24h window
   * @param {Date} [now=new Date()]
   * @returns {number}
   */
  getExternalRemainingQuota(now = new Date()) {
    this.ensureDailyWindow(now);
    return Math.max(0, this.externalDailyTarget - this.externalDeliveredToday);
  }

  /**
   * Returns remaining quota for a specific Telegram source channel
   * @param {string|number} channelKey
   * @param {Date} [now=new Date()]
   * @returns {number}
   */
  getChannelRemainingQuota(channelKey, now = new Date()) {
    this.ensureDailyWindow(now);
    const key = String(channelKey);
    const delivered = this.channelDeliveriesToday[key] || 0;
    return Math.max(0, this.channelDailyTarget - delivered);
  }

  /**
   * Records a successful delivery for the external source
   * @param {object} item Normalized item
   * @param {object} [destination]
   * @returns {object}
   */
  recordExternalDelivery(item, destination = null) {
    this.ensureDailyWindow();
    this.externalDeliveredToday++;

    const sourceItemId = String(item.sourceItemId || item.itemId || item.id || "").trim();
    const uniqueHash = item.uniqueHash || this.generateContentHash(item.sourceId || "ext", sourceItemId, item.canonicalUrl || item.pageUrl || item.mediaUrl);
    const destinationChannel = destination ? destination.destinationChannelId : item.destinationChannel;

    const record = this.recordPermanentItem(item, {
      isDelivered: true,
      deliveredAt: new Date().toISOString(),
      status: "DELIVERED",
      deliverySource: "external",
      destinationChannel: destinationChannel
    });

    this.saveState();
    return {
      success: true,
      externalDeliveredToday: this.externalDeliveredToday,
      remaining: this.getExternalRemainingQuota(),
      record
    };
  }

  /**
   * Records a delivery for an existing Telegram source channel (1-10)
   * @param {string|number} channelKey
   * @param {object} item
   * @returns {object}
   */
  recordTelegramDelivery(channelKey, item) {
    this.ensureDailyWindow();
    const key = String(channelKey);
    const current = this.channelDeliveriesToday[key] || 0;

    if (current >= this.channelDailyTarget) {
      return {
        success: false,
        reason: "CHANNEL_QUOTA_EXCEEDED",
        channel: key,
        current: current,
        target: this.channelDailyTarget
      };
    }

    this.channelDeliveriesToday[key] = current + 1;

    const record = this.recordPermanentItem(item, {
      isDelivered: true,
      deliveredAt: new Date().toISOString(),
      status: "DELIVERED",
      deliverySource: "telegram",
      deliveryChannel: key
    });

    this.saveState();

    console.log(`[TELEGRAM_SOURCE] channel=${key} daily=${this.channelDeliveriesToday[key]}/${this.channelDailyTarget}`);

    return {
      success: true,
      channel: key,
      current: this.channelDeliveriesToday[key],
      target: this.channelDailyTarget,
      remaining: Math.max(0, this.channelDailyTarget - this.channelDeliveriesToday[key]),
      record
    };
  }

  /**
   * Searches discovered items for eligible candidates that have NEVER been delivered
   * @param {number} [limit=15]
   * @returns {Array<object>}
   */
  getNeverDeliveredFallbackCandidates(limit = 15) {
    const candidates = [];
    const seenIds = new Set();

    // Check unique permanent records
    for (const rec of this.records.values()) {
      if (!rec) continue;
      const id = rec.sourceItemId || rec.itemId || rec.uniqueHash;
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);

      // Must be eligible, non-delivered, and have media URL & title
      if (!rec.isDelivered && !rec.deliveredAt && rec.status !== "DELIVERED" && rec.mediaUrl && rec.title) {
        candidates.push({
          sourceItemId: rec.sourceItemId || rec.itemId,
          itemId: rec.itemId || rec.sourceItemId,
          sourceId: rec.sourceId || "external_source",
          uniqueHash: rec.uniqueHash,
          title: rec.title,
          mediaUrl: rec.mediaUrl,
          canonicalUrl: rec.canonicalUrl || rec.pageUrl || rec.mediaUrl,
          publishedAt: rec.publishedAt,
          topicKey: rec.routedTopicKey || rec.topicKey || "General",
          destinationChannel: rec.destinationChannel || null
        });

        if (candidates.length >= limit) break;
      }
    }

    return candidates;
  }

  /**
   * Loads state from disk safely
   */
  loadState() {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const raw = fs.readFileSync(this.stateFilePath, "utf8");
        const parsed = JSON.parse(raw);

        if (parsed && typeof parsed === "object") {
          this.lastSuccessfulPollAt = parsed.lastSuccessfulPollAt || null;
          this.lastDiscoveredCount = parsed.lastDiscoveredCount || 0;
          this.totalProcessedCount = parsed.totalProcessedCount || 0;

          // 24-hour quota state
          this.windowStartAt = parsed.windowStartAt || null;
          this.externalDeliveredToday = typeof parsed.externalDeliveredToday === "number" ? parsed.externalDeliveredToday : 0;
          this.channelDeliveriesToday = (parsed.channelDeliveriesToday && typeof parsed.channelDeliveriesToday === "object") ? parsed.channelDeliveriesToday : {};

          // Round-robin & Queue state
          if (typeof parsed.roundRobinPointer === "number" && parsed.roundRobinPointer >= 1 && parsed.roundRobinPointer <= 10) {
            this.roundRobinPointer = parsed.roundRobinPointer;
          }
          if (Array.isArray(parsed.candidateQueue)) {
            this.candidateQueue = parsed.candidateQueue;
          }
          this.lastSuccessfulDeliveryAt = parsed.lastSuccessfulDeliveryAt || null;

          // Load delivery ledger
          if (Array.isArray(parsed.deliveryLedger)) {
            for (const entry of parsed.deliveryLedger) {
              if (entry && entry.deliveryKey) {
                this.deliveryLedger.set(entry.deliveryKey, entry);
              }
            }
          }

          // Load permanent records
          if (Array.isArray(parsed.records)) {
            for (const rec of parsed.records) {
              if (rec && (rec.sourceItemId || rec.itemId || rec.uniqueHash)) {
                const key = rec.sourceItemId || rec.itemId || rec.uniqueHash;
                this.records.set(key, rec);
                if (rec.uniqueHash && rec.uniqueHash !== key) {
                  this.records.set(rec.uniqueHash, rec);
                }
                if (rec.canonicalUrl) {
                  this.urlIndex.set(this.normalizeUrl(rec.canonicalUrl), rec.uniqueHash || key);
                }
              }
            }
          }

          // Load retained pool
          if (Array.isArray(parsed.retainedPool)) {
            this.retainedPool = parsed.retainedPool.slice(0, this.maxTotalItems);
          }

          // Check window boundary
          this.ensureDailyWindow();
        }
      } else {
        this.ensureDailyWindow();
      }
    } catch (err) {
      console.warn(`⚠️ [EXTERNAL_STATE] Warning loading state from ${this.stateFilePath}: ${err.message}`);
      this.ensureDailyWindow();
    }
  }

  /**
   * Persists state to disk atomically
   */
  saveState() {
    try {
      const dir = path.dirname(this.stateFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Collect unique record list (deduplicating secondary keys)
      const uniqueRecordsMap = new Map();
      for (const rec of this.records.values()) {
        const id = rec.sourceItemId || rec.itemId || rec.uniqueHash;
        if (id) {
          uniqueRecordsMap.set(id, rec);
        }
      }

      const data = {
        version: "4.0.0",
        updatedAt: new Date().toISOString(),
        roundRobinPointer: this.roundRobinPointer,
        candidateQueue: this.candidateQueue,
        lastSuccessfulDeliveryAt: this.lastSuccessfulDeliveryAt,
        deliveryLedger: Array.from(this.deliveryLedger.values()),
        windowStartAt: this.windowStartAt,
        channelDailyTarget: this.channelDailyTarget,
        externalDeliveredToday: this.externalDeliveredToday,
        channelDeliveriesToday: this.channelDeliveriesToday,
        lastSuccessfulPollAt: this.lastSuccessfulPollAt,
        lastDiscoveredCount: this.lastDiscoveredCount,
        totalProcessedCount: this.totalProcessedCount,
        totalPermanentRecords: uniqueRecordsMap.size,
        retainedPoolSize: this.retainedPool.length,
        maxTotalItems: this.maxTotalItems,
        retainedPool: this.retainedPool,
        records: Array.from(uniqueRecordsMap.values())
      };

      const tmpPath = `${this.stateFilePath}.tmp.${Date.now()}`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
      fs.renameSync(tmpPath, this.stateFilePath);
    } catch (err) {
      console.error(`❌ [EXTERNAL_STATE] Error saving state to ${this.stateFilePath}: ${err.message}`);
    }
  }

  /**
   * Normalizes URL for stable index comparison
   * @param {string} url 
   * @returns {string}
   */
  normalizeUrl(url) {
    if (!url || typeof url !== "string") return "";
    return url.trim().toLowerCase().replace(/\/+$/, "");
  }

  /**
   * Generates a deterministic unique hash for an item
   * @param {string} sourceId 
   * @param {string} sourceItemId 
   * @param {string} [canonicalUrl] 
   * @returns {string}
   */
  generateContentHash(sourceId, sourceItemId, canonicalUrl = "") {
    const raw = `${sourceId || "ext"}:${String(sourceItemId).trim()}:${String(canonicalUrl).trim()}`;
    return crypto.createHash("sha256").update(raw, "utf8").digest("hex").substring(0, 32);
  }

  /**
   * Checks if an item has been previously seen/processed in the permanent ledger.
   * Checks primary sourceItemId, canonicalUrl, and contentHash.
   * @param {object} item 
   * @returns {boolean}
   */
  hasSeen(item) {
    if (!item || typeof item !== "object") return false;

    const sourceItemId = String(item.sourceItemId || item.itemId || item.id || "").trim();
    const uniqueHash = item.uniqueHash || (item.sourceId && sourceItemId ? this.generateContentHash(item.sourceId, sourceItemId, item.mediaUrl || item.pageUrl) : null);
    const url = this.normalizeUrl(item.canonicalUrl || item.pageUrl || item.mediaUrl);

    // 1. Primary ID match
    if (sourceItemId && this.records.has(sourceItemId)) {
      return true;
    }

    // 2. Unique Content Hash match
    if (uniqueHash && this.records.has(uniqueHash)) {
      return true;
    }

    // 3. Canonical URL match
    if (url && this.urlIndex.has(url)) {
      return true;
    }

    return false;
  }

  /**
   * Records a processed or ingested item into the permanent dedupe ledger
   * @param {object} item Normalized item
   * @param {object} [extra] Additional metadata
   * @returns {object} Stored record
   */
  recordPermanentItem(item, extra = {}) {
    if (!item) return null;

    const sourceItemId = String(item.sourceItemId || item.itemId || item.id || "").trim();
    const canonicalUrl = item.canonicalUrl || item.pageUrl || item.mediaUrl || null;
    const uniqueHash = item.uniqueHash || this.generateContentHash(item.sourceId || "ext", sourceItemId, canonicalUrl);
    const now = new Date().toISOString();

    const existing = this.records.get(sourceItemId) || this.records.get(uniqueHash);

    const record = {
      sourceItemId: sourceItemId,
      itemId: sourceItemId,
      sourceId: item.sourceId || "external_source",
      canonicalUrl: canonicalUrl,
      uniqueHash: uniqueHash,
      title: item.title || (existing ? existing.title : ""),
      mediaUrl: item.mediaUrl || (existing ? existing.mediaUrl : null),
      firstSeenAt: existing ? existing.firstSeenAt : (item.discoveredAt || now),
      lastSeenAt: now,
      processedAt: existing ? existing.processedAt : (extra.processedAt || now),
      publishedAt: item.publishedAt || (existing ? existing.publishedAt : null),
      isDelivered: extra.isDelivered !== undefined ? Boolean(extra.isDelivered) : (existing ? Boolean(existing.isDelivered) : false),
      deliveredAt: extra.deliveredAt || (existing ? existing.deliveredAt : null),
      deliverySource: extra.deliverySource || (existing ? existing.deliverySource : (extra.isDelivered ? "external" : null)),
      status: extra.status || (existing ? existing.status : (extra.isDelivered ? "DELIVERED" : "DISCOVERED")),
      routedTopicKey: item.topicKey || item.topic || (existing ? existing.routedTopicKey : "General"),
      destinationChannel: extra.destinationChannel || item.destinationChannel || (existing ? existing.destinationChannel : null),
      queuePosition: extra.queuePosition !== undefined ? extra.queuePosition : (existing ? existing.queuePosition : null)
    };

    if (sourceItemId) this.records.set(sourceItemId, record);
    if (uniqueHash) this.records.set(uniqueHash, record);
    if (canonicalUrl) this.urlIndex.set(this.normalizeUrl(canonicalUrl), uniqueHash);

    this.totalProcessedCount++;
    this.saveState();

    return record;
  }

  /**
   * Adds an item to the GLOBAL 150-item rolling retention pool.
   * Newest item is placed at position #1 (index 0).
   * Evicts the 151st item if capacity is exceeded.
   * NOTE: Eviction does NOT delete the permanent dedupe record from this.records!
   * @param {object} item Normalized item
   * @param {object} [destinationInfo] Destination channel metadata
   * @returns {{ position: number, totalRetained: number, evicted: object|null }}
   */
  addToRetentionPool(item, destinationInfo = null) {
    const sourceItemId = String(item.sourceItemId || item.itemId || item.id || "").trim();
    const uniqueHash = item.uniqueHash || this.generateContentHash(item.sourceId || "ext", sourceItemId, item.mediaUrl || item.pageUrl);

    // Remove if already exists in pool (re-indexing to newest)
    const existingIdx = this.retainedPool.findIndex(
      x => x.sourceItemId === sourceItemId || x.itemId === sourceItemId || x.uniqueHash === uniqueHash
    );
    if (existingIdx >= 0) {
      this.retainedPool.splice(existingIdx, 1);
    }

    const poolEntry = {
      sourceItemId: sourceItemId,
      itemId: sourceItemId,
      sourceId: item.sourceId || "external_source",
      uniqueHash: uniqueHash,
      title: item.title,
      mediaUrl: item.mediaUrl,
      canonicalUrl: item.canonicalUrl || item.pageUrl || item.mediaUrl,
      publishedAt: item.publishedAt,
      routedTopicKey: item.topicKey || item.topic || "General",
      destinationChannel: destinationInfo ? destinationInfo.destinationChannelId : null,
      destinationUsername: destinationInfo ? destinationInfo.destinationUsername : null,
      retainedAt: new Date().toISOString()
    };

    // Insert at index 0 (Position #1)
    this.retainedPool.unshift(poolEntry);

    // Enforce GLOBAL MAX_TOTAL_ITEMS (150)
    let evicted = null;
    if (this.retainedPool.length > this.maxTotalItems) {
      evicted = this.retainedPool.pop(); // Evicts oldest item beyond max

      // Update evicted record status in permanent store (DO NOT DELETE RECORD)
      if (evicted && (evicted.sourceItemId || evicted.itemId || evicted.uniqueHash)) {
        const key = evicted.sourceItemId || evicted.itemId || evicted.uniqueHash;
        const rec = this.records.get(key);
        if (rec) {
          rec.status = "EVICTED_FROM_RETAINED_POOL";
          rec.queuePosition = null;
        }
      }
    }

    // Update queue positions for retained pool
    this.retainedPool.forEach((entry, idx) => {
      const rec = this.records.get(entry.sourceItemId) || this.records.get(entry.uniqueHash);
      if (rec) {
        rec.queuePosition = idx + 1;
        rec.status = "RETAINED_IN_POOL";
      }
    });

    this.saveState();

    return {
      position: 1,
      totalRetained: this.retainedPool.length,
      evicted: evicted
    };
  }

  /**
   * Updates polling checkpoint
   * @param {number} discoveredCount 
   */
  updateCheckpoint(discoveredCount) {
    this.lastSuccessfulPollAt = new Date().toISOString();
    this.lastDiscoveredCount = discoveredCount;
    this.saveState();
  }

  /**
   * Returns current retained pool items, optionally filtered by topic
   * @param {string} [topicKey]
   * @returns {Array<object>}
   */
  getRetainedPool(topicKey = null) {
    if (topicKey) {
      return this.retainedPool.filter(x => x.routedTopicKey === topicKey || x.topicKey === topicKey);
    }
    return [...this.retainedPool];
  }

  // ============================================================
  // 🔄 ROUND-ROBIN & DESTINATION-SPECIFIC DEDUPE HELPERS
  // ============================================================

  /**
   * Generates deterministic unique delivery key for destination-specific dedupe.
   * Format: `${sourcePostId}:${destinationChannelId}`
   * @param {string} sourcePostId 
   * @param {string} destinationChannelId 
   * @returns {string}
   */
  getDeliveryKey(sourcePostId, destinationChannelId) {
    const sId = String(sourcePostId || "").trim();
    const dId = String(destinationChannelId || "").trim();
    return `${sId}:${dId}`;
  }

  /**
   * Checks if a source post has already been successfully delivered to a specific destination channel.
   * @param {string} sourcePostId 
   * @param {string} destinationChannelId 
   * @returns {boolean}
   */
  isDeliveredToDestination(sourcePostId, destinationChannelId) {
    if (!sourcePostId || !destinationChannelId) return false;
    const key = this.getDeliveryKey(sourcePostId, destinationChannelId);
    const rec = this.deliveryLedger.get(key);
    return Boolean(rec && rec.status === "DELIVERED");
  }

  /**
   * Records the outcome of a delivery attempt for a specific source-post + destination channel.
   * @param {object} item 
   * @param {string} destinationChannelId 
   * @param {object} [result]
   * @returns {object}
   */
  recordDeliveryResult(item, destinationChannelId, result = {}) {
    const sourceItemId = String(item.sourceItemId || item.itemId || item.id || "").trim();
    const key = this.getDeliveryKey(sourceItemId, destinationChannelId);
    const now = new Date().toISOString();

    const deliveryRecord = {
      deliveryKey: key,
      sourceItemId: sourceItemId,
      itemId: sourceItemId,
      sourceId: item.sourceId || "external_source",
      title: item.title,
      destinationChannelId: destinationChannelId,
      status: result.status || "DELIVERED",
      deliveredAt: result.status === "DELIVERED" ? now : null,
      updatedAt: now,
      telegramMessageId: result.telegramMessageId || null,
      error: result.error || null,
      duration: result.duration || null,
      sizeBytes: result.sizeBytes || null
    };

    this.deliveryLedger.set(key, deliveryRecord);

    if (result.status === "DELIVERED") {
      this.lastSuccessfulDeliveryAt = now;
    }

    // Keep permanent record updated
    this.recordPermanentItem(item, {
      status: result.status || "DELIVERED",
      isDelivered: result.status === "DELIVERED",
      destinationChannel: destinationChannelId,
      deliveredAt: result.status === "DELIVERED" ? now : null,
      telegramMessageId: result.telegramMessageId || null
    });

    this.saveState();
    return deliveryRecord;
  }

  /**
   * Returns current round-robin channel pointer (1 to 10)
   * @returns {number}
   */
  getRoundRobinPointer() {
    return this.roundRobinPointer;
  }

  /**
   * Sets round-robin pointer explicitly (1 to 10)
   * @param {number} idx 
   */
  setRoundRobinPointer(idx) {
    const val = parseInt(idx, 10);
    if (!isNaN(val) && val >= 1 && val <= 10) {
      this.roundRobinPointer = val;
    } else {
      this.roundRobinPointer = 1;
    }
    this.saveState();
  }

  /**
   * Advances the round-robin pointer sequentially: 1 -> 2 -> ... -> 10 -> 1
   * @returns {number} New pointer position
   */
  advanceRoundRobinPointer() {
    this.roundRobinPointer = (this.roundRobinPointer % 10) + 1;
    this.saveState();
    return this.roundRobinPointer;
  }

  /**
   * Enqueues newly discovered candidate posts into the persistent FIFO queue.
   * Filters out candidates already in queue or already DELIVERED to that destination.
   * @param {Array<object>} candidates 
   * @returns {{ enqueued: number, totalInQueue: number }}
   */
  enqueueCandidates(candidates) {
    if (!Array.isArray(candidates)) return { enqueued: 0, totalInQueue: this.candidateQueue.length };
    let enqueued = 0;

    for (const item of candidates) {
      if (!item || typeof item !== "object") continue;
      const sId = String(item.sourceItemId || item.itemId || item.id || "").trim();
      if (!sId) continue;

      const destChannelId = item.destinationChannelId || item.destinationChannel || null;
      const channelIndex = typeof item.channelIndex === "number" ? item.channelIndex : 1;

      // Check if already DELIVERED for this destination
      if (destChannelId && this.isDeliveredToDestination(sId, destChannelId)) {
        continue;
      }

      // Check if already in candidate queue
      const inQueue = this.candidateQueue.some(
        q => String(q.sourceItemId || q.itemId || q.id) === sId && String(q.destinationChannelId || "") === String(destChannelId || "")
      );
      if (inQueue) continue;

      this.candidateQueue.push({
        sourceItemId: sId,
        itemId: sId,
        sourceId: item.sourceId || "external_source",
        title: item.title || "",
        pageUrl: item.pageUrl || "",
        mediaUrl: item.mediaUrl || null,
        topicKey: item.topicKey || "General",
        koreanName: item.koreanName || "",
        cardNum: item.cardNum || null,
        channelIndex: channelIndex,
        destinationChannelId: destChannelId,
        destinationUsername: item.destinationUsername || null,
        discoveredAt: item.discoveredAt || new Date().toISOString(),
        retryCount: 0,
        nextRetryAt: null,
        status: "QUEUED"
      });

      enqueued++;
    }

    if (enqueued > 0) {
      this.saveState();
    }

    return { enqueued, totalInQueue: this.candidateQueue.length };
  }

  /**
   * Checks if candidate queue has pending eligible items for a specific channel
   * @param {number} channelIndex (1 to 10)
   * @returns {boolean}
   */
  hasPendingForChannel(channelIndex) {
    const idx = parseInt(channelIndex, 10);
    const now = Date.now();
    return this.candidateQueue.some(
      q => q.channelIndex === idx && (!q.nextRetryAt || now >= new Date(q.nextRetryAt).getTime())
    );
  }

  /**
   * Pops the next pending eligible candidate for the specified channelIndex from candidateQueue.
   * @param {number} channelIndex (1 to 10)
   * @returns {object|null}
   */
  popNextForChannel(channelIndex) {
    const idx = parseInt(channelIndex, 10);
    const now = Date.now();
    const itemIndex = this.candidateQueue.findIndex(
      q => q.channelIndex === idx && (!q.nextRetryAt || now >= new Date(q.nextRetryAt).getTime())
    );

    if (itemIndex >= 0) {
      const [item] = this.candidateQueue.splice(itemIndex, 1);
      this.saveState();
      return item;
    }

    return null;
  }

  /**
   * Re-queues a failed item for retry with backoff.
   * @param {object} item 
   * @param {number} [backoffMs=60000]
   */
  requeueForRetry(item, backoffMs = 60000) {
    if (!item) return;
    const sId = String(item.sourceItemId || item.itemId || item.id || "").trim();
    const retryCount = (item.retryCount || 0) + 1;

    if (retryCount <= 3) {
      this.candidateQueue.push({
        ...item,
        retryCount,
        nextRetryAt: new Date(Date.now() + backoffMs).toISOString(),
        status: "RETRYABLE"
      });
    } else {
      this.recordDeliveryResult(item, item.destinationChannelId, {
        status: "FAILED_MAX_RETRIES",
        error: "Exceeded 3 download/processing retry attempts"
      });
    }
    this.saveState();
  }

  /**
   * Returns summary metrics of the candidate queue
   * @returns {object}
   */
  getQueueStatus() {
    const counts = {};
    for (let i = 1; i <= 10; i++) counts[i] = 0;
    this.candidateQueue.forEach(q => {
      const ch = q.channelIndex || 1;
      counts[ch] = (counts[ch] || 0) + 1;
    });

    return {
      queueLength: this.candidateQueue.length,
      roundRobinPointer: this.roundRobinPointer,
      pendingByChannel: counts,
      lastSuccessfulDeliveryAt: this.lastSuccessfulDeliveryAt
    };
  }

  /**
   * Clears state completely (primarily for testing)
   */
  clear() {
    this.records.clear();
    this.deliveryLedger.clear();
    this.candidateQueue = [];
    this.roundRobinPointer = 1;
    this.lastSuccessfulDeliveryAt = null;
    this.urlIndex.clear();
    this.retainedPool = [];
    this.lastSuccessfulPollAt = null;
    this.lastDiscoveredCount = 0;
    this.totalProcessedCount = 0;
    if (fs.existsSync(this.stateFilePath)) {
      try {
        fs.unlinkSync(this.stateFilePath);
      } catch (e) {}
    }
  }
}

module.exports = {
  ExternalSourceState,
  MAX_GLOBAL_RETENTION
};
