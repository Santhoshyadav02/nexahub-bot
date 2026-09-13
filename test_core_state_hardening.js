/**
 * Offline tests for core state hardening:
 *  - source_registry: seeding into NEXAHUB_DATA_DIR, corrupt-file recovery,
 *    batched saves, O(n) retention dedupe semantics
 *  - published ledger: atomic writes, FAILED-record pruning, no module-level
 *    side effects on require
 *  - mtproto_reader: lazy client (no throw without API credentials),
 *    FloodWait detection, AUTH_KEY_DUPLICATED treated as fatal
 *
 *   node test_core_state_hardening.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ [PASS] ${name}`);
  } catch (err) {
    failed++;
    console.error(`❌ [FAIL] ${name}: ${err.stack || err.message}`);
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nexahub-core-test-"));
const dataDir = path.join(tmpRoot, "data");
process.env.NEXAHUB_DATA_DIR = dataDir;
delete process.env.LEDGER_PATH;
delete process.env.PUBLISHED_LEDGER_PATH;
// Set to empty instead of deleting: modules call dotenv, which would refill
// deleted keys from a developer's local .env (dotenv never overrides set keys).
process.env.TELEGRAM_API_ID = "";
process.env.TELEGRAM_API_HASH = "";
process.env.TELEGRAM_SESSION_STRING = "";

function freshRequire(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(resolved);
}

(async () => {
  const repoRegistry = path.join(__dirname, "source_registry.json");
  const repoRegistryBefore = fs.readFileSync(repoRegistry, "utf8");

  await runTest("1. source_registry seeds into the data dir and never writes the committed copy", () => {
    const registry = freshRequire("./source_registry");
    const dataFile = path.join(dataDir, "source_registry.json");
    assert.ok(fs.existsSync(dataFile), "data-dir registry should exist");
    registry.processChannelPost({
      chat: { id: "-100999", title: "Unit Test Channel" },
      message_id: 42,
      text: "hello",
      date: Math.floor(Date.now() / 1000)
    });
    assert.strictEqual(fs.readFileSync(repoRegistry, "utf8"), repoRegistryBefore, "committed registry must be untouched");
    const saved = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    assert.ok(saved.posts.some(p => String(p.message_id) === "42"));
  });

  await runTest("2. runInBatch defers saves and writes exactly once", () => {
    const registry = freshRequire("./source_registry");
    const runtimePaths = require("./runtime_paths");
    const original = runtimePaths.writeJsonAtomicSync;
    let writes = 0;
    // source_registry captured the function at require time, so count via mtime + content instead.
    const dataFile = path.join(dataDir, "source_registry.json");
    const before = fs.statSync(dataFile).mtimeMs;
    const realSave = registry.saveData.bind(registry);
    registry.saveData = function () {
      if (this.batchDepth === 0) writes++;
      return realSave();
    };
    registry.runInBatch(() => {
      for (let i = 0; i < 20; i++) {
        registry.processChannelPost({
          chat: { id: "-100888", title: "Batch Channel" },
          message_id: 1000 + i,
          text: `post ${i}`,
          date: Math.floor(Date.now() / 1000)
        });
      }
    });
    registry.saveData = realSave;
    assert.strictEqual(writes, 1, `expected exactly 1 flushed save, got ${writes}`);
    assert.ok(fs.statSync(dataFile).mtimeMs >= before);
    assert.strictEqual(runtimePaths.writeJsonAtomicSync, original);
  });

  await runTest("3. applyRollingRetention keeps first occurrence and drops hash/url/message_id duplicates per group", () => {
    const registry = freshRequire("./source_registry");
    registry.posts = [
      { keyword: "K", unique_hash: "h1", telegram_url: "u1", message_id: 1, published_at: "2026-01-03T00:00:00Z" },
      { keyword: "K", unique_hash: "h1", telegram_url: "u9", message_id: 9, published_at: "2026-01-02T00:00:00Z" },
      { keyword: "K", unique_hash: "h2", telegram_url: "u1", message_id: 2, published_at: "2026-01-02T00:00:00Z" },
      { keyword: "K", unique_hash: "h3", telegram_url: "u3", message_id: 1, published_at: "2026-01-02T00:00:00Z" },
      { keyword: "K", unique_hash: "h4", telegram_url: "u4", message_id: 4, published_at: "2026-01-01T00:00:00Z" },
      { keyword: "Other", unique_hash: "h1", telegram_url: "u1", message_id: 1, published_at: "2026-01-01T00:00:00Z" }
    ];
    registry.applyRollingRetention(50);
    const k = registry.posts.filter(p => p.keyword === "K").map(p => p.unique_hash).sort();
    assert.deepStrictEqual(k, ["h1", "h4"]);
    assert.strictEqual(registry.posts.filter(p => p.keyword === "Other").length, 1, "dedupe is per group");
  });

  await runTest("4. Corrupt data-dir registry is quarantined and restored from the committed seed", () => {
    const dataFile = path.join(dataDir, "source_registry.json");
    fs.writeFileSync(dataFile, "{ \"sources\": [ torn", "utf8");
    const registry = freshRequire("./source_registry");
    const seed = JSON.parse(repoRegistryBefore);
    assert.ok(registry.sources.length >= seed.sources.length, "sources restored from seed");
    const quarantined = fs.readdirSync(dataDir).filter(f => f.startsWith("source_registry.json.corrupt-"));
    assert.strictEqual(quarantined.length, 1, "corrupt copy preserved");
    JSON.parse(fs.readFileSync(dataFile, "utf8"));
  });

  await runTest("5. Requiring telegram_pipeline_publisher has no side effects without MTProto credentials", () => {
    const MTProtoChannelReader = freshRequire("./mtproto_reader");
    MTProtoChannelReader.instance = null;
    const publisherModule = freshRequire("./telegram_pipeline_publisher");
    assert.strictEqual(typeof publisherModule.waitForActiveCycle, "function");
    const reader = new MTProtoChannelReader();
    assert.strictEqual(reader.client, null, "no TelegramClient without API id/hash");
  });

  await runTest("6. Published ledger seeds from the repo baseline, writes atomically and prunes old FAILED records", () => {
    const { PublishedLedger } = freshRequire("./telegram_pipeline_publisher");
    const ledgerFile = path.join(dataDir, "published_ledger.json");
    const repoLedger = path.join(__dirname, "published_ledger.json");
    const repoLedgerBefore = fs.readFileSync(repoLedger, "utf8");
    const baselineSuccess = JSON.parse(repoLedgerBefore).records.filter(r => r.status === "SUCCESS").length;

    const ledger = new PublishedLedger(ledgerFile);
    assert.ok(fs.existsSync(ledgerFile), "ledger seeded into data dir");
    assert.strictEqual(ledger.publishedIdentities.size > 0 || baselineSuccess === 0, true);

    for (let i = 0; i < 520; i++) {
      ledger.records.push({ sourceIdentity: `s:${i}`, status: "FAILED", error: "x" });
    }
    ledger.recordFailure({ sourceIdentity: "s:last", destinationChannelId: "DESTINATION_1" }, "boom");
    const saved = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
    assert.strictEqual(saved.records.filter(r => r.status === "FAILED").length, 500);
    assert.strictEqual(saved.records.filter(r => r.status === "SUCCESS").length, baselineSuccess, "SUCCESS records never pruned");
    assert.ok(saved.records.some(r => r.sourceIdentity === "s:last"), "newest failure kept");
    assert.strictEqual(fs.readFileSync(repoLedger, "utf8"), repoLedgerBefore, "committed ledger untouched");
    assert.deepStrictEqual(fs.readdirSync(dataDir).filter(f => f.endsWith(".tmp")), []);
  });

  await runTest("7. FloodWait detection and AUTH_KEY_DUPLICATED is fatal (no retry loop)", async () => {
    const MTProtoChannelReader = freshRequire("./mtproto_reader");
    assert.strictEqual(MTProtoChannelReader.getFloodWaitSeconds({ className: "FloodWaitError", seconds: 120 }), 120);
    assert.strictEqual(MTProtoChannelReader.getFloodWaitSeconds({ errorMessage: "FLOOD_WAIT_33" }), 33);
    assert.strictEqual(MTProtoChannelReader.getFloodWaitSeconds({ message: "A wait of 45 seconds is required" }), 45);
    assert.strictEqual(MTProtoChannelReader.getFloodWaitSeconds(new Error("CHANNEL_PRIVATE")), 0);

    MTProtoChannelReader.instance = null;
    const reader = new MTProtoChannelReader();
    reader.sessionString = "fake";
    let connectCalls = 0;
    reader.client = {
      connected: false,
      connect: async () => { connectCalls++; const e = new Error("406: AUTH_KEY_DUPLICATED"); e.code = 406; throw e; },
      disconnect: async () => {}
    };
    assert.strictEqual(await reader.connect(), false);
    assert.ok(reader.fatalError && reader.fatalError.includes("AUTH_KEY_DUPLICATED"));
    assert.strictEqual(await reader.connect(), false);
    assert.strictEqual(connectCalls, 1, "no reconnect attempt after AUTH_KEY_DUPLICATED");

    MTProtoChannelReader.instance = null;
    const floodReader = new MTProtoChannelReader();
    floodReader.noteFloodWait({ className: "FloodWaitError", seconds: 300 });
    assert.strictEqual(floodReader.isFloodWaitActive(), true);
  });

  await runTest("8. withTimeout rejects a hung MTProto call", async () => {
    const MTProtoChannelReader = require("./mtproto_reader");
    await assert.rejects(
      MTProtoChannelReader.withTimeout(new Promise(() => {}), 50, "hung call"),
      /TIMEOUT: hung call/
    );
  });

  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch (e) {}

  console.log(`\n📊 CORE STATE HARDENING TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();
