require("D:\\Automation\\hiruboy\\node_modules\\dotenv").config({ path: "D:\\Automation\\hiruboy\\.env" });
const assert = require("assert");
const MTProtoChannelReader = require("D:\\Automation\\hiruboy\\mtproto_reader.js");

async function runHistoryFetchDiagnostic() {
  console.log("=== TELEGRAM MTPROTO HISTORY FETCH DIAGNOSTIC ===\n");

  const reader = new MTProtoChannelReader();
  console.log(`Auth Mode:              ${reader.authMode}`);
  console.log("Fetching message history for all 10 resolved private channels (Read-only mode)...");

  // Read-only history fetch (saveToDisk = false)
  const results = await reader.syncAllChannels(10, false);

  console.log("\n" + "=".repeat(120));
  console.log(
    "Channel Name".padEnd(24) + " | " +
    "Real Chat ID".padEnd(16) + " | " +
    "Access".padEnd(6) + " | " +
    "Fetch Status".padEnd(12) + " | " +
    "Msgs".padEnd(5) + " | " +
    "Vid".padEnd(4) + " | " +
    "Pic".padEnd(4) + " | " +
    "Txt".padEnd(4) + " | " +
    "Latest Msg ID".padEnd(13) + " | " +
    "Latest Media"
  );
  console.log("-".repeat(120));

  for (const r of results) {
    console.log(
      r.channel_name.padEnd(24) + " | " +
      r.chat_id.padEnd(16) + " | " +
      r.access.padEnd(6) + " | " +
      r.history_status.padEnd(12) + " | " +
      String(r.posts_found).padEnd(5) + " | " +
      String(r.num_videos).padEnd(4) + " | " +
      String(r.num_photos).padEnd(4) + " | " +
      String(r.num_text).padEnd(4) + " | " +
      String(r.latest_msg_id).padEnd(13) + " | " +
      r.media_type
    );
  }
  console.log("=".repeat(120) + "\n");

  // Print detailed reports for each channel
  console.log("📌 DETAILED PER-CHANNEL DIAGNOSTIC REPORT:\n");
  for (const r of results) {
    console.log(`--------------------------------------------------`);
    console.log(`Channel Name:          ${r.channel_name}`);
    console.log(`Real Chat ID:          ${r.chat_id}`);
    console.log(`Accessible:            ${r.access}`);
    console.log(`History Fetch Status:  ${r.history_status}`);
    console.log(`Messages Found:        ${r.posts_found} (Videos: ${r.num_videos}, Photos: ${r.num_photos}, Text: ${r.num_text})`);
    console.log(`Latest Message ID:     ${r.latest_msg_id}`);
    console.log(`Latest Message Date:   ${r.latest_date}`);
    console.log(`Latest Media Type:     ${r.media_type}`);
    console.log(`Latest Post Title/Caption:\n"${(r.latest_caption || "").trim()}"`);
    if (r.error) {
      console.log(`Error Detail:          ${r.error}`);
    }
    console.log(`--------------------------------------------------\n`);
  }

  // PASS / FAIL Summary Table
  console.log("📌 FINAL PASS/FAIL SUMMARY TABLE:");
  console.log("Channel Name".padEnd(25) + " | " + "Chat ID".padEnd(18) + " | " + "History Status".padEnd(14) + " | " + "Status");
  console.log("-".repeat(70));
  let passCount = 0;
  for (const r of results) {
    const isPass = r.access === "YES" && r.history_status === "SUCCESS" && r.posts_found > 0;
    if (isPass) passCount++;
    const statusStr = isPass ? "✅ PASS" : "❌ FAIL / JOIN NEEDED";
    console.log(
      r.channel_name.padEnd(25) + " | " +
      r.chat_id.padEnd(18) + " | " +
      r.history_status.padEnd(14) + " | " +
      statusStr
    );
  }
  console.log("-".repeat(70));
  console.log(`Total: ${passCount} / ${results.length} channels PASSED history fetch!\n`);
}

runHistoryFetchDiagnostic();
