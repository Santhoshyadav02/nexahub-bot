/**
 * ============================================================
 * 📥 AVSEE PERSISTENT CATEGORY QUEUE & SIDEBAR FALLBACK
 * ============================================================
 * Manages isolated, persistent FIFO queues for each of the 10
 * destination categories with duplicate rejection, category state
 * tracking, sidebar fallback sweep, category mismatch protection,
 * crash recovery, and capacity enforcement.
 * 
 * Safety & Compliance:
 * - Read-only metadata queuing ONLY.
 * - ZERO media downloads (0 bytes).
 * - ZERO Telegram publications (0 messages).
 * - ZERO Cloudflare bypasses or evasion mechanisms.
 * - Discovery limit capped at 100 candidates per batch.
 * - Queue capacity safety limit capped at 150 items.
 * - Strict token redaction.
 */

const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { discoverBoardPosts } = require('./board_discovery');
const { redactUrl } = require('./player_resolver');
const { DEFAULT_CATEGORY_CONFIG, CATEGORY_STATUS, MAX_DISCOVERY_BATCH_LIMIT } = require('./category_discovery');

/**
 * Queue item lifecycle states
 */
const QUEUE_STATUS = Object.freeze({
  DISCOVERED: 'DISCOVERED',
  QUEUED: 'QUEUED',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  RETRY_PENDING: 'RETRY_PENDING',
  DUPLICATE: 'DUPLICATE',
  EXHAUSTED: 'EXHAUSTED'
});

/**
 * Discovery source types
 */
const DISCOVERY_SOURCE = Object.freeze({
  MAIN_BOARD: 'MAIN_BOARD',
  SIDEBAR_FALLBACK: 'SIDEBAR_FALLBACK'
});

const MAX_QUEUE_CAPACITY = 150;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BACKOFF_MS = 60000; // 1 minute

class CategoryQueue {
  /**
   * @param {object} [config]
   * @param {string} [config.stateFilePath] Path to persistent JSON state
   * @param {number} [config.maxCapacity=150] Max items across all queues
   * @param {number} [config.maxRetries=3] Max retries before permanent failure
   * @param {number} [config.retryBackoffMs=60000] Retry backoff in ms
   * @param {Array<object>} [config.categoryConfig] Category slot configuration
   */
  constructor(config = {}) {
    this.stateFilePath = config.stateFilePath || path.join(__dirname, '..', 'scratch', 'category_queue_state.json');
    this.maxCapacity = config.maxCapacity || MAX_QUEUE_CAPACITY;
    this.maxRetries = config.maxRetries !== undefined ? config.maxRetries : DEFAULT_MAX_RETRIES;
    this.retryBackoffMs = config.retryBackoffMs || DEFAULT_RETRY_BACKOFF_MS;
    this.categoryConfig = config.categoryConfig || DEFAULT_CATEGORY_CONFIG;

    // Per-category FIFO queues: Map<categoryId, Array<QueueItem>>
    this.queues = new Map();

    // Permanent completed ledger: Map<sourcePostId, CompletedRecord>
    this.completedLedger = new Map();

    // Global URL & Post ID dedupe index: Set<string>
    this.dedupeIndex = new Set();

    // Per-category state tracking: Map<categoryId, { status, lastCheckedAt, lastDiscoveredCount, error }>
    this.categoryStates = new Map();

    // Metrics and telemetry
    this.stats = {
      totalEnqueued: 0,
      totalDequeued: 0,
      totalCompleted: 0,
      totalFailed: 0,
      totalRetries: 0,
      duplicatesBlocked: 0,
      capacityRejections: 0,
      mismatchesBlocked: 0,
      malformedBlocked: 0,
      mainBoardDiscovered: 0,
      sidebarDiscovered: 0
    };

    this.initializeCategorySlots();
    this.loadState();
    this.recoverProcessingItems();
  }

  /**
   * Initializes empty queues and default states for all 10 configured categories.
   */
  initializeCategorySlots() {
    for (const cat of this.categoryConfig) {
      if (!this.queues.has(cat.categoryId)) {
        this.queues.set(cat.categoryId, []);
      }
      if (!this.categoryStates.has(cat.categoryId)) {
        this.categoryStates.set(cat.categoryId, {
          categoryId: cat.categoryId,
          categoryCode: cat.categoryCode || cat.categoryId,
          categoryName: cat.categoryName || cat.categoryId,
          channelIndex: cat.channelIndex || 1,
          destinationChannelId: cat.destinationChannelId || '-1002000000001',
          status: CATEGORY_STATUS.ACTIVE,
          lastCheckedAt: null,
          lastDiscoveredCount: 0,
          error: null
        });
      }
    }
  }

