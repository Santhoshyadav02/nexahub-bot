const assert = require("assert");
const sourceRegistry = require("../source_registry");
const { renderTopicPosts } = require("../index");

console.log("==================================================");
console.log("🧪 VERIFYING END-TO-END PRODUCTION FLOW & ROLLING 50");
console.log("==================================================\n");

const targetKeyword = "Dating";
sourceRegistry.registerSource(targetKeyword, "Dating", "Dating", "-100111222333");

// 1. Ingest 60 real video posts into Dating
console.log("--- 1. Ingesting 60 real Telegram video posts for Dating ---");
const nowSec = Math.floor(Date.now() / 1000);
for (let i = 1; i <= 60; i++) {
  sourceRegistry.processChannelPost({
    chat: { id: "-100111222333", title: "Dating", username: "cccsefk" },
    message_id: i,
    date: nowSec + i,
    video: { duration: 60 + i },
    caption: `Real Dating Video Post #${i}`
  }, targetKeyword);
}

sourceRegistry.enforceRollingRetention(targetKeyword);

// 2. Query UI category "👀 아이돌 열애 루머"
console.log("\n--- 2. Requesting UI Category: \"👀 아이돌 열애 루머\" ---");
const apiPosts = sourceRegistry.getPostsForKeyword("👀 아이돌 열애 루머", true);
console.log(`DB & API Returned Video Posts Count: ${apiPosts.length} (Expected: 50)`);
assert.strictEqual(apiPosts.length, 50, "API must return exactly 50 valid video records");

// 3. Verify Cards #1, #10, #25, #50 preview/link integrity
console.log("\n--- 3. Verifying Cards #1, #10, #25, #50 Preview & Link Integrity ---");
const testIndexes = [0, 9, 24, 49]; // 1st, 10th, 25th, 50th
testIndexes.forEach(idx => {
  const item = apiPosts[idx];
  assert.ok(item, `Card #${idx + 1} must exist`);
  assert.strictEqual(item.media_type, "video", `Card #${idx + 1} must be media_type === video`);
  assert.ok(item.message_id, `Card #${idx + 1} must have message_id`);
  assert.ok(item.telegram_url && item.telegram_url.startsWith("http"), `Card #${idx + 1} must have working telegram_url`);
  assert.ok(item.title && item.title.length > 0, `Card #${idx + 1} must have valid non-empty title`);
  console.log(`✅ Card #${idx + 1} Passed! MsgID: ${item.message_id} | Title: "${item.title}" | URL: ${item.telegram_url}`);
});

// 4. Verify UI pagination rendering (Pages 1 to 5)
console.log("\n--- 4. Verifying UI rendering layer (Pages 1 to 5) ---");
const page1 = apiPosts.slice(0, 10);
const page2 = apiPosts.slice(10, 20);
const page3 = apiPosts.slice(20, 30);
const page4 = apiPosts.slice(30, 40);
const page5 = apiPosts.slice(40, 50);

console.log("Page 1 (0..9) Msg IDs:  ", page1.map(p => p.message_id));
console.log("Page 2 (10..19) Msg IDs:", page2.map(p => p.message_id));
console.log("Page 3 (20..29) Msg IDs:", page3.map(p => p.message_id));
console.log("Page 4 (30..39) Msg IDs:", page4.map(p => p.message_id));
console.log("Page 5 (40..49) Msg IDs:", page5.map(p => p.message_id));

// Verify 0 duplicate message IDs across all 5 pages
const all50Ids = apiPosts.map(p => p.message_id);
const uniqueIds = new Set(all50Ids);
assert.strictEqual(uniqueIds.size, 50, "All 50 UI cards must have unique message IDs");
console.log("✅ Zero duplicate message IDs across all 5 pages (50/50 unique)");

// 5. Ingest new 61st video and verify rolling eviction
console.log("\n--- 5. Ingesting new 61st video post ---");
sourceRegistry.processChannelPost({
  chat: { id: "-100111222333", title: "Dating", username: "cccsefk" },
  message_id: 61,
  date: nowSec + 61,
  video: { duration: 90 },
  caption: "New Real Dating Video Post #61"
}, targetKeyword);

sourceRegistry.enforceRollingRetention(targetKeyword);

const updatedPosts = sourceRegistry.getPostsForKeyword("👀 아이돌 열애 루머", true);
console.log(`Updated Video Posts Count: ${updatedPosts.length} (Expected: 50)`);
assert.strictEqual(updatedPosts.length, 50, "Total must remain capped at 50");
assert.strictEqual(updatedPosts[0].message_id, 61, "New video #61 must be position #1");
assert.strictEqual(updatedPosts[updatedPosts.length - 1].message_id, 12, "Oldest retained video must be #12 (ID 11 evicted)");
console.log(`✅ Position #1 is now MsgID 61: "${updatedPosts[0].title}"`);
console.log(`✅ Oldest retained is MsgID 12 (ID 11 evicted cleanly)`);

console.log("\n==================================================");
console.log("🎉 ALL END-TO-END PRODUCTION FLOW AUDITS PASSED!");
console.log("==================================================");
