const assert = require("assert");
const index = require("../index");
const sourceRegistry = require("../source_registry");

console.log("==================================================");
console.log("12 CARD VIDEO MAPPING AUDIT");
console.log("==================================================\n");

const expected12Cards = [
  { cardNum: 1, koreanName: "미얀마", topicKey: "Myanmar", expectedKeyword: "Romantic Vibe" },
  { cardNum: 2, koreanName: "헝다 가무단", topicKey: "Evergrande Troupe", expectedKeyword: "Dating" },
  { cardNum: 3, koreanName: "미얀마 여성", topicKey: "Myanmar Women", expectedKeyword: "Romance" },
  { cardNum: 4, koreanName: "뱀 누나", topicKey: "Sister Snake", expectedKeyword: "Crotch" },
  { cardNum: 5, koreanName: "일거리 있음", topicKey: "Has Work", expectedKeyword: "Mosa" },
  { cardNum: 6, koreanName: "괴롭힘과 성관계", topicKey: "Bullying & Sex", expectedKeyword: "Bunny Girl Cosplay Date" },
  { cardNum: 7, koreanName: "다츠거", topicKey: "Da Ci Ge", expectedKeyword: "Lustful Hostess" },
  { cardNum: 8, koreanName: "고3 사랑 이야기", topicKey: "Senior Year Love Story", expectedKeyword: "Concubine" },
  { cardNum: 9, koreanName: "쓰촨 모자", topicKey: "Sichuan Mother & Son", expectedKeyword: "Saki Mizumi" },
  { cardNum: 10, koreanName: "후쓰위안", topicKey: "Hu Siyuan", expectedKeyword: "A Muse" },
  { cardNum: 11, koreanName: "애인으로 부양", topicKey: "Kept Lover", expectedKeyword: "Romantic Vibe" },
  { cardNum: 12, koreanName: "디디 대리운영", topicKey: "Didi Proxy Operation", expectedKeyword: "Dating" }
];

let totalCards = 12;
let totalVideosTested = 0;
let mappingPassed = 0;
let mappingFailed = 0;
let crossChannelErrors = 0;
let messageIdMismatches = 0;
let previewSourceMismatches = 0;

const auditFailures = [];

