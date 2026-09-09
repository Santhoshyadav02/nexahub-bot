/**
 * ============================================================
 * 🧪 TEST SUITE: EXTERNAL SOURCE PIPELINE & 30-MINUTE POLLING
 * ============================================================
 * Comprehensive verification covering:
 * A. Strongly classifiable source item routes to correct destination.
 * B. Another source category routes correctly.
 * C. Multi-tag item chooses the strongest destination.
 * D. Ambiguous item remains General/Fallback.
 * E. Generic single keyword does NOT incorrectly route an item.
 * F. All 10 destination configurations remain valid.
 * G. Global pool never exceeds 150.
 * H. Duplicate item is never queued twice.
 * I. Second identical source scan produces 0 new items.
 * J. Scheduler remains exactly 30 minutes.
 * K. Existing production 12-card regression tests remain passing.
 * L. Publishing remains disabled.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { ExternalSourceAdapter } = require("./external_source_adapter");
const { ExternalSourcePublisher } = require("./external_source_publisher");
const { ExternalSourceState, MAX_GLOBAL_RETENTION } = require("./external_source_state");
const { ExternalSourcePipeline, POLLING_INTERVAL_MS } = require("./external_source_pipeline");
const { EXTERNAL_PUBLISH_ENABLED, EXTERNAL_TOPIC_DESTINATIONS, getDestinationForTopic } = require("./external_source_destinations");

const TEST_STATE_PATH = path.join(__dirname, "scratch", "test_pipeline_state.json");

function cleanupTestState() {
  if (fs.existsSync(TEST_STATE_PATH)) {
    try {
      fs.unlinkSync(TEST_STATE_PATH);
    } catch (e) {}
  }
}

async function runTests() {
  console.log("==================================================");
  console.log("🚀 RUNNING EXTERNAL SOURCE PIPELINE & ROUTING TEST SUITE");
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

  cleanupTestState();

  const stateStore = new ExternalSourceState({
    stateFilePath: TEST_STATE_PATH,
    maxTotalItems: 150
  });

  const adapter = new ExternalSourceAdapter({
    isAuthorized: true,
    licenseId: "LIC-TEST-PIPELINE",
    allowedDomains: ["authorized-cdn.com"],
    dryRun: true
  });

  const publisher = new ExternalSourcePublisher({
    stateStore: stateStore,
    maxTotalItems: 150,
    publishEnabled: false
  });

  const pipeline = new ExternalSourcePipeline({
    adapter: adapter,
    publisher: publisher,
    stateStore: stateStore,
    pollingIntervalMs: 30 * 60 * 1000,
    maxTotalItems: 150,
    dryRun: true
  });

  // ----------------------------------------------------
  // SECTION A: Strongly classifiable source item routes to correct destination
  // ----------------------------------------------------
  const itemA = adapter.normalizeItem({
    id: "item_a_milf",
    title: "아름다운 미시 유부녀 주부의 은밀한 이야기",
    tags: ["유부녀・주부", "미시", "숙녀"],
    mediaUrl: "https://authorized-cdn.com/a.mp4"
  });
  const routeA = adapter.matchTopic(itemA);
  const destA = getDestinationForTopic(routeA.topicKey);
  record(
    "A. Strongly classifiable source item routes to correct destination (Sister Snake / Channel 4)",
    routeA.topicKey === "Sister Snake" && destA.channelIndex === 4 && routeA.confidence >= 0.88
  );

  // ----------------------------------------------------
  // SECTION B: Another source category routes correctly
  // ----------------------------------------------------
  const itemB = adapter.normalizeItem({
    id: "item_b_massage",
    title: "강남 마사지 업소 스웨디시 힐링 코스 리뷰",
    tags: ["마사지 업소", "스웨디시", "유흥"],
    mediaUrl: "https://authorized-cdn.com/b.mp4"
  });
  const routeB = adapter.matchTopic(itemB);
  const destB = getDestinationForTopic(routeB.topicKey);
  record(
    "B. Another source category routes correctly (Da Ci Ge / Channel 7)",
    routeB.topicKey === "Da Ci Ge" && destB.channelIndex === 7 && routeB.confidence >= 0.88
  );

  // ----------------------------------------------------
  // SECTION C: Multi-tag item chooses the strongest destination
  // ----------------------------------------------------
  const itemC = adapter.normalizeItem({
    id: "item_c_bj",
    title: "인기 한국 BJ 벗방 개인방송 직찍 유출",
    tags: ["korea", "bj", "방송", "일탈녀"],
    mediaUrl: "https://authorized-cdn.com/c.mp4"
  });
  const routeC = adapter.matchTopic(itemC);
  const destC = getDestinationForTopic(routeC.topicKey);
  record(
    "C. Multi-tag item chooses strongest destination (Myanmar Women / Channel 3)",
    routeC.topicKey === "Myanmar Women" && destC.channelIndex === 3 && routeC.confidence >= 0.80
  );

  // ----------------------------------------------------
  // SECTION D: Ambiguous item remains General/Fallback
  // ----------------------------------------------------
  const itemD = adapter.normalizeItem({
    id: "item_d_ambig",
    title: "집들이 문제 어떻게 해결하나요? 고민 상담",
    tags: ["korea"],
    mediaUrl: "https://authorized-cdn.com/d.mp4"
  });
  const routeD = adapter.matchTopic(itemD);
  const destD = getDestinationForTopic(routeD.topicKey);
  record(
    "D. Ambiguous item remains General/Fallback (confidence=0.10, rule=NONE)",
    routeD.topicKey === "General" && routeD.confidence === 0.10 && destD.topicKey === "General"
  );

  // ----------------------------------------------------
  // SECTION E: Generic single keyword does NOT incorrectly route an item
  // ----------------------------------------------------
  const itemE1 = adapter.normalizeItem({ id: "e1", title: "Amazon forest snake documentary", mediaUrl: "https://authorized-cdn.com/e1.mp4" });
  const itemE2 = adapter.normalizeItem({ id: "e2", title: "Formula race driver training", mediaUrl: "https://authorized-cdn.com/e2.mp4" });
  const itemE3 = adapter.normalizeItem({ id: "e3", title: "Spicy sichuan food vlog", mediaUrl: "https://authorized-cdn.com/e3.mp4" });
  record(
    "E. Generic single keyword does NOT incorrectly route an item",
    adapter.matchTopic(itemE1).topicKey === "General" &&
    adapter.matchTopic(itemE2).topicKey === "General" &&
    adapter.matchTopic(itemE3).topicKey === "General"
  );

  // ----------------------------------------------------
  // SECTION F: All 10 destination configurations remain valid
  // ----------------------------------------------------
  const allDestinationsConfigured = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].every(idx => {
    return Object.values(EXTERNAL_TOPIC_DESTINATIONS).some(d => d.channelIndex === idx && d.destinationChannelId);
  });
  record(
    "F. All 10 destination configurations remain valid",
    allDestinationsConfigured === true
  );

  // ----------------------------------------------------
  // SECTION G: Global pool never exceeds 150
  // ----------------------------------------------------
  const bulkItems = [];
  for (let i = 1; i <= 200; i++) {
    bulkItems.push({
      id: `bulk_item_${i}`,
      title: `Bulk Test Item ${i}`,
      mediaUrl: `https://authorized-cdn.com/bulk_${i}.mp4`
    });
  }
  await pipeline.runInitialBackfill({ sourceItems: bulkItems });
  const poolAfterBulk = stateStore.getRetainedPool();
  record(
    "G. Global pool never exceeds 150 (Total pool === 150)",
    poolAfterBulk.length === 150 && stateStore.retainedPool.length === 150
  );

  // ----------------------------------------------------
  // SECTION H: Duplicate item is never queued twice
  // ----------------------------------------------------
  const duplicateItem = bulkItems[0];
  const reQueueRes = await pipeline.runPollingCycle({ sourceItems: [duplicateItem] });
  record(
    "H. Duplicate item is never queued twice (new=0, skippedDuplicate=1)",
    reQueueRes.newItems === 0 && reQueueRes.queued === 0 && reQueueRes.skippedDuplicate === 1
  );

  // ----------------------------------------------------
  // SECTION I: Second identical source scan produces 0 new items
  // ----------------------------------------------------
  const secondScanRes = await pipeline.runPollingCycle({ sourceItems: bulkItems });
  record(
    "I. Second identical source scan produces 0 new items",
    secondScanRes.newItems === 0 && secondScanRes.queued === 0 && secondScanRes.skippedDuplicate === bulkItems.length
  );

  // ----------------------------------------------------
  // SECTION J: Scheduler remains exactly 30 minutes
  // ----------------------------------------------------
  record(
    "J. Scheduler interval is exactly 30 minutes (1,800,000 ms)",
    POLLING_INTERVAL_MS === 30 * 60 * 1000 && pipeline.pollingIntervalMs === 1800000
  );

  // ----------------------------------------------------
  // SECTION K: Existing production 12-card regression tests remain passing
  // ----------------------------------------------------
  const sourceRegistry = require("./source_registry");
  const sources = sourceRegistry.getAllSources();
  const expected10Channels = [
    "Romantic Vibe", "Dating", "Romance", "Crotch", "Mosa",
    "Bunny Girl Cosplay Date", "Lustful Hostess", "Concubine", "Saki Mizumi", "A Muse"
  ];
  const all10Exist = expected10Channels.every(chName => sources.some(s => s.name === chName));

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
    }
  }

  record(
    "K. Existing production 12-card regression tests remain passing",
    all10Exist && cardsUnbroken
  );

  // ----------------------------------------------------
  // SECTION L: Publishing remains disabled
  // ----------------------------------------------------
  record(
    "L. Publishing remains disabled (EXTERNAL_PUBLISH_ENABLED=false, publisher.publishEnabled=false)",
    EXTERNAL_PUBLISH_ENABLED === false && publisher.publishEnabled === false
  );

  // ----------------------------------------------------
  // SECTION M: Process Restart Simulation & Delta Detection (A,B,C -> restart -> A,B,C,D)
  // ----------------------------------------------------
  const restartStatePath = path.join(__dirname, "scratch", "test_restart_state.json");
  if (fs.existsSync(restartStatePath)) try { fs.unlinkSync(restartStatePath); } catch (e) {}

  // Process 1: Ingests A, B, C
  const store1 = new ExternalSourceState({ stateFilePath: restartStatePath, maxTotalItems: 150 });
  const pub1 = new ExternalSourcePublisher({ stateStore: store1, publishEnabled: false });
  const pipe1 = new ExternalSourcePipeline({ adapter: adapter, publisher: pub1, stateStore: store1 });

  const initialItems = [
    { id: "item_A", title: "Item A Title", mediaUrl: "https://authorized-cdn.com/a.mp4" },
    { id: "item_B", title: "Item B Title", mediaUrl: "https://authorized-cdn.com/b.mp4" },
    { id: "item_C", title: "Item C Title", mediaUrl: "https://authorized-cdn.com/c.mp4" }
  ];
  await pipe1.runInitialBackfill({ sourceItems: initialItems });

  // Process 2: Node Restart -> New pipeline instance loads saved state from disk
  const store2 = new ExternalSourceState({ stateFilePath: restartStatePath, maxTotalItems: 150 });
  const pub2 = new ExternalSourcePublisher({ stateStore: store2, publishEnabled: false });
  const pipe2 = new ExternalSourcePipeline({ adapter: adapter, publisher: pub2, stateStore: store2 });

  // Next scan finds A, B, C, D
  const updatedItems = [
    { id: "item_A", title: "Item A Title", mediaUrl: "https://authorized-cdn.com/a.mp4" },
    { id: "item_B", title: "Item B Title", mediaUrl: "https://authorized-cdn.com/b.mp4" },
    { id: "item_C", title: "Item C Title", mediaUrl: "https://authorized-cdn.com/c.mp4" },
    { id: "item_D", title: "Item D Brand New Title", mediaUrl: "https://authorized-cdn.com/d.mp4" }
  ];
  const deltaRes = await pipe2.runPollingCycle({ sourceItems: updatedItems });

  record(
    "M. Process restart preserves state & delta poll detects only new item (new=1, queued=1, dupes=3)",
    deltaRes.newItems === 1 && deltaRes.queued === 1 && deltaRes.skippedDuplicate === 3
  );

  if (fs.existsSync(restartStatePath)) try { fs.unlinkSync(restartStatePath); } catch (e) {}

  // ----------------------------------------------------
  // SECTION N: Singleton Protection & Non-blocking Error Isolation
  // ----------------------------------------------------
  const { getPipelineInstance } = require("./external_source_pipeline");
  const instance1 = getPipelineInstance();
  const instance2 = getPipelineInstance();
  const isSameInstance = instance1 === instance2;

  // Double start protection
  instance1.startScheduler({ immediate: false });
  const timerBefore = instance1.timerId;
  instance1.startScheduler({ immediate: false });
  const timerAfter = instance1.timerId;
  const timerNotDuplicated = timerBefore === timerAfter;
  instance1.stopScheduler();

  record(
    "N. Singleton instance & timer protection intact (single timer, non-duplicated)",
    isSameInstance && timerNotDuplicated
  );

  // ----------------------------------------------------
  // SECTION O: External 15-Item Daily Quota & Partial Fill Capping (14 existing + 10 new -> 1 accepted)
  // ----------------------------------------------------
  const quotaStatePath = path.join(__dirname, "scratch", "test_quota_state.json");
  if (fs.existsSync(quotaStatePath)) try { fs.unlinkSync(quotaStatePath); } catch (e) {}

  const qStore = new ExternalSourceState({ stateFilePath: quotaStatePath, maxTotalItems: 150, externalDailyTarget: 15 });
  const qPub = new ExternalSourcePublisher({ stateStore: qStore, publishEnabled: false });
  const qPipe = new ExternalSourcePipeline({ adapter: adapter, publisher: qPub, stateStore: qStore });

  // Simulate 14 items already delivered today
  for (let i = 1; i <= 14; i++) {
    qStore.recordExternalDelivery({ id: `pre_delivered_${i}`, title: `Pre ${i}`, mediaUrl: `https://authorized-cdn.com/pre_${i}.mp4` });
  }
  const remainingBeforeNew = qStore.getExternalRemainingQuota(); // 15 - 14 = 1

  // Receive 10 brand new items
  const tenNewItems = [];
  for (let i = 1; i <= 10; i++) {
    tenNewItems.push({ id: `ten_new_${i}`, title: `Ten New ${i}`, mediaUrl: `https://authorized-cdn.com/ten_${i}.mp4` });
  }
  const partialRes = await qPipe.runPollingCycle({ sourceItems: tenNewItems });

  record(
    "O. Partial quota fill: target=15, existing=14, new=10 -> only 1 delivered, 9 undispatched",
    remainingBeforeNew === 1 && partialRes.queued === 1 && qStore.externalDeliveredToday === 15 && qStore.getExternalRemainingQuota() === 0
  );

  // ----------------------------------------------------
  // SECTION P: Older Never-Delivered Fallback Selection (Excludes previously delivered A,B; Selects C,D,E)
  // ----------------------------------------------------
  const fbStatePath = path.join(__dirname, "scratch", "test_fb_state.json");
  if (fs.existsSync(fbStatePath)) try { fs.unlinkSync(fbStatePath); } catch (e) {}

  const fbStore = new ExternalSourceState({ stateFilePath: fbStatePath, maxTotalItems: 150, externalDailyTarget: 15 });
  const fbPub = new ExternalSourcePublisher({ stateStore: fbStore, publishEnabled: false });
  const fbPipe = new ExternalSourcePipeline({ adapter: adapter, publisher: fbPub, stateStore: fbStore });

  // 10 items already delivered today
  for (let i = 1; i <= 10; i++) {
    fbStore.recordExternalDelivery({ id: `fb_delivered_${i}`, title: `Delivered ${i}`, mediaUrl: `https://authorized-cdn.com/d_${i}.mp4` });
  }

  // Catalog contains A, B (delivered) and C, D, E (never delivered)
  fbStore.recordPermanentItem({ id: "item_A", title: "Item A", mediaUrl: "https://authorized-cdn.com/a.mp4" }, { isDelivered: true, status: "DELIVERED" });
  fbStore.recordPermanentItem({ id: "item_B", title: "Item B", mediaUrl: "https://authorized-cdn.com/b.mp4" }, { isDelivered: true, status: "DELIVERED" });
  fbStore.recordPermanentItem({ id: "item_C", title: "Item C", mediaUrl: "https://authorized-cdn.com/c.mp4" }, { isDelivered: false, status: "DISCOVERED" });
  fbStore.recordPermanentItem({ id: "item_D", title: "Item D", mediaUrl: "https://authorized-cdn.com/d.mp4" }, { isDelivered: false, status: "DISCOVERED" });
  fbStore.recordPermanentItem({ id: "item_E", title: "Item E", mediaUrl: "https://authorized-cdn.com/e.mp4" }, { isDelivered: false, status: "DISCOVERED" });

  // Scan with 0 new items
  const fbRes = await fbPipe.runPollingCycle({ sourceItems: [] });

  record(
    "P. Fallback selects only never-delivered items (C,D,E selected = 3, delivered count = 13/15)",
    fbRes.newItems === 0 && fbRes.fallbackCandidates === 3 && fbRes.fallbackDelivered === 3 && fbStore.externalDeliveredToday === 13
  );

  // ----------------------------------------------------
  // SECTION Q: 15-Item Quota per Telegram Source Channel (10 independent channels)
  // ----------------------------------------------------
  const chStatePath = path.join(__dirname, "scratch", "test_channel_state.json");
  if (fs.existsSync(chStatePath)) try { fs.unlinkSync(chStatePath); } catch (e) {}

  const chStore = new ExternalSourceState({ stateFilePath: chStatePath, channelDailyTarget: 15 });

  // Fill Channel 1 to 15
  for (let i = 1; i <= 15; i++) {
    const res = chStore.recordTelegramDelivery(1, { id: `ch1_msg_${i}`, title: `Ch1 Msg ${i}`, mediaUrl: `https://tg.com/1_${i}.mp4` });
    assert.strictEqual(res.success, true);
  }
  // 16th item on Channel 1 rejected by quota
  const ch1Excess = chStore.recordTelegramDelivery(1, { id: "ch1_msg_16", title: "Ch1 Msg 16", mediaUrl: "https://tg.com/1_16.mp4" });

  // Channel 2 is independent and still has 15 remaining
  const ch2First = chStore.recordTelegramDelivery(2, { id: "ch2_msg_1", title: "Ch2 Msg 1", mediaUrl: "https://tg.com/2_1.mp4" });

  record(
    "Q. 15-item quota per Telegram source channel (Ch1 capped at 15, Ch2 independent)",
    chStore.channelDeliveriesToday["1"] === 15 &&
    ch1Excess.success === false &&
    ch1Excess.reason === "CHANNEL_QUOTA_EXCEEDED" &&
    ch2First.success === true &&
    chStore.channelDeliveriesToday["2"] === 1
  );

  // ----------------------------------------------------
  // SECTION R: Daily Counter Persistence across Process Restart
  // ----------------------------------------------------
  const prStatePath = path.join(__dirname, "scratch", "test_persist_counters.json");
  if (fs.existsSync(prStatePath)) try { fs.unlinkSync(prStatePath); } catch (e) {}

  // Process 1: Sets Ch1 = 10, External = 8
  const prStore1 = new ExternalSourceState({ stateFilePath: prStatePath, externalDailyTarget: 15, channelDailyTarget: 15 });
  for (let i = 1; i <= 10; i++) prStore1.recordTelegramDelivery(1, { id: `pr_tg_${i}`, title: `TG ${i}`, mediaUrl: `https://tg.com/${i}.mp4` });
  for (let i = 1; i <= 8; i++) prStore1.recordExternalDelivery({ id: `pr_ext_${i}`, title: `EXT ${i}`, mediaUrl: `https://ext.com/${i}.mp4` });

  // Process 2: Restarts and reloads state from disk
  const prStore2 = new ExternalSourceState({ stateFilePath: prStatePath, externalDailyTarget: 15, channelDailyTarget: 15 });

  record(
    "R. Process restart preserves daily counters (Channel 1 = 10/15, External = 8/15)",
    prStore2.channelDeliveriesToday["1"] === 10 &&
    prStore2.externalDeliveredToday === 8 &&
    prStore2.getExternalRemainingQuota() === 7 &&
    prStore2.getChannelRemainingQuota(1) === 5
  );

  // ----------------------------------------------------
  // SECTION S: 24-Hour Window Boundary & Dedupe Preservation
  // ----------------------------------------------------
  // Simulate passage of 25 hours
  const pastTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
  prStore2.windowStartAt = pastTime.toISOString();

  // Next operation triggers new 24h window
  const newWindowTriggered = prStore2.ensureDailyWindow();

  // Item delivered yesterday (pr_ext_1) is encountered again in new window
  const hasSeenYesterdayItem = prStore2.hasSeen({ id: "pr_ext_1", mediaUrl: "https://ext.com/1.mp4" });

  record(
    "S. 24-hour boundary resets daily counters (ext=0) but preserves historical dedupe ledger",
    newWindowTriggered === true &&
    prStore2.externalDeliveredToday === 0 &&
    hasSeenYesterdayItem === true
  );

  // Cleanup test scratch files
  [quotaStatePath, fbStatePath, chStatePath, prStatePath].forEach(p => {
    if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch (e) {}
  });

  cleanupTestState();

  console.log("\n==================================================");
  console.log(`📊 SUMMARY: ${passed} / ${total} TESTS PASSED (${passed === total ? "100% SUCCESS" : "FAILURES DETECTED"})`);
  console.log("==================================================\n");

  if (passed !== total) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error("Test execution error:", err);
  process.exit(1);
});
