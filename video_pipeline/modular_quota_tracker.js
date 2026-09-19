/**
 * ============================================================
 * 📊 MODULAR 24-HOUR CHANNEL QUOTA TRACKER
 * ============================================================
 * Manages daily publishing quotas (5 videos / 24 hours per channel)
 * across the 6 modular scraping channels.
 *
 * Features:
 *   - Atomic JSON persistence (crash safe).
 *   - Automatic midnight date rollover (resets counts every new day).
 *   - Fast query methods: canPublish(channelKey), getRemainingQuota(channelKey).
 *   - Records publication history with timestamps and message IDs.
 */

const fs = require('fs');
const path = require('path');
const { dataPath, writeJsonAtomicSync } = require('../runtime_paths');

const DEFAULT_QUOTA_FILE = dataPath('video_pipeline', 'state', 'modular_channel_quota.json');
const DEFAULT_DAILY_QUOTA = 5;

function getTodayKey() {
  const now = new Date();
  return now.toISOString().split('T')[0]; // YYYY-MM-DD
}

class ModularQuotaTracker {
  /**
   * @param {object} [options]
   * @param {string} [options.quotaPath] Path to modular_channel_quota.json
   * @param {number} [options.defaultDailyQuota=5] Max videos per channel per 24 hours
   */
  constructor(options = {}) {
    this.quotaPath = options.quotaPath || DEFAULT_QUOTA_FILE;
    this.defaultDailyQuota = options.defaultDailyQuota || DEFAULT_DAILY_QUOTA;
    this.data = {
      version: '1.0.0',
      currentDate: getTodayKey(),
      channels: {}
    };

    fs.mkdirSync(path.dirname(this.quotaPath), { recursive: true });
    this._load();
  }

  _load() {
    if (!fs.existsSync(this.quotaPath)) {
      this._save();
      return;
    }
    try {
      const raw = fs.readFileSync(this.quotaPath, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = {
        version: parsed.version || '1.0.0',
        currentDate: parsed.currentDate || getTodayKey(),
        channels: parsed.channels || {}
      };
      this._checkDateRollover();
    } catch (e) {
      console.warn(`[MODULAR_QUOTA_TRACKER] Failed to read ${this.quotaPath}: ${e.message}, initializing fresh.`);
      this._save();
    }
  }

  _save() {
    try {
      writeJsonAtomicSync(this.quotaPath, this.data);
    } catch (e) {
      // Fallback direct write
      fs.writeFileSync(this.quotaPath, JSON.stringify(this.data, null, 2), 'utf8');
    }
  }

  _checkDateRollover() {
    const today = getTodayKey();
    if (this.data.currentDate !== today) {
      console.log(`[MODULAR_QUOTA_TRACKER] Date rollover detected (${this.data.currentDate} -> ${today}). Resetting daily channel counts.`);
      this.data.currentDate = today;
      for (const key of Object.keys(this.data.channels)) {
        this.data.channels[key].publishedToday = 0;
        this.data.channels[key].historyToday = [];
      }
      this._save();
    }
  }

  _ensureChannel(channelKey, maxQuota = this.defaultDailyQuota) {
    this._checkDateRollover();
    if (!this.data.channels[channelKey]) {
      this.data.channels[channelKey] = {
        key: channelKey,
        maxQuota: maxQuota || this.defaultDailyQuota,
        publishedToday: 0,
        totalLifetimePublished: 0,
        historyToday: []
      };
    }
  }

  /**
   * Checks if a channel is allowed to publish another video today.
   * @param {string} channelKey
   * @param {number} [maxQuota]
   * @returns {boolean}
   */
  canPublish(channelKey, maxQuota) {
    this._ensureChannel(channelKey, maxQuota);
    const limit = maxQuota || this.data.channels[channelKey].maxQuota || this.defaultDailyQuota;
    return this.data.channels[channelKey].publishedToday < limit;
  }

  /**
   * Returns remaining quota for today.
   * @param {string} channelKey
   * @param {number} [maxQuota]
   * @returns {number}
   */
  getRemainingQuota(channelKey, maxQuota) {
    this._ensureChannel(channelKey, maxQuota);
    const limit = maxQuota || this.data.channels[channelKey].maxQuota || this.defaultDailyQuota;
    const published = this.data.channels[channelKey].publishedToday;
    return Math.max(0, limit - published);
  }

  /**
   * Returns current count of videos published today for channel.
   * @param {string} channelKey
   * @returns {number}
   */
  getPublishedCountToday(channelKey) {
    this._ensureChannel(channelKey);
    return this.data.channels[channelKey].publishedToday;
  }

  /**
   * Records a successful publication for a channel.
   * @param {string} channelKey
   * @param {object} itemDetails { mediaId, title, messageId, destinationId }
   */
  recordPublish(channelKey, itemDetails = {}) {
    this._ensureChannel(channelKey);
    const ch = this.data.channels[channelKey];
    ch.publishedToday += 1;
    ch.totalLifetimePublished = (ch.totalLifetimePublished || 0) + 1;
    ch.historyToday.push({
      mediaId: itemDetails.mediaId || 'unknown',
      title: itemDetails.title || '',
      messageId: itemDetails.messageId || null,
      destinationId: itemDetails.destinationId || '',
      publishedAt: new Date().toISOString()
    });
    this._save();
    console.log(`[MODULAR_QUOTA_TRACKER] Recorded publish for "${channelKey}": ${ch.publishedToday}/${ch.maxQuota} today.`);
  }

  /**
   * Returns a complete status snapshot for all 6 channels.
   * @returns {object}
   */
  getStatusSummary() {
    this._checkDateRollover();
    const summary = {
      currentDate: this.data.currentDate,
      channels: {}
    };
    for (const [key, ch] of Object.entries(this.data.channels)) {
      summary.channels[key] = {
        publishedToday: ch.publishedToday,
        maxQuota: ch.maxQuota,
        remainingToday: Math.max(0, ch.maxQuota - ch.publishedToday),
        totalLifetime: ch.totalLifetimePublished || 0
      };
    }
    return summary;
  }
}

module.exports = {
  ModularQuotaTracker,
  DEFAULT_DAILY_QUOTA
};
