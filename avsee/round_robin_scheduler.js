/**
 * ============================================================
 * 🔄 AVSEE PERSISTENT ROUND-ROBIN & 24-HOUR QUOTA ENGINE
 * ============================================================
 * Manages fair round-robin scheduling across 10 destination channels
 * with rolling 24-hour channel quotas (10/24h per channel), rolling
 * 24-hour global quotas (100/24h global), persistent pointer state,
 * empty-category sidebar fallback, and crash recovery.
 * 
 * Safety & Compliance:
 * - Read-only scheduling and quota tracking ONLY.
 * - ZERO media downloads (0 bytes).
 * - ZERO production Telegram publications (0 messages).
 * - ZERO Cloudflare bypasses or evasion mechanisms.
 * - 100-item discovery batch limit preserved.
 * - 150-item queue retention capacity preserved.
 */

const fs = require('fs');
const path = require('path');
const { DEFAULT_CATEGORY_CONFIG, CATEGORY_STATUS } = require('./category_discovery');
const { CategoryQueue, QUEUE_STATUS, processSidebarFallbackPosts } = require('./category_queue');

const MAX_CHANNELS = 10;
const MAX_SUCCESSFUL_DELIVERIES_PER_CHANNEL_24H = 10;
const MAX_SUCCESSFUL_DELIVERIES_GLOBAL_24H = 100;
const ROLLING_WINDOW_24H_MS = 24 * 60 * 60 * 1000; // 86,400,000 ms (24 hours)
const POLL_INTERVAL_MS = 1200000; // 20 minutes = 1,200,000 ms

/**
 * Scheduler selection & delivery outcomes
 */
const SCHEDULER_STATUS = Object.freeze({
  DISPATCH_SUCCESS: 'DISPATCH_SUCCESS',
  CHANNEL_QUOTA_REACHED: 'CHANNEL_QUOTA_REACHED',
  GLOBAL_QUOTA_REACHED: 'GLOBAL_QUOTA_REACHED',
  CATEGORY_EMPTY: 'CATEGORY_EMPTY',
  CATEGORY_EXHAUSTED: 'CATEGORY_EXHAUSTED',
  CATEGORY_UNAVAILABLE: 'CATEGORY_UNAVAILABLE',
  DELIVERY_FAILED: 'DELIVERY_FAILED',
  SKIPPED_NO_ELIGIBLE_CHANNELS: 'SKIPPED_NO_ELIGIBLE_CHANNELS'
});

class RoundRobinScheduler {
  /**
   * @param {object} [config]
   * @param {string} [config.stateFilePath] Path to persistent JSON state
   * @param {CategoryQueue} [config.categoryQueue] CategoryQueue instance
   * @param {Array<object>} [config.categoryConfig] Category configuration
   * @param {number} [config.perChannelQuota=10] Max deliveries per channel per 24h
   * @param {number} [config.globalQuota=100] Max deliveries globally per 24h
   * @param {number} [config.rollingWindowMs=86400000] 24-hour window duration in ms
   */
  constructor(config = {}) {
    this.stateFilePath = config.stateFilePath || path.join(__dirname, '..', 'scratch', 'round_robin_scheduler_state.json');
    this.categoryConfig = config.categoryConfig || DEFAULT_CATEGORY_CONFIG;
    this.perChannelQuota = config.perChannelQuota || MAX_SUCCESSFUL_DELIVERIES_PER_CHANNEL_24H;
    this.globalQuota = config.globalQuota || MAX_SUCCESSFUL_DELIVERIES_GLOBAL_24H;
    this.rollingWindowMs = config.rollingWindowMs || ROLLING_WINDOW_24H_MS;

    this.categoryQueue = config.categoryQueue || new CategoryQueue({
      categoryConfig: this.categoryConfig
    });

    // Persistent State Variables
    this.roundRobinPointer = 1; // 1 to 10
    this.channelDeliveryTimestamps = new Map(); // channelIndex (1..10) -> Array<number (epoch ms)>
    this.globalDeliveryTimestamps = []; // Array<number (epoch ms)>

    // Telemetry and statistics
    this.stats = {
      totalDispatched: 0,
      totalDelivered: 0,
      totalDeliveryFailures: 0,
      channelQuotaRejections: 0,
      globalQuotaRejections: 0,
      emptyCategorySkips: 0,
      pointerAdvances: 0
    };

    // Execution mutex
    this.isLocked = false;

    this.initializeChannels();
    this.loadState();
  }

