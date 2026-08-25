const assert = require("assert");
const index = require("../index");
const sourceRegistry = require("../source_registry");
const MTProtoChannelReader = require("../mtproto_reader");

console.log("==================================================");
console.log("🧪 RUNNING PRODUCTION 12-CARD LIST FLOW AUDIT");
console.log("==================================================\n");

let passed = 0;
let failed = 0;

function check(condition, testName) {
  if (condition) {
    console.log(`✅ [TEST PASSED] ${testName}`);
    passed++;
  } else {
    console.error(`❌ [TEST FAILED] ${testName}`);
    failed++;
  }
}

async function runProduction12CardAudit() {
  // 1. Verify MTProto Credentials Exist
  const apiId = process.env.TELEGRAM_API_ID;
  const apiHash = process.env.TELEGRAM_API_HASH;
  const sessionStr = process.env.TELEGRAM_SESSION_STRING;

  check(Boolean(apiId && apiHash && sessionStr), "1. MTProto credentials exist (API_ID, API_HASH, SESSION_STRING present)");

  // 2. Audit All 12 Cards
  const cards = [
    { num: 1, name: "미얀마", key: "Myanmar", channel: "Romantic Vibe" },
    { num: 2, name: "헝다 가무단", key: "Evergrande Troupe", channel: "Dating" },
    { num: 3, name: "미얀마 여성", key: "Myanmar Women", channel: "Romance" },
    { num: 4, name: "뱀 누나", key: "Sister Snake", channel: "Crotch" },
    { num: 5, name: "일거리 있음", key: "Has Work", channel: "Mosa" },
    { num: 6, name: "괴롭힘과 성관계", key: "Bullying & Sex", channel: "Bunny Girl Cosplay Date" },
    { num: 7, name: "다츠거", key: "Da Ci Ge", channel: "Lustful Hostess" },
    { num: 8, name: "고3 사랑 이야기", key: "Senior Year Love Story", channel: "Concubine" },
    { num: 9, name: "쓰촨 모자", key: "Sichuan Mother & Son", channel: "Saki Mizumi" },
    { num: 10, name: "후쓰위안", key: "Hu Siyuan", channel: "A Muse" },
    { num: 11, name: "애인으로 부양", key: "Kept Lover", channel: "Romantic Vibe" },
    { num: 12, name: "디디 대리운영", key: "Didi Proxy Operation", channel: "Dating" }
  ];

  check(cards.length === 12, "2. Exactly 12 Popular Topic cards configured");

  for (const c of cards) {
    const resolvedKw = sourceRegistry.resolveKeyword(c.key);
    check(resolvedKw === c.channel, `Card ${c.num} (${c.name}): key "${c.key}" resolves to channel "${c.channel}"`);

    const posts = sourceRegistry.getPostsForKeyword(c.key, true);
    check(posts.length > 0, `Card ${c.num} (${c.name}): getPostsForKeyword returns > 0 posts (found ${posts.length})`);
    check(posts.length <= 40, `Card ${c.num} (${c.name}): posts count <= 40 (found ${posts.length})`);

    if (posts.length > 0) {
      const p1 = posts[0];
      check(Boolean(p1.id || p1.unique_hash), `Card ${c.num} (${c.name}): Position #1 post has valid stable post.id/unique_hash`);
      check(Boolean(p1.message_id), `Card ${c.num} (${c.name}): Position #1 post has valid message_id`);

      const resolvedPost = sourceRegistry.getPostById(p1.id || p1.unique_hash);
      check(resolvedPost && String(resolvedPost.message_id) === String(p1.message_id), `Card ${c.num} (${c.name}): stable ID resolves to exact source channel + message_id`);
    }
  }

  // 3. Verify Navigation Buttons & Structure
  const mainKb = await index.getMainKeyboard();
  const buttons = mainKb.inline_keyboard.flat();
  check(buttons.length === 12, "3. Main keyboard renders exactly 12 buttons in 3x4 grid");

  console.log("\n==================================================");
  console.log(`📊 PRODUCTION 12-CARD LIST FLOW RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("==================================================");

  if (failed > 0) process.exit(1);
}

runProduction12CardAudit().catch(err => {
  console.error("❌ Audit Runner Error:", err);
  process.exit(1);
});
