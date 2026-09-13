/**
 * ============================================================
 * 🧪 TEST: FULL VIDEO PIPELINE E2E INTEGRATION (Phase 4A)
 * ============================================================
 * Tests the complete end-to-end flow:
 *
 *   Local Fixture Server -> video-tools (Playwright + Downloader)
 *   -> VideoPipelineManager -> MediaIngestor -> MediaLedger
 *   -> BatchCycleManager -> BATCH_READY
 *   -> VideoBatchPublisher -> Mock Telegram Staging -> PublishLedger
 *   -> PUBLISHED
 *
 * Boundary rules:
 *   - Local fixture server only (127.0.0.1).
 *   - Zero live / external requests.
 *   - Zero production Telegram calls.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const { BatchCycleManager } = require('./batch_cycle_manager');
const { MediaIngestor } = require('./media_ingestor');
const { VideoBatchPublisher } = require('./video_batch_publisher');
const { BatchState } = require('./batch_state');
const { PublishLedger } = require('./publish_ledger');

const ROOT_DIR = path.resolve(__dirname, '..');
const FIXTURE_MP4 = path.join(ROOT_DIR, 'scratch', 'real_video_test.mp4');
const E2E_DIR = path.join(ROOT_DIR, 'scratch', 'video_pipeline_e2e_workspace');

let passed = 0, failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.error(`  ❌ ${label}${detail ? ' - ' + detail : ''}`); failed++; }
}
function section(title) { console.log(`\n--- ${title} ---`); }

function freshDir(name) {
  const dir = path.join(E2E_DIR, name);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function runE2ETest() {
  console.log('============================================================');
  console.log('🎬 FULL VIDEO PIPELINE E2E INTEGRATION TEST (PHASE 4A)');
  console.log('============================================================');

  const proxyConfigPath = path.join(ROOT_DIR, 'video-scrapper', 'video-tools', '.proxy.local.json');
  const proxyConfigBackupPath = `${proxyConfigPath}.set-aside-by-nexahub-e2e-test`;
  const hadProxyConfig = fs.existsSync(proxyConfigPath);
  if (hadProxyConfig) {
    fs.renameSync(proxyConfigPath, proxyConfigBackupPath);
    console.log('Temporarily set aside video-tools/.proxy.local.json for this local-only test.');
  }

  const workspace = freshDir('full_e2e_run');
  const outputDir = path.join(workspace, 'output');
  const downloadsDir = path.join(workspace, 'downloads');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(downloadsDir, { recursive: true });

  const batchStatePath = path.join(workspace, 'batch_state.json');
  const publishLedgerPath = path.join(workspace, 'publish_state.json');

  const fixtureBytes = fs.readFileSync(FIXTURE_MP4);

  // 1. Start local mock HTTP server
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/' || url === '/listing') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><body><form id="fboardlist">
        <div class="list-row"><div class="list-item"><a href="/post/1?wr_id=1">Post 1</a></div></div>
      </form></body></html>`);
      return;
    }
    if (url === '/post/1') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><body><h1>E2E Test Video Title</h1>
        <div class="jw-media"><video class="jw-video" src="/media/video1.mp4"></video></div></body></html>`);
      return;
    }
    if (url === '/media/video1.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': fixtureBytes.length });
      res.end(fixtureBytes);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const serverPort = server.address().port;
  const baseUrl = `http://127.0.0.1:${serverPort}/`;
  console.log(`Local fixture server listening at ${baseUrl}`);

  try {
    section('Step 1: BatchCycleManager runs one acquisition cycle');
    const batchState = new BatchState({ statePath: batchStatePath });
    const mediaLedgerPath = path.join(workspace, 'media_state.json');
    const mediaIngestor = new MediaIngestor({ downloadsDir, ledgerPath: mediaLedgerPath });
    const batchManager = new BatchCycleManager({
      acquisitionUrl: baseUrl,
      outputDir,
      downloadsDir,
      batchState,
      mediaIngestor,
      acquisitionOptions: { workers: 1, timeoutSec: 15, targetLinks: 1, maxPages: 1, standalone: true }
    });

    const cycleSummary = await batchManager.runOnce();
    check('Acquisition cycle returns BATCH_READY', cycleSummary.status === 'BATCH_READY');
    check('1 item reached READY in batch', cycleSummary.ready === 1);

    const frozenBatch = batchState.getCycle(cycleSummary.cycleId);
    check('Frozen batch contains media item', Array.isArray(frozenBatch.media) && frozenBatch.media.length === 1);
    check('Frozen title is captured correctly', frozenBatch.media[0].title === 'E2E Test Video Title');
    check('Frozen media size matches fixture', frozenBatch.media[0].size === fixtureBytes.length);

    section('Step 2: VideoBatchPublisher publishes BATCH_READY batch to STAGING');
    const publishLedger = new PublishLedger({ ledgerPath: publishLedgerPath });
    const sentTelegramMessages = [];

    const mockTelegram = {
      sendVideo: async (chatId, filePath, options) => {
        sentTelegramMessages.push({ chatId, filePath, options });
        return { message_id: 998877, chat: { id: chatId } };
      }
    };

    const publisher = new VideoBatchPublisher({
      stagingChatId: '-1009998888',
      telegramClient: mockTelegram,
      batchState,
      publishLedger,
      rateLimitDelayMs: 0
    });

    const pubSummary = await publisher.publishBatch(cycleSummary.cycleId);

    check('Publisher status is PUBLISHED or COMPLETED', ['PUBLISHED', 'COMPLETED'].includes(pubSummary.status));
    check('Published count is 1', pubSummary.published === 1);
    check('Telegram message ID recorded', pubSummary.items[0].telegramMessageId === '998877');
    check('Publish ledger recorded PUBLISHED state', publishLedger.isPublished(frozenBatch.media[0].mediaId, '-1009998888') === true);
    check('Telegram caption matches frozen title', sentTelegramMessages[0].options.caption === 'E2E Test Video Title');
    check('Media file remains on disk (not deleted)', fs.existsSync(frozenBatch.media[0].filePath) === true);

    section('Step 3: Re-publish batch (Idempotency verification)');
    const rePubSummary = await publisher.publishBatch(cycleSummary.cycleId, { allowAlreadyPublishedBatch: true });
    check('Second publish skips already-published media', rePubSummary.skipped === 1 && rePubSummary.published === 0);
    check('Telegram API not called a second time', sentTelegramMessages.length === 1);

    console.log('\n============================================================');
    console.log(`FULL E2E RESULT: ${passed} passed, ${failed} failed`);
    console.log('============================================================\n');
  } finally {
    // process.exit() below must never run inside this try block - it
    // terminates the process immediately and skips any pending `finally`,
    // which previously left video-tools/.proxy.local.json permanently
    // renamed aside on any failing run.
    server.close();
    if (hadProxyConfig && fs.existsSync(proxyConfigBackupPath)) {
      fs.renameSync(proxyConfigBackupPath, proxyConfigPath);
      console.log('Restored video-tools/.proxy.local.json.');
    }
  }

  if (failed > 0) {
    process.exit(1);
  }
}

runE2ETest().catch(err => {
  console.error('E2E test failed with error:', err);
  process.exit(1);
});
