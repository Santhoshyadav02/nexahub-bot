const assert = require("assert");
const index = require("../index");
const sourceRegistry = require("../source_registry");

console.log("==================================================");
console.log("12 CARD COMPLETE VIDEO MAPPING AUDIT");
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
let totalDisplayedVideoItems = 0;
let totalVideoItemsActuallyVerified = 0;
let mappingPassed = 0;
let mappingFailed = 0;
let messageIdMismatches = 0;
let channelMismatches = 0;
let postIdMismatches = 0;
let crossChannelErrors = 0;
let paginationMappingErrors = 0;

const auditFailures = [];

async function audit100PercentVideos() {
  const nowSec = Math.floor(Date.now() / 1000);
  
  // Ensure each target channel has valid test posts in sourceRegistry if registry is empty
  expected12Cards.forEach(card => {
    const kw = card.expectedKeyword;
    const existingPosts = sourceRegistry.getPostsForKeyword(kw, true);
    if (existingPosts.length < 15) {
      for (let i = 1; i <= 20; i++) {
        const msgId = 5000 + i;
        sourceRegistry.processChannelPost({
          chat: { id: `-100_${kw}`, title: kw, username: kw.toLowerCase().replace(/\s+/g, "") },
          message_id: msgId,
          date: nowSec + i,
          video: { duration: 15 + i, file_id: `BAACAgUAAxkBAAI_AUDIT_FILE_ID_${kw}_${msgId}` },
          caption: `▶️ [0:${15+i}] ${card.koreanName} AUDIT VIDEO #${i}`
        }, kw);

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

    const videoPosts = sourceRegistry.getPostsForKeyword(card.topicKey, true);
    const activeVideos = videoPosts.slice(0, 40);
    const totalPages = Math.min(5, Math.ceil(activeVideos.length / 8));

    console.log(`Total Displayable Videos: ${activeVideos.length} (${totalPages} pages)`);
    totalDisplayedVideoItems += activeVideos.length;

    let cardFailCount = 0;

    // Verify 100% of displayed videos
    for (let idx = 0; idx < activeVideos.length; idx++) {
      totalVideoItemsActuallyVerified++;
      const p = activeVideos[idx];
      const pageNum = Math.floor(idx / 8) + 1;
      const listPos = idx + 1;
      const expectedMsgId = p.message_id;
      const expectedChannel = p.channel_name || resolvedKeyword;
      const expectedPostId = p.id || p.unique_hash;

      const callbackData = `det~${encodeURIComponent("topic_page:" + card.topicKey)}~${idx}~${pageNum}`;
      const deepLinkUrl = `https://t.me/santhosh_learning_2026_bot?start=video_${expectedPostId}`;

      // Simulate Telegram start handler lookup
      const postFromId = sourceRegistry.getPostById(expectedPostId);
      if (!postFromId) {
        cardFailCount++;
        mappingFailed++;
        postIdMismatches++;
        auditFailures.push({
          cardNum: card.cardNum,
          page: pageNum,
          pos: listPos,
          expectedPostId,
          expectedMsgId,
          actualMsgId: "NULL",
          cause: `getPostById("${expectedPostId}") returned undefined`,
          file: "source_registry.js",
          fn: "getPostById"
        });
        continue;
      }

      // Simulate index & page calculation in index.js
      const kwPosts = sourceRegistry.getPostsForKeyword(postFromId.keyword, true);
      const foundIdx = kwPosts.findIndex(item => item.id === postFromId.id || item.unique_hash === postFromId.unique_hash);
      const calcPage = Math.floor(foundIdx / 8) + 1;
      const resolvedPost = kwPosts[foundIdx];

      const postIdMatch = resolvedPost && (resolvedPost.id === expectedPostId || resolvedPost.unique_hash === expectedPostId);
      const msgIdMatch = resolvedPost && String(resolvedPost.message_id) === String(expectedMsgId);
      const chanMatch = resolvedPost && sourceRegistry.resolveKeyword(resolvedPost.keyword || resolvedPost.channel_name) === sourceRegistry.resolveKeyword(card.topicKey);
      const isCrossChannel = resolvedPost && sourceRegistry.resolveKeyword(resolvedPost.keyword) !== sourceRegistry.resolveKeyword(card.topicKey);
      const pageMatch = calcPage === pageNum;

      if (postIdMatch && msgIdMatch && chanMatch && !isCrossChannel && pageMatch) {
        mappingPassed++;
      } else {
        cardFailCount++;
        mappingFailed++;
        if (!postIdMatch) postIdMismatches++;
        if (!msgIdMatch) messageIdMismatches++;
        if (!chanMatch) channelMismatches++;
        if (isCrossChannel) crossChannelErrors++;
        if (!pageMatch) paginationMappingErrors++;

        auditFailures.push({
          cardNum: card.cardNum,
          page: pageNum,
          pos: listPos,
          expectedPostId,
          expectedMsgId,
          actualPostId: resolvedPost ? (resolvedPost.id || resolvedPost.unique_hash) : "NULL",
          actualMsgId: resolvedPost ? resolvedPost.message_id : "NULL",
          actualChannel: resolvedPost ? resolvedPost.keyword : "NULL",
          cause: isCrossChannel ? "Cross-Channel Leakage" : (!msgIdMatch ? "Message ID Mismatch" : (!postIdMatch ? "Post ID Mismatch" : "Pagination Mapping Error")),
          file: "index.js",
          fn: "renderItemDetailPage / start handler"
        });
      }
    }

    if (cardFailCount === 0) {
      console.log(`PASS: 100% of ${activeVideos.length} video items across all ${totalPages} pages verified cleanly.`);
    } else {
      console.log(`❌ FAIL: ${cardFailCount} mapping errors detected in Card ${card.cardNum}.`);
    }
  }

  const isComplete = totalDisplayedVideoItems === totalVideoItemsActuallyVerified && totalDisplayedVideoItems > 0;

  console.log(`\n==================================================`);
  console.log(`AUDIT SUMMARY STATISTICS`);
  console.log(`==================================================`);
  console.log(`TOTAL CARDS: ${totalCards}`);
  console.log(`TOTAL DISPLAYED VIDEO ITEMS: ${totalDisplayedVideoItems}`);
  console.log(`TOTAL VIDEO ITEMS ACTUALLY VERIFIED: ${totalVideoItemsActuallyVerified}`);
  console.log(`AUDIT STATUS: ${isComplete ? "COMPLETE" : "INCOMPLETE"}`);
  console.log(`MAPPING PASSED: ${mappingPassed}`);
  console.log(`MAPPING FAILED: ${mappingFailed}`);
  console.log(`MESSAGE ID MISMATCH: ${messageIdMismatches}`);
  console.log(`CHANNEL MISMATCH: ${channelMismatches}`);
  console.log(`POST ID MISMATCH: ${postIdMismatches}`);
  console.log(`CROSS-CHANNEL LEAKAGE: ${crossChannelErrors}`);
  console.log(`PAGINATION MAPPING ERRORS: ${paginationMappingErrors}`);

  if (auditFailures.length > 0) {
    console.log(`\n==================================================`);
    console.log(`🚨 DETAILED DISPARITY FAILURE REPORT`);
    console.log(`==================================================`);
    auditFailures.forEach(f => {
      console.log(`Card ${f.cardNum} | Pg ${f.page} Pos ${f.pos} | Expected PostID:${f.expectedPostId} MsgID:${f.expectedMsgId} | Actual PostID:${f.actualPostId} MsgID:${f.actualMsgId} (@${f.actualChannel}) | Cause: ${f.cause} | File: ${f.file} (${f.fn})`);
    });
  }

  console.log(`==================================================\n`);
}

audit100PercentVideos().catch(err => {
  console.error("❌ Audit script failed:", err);
  process.exit(1);
});
