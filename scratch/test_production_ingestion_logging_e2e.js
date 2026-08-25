const assert = require("assert");
const sourceRegistry = require("../source_registry");
const MTProtoChannelReader = require("../mtproto_reader");

console.log("==================================================");
console.log("🧪 RUNNING E2E IDEMPOTENCY & INGESTION LOGGING SUITE");
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

async function runIdempotencyAndLoggingTests() {
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

  const targetChannel = "Dating";
  const nowSec = Math.floor(Date.now() / 1000);

  // Clear existing Dating posts for isolated idempotency testing
  sourceRegistry.posts = sourceRegistry.posts.filter(p => sourceRegistry.resolveKeyword(p.keyword) !== "Dating");

  // TEST 1: First Startup Sync (100 historical posts)
  startCapture();
  let firstNew = 0;
  let firstSkipped = 0;
  for (let i = 1; i <= 100; i++) {
    const res = sourceRegistry.processChannelPost({
      chat: { id: "-10012345678", title: targetChannel, username: "cccsefk" },
      message_id: 1000 + i,
      date: nowSec + i,
      video: { duration: 25, file_id: `BAACAgUAAxkBAAI_SYNC1_${i}` },
      caption: `Historical Video #${i}`
    }, targetChannel, true); // isStartupSync = true
    if (res && res.isNew) firstNew++; else firstSkipped++;
  }
  stopCapture();

  const postsAfterSync1 = sourceRegistry.getPostsForKeyword(targetChannel, true);
  check(postsAfterSync1.length === 40 && firstNew === 40, `TEST 1: First sync inserted genuinely new records up to 40 max retention cap (new=${firstNew}, total=${postsAfterSync1.length})`);

  // TEST 2: Second Startup Sync (Same 100 historical posts) -> IDEMPOTENCY AUDIT
  startCapture();
  let secondNew = 0;
  let secondSkipped = 0;
  for (let i = 1; i <= 100; i++) {
    const res = sourceRegistry.processChannelPost({
      chat: { id: "-10012345678", title: targetChannel, username: "cccsefk" },
      message_id: 1000 + i,
      date: nowSec + i,
      video: { duration: 25, file_id: `BAACAgUAAxkBAAI_SYNC1_${i}` },
      caption: `Historical Video #${i}`
    }, targetChannel, true);
    if (res && res.isNew) secondNew++; else secondSkipped++;
  }
  stopCapture();

  const postsAfterSync2 = sourceRegistry.getPostsForKeyword(targetChannel, true);
  check(secondNew === 0 && secondSkipped === 100 && postsAfterSync2.length === 40, `TEST 2: Second startup sync detected 100 duplicates (new=${secondNew}, skipped=${secondSkipped}, total=${postsAfterSync2.length})`);

  // TEST 3: Third Startup Sync (Same 100 posts) -> IDEMPOTENCY AUDIT
  let thirdNew = 0;
  let thirdSkipped = 0;
  for (let i = 1; i <= 100; i++) {
    const res = sourceRegistry.processChannelPost({
      chat: { id: "-10012345678", title: targetChannel, username: "cccsefk" },
      message_id: 1000 + i,
      date: nowSec + i,
      video: { duration: 25, file_id: `BAACAgUAAxkBAAI_SYNC1_${i}` },
      caption: `Historical Video #${i}`
    }, targetChannel, true);
    if (res && res.isNew) thirdNew++; else thirdSkipped++;
  }
  check(thirdNew === 0 && thirdSkipped === 100, `TEST 3: Third startup sync detected 100 duplicates (new=${thirdNew}, skipped=${thirdSkipped})`);

  // TEST 4: Real-time Live New Video Arrival
  startCapture();
  const liveNewRes = sourceRegistry.processChannelPost({
    chat: { id: "-10012345678", title: targetChannel, username: "cccsefk" },
    message_id: 9999,
    date: nowSec + 999,
    video: { duration: 30, file_id: "BAACAgUAAxkBAAI_LIVE_NEW_001" },
    caption: "Live New Video Arrival"
  }, targetChannel, false); // isStartupSync = false
  stopCapture();

  const postsAfterLive = sourceRegistry.getPostsForKeyword(targetChannel, true);
  const ingestLogs = capturedLogs.filter(l => l.includes("📥 [INGEST]"));

  check(liveNewRes.isNew === true && ingestLogs.length === 1 && String(postsAfterLive[0].message_id) === "9999", "TEST 4: Live new video arrival unshifted to Page 1 Position #1 with exactly 1 [INGEST] log line");

  // TEST 5: Duplicate Live Message Received Twice
  startCapture();
  const dupLiveRes = sourceRegistry.processChannelPost({
    chat: { id: "-10012345678", title: targetChannel, username: "cccsefk" },
    message_id: 9999, // Duplicate message ID
    date: nowSec + 999,
    video: { duration: 30, file_id: "BAACAgUAAxkBAAI_LIVE_NEW_001" },
    caption: "Live New Video Arrival Duplicate"
  }, targetChannel, false);
  stopCapture();

  const dupIngestLogs = capturedLogs.filter(l => l.includes("📥 [INGEST]"));
  check(dupLiveRes.isNew === false && dupIngestLogs.length === 0, "TEST 5: Duplicate live message produced 0 duplicate records and 0 [INGEST] logs");

  // TEST 6: Same Message ID Across Different Channels (Channel Isolation)
  sourceRegistry.processChannelPost({
    chat: { id: "-10088888888", title: "Romance", username: "e5brygh" },
    message_id: 9999, // Same message ID but different channel
    date: nowSec + 1000,
    video: { duration: 22, file_id: "BAACAgUAAxkBAAI_ROMANCE_9999" },
    caption: "Romance Channel Video with msgId 9999"
  }, "Romance", true);

  const romancePosts = sourceRegistry.getPostsForKeyword("Romance", true);
  const datingPosts = sourceRegistry.getPostsForKeyword("Dating", true);

  const foundInRomance = romancePosts.some(p => String(p.message_id) === "9999");
  const datingCount9999 = datingPosts.filter(p => String(p.message_id) === "9999").length;

  check(foundInRomance && datingCount9999 === 1, "TEST 6: Same message ID across different channels maintains strict channel isolation (1 in Dating, 1 in Romance)");

  // TEST 7: MTProto Reader Concurrency Lock
  const reader = new MTProtoChannelReader();
  reader.isSyncing = true;
  startCapture();
  const syncRes = await reader.syncAllChannels(5, true);
  stopCapture();
  check(syncRes.length === 0 && capturedLogs.some(l => l.includes("already in progress")), "TEST 7: Concurrent MTProto sync blocked cleanly by isSyncing lock");
  reader.isSyncing = false;

  console.log("\n==================================================");
  console.log(`📊 E2E IDEMPOTENCY & LOGGING RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("==================================================");

  if (failed > 0) process.exit(1);
}

runIdempotencyAndLoggingTests().catch(err => {
  console.error("❌ E2E Idempotency Test Error:", err);
  process.exit(1);
});
