/**
 * Test Suite: Bot 1 Video-Tools Engine Integration & Isolation Verification
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');

console.log('\n' + '='.repeat(60));
console.log('🔍 Test 1: Bot 1 Scraper Script Structure & Syntax');
console.log('='.repeat(60));

const scraperPath = path.resolve(__dirname, '..', 'scraping', 'bj_scraper.py');
assert(fs.existsSync(scraperPath), 'bj_scraper.py must exist');

const scraperCode = fs.readFileSync(scraperPath, 'utf8');
assert(scraperCode.includes('BeautifulSoup'), 'Must include BeautifulSoup parsing');
assert(scraperCode.includes('extract_video_from_html'), 'Must define extract_video_from_html');
assert(scraperCode.includes('bcdn_token'), 'Must include bcdn_token regex extraction');
assert(scraperCode.includes('requests.Session'), 'Must include requests Session');
console.log('  ✅ scraping/bj_scraper.py includes all BeautifulSoup & regex video extraction features');

console.log('\n' + '='.repeat(60));
console.log('🔍 Test 2: Bot 1 Downloader Container Integrity Guard');
console.log('='.repeat(60));

const downloaderPath = path.resolve(__dirname, 'modular_downloader.py');
assert(fs.existsSync(downloaderPath), 'modular_downloader.py must exist');

const downloaderCode = fs.readFileSync(downloaderPath, 'utf8');
assert(downloaderCode.includes('ftyp') || downloaderCode.includes('moov'), 'Must include container header verification');
console.log('  ✅ modular_downloader.py has ftyp container protection against HTML pages');

console.log('\n' + '='.repeat(60));
console.log('🔍 Test 3: Bot 1 Channel Configuration Compatibility');
console.log('='.repeat(60));

const configPath = path.resolve(__dirname, 'modular_channel_config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const channelKeys = Object.keys(config.channels);
assert.strictEqual(channelKeys.length, 10, 'Must contain exactly 10 channels for Bot 1');

for (const key of channelKeys) {
  const ch = config.channels[key];
  assert(ch.scraperScript, `Channel ${key} must have scraperScript`);
  assert(fs.existsSync(path.resolve(__dirname, '..', ch.scraperScript)), `Scraper script for ${key} must exist`);
}
console.log('  ✅ All 10 Bot 1 channels properly wired to upgraded scraper script');

console.log('\n' + '='.repeat(60));
console.log('🔍 Test 4: Bot 2 Isolation Guard');
console.log('='.repeat(60));

const bot2ConfigPath = path.resolve(__dirname, '..', 'bot2_pipeline', 'bot2_channel_config.json');
const bot2Config = JSON.parse(fs.readFileSync(bot2ConfigPath, 'utf8'));
const bot2Keys = Object.keys(bot2Config.channels);
assert.strictEqual(bot2Keys.length, 6, 'Bot 2 must remain strictly 6 VIP channels');
console.log('  ✅ Bot 2 remains completely isolated with 6 VIP channels');

console.log('\n' + '='.repeat(60));
console.log('RESULT: All Bot 1 Video-Tools Integration Tests Passed! 🚀');
console.log('='.repeat(60) + '\n');
