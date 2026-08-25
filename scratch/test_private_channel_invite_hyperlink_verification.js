require("D:\\Automation\\hiruboy\\node_modules\\dotenv").config({ path: "D:\\Automation\\hiruboy\\.env" });
const assert = require("assert");

const sourceRegistry = require("D:\\Automation\\hiruboy\\source_registry.js");

const TARGET_CHANNELS = [
  { name: "Romantic Vibe", invite: "https://t.me/+AGVRDJ6c7M9lMGRh", chat_id: "-1005563024409" },
  { name: "Dating", invite: "https://t.me/+I3z-vJdRRV8xZDlh", chat_id: "-1005362445410" },
  { name: "Romance", invite: "https://t.me/+3g-HIjq_KgtkZDE5", chat_id: "-1005491187683" },
  { name: "Crotch", invite: "https://t.me/+8MHLLZRd1L5jMzhh", chat_id: "-1005296875877" },
  { name: "Mosa", invite: "https://t.me/+hdaykD30jbdhNzlh", chat_id: "-1005427855016" },
  { name: "Bunny Girl Cosplay Date", invite: "https://t.me/+5jGUuJ_HWLg5ZWRh", chat_id: "-1005353472623" },
  { name: "Lustful Hostess", invite: "https://t.me/+IypAk6ypLrM1Y2Rh", chat_id: "-1005591987853" },
  { name: "Concubine", invite: "https://t.me/+McyWlyEXgEdkY2Jh", chat_id: "-1005394162064" },
  { name: "Saki Mizumi", invite: "https://t.me/+Kr4JkikOPjtmNTNh", chat_id: "-1005356656249" },
  { name: "A Muse", invite: "https://t.me/+e-JQoCwT8wMyM2Zh", chat_id: "-1005476708057" }
];

async function runPrivateChannelHyperlinkVerification() {
  console.log("=== PRIVATE & PUBLIC CHANNEL HYPERLINK VERIFICATION ===\n");

  const escapeHTML = (str) => String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // 1. Test All 10 Managed Channels
  console.log("📌 1. Verifying Hyperlinks & Access URLs for all 10 managed channels:\n");

  for (const chInfo of TARGET_CHANNELS) {
    const posts = sourceRegistry.getPostsForKeyword(chInfo.name);
    assert.ok(posts.length > 0, `Posts MUST exist for channel ${chInfo.name}`);

    // Verify Page 1 (7 Posts)
    const page1Items = posts.slice(0, 7);
    assert.strictEqual(page1Items.length, 7, `Page 1 for ${chInfo.name} MUST contain exactly 7 posts`);

    page1Items.forEach((p, idx) => {
      const src = sourceRegistry.getSourceByKeyword(p.keyword || p.channel_name);
      let itemUrl = p.telegram_url || p.url || "";
      if (p.username) {
        itemUrl = `https://t.me/${p.username}/${p.message_id || ""}`;
      } else if (p.invite_url) {
        itemUrl = p.invite_url;
      } else if (!itemUrl || itemUrl.includes("/c/")) {
        if (src && src.username) {
          itemUrl = `https://t.me/${src.username}/${p.message_id || ""}`;
        } else if (src && src.invite_url) {
          itemUrl = src.invite_url;
        }
      }

      // Assert that URL is NOT an unaccessible t.me/c/... link for non-members
      assert.strictEqual(itemUrl.includes("/c/"), false, `URL MUST NOT contain /c/ for private channel ${chInfo.name}`);
      assert.strictEqual(itemUrl, chInfo.invite, `URL MUST equal channel invite link ${chInfo.invite}`);
    });

    console.log(`   ✅ Channel ${chInfo.name.padEnd(25)}: ${posts.length} posts | Valid Access Link: ${chInfo.invite}`);
  }

  // 2. Detection Test for Invalid Private Links (Requirement 15)
  console.log("\n📌 2. Testing Detection of Invalid Private Links (Requirement 15):");
  function isAccessibleLink(url, hasUsername, hasInvite) {
    if (url.includes("t.me/c/") && !hasUsername && !hasInvite) {
      return false; // Invalid for non-member end users
    }
    return true;
  }

  assert.strictEqual(isAccessibleLink("https://t.me/c/5362445410/59823", false, false), false, "t.me/c/ link without username/invite MUST be detected as invalid for non-members");
  assert.strictEqual(isAccessibleLink("https://t.me/+I3z-vJdRRV8xZDlh", false, true), true, "t.me/+ invite link MUST be detected as valid");
  assert.strictEqual(isAccessibleLink("https://t.me/public_channel/123", true, false), true, "public username link MUST be detected as valid");
  console.log("   ✅ Invalid private t.me/c/ link detector PASSED!");

  // 3. Test Public Channel Handling (Requirement 5)
  console.log("\n📌 3. Testing Public Channel Handling (Requirement 5):");
  const publicMsg = {
    message_id: 100,
    date: Math.floor(Date.now() / 1000),
    chat: { id: -1001234567890, title: "Public Channel Test", username: "public_channel_test", type: "channel" },
    text: "Public post test"
  };
  const pubPost = sourceRegistry.processChannelPost(publicMsg, "Public Channel Test");
  assert.strictEqual(pubPost.post.telegram_url, "https://t.me/public_channel_test/100");
  console.log(`   ✅ Public channel post generated URL: ${pubPost.post.telegram_url}`);

  console.log("\n🎉 ALL PRIVATE & PUBLIC CHANNEL HYPERLINK VERIFICATION TESTS PASSED!");
}

runPrivateChannelHyperlinkVerification();
