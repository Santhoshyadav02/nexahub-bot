/**
 * ============================================================
 * 🧪 COMPREHENSIVE AUTOMATED ROUND-ROBIN WORKER TEST SUITE
 * ============================================================
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { ExternalSourceState } = require("./external_source_state");
const { AvseeAutomatedWorker, DEFAULT_WORKER_CONFIG, WORKER_STATES } = require("./avsee/automated_worker");
const { AvseePipelineOrchestrator } = require("./avsee/pipeline_orchestrator");
const { validateMp4 } = require("./avsee/mp4_validator");

const TEST_DIR = path.join(__dirname, "scratch", "test_rr_temp");
if (!fs.existsSync(TEST_DIR)) {
  fs.mkdirSync(TEST_DIR, { recursive: true });
}

const TEST_STATE_FILE = path.join(TEST_DIR, "test_round_robin_state.json");

function cleanup() {
  if (fs.existsSync(TEST_STATE_FILE)) {
    try { fs.unlinkSync(TEST_STATE_FILE); } catch (e) {}
  }
}

function createValidMp4Buffer() {
  // Construct a minimal valid MP4 buffer with ftyp, moov, mvhd, trak (vide), tkhd, hdlr, stsd, stsz
  // 1. ftyp
  const ftyp = Buffer.from([
    0x00, 0x00, 0x00, 0x20,
    0x66, 0x74, 0x79, 0x70, // ftyp
    0x69, 0x73, 0x6f, 0x6d, // isom
    0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d,
    0x69, 0x73, 0x6f, 0x32,
    0x61, 0x76, 0x63, 0x31,
    0x6d, 0x70, 0x34, 0x31
  ]);

  // 2. mvhd (duration = 100, timescale = 10 -> 10s)
  const mvhd = Buffer.alloc(32);
  mvhd.writeUInt32BE(32, 0); // size
  mvhd.write("mvhd", 4, "ascii");
  mvhd.writeUInt8(0, 8); // version 0
  mvhd.writeUInt32BE(1000, 20); // timescale
  mvhd.writeUInt32BE(10000, 24); // duration (10 sec)

  // 3. hdlr for video
  const hdlr = Buffer.alloc(32);
  hdlr.writeUInt32BE(32, 0);
  hdlr.write("hdlr", 4, "ascii");
  hdlr.write("vide", 16, "ascii"); // handlerType

  // 4. tkhd
  const tkhd = Buffer.alloc(92);
  tkhd.writeUInt32BE(92, 0);
  tkhd.write("tkhd", 4, "ascii");
  tkhd.writeUInt16BE(720, 84); // width
  tkhd.writeUInt16BE(1280, 88); // height

  // 5. stsd & stsz inside stbl, minf, mdia
  const stsd = Buffer.alloc(24);
  stsd.writeUInt32BE(24, 0);
  stsd.write("stsd", 4, "ascii");
  stsd.write("avc1", 20, "ascii");

  const stsz = Buffer.alloc(20);
  stsz.writeUInt32BE(20, 0);
  stsz.write("stsz", 4, "ascii");
  stsz.writeUInt32BE(100, 12); // sample size
  stsz.writeUInt32BE(300, 16); // sample count (300 frames)

  const stbl = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x3c, 0x73, 0x74, 0x62, 0x6c]), // size 60, 'stbl'
    stsd,
    stsz
  ]);

  const minf = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x44, 0x6d, 0x69, 0x6e, 0x66]), // size 68, 'minf'
    stbl
  ]);

  const mdia = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x6c, 0x6d, 0x64, 0x69, 0x61]), // size 108, 'mdia'
    hdlr,
    minf
  ]);

  const trak = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0xd0, 0x74, 0x72, 0x61, 0x6b]), // size 208, 'trak'
    tkhd,
    mdia
  ]);

  const moov = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0xf8, 0x6d, 0x6f, 0x6f, 0x76]), // size 248, 'moov'
    mvhd,
    trak
  ]);

  const mdat = Buffer.from([
    0x00, 0x00, 0x00, 0x10,
    0x6d, 0x64, 0x61, 0x74,
    0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08
  ]);

  return Buffer.concat([ftyp, moov, mdat]);
}

async function runTests() {
  console.log("============================================================");
  console.log("🧪 RUNNING COMPREHENSIVE AUTOMATED WORKER & ROUND-ROBIN TESTS");
  console.log("============================================================\n");

  let passed = 0;
  let total = 0;

  function test(name, fn) {
    total++;
    try {
      fn();
      console.log(`✅ [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`❌ [FAIL] ${name}: ${err.message}`);
      throw err;
    }
  }

  async function asyncTest(name, fn) {
    total++;
    try {
      await fn();
      console.log(`✅ [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`❌ [FAIL] ${name}: ${err.message}`);
      throw err;
    }
  }

  cleanup();

  // Test 1: Configuration & 20-minute interval
  test("1. 20-minute interval configuration is exactly 1,200,000 ms", () => {
    assert.strictEqual(DEFAULT_WORKER_CONFIG.pollIntervalMs, 20 * 60 * 1000, "Default worker interval must be 20 minutes (1,200,000 ms)");
    const worker = new AvseeAutomatedWorker({ stateFilePath: TEST_STATE_FILE, tempDir: TEST_DIR });
    assert.strictEqual(worker.pollIntervalMs, 1200000, "Worker instance must default to 20 minutes");
  });

  // Test 2: Removal of 15-item daily limit
  test("2. External state has no daily video cap (Infinity quota)", () => {
    const state = new ExternalSourceState({ stateFilePath: TEST_STATE_FILE });
    assert.strictEqual(state.externalDailyTarget, Infinity, "externalDailyTarget must be Infinity");
    
    // Simulate delivering 20 items (exceeding old 15 limit)
    for (let i = 1; i <= 20; i++) {
      const res = state.recordExternalDelivery({ itemId: `item_${i}`, title: `Title ${i}` });
      assert.strictEqual(res.success, true);
    }
    assert.strictEqual(state.externalDeliveredToday, 20, "Should have delivered 20 items today");
    assert.strictEqual(state.getExternalRemainingQuota(), Infinity, "Remaining quota must remain Infinity");
  });

  // Test 3: Round-robin pointer progression (1 -> 10 -> 1)
  test("3. Round-robin pointer advances sequentially from 1 to 10 and wraps to 1", () => {
    cleanup();
    const state = new ExternalSourceState({ stateFilePath: TEST_STATE_FILE });
    assert.strictEqual(state.getRoundRobinPointer(), 1, "Initial pointer must be 1");

    for (let expected = 2; expected <= 10; expected++) {
      const next = state.advanceRoundRobinPointer();
      assert.strictEqual(next, expected, `Pointer should advance to ${expected}`);
      assert.strictEqual(state.getRoundRobinPointer(), expected);
    }

    // Wrap around 10 -> 1
    const wrap = state.advanceRoundRobinPointer();
    assert.strictEqual(wrap, 1, "Pointer after 10 must wrap back to 1");
  });

  // Test 4: Pointer & Queue persistence across process restart
  test("4. State store persists pointer position and candidate queue across re-instantiation", () => {
    cleanup();
    const state1 = new ExternalSourceState({ stateFilePath: TEST_STATE_FILE });
    state1.setRoundRobinPointer(6);
    state1.enqueueCandidates([
      { sourceItemId: "p_101", title: "Post 101", channelIndex: 6, destinationChannelId: "-1002000000006" },
      { sourceItemId: "p_102", title: "Post 102", channelIndex: 7, destinationChannelId: "-1002000000007" }
    ]);
    assert.strictEqual(state1.getRoundRobinPointer(), 6);
    assert.strictEqual(state1.candidateQueue.length, 2);

    // Simulate process restart
    const state2 = new ExternalSourceState({ stateFilePath: TEST_STATE_FILE });
    assert.strictEqual(state2.getRoundRobinPointer(), 6, "Loaded pointer must be 6");
    assert.strictEqual(state2.candidateQueue.length, 2, "Loaded candidate queue length must be 2");
    assert.strictEqual(state2.candidateQueue[0].sourceItemId, "p_101");
    assert.strictEqual(state2.candidateQueue[1].sourceItemId, "p_102");
  });

  // Test 5: Destination-specific dedupe
  test("5. Destination-specific dedupe allows delivering same source to different channels but never twice to same channel", () => {
    cleanup();
    const state = new ExternalSourceState({ stateFilePath: TEST_STATE_FILE });
    const postId = "shared_post_555";
    const destChan1 = "-1002000000001";
    const destChan2 = "-1002000000002";

    assert.strictEqual(state.isDeliveredToDestination(postId, destChan1), false);
    assert.strictEqual(state.isDeliveredToDestination(postId, destChan2), false);

    // Deliver to Channel 1
    state.recordDeliveryResult({ sourceItemId: postId, title: "Shared Post" }, destChan1, { status: "DELIVERED" });
    assert.strictEqual(state.isDeliveredToDestination(postId, destChan1), true, "Channel 1 must be marked DELIVERED");
    assert.strictEqual(state.isDeliveredToDestination(postId, destChan2), false, "Channel 2 must remain false");

    // Deliver to Channel 2
    state.recordDeliveryResult({ sourceItemId: postId, title: "Shared Post" }, destChan2, { status: "DELIVERED" });
    assert.strictEqual(state.isDeliveredToDestination(postId, destChan2), true, "Channel 2 must be marked DELIVERED");

    // Re-enqueuing for Channel 1 must be rejected by enqueueCandidates
    const enq = state.enqueueCandidates([
      { sourceItemId: postId, channelIndex: 1, destinationChannelId: destChan1 }
    ]);
    assert.strictEqual(enq.enqueued, 0, "Already-delivered item must not be re-enqueued for the same channel");
  });

  // Test 6: Failed / invalid items never marked as DELIVERED
  test("6. Failed or rejected download items are never marked as DELIVERED", () => {
    cleanup();
    const state = new ExternalSourceState({ stateFilePath: TEST_STATE_FILE });
    const postId = "failed_post_999";
    const destChan = "-1002000000003";

    state.recordDeliveryResult({ sourceItemId: postId, title: "Failed Item" }, destChan, {
      status: "REJECTED_INVALID_MEDIA",
      error: "Corrupted MP4 box structure"
    });

    assert.strictEqual(state.isDeliveredToDestination(postId, destChan), false, "Failed item must NOT be marked DELIVERED");
    const rec = state.deliveryLedger.get(state.getDeliveryKey(postId, destChan));
    assert.strictEqual(rec.status, "REJECTED_INVALID_MEDIA");
  });

  // Test 7: Empty category skip & pointer advancement
  await asyncTest("7. Automated worker skips empty channel slot safely and advances pointer to next channel", async () => {
    cleanup();
    const state = new ExternalSourceState({ stateFilePath: TEST_STATE_FILE });
    state.setRoundRobinPointer(3); // Start at Channel 3
    // Queue only has an item for Channel 4
    state.enqueueCandidates([
      { sourceItemId: "item_ch4", title: "Channel 4 Item", channelIndex: 4, destinationChannelId: "-1002000000004" }
    ]);

    const orchestrator = new AvseePipelineOrchestrator({
      dryRun: true,
      tempDir: TEST_DIR,
      stateStore: state
    });

    const worker = new AvseeAutomatedWorker({
      stateFilePath: TEST_STATE_FILE,
      tempDir: TEST_DIR,
      orchestrator
    });

    // Run cycle on Channel 3 (which is empty)
    const result = await worker.runOnce({ forceDiscovery: false });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.status, "CHANNEL_SKIPPED_EMPTY");
    assert.strictEqual(result.channelIndex, 3);
    assert.strictEqual(result.nextChannelIndex, 4);
    assert.strictEqual(state.getRoundRobinPointer(), 4, "Pointer must now be at Channel 4");
  });

  // Test 8: Mutex Guard & Long-running download safety (>20 min non-interruption)
  await asyncTest("8. Mutex rejects overlapping scheduled runs without aborting active download", async () => {
    cleanup();
    const worker = new AvseeAutomatedWorker({
      stateFilePath: TEST_STATE_FILE,
      tempDir: TEST_DIR
    });

    // Simulate an ongoing long-running download (mutex locked)
    worker.isExecutionLocked = true;
    worker.workerState = WORKER_STATES.RUNNING;

    // A 20-minute interval scheduler tick arrives
    const overlappingResult = await worker.runOnce();
    assert.strictEqual(overlappingResult.success, false);
    assert.strictEqual(overlappingResult.status, "SKIPPED_OVERLAPPING");
    assert.strictEqual(worker.isExecutionLocked, true, "Active download mutex lock must remain intact and undisturbed");

    // Release lock
    worker.isExecutionLocked = false;
    worker.workerState = WORKER_STATES.IDLE;
  });

  // Test 9: MP4 Buffer Deep Validation
  test("9. ISOBMFF MP4 validator confirms valid buffer and rejects malformed/truncated buffer", () => {
    const validBuffer = createValidMp4Buffer();
    const validCheck = validateMp4(validBuffer);
    assert.strictEqual(validCheck.valid, true, "Valid MP4 buffer should pass validation");
    assert.strictEqual(validCheck.hasVideoTrack, true);
    assert.strictEqual(validCheck.duration, 10);

    const corruptBuffer = Buffer.from([0x00, 0x00, 0x00, 0x20, 0x41, 0x42, 0x43, 0x44]);
    const corruptCheck = validateMp4(corruptBuffer);
    assert.strictEqual(corruptCheck.valid, false, "Corrupt buffer must be rejected");
  });

  // Test 10: Complete 10-Channel Round-Robin Execution Loop
  await asyncTest("10. Full 10-channel round-robin rotation (Channel 1 -> 10 -> 1) with candidate processing", async () => {
    cleanup();
    const state = new ExternalSourceState({ stateFilePath: TEST_STATE_FILE });
    state.setRoundRobinPointer(1);

    // Enqueue 1 candidate for each channel 1..10
    const candidates = [];
    for (let c = 1; c <= 10; c++) {
      candidates.push({
        sourceItemId: `rr_post_${c}`,
        title: `RR Item Channel ${c}`,
        pageUrl: `https://test.local/post/${c}`,
        mediaUrl: `https://test.local/media_${c}.mp4`,
        channelIndex: c,
        destinationChannelId: `-10020000000${String(c).padStart(2, "0")}`
      });
    }
    state.enqueueCandidates(candidates);
    assert.strictEqual(state.candidateQueue.length, 10);

    const orchestrator = new AvseePipelineOrchestrator({
      dryRun: true,
      tempDir: TEST_DIR,
      stateStore: state
    });

    // Mock successful pipeline processing
    orchestrator.processAuthorizedPost = async (cand) => ({
      success: true,
      pipelineState: "DRY_RUN_SUCCESS",
      selectedPostId: cand.sourceItemId,
      downloadedDuration: 120,
      sizeBytes: 1048576,
      telegramMessageId: 1000 + cand.channelIndex
    });

    const worker = new AvseeAutomatedWorker({
      stateFilePath: TEST_STATE_FILE,
      tempDir: TEST_DIR,
      orchestrator
    });

    // Execute 10 consecutive ticks
    for (let expectedChan = 1; expectedChan <= 10; expectedChan++) {
      const res = await worker.runOnce({ forceDiscovery: false });
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.channelIndex, expectedChan, `Cycle should process Channel ${expectedChan}`);
      assert.strictEqual(res.selectedPostId, `rr_post_${expectedChan}`);
      const nextExpected = (expectedChan % 10) + 1;
      assert.strictEqual(res.nextChannelIndex, nextExpected);
      assert.strictEqual(state.getRoundRobinPointer(), nextExpected);
    }

    // Confirm candidate queue is now empty
    assert.strictEqual(state.candidateQueue.length, 0);

    // Confirm pointer is back at Channel 1
    assert.strictEqual(state.getRoundRobinPointer(), 1);

    // Confirm all 10 items recorded as DELIVERED
    for (let c = 1; c <= 10; c++) {
      const dest = `-10020000000${String(c).padStart(2, "0")}`;
      assert.strictEqual(state.isDeliveredToDestination(`rr_post_${c}`, dest), true);
    }
  });

  cleanup();

  console.log("\n============================================================");
  console.log(`🎉 ALL ${passed}/${total} AUTOMATED WORKER & ROUND-ROBIN TESTS PASSED!`);
  console.log("============================================================\n");
}

runTests().catch(err => {
  console.error("FATAL TEST FAILURE:", err);
  process.exit(1);
});
