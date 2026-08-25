const assert = require("assert");
const sourceRegistry = require("../source_registry");

console.log("==================================================");
console.log("🧪 RUNNING ROLLING 50 VIDEO RETENTION TEST SUITE");
console.log("==================================================\n");

const testKeyword = "TestDatingSource";
sourceRegistry.registerSource(testKeyword, "", testKeyword, "-100999888777");

// 1. Insert 60 valid video posts (Message IDs 1..60)
console.log("--- 1. Ingesting 60 valid video posts (IDs 1..60) ---");
const nowSec = Math.floor(Date.now() / 1000);
for (let i = 1; i <= 60; i++) {
  sourceRegistry.processChannelPost({
    chat: { id: "-100999888777", title: testKeyword, username: "test_dating_chan" },
    message_id: i,
    date: nowSec + i,
    video: { duration: 45 },
    caption: `Test Video Post #${i}`
  }, testKeyword);
}

// 2. Enforce rolling 50 retention
sourceRegistry.enforceRollingRetention(testKeyword);

const posts60 = sourceRegistry.getPostsForKeyword(testKeyword, true);
console.log(`Total retained videos after 60 insertions: ${posts60.length} (Expected: 50)`);
assert.strictEqual(posts60.length, 50, "Should retain exactly 50 valid videos");

// 3. Verify newest 50 (IDs 60 down to 11) retained, oldest 10 (IDs 1..10) evicted
const msgIds60 = posts60.map(p => p.message_id);
console.log(`Newest message ID retained: ${msgIds60[0]} (Expected: 60)`);
console.log(`Oldest message ID retained: ${msgIds60[msgIds60.length - 1]} (Expected: 11)`);
assert.strictEqual(msgIds60[0], 60, "Newest message ID must be 60");
assert.strictEqual(msgIds60[msgIds60.length - 1], 11, "Oldest message ID retained must be 11");
assert.strictEqual(msgIds60.includes(10), false, "Message ID 10 must be evicted");
assert.strictEqual(msgIds60.includes(1), false, "Message ID 1 must be evicted");

// 4. Insert Video 61
console.log("\n--- 2. Ingesting Video 61 ---");
sourceRegistry.processChannelPost({
  chat: { id: "-100999888777", title: testKeyword, username: "test_dating_chan" },
  message_id: 61,
  date: nowSec + 61,
  video: { duration: 50 },
  caption: "Test Video Post #61"
}, testKeyword);

sourceRegistry.enforceRollingRetention(testKeyword);

const posts61 = sourceRegistry.getPostsForKeyword(testKeyword, true);
console.log(`Total retained videos after 61st insertion: ${posts61.length} (Expected: 50)`);
assert.strictEqual(posts61.length, 50, "Should still retain exactly 50 valid videos");

const msgIds61 = posts61.map(p => p.message_id);
console.log(`Newest message ID retained: ${msgIds61[0]} (Expected: 61)`);
console.log(`Oldest message ID retained: ${msgIds61[msgIds61.length - 1]} (Expected: 12)`);
assert.strictEqual(msgIds61[0], 61, "Newest message ID must be 61");
assert.strictEqual(msgIds61[msgIds61.length - 1], 12, "Oldest message ID retained must be 12");
assert.strictEqual(msgIds61.includes(11), false, "Message ID 11 must now be evicted");

// 5. Deduplication and Link/Preview validity checks
console.log("\n--- 3. Verifying deduplication and link/preview validity ---");
const uniqueSet = new Set(msgIds61);
assert.strictEqual(uniqueSet.size, 50, "All 50 retained message IDs must be unique");

posts61.forEach((p, idx) => {
  assert.strictEqual(p.media_type, "video", `Post #${idx + 1} must be media_type === video`);
  assert.ok(p.message_id, `Post #${idx + 1} must have message_id`);
  assert.ok(p.telegram_url && p.telegram_url.startsWith("http"), `Post #${idx + 1} must have valid HTTP telegram_url`);
  assert.ok(p.title && p.title.length > 0, `Post #${idx + 1} must have non-empty title`);
});
console.log("✅ All 50 retained posts passed strict link, preview, and media validation!");

console.log("\n==================================================");
console.log("📊 ROLLING 50 RETENTION TEST RESULTS: ALL PASSED!");
console.log("==================================================");
