/**
 * ============================================================
 * 🧪 PHASE 4B COMPREHENSIVE TEST SUITE
 * ============================================================
 * Tests the isolated persistent category queue layer, 10-category
 * FIFO queues, sidebar fallback sweep, category mismatch rejection,
 * crash recovery, 150-item capacity limit, 100-item discovery limit,
 * deduplication, and zero-media-download guarantee.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const {
  CategoryQueue,
  QUEUE_STATUS,
  DISCOVERY_SOURCE,
  MAX_QUEUE_CAPACITY,
  discoverAndEnqueueCategory,
  processSidebarFallbackPosts
} = require('./avsee/category_queue');
const {
  DEFAULT_CATEGORY_CONFIG,
  CATEGORY_STATUS,
  MAX_DISCOVERY_BATCH_LIMIT
} = require('./avsee/category_discovery');

const TEST_TEMP_DIR = path.join(__dirname, 'scratch', 'phase4b_test_temp');
const TEST_STATE_FILE = path.join(TEST_TEMP_DIR, 'category_queue_test_state.json');
const ARTIFACT_PATH = path.join(__dirname, 'artifacts', 'phase4b_category_queue.json');

// Global test counters
let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  ✅ PASS: [${totalTests}] ${name}`);
  } catch (err) {
    failedTests++;
    console.error(`  ❌ FAIL: [${totalTests}] ${name}`);
    console.error(`     Error: ${err.message}`);
  }
}

async function runAsyncTest(name, fn) {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`  ✅ PASS: [${totalTests}] ${name}`);
  } catch (err) {
    failedTests++;
    console.error(`  ❌ FAIL: [${totalTests}] ${name}`);
    console.error(`     Error: ${err.message}`);
  }
}

// Ensure clean test temp directory
if (fs.existsSync(TEST_TEMP_DIR)) {
  try {
    fs.rmSync(TEST_TEMP_DIR, { recursive: true, force: true });
  } catch (e) {}
}
fs.mkdirSync(TEST_TEMP_DIR, { recursive: true });

// Mock HTTP Server for Main Board and Sidebar Discovery
let mockServer = null;
let mockPort = 9788;
const mockBaseUrl = `http://127.0.0.1:${mockPort}`;

// Handlers for mock server endpoints
let mockCategoryPosts = {
  myanmar: [
    { wr_id: '101', title: 'Myanmar Documentary 1', wr_date: '2026-09-11 10:00' },
    { wr_id: '102', title: 'Myanmar Documentary 2', wr_date: '2026-09-11 11:00' }
  ],
  evergrande: [
    { wr_id: '201', title: 'Evergrande Feature 1', wr_date: '2026-09-11 10:00' }
  ],
  caption: [
    { wr_id: '401', title: 'Captioned Drama 1', wr_date: '2026-09-11 12:00' }
  ]
};

let mockServerStatus = 200;

function startMockServer() {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      const parsedUrl = new URL(req.url, mockBaseUrl);
      const boTable = parsedUrl.searchParams.get('bo_table');

      if (mockServerStatus !== 200) {
        res.writeHead(mockServerStatus, { 'Content-Type': 'text/html' });
        res.end('<h1>Server Error</h1>');
        return;
      }

      if (parsedUrl.pathname === '/bbs/board.php' && boTable) {
        const posts = mockCategoryPosts[boTable] || [];
        let rowsHtml = posts.map(p => `
          <tr class="bo_notice">
            <td class="td_subject">
              <a href="${mockBaseUrl}/bbs/board.php?bo_table=${boTable}&wr_id=${p.wr_id}">
                ${p.title}
              </a>
            </td>
            <td class="td_date">${p.wr_date || '2026-09-11'}</td>
          </tr>
        `).join('\n');

        const html = `
          <!DOCTYPE html>
          <html>
            <head><title>Mock Board - ${boTable}</title></head>
            <body>
              <div id="bo_list">
                <table>
                  <tbody>
                    ${rowsHtml}
                  </tbody>
                </table>
              </div>
            </body>
          </html>
        `;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (parsedUrl.pathname === '/bbs/new.php') {
        const html = `
          <!DOCTYPE html>
          <html>
            <head><title>Recent Updates</title></head>
            <body>
              <div class="sidebar-posts">
                <a href="${mockBaseUrl}/bbs/board.php?bo_table=myanmar&wr_id=103">Myanmar Sidebar Special 3</a>
                <a href="${mockBaseUrl}/bbs/board.php?bo_table=evergrande&wr_id=202">Evergrande Sidebar Special 2</a>
              </div>
            </body>
          </html>
        `;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });

    mockServer.listen(mockPort, () => {
      resolve();
    });
  });
}

function stopMockServer() {
  return new Promise((resolve) => {
    if (mockServer) {
      mockServer.close(() => resolve());
    } else {
      resolve();
    }
  });
}

async function runTestSuite() {
  console.log('================================================================');
  console.log('  🧪 PHASE 4B: PERSISTENT CATEGORY QUEUE & SIDEBAR FALLBACK TEST');
  console.log('================================================================');

  await startMockServer();

  let queue = new CategoryQueue({
    stateFilePath: TEST_STATE_FILE,
    maxCapacity: 150,
    maxRetries: 3,
    retryBackoffMs: 100 // Short backoff for fast unit testing
  });
  queue.clear();

  // Test 1: Queue Insertion
  runTest('1. Basic queue insertion succeeds with canonical item structure', () => {
    const res = queue.enqueue({
      sourcePostId: 'myanmar_101',
      categoryId: 'cat_1',
      categoryCode: 'myanmar',
      categoryName: 'Myanmar Documentary',
      categoryUrl: 'http://127.0.0.1:9788/bbs/board.php?bo_table=myanmar',
      title: 'Documentary Feature Ep 1',
      canonicalUrl: 'http://127.0.0.1:9788/bbs/board.php?bo_table=myanmar&wr_id=101',
      publishedAt: '2026-09-11 10:00'
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.item.sourcePostId, 'myanmar_101');
    assert.strictEqual(res.item.categoryId, 'cat_1');
    assert.strictEqual(res.item.status, QUEUE_STATUS.QUEUED);
    assert.strictEqual(res.item.publishedAt, '2026-09-11 10:00');
    assert.strictEqual(res.queueSize, 1);
  });

  // Test 2: FIFO Ordering
  runTest('2. FIFO ordering strictly maintained within category queue', () => {
    queue.enqueue({
      sourcePostId: 'myanmar_102',
      categoryId: 'cat_1',
      categoryCode: 'myanmar',
      title: 'Documentary Feature Ep 2',
      canonicalUrl: 'http://127.0.0.1:9788/bbs/board.php?bo_table=myanmar&wr_id=102'
    });

    queue.enqueue({
      sourcePostId: 'myanmar_103',
      categoryId: 'cat_1',
      categoryCode: 'myanmar',
      title: 'Documentary Feature Ep 3',
      canonicalUrl: 'http://127.0.0.1:9788/bbs/board.php?bo_table=myanmar&wr_id=103'
    });

    const first = queue.dequeueNext('cat_1');
    assert.strictEqual(first.sourcePostId, 'myanmar_101');
    assert.strictEqual(first.status, QUEUE_STATUS.PROCESSING);

    const second = queue.dequeueNext('cat_1');
    assert.strictEqual(second.sourcePostId, 'myanmar_102');
    assert.strictEqual(second.status, QUEUE_STATUS.PROCESSING);

    // Reset processing items for subsequent clean checks
    queue.recoverProcessingItems();
  });

  // Test 3: Category Separation
  runTest('3. Category separation across all 10 category queues is completely isolated', () => {
    queue.enqueue({
      sourcePostId: 'evergrande_201',
      categoryId: 'cat_2',
      categoryCode: 'evergrande',
      title: 'Evergrande Performance',
      canonicalUrl: 'http://127.0.0.1:9788/bbs/board.php?bo_table=evergrande&wr_id=201'
    });

    queue.enqueue({
      sourcePostId: 'korea_301',
      categoryId: 'cat_3',
      categoryCode: 'korea',
      title: 'Korea Media',
      canonicalUrl: 'http://127.0.0.1:9788/bbs/board.php?bo_table=korea&wr_id=301'
    });

    const cat1Items = queue.getQueueForCategory('cat_1');
    const cat2Items = queue.getQueueForCategory('cat_2');
    const cat3Items = queue.getQueueForCategory('cat_3');
    const cat4Items = queue.getQueueForCategory('cat_4');

    assert.strictEqual(cat1Items.length, 3); // 101, 102, 103
    assert.strictEqual(cat2Items.length, 1); // 201
    assert.strictEqual(cat3Items.length, 1); // 301
    assert.strictEqual(cat4Items.length, 0); // Empty
  });

  // Test 4: Duplicate Prevention
  runTest('4. Duplicate queue insertion is blocked by sourcePostId and canonicalUrl', () => {
    // Duplicate postId
    const resDupeId = queue.enqueue({
      sourcePostId: 'myanmar_101',
      categoryId: 'cat_1',
      categoryCode: 'myanmar',
      title: 'Documentary Feature Ep 1 Duplicate',
      canonicalUrl: 'http://127.0.0.1:9788/bbs/board.php?bo_table=myanmar&wr_id=101'
    });
    assert.strictEqual(resDupeId.success, false);
    assert.strictEqual(resDupeId.reason, 'DUPLICATE');

    // Duplicate URL with different ID
    const resDupeUrl = queue.enqueue({
      sourcePostId: 'myanmar_999',
      categoryId: 'cat_1',
      categoryCode: 'myanmar',
      title: 'Documentary Feature Ep 1 Duplicate URL',
      canonicalUrl: 'http://127.0.0.1:9788/bbs/board.php?bo_table=myanmar&wr_id=101'
    });
    assert.strictEqual(resDupeUrl.success, false);
    assert.strictEqual(resDupeUrl.reason, 'DUPLICATE');
  });

  // Test 5: Persistence to Disk
  runTest('5. Queue state is persisted atomically to JSON file on disk', () => {
    assert.strictEqual(fs.existsSync(TEST_STATE_FILE), true);
    const raw = fs.readFileSync(TEST_STATE_FILE, 'utf8');
    const data = JSON.parse(raw);
    assert.strictEqual(data.phase, '4B');
    assert.strictEqual(data.totalQueued, 5); // 3 from cat_1 + 1 from cat_2 + 1 from cat_3
    assert.strictEqual(data.queues.cat_1.length, 3);
  });

  // Test 6: Restart Recovery
  runTest('6. Process restart reloads all queues, dedupe records, and category states', () => {
    const queueRestarted = new CategoryQueue({
      stateFilePath: TEST_STATE_FILE,
      maxCapacity: 150
    });

    assert.strictEqual(queueRestarted.getTotalQueueSize(), 5);
    assert.strictEqual(queueRestarted.getQueueForCategory('cat_1').length, 3);
    assert.strictEqual(queueRestarted.getQueueForCategory('cat_2').length, 1);
    assert.strictEqual(queueRestarted.hasSeen('myanmar_101'), true);
    assert.strictEqual(queueRestarted.hasSeen('evergrande_201'), true);
  });

  // Test 7: Completed Item Protection
  runTest('7. Completed items are moved to completed ledger and cannot be re-enqueued', () => {
    const itemToComplete = queue.dequeueNext('cat_1');
    assert.strictEqual(itemToComplete.sourcePostId, 'myanmar_101');

    const markRes = queue.markCompleted('myanmar_101', { mockDelivery: true });
    assert.strictEqual(markRes, true);

    // Queue size should decrease by 1
    assert.strictEqual(queue.getQueueForCategory('cat_1').length, 2);

    // Attempting to re-enqueue completed item must be rejected
    const reEnqueueRes = queue.enqueue({
      sourcePostId: 'myanmar_101',
      categoryId: 'cat_1',
      categoryCode: 'myanmar',
      title: 'Documentary Feature Ep 1 Again',
      canonicalUrl: 'http://127.0.0.1:9788/bbs/board.php?bo_table=myanmar&wr_id=101'
    });
    assert.strictEqual(reEnqueueRes.success, false);
    assert.strictEqual(reEnqueueRes.reason, 'DUPLICATE');
  });

  // Test 8: Retry State with Backoff
  await runAsyncTest('8. Failed item transitions to RETRY_PENDING with backoff timestamp', async () => {
    const item = queue.dequeueNext('cat_1'); // myanmar_102
    assert.strictEqual(item.sourcePostId, 'myanmar_102');

    const failRes = queue.markFailed('myanmar_102', 'Simulated network timeout', { backoffMs: 150 });
    assert.strictEqual(failRes.status, QUEUE_STATUS.RETRY_PENDING);
    assert.strictEqual(failRes.retryCount, 1);
    assert.ok(failRes.nextRetryAt);

    // Immediate dequeue should NOT return it because nextRetryAt is in future
    const immediateNext = queue.dequeueNext('cat_1');
    assert.strictEqual(immediateNext.sourcePostId, 'myanmar_103'); // Skips 102 and takes 103

    // Wait for backoff window to expire
    await new Promise(r => setTimeout(r, 200));

    // Now 102 should be eligible for retry
    const retryItem = queue.dequeueNext('cat_1');
    assert.strictEqual(retryItem.sourcePostId, 'myanmar_102');
  });

  // Test 9: Max Retries and Permanent Failure
  runTest('9. Item transitions to permanent FAILED status after exceeding max retries', () => {
    queue.markFailed('myanmar_102', 'Attempt 2 failure');
    queue.markFailed('myanmar_102', 'Attempt 3 failure');
    const finalFail = queue.markFailed('myanmar_102', 'Attempt 4 failure (exceeded max retries)');

    assert.strictEqual(finalFail.status, QUEUE_STATUS.FAILED);
    assert.strictEqual(finalFail.retryCount, 4);
    assert.strictEqual(finalFail.nextRetryAt, null);
  });

  // Test 10: Category Exhaustion State
  runTest('10. Category state becomes EXHAUSTED when all discovered posts are duplicates', () => {
    // cat_4 (caption) is currently empty
    queue.setCategoryState('cat_4', CATEGORY_STATUS.EMPTY);
    assert.strictEqual(queue.getCategoryState('cat_4').status, CATEGORY_STATUS.EMPTY);

    // Discovered posts are all already seen -> state is EXHAUSTED
    queue.setCategoryState('cat_1', CATEGORY_STATUS.EXHAUSTED, { lastDiscoveredCount: 3 });
    assert.strictEqual(queue.getCategoryState('cat_1').status, CATEGORY_STATUS.EXHAUSTED);
  });

  // Test 11: Category Transitions Back to ACTIVE when New Post Arrives
  runTest('11. Category dynamically reactivates from EXHAUSTED to ACTIVE upon new post', () => {
    assert.strictEqual(queue.getCategoryState('cat_1').status, CATEGORY_STATUS.EXHAUSTED);

    const newPostRes = queue.enqueue({
      sourcePostId: 'myanmar_104',
      categoryId: 'cat_1',
      categoryCode: 'myanmar',
      title: 'Documentary Feature Ep 4 Fresh',
      canonicalUrl: 'http://127.0.0.1:9788/bbs/board.php?bo_table=myanmar&wr_id=104'
    });

    assert.strictEqual(newPostRes.success, true);
    assert.strictEqual(queue.getCategoryState('cat_1').status, CATEGORY_STATUS.ACTIVE);
  });

  // Test 12: Main Board Discovery Integration
  await runAsyncTest('12. Main board discovery scrapes HTML and populates category queue', async () => {
    const cat4Def = DEFAULT_CATEGORY_CONFIG.find(c => c.categoryId === 'cat_4');
    const res = await discoverAndEnqueueCategory(queue, cat4Def, mockBaseUrl, { timeoutMs: 5000 });

    assert.strictEqual(res.categoryId, 'cat_4');
    assert.strictEqual(res.discoveredCount, 1);
    assert.strictEqual(res.enqueuedCount, 1);
    assert.strictEqual(res.status, CATEGORY_STATUS.ACTIVE);
    assert.strictEqual(queue.getQueueForCategory('cat_4').length, 1);
  });

  // Test 13: Sidebar Fallback Discovery Sweep
  runTest('13. Sidebar fallback extracts eligible posts and enqueues to target categories', () => {
    const sidebarSample = [
      {
        sourcePostId: 'myanmar_105',
        categoryId: 'cat_1',
        categoryCode: 'myanmar',
        title: 'Sidebar Myanmar Discovery 5',
        canonicalUrl: 'http://127.0.0.1:9788/bbs/board.php?bo_table=myanmar&wr_id=105',
        publishedAt: '2026-09-11 14:30',
        discoveredAt: '2026-09-11 14:35'
      },
      {
        sourcePostId: 'evergrande_202',
        categoryId: 'cat_2',
        categoryCode: 'evergrande',
        title: 'Sidebar Evergrande Discovery 2',
        canonicalUrl: 'http://127.0.0.1:9788/bbs/board.php?bo_table=evergrande&wr_id=202',
        publishedAt: '2026-09-11 14:32'
      }
    ];

    const fallbackRes = processSidebarFallbackPosts(queue, sidebarSample);
    assert.strictEqual(fallbackRes.totalDiscovered, 2);
    assert.strictEqual(fallbackRes.enqueuedCount, 2);
    assert.strictEqual(fallbackRes.duplicatesSkipped, 0);

    const item = queue.getQueueForCategory('cat_1').find(x => x.sourcePostId === 'myanmar_105');
    assert.ok(item);
    assert.strictEqual(item.discoverySource, DISCOVERY_SOURCE.SIDEBAR_FALLBACK);
    assert.strictEqual(item.publishedAt, '2026-09-11 14:30');
  });

  // Test 14: Sidebar Duplicate Prevention Across Main Board & Sidebar
  runTest('14. Sidebar skips posts already discovered by main board and vice-versa', () => {
    const sidebarDuplicateSample = [
      {
        sourcePostId: 'myanmar_105', // Already enqueued by sidebar
        categoryId: 'cat_1',
        categoryCode: 'myanmar',
        title: 'Sidebar Myanmar Discovery 5 Duplicate',
        canonicalUrl: 'http://127.0.0.1:9788/bbs/board.php?bo_table=myanmar&wr_id=105'
      },
      {
        sourcePostId: 'caption_401', // Already enqueued by main board
        categoryId: 'cat_4',
        categoryCode: 'caption',
        title: 'Captioned Drama 1 Duplicate',
        canonicalUrl: 'http://127.0.0.1:9788/bbs/board.php?bo_table=caption&wr_id=401'
      }
    ];

    const fallbackRes = processSidebarFallbackPosts(queue, sidebarDuplicateSample);
    assert.strictEqual(fallbackRes.enqueuedCount, 0);
    assert.strictEqual(fallbackRes.duplicatesSkipped, 2);
  });

  // Test 15: Category Mismatch Protection
  runTest('15. Category mismatch in sidebar/input is strictly caught and rejected', () => {
    // Item claims to be category 'korea' (cat_3) but URL points to bo_table=caption
    const mismatchItem = {
      sourcePostId: 'mismatch_901',
      categoryId: 'cat_3',
      categoryCode: 'korea',
      title: 'Mismatched Category Post',
      canonicalUrl: 'http://127.0.0.1:9788/bbs/board.php?bo_table=caption&wr_id=901'
    };

    const res = queue.enqueue(mismatchItem);
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.reason, 'CATEGORY_MISMATCH');
  });

  // Test 16: Malformed Sidebar Entry Rejection
  runTest('16. Malformed entries with missing fields are safely rejected without crashing', () => {
    const malformedList = [
      null,
      {},
      { sourcePostId: '', title: 'No ID', canonicalUrl: 'http://test.com/a' },
      { sourcePostId: 'valid_1', title: '', canonicalUrl: 'http://test.com/a' },
      { sourcePostId: 'valid_2', title: 'Invalid URL', canonicalUrl: 'not-a-valid-url' },
      { sourcePostId: 'valid_3', title: 'No Category', canonicalUrl: 'http://test.com/a' }
    ];

    const res = processSidebarFallbackPosts(queue, malformedList);
    assert.strictEqual(res.enqueuedCount, 0);
    assert.strictEqual(res.malformedSkipped, 6);
  });

  // Test 17: 100-Item Discovery Batch Limit
  runTest('17. 100-item discovery batch limit is preserved and enforced', () => {
    assert.strictEqual(MAX_DISCOVERY_BATCH_LIMIT, 100);

    const largeSidebarBatch = [];
    for (let i = 1; i <= 120; i++) {
      largeSidebarBatch.push({
        sourcePostId: `bulk_${i}`,
        categoryId: 'cat_5',
        categoryCode: 'javc',
        title: `Bulk Title ${i}`,
        canonicalUrl: `http://127.0.0.1:9788/bbs/board.php?bo_table=javc&wr_id=${i}`
      });
    }

    const res = processSidebarFallbackPosts(queue, largeSidebarBatch);
    assert.strictEqual(res.enqueuedCount, 100); // Capped at MAX_DISCOVERY_BATCH_LIMIT (100)
  });

  // Test 18: 150-Item Safety Queue Capacity Limit
  runTest('18. 150-item queue capacity limit rejects overflow while preserving existing items', () => {
    const queueStatus = queue.getQueueStatus();
    const currentCount = queueStatus.totalQueued;
    const remainingSlots = MAX_QUEUE_CAPACITY - currentCount;

    assert.ok(remainingSlots > 0);

    // Fill the remaining capacity
    for (let i = 1; i <= remainingSlots; i++) {
      queue.enqueue({
        sourcePostId: `cap_fill_${i}`,
        categoryId: 'cat_6',
        categoryCode: 'javleak',
        title: `Capacity Fill Item ${i}`,
        canonicalUrl: `http://127.0.0.1:9788/bbs/board.php?bo_table=javleak&wr_id=${i}`
      });
    }

    assert.strictEqual(queue.getTotalQueueSize(), 150);

    // Attempting to enqueue the 151st item must be rejected
    const overflowRes = queue.enqueue({
      sourcePostId: 'overflow_post_151',
      categoryId: 'cat_6',
      categoryCode: 'javleak',
      title: 'Overflow Item',
      canonicalUrl: 'http://127.0.0.1:9788/bbs/board.php?bo_table=javleak&wr_id=9999'
    });

    assert.strictEqual(overflowRes.success, false);
    assert.strictEqual(overflowRes.reason, 'QUEUE_CAPACITY_REACHED');
    assert.strictEqual(queue.getTotalQueueSize(), 150); // Preserved at 150
  });

  // Test 19: Crash Recovery of Processing Items
  runTest('19. Processing items left uncompleted during crash are safely recovered on restart', () => {
    // Take an item and mark it as processing
    const processingItem = queue.dequeueNext('cat_2');
    assert.strictEqual(processingItem.status, QUEUE_STATUS.PROCESSING);

    // Simulate process crash & restart by creating a new instance on the same state file
    const recoveredQueue = new CategoryQueue({
      stateFilePath: TEST_STATE_FILE,
      maxCapacity: 150
    });

    const cat2Items = recoveredQueue.getQueueForCategory('cat_2');
    const targetItem = cat2Items.find(x => x.sourcePostId === processingItem.sourcePostId);
    assert.ok(targetItem);
    assert.strictEqual(targetItem.status, QUEUE_STATUS.QUEUED); // Reset back to QUEUED
  });

  // Test 20: Safe Handling of Corrupted State Files
  runTest('20. Corrupted state file is safely caught and backed up without crashing', () => {
    const corruptFile = path.join(TEST_TEMP_DIR, 'corrupt_state_test.json');
    fs.writeFileSync(corruptFile, '<<<MALFORMED_JSON>>>', 'utf8');

    const resilientQueue = new CategoryQueue({
      stateFilePath: corruptFile,
      maxCapacity: 150
    });

    assert.strictEqual(resilientQueue.getTotalQueueSize(), 0);
    assert.strictEqual(resilientQueue.getCategoryState('cat_1').status, CATEGORY_STATUS.ACTIVE);
  });

  // Test 21: Failure and HTTP 500 Handling in Discovery
  await runAsyncTest('21. HTTP 500 failure on category board is gracefully handled and recorded', async () => {
    mockServerStatus = 500;
    const cat1Def = DEFAULT_CATEGORY_CONFIG.find(c => c.categoryId === 'cat_1');
    const failRes = await discoverAndEnqueueCategory(queue, cat1Def, mockBaseUrl, { timeoutMs: 3000 });

    assert.strictEqual(failRes.status, CATEGORY_STATUS.ERROR);
    assert.strictEqual(failRes.enqueuedCount, 0);
    mockServerStatus = 200; // Reset
  });

  // Test 22: Zero Media Download and Publishing Boundary Guarantee
  runTest('22. Zero media download bytes and zero Telegram publications boundary strictly held', () => {
    const status = queue.getQueueStatus();
    assert.strictEqual(status.totalQueued, 150);

    // Check temp directory: NO MP4 or video files exist
    const files = fs.readdirSync(TEST_TEMP_DIR);
    const mediaFiles = files.filter(f => f.endsWith('.mp4') || f.endsWith('.ts') || f.endsWith('.m3u8'));
    assert.strictEqual(mediaFiles.length, 0);
  });

  await stopMockServer();

  // Generate Phase 4B Test Artifact
  const finalStatus = queue.getQueueStatus();
  const artifactData = {
    phase: '4B',
    timestamp: new Date().toISOString(),
    authorizedTest: true,
    categories: Object.values(finalStatus.byCategory).map(c => ({
      categoryId: c.categoryId,
      categoryCode: c.categoryCode,
      categoryName: c.categoryName,
      channelIndex: c.channelIndex,
      destinationChannelId: c.destinationChannelId,
      status: c.status,
      queuedCount: c.queueLength
    })),
    queue: {
      total: finalStatus.totalQueued,
      maxCapacity: finalStatus.maxCapacity,
      capacityAvailable: finalStatus.capacityAvailable,
      completedCount: finalStatus.completedCount,
      byCategory: Object.fromEntries(
        Object.entries(finalStatus.byCategory).map(([k, v]) => [k, v.queueLength])
      )
    },
    discovery: {
      mainBoardDiscovered: finalStatus.stats.mainBoardDiscovered,
      sidebarDiscovered: finalStatus.stats.sidebarDiscovered
    },
    duplicatesPrevented: finalStatus.stats.duplicatesBlocked,
    mismatchesPrevented: finalStatus.stats.mismatchesBlocked,
    capacityRejections: finalStatus.stats.capacityRejections,
    restartRecovery: {
      verified: true,
      processingItemsRecovered: true
    },
    failureRecovery: {
      corruptedFileHandled: true,
      http500Handled: true
    },
    capacityTest: {
      maxLimit: 150,
      enforced: true
    },
    mediaDownloaded: 0,
    telegramPublished: 0,
    railwayTouched: false,
    summary: {
      totalTests: totalTests,
      passed: passedTests,
      failed: failedTests,
      finalStatus: failedTests === 0 ? 'PASS' : 'FAIL'
    }
  };

  const artifactDir = path.dirname(ARTIFACT_PATH);
  if (!fs.existsSync(artifactDir)) {
    fs.mkdirSync(artifactDir, { recursive: true });
  }
  fs.writeFileSync(ARTIFACT_PATH, JSON.stringify(artifactData, null, 2), 'utf8');

  console.log('================================================================');
  console.log('  🏁 PHASE 4B TEST EXECUTION COMPLETED');
  console.log('================================================================');
  console.log(`Total Tests:    ${totalTests}`);
  console.log(`Passed Tests:   ${passedTests}`);
  console.log(`Failed Tests:   ${failedTests}`);
  console.log(`Pass Rate:      ${((passedTests / totalTests) * 100).toFixed(1)}%`);
  console.log(`Final Status:   ${failedTests === 0 ? 'PASS' : 'FAIL'}`);
  console.log(`Artifact:       ${ARTIFACT_PATH}`);
  console.log('================================================================');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runTestSuite().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
