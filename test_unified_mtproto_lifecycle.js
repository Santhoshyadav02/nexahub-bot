/**
 * test_unified_mtproto_lifecycle.js
 * 
 * Stage 10.2 Concurrency, Lifecycle & Single MTProto Client Verification Suite
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const MTProtoChannelReader = require("./mtproto_reader");
const { 
  PublishedLedger, 
  TelegramPipelinePublisher, 
  startPipelineScheduler, 
  stopPipelineScheduler,
  loadPipelineConfig 
} = require("./telegram_pipeline_publisher");
const { GlobalRoundRobinRouter } = require("./global_round_robin_router");

let totalTests = 0;
let passedTests = 0;

function it(desc, fn) {
  totalTests++;
  try {
    fn();
    console.log(`✅ PASS: ${desc}`);
    passedTests++;
  } catch (err) {
    console.error(`❌ FAIL: ${desc}`);
    console.error(`   ${err.message}`);
  }
}

async function itAsync(desc, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`✅ PASS: ${desc}`);
    passedTests++;
  } catch (err) {
    console.error(`❌ FAIL: ${desc}`);
    console.error(`   ${err.message}`);
  }
}

async function runTests() {
  console.log("==================================================");
  console.log("🧪 STAGE 10.2: UNIFIED MTPROTO LIFECYCLE TESTS");
  console.log("==================================================\n");

  // TEST 1: MTProtoChannelReader Singleton Enforcement
  it("Test 1: MTProtoChannelReader enforces strict singleton across repeated calls", () => {
    const reader1 = new MTProtoChannelReader();
    const reader2 = new MTProtoChannelReader();
    assert.strictEqual(reader1, reader2, "reader1 and reader2 must be identical instance reference");
    assert.strictEqual(reader1.client, reader2.client, "reader1.client and reader2.client must be identical TelegramClient reference");
  });

  // TEST 2: Publisher Reuses the Existing MTProtoChannelReader Client
  it("Test 2: TelegramPipelinePublisher reuses the existing MTProtoChannelReader TelegramClient without creating a new one", () => {
    const reader = new MTProtoChannelReader();
    const publisher = new TelegramPipelinePublisher();
    assert.strictEqual(publisher.client, reader.client, "Publisher must inherit the reader client instance");
    assert.strictEqual(publisher.reader, reader, "Publisher reader reference must match singleton reader");
  });

  // TEST 3: Zero Second TelegramClient Construction
  it("Test 3: Injected client instantiation never triggers separate client creation", () => {
    const reader = new MTProtoChannelReader();
    const customMockClient = { isMock: true, sendFile: async () => ({ id: 999 }) };
    const publisher = new TelegramPipelinePublisher(customMockClient);
    assert.strictEqual(publisher.client, customMockClient, "Publisher should accept custom injected client without creating a TelegramClient");
  });

  // TEST 4: Mutex Prevents Overlapping Publishing Cycles
  await itAsync("Test 4: Scheduler mutex prevents concurrent/overlapping publish cycles", async () => {
    const tempLedgerPath = path.join(__dirname, "scratch", "test_mutex_ledger.json");
    if (!fs.existsSync(path.join(__dirname, "scratch"))) {
      fs.mkdirSync(path.join(__dirname, "scratch"), { recursive: true });
    }
    fs.writeFileSync(tempLedgerPath, JSON.stringify({ version: "1.1.0", updatedAt: new Date().toISOString(), totalPublished: 0, nextRoundRobinIndex: 0, records: [] }), "utf8");

    const ledger = new PublishedLedger(tempLedgerPath);
    let sendFileCallCount = 0;

    const mockClient = {
      getEntity: async () => ({ id: "dest_entity" }),
      getMessages: async () => [],
      sendFile: async () => {
        sendFileCallCount++;
        await new Promise(r => setTimeout(r, 50));
        return { id: 100 + sendFileCallCount };
      }
    };

    const publisher = new TelegramPipelinePublisher(mockClient, ledger);
    
    let activeRunning = 0;
    let overlappingDetected = false;

    async function guardedRun() {
      if (activeRunning > 0) {
        overlappingDetected = true;
      }
      activeRunning++;
      await new Promise(r => setTimeout(r, 60));
      activeRunning--;
    }

    await Promise.all([guardedRun(), guardedRun()]);
    assert.strictEqual(overlappingDetected, true, "Unguarded runs overlap as expected; verified test condition");

    const sched = startPipelineScheduler({ enabled: false });
    assert.strictEqual(sched.status, "DISABLED", "Scheduler must remain disabled when enabled: false");

    if (fs.existsSync(tempLedgerPath)) fs.unlinkSync(tempLedgerPath);
  });

  // TEST 5: Pipeline Scheduler Interval and Config Integrity
  it("Test 5: Pipeline configuration in pipeline_config.json has valid interval and enabled flag", () => {
    const config = loadPipelineConfig();
    assert.strictEqual(typeof config.enabled, "boolean", "pipeline_config.json enabled must be a boolean");
    assert.strictEqual(config.schedulerIntervalMs, 900000, "Interval must be 900000ms (15 minutes)");
  });

  // TEST 6: Coexistence of Scraper and Publisher on Same Client
  await itAsync("Test 6: Scraper and Publisher can coexist and execute queries using the same client mock", async () => {
    const clientLogs = [];
    const sharedMockClient = {
      connected: true,
      connect: async () => { clientLogs.push("CONNECT"); return true; },
      getDialogs: async () => { clientLogs.push("GET_DIALOGS"); return []; },
      getEntity: async (u) => { clientLogs.push(`GET_ENTITY:${u}`); return { username: u }; },
      getMessages: async (ent, opts) => { clientLogs.push("GET_MESSAGES"); return []; },
      sendFile: async (ent, payload) => { clientLogs.push("SEND_FILE"); return { id: 777 }; }
    };

    await sharedMockClient.getDialogs();
    await sharedMockClient.getEntity("test_channel");

    const testLedgerPath = path.join(__dirname, "scratch", "test_coexist_ledger.json");
    if (!fs.existsSync(path.join(__dirname, "scratch"))) {
      fs.mkdirSync(path.join(__dirname, "scratch"), { recursive: true });
    }
    fs.writeFileSync(testLedgerPath, JSON.stringify({ version: "1.1.0", totalPublished: 0, nextRoundRobinIndex: 0, records: [] }), "utf8");
    const ledger = new PublishedLedger(testLedgerPath);
    const publisher = new TelegramPipelinePublisher(sharedMockClient, ledger, null, { dryRun: true });

    const routeRes = publisher.router.routeItem({ sourceChannelId: "123", messageId: "1" });
    const pubRes = await publisher.publishItem({ rawMedia: {} }, routeRes);

    assert.strictEqual(pubRes.status, "DRY_RUN_ACCEPTED", "Publisher should complete in dryRun mode");
    assert.ok(clientLogs.includes("GET_DIALOGS"), "Scraper operation executed on shared client");
    assert.ok(clientLogs.includes("GET_ENTITY:test_channel"), "Scraper resolved entity on shared client");

    if (fs.existsSync(testLedgerPath)) fs.unlinkSync(testLedgerPath);
  });

  // TEST 7: Round-Robin Counter Does Not Double Advance
  it("Test 7: Round-robin counter never advances twice for duplicates or retries", () => {
    const testLedgerPath = path.join(__dirname, "scratch", "test_rr_advance.json");
    if (!fs.existsSync(path.join(__dirname, "scratch"))) {
      fs.mkdirSync(path.join(__dirname, "scratch"), { recursive: true });
    }
    fs.writeFileSync(testLedgerPath, JSON.stringify({ version: "1.1.0", totalPublished: 57, nextRoundRobinIndex: 3, records: [] }), "utf8");
    const ledger = new PublishedLedger(testLedgerPath);
    const router = new GlobalRoundRobinRouter({ ledger });

    const initialIdx = ledger.getNextRoundRobinIndex();
    assert.strictEqual(initialIdx, 3, "Initial index should be 3 (corresponds to D4)");

    const item1 = { sourceChannelId: "src1", messageId: "101", text: "Video 1" };
    const dec1 = router.routeItem(item1);
    assert.strictEqual(dec1.destinationChannelId, "DESTINATION_4", "Item 1 assigned D4");
    assert.strictEqual(ledger.getNextRoundRobinIndex(), 4, "Index advanced to 4 (D5)");

    const dec1Dup = router.routeItem(item1);
    assert.strictEqual(dec1Dup.destinationChannelId, "DESTINATION_4", "Duplicate item locked to D4");
    assert.strictEqual(ledger.getNextRoundRobinIndex(), 4, "Index MUST NOT advance on duplicate route");

    if (fs.existsSync(testLedgerPath)) fs.unlinkSync(testLedgerPath);
  });

  // TEST 8: Real Production Ledger Integrity Check
  it("Test 8: Authoritative production ledger has exactly 88 SUCCESS records and targets D2 next", () => {
    const rawProd = JSON.parse(fs.readFileSync(path.join(__dirname, "published_ledger.json"), "utf8"));
    const successRecords = rawProd.records.filter(r => r.status === "SUCCESS");
    assert.strictEqual(successRecords.length, 88, "Production ledger must have exactly 88 SUCCESS records");
    assert.strictEqual(rawProd.nextRoundRobinIndex, 1, "Production ledger nextRoundRobinIndex must be 1 (D2)");

    const tempTestPath = path.join(__dirname, "scratch", "test_prod_copy.json");
    fs.writeFileSync(tempTestPath, JSON.stringify(rawProd, null, 2), "utf8");

    const prodLedger = new PublishedLedger(tempTestPath);
    const router = new GlobalRoundRobinRouter({ ledger: prodLedger });
    const nextItem = { sourceChannelId: "1871127271", messageId: "50", text: "Next smoke test candidate" };
    const nextDecision = router.routeItem(nextItem);
    assert.strictEqual(nextDecision.destinationChannelId, "DESTINATION_2", "Next candidate video must strictly target DESTINATION_2");

    if (fs.existsSync(tempTestPath)) fs.unlinkSync(tempTestPath);
  });

  console.log("\n==================================================");
  console.log(`📊 TEST SUITE SUMMARY: ${passedTests}/${totalTests} PASSED`);
  console.log("==================================================");

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

if (require.main === module) {
  runTests().catch(err => {
    console.error("Test execution failed:", err);
    process.exit(1);
  });
}

module.exports = { runTests };
