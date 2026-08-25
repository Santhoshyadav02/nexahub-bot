require("dotenv").config();
const assert = require("assert");

const MTProtoChannelReader = require("../mtproto_reader.js");
const indexApp = require("../index.js");
const sourceRegistry = require("../source_registry.js");

async function runMTProtoMediaResolutionIntegrationTest() {
  console.log("=== MTPROTO MEDIA RESOLUTION INTEGRATION TEST ===\n");

  // 1. Ingest a brand new post WITHOUT any file_id in cache or record
  const uniqueMsgId = Date.now() + Math.floor(Math.random() * 1000);
  const targetChannelName = "MTProto Dynamic Channel " + Date.now();
  const uniqueChatId = "-100" + Math.floor(100000000 + Math.random() * 900000000);
  const dummyPost = {
    chat_id: uniqueChatId,
    message_id: uniqueMsgId,
    chat: { id: uniqueChatId, title: targetChannelName, username: "mtproto_fresh_" + Date.now() },
    text: "🎬 Newly Synchronized Video Post",
    date: Math.floor(Date.now() / 1000)
  };

  sourceRegistry.processChannelPost(dummyPost, targetChannelName);
  const posts = sourceRegistry.getPostsForKeyword(targetChannelName);
  assert.ok(posts.length > 0, "Ingested post MUST exist");

  const unCachedItem = posts[0];

  // Verify missing file_id initially
  const initialCachedId = indexApp.getCachedFileId(unCachedItem.id || unCachedItem.unique_hash);
  assert.strictEqual(initialCachedId, null, "Initial cached file_id MUST be null!");
  console.log("   ✅ Verified initial file_id is NULL for newly synchronized post.");

  // 2. Stub/Mock MTProto channel reader resolveMediaForPost method
  const mockFileId = "BAACAgUAAxkBAAI_STUBBED_MTPROTO_FILE_ID_DYNAMIC";
  let mtprotoResolvedCalled = false;

  const originalResolveMedia = MTProtoChannelReader.prototype.resolveMediaForPost;
  MTProtoChannelReader.prototype.resolveMediaForPost = async function(post) {
    mtprotoResolvedCalled = true;
    return {
      message_id: post.message_id,
      file_id: mockFileId,
      type: "video",
      has_media: true
    };
  };

  // 3. Stub process.env.TELEGRAM_SESSION_STRING to trigger MTProto path
  process.env.TELEGRAM_SESSION_STRING = "1AZVjY0YBu8v...STUBBED_SESSION";

  // 4. Execute renderItemDetailPage
  const testChatId = 555666777;
  const callbackPrefix = `topic_page:${targetChannelName}`;
  const page = 2;
  const itemIndex = 0;

  await indexApp.renderItemDetailPage(testChatId, callbackPrefix, itemIndex, page, null);

  // Restore original methods
  MTProtoChannelReader.prototype.resolveMediaForPost = originalResolveMedia;

  // 5. Assertions
  console.log("\n📌 Integration Test Assertions:");
  
  // A. MTProto resolution executed
  assert.strictEqual(mtprotoResolvedCalled, true, "MTProto resolveMediaForPost MUST be called when file_id is missing!");
  console.log("   ✅ MTProto media resolution triggered successfully.");

  // B. Cache updated
  const newlyCachedId = indexApp.getCachedFileId(unCachedItem.id || unCachedItem.unique_hash);
  assert.strictEqual(newlyCachedId, mockFileId, "Resolved file_id MUST be saved to local cache!");
  console.log(`   ✅ Resolved file_id saved to local cache: ${newlyCachedId}`);

  console.log("\n🎉 MTPROTO MEDIA RESOLUTION INTEGRATION TEST PASSED!");
}

runMTProtoMediaResolutionIntegrationTest().catch(err => {
  console.error("❌ INTEGRATION TEST FAILED:", err);
  process.exit(1);
});