  /**
   * Initializes quota timestamp tracking for all 10 channels.
   */
  initializeChannels() {
    for (let i = 1; i <= MAX_CHANNELS; i++) {
      if (!this.channelDeliveryTimestamps.has(i)) {
        this.channelDeliveryTimestamps.set(i, []);
      }
    }
  }

  /**
   * Prunes delivery timestamps that are older than the 24-hour rolling window.
   * @param {number} [now=Date.now()]
   */
  pruneExpiredDeliveries(now = Date.now()) {
    const cutoff = now - this.rollingWindowMs;

    // Prune per-channel timestamps
    for (let i = 1; i <= MAX_CHANNELS; i++) {
      const timestamps = this.channelDeliveryTimestamps.get(i) || [];
      const valid = timestamps.filter(ts => ts >= cutoff);
      this.channelDeliveryTimestamps.set(i, valid);
    }

    // Prune global timestamps
    this.globalDeliveryTimestamps = this.globalDeliveryTimestamps.filter(ts => ts >= cutoff);
  }

  /**
   * Returns the count of active successful deliveries in the rolling 24-hour window for a channel.
   * @param {number} channelIndex (1..10)
   * @param {number} [now=Date.now()]
   * @returns {number}
   */
  getChannel24hUsage(channelIndex, now = Date.now()) {
    this.pruneExpiredDeliveries(now);
    const timestamps = this.channelDeliveryTimestamps.get(channelIndex) || [];
    return timestamps.length;
  }

  /**
   * Returns remaining quota slots for a specific channel.
   * @param {number} channelIndex (1..10)
   * @param {number} [now=Date.now()]
   * @returns {number}
   */
  getChannel24hRemaining(channelIndex, now = Date.now()) {
    return Math.max(0, this.perChannelQuota - this.getChannel24hUsage(channelIndex, now));
  }

  /**
   * Checks if channel has available quota in the current 24-hour rolling window.
   * @param {number} channelIndex 
   * @param {number} [now=Date.now()] 
   * @returns {boolean}
   */
  isChannelQuotaAvailable(channelIndex, now = Date.now()) {
    return this.getChannel24hRemaining(channelIndex, now) > 0;
  }

  /**
   * Returns the count of active successful deliveries globally in the rolling 24-hour window.
   * @param {number} [now=Date.now()]
   * @returns {number}
   */
  getGlobal24hUsage(now = Date.now()) {
    this.pruneExpiredDeliveries(now);
    return this.globalDeliveryTimestamps.length;
  }

  /**
   * Returns remaining global quota slots in the rolling 24-hour window.
   * @param {number} [now=Date.now()]
   * @returns {number}
   */
  getGlobal24hRemaining(now = Date.now()) {
    return Math.max(0, this.globalQuota - this.getGlobal24hUsage(now));
  }

  /**
   * Checks if global quota is available.
   * @param {number} [now=Date.now()]
   * @returns {boolean}
   */
  isGlobalQuotaAvailable(now = Date.now()) {
    return this.getGlobal24hRemaining(now) > 0;
  }

  /**
   * Returns the configuration definition for a channel index.
   * @param {number} channelIndex 
   * @returns {object|null}
   */
  getCategoryForChannel(channelIndex) {
    return this.categoryConfig.find(c => c.channelIndex === channelIndex) || null;
  }