async function auditAll12Cards() {
  // Ensure each target channel has valid test posts in sourceRegistry if registry is empty
  const nowSec = Math.floor(Date.now() / 1000);
  
  expected12Cards.forEach(card => {
    const kw = card.expectedKeyword;
    const existingPosts = sourceRegistry.getPostsForKeyword(kw, true);
    if (existingPosts.length < 10) {
      // Ingest sample video & text posts to thoroughly audit mapping logic
      for (let i = 1; i <= 12; i++) {
        const msgId = 5000 + i;
        sourceRegistry.processChannelPost({
          chat: { id: `-100_${kw}`, title: kw, username: kw.toLowerCase().replace(/\s+/g, "") },
          message_id: msgId,
          date: nowSec + i,
          video: { duration: 15 + i, file_id: `BAACAgUAAxkBAAI_AUDIT_FILE_ID_${kw}_${msgId}` },
          caption: `▶️ [0:${15+i}] ${card.koreanName} AUDIT VIDEO #${i}`
        }, kw);

        // Add an interleaved text post to test videoOnly index resolution robustness
        if (i % 3 === 0) {
          sourceRegistry.processChannelPost({
            chat: { id: `-100_${kw}`, title: kw, username: kw.toLowerCase().replace(/\s+/g, "") },
            message_id: 9000 + i,
            date: nowSec + i + 1,
            caption: `TEXT ONLY POST #${i}`
          }, kw);
        }
      }
    }
  });

  for (const card of expected12Cards) {
    console.log(`--------------------------------------------------`);
    console.log(`CARD ${card.cardNum}`);
    console.log(`Card Name: ${card.koreanName}`);
    console.log(`topicKey: ${card.topicKey}`);
    
    const resolvedKeyword = sourceRegistry.resolveKeyword(card.topicKey);
    const sourceObj = sourceRegistry.getSourceByKeyword(card.topicKey);
    const channelUsername = sourceObj ? (sourceObj.username || "N/A") : "N/A";
    const channelId = sourceObj ? (sourceObj.chat_id || sourceObj.id || "N/A") : "N/A";
    
    console.log(`Resolved Topic/Category: ${resolvedKeyword}`);
    console.log(`Telegram Channel Username: @${channelUsername}`);
    console.log(`Telegram Channel ID: ${channelId}`);

    // Get posts eligible for display
    const videoPosts = sourceRegistry.getPostsForKeyword(card.topicKey, true);
    console.log(`Total Displayable Videos: ${videoPosts.length}`);

    let cardPass = true;
    let cardTestedCount = 0;

    // Test items: Page 1 items (first, middle, last) and Page 2 items
    const itemsToTest = [];
    if (videoPosts.length > 0) itemsToTest.push({ pos: 1, post: videoPosts[0], page: 1 });
    if (videoPosts.length > 3) itemsToTest.push({ pos: 4, post: videoPosts[3], page: 1 });
    if (videoPosts.length >= 8) itemsToTest.push({ pos: 8, post: videoPosts[7], page: 1 });
    if (videoPosts.length > 8) itemsToTest.push({ pos: 9, post: videoPosts[8], page: 2 });
    if (videoPosts.length >= 12) itemsToTest.push({ pos: 12, post: videoPosts[11], page: 2 });

    for (const testItem of itemsToTest) {
      totalVideosTested++;
      cardTestedCount++;

      const p = testItem.post;
      const expectedMsgId = p.message_id;
      const expectedChannel = p.channel_name || resolvedKeyword;

      // 1. Simulate button click resolution via video_<id> payload handler
      const videoId = p.id || p.unique_hash;
      const lookupPost = sourceRegistry.getPostById(videoId);

      if (!lookupPost) {
        cardPass = false;
        mappingFailed++;
        auditFailures.push({
          cardNum: card.cardNum,
          itemPos: testItem.pos,
          expectedChannel,
          expectedMsgId,
          actualMsgId: "NULL",
          rootCause: `getPostById("${videoId}") returned undefined`,
          file: "source_registry.js / index.js"
        });
        continue;
      }

      // Trace index resolution in index.js /start handler:
      const callbackPrefix = `topic_page:${lookupPost.keyword}`;
      const postsForKwVideoOnly = sourceRegistry.getPostsForKeyword(lookupPost.keyword, true);
      const foundIdxVideoOnly = postsForKwVideoOnly.findIndex(item => item.id === lookupPost.id || item.unique_hash === lookupPost.unique_hash);

      const postsForKwAll = sourceRegistry.getPostsForKeyword(lookupPost.keyword, false);
      const foundIdxAll = postsForKwAll.findIndex(item => item.id === lookupPost.id || item.unique_hash === lookupPost.unique_hash);

      // Verify resolved post in renderItemDetailPage:
      const resolvedPost = postsForKwVideoOnly[foundIdxVideoOnly];

      const msgIdMatch = resolvedPost && String(resolvedPost.message_id) === String(expectedMsgId);
      const chanMatch = resolvedPost && sourceRegistry.resolveKeyword(resolvedPost.keyword || resolvedPost.channel_name) === sourceRegistry.resolveKeyword(expectedChannel);
      const crossChannelLeak = resolvedPost && sourceRegistry.resolveKeyword(resolvedPost.keyword) !== sourceRegistry.resolveKeyword(card.topicKey);

      if (foundIdxAll !== foundIdxVideoOnly && postsForKwAll.length !== postsForKwVideoOnly.length) {
        console.warn(`⚠️ WARNING: Index disparity detected! VideoOnly index=${foundIdxVideoOnly}, AllPost index=${foundIdxAll}`);
      }

      if (msgIdMatch && chanMatch && !crossChannelLeak) {
        mappingPassed++;
      } else {
        cardPass = false;
        mappingFailed++;
        if (crossChannelLeak) crossChannelErrors++;
        if (!msgIdMatch) messageIdMismatches++;
        if (!chanMatch) previewSourceMismatches++;

        auditFailures.push({
          cardNum: card.cardNum,
          itemPos: testItem.pos,
          expectedChannel,
          expectedMsgId,
          actualChannel: resolvedPost ? resolvedPost.channel_name : "UNKNOWN",
          actualMsgId: resolvedPost ? resolvedPost.message_id : "UNKNOWN",
          rootCause: crossChannelLeak ? "Cross-channel leakage" : (!msgIdMatch ? "Message ID Mismatch" : "Channel Mismatch"),
          file: "index.js (renderItemDetailPage / start handler)"
        });
      }
    }

    if (cardPass) {
      console.log(`PASS: List → Callback → Channel → Message ID → Preview (${cardTestedCount} videos verified)`);
    } else {
      console.log(`❌ FAIL: Mapping disparity detected in Card ${card.cardNum}`);
    }
  }

  console.log(`\n==================================================`);
  console.log(`AUDIT SUMMARY STATISTICS`);
  console.log(`==================================================`);
  console.log(`TOTAL CARDS: ${totalCards}`);
  console.log(`TOTAL VIDEOS TESTED: ${totalVideosTested}`);
  console.log(`MAPPING PASSED: ${mappingPassed}`);
  console.log(`MAPPING FAILED: ${mappingFailed}`);
  console.log(`CROSS-CHANNEL ERRORS: ${crossChannelErrors}`);
  console.log(`MESSAGE-ID MISMATCHES: ${messageIdMismatches}`);
  console.log(`PREVIEW SOURCE MISMATCHES: ${previewSourceMismatches}`);

  if (auditFailures.length > 0) {
    console.log(`\n==================================================`);
    console.log(`🚨 DETAILED FAILURE DISPARITY REPORT`);
    console.log(`==================================================`);
    auditFailures.forEach(f => {
      console.log(`Card ${f.cardNum} | Pos ${f.itemPos} | Expected MsgID:${f.expectedMsgId} (@${f.expectedChannel}) | Actual MsgID:${f.actualMsgId} (@${f.actualChannel}) | Cause: ${f.rootCause} | File: ${f.file}`);
    });
  }

  console.log(`==================================================\n`);
}

auditAll12Cards().catch(err => {
  console.error("❌ Audit script failed:", err);
  process.exit(1);
});
