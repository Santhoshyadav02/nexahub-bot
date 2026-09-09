/**
 * ============================================================
 * 📡 EXTERNAL SOURCE DESTINATION MAPPINGS
 * ============================================================
 * Maps canonical topicKey to authorized Telegram destination channels/topics.
 * Completely isolated from source_registry.js.
 * 
 * Safety Flag:
 * EXTERNAL_PUBLISH_ENABLED=false (default: disabled during development)
 */

const EXTERNAL_PUBLISH_ENABLED = process.env.EXTERNAL_PUBLISH_ENABLED === "true";

const EXTERNAL_TOPIC_DESTINATIONS = {
  "Myanmar": {
    topicKey: "Myanmar",
    koreanName: "미얀마",
    cardNum: 1,
    channelIndex: 1,
    destinationChannelId: process.env.EXTERNAL_DEST_MYANMAR || "-1002000000001",
    destinationUsername: "myanmar_dest"
  },
  "Evergrande Troupe": {
    topicKey: "Evergrande Troupe",
    koreanName: "헝다 가무단",
    cardNum: 2,
    channelIndex: 2,
    destinationChannelId: process.env.EXTERNAL_DEST_EVERGRANDE || "-1002000000002",
    destinationUsername: "evergrande_dest"
  },
  "Myanmar Women": {
    topicKey: "Myanmar Women",
    koreanName: "미얀마 여성",
    cardNum: 3,
    channelIndex: 3,
    destinationChannelId: process.env.EXTERNAL_DEST_MYANMAR_WOMEN || "-1002000000003",
    destinationUsername: "myanmar_women_dest"
  },
  "Sister Snake": {
    topicKey: "Sister Snake",
    koreanName: "뱀 누나",
    cardNum: 4,
    channelIndex: 4,
    destinationChannelId: process.env.EXTERNAL_DEST_SISTER_SNAKE || "-1002000000004",
    destinationUsername: "sister_snake_dest"
  },
  "Has Work": {
    topicKey: "Has Work",
    koreanName: "일거리 있음",
    cardNum: 5,
    channelIndex: 5,
    destinationChannelId: process.env.EXTERNAL_DEST_HAS_WORK || "-1002000000005",
    destinationUsername: "has_work_dest"
  },
  "Bullying & Sex": {
    topicKey: "Bullying & Sex",
    koreanName: "괴롭힘과 성관계",
    cardNum: 6,
    channelIndex: 6,
    destinationChannelId: process.env.EXTERNAL_DEST_BULLYING || "-1002000000006",
    destinationUsername: "bullying_dest"
  },
  "Da Ci Ge": {
    topicKey: "Da Ci Ge",
    koreanName: "다츠거",
    cardNum: 7,
    channelIndex: 7,
    destinationChannelId: process.env.EXTERNAL_DEST_DACIGE || "-1002000000007",
    destinationUsername: "dacige_dest"
  },
  "Senior Year Love Story": {
    topicKey: "Senior Year Love Story",
    koreanName: "고3 사랑 이야기",
    cardNum: 8,
    channelIndex: 8,
    destinationChannelId: process.env.EXTERNAL_DEST_SENIOR_YEAR || "-1002000000008",
    destinationUsername: "senioryear_dest"
  },
  "Sichuan Mother & Son": {
    topicKey: "Sichuan Mother & Son",
    koreanName: "쓰촨 모자",
    cardNum: 9,
    channelIndex: 9,
    destinationChannelId: process.env.EXTERNAL_DEST_SICHUAN || "-1002000000009",
    destinationUsername: "sichuan_dest"
  },
  "Hu Siyuan": {
    topicKey: "Hu Siyuan",
    koreanName: "후쓰위안",
    cardNum: 10,
    channelIndex: 10,
    destinationChannelId: process.env.EXTERNAL_DEST_HU_SIYUAN || "-1002000000010",
    destinationUsername: "husiyuan_dest"
  },
  "Kept Lover": {
    topicKey: "Kept Lover",
    koreanName: "애인으로 부양",
    cardNum: 11,
    channelIndex: 1,
    destinationChannelId: process.env.EXTERNAL_DEST_KEPT_LOVER || "-1002000000001",
    destinationUsername: "keptlover_dest"
  },
  "Didi Proxy Operation": {
    topicKey: "Didi Proxy Operation",
    koreanName: "디디 대리운영",
    cardNum: 12,
    channelIndex: 2,
    destinationChannelId: process.env.EXTERNAL_DEST_DIDI || "-1002000000002",
    destinationUsername: "didiproxy_dest"
  },
  "General": {
    topicKey: "General",
    koreanName: "기타 (미분류)",
    cardNum: null,
    channelIndex: null, // Separated fallback channel (does not pollute Channel 1)
    destinationChannelId: process.env.EXTERNAL_DEST_GENERAL || "-1002000000000",
    destinationUsername: "general_fallback_dest"
  }
};

/**
 * Resolves destination configuration for a given topicKey
 * @param {string} topicKey 
 * @returns {object}
 */
function getDestinationForTopic(topicKey) {
  return EXTERNAL_TOPIC_DESTINATIONS[topicKey] || EXTERNAL_TOPIC_DESTINATIONS["General"];
}

module.exports = {
  EXTERNAL_PUBLISH_ENABLED,
  EXTERNAL_TOPIC_DESTINATIONS,
  getDestinationForTopic,
  resolveDestination: getDestinationForTopic
};
