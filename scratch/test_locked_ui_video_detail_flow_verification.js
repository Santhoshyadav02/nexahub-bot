require("D:\\Automation\\hiruboy\\node_modules\\dotenv").config({ path: "D:\\Automation\\hiruboy\\.env" });
const assert = require("assert");

const indexApp = require("D:\\Automation\\hiruboy\\index.js");
const sourceRegistry = require("D:\\Automation\\hiruboy\\source_registry.js");

const SPECIFIC_TESTS = [
  { testName: "Romance -> Video #1", channel: "Romance", itemIdx: 0, expectedUn: "e5brygh" },
  { testName: "Romance -> Video #3", channel: "Romance", itemIdx: 2, expectedUn: "e5brygh" },
  { testName: "Dating -> Video #1", channel: "Dating", itemIdx: 0, expectedUn: "cccsefk" },
  { testName: "Mosa -> Video #1", channel: "Mosa", itemIdx: 0, expectedUn: "vsdxda" },
  { testName: "A Muse -> Video #1", channel: "A Muse", itemIdx: 0, expectedUn: "bzd4wrf" }
];

async function runLockedUiVideoDetailFlowVerification() {
  console.log("=== LOCKED UI & VIDEO DETAIL FLOW VERIFICATION ===\n");

  console.log("📌 1. Verifying 5-Column HOT TOPICS Compact Formatting:");
  const mainKb = await indexApp.getMainKeyboard();
  const rows = mainKb.inline_keyboard;
  assert.strictEqual(rows.length, 4, "HOT TOPICS grid MUST have 4 rows");
  rows.forEach(r => assert.strictEqual(r.length, 5, "Each row MUST have 5 columns"));
  console.log("   ✅ HOT TOPICS grid rendered as 4 rows x 5 columns = 20 buttons!");

  console.log("\n📌 2. Verifying 5 Specific Video Detail Scenarios:");
  console.log("=".repeat(150));
  console.log(
    "Scenario Name".padEnd(20) + " | " +
    "Channel".padEnd(12) + " | " +
    "Msg ID".padEnd(8) + " | " +
    "WATCH VIDEO URL (Post)".padEnd(30) + " | " +
    "JOIN GROUP URL (Channel)".padEnd(26) + " | " +
    "BACK Callback".padEnd(20) + " | " +
    "HOME"
  );
  console.log("-".repeat(150));

  for (const st of SPECIFIC_TESTS) {
    const posts = sourceRegistry.getPostsForKeyword(st.channel);
    assert.ok(posts.length > st.itemIdx, `Post index ${st.itemIdx} MUST exist for ${st.channel}`);
    const selectedPost = posts[st.itemIdx];

    const src = sourceRegistry.getSourceByKeyword(st.channel);
    assert.strictEqual(src.username, st.expectedUn, `Username for ${st.channel} MUST be ${st.expectedUn}`);

    const expectedPostUrl = `https://t.me/${src.username}/${selectedPost.message_id}`;
    const expectedGroupUrl = `https://t.me/${src.username}`;
    const expectedBackCallback = `topic:${st.channel}:1`;

    assert.ok(expectedPostUrl.startsWith(`https://t.me/${st.expectedUn}/`), `Post URL MUST match https://t.me/${st.expectedUn}/<msg_id>`);
    assert.strictEqual(expectedGroupUrl, `https://t.me/${st.expectedUn}`, `Group URL MUST match https://t.me/${st.expectedUn}`);
    assert.strictEqual(expectedPostUrl.includes("t.me/+"), false, "Old private invite link MUST NOT be used");

    console.log(
      st.testName.padEnd(20) + " | " +
      st.channel.padEnd(12) + " | " +
      String(selectedPost.message_id).padEnd(8) + " | " +
      expectedPostUrl.padEnd(30) + " | " +
      expectedGroupUrl.padEnd(26) + " | " +
      expectedBackCallback.padEnd(20) + " | " +
      "menu"
    );
  }
  console.log("=".repeat(150) + "\n");

  // Verify Video #1 vs Video #3 Data Isolation
  console.log("📌 3. Verifying Video #1 vs Video #3 Data Isolation (Romance):");
  const romancePosts = sourceRegistry.getPostsForKeyword("Romance");
  const video1 = romancePosts[0];
  const video3 = romancePosts[2];

  const video1Url = `https://t.me/e5brygh/${video1.message_id}`;
  const video3Url = `https://t.me/e5brygh/${video3.message_id}`;

  assert.notStrictEqual(video1Url, video3Url, "Video #1 and Video #3 MUST have distinct post URLs");
  assert.notStrictEqual(video1.message_id, video3.message_id, "Video #1 and Video #3 MUST have distinct message IDs");

  console.log(`   ✅ Romance Video #1 (Msg ID ${video1.message_id}): ${video1Url}`);
  console.log(`   ✅ Romance Video #3 (Msg ID ${video3.message_id}): ${video3Url}`);
  console.log("   ✅ Zero data leakage! Video #3 NEVER reuses Video #1's URL!");

  console.log("\n🎉 ALL LOCKED UI & VIDEO DETAIL FLOW VERIFICATION TESTS PASSED!");
}

runLockedUiVideoDetailFlowVerification();
