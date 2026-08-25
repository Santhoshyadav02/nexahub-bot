const sourceRegistry = require('../source_registry');

console.log("==================================================");
console.log("📡 VERIFYING PRODUCTION MTPROTO SOURCE REGISTRY & CHANNELS");
console.log("==================================================\n");

const targetChannels = [
  "Romantic Vibe", "Dating", "Romance", "Crotch", "Mosa",
  "Bunny Girl Cosplay Date", "Lustful Hostess", "Concubine", "Saki Mizumi", "A Muse"
];

const checkpoints = sourceRegistry.loadCheckpoints ? sourceRegistry.loadCheckpoints() : {};
let validCount = 0;

targetChannels.forEach((keyword) => {
  const posts = sourceRegistry.getPostsForKeyword(keyword);
  const cp = checkpoints[keyword] || {};
  console.log(`Channel [${keyword}]:`);
  console.log(`  - Posts count: ${posts.length}`);
  console.log(`  - Checkpoint last_msg_id: ${cp.last_msg_id || 'N/A'}`);
  console.log(`  - Last updated: ${cp.updated_at || 'N/A'}`);
  if (posts.length > 0) {
    validCount++;
    console.log(`  - Latest Post Title: "${posts[0].title}"`);
  }
  console.log("");
});

console.log(`==================================================`);
console.log(`📊 TOTAL ACTIVE MTPROTO CHANNELS WITH POSTS: ${validCount} / 10`);
console.log(`==================================================`);
