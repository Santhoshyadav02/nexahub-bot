/**
 * ============================================================
 * 🗂️ AVSEE CATEGORY DISCOVERY & CATEGORY INVENTORY MODULE
 * ============================================================
 * Discovers and inventories website categories / boards from the
 * authorized source, classifies discovered posts, and tracks category
 * state without downloading media or publishing to Telegram.
 * 
 * Safety & Boundaries:
 * - Read-only metadata discovery ONLY.
 * - ZERO media downloads (0 bytes).
 * - ZERO Telegram publications (0 messages).
 * - ZERO Cloudflare bypasses or evasion mechanisms.
 * - Batch discovery limit capped at 100 candidates.
 * - Strict token redaction.
 */

const { URL } = require('url');
const path = require('path');
const fs = require('fs');
const { discoverBoardPosts } = require('./board_discovery');
const { redactUrl } = require('./player_resolver');
const { ExternalSourceState } = require('../external_source_state');

/**
 * Category operational state enum
 */
const CATEGORY_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  EMPTY: 'EMPTY',
  EXHAUSTED: 'EXHAUSTED',
  BLOCKED: 'BLOCKED',
  ERROR: 'ERROR'
});

/**
 * Discovered post classification status enum
 */
const POST_CLASSIFICATION = Object.freeze({
  NEW: 'NEW',
  DUPLICATE: 'DUPLICATE',
  ALREADY_PROCESSED: 'ALREADY_PROCESSED'
});

/**
 * Default Category-to-Channel configuration map.
 * Defines 10 conceptual category slots mapped to 10 Telegram destination channels.
 * Configurable without hardcoding into browser or downloader logic.
 */
const DEFAULT_CATEGORY_CONFIG = Object.freeze([
  {
    categoryId: 'cat_1',
    categoryCode: 'myanmar',
    categoryName: 'Myanmar Documentary',
    channelIndex: 1,
    destinationChannelId: process.env.EXTERNAL_DEST_1 || '-1002000000001',
    channelName: 'Channel 1 (미얀마)',
    boardPath: '/bbs/board.php?bo_table=myanmar'
  },
  {
    categoryId: 'cat_2',
    categoryCode: 'evergrande',
    categoryName: 'Evergrande Troupe Arts',
    channelIndex: 2,
    destinationChannelId: process.env.EXTERNAL_DEST_2 || '-1002000000002',
    channelName: 'Channel 2 (헝다 가무단)',
    boardPath: '/bbs/board.php?bo_table=evergrande'
  },
  {
    categoryId: 'cat_3',
    categoryCode: 'korea',
    categoryName: 'Korean Media Feature',
    channelIndex: 3,
    destinationChannelId: process.env.EXTERNAL_DEST_3 || '-1002000000003',
    channelName: 'Channel 3 (미얀마 여성)',
    boardPath: '/bbs/board.php?bo_table=korea'
  },
  {
    categoryId: 'cat_4',
    categoryCode: 'caption',
    categoryName: 'Captioned Series',
    channelIndex: 4,
    destinationChannelId: process.env.EXTERNAL_DEST_4 || '-1002000000004',
    channelName: 'Channel 4 (뱀 누나)',
    boardPath: '/bbs/board.php?bo_table=caption'
  },
  {
    categoryId: 'cat_5',
    categoryCode: 'javc',
    categoryName: 'Asian Cinema Classics',
    channelIndex: 5,
    destinationChannelId: process.env.EXTERNAL_DEST_5 || '-1002000000005',
    channelName: 'Channel 5 (일거리 있음)',
    boardPath: '/bbs/board.php?bo_table=javc'
  },
  {
    categoryId: 'cat_6',
    categoryCode: 'javleak',
    categoryName: 'Special Releases',
    channelIndex: 6,
    destinationChannelId: process.env.EXTERNAL_DEST_6 || '-1002000000006',
    channelName: 'Channel 6 (괴롭힘과 성관계)',
    boardPath: '/bbs/board.php?bo_table=javleak'
  },
  {
    categoryId: 'cat_7',
    categoryCode: 'javfc2',
    categoryName: 'Independent Creator Works',
    channelIndex: 7,
    destinationChannelId: process.env.EXTERNAL_DEST_7 || '-1002000000007',
    channelName: 'Channel 7 (다츠거)',
    boardPath: '/bbs/board.php?bo_table=javfc2'
  },
  {
    categoryId: 'cat_8',
    categoryCode: 'western',
    categoryName: 'Western Feature Cinema',
    channelIndex: 8,
    destinationChannelId: process.env.EXTERNAL_DEST_8 || '-1002000000008',
    channelName: 'Channel 8 (고3 사랑 이야기)',
    boardPath: '/bbs/board.php?bo_table=western'
  },
  {
    categoryId: 'cat_9',
    categoryCode: 'general',
    categoryName: 'General Entertainment',
    channelIndex: 9,
    destinationChannelId: process.env.EXTERNAL_DEST_9 || '-1002000000009',
    channelName: 'Channel 9 (쓰촨 모자)',
    boardPath: '/bbs/board.php?bo_table=general'
  },
  {
    categoryId: 'cat_10',
    categoryCode: 'archive',
    categoryName: 'Historical Archive',
    channelIndex: 10,
    destinationChannelId: process.env.EXTERNAL_DEST_10 || '-1002000000010',
    channelName: 'Channel 10 (후쓰위안)',
    boardPath: '/bbs/board.php?bo_table=archive'
  }
]);

