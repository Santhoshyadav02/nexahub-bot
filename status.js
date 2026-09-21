/**
 * ============================================================
 * 📊 NEXAHUB BOT STATUS & CHANNEL PUBLISHING MONITOR
 * ============================================================
 * Run: node status.js
 */

const fs = require('fs');
const path = require('path');
const { dataPath } = require('./runtime_paths');

function loadJson(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (_) {}
  return null;
}

console.log('\n' + '='.repeat(70));
console.log('🤖 NEXAHUB MULTI-BOT & CHANNEL PUBLISHING STATUS REPORT');
console.log('='.repeat(70));
console.log(`🕒 Timestamp: ${new Date().toISOString()}`);

// ------------------------------------------------------------
// 1. BOT 1 STATUS (10 CHANNELS)
// ------------------------------------------------------------
console.log('\n' + '-'.repeat(70));
console.log('📌 BOT 1: UNIFIED 10-CHANNEL PIPELINE (@santhosh_learning_2026_bot)');
console.log('-'.repeat(70));

const bot1Config = loadJson(path.join(__dirname, 'video_pipeline', 'modular_channel_config.json')) || { channels: {} };
const bot1StatePaths = [
  dataPath('video_pipeline', 'state', 'modular_quota_state.json'),
  '/var/lib/nexahub/video_pipeline/state/modular_quota_state.json',
  path.join(__dirname, 'data', 'video_pipeline', 'state', 'modular_quota_state.json')
];

let bot1State = null;
for (const p of bot1StatePaths) {
  bot1State = loadJson(p);
  if (bot1State) break;
}

if (bot1State && bot1State.channels) {
  console.log(`📅 Quota Date: ${bot1State.currentDate || 'Today'}`);
  console.log('┌────────────┬─────────────────────────────┬───────────┬───────────┬─────────┐');
  console.log('│ Channel    │ Target Name                 │ Published │ Remaining │ Quota   │');
  console.log('├────────────┼─────────────────────────────┼───────────┼───────────┼─────────┤');

  let totalPublished = 0;
  for (const [key, conf] of Object.entries(bot1Config.channels || {})) {
    const chData = bot1State.channels[key] || { publishedToday: 0, maxQuota: 5 };
    const published = chData.publishedToday || 0;
    const maxQuota = conf.dailyQuota || chData.maxQuota || 5;
    const remaining = Math.max(0, maxQuota - published);
    totalPublished += published;

    const keyCol = key.padEnd(10).slice(0, 10);
    const nameCol = (conf.name || '').padEnd(27).slice(0, 27);
    const pubCol = `${published}`.padStart(9);
    const remCol = `${remaining}`.padStart(9);
    const quotaCol = `${maxQuota}`.padStart(7);

    console.log(`│ ${keyCol} │ ${nameCol} │ ${pubCol} │ ${remCol} │ ${quotaCol} │`);
  }
  console.log('└────────────┴─────────────────────────────┴───────────┴───────────┴─────────┘');
  console.log(`🎯 Total Bot 1 Videos Published Today: ${totalPublished} / 50`);
} else {
  console.log('ℹ️ No active publication state recorded yet for today (Bot 1 is initializing).');
}

// ------------------------------------------------------------
// 2. BOT 2 STATUS (6 VIP CHANNELS)
// ------------------------------------------------------------
console.log('\n' + '-'.repeat(70));
console.log('📌 BOT 2: VIP 6-CHANNEL PIPELINE (@INFINITY_121_bot)');
console.log('-'.repeat(70));

const bot2Config = loadJson(path.join(__dirname, 'bot2_pipeline', 'bot2_channel_config.json')) || { channels: {} };
const bot2StatePaths = [
  dataPath('bot2_pipeline', 'state', 'bot2_quota_state.json'),
  '/var/lib/nexahub/bot2_pipeline/state/bot2_quota_state.json',
  path.join(__dirname, 'data', 'bot2_pipeline', 'state', 'bot2_quota_state.json')
];

let bot2State = null;
for (const p of bot2StatePaths) {
  bot2State = loadJson(p);
  if (bot2State) break;
}

if (bot2State && bot2State.channels) {
  console.log(`📅 Quota Date: ${bot2State.currentDate || 'Today'}`);
  console.log('┌────────────┬─────────────────────────────┬───────────┬───────────┬─────────┐');
  console.log('│ Channel    │ Target VIP Group            │ Published │ Remaining │ Quota   │');
  console.log('├────────────┼─────────────────────────────┼───────────┼───────────┼─────────┤');

  let totalBot2 = 0;
  for (const [key, conf] of Object.entries(bot2Config.channels || {})) {
    const chData = bot2State.channels[key] || { publishedToday: 0 };
    const published = chData.publishedToday || 0;
    const maxQuota = conf.dailyQuota || 5;
    const remaining = Math.max(0, maxQuota - published);
    totalBot2 += published;

    const keyCol = key.padEnd(10).slice(0, 10);
    const nameCol = (conf.name || '').padEnd(27).slice(0, 27);
    const pubCol = `${published}`.padStart(9);
    const remCol = `${remaining}`.padStart(9);
    const quotaCol = `${maxQuota}`.padStart(7);

    console.log(`│ ${keyCol} │ ${nameCol} │ ${pubCol} │ ${remCol} │ ${quotaCol} │`);
  }
  console.log('└────────────┴─────────────────────────────┴───────────┴───────────┴─────────┘');
  console.log(`🎯 Total Bot 2 Videos Published Today: ${totalBot2} / 30`);
} else {
  console.log('ℹ️ No active publication state recorded yet for Bot 2 (Not yet started or fresh initialization).');
}

console.log('\n' + '='.repeat(70) + '\n');
