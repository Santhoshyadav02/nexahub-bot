/**
 * ============================================================
 * 📊 PIPELINE & SCRAPER REAL-TIME STATUS CLI
 * ============================================================
 * Displays unified status for all 10 Telegram video channels,
 * scraping databases, 2-worker downloads, and daily quotas (50/day).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT_DIR = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(__dirname, 'modular_channel_config.json');

function getFolderSize(dirPath) {
  let total = 0;
  let count = 0;
  try {
    if (fs.existsSync(dirPath)) {
      const files = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const f of files) {
        const full = path.join(dirPath, f.name);
        if (f.isDirectory()) {
          const sub = getFolderSize(full);
          total += sub.total;
          count += sub.count;
        } else if (f.isFile()) {
          try {
            const stat = fs.statSync(full);
            total += stat.size;
            count++;
          } catch (_) {}
        }
      }
    }
  } catch (_) {}
  return { total, count };
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(2)} MB`;
  const kb = bytes / 1024;
  return `${kb.toFixed(2)} KB`;
}

function printStatus() {
  console.log('\n' + '='.repeat(68));
  console.log('       🚀 NEXAHUB UNIFIED 10-CHANNEL VIDEO PIPELINE STATUS');
  console.log('='.repeat(68));
  console.log(`⏱️  Timestamp: ${new Date().toISOString()}`);
  console.log(`💻 Platform:  ${process.platform} (${os.release()}) | Free RAM: ${formatBytes(os.freemem())} / ${formatBytes(os.totalmem())}`);

  let config = { channels: {}, dailyQuotaPerChannel: 5 };
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (e) {
    console.error(`⚠️ Could not load modular_channel_config.json: ${e.message}`);
  }

  let qt = null;
  try {
    const { ModularQuotaTracker } = require('./modular_quota_tracker');
    qt = new ModularQuotaTracker({ defaultDailyQuota: config.dailyQuotaPerChannel || 5 });
  } catch (_) {}

  console.log('\n' + '-'.repeat(68));
  console.log('📺 UNIFIED 10-CHANNEL INVENTORY & PUBLISHING HEALTH');
  console.log('-'.repeat(68));

  const channelKeys = Object.keys(config.channels || {});
  let totalScraped = 0;
  let totalFilesOnDisk = 0;
  let totalDiskBytes = 0;
  let totalPublishedToday = 0;
  const targetTotal = channelKeys.length * (config.dailyQuotaPerChannel || 5);

  channelKeys.forEach((key, idx) => {
    const ch = config.channels[key];
    const dbPath = path.join(ROOT_DIR, ch.databaseJson || `scraping/${key}_videos.json`);
    const dirPath = path.join(ROOT_DIR, ch.downloadDir || `scraping/downloads/${key}`);

    let scrapedCount = 0;
    let latestTitle = 'None';
    if (fs.existsSync(dbPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        if (Array.isArray(raw)) {
          scrapedCount = raw.length;
          if (raw[0]) latestTitle = raw[0].title || raw[0].code || 'Item';
        }
      } catch (_) {}
    }
    totalScraped += scrapedCount;

    const dl = getFolderSize(dirPath);
    totalFilesOnDisk += dl.count;
    totalDiskBytes += dl.total;

    const publishedToday = qt && qt.getPublishedCountToday ? qt.getPublishedCountToday(key) : 0;
    totalPublishedToday += publishedToday;
    const quota = ch.dailyQuota || config.dailyQuotaPerChannel || 5;
    const progress = '█'.repeat(Math.min(publishedToday, quota)) + '░'.repeat(Math.max(0, quota - publishedToday));

    const channelTag = ch.username ? `@${ch.username}` : (ch.chatId || key);
    console.log(`\n${String(idx + 1).padStart(2)}. [${key.toUpperCase().padEnd(8)}] ${ch.name}`);
    console.log(`    ├─ Channel:   ${channelTag.padEnd(16)} | Target ID: ${ch.chatId || 'N/A'}`);
    console.log(`    ├─ Scraped:   ${String(scrapedCount).padStart(3)} in DB        | Latest: ${latestTitle.substring(0, 38)}`);
    console.log(`    ├─ Disk Temp: ${String(dl.count).padStart(3)} files (${formatBytes(dl.total).padEnd(8)}) | Auto-clean on publish: Active`);
    console.log(`    └─ Quota:     [${progress}] ${publishedToday}/${quota} published (24h)`);
  });

  console.log('\n' + '='.repeat(68));
  console.log(`🎯 OVERALL 24-HOUR TARGET: ${totalPublishedToday}/${targetTotal || 50} POSTED (${channelKeys.length} CHANNELS x 5)`);
  console.log('='.repeat(68));
  console.log(`• Parallel Workers:         2 download workers`);
  console.log(`• Total Scraped Inventory:  ${totalScraped} items in DBs`);
  console.log(`• Temp Disk Space in Use:   ${formatBytes(totalDiskBytes)} (${totalFilesOnDisk} files awaiting upload)`);
  console.log(`• Post-Publish Cleanup:     ENABLED (temp files unlinked after send)`);
  console.log('='.repeat(68) + '\n');
}

if (require.main === module) {
  printStatus();
}

module.exports = { printStatus };
