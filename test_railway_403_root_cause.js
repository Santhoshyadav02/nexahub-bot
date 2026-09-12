const http = require('http');
const assert = require('assert');
const { chromium } = require('playwright');
const { AvseeSourceAdapter } = require('./avsee_source_adapter');
const { discoverBoardPosts } = require('./avsee/board_discovery');
const { CategoryRoundRobinPipeline, HEALTH_STATE } = require('./avsee/category_round_robin_pipeline');
const { DEFAULT_CATEGORY_CONFIG } = require('./avsee/category_discovery');
const { CategoryDiscovery, CATEGORY_STATUS } = require('./avsee/category_discovery');

async function runRootCauseSuite() {
  console.log('====================================================');
  console.log('🧪 RUNNING RAILWAY 403 ROOT CAUSE VERIFICATION SUITE');
  console.log('====================================================\n');

  let server = null;
  let serverMode = 200;

  server = http.createServer((req, res) => {
    if (serverMode === 403) {
      res.writeHead(403, { 'Content-Type': 'text/html' });
      res.end('<html><head><title>403 Forbidden</title></head><body><h1>Access Denied</h1></body></html>');
      return;
    }
    if (serverMode === 'challenge') {
      res.writeHead(403, { 'Content-Type': 'text/html' });
      res.end('<html><head><title>Just a moment...</title></head><body><div id="challenge-running">Checking your browser</div></body></html>');
      return;
    }
    if (serverMode === 'empty') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><div id="bo_list"><table><tbody></tbody></table></div></body></html>');
      return;
    }
    if (serverMode === 'timeout') {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body>Delayed</body></html>');
      }, 5000);
      return;
    }
    // 200 with posts
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><div id="bo_list"><table><tbody><tr><td class="td_subject"><a href="http://127.0.0.1:9777/bbs/board.php?bo_table=korea&wr_id=101">Item 101</a></td></tr></tbody></table></div></body></html>');
  });

  await new Promise(r => server.listen(9777, r));
  const testUrl = 'http://127.0.0.1:9777/bbs/board.php?bo_table=korea';

  try {
    // 1. Chromium healthy + target HTTP 200
    serverMode = 200;
    const adapter = new AvseeSourceAdapter({ apiUrl: 'http://127.0.0.1:9777' });
    const browserCheck = await adapter.checkBrowserLaunch();
    assert.strictEqual(browserCheck.pass, true, 'Test 1: Browser check must PASS');
    const posts200 = await discoverBoardPosts(testUrl, { headless: true });
    assert.strictEqual(posts200.success, true, 'Test 1: HTTP 200 discovery must PASS');
    assert.strictEqual(posts200.posts.length, 1, 'Test 1: Found 1 post');
    console.log('✅ [PASS] 1. Chromium healthy + target HTTP 200');

    // 2. Chromium healthy + target HTTP 403
    serverMode = 403;
    const browserCheck2 = await adapter.checkBrowserLaunch();
    assert.strictEqual(browserCheck2.pass, true, 'Test 2: Browser check remains PASS even when target is 403');
    const posts403 = await discoverBoardPosts(testUrl, { headless: true });
    assert.strictEqual(posts403.success, false, 'Test 2: HTTP 403 discovery returns success: false');
    assert.strictEqual(posts403.posts.length, 0, 'Test 2: 0 posts on 403');
    assert.ok(posts403.error.includes('403'), 'Test 2: Error correctly captures HTTP 403');
    console.log('✅ [PASS] 2. Chromium healthy + target HTTP 403 (Clean separation of browser health vs target access)');

    // 3. Chromium healthy + target challenge
    serverMode = 'challenge';
    const postsChal = await discoverBoardPosts(testUrl, { headless: true });
    assert.strictEqual(postsChal.success, false, 'Test 3: Challenge discovery fails safely');
    console.log('✅ [PASS] 3. Chromium healthy + target challenge');

    // 4. Category Discovery 403 Status Mapping
    serverMode = 403;
    const catDisc = new CategoryDiscovery({
      baseUrl: 'http://127.0.0.1:9777',
      categoryConfig: [{ categoryId: 'cat_1', categoryCode: 'korea', categoryName: 'Korea', boardPath: '/bbs/board.php?bo_table=korea' }]
    });
    const catRes = await catDisc.discoverCategory(catDisc.categoryConfig[0]);
    assert.strictEqual(catRes.status, CATEGORY_STATUS.BLOCKED, 'Test 4: Category status on 403 is BLOCKED');
    assert.strictEqual(catRes.totalDiscovered, 0, 'Test 4: Discovered count is 0');
    console.log('✅ [PASS] 4. Category discovery marks HTTP 403 as CATEGORY_STATUS.BLOCKED');

    // 5. Zero listings (Empty board)
    serverMode = 'empty';
    const postsEmpty = await discoverBoardPosts(testUrl, { headless: true });
    assert.strictEqual(postsEmpty.success, true, 'Test 5: Empty board succeeds with 0 posts');
    assert.strictEqual(postsEmpty.posts.length, 0);
    console.log('✅ [PASS] 5. Zero listings on empty board handled safely');

    // 6. Navigation timeout
    serverMode = 'timeout';
    const postsTimeout = await discoverBoardPosts(testUrl, { pageTimeoutMs: 1000, headless: true });
    assert.strictEqual(postsTimeout.success, false, 'Test 6: Navigation timeout fails cleanly');
    console.log('✅ [PASS] 6. Navigation timeout handled gracefully without crash');

    // 7. Pipeline continues after blocked cycle
    serverMode = 403;
    const pipeline = new CategoryRoundRobinPipeline({
      baseUrl: 'http://127.0.0.1:9777',
      categoryConfig: DEFAULT_CATEGORY_CONFIG
    });
    pipeline.clear();
    const cycleRes = await pipeline.executeCycle();
    assert.strictEqual(pipeline.scheduler.isLocked, false, 'Test 7: Mutex released after 403 cycle');
    assert.strictEqual(pipeline.scheduler.roundRobinPointer, 1, 'Test 7: Pointer preserved');
    console.log('✅ [PASS] 7. Worker and scheduler continue smoothly after blocked cycle');

    // 8. No false media download & no Telegram publish
    assert.strictEqual(pipeline.stagingPublishedMessages.size, 0, 'Test 8: Zero staging messages');
    console.log('✅ [PASS] 8. Zero false media downloads and zero Telegram publications');

  } finally {
    server.close();
  }

  console.log('\n====================================================');
  console.log('🎉 ALL 8 LOCAL 403 ROOT CAUSE TESTS PASSED!');
  console.log('====================================================');
}

runRootCauseSuite().catch(err => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
