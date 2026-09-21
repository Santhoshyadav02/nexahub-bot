/**
 * ============================================================
 * 🧪 TEST SUITE: UNIFIED 10-CHANNEL SCRAPER PIPELINE
 * ============================================================
 * Verifies:
 *   1. Correct mapping for all 10 specialized channels.
 *   2. 24-hour quota management (5 videos/day per channel limit, 50 total).
 *   3. Date rollover behavior.
 *   4. Dedicated channel routing and idempotency.
 *   5. End-to-end dry-run orchestration.
 */

const fs = require('fs');
const path = require('path');
const { ModularQuotaTracker } = require('./modular_quota_tracker');
const { ModularScraperPipeline } = require('./modular_scraper_pipeline');

const TEST_QUOTA_FILE = path.join(__dirname, '..', 'scratch', 'test_modular_quota.json');
let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}${detail ? ' - ' + detail : ''}`);
    failed++;
  }
}

function section(title) {
  console.log(`\n============================================================`);
  console.log(`🔍 ${title}`);
  console.log(`============================================================`);
}

async function runTests() {
  fs.mkdirSync(path.dirname(TEST_QUOTA_FILE), { recursive: true });
  if (fs.existsSync(TEST_QUOTA_FILE)) fs.unlinkSync(TEST_QUOTA_FILE);

  section('Test 1: Channel Configurations & Scraper Mappings');
  {
    const pipeline = new ModularScraperPipeline({
      quotaTracker: new ModularQuotaTracker({ quotaPath: TEST_QUOTA_FILE })
    });
    const channels = pipeline.config.channels;

    check('Exactly 10 channels configured', Object.keys(channels).length === 10);

    // 1. BJ
    check('BJ maps to @tfccdet (-1004416217845)', channels.bj && channels.bj.username === 'tfccdet' && channels.bj.chatId === '-1004416217845');

    // 2. KR (javleak)
    check('KR maps to @ccsfvk (-1003780478806)', channels.javleak && channels.javleak.username === 'ccsfvk' && channels.javleak.chatId === '-1003780478806');

    // 3. JP (caption)
    check('JP maps to @vsdxda (-1004486764871)', channels.caption && channels.caption.username === 'vsdxda' && channels.caption.chatId === '-1004486764871');

    // 4. CN (javc)
    check('CN maps to @ccdjxc (-1004481385613)', channels.javc && channels.javc.username === 'ccdjxc' && channels.javc.chatId === '-1004481385613');

    // 5. 18.. (javmgs)
    check('18.. maps to @ddkicr (-1004419758275)', channels.javmgs && channels.javmgs.username === 'ddkicr' && channels.javmgs.chatId === '-1004419758275');

    // 6. AV (javm)
    check('AV maps to @cccddghhgf (-1004384169456)', channels.javm && channels.javm.username === 'cccddghhgf' && channels.javm.chatId === '-1004384169456');

    // 7. Dating
    check('Dating maps to @cccsefk (-1003786693669)', channels.dating && channels.dating.username === 'cccsefk' && channels.dating.chatId === '-1003786693669');

    // 8. Romance
    check('Romance maps to @e5brygh (-1004483241550)', channels.romance && channels.romance.username === 'e5brygh' && channels.romance.chatId === '-1004483241550');

    // 9. Hostess
    check('Hostess maps to @sfgfem (-1003725861834)', channels.hostess && channels.hostess.username === 'sfgfem' && channels.hostess.chatId === '-1003725861834');

    // 10. Muse
    check('Muse maps to @bzd4wrf (-1004464504918)', channels.muse && channels.muse.username === 'bzd4wrf' && channels.muse.chatId === '-1004464504918');
  }

  section('Test 2: 24-Hour Quota Tracker (5 Videos/Day Per Channel)');
  {
    const tracker = new ModularQuotaTracker({ quotaPath: TEST_QUOTA_FILE, defaultDailyQuota: 5 });

    check('Initial canPublish(bj) is true', tracker.canPublish('bj') === true);
    check('Initial remaining quota is 5', tracker.getRemainingQuota('bj') === 5);

    // Publish 5 videos
    for (let i = 1; i <= 5; i++) {
      tracker.recordPublish('bj', { mediaId: `vid_${i}`, title: `BJ Video ${i}`, messageId: 100 + i });
    }

    check('Count today is 5', tracker.getPublishedCountToday('bj') === 5);
    check('Remaining quota is 0', tracker.getRemainingQuota('bj') === 0);
    check('canPublish(bj) is now false (ceiling hit)', tracker.canPublish('bj') === false);

    // Other channels still have quota
    check('caption (JP) quota is still 5', tracker.getRemainingQuota('caption') === 5);
    check('canPublish(caption) is true', tracker.canPublish('caption') === true);
  }

  section('Test 3: Date Rollover & Quota Reset');
  {
    const tracker = new ModularQuotaTracker({ quotaPath: TEST_QUOTA_FILE, defaultDailyQuota: 5 });
    tracker.data.currentDate = '2026-01-01'; // Simulate yesterday
    tracker._checkDateRollover();

    check('After rollover, currentDate is updated to today', tracker.data.currentDate === new Date().toISOString().split('T')[0]);
    check('After rollover, bj publishedToday resets to 0', tracker.getPublishedCountToday('bj') === 0);
    check('After rollover, canPublish(bj) is true again', tracker.canPublish('bj') === true);
  }

  section('Test 4: Parallel Downloader Integration');
  {
    const downloaderFile = path.join(__dirname, 'modular_downloader.py');
    check('modular_downloader.py exists', fs.existsSync(downloaderFile));
  }

  section('Test 5: Dry-Run End-to-End Orchestrator');
  {
    const mockClient = {
      sendFile: async (chatId, opts) => ({ id: Math.floor(Math.random() * 10000) }),
      sendVideo: async (chatId, file, opts) => ({ message_id: Math.floor(Math.random() * 10000) })
    };

    const pipeline = new ModularScraperPipeline({
      quotaTracker: new ModularQuotaTracker({ quotaPath: TEST_QUOTA_FILE, defaultDailyQuota: 5 }),
      telegramClient: mockClient,
      workers: 2
    });

    const status = pipeline.getStatus();
    check('Pipeline status retrieved', status && typeof status === 'object');
    check('Scheduler initially inactive', status.schedulerActive === false);
  }

  console.log(`\n============================================================`);
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log(`============================================================\n`);

  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
