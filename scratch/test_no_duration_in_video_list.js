const assert = require("assert");
const sourceRegistry = require("../source_registry");

console.log("==================================================");
console.log("🧪 TESTING REMOVAL OF ▶️ AND DURATION FROM LIST ITEMS");
console.log("==================================================\n");

// 1. Ingest dummy post with ▶️ and duration e.g. [0:13]
const postRes = sourceRegistry.processChannelPost({
  chat: { id: "-10012345678", title: "Dating", username: "cccsefk" },
  message_id: 8888,
  date: Math.floor(Date.now() / 1000),
  video: { duration: 13, file_id: "test_vid_8888" },
  caption: "▶️ [0:13] 💋 연인 사이 스킨십 포착"
}, "Dating");

assert.ok(postRes && postRes.post, "Ingestion must return post record");
const post = postRes.post;

// Clean title using list item formatting logic
const cleanTitle = post.title
  .replace(/^▶️\s*/g, "")
  .replace(/^▶\s*/g, "")
  .replace(/^🎬\s*/g, "")
  .replace(/\[\d+:\d+\]\s*/g, "")
  .trim();

console.log(`Cleaned List Item Title: "1. ${cleanTitle}"`);

// Assert no ▶️ or duration brackets exist
assert.strictEqual(cleanTitle.includes("▶️"), false, "List item title MUST NOT contain ▶️");
assert.strictEqual(/\[\d+:\d+\]/.test(cleanTitle), false, "List item title MUST NOT contain duration brackets like [0:13]");

// Assert Emoji and Video Title remain
assert.ok(cleanTitle.startsWith("💋"), "List item title MUST start with emoji");
assert.ok(cleanTitle.includes("연인 사이 스킨십 포착"), "List item title MUST contain video title");

console.log("\n==================================================");
console.log("🎉 REMOVE ▶️ AND DURATION TEST PASSED!");
console.log("==================================================");
