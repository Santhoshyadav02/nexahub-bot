/**
 * ============================================================
 * 📊 BOT 2 QUOTA & DEDUPLICATION TRACKER (Scraping-1 Engine)
 * ============================================================
 * Manages daily publication quotas and duplicate prevention
 * specifically for Bot 2 across its 6 channels.
 */

const fs = require('fs');
const path = require('path');
const { dataPath, writeJsonAtomicSync } = require('../runtime_paths');

const LOG_PREFIX = '[BOT2_QUOTA_TRACKER]';

class Bot2QuotaTracker {
  /**
   * @param {object} [options]
   * @param {string} [options.stateFilePath]
   * @param {number} [options.defaultDailyQuota=5]
   */
  constructor(options = {}) {
    this.stateFilePath = options.stateFilePath || dataPath('bot2_pipeline', 'state', 'bot2_quota_state.json');
    this.defaultDailyQuota = options.defaultDailyQuota || 5;
    this.state = this._loadState();
    this._checkDateRollover();
  }

  _getTodayString() {
    return new Date().toISOString().slice(0, 10);
  }

  _loadState() {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const raw = fs.readFileSync(this.stateFilePath, 'utf8');
        return JSON.parse(raw);
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} Could not load state from ${this.stateFilePath}, initializing fresh: ${err.message}`);
    }

    return {
      currentDate: this._getTodayString(),
      channels: {},
      publishedTitles: {},
      totalPublishedToday: 0
    };
  }

  _saveState() {
    try {
      const dir = path.dirname(this.stateFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      writeJsonAtomicSync(this.stateFilePath, this.state);
    } catch (err) {
      console.error(`${LOG_PREFIX} Failed to persist quota state: ${err.message}`);
    }
  }

  _checkDateRollover() {
    const today = this._getTodayString();
    if (this.state.currentDate !== today) {
      console.log(`${LOG_PREFIX} Date rollover detected (${this.state.currentDate} -> ${today}). Resetting daily channel counts.`);
      this.state.currentDate = today;
      this.state.totalPublishedToday = 0;
      for (const key of Object.keys(this.state.channels)) {
        this.state.channels[key].publishedToday = 0;
        this.state.channels[key].lastReset = today;
      }
      this._saveState();
    }
  }

  _ensureChannel(channelKey) {
    this._checkDateRollover();
    if (!this.state.channels[channelKey]) {
      this.state.channels[channelKey] = {
        publishedToday: 0,
        totalAllTime: 0,
        lastReset: this.state.currentDate,
        history: []
      };
    }
    return this.state.channels[channelKey];
  }

  canPublish(channelKey, customQuota = null) {
    this._checkDateRollover();
    const ch = this._ensureChannel(channelKey);
    const limit = customQuota !== null ? customQuota : this.defaultDailyQuota;
    return ch.publishedToday < limit;
  }

  getRemainingQuota(channelKey, customQuota = null) {
    this._checkDateRollover();
    const ch = this._ensureChannel(channelKey);
    const limit = customQuota !== null ? customQuota : this.defaultDailyQuota;
    return Math.max(0, limit - ch.publishedToday);
  }

  getPublishedCountToday(channelKey) {
    this._checkDateRollover();
    const ch = this._ensureChannel(channelKey);
    return ch.publishedToday;
  }

  recordPublish(channelKey, item = {}) {
    this._checkDateRollover();
    const ch = this._ensureChannel(channelKey);
    ch.publishedToday += 1;
    ch.totalAllTime += 1;
    this.state.totalPublishedToday = (this.state.totalPublishedToday || 0) + 1;

    const entry = {
      timestamp: new Date().toISOString(),
      title: item.title || 'Untitled',
      mediaId: item.mediaId || null,
      messageId: item.messageId || null,
      destinationId: item.destinationId || null
    };

    ch.history.push(entry);
    if (ch.history.length > 200) {
      ch.history = ch.history.slice(-200);
    }

    if (item.title) {
      const norm = this.normalizeTitle(item.title);
      this.state.publishedTitles[norm] = {
        title: item.title,
        channelKey,
        publishedAt: entry.timestamp
      };
    }

    this._saveState();
    console.log(`${LOG_PREFIX} Recorded publish for "${channelKey}": ${ch.publishedToday}/${this.defaultDailyQuota} today.`);
    return ch.publishedToday;
  }

  normalizeTitle(title) {
    if (!title) return '';
    return String(title)
      .toLowerCase()
      .replace(/\[.*?\]|\(.*?\)/g, ' ')
      .replace(/[\s\-_|:]+/g, ' ')
      .trim();
  }

  isDuplicateTitle(title) {
    if (!title) return false;
    const norm = this.normalizeTitle(title);
    return Boolean(this.state.publishedTitles[norm]);
  }

  getStatusSummary() {
    this._checkDateRollover();
    const summary = {
      date: this.state.currentDate,
      totalPublishedToday: this.state.totalPublishedToday || 0,
      channels: {}
    };

    for (const [key, val] of Object.entries(this.state.channels)) {
      summary.channels[key] = {
        publishedToday: val.publishedToday,
        totalAllTime: val.totalAllTime,
        remainingToday: Math.max(0, this.defaultDailyQuota - val.publishedToday)
      };
    }
    return summary;
  }
}

module.exports = {
  Bot2QuotaTracker,
  LOG_PREFIX
};
