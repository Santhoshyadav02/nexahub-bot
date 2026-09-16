const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const { DailyAdminReporter, formatBytes } = require('./video_pipeline/daily_admin_reporter');

function runTests() {
  console.log('🧪 Starting DailyAdminReporter Unit Tests...');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reporter-test-'));
  const downloadsDir = path.join(tmpDir, 'downloads');
  const stateDir = path.join(tmpDir, 'state');
  fs.mkdirSync(downloadsDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  const now = Date.now();
  const twoHoursAgo = new Date(now - 2 * 3600 * 1000).toISOString();
  const thirtyHoursAgo = new Date(now - 30 * 3600 * 1000).toISOString();

  // Mock download_seen.json
  const seenPath = path.join(downloadsDir, 'download_seen.json');
  fs.writeFileSync(seenPath, JSON.stringify(['url1', 'url2', 'url3', 'url4', 'url5']), 'utf8');

  // Mock download_report.json
  const reportPath = path.join(downloadsDir, 'download_report.json');
  const mockDownloads = [
    { url: 'url1', downloaded_at: twoHoursAgo, filesize: 1024 * 1024 * 500 }, // 500 MB (in window)
    { url: 'url2', downloaded_at: twoHoursAgo, filesize: 1024 * 1024 * 1000 }, // 1000 MB (in window)
    { url: 'url3', downloaded_at: thirtyHoursAgo, filesize: 1024 * 1024 * 800 } // 800 MB (outside window)
  ];
  fs.writeFileSync(reportPath, JSON.stringify(mockDownloads), 'utf8');

  // Mock publish_state.json
  const pubPath = path.join(stateDir, 'publish_state.json');
  const mockPublish = {
    records: {
      rec1: { mediaId: 'm1', destinationId: 'DESTINATION_1', status: 'PUBLISHED', publishedAt: twoHoursAgo },
      rec2: { mediaId: 'm2', destinationId: 'DESTINATION_1', status: 'PUBLISHED', publishedAt: twoHoursAgo },
      rec3: { mediaId: 'm3', destinationId: 'DESTINATION_2', status: 'PUBLISHED', publishedAt: twoHoursAgo },
      rec4: { mediaId: 'm4', destinationId: 'DESTINATION_5', status: 'PUBLISHED', publishedAt: twoHoursAgo },
      rec5: { mediaId: 'm5', destinationId: 'DESTINATION_1', status: 'PUBLISHED', publishedAt: thirtyHoursAgo } // outside window
    }
  };
  fs.writeFileSync(pubPath, JSON.stringify(mockPublish), 'utf8');

  const reporter = new DailyAdminReporter({
    downloadsDir,
    downloadReportPath: reportPath,
    downloadSeenPath: seenPath,
    publishLedgerPath: pubPath
  });

  const rep = reporter.generateReport(24);

  // Assertions
  assert.strictEqual(rep.crawling.totalCrawledLinks, 5, 'Crawled links must be 5');
  assert.strictEqual(rep.downloads.count, 2, 'In-window downloads must be 2');
  assert.strictEqual(rep.publishing.total, 4, 'In-window published must be 4');
  assert.strictEqual(rep.publishing.channels.DESTINATION_1.count, 2, 'DESTINATION_1 count must be 2');
  assert.strictEqual(rep.publishing.channels.DESTINATION_2.count, 1, 'DESTINATION_2 count must be 1');
  assert.strictEqual(rep.publishing.channels.DESTINATION_5.count, 1, 'DESTINATION_5 count must be 1');
  assert(rep.htmlText.includes('Romantic Vibe'), 'HTML must include channel name');
  assert(rep.htmlText.includes('Playwright 크롤링'), 'HTML must include Playwright header');

  console.log('✅ Unit tests passed successfully!');

  // Test mock send
  const mockBot = {
    sentMessages: [],
    async sendMessage(chatId, text, opts) {
      this.sentMessages.push({ chatId, text, opts });
      return { message_id: 123 };
    }
  };

  reporter.sendReportToAdmins(mockBot, ['8781836301']).then(res => {
    assert(res.success === true, 'sendReportToAdmins must succeed');
    assert(mockBot.sentMessages.length > 0, 'Must send message to admin');
    assert.strictEqual(mockBot.sentMessages[0].chatId, '8781836301', 'Must target 8781836301');
    console.log('✅ Dispatcher tests passed successfully!');

    // Cleanup
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {}

    console.log('🎉 All DailyAdminReporter tests completed with 0 errors.');
  });
}

runTests();