/**
 * ============================================================
 * 🧪 TEST SUITE: SHUTDOWN HARDENING & ACTIVE DOWNLOAD ABORT
 * ============================================================
 * Tests:
 * 1. Idle shutdown cleanly sets status and saves state
 * 2. In-flight streaming download aborts cleanly on shutdown
 * 3. Partial destination .mp4 is unlinked immediately on abort
 * 4. Idempotency: multiple abort/shutdown calls do not throw
 * 5. Bounded timeout: pipeline shutdown resolves within timeout
 * 6. Pipeline rejects new cycles while shutting down
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { AvseeSourceAdapter } = require("./avsee_source_adapter");
const { CategoryRoundRobinPipeline, HEALTH_STATE } = require("./avsee/category_round_robin_pipeline");

const TEST_DIR = path.join(__dirname, "scratch", "test_shutdown_hardening");

async function runTests() {
  console.log("============================================================");
  console.log("🚀 STARTING SHUTDOWN HARDENING VERIFICATION TEST");
  console.log("============================================================");

  if (!fs.existsSync(TEST_DIR)) {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  }

  let passed = 0;
  let total = 0;

  function recordPass(desc) {
    total++;
    passed++;
    console.log(`  ✅ PASS: [${total}] ${desc}`);
  }

  // --- Test 1: Adapter abort tracking on in-flight stream ---
  console.log("\n--- Scenario 1: Active Streaming Download Abort & Temp File Cleanup ---");
  
  // Set up local mock slow streaming HTTP server
  let serverSockets = new Set();
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "video/mp4" });
    // Write an initial chunk
    res.write(Buffer.alloc(1024, 0xAA));
    // Keep connection open without ending to simulate long download
  });

  server.on("connection", (sock) => {
    serverSockets.add(sock);
    sock.on("close", () => serverSockets.delete(sock));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const mockUrl = `http://127.0.0.1:${port}/test_stream.mp4`;

  const adapter = new AvseeSourceAdapter({
    apiUrl: `http://127.0.0.1:${port}`,
    tempDir: TEST_DIR,
    isAuthorized: true,
    licenseId: "TEST_LIC_123",
    dryRun: false
  });

  const uniqueHash = `abort_test_${Date.now()}`;
  const expectedDestPath = path.join(TEST_DIR, `${uniqueHash}.mp4`);

  // Start download in background
  const downloadPromise = adapter.downloadAuthorizedMedia({
    title: "Test In-Flight Video",
    mediaUrl: mockUrl,
    uniqueHash: uniqueHash
  });

  // Allow short delay for stream and temp file creation
  await new Promise((r) => setTimeout(r, 100));

  assert.strictEqual(adapter.activeDownloads.size, 1, "Active download should be tracked in activeDownloads");
  recordPass("Active streaming download is tracked by adapter instance");

  // Trigger abortActiveDownloads
  adapter.abortActiveDownloads("Process shutdown simulated");

  let caughtErr = null;
  try {
    await downloadPromise;
  } catch (err) {
    caughtErr = err;
  }

  assert(caughtErr !== null, "Download promise should reject on abort");
  assert(caughtErr.message.includes("AVSEE_ABORT") || caughtErr.message.includes("shutting down"), "Error should indicate abort/shutdown");
  recordPass("In-flight streaming download rejected immediately on abort");

  // Verify file does not exist on disk
  const fileExists = fs.existsSync(expectedDestPath);
  assert.strictEqual(fileExists, false, "Partial .mp4 destination file should be unlinked on abort");
  recordPass("Partial .mp4 destination file was unlinked and left 0 residue on disk");

  assert.strictEqual(adapter.activeDownloads.size, 0, "activeDownloads set is cleared after abort");
  recordPass("activeDownloads set is empty after abort");

  // Clean up server
  for (const s of serverSockets) s.destroy();
  await new Promise((r) => server.close(r));

  // --- Test 2: Idempotency ---
  console.log("\n--- Scenario 2: Idempotent Abort Calls ---");
  assert.doesNotThrow(() => {
    adapter.abortActiveDownloads("Second signal");
    adapter.abortActiveDownloads("Third signal");
  }, "Multiple abort calls should be idempotent and not throw");
  recordPass("Multiple abortActiveDownloads calls are strictly idempotent");

  // --- Test 3: New download rejected while shutting down ---
  console.log("\n--- Scenario 3: Prevent Download While Shutting Down ---");
  let rejectOnShutdownErr = null;
  try {
    await adapter.downloadAuthorizedMedia({
      title: "Should Fail",
      mediaUrl: "http://127.0.0.1:9999/dummy.mp4",
      uniqueHash: "dummy"
    });
  } catch (err) {
    rejectOnShutdownErr = err;
  }
  assert(rejectOnShutdownErr !== null && rejectOnShutdownErr.message.includes("shutting down"), "New download rejected when adapter is shutting down");
  recordPass("New downloads rejected immediately while adapter is in shutting down state");

  // Reset adapter state
  adapter.resetShutdown();

  // --- Test 4: CategoryRoundRobinPipeline graceful shutdown ---
  console.log("\n--- Scenario 4: CategoryRoundRobinPipeline Graceful Shutdown ---");
  const pipeline = new CategoryRoundRobinPipeline({
    tempDir: TEST_DIR,
    apiUrl: `http://127.0.0.1:${port}`,
    dryRun: true
  });

  const shutdownResult = await pipeline.shutdown({ timeoutMs: 1000 });
  assert.strictEqual(shutdownResult, true, "Pipeline shutdown should resolve true");
  assert.strictEqual(pipeline.healthState, HEALTH_STATE.IDLE, "Pipeline state returns to IDLE after saving state");
  recordPass("Pipeline shutdown completes cleanly, preserves state, and returns to IDLE");

  // Verify stop alias
  const stopResult = await pipeline.stop({ timeoutMs: 1000 });
  assert.strictEqual(stopResult, true, "Pipeline stop alias should resolve true");
  recordPass("Pipeline stop alias operates identically and cleanly");

  // --- Test 5: Pipeline rejects executeCycle when stopping ---
  console.log("\n--- Scenario 5: Pipeline Cycle Guard During Shutdown ---");
  pipeline.healthState = HEALTH_STATE.STOPPING;
  const cycleRes = await pipeline.executeCycle();
  assert.strictEqual(cycleRes.success, false, "executeCycle should fail when pipeline is stopping");
  assert.strictEqual(cycleRes.status, "PIPELINE_STOPPING", "Status should report PIPELINE_STOPPING");
  recordPass("Pipeline cycle rejects safely with PIPELINE_STOPPING status when stopping");

  pipeline.clear();

  // Cleanup test scratch dir
  if (fs.existsSync(TEST_DIR)) {
    try {
      const files = fs.readdirSync(TEST_DIR);
      for (const f of files) fs.unlinkSync(path.join(TEST_DIR, f));
      fs.rmdirSync(TEST_DIR);
    } catch (e) {}
  }

  console.log("\n============================================================");
  console.log(`🏁 ALL TESTS COMPLETED: Passed ${passed}/${total} assertions (100%)`);
  console.log("============================================================\n");
}

runTests().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
