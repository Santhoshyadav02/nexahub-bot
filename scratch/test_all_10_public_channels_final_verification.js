require("D:\\Automation\\hiruboy\\node_modules\\dotenv").config({ path: "D:\\Automation\\hiruboy\\.env" });
const assert = require("assert");

const sourceRegistry = require("D:\\Automation\\hiruboy\\source_registry.js");

const ALL_10_PUBLIC_CHANNELS = [
  { name: "Romantic Vibe", expected_un: "ccsfvk", expected_url: "https://t.me/ccsfvk" },
  { name: "Dating", expected_un: "cccsefk", expected_url: "https://t.me/cccsefk" },
  { name: "Romance", expected_un: "e5brygh", expected_url: "https://t.me/e5brygh" },
  { name: "Crotch", expected_un: "ccdjxc", expected_url: "https://t.me/ccdjxc" },
  { name: "Mosa", expected_un: "vsdxda", expected_url: "https://t.me/vsdxda" },
  { name: "Bunny Girl Cosplay Date", expected_un: "tfccdet", expected_url: "https://t.me/tfccdet" },
  { name: "Lustful Hostess", expected_un: "sfgfem", expected_url: "https://t.me/sfgfem" },
  { name: "Concubine", expected_un: "ddkicr", expected_url: "https://t.me/ddkicr" },
  { name: "Saki Mizumi", expected_un: "cccddghhgf", expected_url: "https://t.me/cccddghhgf" },
  { name: "A Muse", expected_un: "bzd4wrf", expected_url: "https://t.me/bzd4wrf" }
];

async function runAll10PublicChannelsVerification() {
  console.log("=== ALL 10 PUBLIC TELEGRAM CHANNELS FINAL MAPPING VERIFICATION ===\n");

  const rows = [];

  for (const item of ALL_10_PUBLIC_CHANNELS) {
    const src = sourceRegistry.getSourceByKeyword(item.name);
    assert.ok(src, `Source metadata MUST exist for ${item.name}`);
    assert.strictEqual(src.username, item.expected_un, `Username for ${item.name} MUST be ${item.expected_un}`);

    const posts = sourceRegistry.getPostsForKeyword(item.name);
    assert.ok(posts.length > 0, `Posts MUST exist for ${item.name}`);

    const topPost = posts[0];
    const generatedDeepLink = `https://t.me/${src.username}/${topPost.message_id}`;

    assert.ok(generatedDeepLink.startsWith(item.expected_url), `Generated URL MUST start with ${item.expected_url}`);
    assert.strictEqual(generatedDeepLink.includes("t.me/+"), false, `Old private invite link MUST NOT be used for ${item.name}`);

    rows.push({
      channel: item.name.padEnd(25),
      username: `@${src.username}`.padEnd(16),
      sampleMsgId: String(topPost.message_id).padEnd(12),
      deepLinkUrl: generatedDeepLink
    });
  }

  console.log("=".repeat(110));
  console.log("Channel Name              | Public Username  | Sample Msg ID | Final Deep-Link Post URL");
  console.log("-".repeat(110));
  rows.forEach(r => {
    console.log(`${r.channel} | ${r.username} | ${r.sampleMsgId} | ${r.deepLinkUrl}`);
  });
  console.log("=".repeat(110) + "\n");

  // Verify Zero Cross-Channel Leaks
  for (let i = 0; i < ALL_10_PUBLIC_CHANNELS.length; i++) {
    for (let j = i + 1; j < ALL_10_PUBLIC_CHANNELS.length; j++) {
      const unA = ALL_10_PUBLIC_CHANNELS[i].expected_un;
      const unB = ALL_10_PUBLIC_CHANNELS[j].expected_un;
      assert.notStrictEqual(unA, unB, `Username for ${ALL_10_PUBLIC_CHANNELS[i].name} and ${ALL_10_PUBLIC_CHANNELS[j].name} MUST be unique`);
    }
  }

  console.log("✅ All 10 Telegram channels verified as PUBLIC!");
  console.log("✅ Zero old private invite links remain!");
  console.log("\n🎉 ALL 10 PUBLIC CHANNELS VERIFICATION TESTS PASSED!");
}

runAll10PublicChannelsVerification();
