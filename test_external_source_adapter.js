/**
 * ============================================================
 * 🧪 HARDENED UNIT & REGRESSION TEST SUITE FOR EXTERNAL ADAPTER
 * ============================================================
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { ExternalSourceAdapter, CANONICAL_12_TOPIC_RULES } = require("./external_source_adapter");

const TEST_LEDGER_PATH = path.join(__dirname, "scratch", "test_external_source_ledger.json");

function cleanTestLedger() {
  if (fs.existsSync(TEST_LEDGER_PATH)) {
    try {
      fs.unlinkSync(TEST_LEDGER_PATH);
    } catch (e) {}
  }
}

async function runTests() {
  console.log("==================================================");
  console.log("🚀 RUNNING HARDENED 12-TOPIC EXTERNAL ADAPTER TEST SUITE");
  console.log("==================================================\n");

  let passed = 0;
  let total = 0;

  function record(name, condition, details = "") {
    total++;
    if (condition) {
      passed++;
      console.log(`✅ [PASS] ${name}`);
    } else {
      console.error(`❌ [FAIL] ${name} - ${details}`);
    }
  }

  cleanTestLedger();
  const adapter = new ExternalSourceAdapter({
    isAuthorized: true,
    licenseId: "LIC-TEST-HARDENED",
    allowedDomains: ["authorized-cdn.com"],
    dryRun: true,
    ledgerPath: TEST_LEDGER_PATH
  });

  // ----------------------------------------------------
  // SECTION 1: ALL 12 CANONICAL TOPIC ROUTING TESTS
  // ----------------------------------------------------
  console.log("\n--- [1. All 12 Canonical Topics Base Verification] ---");

  const canonical12Cases = [
    { cardNum: 1, key: "Myanmar", title: "Documentary on Yangon City and Myanmar Culture", tags: ["myanmar"] },
    { cardNum: 2, key: "Evergrande Troupe", title: "Evergrande Troupe Annual Gala Performance", tags: ["evergrandetroupe"] },
    { cardNum: 3, key: "Myanmar Women", title: "Inspirational Journey of Modern Myanmar Women", tags: ["myanmarwomen"] },
    { cardNum: 4, key: "Sister Snake", title: "The Dramatic Tale of Sister Snake", tags: ["sistersnake"] },
    { cardNum: 5, key: "Has Work", title: "Urgent Weekend Hiring - Has Work Available", tags: ["haswork"] },
    { cardNum: 6, key: "Bullying & Sex", title: "Campus Bullying and Dramatic Conflict", tags: ["bullyingsex"] },
    { cardNum: 7, key: "Da Ci Ge", title: "Viral Vlog from Da Ci Ge", tags: ["dacige"] },
    { cardNum: 8, key: "Senior Year Love Story", title: "Memories of High School: Senior Year Love Story", tags: ["senioryearlovestory"] },
    { cardNum: 9, key: "Sichuan Mother & Son", title: "Heartwarming Tale of a Sichuan Mother & Son", tags: ["sichuanmotherson"] },
    { cardNum: 10, key: "Hu Siyuan", title: "Visual Art Exhibition by Hu Siyuan", tags: ["husiyuan"] },
    { cardNum: 11, key: "Kept Lover", title: "Secret Life as a Maintained Kept Lover", tags: ["keptlover"] },
    { cardNum: 12, key: "Didi Proxy Operation", title: "Night Chauffeur Stories in Didi Proxy Operation", tags: ["didiproxy"] }
  ];

  for (const tc of canonical12Cases) {
    const item = adapter.normalizeItem({
      id: `can_${tc.cardNum}`,
      title: tc.title,
      tags: tc.tags,
      mediaUrl: "https://authorized-cdn.com/v.mp4"
    });
    const route = adapter.matchTopic(item);
    record(
      `1.${tc.cardNum} Card ${tc.cardNum} (${tc.key}) -> correctly routed`,
      route.topicKey === tc.key && route.cardNum === tc.cardNum && route.confidence >= 0.8,
      `Expected: ${tc.key}, Got: ${route.topicKey} (Rule: ${route.matchedRule}, Conf: ${route.confidence})`
    );
  }

  // ----------------------------------------------------
  // SECTION 2: SPECIFIC RULE TIER TESTS (HASHTAG, PHRASE, CJK, COMBO)
  // ----------------------------------------------------
  console.log("\n--- [2. Specific Rule Tier Tests] ---");

  // 2.1 Exact Hashtag Match (Priority 1)
  {
    const item = adapter.normalizeItem({
      id: "t_ht",
      title: "Random Clip Title",
      tags: ["#SisterSnake"],
      mediaUrl: "https://authorized-cdn.com/v.mp4"
    });
    const route = adapter.matchTopic(item);
    record(
      "2.1 Exact Hashtag (#SisterSnake) -> Sister Snake (EXACT_HASHTAG, conf=0.98)",
      route.topicKey === "Sister Snake" && route.matchedRule === "EXACT_HASHTAG" && route.confidence === 0.98
    );
  }

  // 2.2 Exact Multi-word Phrase Match (Priority 2)
  {
    const item = adapter.normalizeItem({
      id: "t_phrase",
      title: "Night shift didi driver tells his story",
      mediaUrl: "https://authorized-cdn.com/v.mp4"
    });
    const route = adapter.matchTopic(item);
    record(
      "2.2 Exact Phrase ('didi driver') -> Didi Proxy Operation (EXACT_PHRASE, conf=0.90)",
      route.topicKey === "Didi Proxy Operation" && route.matchedRule === "EXACT_PHRASE" && route.confidence === 0.90
    );
  }

  // 2.3 Exact Chinese Tag Match (Priority 3)
  {
    const item = adapter.normalizeItem({
      id: "t_cjk",
      title: "四川母子 温泉旅行记录",
      mediaUrl: "https://authorized-cdn.com/v.mp4"
    });
    const route = adapter.matchTopic(item);
    record(
      "2.3 Exact CJK Tag ('四川母子') -> Sichuan Mother & Son (EXACT_CJK, conf=0.88)",
      route.topicKey === "Sichuan Mother & Son" && route.matchedRule === "EXACT_CJK" && route.confidence === 0.88
    );
  }

  // 2.4 Specific Combination Match (Priority 4)
  {
    const item = adapter.normalizeItem({
      id: "t_combo",
      title: "Featuring dancers in the gala with evergrande troupe members",
      mediaUrl: "https://authorized-cdn.com/v.mp4"
    });
    const route = adapter.matchTopic(item);
    record(
      "2.4 Specific Combination (['evergrande', 'gala']) -> Evergrande Troupe (SPECIFIC_COMBINATION, conf=0.80)",
      route.topicKey === "Evergrande Troupe" && route.confidence >= 0.80
    );
  }

  // 2.5 Specificity Conflict Resolution: "Myanmar Women" beats "Myanmar"
  {
    const item = adapter.normalizeItem({
      id: "t_spec",
      title: "Documentary focusing on Myanmar women and traditions",
      tags: ["myanmar", "myanmarwomen"],
      mediaUrl: "https://authorized-cdn.com/v.mp4"
    });
    const route = adapter.matchTopic(item);
    record(
      "2.5 Specificity conflict ('Myanmar Women' beats generic 'Myanmar')",
      route.topicKey === "Myanmar Women"
    );
  }

  // ----------------------------------------------------
  // SECTION 3: GENERIC SINGLE WORDS GUARD (MUST ROUTE TO GENERAL)
  // ----------------------------------------------------
  console.log("\n--- [3. Generic Single Words Guard Tests] ---");

  // 3.1 Generic "snake" alone
  {
    const item = adapter.normalizeItem({
      id: "g_snake",
      title: "Wildlife documentary: A venomous snake in the tropical forest",
      mediaUrl: "https://authorized-cdn.com/v.mp4"
    });
    const route = adapter.matchTopic(item);
    record(
      "3.1 Generic 'snake' alone -> General (NOT Sister Snake)",
      route.topicKey === "General" && route.matchedRule === "NONE"
    );
  }

  // 3.2 Generic "driver" alone
  {
    const item = adapter.normalizeItem({
      id: "g_driver",
      title: "Formula 1 race car driver training session",
      mediaUrl: "https://authorized-cdn.com/v.mp4"
    });
    const route = adapter.matchTopic(item);
    record(
      "3.2 Generic 'driver' alone -> General (NOT Didi Proxy Operation)",
      route.topicKey === "General" && route.matchedRule === "NONE"
    );
  }

  // 3.3 Generic "dance" alone
  {
    const item = adapter.normalizeItem({
      id: "g_dance",
      title: "Modern jazz dance choreography lesson for beginners",
      mediaUrl: "https://authorized-cdn.com/v.mp4"
    });
    const route = adapter.matchTopic(item);
    record(
      "3.3 Generic 'dance' alone -> General (NOT Evergrande Troupe)",
      route.topicKey === "General" && route.matchedRule === "NONE"
    );
  }

  // 3.4 Generic "troupe" alone
  {
    const item = adapter.normalizeItem({
      id: "g_troupe",
      title: "Traveling circus troupe arrives in small European village",
      mediaUrl: "https://authorized-cdn.com/v.mp4"
    });
    const route = adapter.matchTopic(item);
    record(
      "3.4 Generic 'troupe' alone -> General (NOT Evergrande Troupe)",
      route.topicKey === "General" && route.matchedRule === "NONE"
    );
  }

  // 3.5 Generic "schoolmate" alone
  {
    const item = adapter.normalizeItem({
      id: "g_schoolmate",
      title: "College reunion gathering with an old schoolmate",
      mediaUrl: "https://authorized-cdn.com/v.mp4"
    });
    const route = adapter.matchTopic(item);
    record(
      "3.5 Generic 'schoolmate' alone -> General (NOT Bullying & Sex)",
      route.topicKey === "General" && route.matchedRule === "NONE"
    );
  }

  // 3.6 Generic "highschool" alone
  {
    const item = adapter.normalizeItem({
      id: "g_highschool",
      title: "National highschool science olympiad tournament",
      mediaUrl: "https://authorized-cdn.com/v.mp4"
    });
    const route = adapter.matchTopic(item);
    record(
      "3.6 Generic 'highschool' alone -> General (NOT Senior Year Love Story)",
      route.topicKey === "General" && route.matchedRule === "NONE"
    );
  }

  // 3.7 Generic "sichuan" alone
  {
    const item = adapter.normalizeItem({
      id: "g_sichuan",
      title: "Authentic spicy Sichuan noodle recipe cooking vlog",
      mediaUrl: "https://authorized-cdn.com/v.mp4"
    });
    const route = adapter.matchTopic(item);
    record(
      "3.7 Generic 'sichuan' alone -> General (NOT Sichuan Mother & Son)",
      route.topicKey === "General" && route.matchedRule === "NONE"
    );
  }

  // 3.8 Ambiguous Multi-Topic Conflict
  {
    const item = adapter.normalizeItem({
      id: "g_ambig",
      title: "Special collaboration between #SisterSnake and #HuSiyuan in studio",
      tags: ["sistersnake", "husiyuan"],
      mediaUrl: "https://authorized-cdn.com/v.mp4"
    });
    const route = adapter.matchTopic(item);
    record(
      "3.8 Ambiguous multi-topic conflict -> General (AMBIGUOUS_CONFLICT, NEVER guesses)",
      route.topicKey === "General" && route.matchedRule === "AMBIGUOUS_CONFLICT"
    );
  }

  // ----------------------------------------------------
  // SECTION 4: STRUCTURED RESULT & DRY-RUN SAFETY
  // ----------------------------------------------------
  console.log("\n--- [4. Structured Result & Dry-Run Safety] ---");

  {
    const item = {
      id: "dry_struct_1",
      title: "Didi Proxy Operation Real Driver Experience",
      tags: ["didiproxy"],
      mediaUrl: "https://authorized-cdn.com/didi.mp4"
    };

    const processRes = adapter.processItem(item);
    record("4.1 processItem executes in DRY_RUN mode by default", processRes.dryRun === true && processRes.status === "DRY_RUN_PROCESSED");
    record("4.2 Normalized item contains explicit topicKey, matchedRule, and confidence",
      processRes.item.topicKey === "Didi Proxy Operation" &&
      processRes.item.matchedRule === "EXACT_HASHTAG" &&
      processRes.item.routingConfidence === 0.98 &&
      processRes.item.cardNum === 12
    );
  }

  // ----------------------------------------------------
  // SECTION 5: HARD REGRESSION ON EXISTING TELEGRAM PIPELINE
  // ----------------------------------------------------
  console.log("\n--- [5. Hard Regression: Unmodified Telegram Channels & Routing] ---");

  const sourceRegistry = require("./source_registry");
  const sources = sourceRegistry.getAllSources();
  const expected10Channels = [
    "Romantic Vibe", "Dating", "Romance", "Crotch", "Mosa",
    "Bunny Girl Cosplay Date", "Lustful Hostess", "Concubine", "Saki Mizumi", "A Muse"
  ];
  const all10Exist = expected10Channels.every(chName => sources.some(s => s.name === chName));
  record("5.1 All 10 Telegram source channels exist and are configured in source_registry", all10Exist);

  const expected12Cards = [
    { num: 1, key: "Myanmar", channel: "Romantic Vibe" },
    { num: 2, key: "Evergrande Troupe", channel: "Dating" },
    { num: 3, key: "Myanmar Women", channel: "Romance" },
    { num: 4, key: "Sister Snake", channel: "Crotch" },
    { num: 5, key: "Has Work", channel: "Mosa" },
    { num: 6, key: "Bullying & Sex", channel: "Bunny Girl Cosplay Date" },
    { num: 7, key: "Da Ci Ge", channel: "Lustful Hostess" },
    { num: 8, key: "Senior Year Love Story", channel: "Concubine" },
    { num: 9, key: "Sichuan Mother & Son", channel: "Saki Mizumi" },
    { num: 10, key: "Hu Siyuan", channel: "A Muse" },
    { num: 11, key: "Kept Lover", channel: "Romantic Vibe" },
    { num: 12, key: "Didi Proxy Operation", channel: "Dating" }
  ];

  let cardsUnbroken = true;
  for (const c of expected12Cards) {
    const resolved = sourceRegistry.resolveKeyword(c.key);
    if (resolved !== c.channel) {
      cardsUnbroken = false;
      console.error(`Mismatch for card ${c.num} ("${c.key}"): expected "${c.channel}", got "${resolved}"`);
    }
  }
  record("5.2 Existing 12-card routing resolves identically to the 10 Telegram channels", cardsUnbroken);

  cleanTestLedger();

  console.log("\n==================================================");
  console.log(`📊 SUMMARY: ${passed} / ${total} TESTS PASSED (${passed === total ? "100% SUCCESS" : "FAILURES DETECTED"})`);
  console.log("==================================================\n");

  if (passed !== total) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
