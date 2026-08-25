const assert = require("assert");
const sourceRegistry = require("../source_registry");

console.log("==================================================");
console.log("🧪 TESTING OPTIMIZED LOGGING & NEW VIDEO TOP RANKING");
console.log("==================================================\n");

// 1. Ingest new post into Dating channel
const nowSec = Math.floor(Date.now() / 1000);
const newPostMsg = {
  chat: { id: "-100111222333", title: "Dating", username: "cccsefk" },
  message_id: 99999,
  date: nowSec,
  video: { duration: 60, file_id: "vid_99999_test" },
  caption: "🚨 NEW TEST VIDEO ARRIVAL 99999"
};

const res = sourceRegistry.processChannelPost(newPostMsg, "Dating");
assert.ok(res && res.isNew === true, "New video ingestion must return isNew = true");

// 2. Verify top ranking position (#1)
const datingPosts = sourceRegistry.getPostsForKeyword("Dating", true);
assert.ok(datingPosts.length > 0, "Dating posts list must not be empty");
assert.strictEqual(datingPosts[0].message_id, 99999, "New video MUST be ranked at Position #1 (top)");
console.log(`✅ Top video (#1) verified: Message ID ${datingPosts[0].message_id} ("${datingPosts[0].title}")`);

// 3. Verify channel isolation (e.g. Romance list unaffected by Dating post)
const romancePosts = sourceRegistry.getPostsForKeyword("Romance", true);
const romanceHasNewMsg = romancePosts.some(p => p.message_id === 99999);
assert.strictEqual(romanceHasNewMsg, false, "Romance channel MUST NOT contain Dating post 99999");
console.log("✅ Channel isolation verified: Romance channel list unaffected");

console.log("\n==================================================");
console.log("🎉 OPTIMIZED LOGGING & NEW VIDEO TOP RANKING TEST PASSED!");
console.log("==================================================");