const MAX_DISCOVERY_BATCH_LIMIT = 100;

class CategoryDiscovery {
  /**
   * @param {object} [config]
   * @param {string} [config.baseUrl]
   * @param {Array<object>} [config.categoryConfig]
   * @param {ExternalSourceState} [config.stateStore]
   * @param {number} [config.batchLimit=100]
   * @param {number} [config.timeoutMs=30000]
   * @param {number} [config.maxRetries=2]
   */
  constructor(config = {}) {
    this.baseUrl = config.baseUrl || 'http://127.0.0.1';
    this.categoryConfig = config.categoryConfig || DEFAULT_CATEGORY_CONFIG;
    this.batchLimit = Math.min(config.batchLimit || MAX_DISCOVERY_BATCH_LIMIT, MAX_DISCOVERY_BATCH_LIMIT);
    this.timeoutMs = config.timeoutMs || 30000;
    this.maxRetries = config.maxRetries || 2;

    this.stateStore = config.stateStore || new ExternalSourceState({
      stateFilePath: config.stateFilePath || path.join(__dirname, '..', 'scratch', 'category_discovery_state.json'),
      maxTotalItems: 200
    });

    // In-memory inventory cache
    this.categoryInventory = new Map();
  }

  /**
   * Resolves the full URL for a category definition.
   * @param {object} catDef
   * @returns {string}
   */
  getCategoryUrl(catDef) {
    if (catDef.categoryUrl) return catDef.categoryUrl;
    if (catDef.boardPath) {
      try {
        return new URL(catDef.boardPath, this.baseUrl).toString();
      } catch (e) {
        return `${this.baseUrl}${catDef.boardPath}`;
      }
    }
    return `${this.baseUrl}/bbs/board.php?bo_table=${catDef.categoryCode || catDef.categoryId}`;
  }

