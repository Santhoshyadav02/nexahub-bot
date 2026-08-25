require("D:\\Automation\\hiruboy\\node_modules\\dotenv").config({ path: "D:\\Automation\\hiruboy\\.env" });
const assert = require("assert");

const sourceRegistry = require("D:\\Automation\\hiruboy\\source_registry.js");

const TARGET_CHANNELS = [
  { name: "Romantic Vibe", chat_id: "-1005563024409" },
  { name: "Dating", chat_id: "-1005362445410" },
  { name: "Romance", chat_id: "-1005491187683" },
  { name: "Crotch", chat_id: "-1005296875877" },
  { name: "Mosa", chat_id: "-1005427855016" },
  { name: "Bunny Girl Cosplay Date", chat_id: "-1005353472623" },
  { name: "Lustful Hostess", chat_id: "-1005591987853" },
  { name: "Concubine", chat_id: "-1005394162064" },
  { name: "Saki Mizumi", chat_id: "-1005356656249" },
  { name: "A Muse", chat_id: "-1005476708057" }
];

async function runExactChannelUrlVerification() {
  console.log("=== EXACT SOURCE CHANNEL URL & ISOLATION VERIFICATION ===\n");

  const reportRows = [];

  for (const chInfo of TARGET_CHANNELS) {
    const posts = sourceRegistry.getPostsForKeyword(chInfo.name);
    assert.ok(posts.length > 0, `Posts MUST exist for channel ${chInfo.name}`);

    const topPost = posts[0];
    const src = sourceRegistry.getSourceByKeyword(chInfo.name);
    assert.ok(src, `Source metadata MUST exist for ${chInfo.name}`);

    // Verify chat_id & message_id preservation
    assert.strictEqual(String(topPost.chat_id), chInfo.chat_id, `Chat ID MUST match ${chInfo.chat_id}`);
    assert.ok(topPost.message_id > 0, `Message ID MUST be a positive integer`);

    // Determine URL
    let generatedUrl = topPost.telegram_url || "";
    let isPublic = false;

    if (topPost.username || (src && src.username)) {
      isPublic = true;
      const un = topPost.username || src.username;
      generatedUrl = `https://t.me/${un}/${topPost.message_id}`;
    } else if (topPost.invite_url || (src && src.invite_url)) {
      generatedUrl = topPost.invite_url || src.invite_url;
    }

    // Verify cross-channel isolation: Dating MUST NOT receive Romance's URL
    const otherSources = TARGET_CHANNELS.filter(c => c.name !== chInfo.name);
    otherSources.forEach(other => {
      const otherSrc = sourceRegistry.getSourceByKeyword(other.name);
      if (otherSrc && otherSrc.invite_url) {
        assert.notStrictEqual(generatedUrl, otherSrc.invite_url, `Channel ${chInfo.name} MUST NOT receive invite URL of ${other.name}`);
      }
    });

    reportRows.push({
      channel_name: chInfo.name,
      chat_id: chInfo.chat_id,
      message_id: topPost.message_id,
      url: generatedUrl,
      type: isPublic ? "Public Username" : "Private Invite",
      exact_post_nav: isPublic ? "YES (Direct Message)" : "NO (Channel Invite Access)"
    });
  }

  console.log("=".repeat(120));
  console.log(
    "Channel Name".padEnd(25) + " | " +
    "Chat ID".padEnd(16) + " | " +
    "Message ID".padEnd(12) + " | " +
    "Type".padEnd(18) + " | " +
    "Exact Post Direct Nav?".padEnd(28) + " | " +
    "Redacted URL"
  );
  console.log("-".repeat(120));

  reportRows.forEach(r => {
    // Redact invite token hash in output report
    let redactedUrl = r.url;
    if (redactedUrl.includes("t.me/+")) {
      const parts = redactedUrl.split("t.me/+");
      redactedUrl = `https://t.me/+${parts[1].substring(0, 6)}...`;
    }
    console.log(
      r.channel_name.padEnd(25) + " | " +
      r.chat_id.padEnd(16) + " | " +
      String(r.message_id).padEnd(12) + " | " +
      r.type.padEnd(18) + " | " +
      r.exact_post_nav.padEnd(28) + " | " +
      redactedUrl
    );
  });
  console.log("=".repeat(120) + "\n");

  console.log("✅ Cross-channel URL isolation verified across all 10 channels!");
  console.log("✅ Chat ID and Message ID preservation verified!");
}

runExactChannelUrlVerification();
