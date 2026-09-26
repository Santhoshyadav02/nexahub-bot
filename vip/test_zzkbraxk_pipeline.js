const assert = require('assert');
const { cleanVideoTitle, formatCleanCaption, ZzkbraxkPipeline } = require('./vip_channel_source_pipeline');

console.log('🧪 Testing Zzkbraxk Pipeline Components...');

// 1. Test cleanVideoTitle
const testCases = [
  {
    input: '🔥 Super Hot Video Title\nhttps://t.me/some_channel Join here!\n#tag1 #tag2',
    expected: '🔥 Super Hot Video Title'
  },
  {
    input: 'https://t.me/spam\n@somebot\nJust Title Here',
    expected: 'Just Title Here'
  },
  {
    input: '   - Best Video Compilation 2026 -   \nMore details in comments',
    expected: 'Best Video Compilation 2026'
  },
  {
    input: '',
    expected: 'VIP-🔞 신규 영상'
  }
];

for (const tc of testCases) {
  const res = cleanVideoTitle(tc.input);
  console.log(`Input: "${tc.input.replace(/\n/g, ' ')}" -> Output: "${res}"`);
  assert.strictEqual(res, tc.expected, `Expected ${tc.expected}, got ${res}`);
}

// 2. Test formatCleanCaption
const caption = formatCleanCaption('Sexy Korean Model <Dance>');
assert.ok(caption.includes('Sexy Korean Model &lt;Dance&gt;'));
assert.ok(caption.includes('VIP-🔞 정보공유'));

// 3. Test isVideoMessage
const pipeline = new ZzkbraxkPipeline();

const videoMsg = {
  id: 101,
  media: {
    className: 'MessageMediaDocument',
    document: {
      mimeType: 'video/mp4',
      attributes: [{ className: 'DocumentAttributeVideo' }]
    }
  },
  message: 'Title of Video'
};

const photoMsg = {
  id: 102,
  media: {
    className: 'MessageMediaPhoto'
  },
  message: 'Photo ad'
};

const textMsg = {
  id: 103,
  message: 'Text only message'
};

assert.strictEqual(pipeline.isVideoMessage(videoMsg), true);
assert.strictEqual(pipeline.isVideoMessage(photoMsg), false);
assert.strictEqual(pipeline.isVideoMessage(textMsg), false);

console.log('✅ All Zzkbraxk Pipeline unit tests passed successfully!');