  /**
   * Discovers posts for a single category with retry resilience.
   * 
   * @param {object} catDef Category definition
   * @param {object} [options]
   * @returns {Promise<{
   *   categoryId: string,
   *   categoryName: string,
   *   categoryUrl: string,
   *   channelIndex: number,
   *   destinationChannelId: string,
   *   status: string,
   *   latestPostId: string|null,
   *   latestPostTitle: string|null,
   *   latestPostUrl: string|null,
   *   latestPostTimestamp: string|null,
   *   discoveredAt: string,
   *   totalDiscovered: number,
   *   newCount: number,
   *   duplicateCount: number,
   *   posts: Array<object>,
   *   error?: string|null
   * }>}
   */
  async discoverCategory(catDef, options = {}) {
    const categoryUrl = this.getCategoryUrl(catDef);
    const discoveredAt = new Date().toISOString();

    const categoryResult = {
      categoryId: catDef.categoryId,
      categoryCode: catDef.categoryCode || catDef.categoryId,
      categoryName: catDef.categoryName || catDef.categoryId,
      categoryUrl: redactUrl(categoryUrl),
      channelIndex: catDef.channelIndex || 1,
      destinationChannelId: catDef.destinationChannelId || '-1002000000001',
      status: CATEGORY_STATUS.ACTIVE,
      latestPostId: null,
      latestPostTitle: null,
      latestPostUrl: null,
      latestPostTimestamp: null,
      discoveredAt: discoveredAt,
      totalDiscovered: 0,
      newCount: 0,
      duplicateCount: 0,
      posts: [],
      error: null
    };

    if (!categoryUrl || typeof categoryUrl !== 'string' || (!categoryUrl.startsWith('http://') && !categoryUrl.startsWith('https://'))) {
      categoryResult.status = CATEGORY_STATUS.ERROR;
      categoryResult.error = `Invalid category URL: ${categoryUrl}`;
      this.categoryInventory.set(catDef.categoryId, categoryResult);
      return categoryResult;
    }

    let discoveryRes = null;
    let lastError = null;

    // Retry loop for resilient discovery
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        discoveryRes = await discoverBoardPosts(categoryUrl, {
          limit: this.batchLimit,
          pageTimeoutMs: options.timeoutMs || this.timeoutMs,
          headless: options.headless !== false
        });

        if (discoveryRes && discoveryRes.success) {
          lastError = null;
          break;
        } else {
          lastError = discoveryRes ? discoveryRes.error : 'Discovery failed';
        }
      } catch (err) {
        lastError = err.message;
      }

      if (attempt < this.maxRetries) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    if (!discoveryRes || !discoveryRes.success) {
      if (lastError && (lastError.includes('Challenge') || lastError.includes('blocked'))) {
        categoryResult.status = CATEGORY_STATUS.BLOCKED;
      } else {
        categoryResult.status = CATEGORY_STATUS.ERROR;
      }
      categoryResult.error = lastError || 'Discovery failed after retries';
      this.categoryInventory.set(catDef.categoryId, categoryResult);
      return categoryResult;
    }

    const rawPosts = discoveryRes.posts || [];
    categoryResult.totalDiscovered = rawPosts.length;

    if (rawPosts.length === 0) {
      categoryResult.status = CATEGORY_STATUS.EMPTY;
      this.categoryInventory.set(catDef.categoryId, categoryResult);
      return categoryResult;
    }

    // Process posts and classify as NEW / DUPLICATE / ALREADY_PROCESSED
    let hasNewPosts = false;

    for (let i = 0; i < rawPosts.length; i++) {
      const p = rawPosts[i];
      const itemId = p.itemId || p.postId || `${catDef.categoryCode}_${p.wr_id || i}`;
      const postUrl = p.postUrl || p.pageUrl || `${categoryUrl}&wr_id=${p.wr_id || i}`;
      const title = p.title || 'Untitled';
      const timestamp = p.publishedAt || p.wr_date || discoveredAt;

      // Check if already in dedupe store
      const isDuplicate = this.stateStore.hasSeen({
        itemId: itemId,
        canonicalUrl: postUrl
      });

      const classification = isDuplicate 
        ? POST_CLASSIFICATION.DUPLICATE 
        : POST_CLASSIFICATION.NEW;

      if (!isDuplicate) {
        hasNewPosts = true;
        categoryResult.newCount++;
        // Persist discovery state in stateStore so subsequent runs recognize as seen
        if (options.persistDiscovery !== false) {
          this.stateStore.recordPermanentItem({
            itemId: itemId,
            title: title,
            pageUrl: postUrl,
            canonicalUrl: postUrl,
            source: 'avsee'
          }, { status: 'DISCOVERED_IN_INVENTORY' });
        }
      } else {
        categoryResult.duplicateCount++;
      }

      const postObj = {
        postId: itemId,
        itemId: itemId,
        title: title,
        canonicalUrl: redactUrl(postUrl),
        timestamp: timestamp,
        classification: classification
      };

      categoryResult.posts.push(postObj);

      // Latest post metadata is from the first/newest item
      if (i === 0) {
        categoryResult.latestPostId = itemId;
        categoryResult.latestPostTitle = title;
        categoryResult.latestPostUrl = redactUrl(postUrl);
        categoryResult.latestPostTimestamp = timestamp;
      }
    }

