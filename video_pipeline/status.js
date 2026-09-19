/**
 * ============================================================
 * 📊 PIPELINE & SCRAPER REAL-TIME STATUS CLI
 * ============================================================
 * Displays complete status for Scraper 1, Scraper 2, Playwright
 * databases, downloading workers, and Telegram channel uploads.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT_DIR = path.resolve(__dirname, '..');

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
  console.log('\n' + '='.repeat(65));
  console.log('       🚀 NEXAHUB SCRAPING & PUBLISHING PIPELINE STATUS');
  console.log('='.repeat(65));
  console.log(`⏱️  Timestamp: ${new Date().toISOString()}`);
  console.log(`💻 Platform: ${process.platform} (${os.release()}) | Memory Free: ${formatBytes(os.freemem())} / ${formatBytes(os.totalmem())}`);

  // -------------------------------------------------------------
  // 1. SCRAPER 2: MODULAR 6-CHANNEL PIPELINE STATUS
  // -------------------------------------------------------------
  console.log('\n' + '-'.repeat(65));
  console.log('📦 [SCRAPER 2] MODULAR 6-CHANNEL PLAYWRIGHT & TELEGRAM STATUS');
  console.log('-'.repeat(65));

  const scraper2Channels = [
    { key: 'bj', name: '토끼 소녀 코스프레 데이트', channel: '@tfccdet', topic: 'BJ.', db: 'scraping/bj_videos.json', dir: 'scraping/downloads/bj' },
    { key: 'javleak', name: '로맨틱한 분위기💥', channel: '@ccsfvk', topic: 'KR', db: 'scraping/javleak_videos.json', dir: 'scraping/downloads/JAV leak' },
    { key: 'caption', name: '모사 JP', channel: '@vsdxda', topic: 'JP', db: 'scraping/caption_videos.json', dir: 'scraping/downloads/JAV caption' },
    { key: 'javc', name: '가랑이 (CN)', channel: '@ccdjxc', topic: 'CN', db: 'scraping/javc_videos.json', dir: 'scraping/downloads/JAV censored' },
    { key: 'javmgs', name: '첩 (18..)', channel: '@ddkicr', topic: '18..', db: 'scraping/javmgs_videos.json', dir: 'scraping/downloads/JAV MGStage' },
    { key: 'javm', name: '사키 미즈미 (AV)', channel: '@cccddghhgf', topic: 'AV', db: 'scraping/javm_videos.json', dir: 'scraping/downloads/JAV removed Mosaic' }
  ];

  let totalScraped2 = 0;
  let totalPendingDownloads = 0;

  for (const ch of scraper2Channels) {
    const dbPath = path.join(ROOT_DIR, ch.db);
    const dirPath = path.join(ROOT_DIR, ch.dir);

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
    totalScraped2 += scrapedCount;

    const dl = getFolderSize(dirPath);
    totalPendingDownloads += dl.count;

    console.log(`\n• [${ch.topic.padEnd(5)}] ${ch.name}`);
    console.log(`  └─ Channel: ${ch.channel.padEnd(14)} | VIP Topic: ${ch.topic}`);
    console.log(`  └─ Scraped in DB: ${String(scrapedCount).padStart(3)} videos | Latest: ${latestTitle.substring(0, 35)}`);
    console.log(`  └─ Download Dir:  ${String(dl.count).padStart(3)} files on disk (${formatBytes(dl.total)})`);
  }

  // Quota Status
  try {
    const { ModularQuotaTracker } = require('./modular_quota_tracker');
    const qt = new ModularQuotaTracker();
    console.log('\n📊 24-Hour Channel Quota Usage (Max 5/day):');
    for (const ch of scraper2Channels) {
      const todayCount = (qt.getPublishedCountToday ? qt.getPublishedCountToday(ch.key) : 0) || 0;
      const progress = '█'.repeat(todayCount) + '░'.repeat(Math.max(0, 5 - todayCount));
      console.log(`  • ${ch.topic.padEnd(5)} (${ch.channel.padEnd(12)}): [${progress}] ${todayCount}/5 published today`);
    }
  } catch (_) {}

  // -------------------------------------------------------------
  // 2. VIP TOPIC CATALOG CARDS STATUS
  // -------------------------------------------------------------
  console.log('\n' + '-'.repeat(65));
  console.log('👑 [VIP SUPERGROUP] TOPIC CATALOG INVENTORY');
  console.log('-'.repeat(65));

  try {
    const { VipTopicRouter } = require('./vip_topic_router');
    const router = new VipTopicRouter();
    const categories = ['BJ', 'KR', 'JP', 'CN', '18', 'AV', 'ALL'];
    for (const cat of categories) {
      const items = router.cardsData.categories[cat] || [];
      const card = router.formatCategoryCard(cat, 1);
      const totalPages = Math.max(1, Math.ceil(items.length / 8));
      console.log(`  • [${cat.padEnd(4)}] Total Links: ${String(items.length).padStart(3)} | Pages: ${totalPages} | Header: ${card.text.split('\n')[0]}`);
    }
  } catch (e) {
    console.log(`  ⚠️ Could not read VIP router cards: ${e.message}`);
  }

  // -------------------------------------------------------------
  // 3. SCRAPER 1: 4 CHANNELS (DATING, ROMANCE, HOSTESS, MUSE)
  // -------------------------------------------------------------
  console.log('\n' + '-'.repeat(65));
  console.log('🌐 [SCRAPER 1] 4-CHANNEL STREAMING PIPELINE & LEDGER STATUS');
  console.log('-'.repeat(65));

  const scraper1Channels = [
    { name: 'Dating', channel: '@cccsefk', chatId: '-1004464504918' },
    { name: 'Romance', channel: '@e5brygh', chatId: '-1004384169456' },
    { name: 'Lustful Hostess', channel: '@sfgfem', chatId: '-1004486764871' },
    { name: 'A Muse', channel: '@bzd4wrf', chatId: '-1003786693669' }
  ];

  for (const ch of scraper1Channels) {
    console.log(`• ${ch.name.padEnd(16)} | Channel: ${ch.channel.padEnd(12)} | ID: ${ch.chatId} | Target: 5 vids/day`);
  }

  const sourceRegPath = path.join(ROOT_DIR, 'source_registry.json');
  if (fs.existsSync(sourceRegPath)) {
    try {
      const reg = JSON.parse(fs.readFileSync(sourceRegPath, 'utf8'));
      const postsCount = (reg.posts || []).length;
      const sourcesCount = (reg.sources || []).length;
      console.log(`\n  • Source Registry Channels: ${sourcesCount} sources`);
      console.log(`  • Total Master Indexed Posts: ${postsCount} posts in registry`);
    } catch (_) {}
  }

  try {
    const { PublishLedger } = require('./publish_ledger');
    const ledger = new PublishLedger();
    const publishedCount = ledger.getPublishedCount ? ledger.getPublishedCount() : (ledger.records ? Object.keys(ledger.records).length : 0);
    console.log(`  • Total Confirmed Published Records in Ledger: ${publishedCount}`);
  } catch (_) {}

  // -------------------------------------------------------------
  // 4. OVERALL 50-VIDEO / 24-HOUR TARGET SUMMARY
  // -------------------------------------------------------------
  console.log('\n' + '='.repeat(65));
  console.log('🎯 OVERALL 24-HOUR TARGET: 50 VIDEOS / DAY (10 CHANNELS x 5)');
  console.log('='.repeat(65));
  console.log(`• Total Channels Configured: 10 (4 Scraper 1 + 6 Scraper 2)`);
  console.log(`• Daily Quota per Channel:   5 videos / 24 hours`);
  console.log(`• Auto Post-Publish Cleanup: ENABLED (zero disk waste)`);
  console.log('='.repeat(65) + '\n');
}

if (require.main === module) {
  printStatus();
}

module.exports = { printStatus };
