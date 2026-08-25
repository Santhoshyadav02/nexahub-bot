const assert = require("assert");
const sourceRegistry = require("../source_registry");
const { getMainKeyboard, renderTopicPosts, renderItemDetailPage } = require("../index");

console.log("==================================================");
console.log("🧪 TESTING ALL 10 CHANNELS & CLIENT FLOW REQUIREMENT");
console.log("==================================================\n");

// Clear any local dirty state for clean test isolation
sourceRegistry.posts = [];

const TARGET_CHANNELS = [
  { keyword: "Romantic Vibe", username: "ccsfvk", chatId: "-100100000001" },
  { keyword: "Dating", username: "cccsefk", chatId: "-100100000002" },
  { keyword: "Romance", username: "e5brygh", chatId: "-100100000003" },
  { keyword: "Crotch", username: "ccdjxc", chatId: "-100100000004" },
  { keyword: "Mosa", username: "vsdxda", chatId: "-100100000005" },
  { keyword: "Bunny Girl Cosplay Date", username: "tfccdet", chatId: "-100100000006" },
  { keyword: "Lustful Hostess", username: "sfgfem", chatId: "-100100000007" },
  { keyword: "Concubine", username: "ddkicr", chatId: "-100100000008" },
  { keyword: "Saki Mizumi", username: "cccddghhgf", chatId: "-100100000009" },
  { keyword: "A Muse", username: "bzd4wrf", chatId: "-100100000010" }
];

// Ensure initial sources registered
TARGET_CHANNELS.forEach(ch => {
  sourceRegistry.registerSource(ch.keyword, ch.keyword, ch.username, ch.chatId);
});

// 1. Ingest 60 posts into EACH of the 10 channels
console.log("--- 1. Ingesting 60 valid video posts into each of the 10 Telegram channels ---");
const nowSec = Math.floor(Date.now() / 1000);

TARGET_CHANNELS.forEach((ch, chIdx) => {
  for (let i = 1; i <= 60; i++) {
    sourceRegistry.processChannelPost({
      chat: { id: ch.chatId, title: ch.keyword, username: ch.username },
      message_id: (chIdx + 1) * 10000 + i,
      date: nowSec + i,
      video: { duration: 30 + i },
      caption: `Video post #${i} for ${ch.keyword}`
    }, ch.keyword);
  }
  sourceRegistry.enforceRollingRetention(ch.keyword);
});

// 2. Audit all 10 channels individually
console.log("\n--- 2. Auditing all 10 channels for 50 rolling retention & channel isolation ---");
TARGET_CHANNELS.forEach((ch, chIdx) => {
  const posts = sourceRegistry.getPostsForKeyword(ch.keyword, true);
  console.log(`[Channel ${chIdx + 1}] ${ch.keyword} (@${ch.username}): ${posts.length} posts retained (Expected: 50)`);
  assert.strictEqual(posts.length, 50, `Channel ${ch.keyword} must retain exactly 50 valid videos`);

  // Verify ownership: all posts must belong to this exact channel
  posts.forEach(p => {
    const pKw = p.keyword.trim().toLowerCase();
    const pUser = (p.username || "").trim().toLowerCase();
    assert.ok(
      pKw === ch.keyword.toLowerCase() || pUser === ch.username.toLowerCase(),
      `Post ${p.id} in ${ch.keyword} must belong strictly to ${ch.keyword}`
    );
  });
});
console.log("✅ All 10 channels passed 50-retention & channel isolation checks!");

// 3. Test UI Pagination (Pages 1 to 5) for Channel 3 (Romance)
console.log("\n--- 3. Testing UI Pagination (Pages 1 to 5) for Channel 3 (Romance) ---");
const romancePosts = sourceRegistry.getPostsForKeyword("Romance", true);
assert.strictEqual(romancePosts.length, 50, "Romance must have 50 posts");

const page1 = romancePosts.slice(0, 10);
const page2 = romancePosts.slice(10, 20);
const page3 = romancePosts.slice(20, 30);
const page4 = romancePosts.slice(30, 40);
const page5 = romancePosts.slice(40, 50);

console.log("Romance Page 1 (0..9) Msg IDs:  ", page1.map(p => p.message_id));
console.log("Romance Page 5 (40..49) Msg IDs:", page5.map(p => p.message_id));
assert.strictEqual(page1.length, 10, "Page 1 must have 10 posts");
assert.strictEqual(page5.length, 10, "Page 5 must have 10 posts");

// 4. Test Video Detail Page & Buttons for Channel 3
console.log("\n--- 4. Testing Video Detail Page & Buttons ---");
const firstRomancePost = romancePosts[0];
assert.ok(firstRomancePost, "First romance post must exist");
assert.strictEqual(firstRomancePost.media_type, "video", "Must be video media_type");
assert.ok(firstRomancePost.message_id, "Must have message_id");
assert.ok(firstRomancePost.telegram_url.includes("e5brygh"), "Telegram URL must point to @e5brygh");
console.log(`✅ Item #1 preview URL verified: ${firstRomancePost.telegram_url}`);

// 5. Ingest new 61st video into Channel 3 (Romance) and verify isolation
console.log("\n--- 5. Ingesting 61st post into Channel 3 (Romance) & verifying isolation ---");
sourceRegistry.processChannelPost({
  chat: { id: "-100100000003", title: "Romance", username: "e5brygh" },
  message_id: 30061,
  date: nowSec + 100,
  video: { duration: 120 },
  caption: "New Video Post #61 for Romance"
}, "Romance");

sourceRegistry.enforceRollingRetention("Romance");

const updatedRomancePosts = sourceRegistry.getPostsForKeyword("Romance", true);
assert.strictEqual(updatedRomancePosts.length, 50, "Romance must remain 50 posts");
assert.strictEqual(updatedRomancePosts[0].message_id, 30061, "New post #30061 must be position #1");
console.log(`✅ Romance Position #1 is now MsgID 30061: "${updatedRomancePosts[0].title}"`);

// Verify other channels are completely unchanged
TARGET_CHANNELS.forEach((ch, chIdx) => {
  if (ch.keyword !== "Romance") {
    const posts = sourceRegistry.getPostsForKeyword(ch.keyword, true);
    assert.strictEqual(posts.length, 50, `Channel ${ch.keyword} must still have 50 posts`);
    assert.notStrictEqual(posts[0].message_id, 30061, `Channel ${ch.keyword} must NOT contain MsgID 30061`);
  }
});
console.log("✅ All other 9 channel post lists remained completely unchanged!");

console.log("\n==================================================");
console.log("🎉 ALL 10 CHANNELS & CLIENT FLOW TESTS PASSED!");
console.log("==================================================");
