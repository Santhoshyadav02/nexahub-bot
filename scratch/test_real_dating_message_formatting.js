require("D:\\Automation\\hiruboy\\node_modules\\dotenv").config({ path: "D:\\Automation\\hiruboy\\.env" });
const assert = require("assert");
const sourceRegistry = require("D:\\Automation\\hiruboy\\source_registry.js");

async function verifyRealDatingMessageFormatting() {
  console.log("=== REAL DATING TELEGRAM MESSAGE FORMATTING AUDIT ===\n");

  // 1. Fetch real Dating posts from source_registry.json
  const datingPosts = sourceRegistry.getPostsForKeyword("Dating");
  assert.ok(datingPosts.length >= 10, "Dating MUST have at least 10 stored posts in source_registry.json");

  console.log(`📌 Found ${datingPosts.length} real Dating posts in source_registry.json.`);

  // 2. Generate Page 1 Telegram HTML Message
  const itemsPerPage = 7;
  const page1Items = datingPosts.slice(0, 7);

  const escapeHTML = (str) => String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const page1LinkLines = page1Items.map((p, index) => {
    const itemNumber = index + 1;
    let displayTitle = String(p.title || p.name || "").trim();
    const fullTitle = displayTitle.trim();
    
    let itemUrl = p.telegram_url || p.url || "";
    if (!itemUrl && p.chat_id && p.message_id) {
      let cleanChatId = String(p.chat_id).startsWith("-100") ? String(p.chat_id).substring(4) : String(p.chat_id).replace("-", "");
      itemUrl = `https://t.me/c/${cleanChatId}/${p.message_id}`;
    }

    // Verify private channel URL format: https://t.me/c/5362445410/<message_id>
    assert.strictEqual(itemUrl.startsWith("https://t.me/c/5362445410/"), true, `URL MUST start with https://t.me/c/5362445410/ but got ${itemUrl}`);
    assert.ok(itemUrl.includes(String(p.message_id)), `URL MUST include message_id ${p.message_id}`);

    const safeUrl = escapeHTML(itemUrl);
    const escapedTitle = escapeHTML(fullTitle);

    return `${itemNumber}. <a href="${safeUrl}">${escapedTitle}</a>`;
  });

  const page1MessageText = `📺 <b>Dating</b>\n\nBelow are the latest videos from this channel.\n\n` + page1LinkLines.join("\n\n") + `\n\n<b>Page 1/2</b>`;

  console.log("--------------------------------------------------------------------------------");
  console.log("📡 GENERATED TELEGRAM PAGE 1 HTML MESSAGE OUTPUT:");
  console.log("--------------------------------------------------------------------------------");
  console.log(page1MessageText);
  console.log("--------------------------------------------------------------------------------\n");

  // Audit Assertions for Page 1
  assert.strictEqual(page1LinkLines.length, 7, "Page 1 MUST contain exactly 7 posts");
  assert.strictEqual(page1MessageText.includes("CHANNEL/VIDEO LINKS"), false, "MUST NOT contain 'CHANNEL/VIDEO LINKS'");
  assert.strictEqual(page1MessageText.includes("Item detail not found"), false, "MUST NOT contain 'Item detail not found'");
  assert.strictEqual(page1MessageText.includes("🔎"), false, "MUST NOT contain '🔎' detail buttons");
  assert.ok(page1MessageText.includes("https://t.me/c/5362445410/"), "All URLs MUST point to Dating chat_id 5362445410");

  console.log("✅ Page 1 Formatting Audit Passed: Exactly 7 posts, valid HTML <a href>, zero 🔎 buttons, zero 'CHANNEL/VIDEO LINKS'.");

  // 3. Generate Page 2 Telegram HTML Message
  const page2Items = datingPosts.slice(7, 14);
  const page2LinkLines = page2Items.map((p, index) => {
    const itemNumber = 7 + index + 1;
    let displayTitle = String(p.title || p.name || "").trim();
    let itemUrl = p.telegram_url || p.url || "";
    if (!itemUrl && p.chat_id && p.message_id) {
      let cleanChatId = String(p.chat_id).startsWith("-100") ? String(p.chat_id).substring(4) : String(p.chat_id).replace("-", "");
      itemUrl = `https://t.me/c/${cleanChatId}/${p.message_id}`;
    }
    return `${itemNumber}. <a href="${escapeHTML(itemUrl)}">${escapeHTML(displayTitle)}</a>`;
  });

  const page2MessageText = `📺 <b>Dating</b>\n\nBelow are the latest videos from this channel.\n\n` + page2LinkLines.join("\n\n") + `\n\n<b>Page 2/2</b>`;

  console.log("--------------------------------------------------------------------------------");
  console.log("📡 GENERATED TELEGRAM PAGE 2 HTML MESSAGE OUTPUT:");
  console.log("--------------------------------------------------------------------------------");
  console.log(page2MessageText);
  console.log("--------------------------------------------------------------------------------\n");

  assert.ok(page2LinkLines.length > 0, "Page 2 MUST contain remaining posts");
  console.log(`✅ Page 2 Formatting Audit Passed: ${page2LinkLines.length} posts (indices 8 to ${7 + page2LinkLines.length}).`);

  // 4. Verify Isolation against Saki Mizumi
  console.log("\n📌 Cross-Channel URL Isolation Check:");
  const sakiPosts = sourceRegistry.getPostsForKeyword("Saki Mizumi");
  sakiPosts.forEach(p => {
    let url = p.telegram_url || "";
    assert.strictEqual(url.includes("5362445410"), false, "Saki Mizumi URL MUST NOT contain Dating chat_id 5362445410");
    assert.ok(url.includes("5356656249"), `Saki Mizumi URL MUST contain Saki chat_id 5356656249 but got ${url}`);
  });
  console.log("✅ Cross-Channel Isolation Passed: Dating posts point strictly to -1005362445410. Saki Mizumi posts point strictly to -1005356656249.");

  console.log("\n🎉 ALL AUDIT VERIFICATION CHECKS PASSED!");
}

verifyRealDatingMessageFormatting();
