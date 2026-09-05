/**
 * global_round_robin_router.js
 * 
 * NexaHub Global Round-Robin Router (Stage 10.1 - State Hardening)
 * 
 * Implements authoritative persisted round-robin destination assignment across the
 * 10 Telegram destination channels:
 * Video #1 -> DESTINATION_1
 * Video #2 -> DESTINATION_2
 * ...
 * Video #10 -> DESTINATION_10
 * Video #11 -> DESTINATION_1
 * 
 * GUARANTEES:
 * - Authoritative persisted global counter/index stored in the persistent pipeline state/ledger.
 * - The persisted value explicitly represents the NEXT destination index (0..9) to assign.
 * - On every NEW video assignment: reads current persisted index, assigns destination,
 *   atomically advances (index + 1) % 10, and persists to disk.
 * - Retry of failed video locks to original destination and NEVER advances the counter.
 * - Duplicate input / already published video NEVER advances the counter.
 * - 1-to-1 video-to-destination assignment with zero cross-destination duplication.
 * - Complete independence from category keywords or source channel IDs.
 * - Direct load on restart; safe one-time backward-compatible migration for legacy ledgers.
 */

const fs = require("fs");
const path = require("path");
const { generateKoreanCaption } = require("./korean_caption_generator");

const DESTINATION_KEYS = [
  "DESTINATION_1",
  "DESTINATION_2",
  "DESTINATION_3",
  "DESTINATION_4",
  "DESTINATION_5",
  "DESTINATION_6",
  "DESTINATION_7",
  "DESTINATION_8",
  "DESTINATION_9",
  "DESTINATION_10"
];

const DESTINATIONS_META = {
  "DESTINATION_1": { id: "DESTINATION_1", name: "Romantic Vibe", username: "ccsfvk" },
  "DESTINATION_2": { id: "DESTINATION_2", name: "Dating", username: "cccsefk" },
  "DESTINATION_3": { id: "DESTINATION_3", name: "Romance", username: "e5brygh" },
  "DESTINATION_4": { id: "DESTINATION_4", name: "Crotch", username: "ccdjxc" },
  "DESTINATION_5": { id: "DESTINATION_5", name: "Mosa", username: "vsdxda" },
  "DESTINATION_6": { id: "DESTINATION_6", name: "Bunny Girl Cosplay Date", username: "tfccdet" },
  "DESTINATION_7": { id: "DESTINATION_7", name: "Lustful Hostess", username: "sfgfem" },
  "DESTINATION_8": { id: "DESTINATION_8", name: "Concubine", username: "ddkicr" },
  "DESTINATION_9": { id: "DESTINATION_9", name: "Saki Mizumi", username: "cccddghhgf" },
  "DESTINATION_10": { id: "DESTINATION_10", name: "A Muse", username: "bzd4wrf" }
};

class GlobalRoundRobinRouter {
  /**
   * @param {object} [options]
   * @param {Array<string>} [options.destinations]
   * @param {object} [options.ledger] PublishedLedger instance
   * @param {number} [options.initialIndex] Force start index (0..9) for unattached instances
   */
  constructor(options = {}) {
    this.destinations = options.destinations || DESTINATION_KEYS;
    this.destinationsMeta = DESTINATIONS_META;
    this.ledger = options.ledger || null;
    this.assignedDestinations = new Map(); // sourceIdentity -> destinationKey
    this.currentIndex = 0;

    if (this.ledger) {
      this.syncStateFromLedger(this.ledger);
    } else if (typeof options.initialIndex === "number") {
      this.currentIndex = ((options.initialIndex % this.destinations.length) + this.destinations.length) % this.destinations.length;
    }
  }

  /**
   * Syncs state from an authoritative PublishedLedger instance
   * @param {object} ledger 
   */
  syncStateFromLedger(ledger) {
    if (!ledger) return;

    this.ledger = ledger;

    if (Array.isArray(ledger.records)) {
      for (const rec of ledger.records) {
        if (rec.sourceIdentity && rec.destinationChannelId) {
          this.assignedDestinations.set(rec.sourceIdentity, rec.destinationChannelId);
        }
      }
    }

    // Authoritative index is loaded directly from persisted ledger state
    if (typeof ledger.getNextRoundRobinIndex === "function") {
      this.currentIndex = ledger.getNextRoundRobinIndex();
    } else if (typeof ledger.nextRoundRobinIndex === "number") {
      this.currentIndex = ledger.nextRoundRobinIndex;
    }
  }

  /**
   * Returns current destination index representing the NEXT destination to assign
   * @returns {number}
   */
  getCurrentIndex() {
    if (this.ledger && typeof this.ledger.getNextRoundRobinIndex === "function") {
      return this.ledger.getNextRoundRobinIndex();
    }
    return this.currentIndex;
  }

  /**
   * Sets current destination index explicitly
   * @param {number} idx 
   */
  setCurrentIndex(idx) {
    this.currentIndex = ((idx % this.destinations.length) + this.destinations.length) % this.destinations.length;
    if (this.ledger && typeof this.ledger.setNextRoundRobinIndex === "function") {
      this.ledger.setNextRoundRobinIndex(this.currentIndex);
    }
  }

