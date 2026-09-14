/**
 * ============================================================
 * 🧭 VIDEO DESTINATION ROUTER (Phase 4B - 10-Channel Routing & Classification)
 * ============================================================
 * Deterministically classifies frozen BATCH_READY media items and maps them
 * to the 10 canonical destination channels using weighted keyword matching.
 *
 * Hard safety boundaries:
 *   - Uses ONLY destination_routing_config.json as the canonical source.
 *   - Does NOT perform any network or Telegram calls.
 *   - Does NOT scrape or revisit external websites.
 *   - Uses ONLY the frozen title/metadata from BATCH_READY records.
 *   - Deterministic and thread-safe.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_ROUTING_CONFIG_PATH = path.resolve(__dirname, '..', 'destination_routing_config.json');

const WEIGHTS = {
  high: 10,
  medium: 5,
  low: 2
};

/**
 * Normalizes text for multilingual matching (English, Korean, Chinese, Japanese).
 * Strips URLs, punctuation, and collapses whitespace.
 * @param {string} text
 * @returns {string}
 */
function normalizeText(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/https?:\/\/[^\s]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

class VideoDestinationRouter {
  /**
   * @param {object} [config]
   * @param {string} [config.configPath] Path to destination_routing_config.json
   * @param {object} [config.routingConfig] Direct config object injection (for tests)
   * @param {string} [config.defaultDestinationId='DESTINATION_1'] Fallback destination if no keywords match
   */
  constructor(config = {}) {
    this.configPath = config.configPath || DEFAULT_ROUTING_CONFIG_PATH;
    this.defaultDestinationId = config.defaultDestinationId || 'DESTINATION_1';
    this.routingConfig = config.routingConfig || this._loadConfig();
    this._compiledDestinations = this._compileDestinations();
  }

  _loadConfig() {
    if (fs.existsSync(this.configPath)) {
      try {
        const raw = fs.readFileSync(this.configPath, 'utf8');
        return JSON.parse(raw);
      } catch (e) {
        console.warn(`[VIDEO_DESTINATION_ROUTER] Warning: Failed to parse ${this.configPath}: ${e.message}`);
      }
    }
    return { destinations: {} };
  }

  _compileDestinations() {
    const rawDestinations = this.routingConfig.destinations || {};
    const compiled = [];

    for (const [key, dest] of Object.entries(rawDestinations)) {
      if (dest.enabled === false) continue;

      const highKeywords = (dest.keywords && Array.isArray(dest.keywords.high))
        ? dest.keywords.high.map(k => normalizeText(k)).filter(Boolean)
        : [];
      const mediumKeywords = (dest.keywords && Array.isArray(dest.keywords.medium))
        ? dest.keywords.medium.map(k => normalizeText(k)).filter(Boolean)
        : [];
      const lowKeywords = (dest.keywords && Array.isArray(dest.keywords.low))
        ? dest.keywords.low.map(k => normalizeText(k)).filter(Boolean)
        : [];

      compiled.push({
        id: dest.id || key,
        name: dest.name || key,
        username: dest.username || '',
        chatId: process.env[`VIDEO_PIPELINE_${dest.id || key}_CHAT_ID`] || dest.chatId || '',
        priority: typeof dest.priority === 'number' ? dest.priority : 99,
        keywords: {
          high: highKeywords,
          medium: mediumKeywords,
          low: lowKeywords
        }
      });
    }

    // Sort by priority ascending
    compiled.sort((a, b) => a.priority - b.priority);
    return compiled;
  }

  /**
   * Returns list of all available destination configurations.
   */
  getDestinations() {
    return this._compiledDestinations.map(d => ({
      id: d.id,
      name: d.name,
      username: d.username,
      chatId: d.chatId,
      priority: d.priority
    }));
  }

  /**
   * Classifies a single media item based on its frozen title and metadata.
   * @param {object} media Frozen media object from BATCH_READY (must contain mediaId, title)
   * @returns {object} Classification decision with primaryDestination, allMatches, and metadata
   */
  routeMedia(media) {
    if (!media || typeof media !== 'object') {
      return this._buildUnclassifiedResult('INVALID_MEDIA', 'Media object is missing or invalid');
    }

    const mediaId = media.mediaId || 'unknown_media';
    const rawTitle = (media.title || '').trim();
    const normTitle = normalizeText(rawTitle);

    if (!normTitle) {
      return this._buildFallbackResult(mediaId, rawTitle, 'EMPTY_TITLE', 'Media title is empty or unparseable');
    }

    const matches = [];

    for (const dest of this._compiledDestinations) {
      let score = 0;
      const matchedKeywords = [];

      // Check high priority keywords (weight 10)
      for (const kw of dest.keywords.high) {
        if (this._textContainsKeyword(normTitle, kw)) {
          score += WEIGHTS.high;
          matchedKeywords.push({ keyword: kw, tier: 'high', weight: WEIGHTS.high });
        }
      }

      // Check medium priority keywords (weight 5)
      for (const kw of dest.keywords.medium) {
        if (this._textContainsKeyword(normTitle, kw)) {
          score += WEIGHTS.medium;
          matchedKeywords.push({ keyword: kw, tier: 'medium', weight: WEIGHTS.medium });
        }
      }

      // Check low priority keywords (weight 2)
      for (const kw of dest.keywords.low) {
        if (this._textContainsKeyword(normTitle, kw)) {
          score += WEIGHTS.low;
          matchedKeywords.push({ keyword: kw, tier: 'low', weight: WEIGHTS.low });
        }
      }

      if (score > 0) {
        matches.push({
          destinationId: dest.id,
          name: dest.name,
          username: dest.username,
          priority: dest.priority,
          score,
          confidence: score >= WEIGHTS.high ? 'HIGH' : (score >= WEIGHTS.medium ? 'MEDIUM' : 'LOW'),
          matchedKeywords
        });
      }
    }

    // Sort matches: highest score first; tie-breaker: lower priority number (higher priority rank)
    matches.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.priority - b.priority;
    });

    if (matches.length === 0) {
      return this._buildFallbackResult(mediaId, rawTitle, 'NO_KEYWORD_MATCH', 'No keywords matched across 10 destinations');
    }

    const primary = matches[0];

    return {
      mediaId,
      title: rawTitle,
      status: 'CLASSIFIED',
      primaryDestination: {
        id: primary.destinationId,
        name: primary.name,
        username: primary.username,
        score: primary.score,
        confidence: primary.confidence,
        matchedKeywords: primary.matchedKeywords.map(k => k.keyword)
      },
      allMatches: matches,
      fallbackUsed: false,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Routes an entire list of frozen media items.
   * @param {Array<object>} mediaList
   * @returns {Array<object>}
   */
  routeBatch(mediaList) {
    if (!Array.isArray(mediaList)) return [];
    return mediaList.map(m => this.routeMedia(m));
  }

  getDestination(destinationId) {
    const destination = this._compiledDestinations.find(d => d.id === destinationId);
    return destination ? { id: destination.id, name: destination.name, username: destination.username, chatId: destination.chatId, priority: destination.priority } : null;
  }

  _textContainsKeyword(normText, normKeyword) {
    if (!normText || !normKeyword) return false;
    // Word boundary or substring match for CJK / English
    return normText.includes(normKeyword);
  }

  _buildFallbackResult(mediaId, rawTitle, reasonCode, reasonMessage) {
    const fallbackDest = this._compiledDestinations.find(d => d.id === this.defaultDestinationId)
      || this._compiledDestinations[0]
      || { id: 'DESTINATION_1', name: 'Romantic Vibe', username: 'ccsfvk', priority: 1 };

    return {
      mediaId,
      title: rawTitle,
      status: 'FALLBACK_ASSIGNED',
      primaryDestination: {
        id: fallbackDest.id,
        name: fallbackDest.name,
        username: fallbackDest.username,
        score: 0,
        confidence: 'NONE',
        matchedKeywords: []
      },
      allMatches: [],
      fallbackUsed: true,
      reasonCode,
      reasonMessage,
      timestamp: new Date().toISOString()
    };
  }

  _buildUnclassifiedResult(reasonCode, reasonMessage) {
    return {
      mediaId: 'unknown',
      title: '',
      status: 'UNCLASSIFIED',
      primaryDestination: null,
      allMatches: [],
      fallbackUsed: false,
      reasonCode,
      reasonMessage,
      timestamp: new Date().toISOString()
    };
  }
}

module.exports = {
  VideoDestinationRouter,
  normalizeText,
  WEIGHTS
};
