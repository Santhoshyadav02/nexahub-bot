require("D:\\Automation\\hiruboy\\node_modules\\dotenv").config({ path: "D:\\Automation\\hiruboy\\.env" });
const assert = require("assert");

const indexApp = require("D:\\Automation\\hiruboy\\index.js");
const sourceRegistry = require("D:\\Automation\\hiruboy\\source_registry.js");

async function runFinalSanityCheck() {
  console.log("=== FINAL SANITY CHECK BEFORE DEPLOYMENT ===\n");

  // 1. Verify Romance, Mosa, A Muse posts and zero duplicates
  const romancePosts = sourceRegistry.getPostsForKeyword("Romance");
  const mosaPosts = sourceRegistry.getPostsForKeyword("Mosa");
  const amusePosts = sourceRegistry.getPostsForKeyword("A Muse");

  console.log(`📌 1. Post Counts:`);
  console.log(`   - Romance : ${romancePosts.length} posts`);
  console.log(`   - Mosa    : ${mosaPosts.length} posts`);
  console.log(`   - A Muse  : ${amusePosts.length} posts`);

  assert.strictEqual(romancePosts.length, 15, "Romance MUST have 15 posts");
  assert.strictEqual(mosaPosts.length, 14, "Mosa MUST have 14 posts");
  assert.strictEqual(amusePosts.length, 14, "A Muse MUST have 14 posts");

  // Check 0 duplicates
  const seenHashes = new Set();
  for (const p of sourceRegistry.posts) {
    const hashKey = p.unique_hash || `${p.channel_name}_${p.message_id}`;
    assert.strictEqual(seenHashes.has(hashKey), false, `Duplicate post found for hash ${hashKey}`);
    seenHashes.add(hashKey);
  }
  console.log(`   ✅ 0 duplicate post hashes across all ${sourceRegistry.posts.length} stored posts!`);

  // 2. Confirm public usernames and zero private links
  const target3 = [
    { kw: "Romance", expectedUn: "e5brygh" },
    { kw: "Mosa", expectedUn: "vsdxda" },
    { kw: "A Muse", expectedUn: "bzd4wrf" }
  ];

  console.log(`\n📌 2. Public Usernames & URL Generation:`);
  target3.forEach(item => {
    const src = sourceRegistry.getSourceByKeyword(item.kw);
    assert.strictEqual(src.username, item.expectedUn, `Username for ${item.kw} MUST be ${item.expectedUn}`);
    assert.strictEqual(Boolean(src.invite_url), false, `Old invite_url MUST NOT exist on source ${item.kw}`);

    const posts = sourceRegistry.getPostsForKeyword(item.kw);
    const topPost = posts[0];
    const generatedUrl = `https://t.me/${src.username}/${topPost.message_id}`;
    assert.ok(generatedUrl.startsWith(`https://t.me/${item.expectedUn}/`), `URL for ${item.kw} MUST start with https://t.me/${item.expectedUn}/`);
    assert.strictEqual(generatedUrl.includes("t.me/+"), false, `Old private invite link MUST NOT be generated for ${item.kw}`);
    console.log(`   ✅ ${item.kw.padEnd(10)}: Username = @${src.username} | Sample URL = ${generatedUrl}`);
  });

  // 3. Confirm Main Keyboard Grid Mapping Verification
  console.log(`\n📌 3. Main Keyboard Grid Mapping Verification:`);
  const keyboardObj = await indexApp.getMainKeyboard();
  const buttons = keyboardObj.inline_keyboard.flat();
  assert.strictEqual(buttons.length, 20, "Main grid MUST contain 20 card buttons");

  // Card 3 & 13 -> Romance
  assert.strictEqual(buttons[2].callback_data, "topic:Romance", "Card 3 MUST map to topic:Romance");
  assert.strictEqual(buttons[12].callback_data, "topic:Romance", "Card 13 MUST map to topic:Romance");

  // Card 5 & 15 -> Mosa
  assert.strictEqual(buttons[4].callback_data, "topic:Mosa", "Card 5 MUST map to topic:Mosa");
  assert.strictEqual(buttons[14].callback_data, "topic:Mosa", "Card 15 MUST map to topic:Mosa");

  // Card 10 & 20 -> A Muse
  assert.strictEqual(buttons[9].callback_data, "topic:A Muse", "Card 10 MUST map to topic:A Muse");
  assert.strictEqual(buttons[19].callback_data, "topic:A Muse", "Card 20 MUST map to topic:A Muse");

  console.log(`   ✅ Card 3  & 13 -> topic:Romance`);
  console.log(`   ✅ Card 5  & 15 -> topic:Mosa`);
  console.log(`   ✅ Card 10 & 20 -> topic:A Muse`);

  console.log("\n🎉 ALL FINAL PRE-DEPLOYMENT SANITY CHECKS PASSED!");
}

runFinalSanityCheck();