  /**
   * Advances the round-robin pointer to the next sequential channel (1 -> 2 ... -> 10 -> 1).
   * Persists immediately to disk.
   * @param {number} [fromChannelIndex] Optional base channel index to advance from
   * @returns {number} The new pointer value
   */
  advancePointer(fromChannelIndex = null) {
    const base = (typeof fromChannelIndex === 'number' && fromChannelIndex >= 1 && fromChannelIndex <= MAX_CHANNELS)
      ? fromChannelIndex
      : this.roundRobinPointer;
    this.roundRobinPointer = (base % MAX_CHANNELS) + 1;
    this.stats.pointerAdvances++;
    this.saveState();
    return this.roundRobinPointer;
  }

  /**
   * Manually sets the round-robin pointer (for testing or recovery).
   * @param {number} pointer 
   */
  setPointer(pointer) {
    if (typeof pointer === 'number' && pointer >= 1 && pointer <= MAX_CHANNELS) {
      this.roundRobinPointer = pointer;
      this.saveState();
    }
  }

  /**
   * Selects the next eligible destination channel and candidate post based on
   * round-robin pointer, 24h channel quota, 24h global quota, and queue availability.
   * 
   * @param {object} [options]
   * @param {number} [options.now=Date.now()]
   * @param {Array<object>} [options.sidebarFallbackPosts] Optional sidebar feed for empty fallback
   * @returns {{
   *   eligible: boolean,
   *   channelIndex?: number,
   *   categoryId?: string,
   *   categoryName?: string,
   *   destinationChannelId?: string,
   *   candidateItem?: object,
   *   reason?: string,
   *   details?: object
   * }}
   */
  selectNextEligibleDestination(options = {}) {
    const now = options.now || Date.now();
    this.pruneExpiredDeliveries(now);

    // 1. Check Global 24-Hour Quota (Max 100)
    if (!this.isGlobalQuotaAvailable(now)) {
      this.stats.globalQuotaRejections++;
      return {
        eligible: false,
        reason: SCHEDULER_STATUS.GLOBAL_QUOTA_REACHED,
        details: {
          globalUsage: this.getGlobal24hUsage(now),
          globalQuota: this.globalQuota
        }
      };
    }

    const startPointer = this.roundRobinPointer;
    let currentPointer = startPointer;

    // Scan up to MAX_CHANNELS channels starting from current pointer
    for (let step = 0; step < MAX_CHANNELS; step++) {
      const channelIndex = currentPointer;
      const catDef = this.getCategoryForChannel(channelIndex);

      if (!catDef) {
        currentPointer = (currentPointer % MAX_CHANNELS) + 1;
        continue;
      }

      const categoryId = catDef.categoryId;

      // 2. Check Channel 24-Hour Quota (Max 10)
      if (!this.isChannelQuotaAvailable(channelIndex, now)) {
        this.stats.channelQuotaRejections++;
        currentPointer = (currentPointer % MAX_CHANNELS) + 1;
        continue;
      }

      // 3. Check Category Queue for eligible item
      let nextItem = this.categoryQueue.dequeueNext(categoryId);

      // If empty and sidebar fallback posts were provided, attempt fallback sweep
      if (!nextItem && Array.isArray(options.sidebarFallbackPosts) && options.sidebarFallbackPosts.length > 0) {
        processSidebarFallbackPosts(this.categoryQueue, options.sidebarFallbackPosts);
        nextItem = this.categoryQueue.dequeueNext(categoryId);
      }

      if (nextItem) {
        this.stats.totalDispatched++;
        return {
          eligible: true,
          channelIndex: channelIndex,
          categoryId: categoryId,
          categoryName: catDef.categoryName,
          destinationChannelId: catDef.destinationChannelId,
          candidateItem: nextItem,
          reason: SCHEDULER_STATUS.DISPATCH_SUCCESS
        };
      } else {
        // Category is empty; record skip and check next channel
        this.stats.emptyCategorySkips++;
        currentPointer = (currentPointer % MAX_CHANNELS) + 1;
      }
    }

    return {
      eligible: false,
      reason: SCHEDULER_STATUS.SKIPPED_NO_ELIGIBLE_CHANNELS,
      details: {
        checkedChannels: MAX_CHANNELS,
        startPointer: startPointer,
        globalUsage: this.getGlobal24hUsage(now)
      }
    };
  }

