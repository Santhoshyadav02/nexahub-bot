const assert = require("assert");
const sourceRegistry = require("../source_registry");
const { renderTopicPosts, renderItemDetailPage } = require("../index");

console.log("==================================================");
console.log("🧪 TESTING NEW TELEGRAM VIDEO ARRIVAL & LIVE FLOW");
console.log("==================================================\n");

const targetChannel = "Dating";
const targetUsername = "cccsefk";
const targetChatId = "-100111222333";
const newMsgId = 999;
const nowSec = Math.floor(Date.now() / 1000);

// 1. Simulate new Telegram video arriving after bot starts
console.log("--- 1. Simulating NEW Telegram Video post arriving after bot start ---");
const rawTelegramMsg = {
  chat: { id: targetChatId, title: targetChannel, username: targetUsername },
  message_id: newMsgId,
  date: nowSec,
  video: { duration: 75, file_id: "BAACAgUAAxkBAAI_LIVE_TEST_FILE_ID_999" },
  caption: "🚨 BRAND NEW LIVE DATING VIDEO POST #999"
};

const ingestResult = sourceRegistry.processChannelPost(rawTelegramMsg, targetChannel);
assert.ok(ingestResult && ingestResult.post, "Ingested post must return valid record");

// 2. Verify stored record properties
console.log("\n--- 2. Verifying stored source_registry record properties ---");
const storedPost = ingestResult.post;
console.log(`Stored media_type: ${storedPost.media_type} (Expected: video)`);
console.log(`Stored message_id: ${storedPost.message_id} (Expected: 999)`);
console.log(`Stored telegram_url: ${storedPost.telegram_url}`);
console.log(`Stored video_file_id: ${storedPost.video_file_id}`);

assert.strictEqual(storedPost.media_type, "video", "media_type MUST be video");
assert.strictEqual(storedPost.message_id, newMsgId, "message_id MUST match newMsgId");
assert.strictEqual(storedPost.video_file_id, "BAACAgUAAxkBAAI_LIVE_TEST_FILE_ID_999", "video_file_id MUST be stored");
assert.strictEqual(storedPost.telegram_url, `https://t.me/${targetUsername}/${newMsgId}`, "telegram_url MUST be canonical URL");

// 3. Verify Home card video query retrieves the new record at Position #1
console.log("\n--- 3. Verifying Home Card retrieval & Position #1 ranking ---");
const cardVideos = sourceRegistry.getPostsForKeyword("Dating", true);
assert.ok(cardVideos.length > 0, "Card video list must be non-empty");
assert.strictEqual(cardVideos[0].message_id, newMsgId, "New video MUST be position #1");
console.log(`✅ Position #1 video is: "${cardVideos[0].title}" (MsgID: ${cardVideos[0].message_id})`);

// 4. Verify Topic List rendering ([TOPIC_FLOW])
console.log("\n--- 4. Verifying Topic List rendering ---");
renderTopicPosts("12345678", "Dating", 1);

// 5. Verify Video Detail View ([VIDEO_DETAIL])
console.log("\n--- 5. Verifying Video Detail View ---");
renderItemDetailPage("12345678", "topic_page:Dating", 0, 1);

console.log("\n==================================================");
console.log("🎉 NEW TELEGRAM VIDEO ARRIVAL & LIVE FLOW TEST PASSED!");
console.log("==================================================");
