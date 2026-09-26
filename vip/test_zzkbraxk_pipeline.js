const { ZzkbraxkPipeline } = require('./vip_channel_source_pipeline');

console.log('============================================================');
console.log('🧪 Testing @zzkbraxk Channel Pipeline Logic');
console.log('============================================================\n');

const pipeline = new ZzkbraxkPipeline();

// Test 1: Spam / Ad Filter
console.log('[Test 1] Testing Spam / Promo Ad Detection...');
const adMsg = '🎉“这个中秋，别再花冤枉钱了！~！”🎉 本群高级会员优惠力度直接拉满：月付88元 年付188元 永久仅需228元！';
const normalMsg = '【T279的一些续集】 T279续集里更新了些内容，里面涉及我BBW老婆的故事部分 #T280';

const isAd1 = pipeline.isSpamOrAd(adMsg);
const isAd2 = pipeline.isSpamOrAd(normalMsg);

console.log('Ad text detected as ad:', isAd1);
console.log('Normal text detected as ad:', isAd2);

if (!isAd1 || isAd2) {
  throw new Error('❌ Ad filter test failed!');
}
console.log('✅ Spam / Ad Filter Verified');

// Test 2: Clean Title Formatting
console.log('\n[Test 2] Testing Clean Title Generation...');
const cleanT = pipeline.cleanTitle(normalMsg, 3757);
console.log('Clean Title:', cleanT);

if (!cleanT.includes('T279')) {
  throw new Error('❌ Clean title formatting failed!');
}
console.log('✅ Title Generation Verified');

console.log('\n============================================================');
console.log('🎉 ALL LOGIC TESTS PASSED!');
console.log('============================================================\n');