  /**
   * Normalizes URLs for canonical deduplication.
   * @param {string} url 
   * @returns {string}
   */
  normalizeUrl(url) {
    if (!url || typeof url !== 'string') return '';
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.host}${u.pathname}${u.search}`.toLowerCase().replace(/\/+$/, '');
    } catch (e) {
      return url.trim().toLowerCase().replace(/\/+$/, '');
    }
  }

  /**
   * Generates a dedupe key for post IDs or URLs.
   * @param {string} sourcePostId 
   * @param {string} [canonicalUrl] 
   * @returns {string}
   */
  getDedupeKey(sourcePostId, canonicalUrl = '') {
    if (sourcePostId) return `id:${String(sourcePostId).trim().toLowerCase()}`;
    if (canonicalUrl) return `url:${this.normalizeUrl(canonicalUrl)}`;
    return '';
  }

  /**
   * Validates if a post URL's query parameters match the specified category.
   * @param {string} canonicalUrl 
   * @param {string} categoryCode 
   * @param {string} categoryId 
   * @returns {boolean}
   */
  validateCategoryMatch(canonicalUrl, categoryCode, categoryId) {
    if (!canonicalUrl || typeof canonicalUrl !== 'string') return false;
    try {
      const parsed = new URL(canonicalUrl);
      const boTable = parsed.searchParams.get('bo_table');
      if (boTable) {
        const targetCode = (categoryCode || '').toLowerCase();
        const targetId = (categoryId || '').toLowerCase();
        const actualCode = boTable.toLowerCase();
        return actualCode === targetCode || actualCode === targetId;
      }
      return true; // If bo_table is not present, don't fail match on searchParam
    } catch (e) {
      return false;
    }
  }

  /**
   * Checks if an item is already known (in queue, completed ledger, or dedupe index).
   * @param {string} sourcePostId 
   * @param {string} [canonicalUrl] 
   * @returns {boolean}
   */
  hasSeen(sourcePostId, canonicalUrl = '') {
    const sId = String(sourcePostId || '').trim();
    if (sId && this.completedLedger.has(sId)) return true;
    if (sId && this.dedupeIndex.has(this.getDedupeKey(sId))) return true;

    const normUrl = this.normalizeUrl(canonicalUrl);
    if (normUrl && this.dedupeIndex.has(this.getDedupeKey(null, normUrl))) return true;

    // Check across active queues
    for (const queue of this.queues.values()) {
      for (const item of queue) {
        if (sId && String(item.sourcePostId).trim() === sId) return true;
        if (normUrl && this.normalizeUrl(item.canonicalUrl) === normUrl) return true;
      }
    }

    return false;
  }

  /**
   * Returns total active items across all category queues.
   * @returns {number}
   */
  getTotalQueueSize() {
    let count = 0;
    for (const q of this.queues.values()) {
      count += q.length;
    }
    return count;
  }

  /**
   * Recovers items left in PROCESSING state (e.g. after unexpected crash/restart)
   * back to QUEUED or RETRY_PENDING.
   */
  recoverProcessingItems() {
    let recoveredCount = 0;
    for (const [catId, queue] of this.queues.entries()) {
      for (const item of queue) {
        if (item.status === QUEUE_STATUS.PROCESSING) {
          if ((item.retryCount || 0) > 0) {
            item.status = QUEUE_STATUS.RETRY_PENDING;
            item.nextRetryAt = new Date(Date.now() + 5000).toISOString(); // Retry in 5s
          } else {
            item.status = QUEUE_STATUS.QUEUED;
          }
          item.updatedAt = new Date().toISOString();
          recoveredCount++;
        }
      }
    }
    if (recoveredCount > 0) {
      this.saveState();
    }
  }

  /**
   * Enqueues a candidate post into its category FIFO queue.
   * 
   * @param {object} candidate
   * @param {string} candidate.sourcePostId
   * @param {string} candidate.categoryId
   * @param {string} [candidate.categoryCode]
   * @param {string} [candidate.categoryName]
   * @param {string} [candidate.categoryUrl]
   * @param {string} candidate.title
   * @param {string} candidate.canonicalUrl
   * @param {string} [candidate.publishedAt]
   * @param {string} [candidate.discoveredAt]
   * @param {object} [options]
   * @param {string} [options.discoverySource='MAIN_BOARD']
   * @returns {{
   *   success: boolean,
   *   reason?: string,
   *   item?: object,
   *   queueSize?: number,
   *   totalQueueSize?: number
   * }}
   */
  enqueue(candidate, options = {}) {
    if (!candidate || typeof candidate !== 'object') {
      this.stats.malformedBlocked++;
      return { success: false, reason: 'MALFORMED_ENTRY' };
    }

    const sourcePostId = String(candidate.sourcePostId || candidate.postId || candidate.itemId || candidate.wr_id || '').trim();
    const categoryId = candidate.categoryId || (candidate.categoryCode ? `cat_${candidate.categoryCode}` : null);
    const title = String(candidate.title || '').trim();
    const canonicalUrl = candidate.canonicalUrl || candidate.postUrl || candidate.pageUrl || '';

    // Validate required fields
    if (!sourcePostId) {
      this.stats.malformedBlocked++;
      return { success: false, reason: 'MISSING_POST_ID' };
    }
    if (!title) {
      this.stats.malformedBlocked++;
      return { success: false, reason: 'MISSING_TITLE' };
    }
    if (!canonicalUrl || (!canonicalUrl.startsWith('http://') && !canonicalUrl.startsWith('https://'))) {
      this.stats.malformedBlocked++;
      return { success: false, reason: 'INVALID_CANONICAL_URL' };
    }
    if (!categoryId) {
      this.stats.malformedBlocked++;
      return { success: false, reason: 'MISSING_CATEGORY_ID' };
    }

    // Resolve category configuration
    const catDef = this.categoryConfig.find(c => c.categoryId === categoryId || c.categoryCode === candidate.categoryCode || c.categoryId === candidate.categoryCode);
    const resolvedCatId = catDef ? catDef.categoryId : categoryId;
    const resolvedCatCode = catDef ? catDef.categoryCode : (candidate.categoryCode || resolvedCatId);
    const resolvedCatName = catDef ? catDef.categoryName : (candidate.categoryName || resolvedCatId);

    // Verify category match (mismatch protection)
    if (!this.validateCategoryMatch(canonicalUrl, resolvedCatCode, resolvedCatId)) {
      this.stats.mismatchesBlocked++;
      return {
        success: false,
        reason: 'CATEGORY_MISMATCH',
        details: `URL '${redactUrl(canonicalUrl)}' does not match category '${resolvedCatCode}'`
      };
    }

    // Dedupe check
    if (this.hasSeen(sourcePostId, canonicalUrl)) {
      this.stats.duplicatesBlocked++;
      return { success: false, reason: 'DUPLICATE' };
    }

    // Capacity limit check (150-item safety limit)
    if (this.getTotalQueueSize() >= this.maxCapacity) {
      this.stats.capacityRejections++;
      return { success: false, reason: 'QUEUE_CAPACITY_REACHED' };
    }

    const discoverySource = options.discoverySource || DISCOVERY_SOURCE.MAIN_BOARD;
    const now = new Date().toISOString();
    const publishedAt = candidate.publishedAt || candidate.wr_date || candidate.discoveredAt || now;
    const discoveredAt = candidate.discoveredAt || now;

    const queueItem = {
      sourcePostId: sourcePostId,
      categoryId: resolvedCatId,
      categoryCode: resolvedCatCode,
      categoryName: resolvedCatName,
      categoryUrl: candidate.categoryUrl || (catDef ? catDef.boardPath : null) || '',
      title: title,
      canonicalUrl: redactUrl(canonicalUrl),
      publishedAt: publishedAt,
      discoveredAt: discoveredAt,
      status: QUEUE_STATUS.QUEUED,
      retryCount: 0,
      nextRetryAt: null,
      error: null,
      discoverySource: discoverySource,
      enqueuedAt: now,
      updatedAt: now
    };

    if (!this.queues.has(resolvedCatId)) {
      this.queues.set(resolvedCatId, []);
    }

    const targetQueue = this.queues.get(resolvedCatId);
    targetQueue.push(queueItem);

    // Register in dedupe index
    this.dedupeIndex.add(this.getDedupeKey(sourcePostId));
    this.dedupeIndex.add(this.getDedupeKey(null, canonicalUrl));

    // Update category state
    const catState = this.categoryStates.get(resolvedCatId);
    if (catState) {
      catState.status = CATEGORY_STATUS.ACTIVE;
      catState.lastCheckedAt = now;
      catState.error = null;
    }

    // Telemetry
    this.stats.totalEnqueued++;
    if (discoverySource === DISCOVERY_SOURCE.SIDEBAR_FALLBACK) {
      this.stats.sidebarDiscovered++;
    } else {
      this.stats.mainBoardDiscovered++;
    }

    this.saveState();

    return {
      success: true,
      item: queueItem,
      queueSize: targetQueue.length,
      totalQueueSize: this.getTotalQueueSize()
    };
  }

  /**
   * Dequeues the next eligible FIFO item for a specific category.
   * Handles FIFO ordering, retry backoff evaluation, and sets status to PROCESSING.
   * 
   * @param {string} categoryId 
   * @returns {object|null}
   */
  dequeueNext(categoryId) {
    const queue = this.queues.get(categoryId);
    if (!queue || queue.length === 0) return null;

    const now = Date.now();
    const itemIndex = queue.findIndex(item => {
      if (item.status === QUEUE_STATUS.QUEUED) return true;
      if (item.status === QUEUE_STATUS.RETRY_PENDING) {
        if (!item.nextRetryAt) return true;
        const retryTime = new Date(item.nextRetryAt).getTime();
        return !isNaN(retryTime) && now >= retryTime;
      }
      return false;
    });

    if (itemIndex < 0) return null;

    const item = queue[itemIndex];
    item.status = QUEUE_STATUS.PROCESSING;
    item.updatedAt = new Date().toISOString();

    this.stats.totalDequeued++;
    this.saveState();

    return item;
  }

  /**
   * Marks a queue item as COMPLETED. Removes it from active FIFO queue
   * and records it in the permanent completedLedger.
   * 
   * @param {string} sourcePostId 
   * @param {object} [result] 
   * @returns {boolean}
   */
  markCompleted(sourcePostId, result = {}) {
    const sId = String(sourcePostId || '').trim();
    if (!sId) return false;

    let foundItem = null;
    let foundCatId = null;

    for (const [catId, queue] of this.queues.entries()) {
      const idx = queue.findIndex(item => String(item.sourcePostId).trim() === sId);
      if (idx >= 0) {
        foundItem = queue.splice(idx, 1)[0];
        foundCatId = catId;
        break;
      }
    }

    const now = new Date().toISOString();
    const completedRecord = {
      sourcePostId: sId,
      categoryId: foundItem ? foundItem.categoryId : (result.categoryId || null),
      categoryName: foundItem ? foundItem.categoryName : (result.categoryName || null),
      title: foundItem ? foundItem.title : (result.title || null),
      canonicalUrl: foundItem ? foundItem.canonicalUrl : (result.canonicalUrl || null),
      publishedAt: foundItem ? foundItem.publishedAt : null,
      discoveredAt: foundItem ? foundItem.discoveredAt : null,
      completedAt: now,
      status: QUEUE_STATUS.COMPLETED,
      deliveryMetadata: result
    };

    this.completedLedger.set(sId, completedRecord);
    this.stats.totalCompleted++;

    this.saveState();
    return true;
  }

  /**
   * Marks a queue item as failed with retry or permanent failure.
   * 
   * @param {string} sourcePostId 
   * @param {string|Error} error 
   * @param {object} [options]
   * @returns {object|null}
   */
  markFailed(sourcePostId, error, options = {}) {
    const sId = String(sourcePostId || '').trim();
    if (!sId) return null;

    let targetItem = null;
    let targetQueue = null;

    for (const queue of this.queues.values()) {
      const item = queue.find(it => String(it.sourcePostId).trim() === sId);
      if (item) {
        targetItem = item;
        targetQueue = queue;
        break;
      }
    }

    if (!targetItem) return null;

    const errorMsg = typeof error === 'string' ? error : (error ? error.message : 'Unknown error');
    targetItem.retryCount = (targetItem.retryCount || 0) + 1;
    targetItem.error = errorMsg;
    targetItem.updatedAt = new Date().toISOString();

    const maxRetries = options.maxRetries !== undefined ? options.maxRetries : this.maxRetries;

    if (targetItem.retryCount <= maxRetries) {
      targetItem.status = QUEUE_STATUS.RETRY_PENDING;
      const backoff = options.backoffMs || this.retryBackoffMs;
      targetItem.nextRetryAt = new Date(Date.now() + backoff).toISOString();
      this.stats.totalRetries++;
    } else {
      targetItem.status = QUEUE_STATUS.FAILED;
      targetItem.nextRetryAt = null;
      this.stats.totalFailed++;
    }

    this.saveState();
    return targetItem;
  }

  /**
   * Gets queue array for a specific category.
   * @param {string} categoryId 
   * @returns {Array<object>}
   */
  getQueueForCategory(categoryId) {
    const q = this.queues.get(categoryId);
    return q ? [...q] : [];
  }

  /**
   * Sets category state explicitly.
   * @param {string} categoryId 
   * @param {string} status 
   * @param {object} [details]
   */
  setCategoryState(categoryId, status, details = {}) {
    let catState = this.categoryStates.get(categoryId);
    if (!catState) {
      catState = {
        categoryId,
        categoryCode: details.categoryCode || categoryId,
        categoryName: details.categoryName || categoryId,
        channelIndex: details.channelIndex || 1,
        destinationChannelId: details.destinationChannelId || '-1002000000001',
        status: status,
        lastCheckedAt: new Date().toISOString(),
        lastDiscoveredCount: details.lastDiscoveredCount || 0,
        error: details.error || null
      };
      this.categoryStates.set(categoryId, catState);
    } else {
      catState.status = status;
      catState.lastCheckedAt = new Date().toISOString();
      if (details.lastDiscoveredCount !== undefined) catState.lastDiscoveredCount = details.lastDiscoveredCount;
      if (details.error !== undefined) catState.error = details.error;
    }
    this.saveState();
  }

  /**
   * Returns current operational state for a category.
   * @param {string} categoryId 
   * @returns {object|null}
   */
  getCategoryState(categoryId) {
    const s = this.categoryStates.get(categoryId);
    return s ? { ...s } : null;
  }

  /**
   * Returns comprehensive queue status across all 10 categories.
   * @returns {object}
   */
  getQueueStatus() {
    const byCategory = {};
    for (const cat of this.categoryConfig) {
      const q = this.queues.get(cat.categoryId) || [];
      const st = this.categoryStates.get(cat.categoryId) || {};
      byCategory[cat.categoryId] = {
        categoryId: cat.categoryId,
        categoryCode: cat.categoryCode,
        categoryName: cat.categoryName,
        channelIndex: cat.channelIndex,
        destinationChannelId: cat.destinationChannelId,
        status: st.status || CATEGORY_STATUS.ACTIVE,
        queueLength: q.length,
        items: q.map(it => ({
          sourcePostId: it.sourcePostId,
          title: it.title,
          status: it.status,
          retryCount: it.retryCount,
          discoverySource: it.discoverySource
        }))
      };
    }

    return {
      totalQueued: this.getTotalQueueSize(),
      maxCapacity: this.maxCapacity,
      capacityAvailable: Math.max(0, this.maxCapacity - this.getTotalQueueSize()),
      completedCount: this.completedLedger.size,
      byCategory: byCategory,
      stats: { ...this.stats }
    };
  }

  /**
   * Loads queue state from disk safely with corruption recovery.
   */
  loadState() {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const raw = fs.readFileSync(this.stateFilePath, 'utf8');
        const parsed = JSON.parse(raw);

        if (parsed && typeof parsed === 'object') {
          // Load stats
          if (parsed.stats && typeof parsed.stats === 'object') {
            this.stats = { ...this.stats, ...parsed.stats };
          }

          // Load completed ledger
          if (Array.isArray(parsed.completedLedger)) {
            for (const item of parsed.completedLedger) {
              if (item && item.sourcePostId) {
                this.completedLedger.set(String(item.sourcePostId).trim(), item);
                this.dedupeIndex.add(this.getDedupeKey(item.sourcePostId));
                if (item.canonicalUrl) {
                  this.dedupeIndex.add(this.getDedupeKey(null, item.canonicalUrl));
                }
              }
            }
          }

          // Load category states
          if (Array.isArray(parsed.categoryStates)) {
            for (const st of parsed.categoryStates) {
              if (st && st.categoryId) {
                this.categoryStates.set(st.categoryId, st);
              }
            }
          }

          // Load queues
          if (parsed.queues && typeof parsed.queues === 'object') {
            for (const [catId, items] of Object.entries(parsed.queues)) {
              if (Array.isArray(items)) {
                this.queues.set(catId, items);
                for (const it of items) {
                  if (it && it.sourcePostId) {
                    this.dedupeIndex.add(this.getDedupeKey(it.sourcePostId));
                    if (it.canonicalUrl) {
                      this.dedupeIndex.add(this.getDedupeKey(null, it.canonicalUrl));
                    }
                  }
                }
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn(`⚠️ [CATEGORY_QUEUE] Corrupted state file detected at ${this.stateFilePath}: ${err.message}. Starting safe fresh state.`);
      try {
        const backupPath = `${this.stateFilePath}.corrupt.${Date.now()}`;
        fs.renameSync(this.stateFilePath, backupPath);
      } catch (e) {}
    }
  }

  /**
   * Persists queue state atomically to disk.
   */
  saveState() {
    try {
      const dir = path.dirname(this.stateFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const queuesObj = {};
      for (const [catId, q] of this.queues.entries()) {
        queuesObj[catId] = q;
      }

      const payload = {
        version: '4.2.0',
        phase: '4B',
        updatedAt: new Date().toISOString(),
        totalQueued: this.getTotalQueueSize(),
        maxCapacity: this.maxCapacity,
        stats: this.stats,
        categoryStates: Array.from(this.categoryStates.values()),
        completedLedger: Array.from(this.completedLedger.values()),
        queues: queuesObj
      };

      const tmpPath = `${this.stateFilePath}.tmp.${Date.now()}`;
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.stateFilePath);
    } catch (err) {
      console.error(`❌ [CATEGORY_QUEUE] Failed to save queue state: ${err.message}`);
    }
  }

  /**
   * Clears all in-memory queues and deletes the state file (for clean testing).
   */
  clear() {
    this.queues.clear();
    this.completedLedger.clear();
    this.dedupeIndex.clear();
    this.categoryStates.clear();
    this.stats = {
      totalEnqueued: 0,
      totalDequeued: 0,
      totalCompleted: 0,
      totalFailed: 0,
      totalRetries: 0,
      duplicatesBlocked: 0,
      capacityRejections: 0,
      mismatchesBlocked: 0,
      malformedBlocked: 0,
      mainBoardDiscovered: 0,
      sidebarDiscovered: 0
    };
    this.initializeCategorySlots();
    if (fs.existsSync(this.stateFilePath)) {
      try {
        fs.unlinkSync(this.stateFilePath);
      } catch (e) {}
    }
  }
}

/**
 * Discovers and enqueues posts for a single category board from the main website.
 * 
 * @param {CategoryQueue} categoryQueue
 * @param {object} catDef Category definition
 * @param {string} baseUrl
 * @param {object} [options]
 * @returns {Promise<{
 *   categoryId: string,
 *   categoryName: string,
 *   status: string,
 *   discoveredCount: number,
 *   enqueuedCount: number,
 *   duplicateCount: number,
 *   error?: string|null
 * }>}
 */
async function discoverAndEnqueueCategory(categoryQueue, catDef, baseUrl, options = {}) {
  const categoryId = catDef.categoryId;
  const categoryCode = catDef.categoryCode || categoryId;
  const boardPath = catDef.boardPath || `/bbs/board.php?bo_table=${categoryCode}`;
  const categoryUrl = `${baseUrl.replace(/\/+$/, '')}${boardPath}`;
  const batchLimit = Math.min(options.batchLimit || MAX_DISCOVERY_BATCH_LIMIT, MAX_DISCOVERY_BATCH_LIMIT);

  let discoveryRes = null;
  let errorMsg = null;

  try {
    discoveryRes = await discoverBoardPosts(categoryUrl, {
      limit: batchLimit,
      pageTimeoutMs: options.timeoutMs || 30000,
      headless: options.headless !== false
    });
  } catch (err) {
    errorMsg = err.message;
  }

  if (!discoveryRes || !discoveryRes.success) {
    const failureStatus = errorMsg && errorMsg.includes('Challenge') ? CATEGORY_STATUS.BLOCKED : CATEGORY_STATUS.ERROR;
    categoryQueue.setCategoryState(categoryId, failureStatus, {
      error: errorMsg || (discoveryRes ? discoveryRes.error : 'Discovery failed')
    });
    return {
      categoryId,
      categoryName: catDef.categoryName,
      status: failureStatus,
      discoveredCount: 0,
      enqueuedCount: 0,
      duplicateCount: 0,
      error: errorMsg || (discoveryRes ? discoveryRes.error : 'Discovery failed')
    };
  }

  const rawPosts = discoveryRes.posts || [];
  let enqueuedCount = 0;
  let duplicateCount = 0;

  for (let i = 0; i < rawPosts.length; i++) {
    const p = rawPosts[i];
    const sourcePostId = String(p.itemId || p.postId || p.wr_id || `${categoryCode}_${i}`).trim();
    const postUrl = p.postUrl || p.pageUrl || `${categoryUrl}&wr_id=${p.wr_id || i}`;
    const title = p.title || 'Untitled';
    const publishedAt = p.publishedAt || p.wr_date || new Date().toISOString();

    const enqueueRes = categoryQueue.enqueue({
      sourcePostId: sourcePostId,
      categoryId: categoryId,
      categoryCode: categoryCode,
      categoryName: catDef.categoryName,
      categoryUrl: categoryUrl,
      title: title,
      canonicalUrl: postUrl,
      publishedAt: publishedAt,
      discoveredAt: new Date().toISOString()
    }, { discoverySource: DISCOVERY_SOURCE.MAIN_BOARD });

    if (enqueueRes.success) {
      enqueuedCount++;
    } else if (enqueueRes.reason === 'DUPLICATE') {
      duplicateCount++;
    }
  }

  let finalStatus = CATEGORY_STATUS.ACTIVE;
  if (rawPosts.length === 0) {
    finalStatus = CATEGORY_STATUS.EMPTY;
  } else if (enqueuedCount === 0) {
    finalStatus = CATEGORY_STATUS.EXHAUSTED;
  }

  categoryQueue.setCategoryState(categoryId, finalStatus, {
    lastDiscoveredCount: rawPosts.length,
    error: null
  });

  return {
    categoryId,
    categoryName: catDef.categoryName,
    status: finalStatus,
    discoveredCount: rawPosts.length,
    enqueuedCount,
    duplicateCount,
    error: null
  };
}

/**
 * Discovers and enqueues posts from the sidebar / latest posts fallback feed.
 * Validates category matching, deduplication, and timestamps.
 * 
 * @param {CategoryQueue} categoryQueue
 * @param {Array<object>} sidebarPosts Raw posts from sidebar feed
 * @param {object} [options]
 * @returns {{
 *   totalDiscovered: number,
 *   enqueuedCount: number,
 *   duplicatesSkipped: number,
 *   mismatchesSkipped: number,
 *   malformedSkipped: number,
 *   items: Array<object>
 * }}
 */
function processSidebarFallbackPosts(categoryQueue, sidebarPosts = [], options = {}) {
  let enqueuedCount = 0;
  let duplicatesSkipped = 0;
  let mismatchesSkipped = 0;
  let malformedSkipped = 0;
  const processedItems = [];

  const limit = Math.min(sidebarPosts.length, MAX_DISCOVERY_BATCH_LIMIT);

  for (let i = 0; i < limit; i++) {
    const post = sidebarPosts[i];
    if (!post || typeof post !== 'object') {
      malformedSkipped++;
      continue;
    }

    const enqueueRes = categoryQueue.enqueue(post, {
      discoverySource: DISCOVERY_SOURCE.SIDEBAR_FALLBACK
    });

    if (enqueueRes.success) {
      enqueuedCount++;
      processedItems.push({
        sourcePostId: enqueueRes.item.sourcePostId,
        categoryId: enqueueRes.item.categoryId,
        title: enqueueRes.item.title,
        status: 'ENQUEUED'
      });
    } else if (enqueueRes.reason === 'DUPLICATE') {
      duplicatesSkipped++;
    } else if (enqueueRes.reason === 'CATEGORY_MISMATCH') {
      mismatchesSkipped++;
    } else {
      malformedSkipped++;
    }
  }

  return {
    totalDiscovered: sidebarPosts.length,
    enqueuedCount,
    duplicatesSkipped,
    mismatchesSkipped,
    malformedSkipped,
    items: processedItems
  };
}

module.exports = {
  CategoryQueue,
  QUEUE_STATUS,
  DISCOVERY_SOURCE,
  MAX_QUEUE_CAPACITY,
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_BACKOFF_MS,
  discoverAndEnqueueCategory,
  processSidebarFallbackPosts
};
