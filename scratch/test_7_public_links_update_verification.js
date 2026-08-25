require("D:\\Automation\\hiruboy\\node_modules\\dotenv").config({ path: "D:\\Automation\\hiruboy\\.env" });
const assert = require("assert");

const sourceRegistry = require("D:\\Automation\\hiruboy\\source_registry.js");

const UPDATED_CHANNELS = [
  { name: "Romantic Vibe", expected_url: "https://t.me/ccsfvk", expected_username: "ccsfvk" },
  { name: "Dating", expected_url: "https://t.me/cccsefk", expected_username: "cccsefk" },
  { name: "Crotch", expected_url: "https://t.me/ccdjxc", expected_username: "ccdjxc" },
  { name: "Bunny Girl Cosplay Date", expected_url: "https://t.me/tfccdet", expected_username: "tfccdet" },
  { name: "Lustful Hostess", expected_url: "https://t.me/sfgfem", expected_username: "sfgfem" },
  { name: "Concubine", expected_url: "https://t.me/ddkicr", expected_username: "ddkicr" },
  { name: "Saki Mizumi", expected_url: "https://t.me/cccddghhgf", expected_username: "cccddghhgf" }
];

const UNCHANGED_CHANNELS = [
  { name: "Romance", expected_invite: "https://t.me/+3g-HIjq_KgtkZDE5" },
  { name: "Mosa", expected_invite: "https://t.me/+hdaykD30jbdhNzlh" },
  { name: "A Muse", expected_invite: "https://t.me/+e-JQoCwT8wMyM2Zh" }
];

async function run7PublicLinksUpdateVerification() {
  console.log("=== 7 PUBLIC TELEGRAM LINKS UPDATE VERIFICATION ===\n");

  // 1. Verify 7 Updated Public Channels
  console.log("📌 1. Verifying 7 Updated Public Channels:");
  for (const item of UPDATED_CHANNELS) {
    const src = sourceRegistry.getSourceByKeyword(item.name);
    assert.ok(src, `Source MUST exist for ${item.name}`);
    assert.strictEqual(src.username, item.expected_username, `Username for ${item.name} MUST equal ${item.expected_username}`);

    const posts = sourceRegistry.getPostsForKeyword(item.name);
    assert.ok(posts.length > 0, `Posts MUST exist for ${item.name}`);

    const topPost = posts[0];
    const generatedUrl = topPost.username ? `https://t.me/${topPost.username}/${topPost.message_id}` : (src.username ? `https://t.me/${src.username}/${topPost.message_id}` : src.invite_url);

    assert.ok(generatedUrl.startsWith(item.expected_url), `Generated URL for ${item.name} MUST start with ${item.expected_url} but got ${generatedUrl}`);
    assert.strictEqual(generatedUrl.includes("t.me/+"), false, `Old private invite URL MUST NOT be used for ${item.name}`);

    console.log(`   ✅ ${item.name.padEnd(25)}: Username = @${item.expected_username.padEnd(12)} | Deep-link Post URL = ${generatedUrl}`);
  }

  // 2. Verify 3 Unchanged Private Channels
  console.log("\n📌 2. Verifying 3 Unchanged Private Channels (Must preserve existing invite links):");
  for (const item of UNCHANGED_CHANNELS) {
    const src = sourceRegistry.getSourceByKeyword(item.name);
    assert.ok(src, `Source MUST exist for ${item.name}`);
    assert.strictEqual(src.invite_url, item.expected_invite, `Invite URL for ${item.name} MUST equal ${item.expected_invite}`);

    const posts = sourceRegistry.getPostsForKeyword(item.name);
    assert.ok(posts.length > 0, `Posts MUST exist for ${item.name}`);

    const topPost = posts[0];
    const generatedUrl = (src && src.username) ? `https://t.me/${src.username}/${topPost.message_id}` : src.invite_url;

    assert.strictEqual(generatedUrl, item.expected_invite, `Generated URL for ${item.name} MUST equal ${item.expected_invite}`);

    console.log(`   ✅ ${item.name.padEnd(25)}: Invite Link Preserved = ${generatedUrl}`);
  }

  // 3. Verify Cross-Channel Mapping Isolation
  console.log("\n📌 3. Verifying Cross-Channel Isolation Across All 10 Channels:");
  const all10 = [...UPDATED_CHANNELS, ...UNCHANGED_CHANNELS];
  for (let i = 0; i < all10.length; i++) {
    for (let j = i + 1; j < all10.length; j++) {
      const srcA = sourceRegistry.getSourceByKeyword(all10[i].name);
      const srcB = sourceRegistry.getSourceByKeyword(all10[j].name);
      const urlA = srcA.username ? srcA.public_url : srcA.invite_url;
      const urlB = srcB.username ? srcB.public_url : srcB.invite_url;
      assert.notStrictEqual(urlA, urlB, `Channel ${all10[i].name} and ${all10[j].name} MUST NOT share the same access URL`);
    }
  }
  console.log("   ✅ Zero cross-channel URL collisions across all 10 channels!");

  console.log("\n🎉 ALL 7 PUBLIC LINKS UPDATE VERIFICATION TESTS PASSED!");
}

run7PublicLinksUpdateVerification();
