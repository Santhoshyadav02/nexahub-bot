/**
 * ============================================================
 * 🧪 OFFLINE TEST: EXTERNAL SOURCE DEPLOYMENT HARDENING
 * ============================================================
 * - D4: destinations without an env var are disabled (null ID, one-time warning),
 *       and the round-robin scheduler skips disabled category slots.
 * - D1: EXTERNAL_PUBLISH_ENABLED=true is reported as NOT delivered.
 * - D2: requiring external_source_pipeline has no side effects (lazy instance),
 *       and stopScheduler() clears its interval and releases the media pipeline/browsers.
 * - State: fixture records ignored on the default path, corrupt JSON quarantined.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nexahub-ext-hardening-"));
process.env.NEXAHUB_DATA_DIR = DATA_DIR;
delete process.env.EXTERNAL_PUBLISH_ENABLED;
for (const key of Object.keys(process.env)) {
  if (key.startsWith("EXTERNAL_DEST_")) delete process.env[key];
}

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ [PASS] ${name}`);
  } catch (err) {
    failed++;
    console.error(`❌ [FAIL] ${name} - ${err.message}`);
  }
}

function captureWarnings(fn) {
  const original = console.warn;
  const lines = [];
  console.warn = (...args) => lines.push(args.join(" "));
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return lines;
}

async function run() {
  console.log("==================================================");
  console.log("🚀 RUNNING EXTERNAL SOURCE DEPLOY HARDENING TESTS (OFFLINE)");
  console.log("==================================================\n");

  // ---------------- D2: lazy singleton ----------------
  await check("D2a. Requiring external_source_pipeline does not construct the singleton", () => {
    const mod = require("./external_source_pipeline");
    const desc = Object.getOwnPropertyDescriptor(mod, "instance");
    assert.ok(desc && typeof desc.get === "function", "instance must be a lazy getter");
    assert.strictEqual(fs.existsSync(path.join(DATA_DIR, "external_source_state.json")), false, "no state file written at require time");
    assert.strictEqual(typeof mod.getPipelineInstance, "function");
  });

  const destinations = require("./external_source_destinations");

  // ---------------- D4: destinations ----------------
  await check("D4a. Unset env vars -> every destination disabled with null ID (no placeholders)", () => {
    const all = Object.values(destinations.EXTERNAL_TOPIC_DESTINATIONS);
    assert.strictEqual(all.length, 13);
    for (const d of all) {
      assert.strictEqual(d.enabled, false, `${d.topicKey} must be disabled`);
      assert.strictEqual(d.destinationChannelId, null, `${d.topicKey} must have null ID`);
      assert.ok(/^EXTERNAL_DEST_/.test(d.destinationEnvVar));
    }
    assert.strictEqual(destinations.getDisabledDestinations().length, 13);
  });

  await check("D4b. Configured env var -> destination enabled with that exact ID", () => {
    const map = destinations.buildTopicDestinations({ EXTERNAL_DEST_MYANMAR: " -1009876543210 " });
    assert.strictEqual(map.Myanmar.enabled, true);
    assert.strictEqual(map.Myanmar.destinationChannelId, "-1009876543210");
    assert.strictEqual(map.General.enabled, false);
    assert.strictEqual(map.General.destinationChannelId, null);
  });

  await check("D4c. getDestinationForTopic warns once per disabled destination", () => {
    const lines = captureWarnings(() => {
      destinations.getDestinationForTopic("Sister Snake");
      destinations.getDestinationForTopic("Sister Snake");
      destinations.getDestinationForTopic("Sister Snake");
    });
    const relevant = lines.filter(l => l.includes("EXTERNAL_DEST_SISTER_SNAKE"));
    assert.strictEqual(relevant.length, 1, `expected 1 warning, got ${relevant.length}`);
    assert.strictEqual(destinations.isDestinationEnabled(destinations.getDestinationForTopic("Sister Snake")), false);
  });

  await check("D4d. Category slots without EXTERNAL_DEST_<n> are disabled with null IDs", () => {
    const { DEFAULT_CATEGORY_CONFIG } = require("./avsee/category_discovery");
    assert.strictEqual(DEFAULT_CATEGORY_CONFIG.length, 10);
    for (const c of DEFAULT_CATEGORY_CONFIG) {
      assert.strictEqual(c.enabled, false);
      assert.strictEqual(c.destinationChannelId, null);
      assert.strictEqual(c.destinationEnvVar, `EXTERNAL_DEST_${c.channelIndex}`);
    }
  });

  await check("D4e. Round-robin scheduler skips a disabled slot and dispatches to the enabled one", () => {
    const { CategoryQueue } = require("./avsee/category_queue");
    const { RoundRobinScheduler } = require("./avsee/round_robin_scheduler");
    const categoryConfig = [
      { categoryId: "cat_1", categoryCode: "myanmar", categoryName: "Disabled", channelIndex: 1, destinationEnvVar: "EXTERNAL_DEST_1", destinationChannelId: null, enabled: false, boardPath: "/bbs/board.php?bo_table=myanmar" },
      { categoryId: "cat_2", categoryCode: "evergrande", categoryName: "Enabled", channelIndex: 2, destinationEnvVar: "EXTERNAL_DEST_2", destinationChannelId: "-1001111111111", enabled: true, boardPath: "/bbs/board.php?bo_table=evergrande" }
    ];
    const queue = new CategoryQueue({ stateFilePath: path.join(DATA_DIR, "d4e_queue.json"), categoryConfig });
    const r1 = queue.enqueue({ sourcePostId: "501", categoryId: "cat_1", title: "Disabled post", canonicalUrl: "https://02.avsee.is/bbs/board.php?bo_table=myanmar&wr_id=501" });
    const r2 = queue.enqueue({ sourcePostId: "502", categoryId: "cat_2", title: "Enabled post", canonicalUrl: "https://02.avsee.is/bbs/board.php?bo_table=evergrande&wr_id=502" });
    assert.ok(r1.success && r2.success, "fixture enqueue must succeed");

    const scheduler = new RoundRobinScheduler({ stateFilePath: path.join(DATA_DIR, "d4e_sched.json"), categoryQueue: queue, categoryConfig });
    let selection;
    const warnings = captureWarnings(() => { selection = scheduler.selectNextEligibleDestination(); });
    assert.strictEqual(selection.eligible, true);
    assert.strictEqual(selection.channelIndex, 2);
    assert.strictEqual(selection.destinationChannelId, "-1001111111111");
    assert.ok(warnings.some(l => l.includes("EXTERNAL_DEST_1")), "disabled slot must be warned about");
    assert.strictEqual(queue.getQueueForCategory("cat_1")[0].status, "QUEUED", "disabled slot's item must stay untouched");
  });

  // ---------------- D1: live publishing not implemented ----------------
  const { ExternalSourceState, isFixtureRecord } = require("./external_source_state");
  const { ExternalSourcePublisher, isCountedAsDelivery, LIVE_PUBLISH_NOT_IMPLEMENTED } = require("./external_source_publisher");
  const { ExternalSourceAdapter } = require("./external_source_adapter");
  const { ExternalSourcePipeline } = require("./external_source_pipeline");

  await check("D1a. publishEnabled=true returns LIVE_PUBLISH_NOT_IMPLEMENTED (not a delivery) with one warning", async () => {
    const store = new ExternalSourceState({ stateFilePath: path.join(DATA_DIR, "d1a_state.json") });
    let publisher;
    const warnings = captureWarnings(() => {
      publisher = new ExternalSourcePublisher({ stateStore: store, publishEnabled: true });
      new ExternalSourcePublisher({ stateStore: store, publishEnabled: true });
    });
    assert.strictEqual(warnings.filter(l => l.includes("NOT implemented")).length, 1);
    const res = await publisher.publishAuthorizedItem({ itemId: "real_1", title: "Real", mediaUrl: "https://authorized-cdn.com/r.mp4", topicKey: "Myanmar" });
    assert.strictEqual(res.status, LIVE_PUBLISH_NOT_IMPLEMENTED);
    assert.strictEqual(res.published, false);
    assert.strictEqual(isCountedAsDelivery(res), false);
    assert.notStrictEqual(store.records.get("real_1").status, "LIVE_PUBLISHED");
  });

  await check("D1b. Pipeline records NO deliveries when live publishing is enabled", async () => {
    const store = new ExternalSourceState({ stateFilePath: path.join(DATA_DIR, "d1b_state.json"), externalDailyTarget: 15 });
    const adapter = new ExternalSourceAdapter({ isAuthorized: true, licenseId: "LIC", allowedDomains: ["authorized-cdn.com"], dryRun: true, ledgerPath: path.join(DATA_DIR, "d1b_ledger.json") });
    const publisher = new ExternalSourcePublisher({ stateStore: store, publishEnabled: true });
    const pipeline = new ExternalSourcePipeline({ adapter, publisher, stateStore: store });
    const items = [1, 2, 3].map(i => ({ id: `live_${i}`, title: `Live ${i}`, mediaUrl: `https://authorized-cdn.com/live_${i}.mp4` }));
    const backfill = await pipeline.runInitialBackfill({ sourceItems: items });
    const poll = await pipeline.runPollingCycle({ sourceItems: [{ id: "live_4", title: "Live 4", mediaUrl: "https://authorized-cdn.com/live_4.mp4" }] });
    assert.strictEqual(backfill.queued, 0);
    assert.strictEqual(poll.queued, 0);
    assert.strictEqual(store.externalDeliveredToday, 0);
    for (const rec of new Set(store.records.values())) {
      assert.notStrictEqual(rec.isDelivered, true, `${rec.sourceItemId} must not be marked delivered`);
    }
  });

  await check("D1c. Dry-run simulation still counts as a (simulated) delivery", async () => {
    const store = new ExternalSourceState({ stateFilePath: path.join(DATA_DIR, "d1c_state.json") });
    const publisher = new ExternalSourcePublisher({ stateStore: store, publishEnabled: false });
    const res = await publisher.publishAuthorizedItem({ itemId: "dry_1", title: "Dry", topicKey: "General" });
    assert.strictEqual(res.status, "SIMULATED_PUBLISH_SUCCESS");
    assert.strictEqual(isCountedAsDelivery(res), true);
  });

  // ---------------- D2: stopScheduler ----------------
  await check("D2b. stopScheduler() clears the interval and shuts down media pipeline + browsers", async () => {
    const store = new ExternalSourceState({ stateFilePath: path.join(DATA_DIR, "d2b_state.json") });
    let shutdownCalls = 0;
    let browsersClosed = 0;
    const adapter = new ExternalSourceAdapter({ isAuthorized: true, licenseId: "LIC", dryRun: true, ledgerPath: path.join(DATA_DIR, "d2b_ledger.json") });
    adapter.closeActiveBrowsers = async () => { browsersClosed++; return 0; };
    const pipeline = new ExternalSourcePipeline({
      adapter,
      stateStore: store,
      publisher: new ExternalSourcePublisher({ stateStore: store, publishEnabled: false }),
      schedulerEnabled: true
    });
    pipeline.mediaPipeline = { shutdown: async () => { shutdownCalls++; } };
    pipeline.startScheduler({ immediate: false });
    assert.ok(pipeline.timerId, "timer must be active after start");
    const ret = pipeline.stopScheduler();
    assert.strictEqual(pipeline.timerId, null);
    assert.strictEqual(pipeline.isStarted, false);
    await ret;
    assert.strictEqual(shutdownCalls, 1, "media pipeline shutdown() must be called");
    assert.strictEqual(browsersClosed, 1, "adapter browsers must be released");
  });

  // ---------------- State: fixtures & corruption ----------------
  await check("S1. Fixture records (item_4 / h4, no URLs) are detected; real records are not", () => {
    assert.strictEqual(isFixtureRecord({ sourceItemId: "item_4", uniqueHash: "h4", title: "Video 4" }), true);
    assert.strictEqual(isFixtureRecord({ sourceItemId: "item_4", uniqueHash: "h4", mediaUrl: "https://cdn/x.mp4" }), false);
    assert.strictEqual(isFixtureRecord({ sourceItemId: "korea_12345", uniqueHash: "abc", canonicalUrl: "https://02.avsee.is/x" }), false);
    assert.strictEqual(isFixtureRecord({ sourceItemId: "anything", isTest: true }), true);
  });

  await check("S2. Default (seeded) state path ignores the committed fixture records", () => {
    const store = new ExternalSourceState();
    assert.strictEqual(path.dirname(store.stateFilePath), path.resolve(DATA_DIR), "default state path must be in NEXAHUB_DATA_DIR");
    assert.strictEqual(store.retainedPool.length, 0, "fixture pool entries must be ignored");
    assert.strictEqual(store.hasSeen({ itemId: "item_4" }), false, "fixture record must not be loaded");
    assert.strictEqual(store.getNeverDeliveredFallbackCandidates(100).length, 0);
  });

  await check("S3. Explicit state paths keep loading fixture-like records (tests rely on them)", () => {
    const p = path.join(DATA_DIR, "s3_state.json");
    fs.writeFileSync(p, JSON.stringify({ records: [{ sourceItemId: "item_1", uniqueHash: "h1", title: "Video 1" }], retainedPool: [] }));
    const store = new ExternalSourceState({ stateFilePath: p });
    assert.strictEqual(store.hasSeen({ itemId: "item_1" }), true);
  });

  await check("S4. Corrupt state JSON is quarantined, not overwritten", () => {
    const p = path.join(DATA_DIR, "s4_state.json");
    fs.writeFileSync(p, "{ \"records\": [ torn");
    const store = new ExternalSourceState({ stateFilePath: p });
    const quarantined = fs.readdirSync(DATA_DIR).filter(f => f.startsWith("s4_state.json.corrupt-"));
    assert.strictEqual(quarantined.length, 1, "corrupt file must be preserved");
    assert.strictEqual(fs.readFileSync(path.join(DATA_DIR, quarantined[0]), "utf8"), "{ \"records\": [ torn");
    assert.strictEqual(store.records.size, 0);
  });

  await check("S5. Corrupt adapter ledger is quarantined and saves are atomic", () => {
    const p = path.join(DATA_DIR, "s5_ledger.json");
    fs.writeFileSync(p, "");
    const adapter = new ExternalSourceAdapter({ isAuthorized: true, licenseId: "LIC", ledgerPath: p });
    assert.strictEqual(adapter.ledger.size, 0);
    assert.strictEqual(fs.readdirSync(DATA_DIR).filter(f => f.startsWith("s5_ledger.json.corrupt-")).length, 1);
    adapter.recordItem({ uniqueHash: "u1", itemId: "x1", title: "X" });
    const saved = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.strictEqual(saved.records.length, 1);
    assert.strictEqual(fs.readdirSync(DATA_DIR).filter(f => f.startsWith("s5_ledger.json.") && f.endsWith(".tmp")).length, 0);
  });

  await check("S6. Default ledger/temp paths live in NEXAHUB_DATA_DIR", () => {
    const { AvseeSourceAdapter } = require("./avsee_source_adapter");
    const a = new AvseeSourceAdapter({ isAuthorized: true, licenseId: "LIC" });
    assert.ok(a.ledgerPath.startsWith(path.resolve(DATA_DIR)));
    assert.ok(a.tempDir.startsWith(path.resolve(DATA_DIR)));
    const { CategoryQueue } = require("./avsee/category_queue");
    const q = new CategoryQueue();
    assert.ok(q.stateFilePath.startsWith(path.resolve(DATA_DIR)));
  });

  console.log("\n==================================================");
  console.log(`📊 SUMMARY: ${passed} / ${passed + failed} TESTS PASSED`);
  console.log("==================================================\n");
  process.exit(failed === 0 ? 0 : 1);
}

run().catch(err => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