  /**
   * Routes a single item using global round-robin sequence
   * @param {object} item 
   * @returns {object}
   */
  routeItem(item) {
    if (!item || typeof item !== "object") {
      throw new Error("routeItem requires a valid item object");
    }

    const sourceChannelId = String(item.sourceChannelId || "unknown");
    const messageId = String(item.messageId || item.id || "0");
    const sourceIdentity = `${sourceChannelId}:${messageId}`;

    // 1. Check if already successfully published in ledger (SUCCESS duplicate)
    if (this.ledger && this.ledger.isPublished(sourceIdentity)) {
      const priorDest = (this.ledger.getAssignedDestination && this.ledger.getAssignedDestination(sourceIdentity))
        || this.assignedDestinations.get(sourceIdentity)
        || "UNKNOWN";
      return {
        sourceChannelId,
        sourceUsername: item.sourceUsername || "",
        messageId,
        sourceIdentity,
        destinationChannelId: priorDest,
        destinationUsername: this.destinationsMeta[priorDest] ? this.destinationsMeta[priorDest].username : "",
        destinationName: this.destinationsMeta[priorDest] ? this.destinationsMeta[priorDest].name : "",
        status: "SKIPPED_ALREADY_PUBLISHED",
        duplicate: true,
        alreadyPublished: true
      };
    }

    // 2. Check if item has a prior assigned destination lock (e.g. retry after failure)
    let assignedDest = (this.ledger && this.ledger.getAssignedDestination && this.ledger.getAssignedDestination(sourceIdentity))
      || this.assignedDestinations.get(sourceIdentity);
    let assignedIndex = null;
    let isRetry = false;

    if (assignedDest && this.destinations.includes(assignedDest)) {
      assignedIndex = this.destinations.indexOf(assignedDest);
      isRetry = true;
      // RETRY OF ALREADY-ASSIGNED FAILED VIDEO MUST NOT ADVANCE THE GLOBAL COUNTER
    } else {
      // 3. Assign next global round-robin destination from authoritative persisted counter
      if (this.ledger && typeof this.ledger.getNextRoundRobinIndex === "function") {
        assignedIndex = this.ledger.getNextRoundRobinIndex();
        assignedDest = this.destinations[assignedIndex];
        this.assignedDestinations.set(sourceIdentity, assignedDest);

        // Atomically advance and persist next index
        this.ledger.advanceRoundRobinIndex();
        this.currentIndex = this.ledger.getNextRoundRobinIndex();
      } else {
        assignedIndex = this.currentIndex;
        assignedDest = this.destinations[assignedIndex];
        this.assignedDestinations.set(sourceIdentity, assignedDest);

        // In-memory fallback if no ledger attached
        this.currentIndex = (this.currentIndex + 1) % this.destinations.length;
      }
    }

    const destMeta = this.destinationsMeta[assignedDest] || { id: assignedDest, name: assignedDest, username: "" };

    // 4. Generate Korean caption using existing caption engine
    const captionResult = generateKoreanCaption(item, { matchedCategory: destMeta.name });

    return {
      sourceChannelId,
      sourceUsername: item.sourceUsername || "",
      messageId,
      sourceIdentity,
      destinationChannelId: assignedDest,
      destinationUsername: destMeta.username,
      destinationName: destMeta.name,
      destinationIndex: assignedIndex,
      roundRobinNumber: assignedIndex + 1,
      generatedKoreanCaption: captionResult.generatedKoreanCaption,
      captionSource: captionResult.captionSource,
      routingStage: "GLOBAL_ROUND_ROBIN",
      isRetry: isRetry,
      duplicate: false,
      alreadyPublished: false
    };
  }

  /**
   * Routes a batch of candidates deterministically
   * @param {Array<object>} items 
   * @returns {object}
   */
  routeBatch(items = []) {
    const results = {
      totalInput: items.length,
      routed: 0,
      skippedDuplicates: 0,
      destinationCounts: {},
      decisions: []
    };

    for (const d of this.destinations) {
      results.destinationCounts[d] = 0;
    }

    const seenInBatch = new Set();

    for (const item of items) {
      const sourceChannelId = String(item.sourceChannelId || "unknown");
      const messageId = String(item.messageId || item.id || "0");
      const sourceIdentity = `${sourceChannelId}:${messageId}`;

      // In-batch duplicate check (duplicates MUST NOT advance the counter)
      if (seenInBatch.has(sourceIdentity)) {
        results.skippedDuplicates++;
        continue;
      }
      seenInBatch.add(sourceIdentity);

      const decision = this.routeItem(item);
      results.decisions.push(decision);

      if (decision.alreadyPublished || decision.status === "SKIPPED_ALREADY_PUBLISHED") {
        results.skippedDuplicates++;
      } else {
        results.routed++;
        results.destinationCounts[decision.destinationChannelId] = 
          (results.destinationCounts[decision.destinationChannelId] || 0) + 1;
      }
    }

    return results;
  }
}

module.exports = {
  DESTINATION_KEYS,
  DESTINATIONS_META,
  GlobalRoundRobinRouter
};