  /**
   * Records a successful delivery outcome. Consumes exactly 1 channel quota slot,
   * 1 global quota slot, marks the queue item COMPLETED, and advances the round-robin pointer.
   * 
   * @param {number} channelIndex 
   * @param {object} candidateItem 
   * @param {object} [deliveryResult={}]
   * @param {number} [now=Date.now()]
   * @returns {{
   *   success: boolean,
   *   channelIndex: number,
   *   previousPointer: number,
   *   newPointer: number,
   *   channelUsage24h: number,
   *   globalUsage24h: number
   * }}
   */
  recordDeliverySuccess(channelIndex, candidateItem, deliveryResult = {}, now = Date.now()) {
    this.pruneExpiredDeliveries(now);

    const sourcePostId = candidateItem ? (candidateItem.sourcePostId || candidateItem.itemId) : null;
    if (sourcePostId) {
      this.categoryQueue.markCompleted(sourcePostId, {
        ...deliveryResult,
        channelIndex,
        deliveredAt: new Date(now).toISOString()
      });
    }

    // Record timestamp in channel list
    if (!this.channelDeliveryTimestamps.has(channelIndex)) {
      this.channelDeliveryTimestamps.set(channelIndex, []);
    }
    this.channelDeliveryTimestamps.get(channelIndex).push(now);

    // Record timestamp in global list
    this.globalDeliveryTimestamps.push(now);

    const prevPointer = this.roundRobinPointer;
    // Advance pointer ONLY on successful delivery to the next slot after channelIndex
    const newPointer = this.advancePointer(channelIndex);

    this.stats.totalDelivered++;
    this.saveState();

    return {
      success: true,
      channelIndex,
      previousPointer: prevPointer,
      newPointer: newPointer,
      channelUsage24h: this.getChannel24hUsage(channelIndex, now),
      globalUsage24h: this.getGlobal24hUsage(now)
    };
  }

  /**
   * Records a delivery failure. Marks the item FAILED or RETRY_PENDING in CategoryQueue.
   * Crucially: Does NOT advance the pointer and does NOT consume 24h quota.
   * 
   * @param {number} channelIndex 
   * @param {object} candidateItem 
   * @param {string|Error} error 
   * @returns {{
   *   success: boolean,
   *   channelIndex: number,
   *   pointerPreserved: number,
   *   error: string
   * }}
   */
  recordDeliveryFailure(channelIndex, candidateItem, error) {
    const sourcePostId = candidateItem ? (candidateItem.sourcePostId || candidateItem.itemId) : null;
    const errorMsg = typeof error === 'string' ? error : (error ? error.message : 'Delivery failure');

    if (sourcePostId) {
      this.categoryQueue.markFailed(sourcePostId, errorMsg);
    }

    this.stats.totalDeliveryFailures++;
    this.saveState();

    return {
      success: false,
      channelIndex,
      pointerPreserved: this.roundRobinPointer,
      error: errorMsg
    };
  }

  /**
   * Returns current scheduler and quota status across all 10 channels.
   * @param {number} [now=Date.now()]
   * @returns {object}
   */
  getStatus(now = Date.now()) {
    this.pruneExpiredDeliveries(now);

    const channelQuotas = {};
    for (let i = 1; i <= MAX_CHANNELS; i++) {
      const cat = this.getCategoryForChannel(i);
      const usage = this.getChannel24hUsage(i, now);
      channelQuotas[i] = {
        channelIndex: i,
        categoryId: cat ? cat.categoryId : `cat_${i}`,
        categoryName: cat ? cat.categoryName : `Channel ${i}`,
        destinationChannelId: cat ? cat.destinationChannelId : null,
        deliveries24h: usage,
        quotaLimit24h: this.perChannelQuota,
        remaining24h: Math.max(0, this.perChannelQuota - usage),
        isQuotaAvailable: usage < this.perChannelQuota
      };
    }

    return {
      roundRobinPointer: this.roundRobinPointer,
      currentChannelSlot: `Channel ${this.roundRobinPointer}/10`,
      globalQuota: {
        deliveries24h: this.getGlobal24hUsage(now),
        quotaLimit24h: this.globalQuota,
        remaining24h: this.getGlobal24hRemaining(now),
        isQuotaAvailable: this.isGlobalQuotaAvailable(now)
      },
      channelQuotas: channelQuotas,
      queueStatus: this.categoryQueue.getQueueStatus(),
      stats: { ...this.stats }
    };
  }