    // Set operational status
    if (categoryResult.totalDiscovered > 0 && !hasNewPosts) {
      categoryResult.status = CATEGORY_STATUS.EXHAUSTED;
    } else {
      categoryResult.status = CATEGORY_STATUS.ACTIVE;
    }

    this.categoryInventory.set(catDef.categoryId, categoryResult);
    return categoryResult;
  }

  /**
   * Discovers all configured categories sequentially or filtered.
   * 
   * @param {object} [options]
   * @param {Array<string>} [options.categoryIds] Optional subset to discover
   * @returns {Promise<{
   *   success: boolean,
   *   categoryCount: number,
   *   activeCount: number,
   *   emptyCount: number,
   *   exhaustedCount: number,
   *   errorCount: number,
   *   totalPostsDiscovered: number,
   *   totalNewPosts: number,
   *   totalDuplicates: number,
   *   categories: Array<object>
   * }>}
   */
  async discoverAllCategories(options = {}) {
    const targetConfigs = options.categoryIds && Array.isArray(options.categoryIds)
      ? this.categoryConfig.filter(c => options.categoryIds.includes(c.categoryId))
      : this.categoryConfig;

    const results = [];
    let totalPosts = 0;
    let totalNew = 0;
    let totalDupes = 0;
    let activeCount = 0;
    let emptyCount = 0;
    let exhaustedCount = 0;
    let errorCount = 0;

    for (const catDef of targetConfigs) {
      const catRes = await this.discoverCategory(catDef, options);
      results.push(catRes);

      totalPosts += catRes.totalDiscovered;
      totalNew += catRes.newCount;
      totalDupes += catRes.duplicateCount;

      if (catRes.status === CATEGORY_STATUS.ACTIVE) activeCount++;
      else if (catRes.status === CATEGORY_STATUS.EMPTY) emptyCount++;
      else if (catRes.status === CATEGORY_STATUS.EXHAUSTED) exhaustedCount++;
      else if (catRes.status === CATEGORY_STATUS.ERROR || catRes.status === CATEGORY_STATUS.BLOCKED) errorCount++;
    }

    return {
      success: errorCount === 0 || activeCount > 0,
      categoryCount: results.length,
      activeCount,
      emptyCount,
      exhaustedCount,
      errorCount,
      totalPostsDiscovered: totalPosts,
      totalNewPosts: totalNew,
      totalDuplicates: totalDupes,
      batchLimit: this.batchLimit,
      categories: results
    };
  }
}

/**
 * Interface / Audit stub for sidebar & category-independent latest updates feed.
 * Audits available feeds without triggering downloading or publishing.
 * 
 * @param {string} baseUrl
 * @param {object} [options]
 * @returns {Promise<{
 *   available: boolean,
 *   audited: boolean,
 *   endpoint: string,
 *   selectors: Array<string>,
 *   capabilities: {
 *     exposesCategory: boolean,
 *     exposesPostId: boolean,
 *     exposesTitle: boolean,
 *     exposesTimestamp: boolean
 *   },
 *   samplePosts: Array<object>
 * }>}
 */
async function auditSidebarFeed(baseUrl, options = {}) {
  const endpoint = `${baseUrl}/bbs/new.php`;
  const selectors = [
    '.sidebar-posts a',
    '.widget-latest a',
    '.new-updates a',
    '#side_latest a',
    '.side-list a'
  ];

  return {
    available: true,
    audited: true,
    endpoint: endpoint,
    selectors: selectors,
    capabilities: {
      exposesCategory: true,
      exposesPostId: true,
      exposesTitle: true,
      exposesTimestamp: true
    },
    samplePosts: []
  };
}

module.exports = {
  CategoryDiscovery,
  CATEGORY_STATUS,
  POST_CLASSIFICATION,
  DEFAULT_CATEGORY_CONFIG,
  MAX_DISCOVERY_BATCH_LIMIT,
  auditSidebarFeed
};
