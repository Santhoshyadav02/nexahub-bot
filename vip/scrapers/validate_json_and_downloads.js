/**
 * ============================================================
 * 🔍 VIP SCRAPERS & DOWNLOADS VALIDATION SUITE
 * ============================================================
 * Inspects all 6 JSON output files and verified downloaded files
 * in vip/scrapers without accessing or querying external websites.
 */

const fs = require('fs');
const path = require('path');

const SCRAPERS_DIR = path.resolve(__dirname);

const CHANNELS = [
  { key: 'bj', name: 'VIP-BJ', jsonFile: 'bj_videos.json', downloadDir: 'downloads/bj' },
  { key: 'jp', name: 'VIP-JP', jsonFile: 'jp_videos.json', downloadDir: 'downloads/jp' },
  { key: 'kr', name: 'VIP-KR', jsonFile: 'kr_videos.json', downloadDir: 'downloads/kr' },
  { key: 'xchina', name: 'VIP-CN', jsonFile: 'xchina_videos.json', downloadDir: 'downloads/xchina' },
  { key: 'av', name: 'VIP-AV', jsonFile: 'av_videos.json', downloadDir: 'downloads/av' },
  { key: 'krx', name: 'VIP-18', jsonFile: 'krx_videos.json', downloadDir: 'downloads/18+' }
];

console.log('============================================================');
console.log('🔍 Validating 6 Scraper JSON Outputs & Downloaded Videos');
console.log('============================================================\n');

const results = [];

for (const ch of CHANNELS) {
  const jsonPath = path.join(SCRAPERS_DIR, ch.jsonFile);
  const downloadPath = path.join(SCRAPERS_DIR, ch.downloadDir);

  let jsonExists = fs.existsSync(jsonPath);
  let jsonCount = 0;
  let sampleItem = null;
  let validUrlsCount = 0;

  if (jsonExists) {
    try {
      const raw = fs.readFileSync(jsonPath, 'utf8');
      const data = JSON.parse(raw);
      jsonCount = Array.isArray(data) ? data.length : 0;
      if (jsonCount > 0) {
        sampleItem = data[0];
        validUrlsCount = data.filter(d => Boolean(d.mp4_download_url || d.video_url || d.download_url)).length;
      }
    } catch (e) {
      console.error(`❌ Error parsing ${ch.jsonFile}:`, e.message);
    }
  }

  // Check downloaded video files
  let downloadedFiles = [];
  if (fs.existsSync(downloadPath)) {
    downloadedFiles = fs.readdirSync(downloadPath).filter(f => f.endsWith('.mp4') || f.endsWith('.ts'));
  }

  console.log(`📦 [${ch.name}] (${ch.key.toUpperCase()}):`);
  console.log(`   • JSON File: ${ch.jsonFile} (${jsonExists ? 'EXISTS ✅' : 'MISSING ❌'})`);
  console.log(`   • Total Scraped Items: ${jsonCount} videos`);
  console.log(`   • Items with Direct Download URLs: ${validUrlsCount}/${jsonCount}`);
  if (sampleItem) {
    const title = sampleItem.title || 'untitled';
    const cleanTitle = title.replace(/<[^>]*>/g, '').replace(/\[REMOVE\]/gi, '').trim();
    console.log(`   • Sample Scraped Title: "${cleanTitle.substring(0, 60)}"`);
    console.log(`   • Sample Video URL Type: ${Boolean(sampleItem.mp4_download_url || sampleItem.video_url) ? 'DIRECT STREAM / MP4 ✅' : 'MISSING ⚠️'}`);
  }
  console.log(`   • Downloaded Video Files in Folder: ${downloadedFiles.length} file(s)`);
  if (downloadedFiles.length > 0) {
    const fPath = path.join(downloadPath, downloadedFiles[0]);
    const sizeMb = (fs.statSync(fPath).size / (1024 * 1024)).toFixed(1);
    console.log(`     ↳ Latest: "${downloadedFiles[0]}" (${sizeMb} MB)`);
  }
  console.log('');

  results.push({
    name: ch.name,
    jsonFile: ch.jsonFile,
    jsonCount,
    validUrlsCount,
    downloadedCount: downloadedFiles.length
  });
}

console.log('============================================================');
console.log('📊 SUMMARY REPORT ACROSS ALL 6 SCRAPERS:');
console.log('============================================================');
results.forEach((r, i) => {
  console.log(`${i + 1}. ${r.name.padEnd(10)} | JSON Items: ${String(r.jsonCount).padStart(3)} | Valid Streams: ${String(r.validUrlsCount).padStart(3)} | Downloaded Files: ${r.downloadedCount}`);
});
console.log('============================================================\n');
