const assert = require('assert');
const path = require('path');
const { VipForwarder } = require('./vip_forwarder');

console.log('============================================================');
console.log('🔍 Testing VIP Channel Forwarder & Topic Hub');
console.log('============================================================');

const forwarder = new VipForwarder(path.resolve(__dirname, 'config.json'));

// Test 1: Configuration integrity
console.log('\n[Test 1] Verifying 6 VIP Channels Configuration...');
const channelKeys = Object.keys(forwarder.config.channels);
assert.strictEqual(channelKeys.length, 6, 'Should track exactly 6 VIP channels');
console.log('  ✅ Exactly 6 VIP channels configured:');
channelKeys.forEach(chId => {
  const ch = forwarder.config.channels[chId];
  console.log(`     • ${ch.name} (${ch.tag}) [ID: ${chId}] ➔ ${ch.emoji}`);
});

// Test 2: Channel Post Link Generation
console.log('\n[Test 2] Verifying Channel Post Link Generation...');
const linkKR = forwarder.getChannelPostLink('-1004435999618', 1234);
assert.strictEqual(linkKR, 'https://t.me/c/4435999618/1234', 'Should correctly format private channel link without -100 prefix');
console.log(`  ✅ Generated Post Link: ${linkKR}`);

// Test 3: Title Extraction
console.log('\n[Test 3] Verifying Title Extraction...');
const sampleMsg = {
  chat: { id: -1004435999618 },
  message_id: 55,
  caption: 'FC2PPV-4925245UL\n추천 영상입니다.'
};
const title = forwarder.extractTitle(sampleMsg);
assert.strictEqual(title, 'FC2PPV-4925245UL', 'Should extract first line as title');
console.log(`  ✅ Extracted Title: "${title}"`);

// Test 4: Rich Card Formatting for Category & All Topics
console.log('\n[Test 4] Verifying Rich Card Formatting...');
const krConfig = forwarder.config.channels['-1004435999618'];
const allCard = forwarder.formatAllCard(krConfig, title);
const catCard = forwarder.formatCategoryCard(krConfig, title);

assert(allCard.includes('[ALL / 전체] 신규 업데이트 (KR)'), 'All card should contain ALL header');
assert(allCard.includes('FC2PPV-4925245UL'), 'All card should contain title');
assert(catCard.includes('[KR / 전용] 신규 업데이트'), 'Category card should contain KR header');
console.log('  ✅ All Card Preview:\n' + allCard.split('\n').map(l => '     ' + l).join('\n'));
console.log('\n  ✅ Category Card Preview:\n' + catCard.split('\n').map(l => '     ' + l).join('\n'));

// Test 5: Keyboard Dual Links
console.log('\n[Test 5] Verifying Dual Jump Links in Keyboard...');
const keyboard = forwarder.buildKeyboard(krConfig, linkKR);
assert.strictEqual(keyboard.inline_keyboard[0][0].text, '🌐 All ↗️');
assert.strictEqual(keyboard.inline_keyboard[0][1].url, 'https://t.me/c/4435999618/1234');
console.log('  ✅ Button 1: ' + keyboard.inline_keyboard[0][0].text + ' -> ' + keyboard.inline_keyboard[0][0].url);
console.log('  ✅ Button 2: ' + keyboard.inline_keyboard[0][1].text + ' -> ' + keyboard.inline_keyboard[0][1].url);

// Test 6: Mock Processing & Duplicate Guard
console.log('\n[Test 6] Verifying Simulated Channel Post Event & Deduplication...');
let sentMessages = [];
forwarder.bot = {
  sendMessage: async (chatId, text, opts) => {
    sentMessages.push({ chatId, text, opts });
    return { message_id: 999 };
  }
};

// Set mock topic thread IDs for testing
krConfig.topicThreadId = 1001;

forwarder.handleChannelPost(sampleMsg).then(result => {
  assert.strictEqual(result, true, 'First handle should succeed');
  assert.strictEqual(sentMessages.length, 2, 'Should send to both Category topic and General/ALL topic');
  console.log(`  ✅ Sent 2 messages (1 to Topic ${sentMessages[0].opts.message_thread_id}, 1 to All ${sentMessages[1].opts.message_thread_id})`);

  // Repeat same message to test deduplication
  forwarder.handleChannelPost(sampleMsg).then(dupeResult => {
    assert.strictEqual(dupeResult, false, 'Duplicate message should be rejected');
    assert.strictEqual(sentMessages.length, 2, 'No new messages sent for duplicate');
    console.log('  ✅ Deduplication successfully blocked duplicate post');

    console.log('\n============================================================');
    console.log('🎉 ALL 6 TESTS PASSED! VIP FORWARDER IS READY');
    console.log('============================================================\n');
  });
});
