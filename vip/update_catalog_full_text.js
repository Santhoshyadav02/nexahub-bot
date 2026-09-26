const fs = require('fs');
const path = require('path');

const catalogPath = path.resolve(__dirname, 'channel_catalogs.json');
const catalogs = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

const fullTitles = {
  41: '【T279的一些续集】 T279续集里更新了些内容，里面涉及我BBW老婆的故事部分，描述得还挺详细的，建议去瞅瞅。',
  40: '【T279的一些续集】 T279续集里更新了些内容，里面涉及我BBW老婆的故事部分，描述得还挺详细的，建议去瞅瞅。',
  39: '【T279的一些续集】 T279续集里更新了些内容，里面涉及我BBW老婆的故事部分，描述得还挺详细的，建议去瞅瞅。',
  38: '【T279的一些续集】 T279续集里更新了些内容，里面涉及我BBW老婆的故事部分，描述得还挺详细的，建议去瞅瞅。',
  37: '【T279的一些续集】 T279续集里更新了些内容，里面涉及我BBW老婆的故事部分，描述得还挺详细的，建议去瞅瞅。',
  36: '【巨乳骚萌女大】 这妹子穿百褶短裙，蕾丝内裤勒着肥逼，跳蛋塞穴震动。对镜自慰动作越来越骚。巨乳晃荡又软沉，配肥臀肉感足。揉胸低喘腿软，最后高潮喷水近景清楚。',
  35: '【巨乳骚萌女大】 这妹子穿百褶短裙，蕾丝内裤勒着肥逼，跳蛋塞穴震动。对镜自慰动作越来越骚。巨乳晃荡又软沉，配肥臀肉感足。揉胸低喘腿软，最后高潮喷水近景清楚。',
  34: '【巨乳骚萌女大】 这妹子穿百褶短裙，蕾丝内裤勒着肥逼，跳蛋塞穴震动。对镜自慰动作越来越骚。巨乳晃荡又软沉，配肥臀肉感足。揉胸低喘腿软，最后高潮喷水近景清楚。',
  33: '【巨乳骚萌女大】 这妹子穿百褶短裙，蕾丝内裤勒着肥逼，跳蛋塞穴震动。对镜自慰动作越来越骚。巨乳晃荡又软沉，配肥臀肉感足。揉胸低喘腿软，最后高潮喷水近景清楚。',
  28: '【T279的一些续集】 T279续集里更新了些内容，里面涉及我BBW老婆的故事部分，描述得还挺详细的，建议去瞅瞅。'
};

if (catalogs['18']) {
  for (const item of catalogs['18']) {
    if (fullTitles[item.messageId]) {
      item.title = fullTitles[item.messageId];
    }
  }
}

fs.writeFileSync(catalogPath, JSON.stringify(catalogs, null, 2), 'utf8');
console.log('✅ Updated channel_catalogs.json with full multi-line text for VIP-18');
