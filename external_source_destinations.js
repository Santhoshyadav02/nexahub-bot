/**
 * ============================================================
 * 📡 EXTERNAL SOURCE DESTINATION MAPPINGS
 * ============================================================
 * Maps canonical topicKey to authorized Telegram destination channels/topics.
 * Completely isolated from source_registry.js.
 *
 * Safety Flag:
 * EXTERNAL_PUBLISH_ENABLED=false (default: disabled during development)
 *
 * Destination chat IDs come ONLY from environment variables
 * (EXTERNAL_DEST_MYANMAR, EXTERNAL_DEST_GENERAL, ...). A destination whose
 * variable is unset is `enabled: false` with `destinationChannelId: null` -
 * it is never given a placeholder ID.
 */

const EXTERNAL_PUBLISH_ENABLED = process.env.EXTERNAL_PUBLISH_ENABLED === "true";

const DESTINATION_DEFINITIONS = Object.freeze([
  { topicKey: "Myanmar", koreanName: "미얀마", cardNum: 1, channelIndex: 1, destinationEnvVar: "EXTERNAL_DEST_MYANMAR", destinationUsername: "myanmar_dest" },
  { topicKey: "Evergrande Troupe", koreanName: "헝다 가무단", cardNum: 2, channelIndex: 2, destinationEnvVar: "EXTERNAL_DEST_EVERGRANDE", destinationUsername: "evergrande_dest" },
  { topicKey: "Myanmar Women", koreanName: "미얀마 여성", cardNum: 3, channelIndex: 3, destinationEnvVar: "EXTERNAL_DEST_MYANMAR_WOMEN", destinationUsername: "myanmar_women_dest" },
  { topicKey: "Sister Snake", koreanName: "뱀 누나", cardNum: 4, channelIndex: 4, destinationEnvVar: "EXTERNAL_DEST_SISTER_SNAKE", destinationUsername: "sister_snake_dest" },
  { topicKey: "Has Work", koreanName: "일거리 있음", cardNum: 5, channelIndex: 5, destinationEnvVar: "EXTERNAL_DEST_HAS_WORK", destinationUsername: "has_work_dest" },
  { topicKey: "Bullying & Sex", koreanName: "괴롭힘과 성관계", cardNum: 6, channelIndex: 6, destinationEnvVar: "EXTERNAL_DEST_BULLYING", destinationUsername: "bullying_dest" },
  { topicKey: "Da Ci Ge", koreanName: "다츠거", cardNum: 7, channelIndex: 7, destinationEnvVar: "EXTERNAL_DEST_DACIGE", destinationUsername: "dacige_dest" },
  { topicKey: "Senior Year Love Story", koreanName: "고3 사랑 이야기", cardNum: 8, channelIndex: 8, destinationEnvVar: "EXTERNAL_DEST_SENIOR_YEAR", destinationUsername: "senioryear_dest" },
  { topicKey: "Sichuan Mother & Son", koreanName: "쓰촨 모자", cardNum: 9, channelIndex: 9, destinationEnvVar: "EXTERNAL_DEST_SICHUAN", destinationUsername: "sichuan_dest" },
  { topicKey: "Hu Siyuan", koreanName: "후쓰위안", cardNum: 10, channelIndex: 10, destinationEnvVar: "EXTERNAL_DEST_HU_SIYUAN", destinationUsername: "husiyuan_dest" },
  { topicKey: "Kept Lover", koreanName: "애인으로 부양", cardNum: 11, channelIndex: 1, destinationEnvVar: "EXTERNAL_DEST_KEPT_LOVER", destinationUsername: "keptlover_dest" },
  { topicKey: "Didi Proxy Operation", koreanName: "디디 대리운영", cardNum: 12, channelIndex: 2, destinationEnvVar: "EXTERNAL_DEST_DIDI", destinationUsername: "didiproxy_dest" },
  // Separated fallback channel (does not pollute Channel 1)
  { topicKey: "General", koreanName: "기타 (미분류)", cardNum: null, channelIndex: null, destinationEnvVar: "EXTERNAL_DEST_GENERAL", destinationUsername: "general_fallback_dest" }
]);

/**
 * Reads a destination chat ID from the environment. Unset/blank -> null.
 * @param {string} envVar
 * @param {object} [env=process.env]
 * @returns {string|null}
 */
function readDestinationId(envVar, env = process.env) {
  if (!envVar || !env) return null;
  const raw = env[envVar] !== undefined && env[envVar] !== null ? String(env[envVar]).trim() : "";
  return raw || null;
}

/**
 * Builds the topic -> destination map from an environment object.
 * @param {object} [env=process.env]
 * @returns {Object<string, object>}
 */
function buildTopicDestinations(env = process.env) {
  const map = {};
  for (const def of DESTINATION_DEFINITIONS) {
    const destinationChannelId = readDestinationId(def.destinationEnvVar, env);
    map[def.topicKey] = {
      ...def,
      destinationChannelId,
      enabled: Boolean(destinationChannelId)
    };
  }
  return map;
}

const EXTERNAL_TOPIC_DESTINATIONS = buildTopicDestinations();

/**
 * @param {object} dest
 * @returns {boolean}
 */
function isDestinationEnabled(dest) {
  return Boolean(dest && dest.enabled !== false && dest.destinationChannelId);
}

const warnedDisabledDestinations = new Set();

function warnDisabledDestinationOnce(dest) {
  if (!dest) return;
  const key = dest.destinationEnvVar || dest.topicKey;
  if (warnedDisabledDestinations.has(key)) return;
  warnedDisabledDestinations.add(key);
  console.warn(`⚠️ [EXTERNAL_DEST] Destination for topic "${dest.topicKey}" is DISABLED: ${dest.destinationEnvVar} is not set. Items routed there will not be published.`);
}

/**
 * Resolves destination configuration for a given topicKey.
 * Disabled destinations are still returned (enabled: false, destinationChannelId: null)
 * so callers can skip them explicitly; a one-time warning is logged per destination.
 * @param {string} topicKey
 * @returns {object}
 */
function getDestinationForTopic(topicKey) {
  const dest = EXTERNAL_TOPIC_DESTINATIONS[topicKey] || EXTERNAL_TOPIC_DESTINATIONS["General"];
  if (!isDestinationEnabled(dest)) {
    warnDisabledDestinationOnce(dest);
  }
  return dest;
}

/**
 * @returns {Array<object>} Destinations without a configured chat ID
 */
function getDisabledDestinations() {
  return Object.values(EXTERNAL_TOPIC_DESTINATIONS).filter(d => !isDestinationEnabled(d));
}

module.exports = {
  EXTERNAL_PUBLISH_ENABLED,
  EXTERNAL_TOPIC_DESTINATIONS,
  DESTINATION_DEFINITIONS,
  getDestinationForTopic,
  resolveDestination: getDestinationForTopic,
  isDestinationEnabled,
  getDisabledDestinations,
  readDestinationId,
  buildTopicDestinations
};