  /**
   * Loads state from disk safely with corruption recovery.
   */
  loadState() {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const raw = fs.readFileSync(this.stateFilePath, 'utf8');
        const parsed = JSON.parse(raw);

        if (parsed && typeof parsed === 'object') {
          if (typeof parsed.roundRobinPointer === 'number' && parsed.roundRobinPointer >= 1 && parsed.roundRobinPointer <= MAX_CHANNELS) {
            this.roundRobinPointer = parsed.roundRobinPointer;
          }

          if (parsed.stats && typeof parsed.stats === 'object') {
            this.stats = { ...this.stats, ...parsed.stats };
          }

          if (Array.isArray(parsed.globalDeliveryTimestamps)) {
            this.globalDeliveryTimestamps = parsed.globalDeliveryTimestamps;
          }

          if (parsed.channelDeliveryTimestamps && typeof parsed.channelDeliveryTimestamps === 'object') {
            for (const [chKey, tsList] of Object.entries(parsed.channelDeliveryTimestamps)) {
              const chIdx = parseInt(chKey, 10);
              if (!isNaN(chIdx) && Array.isArray(tsList)) {
                this.channelDeliveryTimestamps.set(chIdx, tsList);
              }
            }
          }

          this.pruneExpiredDeliveries();
        }
      }
    } catch (err) {
      console.warn(`⚠️ [ROUND_ROBIN] Corrupted state file at ${this.stateFilePath}: ${err.message}. Starting safe fresh state.`);
      try {
        const backupPath = `${this.stateFilePath}.corrupt.${Date.now()}`;
        fs.renameSync(this.stateFilePath, backupPath);
      } catch (e) {}
    }
  }

  /**
   * Persists scheduler and quota state atomically to disk.
   */
  saveState() {
    try {
      const dir = path.dirname(this.stateFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const channelObj = {};
      for (const [chIdx, tsList] of this.channelDeliveryTimestamps.entries()) {
        channelObj[chIdx] = tsList;
      }

      const payload = {
        version: '4.3.0',
        phase: '4C',
        updatedAt: new Date().toISOString(),
        roundRobinPointer: this.roundRobinPointer,
        perChannelQuota: this.perChannelQuota,
        globalQuota: this.globalQuota,
        stats: this.stats,
        globalDeliveryTimestamps: this.globalDeliveryTimestamps,
        channelDeliveryTimestamps: channelObj
      };

      const tmpPath = `${this.stateFilePath}.tmp.${Date.now()}`;
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.stateFilePath);
    } catch (err) {
      console.error(`❌ [ROUND_ROBIN] Failed to save scheduler state: ${err.message}`);
    }
  }

  /**
   * Clears state for testing.
   */
  clear() {
    this.roundRobinPointer = 1;
    this.globalDeliveryTimestamps = [];
    this.channelDeliveryTimestamps.clear();
    this.stats = {
      totalDispatched: 0,
      totalDelivered: 0,
      totalDeliveryFailures: 0,
      channelQuotaRejections: 0,
      globalQuotaRejections: 0,
      emptyCategorySkips: 0,
      pointerAdvances: 0
    };
    this.initializeChannels();
    this.categoryQueue.clear();
    if (fs.existsSync(this.stateFilePath)) {
      try {
        fs.unlinkSync(this.stateFilePath);
      } catch (e) {}
    }
  }
}

module.exports = {
  RoundRobinScheduler,
  SCHEDULER_STATUS,
  MAX_CHANNELS,
  MAX_SUCCESSFUL_DELIVERIES_PER_CHANNEL_24H,
  MAX_SUCCESSFUL_DELIVERIES_GLOBAL_24H,
  ROLLING_WINDOW_24H_MS,
  POLL_INTERVAL_MS
};
