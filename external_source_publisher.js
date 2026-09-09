/**
 * ============================================================
 * 📤 EXTERNAL SOURCE PUBLISHER INTERFACE
 * ============================================================
 * Separate publisher interface for authorized external content.
 * 
 * Safety & Isolation:
 * - Completely isolated from telegram_pipeline_publisher.js.
 * - Does NOT touch source_registry.js.
 * - Enforces EXTERNAL_PUBLISH_ENABLED=false during development.
 * - Maintains ONE combined global retention pool of 150 items TOTAL across all 10 channels.
 * - Newest items are placed at Position #1.
 * - Item 151 evicts the oldest retained item.
 * - Eviction from retention pool does NOT delete the permanent dedupe record.
 */

const fs = require("fs");
const path = require("path");
const { EXTERNAL_PUBLISH_ENABLED, getDestinationForTopic } = require("./external_source_destinations");
const { ExternalSourceState, MAX_GLOBAL_RETENTION } = require("./external_source_state");

class ExternalSourcePublisher {
  /**
   * @param {object} [config]
   * @param {boolean} [config.publishEnabled]
   * @param {number} [config.maxTotalItems=150]
   * @param {number} [config.maxRetentionPerTopic]
   * @param {string} [config.retentionStorePath]
   * @param {ExternalSourceState} [config.stateStore]
   */
  constructor(config = {}) {
    this.publishEnabled = config.publishEnabled !== undefined 
      ? Boolean(config.publishEnabled) 
      : EXTERNAL_PUBLISH_ENABLED;

    this.maxTotalItems = config.maxTotalItems || config.maxRetentionPerTopic || MAX_GLOBAL_RETENTION;
    this.stateStore = config.stateStore || new ExternalSourceState({
      maxTotalItems: this.maxTotalItems,
      stateFilePath: config.retentionStorePath || config.stateFilePath
    });
  }

  /**
   * Applies rolling retention to the global 150-item pool across all 10 channels.
   * Newest item is placed at position #1 (index 0).
   * Evicts item 151 from the pool without deleting its permanent dedupe record.
   * @param {object} item Normalized item
   * @param {object} [destinationInfo]
   * @returns {{ total: number, evicted: object|null, position: number }}
   */
  applyRollingRetention(item, destinationInfo = null) {
    const result = this.stateStore.addToRetentionPool(item, destinationInfo);
    return {
      total: result.totalRetained,
      evicted: result.evicted,
      position: result.position
    };
  }

  /**
   * Publishes an authorized item to its mapped destination or executes simulated dry-run.
   * @param {object} item Normalized item
   * @param {string|null} [mediaPath] Local media file path (if downloaded)
   * @param {object|null} [destinationOverride] Explicit destination override
   * @returns {Promise<object>}
   */
  async publishAuthorizedItem(item, mediaPath = null, destinationOverride = null) {
    if (!item || typeof item !== "object") {
      throw new Error("[EXTERNAL_PUBLISHER] Invalid item parameter.");
    }

    const topicKey = item.topicKey || item.topic || "General";
    const dest = destinationOverride || getDestinationForTopic(topicKey);

    // Record into permanent dedupe ledger
    this.stateStore.recordPermanentItem(item, {
      status: this.publishEnabled ? "LIVE_PUBLISHED" : "DRY_RUN_PUBLISHED",
      destinationChannel: dest ? dest.destinationChannelId : null
    });

    // Apply global rolling retention across all 10 channels (Max 150 total)
    const retentionInfo = this.applyRollingRetention(item, dest);

    // Check publish safety flag
    if (!this.publishEnabled) {
      if (process.env.DEBUG_EXTERNAL_SOURCE === "true") {
        console.log(
          `🛡️ [EXTERNAL_PUBLISHER DRY_RUN] Simulated dispatch of "${item.title}" to ` +
          `Channel (${dest ? dest.destinationUsername : "default"}) [Global Pool: ${retentionInfo.total}/${this.maxTotalItems}]`
        );
      }
      return {
        status: "SIMULATED_PUBLISH_SUCCESS",
        published: false,
        topicKey: topicKey,
        destination: dest,
        retention: retentionInfo,
        item: item
      };
    }

    // Live publishing placeholder (disabled by default)
    console.log(`📡 [EXTERNAL_PUBLISHER] Live dispatching item "${item.title}" to ${dest ? dest.destinationChannelId : "N/A"}`);
    return {
      status: "LIVE_PUBLISH_SUCCESS",
      published: true,
      topicKey: topicKey,
      destination: dest,
      retention: retentionInfo,
      item: item
    };
  }

  /**
   * Returns retained items in the global 150 pool (optionally filtered by topicKey)
   * @param {string} [topicKey]
   * @returns {Array<object>}
   */
  getRetainedItems(topicKey = null) {
    return this.stateStore.getRetainedPool(topicKey);
  }

  /**
   * Returns total count of items in the global retention pool
   * @returns {number}
   */
  getRetainedCount() {
    return this.stateStore.retainedPool.length;
  }
}

module.exports = {
  ExternalSourcePublisher
};
