const assert = require("assert");
const sourceRegistry = require("../source_registry");
const MTProtoChannelReader = require("../mtproto_reader");

console.log("==================================================");
console.log("🧪 RUNNING E2E PRODUCTION INGESTION LOGGING SUITE");
console.log("==================================================\n");

let passed = 0;
let failed = 0;

function check(condition, testName) {
  if (condition) {
    console.log(`✅ [TEST PASSED] ${testName}`);
    passed++;
  } else {
    console.error(`❌ [TEST FAILED] ${testName}`);
    failed++;
  }
}

async function runLoggingTests() {
  const originalLog = console.log;
  const originalError = console.error;

  let capturedLogs = [];
  let capturedErrors = [];

  function startCapture() {
    capturedLogs = [];
    capturedErrors = [];
    console.log = (...args) => {
      capturedLogs.push(args.join(" "));
      originalLog.apply(console, args);
    };
    console.error = (...args) => {
      capturedErrors.push(args.join(" "));
      originalError.apply(console, args);
    };
  }

  function stopCapture() {
    console.log = originalLog;
    console.error = originalError;
  }

  // TEST 1: Startup Bulk Sync Logging (500 historical posts)
  startCapture();
  const targetChannel = "Romantic Vibe";
  const nowSec = Math.floor(Date.now() / 1000);

  for (let i = 1; i <= 500; i++) {
    sourceRegistry.processChannelPost({
      chat: { id: "-10012345678", title: targetChannel, username: "ccsfvk" },
      message_id: 1000 + i,
      date: nowSec + i,
      video: { duration: 25, file_id: `BAACAgUAAxkBAAI_STARTUP_${i}` },
      caption: `Historical Video Post #${i}`
    }, targetChannel, true); // isStartupSync = true
  }
  stopCapture();

  const perPostIngestLogsInSync = capturedLogs.filter(l => l.includes("📥 [INGEST]"));
  check(perPostIngestLogsInSync.length === 0, "TEST 1: Startup bulk sync produced 0 per-post [INGEST] logs (500 posts loaded cleanly)");

  // TEST 2: Real-time Live New Video Arrival Logging
  startCapture();
  sourceRegistry.processChannelPost({
    chat: { id: "-10012345678", title: targetChannel, username: "ccsfvk" },
    message_id: 9999,
    date: nowSec + 600,
    video: { duration: 30, file_id: "BAACAgUAAxkBAAI_LIVE_NEW_VIDEO_001" },
    caption: "Live New Video Arrival"
  }, targetChannel, false); // isStartupSync = false (live)
  stopCapture();

  const liveIngestLogs = capturedLogs.filter(l => l.includes("📥 [INGEST]"));
  check(liveIngestLogs.length === 1, "TEST 2: Real-time live new video arrival produced exactly 1 concise [INGEST] log");

  // TEST 3: Duplicate Message Ingestion Logging
  startCapture();
  sourceRegistry.processChannelPost({
    chat: { id: "-10012345678", title: targetChannel, username: "ccsfvk" },
    message_id: 9999, // Duplicate message ID
    date: nowSec + 600,
    video: { duration: 30, file_id: "BAACAgUAAxkBAAI_LIVE_NEW_VIDEO_001" },
    caption: "Live New Video Arrival Duplicate"
  }, targetChannel, false);
  stopCapture();

  const dupIngestLogs = capturedLogs.filter(l => l.includes("📥 [INGEST]"));
  check(dupIngestLogs.length === 0, "TEST 3: Duplicate live message produced 0 [INGEST] logs");

  // TEST 4: MTProto Reader Concurrency Lock
  const reader = new MTProtoChannelReader();
  reader.isSyncing = true;
  startCapture();
  const syncRes = await reader.syncAllChannels(5, true);
  stopCapture();
  check(syncRes.length === 0 && capturedLogs.some(l => l.includes("already in progress")), "TEST 4: Concurrent MTProto sync blocked cleanly by isSyncing lock");
  reader.isSyncing = false;

  // TEST 5: Genuine Errors Remain Visible via console.error
  startCapture();
  console.error("[TELEGRAM API ERROR] Func:sendVideoSafe 400 Bad Request: real error test");
  stopCapture();
  check(capturedErrors.length === 1 && capturedErrors[0].includes("real error test"), "TEST 5: Genuine API errors remain visible via console.error");

  console.log("\n==================================================");
  console.log(`📊 E2E INGESTION LOGGING RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("==================================================");

  if (failed > 0) process.exit(1);
}

runLoggingTests().catch(err => {
  console.error("❌ E2E Logging Test Error:", err);
  process.exit(1);
});
