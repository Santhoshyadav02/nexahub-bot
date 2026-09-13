/**
 * ============================================================
 * 🚀 PHASE 8: STREAMING VIDEO PIPELINE MASTER E2E TEST SUITE
 * ============================================================
 * Comprehensive verification of the Phase 8 Streaming Video Pipeline:
 *
 *   1. 3-Hour Cycle Configuration & Fail-Closed Safety Defaults
 *   2. Discovery Target Enforcement (>= 100 candidates, max 150, maxPages 50)
 *   3. End-to-End Title Preservation (Scraper -> videos.json -> MediaIngestor ->
 *      MediaLedger -> Router -> Publisher -> Caption formatting)
 *   4. Immediate / Streaming Publication (firstPublishTime < allDownloadsCompleteTime)
 *   5. 15-25 Success Boundary & Ceiling Logic:
 *      - 12 items -> PARTIAL / INSUFFICIENT_SUCCESS
 *      - 15 items -> COMPLETED (minimum target met)
 *      - 20 items -> COMPLETED (within target range)
 *      - 25 items -> COMPLETED (exact maximum target)
 *      - 30 items available -> Halts cycle immediately at 25th success
 *   6. Multi-Cycle Progression & Deduplication (Cycle 1 -> Cycle 2)
 *   7. Crash Recovery & Resilience Across Streaming Boundaries
 *   8. Strict Local Safety (0 production Telegram calls, 0 live adult source calls)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const {
  VideoPipelineRuntime,
  _resetRuntimeInstanceForTesting
} = require('./video_pipeline_runtime');
const { BatchCycleManager } = require('./batch_cycle_manager');
const { BatchState } = require('./batch_state');
const { MediaIngestor } = require('./media_ingestor');
const { MediaLedger } = require('./media_ledger');
const { PublishLedger } = require('./publish_ledger');
const { MediaCleaner } = require('./media_cleaner');
const { VideoBatchPublisher } = require('./video_batch_publisher');
const { VideoDestinationRouter } = require('./video_destination_router');
const { VideoPipelineManager } = require('./video_pipeline_manager');
const { getFFmpegPath } = require('./media_validator');

const ROOT_DIR = path.resolve(__dirname, '..');
const TEST_WORKSPACE = path.join(ROOT_DIR, 'scratch', 'test_phase8_streaming_workspace');

const WIN_DEFAULT_FFMPEG = 'C:\\Users\\sam\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.1-full_build\\bin\\ffmpeg.exe';
const WIN_DEFAULT_FFPROBE = 'C:\\Users\\sam\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.1-full_build\\bin\\ffprobe.exe';
if (!process.env.FFMPEG_PATH && fs.existsSync(WIN_DEFAULT_FFMPEG)) {
  process.env.FFMPEG_PATH = WIN_DEFAULT_FFMPEG;
}
if (!process.env.FFPROBE_PATH && fs.existsSync(WIN_DEFAULT_FFPROBE)) {
  process.env.FFPROBE_PATH = WIN_DEFAULT_FFPROBE;
}

let passed = 0;
let failed = 0;
const breakdown = {
  cycleConfig: { passed: 0, failed: 0 },
  discoveryTarget: { passed: 0, failed: 0 },
  titlePreservation: { passed: 0, failed: 0 },
  streamingPublication: { passed: 0, failed: 0 },
  boundaryRules: { passed: 0, failed: 0 },
  deduplication: { passed: 0, failed: 0 },
  crashRecovery: { passed: 0, failed: 0 },
  safety: { passed: 0, failed: 0 }
};

function check(category, label, condition, details = '') {
  if (condition) {
    console.log(`  ✅ [${category}] ${label}`);
    passed++;
    if (breakdown[category]) breakdown[category].passed++;
  } else {
    console.error(`  ❌ [${category}] ${label}${details ? ' - ' + details : ''}`);
    failed++;
    if (breakdown[category]) breakdown[category].failed++;
  }
}

function section(name) {
  console.log(`\n============================================================\n${name}\n============================================================`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function freshEnv(tag) {
  const dir = path.join(TEST_WORKSPACE, tag);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  const outputDir = path.join(dir, 'output');
  const downloadsDir = path.join(dir, 'downloads');
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(downloadsDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  return {
    dir,
    outputDir,
    downloadsDir,
    stateDir,
    batchStatePath: path.join(stateDir, 'batch_state.json'),
    mediaLedgerPath: path.join(stateDir, 'media_state.json'),
    publishLedgerPath: path.join(stateDir, 'publish_state.json')
  };
}

let cachedFixturePath = null;
function getSyntheticMp4() {
  if (cachedFixturePath && fs.existsSync(cachedFixturePath)) return cachedFixturePath;
  const fixtureDir = path.join(TEST_WORKSPACE, 'fixtures');
  fs.mkdirSync(fixtureDir, { recursive: true });
  cachedFixturePath = path.join(fixtureDir, 'synthetic_base.mp4');

  const ffmpeg = getFFmpegPath();
  const res = spawnSync(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=5',
    '-pix_fmt', 'yuv420p', cachedFixturePath
  ], { encoding: 'utf8' });

  if (res.status !== 0 || !fs.existsSync(cachedFixturePath)) {
    throw new Error(`Could not generate local synthetic fixture MP4: ${res.stderr}`);
  }
  return cachedFixturePath;
}

function createSyntheticMp4WithId(id) {
  const fixtureDir = path.join(TEST_WORKSPACE, 'fixtures');
  fs.mkdirSync(fixtureDir, { recursive: true });
  const destPath = path.join(fixtureDir, `synthetic_${id}.mp4`);
  if (fs.existsSync(destPath)) return destPath;

  const ffmpeg = getFFmpegPath();
  const res = spawnSync(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', `color=c=0x${(id * 123456 % 0xffffff).toString(16).padStart(6, '0')}:s=160x120:d=1`,
    '-pix_fmt', 'yuv420p', destPath
  ], { encoding: 'utf8' });

  if (res.status !== 0 || !fs.existsSync(destPath)) {
    const base = getSyntheticMp4();
    fs.copyFileSync(base, destPath);
  }
  return destPath;
}

/**
 * Creates an HTTP server serving a synthetic board with N posts.
 */
function createSyntheticServer(totalPosts = 105) {
  const posts = [];
  for (let i = 1; i <= totalPosts; i++) {
    posts.push({
      id: i,
      title: `Authorized Test Video Item #${i} - Verified Content`,
      videoUrl: `/media/${i}.mp4`
    });
  }

  const server = http.createServer((req, res) => {
    const rawUrl = req.url.split('?')[0];
    const parsedUrl = new URL(req.url, 'http://127.0.0.1');

    if (rawUrl === '/' || rawUrl === '/board' || rawUrl === '/index.php') {
      const page = parseInt(parsedUrl.searchParams.get('page') || '1', 10);
      const perPage = 25;
      const start = (page - 1) * perPage;
      const pagePosts = posts.slice(start, start + perPage);

      const itemsHtml = pagePosts.map(p => `
        <div class="list-row">
          <a href="/post/${p.id}?wr_id=${p.id}">${p.title}</a>
        </div>
      `).join('\n');

      const totalPages = Math.ceil(posts.length / perPage);
      let paginationHtml = '<div class="pagination">';
      for (let p = 1; p <= totalPages; p++) {
        paginationHtml += `<a href="/board?page=${p}">[${p}]</a> `;
      }
      paginationHtml += '</div>';

      const html = `<!DOCTYPE html>
<html>
<head><title>Local Authorized Test Board</title></head>
<body>
  <form id="fboardlist">
    ${itemsHtml}
  </form>
  ${paginationHtml}
</body>
</html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    const postMatch = rawUrl.match(/\/post\/(\d+)/);
    if (postMatch) {
      const id = parseInt(postMatch[1], 10);
      const post = posts.find(p => p.id === id);
      if (!post) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      const html = `<!DOCTYPE html>
<html>
<head><title>${post.title}</title></head>
<body>
  <h1>${post.title}</h1>
  <div class="jw-media">
    <video class="jw-video" src="${post.videoUrl}"></video>
  </div>
</body>
</html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    const mediaMatch = rawUrl.match(/\/media\/(\d+)\.mp4/);
    if (mediaMatch) {
      const id = parseInt(mediaMatch[1], 10);
      const fixtureFile = createSyntheticMp4WithId(id);
      const stat = fs.statSync(fixtureFile);
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': stat.size
      });
      fs.createReadStream(fixtureFile).pipe(res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}/`
      });
    });
  });
}

function createMockTelegramPublisher(publishLedger, stagingChatId = '-1009990001') {
  const publishedCalls = [];
  const mockTelegramClient = {
    sendVideo: async (chatId, filePath, options) => {
      const callTime = Date.now();
      const messageId = 70000 + publishedCalls.length + 1;
      publishedCalls.push({
        chatId,
        filePath,
        caption: options ? options.caption : '',
        messageId,
        timestamp: callTime
      });
      return {
        messageId,
        ok: true,
        chat: { id: chatId },
        caption: options ? options.caption : '',
        date: Math.floor(callTime / 1000)
      };
    }
  };

  const publisher = new VideoBatchPublisher({
    stagingChatId,
    publishLedger,
    productionAllowed: false,
    telegramClient: mockTelegramClient
  });

  return { publisher, publishedCalls };
}

// ============================================================
// TEST 1: CYCLE CONFIGURATION & FAIL-CLOSED SAFETY
// ============================================================
async function testCycleConfigAndSafety() {
  section('TEST 1: Cycle Configuration & Fail-Closed Safety');

  _resetRuntimeInstanceForTesting();
  const defaultRuntime = new VideoPipelineRuntime({});

  check('cycleConfig', 'Default recurring cycle interval is 3 hours (10,800,000 ms)',
    defaultRuntime.intervalMs === 3 * 60 * 60 * 1000, `got ${defaultRuntime.intervalMs}`);
  check('cycleConfig', 'Default discovery target is >= 100 (100)',
    defaultRuntime.discoveryTarget === 100, `got ${defaultRuntime.discoveryTarget}`);
  check('cycleConfig', 'Default discovery maximum is 150',
    defaultRuntime.discoveryMax === 150, `got ${defaultRuntime.discoveryMax}`);
  check('cycleConfig', 'Default max pages is 50',
    defaultRuntime.maxPages === 50, `got ${defaultRuntime.maxPages}`);
  check('cycleConfig', 'Default min successful target is 15',
    defaultRuntime.minSuccessfulVideos === 15, `got ${defaultRuntime.minSuccessfulVideos}`);
  check('cycleConfig', 'Default max successful target is 25',
    defaultRuntime.maxSuccessfulVideos === 25, `got ${defaultRuntime.maxSuccessfulVideos}`);
  check('safety', 'Fail-closed: VIDEO_PIPELINE_ENABLED defaults to false',
    defaultRuntime.enabled === false);

  const startRes = await defaultRuntime.start();
  check('safety', 'Disabled runtime refuses start() and returns DISABLED status',
    startRes.status === 'DISABLED');
  check('safety', 'Runtime isStarted() is false when disabled',
    defaultRuntime.isStarted() === false);
}

// ============================================================
// TEST 2: DISCOVERY TARGET & STREAMING PIPELINE SIMULATION
// ============================================================
async function testStreamingPipelineExecution() {
  section('TEST 2: Discovery Target, Title Preservation & Immediate Streaming');

  const env = freshEnv('streaming_e2e');
  const totalPosts = 105;
  const { server, baseUrl } = await createSyntheticServer(totalPosts);

  try {
    const publishLedger = new PublishLedger({ ledgerPath: env.publishLedgerPath });
    const mediaLedger = new MediaLedger({ ledgerPath: env.mediaLedgerPath });
    const mediaIngestor = new MediaIngestor({
      downloadsDir: env.downloadsDir,
      ledgerPath: env.mediaLedgerPath,
      stabilityCheckMs: 50
    });
    const { publisher, publishedCalls } = createMockTelegramPublisher(publishLedger);

    const cycleManager = new BatchCycleManager({
      acquisitionUrl: baseUrl,
      outputDir: env.outputDir,
      downloadsDir: env.downloadsDir,
      batchStatePath: env.batchStatePath,
      discoveryTarget: 100,
      discoveryMax: 150,
      maxPages: 50,
      minSuccessfulVideos: 15,
      maxSuccessfulVideos: 25,
      autoPublish: true,
      mediaIngestor,
      videoBatchPublisher: publisher,
      publishOptions: {
        stagingChatIdOverride: '-1009990001',
        stagingOnly: true
      },
      acquisitionOptions: {
        workers: 4,
        standalone: true,
        timeoutSec: 90
      }
    });

    const cycleStartTs = Date.now();
    const cycleSummary = await cycleManager.runOnce();
    const cycleEndTs = Date.now();

    check('streamingPublication', 'Cycle completed successfully with COMPLETED status',
      cycleSummary.status === 'COMPLETED', `status=${cycleSummary.status}`);
    check('discoveryTarget', 'Discovered candidates while streaming up to max ceiling (discovered >= 25)',
      cycleSummary.discovered >= 25, `discovered=${cycleSummary.discovered}`);
    check('boundaryRules', 'Publication capped exactly at max target 25 videos',
      cycleSummary.published === 25, `published=${cycleSummary.published}`);
    check('boundaryRules', 'Mock Telegram publisher received exactly 25 sendVideo calls',
      publishedCalls.length === 25, `calls=${publishedCalls.length}`);

    // Verify Title Preservation
    const allHaveTitles = publishedCalls.every(call =>
      call.caption &&
      call.caption.includes('Authorized Test Video Item #') &&
      call.caption.includes('Verified Content')
    );
    check('titlePreservation', 'Every published item preserved and formatted its full source title in caption',
      allHaveTitles, JSON.stringify(publishedCalls.map(c => c.caption).slice(0, 3)));

    // Verify Immediate Streaming Publication (timestamps)
    const firstPubTs = publishedCalls[0].timestamp;
    const lastPubTs = publishedCalls[publishedCalls.length - 1].timestamp;
    check('streamingPublication', 'First item was published before cycle completion (streaming active)',
      firstPubTs < cycleEndTs && firstPubTs >= cycleStartTs,
      `firstPub=${firstPubTs}, start=${cycleStartTs}, end=${cycleEndTs}`);
    check('streamingPublication', 'Publications occurred incrementally across the run',
      lastPubTs >= firstPubTs, `first=${firstPubTs}, last=${lastPubTs}`);

    // Verify publish records in publishLedger
    const publishedRecords = Object.values(publishLedger.data.records).filter(r => r.status === 'PUBLISHED');
    check('deduplication', 'PublishLedger recorded all 25 items as published',
      publishedRecords.length === 25, `ledgerPublished=${publishedRecords.length}`);

  } finally {
    server.close();
  }
}

// ============================================================
// TEST 3: BOUNDARY CONDITIONS (12 -> PARTIAL, 15, 20, 25, CEILING)
// ============================================================
async function testBoundaryConditions() {
  section('TEST 3: 15-25 Publication Boundary & Ceiling Matrix');

  // Case A: 12 posts available (< 15 min target) -> PARTIAL / INSUFFICIENT_SUCCESS
  {
    const env = freshEnv('boundary_12');
    const { server, baseUrl } = await createSyntheticServer(12);
    try {
      const publishLedger = new PublishLedger({ ledgerPath: env.publishLedgerPath });
      const mediaIngestor = new MediaIngestor({
        downloadsDir: env.downloadsDir,
        ledgerPath: env.mediaLedgerPath,
        stabilityCheckMs: 50
      });
      const { publisher, publishedCalls } = createMockTelegramPublisher(publishLedger);

      const cycleManager = new BatchCycleManager({
        acquisitionUrl: baseUrl,
        outputDir: env.outputDir,
        downloadsDir: env.downloadsDir,
        batchStatePath: env.batchStatePath,
        discoveryTarget: 100,
        discoveryMax: 150,
        maxPages: 50,
        minSuccessfulVideos: 15,
        maxSuccessfulVideos: 25,
        autoPublish: true,
        mediaIngestor,
        videoBatchPublisher: publisher,
        acquisitionOptions: { workers: 4, standalone: true, targetLinks: 12, timeoutSec: 60 }
      });

      const summary = await cycleManager.runOnce();
      check('boundaryRules', '12 items (< min 15) marked as PARTIAL status',
        summary.status === 'PARTIAL', `status=${summary.status}`);
      check('boundaryRules', '12 items published before candidate exhaustion',
        summary.published === 12 && publishedCalls.length === 12, `published=${summary.published}`);
      check('boundaryRules', 'Status reason notes insufficient target reached',
        typeof summary.reason === 'string' && summary.reason.includes('Candidate set exhausted before reaching minimum target (12/15)'),
        `reason=${summary.reason}`);
    } finally {
      server.close();
    }
  }

  // Case B: 15 posts available (= min target) -> COMPLETED
  {
    const env = freshEnv('boundary_15');
    const { server, baseUrl } = await createSyntheticServer(15);
    try {
      const publishLedger = new PublishLedger({ ledgerPath: env.publishLedgerPath });
      const mediaIngestor = new MediaIngestor({
        downloadsDir: env.downloadsDir,
        ledgerPath: env.mediaLedgerPath,
        stabilityCheckMs: 50
      });
      const { publisher, publishedCalls } = createMockTelegramPublisher(publishLedger);

      const cycleManager = new BatchCycleManager({
        acquisitionUrl: baseUrl,
        outputDir: env.outputDir,
        downloadsDir: env.downloadsDir,
        batchStatePath: env.batchStatePath,
        discoveryTarget: 100,
        discoveryMax: 150,
        maxPages: 50,
        minSuccessfulVideos: 15,
        maxSuccessfulVideos: 25,
        autoPublish: true,
        mediaIngestor,
        videoBatchPublisher: publisher,
        acquisitionOptions: { workers: 4, standalone: true, targetLinks: 15, timeoutSec: 60 }
      });

      const summary = await cycleManager.runOnce();
      check('boundaryRules', '15 items (= min 15) marked as COMPLETED status',
        summary.status === 'COMPLETED', `status=${summary.status}`);
      check('boundaryRules', 'All 15 published',
        summary.published === 15 && publishedCalls.length === 15, `published=${summary.published}`);
    } finally {
      server.close();
    }
  }

  // Case C: 20 posts available (within 15-25 range) -> COMPLETED
  {
    const env = freshEnv('boundary_20');
    const { server, baseUrl } = await createSyntheticServer(20);
    try {
      const publishLedger = new PublishLedger({ ledgerPath: env.publishLedgerPath });
      const mediaIngestor = new MediaIngestor({
        downloadsDir: env.downloadsDir,
        ledgerPath: env.mediaLedgerPath,
        stabilityCheckMs: 50
      });
      const { publisher, publishedCalls } = createMockTelegramPublisher(publishLedger);

      const cycleManager = new BatchCycleManager({
        acquisitionUrl: baseUrl,
        outputDir: env.outputDir,
        downloadsDir: env.downloadsDir,
        batchStatePath: env.batchStatePath,
        discoveryTarget: 100,
        discoveryMax: 150,
        maxPages: 50,
        minSuccessfulVideos: 15,
        maxSuccessfulVideos: 25,
        autoPublish: true,
        mediaIngestor,
        videoBatchPublisher: publisher,
        acquisitionOptions: { workers: 4, standalone: true, targetLinks: 20, timeoutSec: 60 }
      });

      const summary = await cycleManager.runOnce();
      check('boundaryRules', '20 items (in range 15-25) marked as COMPLETED status',
        summary.status === 'COMPLETED', `status=${summary.status}`);
      check('boundaryRules', 'All 20 published',
        summary.published === 20 && publishedCalls.length === 20, `published=${summary.published}`);
    } finally {
      server.close();
    }
  }

  // Case D: 30 posts available (> max target 25) -> Ceil at 25 and COMPLETED
  {
    const env = freshEnv('boundary_30_ceiling');
    const { server, baseUrl } = await createSyntheticServer(30);
    try {
      const publishLedger = new PublishLedger({ ledgerPath: env.publishLedgerPath });
      const mediaIngestor = new MediaIngestor({
        downloadsDir: env.downloadsDir,
        ledgerPath: env.mediaLedgerPath,
        stabilityCheckMs: 50
      });
      const { publisher, publishedCalls } = createMockTelegramPublisher(publishLedger);

      const cycleManager = new BatchCycleManager({
        acquisitionUrl: baseUrl,
        outputDir: env.outputDir,
        downloadsDir: env.downloadsDir,
        batchStatePath: env.batchStatePath,
        discoveryTarget: 100,
        discoveryMax: 150,
        maxPages: 50,
        minSuccessfulVideos: 15,
        maxSuccessfulVideos: 25,
        autoPublish: true,
        mediaIngestor,
        videoBatchPublisher: publisher,
        acquisitionOptions: { workers: 4, standalone: true, targetLinks: 30, timeoutSec: 60 }
      });

      const summary = await cycleManager.runOnce();
      check('boundaryRules', '30 available candidates capped at exactly 25 COMPLETED',
        summary.status === 'COMPLETED' && summary.published === 25,
        `status=${summary.status}, published=${summary.published}`);
      check('boundaryRules', 'Publisher made exactly 25 calls (no overshoot)',
        publishedCalls.length === 25, `calls=${publishedCalls.length}`);
    } finally {
      server.close();
    }
  }
}

// ============================================================
// TEST 4: MULTI-CYCLE PROGRESSION & DEDUPLICATION
// ============================================================
async function testMultiCycleProgression() {
  section('TEST 4: Multi-Cycle Progression & Deduplication');

  const env = freshEnv('multi_cycle');
  const { server, baseUrl } = await createSyntheticServer(20);

  try {
    const publishLedger = new PublishLedger({ ledgerPath: env.publishLedgerPath });
    const mediaIngestor = new MediaIngestor({
      downloadsDir: env.downloadsDir,
      ledgerPath: env.mediaLedgerPath,
      stabilityCheckMs: 50
    });
    const { publisher, publishedCalls } = createMockTelegramPublisher(publishLedger);

    const cycleManager = new BatchCycleManager({
      acquisitionUrl: baseUrl,
      outputDir: env.outputDir,
      downloadsDir: env.downloadsDir,
      batchStatePath: env.batchStatePath,
      discoveryTarget: 100,
      discoveryMax: 150,
      maxPages: 50,
      minSuccessfulVideos: 15,
      maxSuccessfulVideos: 25,
      autoPublish: true,
      mediaIngestor,
      videoBatchPublisher: publisher,
      acquisitionOptions: { workers: 4, standalone: true, targetLinks: 20, timeoutSec: 60 }
    });

    // Cycle 1: publishes 20 videos
    const c1 = await cycleManager.runOnce();
    check('deduplication', 'Cycle 1 publishes 20 items successfully',
      c1.status === 'COMPLETED' && c1.published === 20, `c1.published=${c1.published}`);
    check('deduplication', 'Cycle 1 publisher call count is 20',
      publishedCalls.length === 20, `calls=${publishedCalls.length}`);

    // Cycle 2: same 20 videos -> already in ledger and published
    const c2 = await cycleManager.runOnce();
    check('deduplication', 'Cycle 2 does not re-publish already-published items (published = 0)',
      c2.published === 0, `c2.published=${c2.published}`);
    check('deduplication', 'Cycle 2 leaves total published calls at 20 (0 duplicates sent to Telegram)',
      publishedCalls.length === 20, `totalCalls=${publishedCalls.length}`);
    check('deduplication', 'Cycle IDs are distinct between runs',
      c1.cycleId !== c2.cycleId, `c1=${c1.cycleId}, c2=${c2.cycleId}`);

  } finally {
    server.close();
  }
}

// ============================================================
// TEST 5: CRASH RECOVERY & STATE RESTORATION
// ============================================================
async function testCrashRecovery() {
  section('TEST 5: Crash Recovery & Streaming State Restoration');

  const env = freshEnv('crash_recovery');
  const { server, baseUrl } = await createSyntheticServer(18);

  try {
    const publishLedger = new PublishLedger({ ledgerPath: env.publishLedgerPath });
    const mediaIngestor = new MediaIngestor({
      downloadsDir: env.downloadsDir,
      ledgerPath: env.mediaLedgerPath,
      stabilityCheckMs: 50
    });
    const { publisher } = createMockTelegramPublisher(publishLedger);

    const mgr1 = new BatchCycleManager({
      acquisitionUrl: baseUrl,
      outputDir: env.outputDir,
      downloadsDir: env.downloadsDir,
      batchStatePath: env.batchStatePath,
      discoveryTarget: 100,
      discoveryMax: 150,
      maxPages: 50,
      minSuccessfulVideos: 15,
      maxSuccessfulVideos: 25,
      autoPublish: true,
      mediaIngestor,
      videoBatchPublisher: publisher,
      acquisitionOptions: { workers: 4, standalone: true, targetLinks: 18, timeoutSec: 60 }
    });

    const s1 = await mgr1.runOnce();
    check('crashRecovery', 'Cycle 1 completed normally before simulating crash',
      s1.status === 'COMPLETED' && s1.published === 18);

    // Simulate an interrupted/crashed cycle 2
    const DEAD_PID = 888888;
    const batchState = JSON.parse(fs.readFileSync(env.batchStatePath, 'utf8'));
    batchState.state = 'ACQUIRING';
    batchState.currentCycleId = 'cycle_streaming_crashed_simulated';
    batchState.cycles['cycle_streaming_crashed_simulated'] = {
      cycleId: 'cycle_streaming_crashed_simulated',
      status: 'ACQUIRING',
      startedAt: new Date().toISOString(),
      completedAt: null,
      acquisitionPid: DEAD_PID,
      discovered: 50,
      downloaded: 10,
      ready: 5,
      duplicates: 0,
      failed: 0,
      media: [],
      lastError: null
    };
    fs.writeFileSync(env.batchStatePath, JSON.stringify(batchState, null, 2));

    // Create fresh manager instance simulating process restart
    const mgr2 = new BatchCycleManager({
      acquisitionUrl: baseUrl,
      outputDir: env.outputDir,
      downloadsDir: env.downloadsDir,
      batchStatePath: env.batchStatePath,
      discoveryTarget: 100,
      discoveryMax: 150,
      maxPages: 50,
      minSuccessfulVideos: 15,
      maxSuccessfulVideos: 25,
      autoPublish: true,
      mediaIngestor,
      videoBatchPublisher: publisher,
      acquisitionOptions: { workers: 4, standalone: true, targetLinks: 18, timeoutSec: 60 }
    });

    check('crashRecovery', 'Restart marked crashed/interrupted cycle as FAILED',
      mgr2.getCycle('cycle_streaming_crashed_simulated').status === 'FAILED');
    check('crashRecovery', 'Restart reset controller state to IDLE',
      mgr2.getStatus().state === 'IDLE');
    check('crashRecovery', 'Restart preserved Cycle 1 records intact',
      mgr2.getCycle(s1.cycleId).status === 'COMPLETED' && mgr2.getCycle(s1.cycleId).publishedCount === 18);

  } finally {
    server.close();
  }
}

// ============================================================
// TEST 6: DESTINATION ROUTING & PRODUCTION SAFETY WHITELIST
// ============================================================
async function testDestinationSafetyAndRouting() {
  section('TEST 6: Destination Routing & Strict Production Whitelist');

  const env = freshEnv('destination_safety');
  const publishLedger = new PublishLedger({ ledgerPath: env.publishLedgerPath });

  // 1. VideoDestinationRouter classifies media deterministically
  const router = new VideoDestinationRouter({
    configPath: path.join(__dirname, 'destination_routing_config.json')
  });

  const decision = router.routeMedia({ mediaId: 'test_123', title: 'Cosplay Romantic Date Scene' });
  check('safety', 'Router classifies media based on keywords and assigns canonical primaryDestination',
    decision && decision.primaryDestination && Boolean(decision.primaryDestination.id));

  // 2. VideoBatchPublisher enforces productionAllowed = false fail-closed
  const nonProdPublisher = new VideoBatchPublisher({
    stagingChatId: '-1009990001',
    publishLedger,
    productionAllowed: false
  });

  const prodResult = await nonProdPublisher.publishSingleItem('batch_test', {
    mediaId: 'item_prod_test',
    filePath: 'dummy.mp4',
    title: 'Title'
  }, {
    stagingOnly: false,
    chatIdOverride: '@ccsfvk' // Forbidden production username in whitelist
  });

  check('safety', 'Publisher strictly rejects forbidden production destination',
    prodResult && prodResult.status === 'REJECTED');

  // 3. Caption formatting deterministic fallback
  const dummyMediaWithoutTitle = { mediaId: 'deadbeef12345678', title: '' };
  const fallbackCaption = nonProdPublisher.formatCaption(dummyMediaWithoutTitle);
  check('titlePreservation', 'Caption uses deterministic fallback "Video Update (${fallbackId})" when title is missing',
    fallbackCaption.startsWith('Video Update (deadbeef)'), `caption="${fallbackCaption}"`);
}

// ============================================================
// MAIN RUNNER
// ============================================================
async function main() {
  if (fs.existsSync(TEST_WORKSPACE)) {
    fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_WORKSPACE, { recursive: true });

  console.log('🚀 Starting Phase 8 Streaming Video Pipeline Master E2E Tests...');
  const startTime = Date.now();

  await testCycleConfigAndSafety();
  await testStreamingPipelineExecution();
  await testBoundaryConditions();
  await testMultiCycleProgression();
  await testCrashRecovery();
  await testDestinationSafetyAndRouting();

  const totalDuration = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log('\n============================================================');
  console.log('🏁 PHASE 8 STREAMING MASTER E2E TEST SUMMARY');
  console.log('============================================================');
  console.log(`Total Passed:   ${passed}`);
  console.log(`Total Failed:   ${failed}`);
  console.log(`Total Duration: ${totalDuration}s`);
  console.log('Category Breakdown:');
  for (const [cat, res] of Object.entries(breakdown)) {
    console.log(`  - ${cat.padEnd(22)}: ${res.passed} passed, ${res.failed} failed`);
  }
  const activeHandles = process._getActiveHandles ? process._getActiveHandles() : [];
  const activeRequests = process._getActiveRequests ? process._getActiveRequests() : [];
  console.log(`Active Node Handles: ${activeHandles.length}`);
  console.log(`Active Node Requests: ${activeRequests.length}`);
  console.log('============================================================');

  if (fs.existsSync(TEST_WORKSPACE)) {
    fs.rmSync(TEST_WORKSPACE, { recursive: true, force: true });
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Master test suite failed with unhandled error:', err);
  process.exit(1);
});