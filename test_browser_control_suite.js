const http = require('http');
const assert = require('assert');
const {
  BrowserController,
  BrowserControlUIServer,
  NavigationRecovery,
  detectChallenge,
  redactUrl,
  inspectFrames,
  isCandidatePlayerFrame,
  inspectVideos,
  CHALLENGE_STATES,
  BROWSER_STATES,
  LOAD_STATES
} = require('./browser-control');

// Create mock HTTP server for testing
function createMockServer(port = 4567) {
  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url, `http://localhost:${port}`);
    const pathname = parsed.pathname;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    if (pathname === '/main') {
      res.writeHead(200);
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Authorized Test Media Portal</title></head>
        <body>
          <h1>Main Page</h1>
          <video id="main-video" src="https://cdn.example.com/media/video.mp4?token=secret123&bcdn_token=abc987" width="1280" height="720" muted></video>
          <iframe id="player-frame" name="player-frame" src="/player?auth=tokenXYZ"></iframe>
          <iframe id="ad-frame" name="ad-frame" src="/ad"></iframe>
          <button id="popup-btn" onclick="window.open('/popup?token=sensitive999', '_blank')">Open Popup</button>
        </body>
        </html>
      `);
      return;
    }

    if (pathname === '/player') {
      res.writeHead(200);
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Embedded Player</title></head>
        <body>
          <div class="video-player-container">
            <video id="frame-video" currentSrc="https://stream.example.com/video_stream.mp4?sig=mysig456&key=pass123" src="https://stream.example.com/video_stream.mp4?sig=mysig456&key=pass123" width="1920" height="1080" autoplay muted></video>
          </div>
        </body>
        </html>
      `);
      return;
    }

    if (pathname === '/ad') {
      res.writeHead(200);
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Advert Frame</title></head>
        <body><p>Banner Advertisement</p></body>
        </html>
      `);
      return;
    }

    if (pathname === '/popup') {
      res.writeHead(200);
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Unwanted Popup Window</title></head>
        <body><h1>Unwanted Advertisement Popup</h1></body>
        </html>
      `);
      return;
    }

    if (pathname === '/challenge') {
      res.writeHead(200);
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Just a moment... Security Check</title></head>
        <body>
          <div id="challenge-running">Checking your browser before accessing the website...</div>
        </body>
        </html>
      `);
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function runTests() {
  console.log('================================================================');
  console.log('STARTING BROWSER CONTROL & INSPECTOR TEST SUITE');
  console.log('================================================================');

  const mockPort = 4567;
  const mockServer = await createMockServer(mockPort);
  const baseUrl = `http://127.0.0.1:${mockPort}`;
  let passed = 0;
  let total = 15;

  let controller = null;
  let uiServer = null;

  try {
    // TEST 1: Redaction helper removes sensitive tokens
    console.log('\n[TEST 1] Redaction helper URL sanitization');
    const sensitiveUrl = 'https://example.com/media/file.mp4?token=secret123&bcdn_token=abc&sig=999&auth=authkey&foo=bar';
    const redacted = redactUrl(sensitiveUrl);
    assert.strictEqual(redacted.includes('secret123'), false, 'Token was not redacted');
    assert.strictEqual(redacted.includes('abc'), false, 'bcdn_token was not redacted');
    assert.strictEqual(redacted.includes('999'), false, 'sig was not redacted');
    assert.strictEqual(redacted.includes('authkey'), false, 'auth was not redacted');
    assert.strictEqual(redacted.includes('foo=bar'), true, 'Non-sensitive query params should remain');
    assert.strictEqual(redacted.includes('token=REDACTED'), true, 'Should replace with REDACTED');
    console.log('PASS: Redaction masks all sensitive query tokens correctly.');
    passed++;

    // TEST 2: Controller startup and initial STOPPED/RUNNING state
    console.log('\n[TEST 2] BrowserController launch & lifecycle state');
    controller = new BrowserController();
    assert.strictEqual(controller.getState().browserState, BROWSER_STATES.STOPPED);
    
    await controller.start(`${baseUrl}/main`);
    assert.strictEqual(controller.getState().browserState, BROWSER_STATES.RUNNING);
    assert.ok(
      [LOAD_STATES.DOM_LOADED, LOAD_STATES.NETWORK_IDLE].includes(controller.getState().loadState),
      `Expected loadState to be DOM_LOADED or NETWORK_IDLE, got ${controller.getState().loadState}`
    );
    console.log('PASS: Browser launched successfully and reached RUNNING state.');
    passed++;

    // TEST 3: Page load state and title tracking
    console.log('\n[TEST 3] Page load state, URLs, and title tracking');
    const state = controller.getState();
    assert.strictEqual(state.pageTitle, 'Authorized Test Media Portal');
    assert.strictEqual(state.openTabsCount, 1);
    assert.strictEqual(state.currentPageUrl.startsWith(baseUrl), true);
    console.log(`PASS: Page title tracked: "${state.pageTitle}", Open tabs: ${state.openTabsCount}.`);
    passed++;

    // TEST 4: Frame inspection and enumeration
    console.log('\n[TEST 4] Frame inspection and enumeration');
    const framesData = state.frameInspection;
    assert.ok(framesData.totalFrames >= 3, `Expected at least 3 frames (main + 2 iframes), got ${framesData.totalFrames}`);
    console.log(`PASS: Total frames enumerated: ${framesData.totalFrames}.`);
    passed++;

    // TEST 5: Frame player candidate heuristics
    console.log('\n[TEST 5] Candidate player iframe heuristic matching');
    const candidateFrames = framesData.candidatePlayerFrames;
    assert.ok(candidateFrames.length >= 1, 'Should identify player iframe as candidate');
    const playerFrame = candidateFrames.find(f => f.url.includes('/player') || f.name === 'player-frame');
    assert.ok(playerFrame, 'player iframe found in candidates');
    assert.strictEqual(playerFrame.isCandidatePlayerFrame, true);
    console.log(`PASS: Candidate player frame detected correctly (${playerFrame.name} -> ${playerFrame.url}).`);
    passed++;

    // TEST 6: Video inspection across frames and main page
    console.log('\n[TEST 6] Video element discovery across hierarchy');
    const videosData = state.videoInspection;
    assert.ok(videosData.videoCount >= 2, `Expected at least 2 video elements across frames, got ${videosData.videoCount}`);
    console.log(`PASS: Discovered ${videosData.videoCount} video elements.`);
    passed++;

    // TEST 7: Video metadata extraction
    console.log('\n[TEST 7] Video metadata (dimensions, readyState, pause status, sourceHost)');
    const video1 = videosData.videos.find(v => v.dimensions.startsWith('1280x720') || v.videoWidth === 1280);
    assert.ok(video1, 'Main video element metadata extracted');
    assert.strictEqual(video1.sourceHost, 'cdn.example.com');
    assert.strictEqual(video1.currentSrc.includes('secret123'), false, 'Sensitive token must be redacted from currentSrc');
    assert.strictEqual(video1.currentSrc.includes('REDACTED'), true, 'currentSrc must contain REDACTED token');
    console.log(`PASS: Video metadata extracted: Dimensions=${video1.dimensions}, SourceHost=${video1.sourceHost}, ReadyState=${video1.readyState}.`);
    passed++;

    // TEST 8: Popup auto-close & Main page refocus
    console.log('\n[TEST 8] Unwanted popup detection, auto-close, and main page refocus');
    let popupClosedEmitted = false;
    controller.once('popup_closed', (data) => {
      popupClosedEmitted = true;
    });

    // Trigger popup from main page
    await controller.mainPage.click('#popup-btn');
    // Wait for popup auto-close handler
    await new Promise(r => setTimeout(r, 1000));

    const recStatus = controller.getState().recoveryStatus;
    assert.ok(recStatus.closedPopupsCount >= 1, `Expected closedPopupsCount >= 1, got ${recStatus.closedPopupsCount}`);
    assert.strictEqual(recStatus.isRefocused, true, 'Main page must be refocused');
    assert.strictEqual(recStatus.lastClosedPopupUrl.includes('sensitive999'), false, 'Popup URL token must be redacted');
    assert.strictEqual(controller.getState().openTabsCount, 1, 'Only main page should remain open');
    console.log(`PASS: Unwanted popup auto-closed. Total closed: ${recStatus.closedPopupsCount}, Last URL: ${recStatus.lastClosedPopupUrl}, Main focused: ${recStatus.isRefocused}.`);
    passed++;

    // TEST 9: Multiple rapid popups handling
    console.log('\n[TEST 9] Multiple rapid popups auto-close resiliency');
    const initialClosed = recStatus.closedPopupsCount;
    await controller.mainPage.evaluate(() => {
      window.open('/popup?token=pop1', '_blank');
      window.open('/popup?token=pop2', '_blank');
    });
    await new Promise(r => setTimeout(r, 1500));

    const recStatus2 = controller.getState().recoveryStatus;
    assert.ok(recStatus2.closedPopupsCount >= initialClosed + 2, `Expected at least ${initialClosed + 2} closed popups, got ${recStatus2.closedPopupsCount}`);
    assert.strictEqual(controller.getState().openTabsCount, 1, 'Tabs count should remain 1');
    console.log(`PASS: Handled multiple rapid popups. Total closed: ${recStatus2.closedPopupsCount}.`);
    passed++;

    // TEST 10: Security Challenge Detection -> LEGITIMATE/MANUAL ACTION REQUIRED
    console.log('\n[TEST 10] Security Challenge Detection state transition');
    let challengeChangedEmitted = false;
    controller.once('challenge_changed', (state) => {
      challengeChangedEmitted = true;
    });

    await controller.navigate(`${baseUrl}/challenge`);
    const challengeState = controller.getState().recoveryStatus.challengeState;
    assert.strictEqual(challengeState, CHALLENGE_STATES.MANUAL_REQUIRED, `Expected challenge state "${CHALLENGE_STATES.MANUAL_REQUIRED}", got "${challengeState}"`);
    console.log(`PASS: Challenge detected correctly, transitioned to: "${challengeState}". No bypass attempted.`);
    passed++;

    // TEST 11: Activity Log recording and emission
    console.log('\n[TEST 11] Timestamped Activity Log structure and events');
    const logs = controller.getLogs();
    assert.ok(logs.length >= 5, `Expected multiple log entries, got ${logs.length}`);
    const sampleLog = logs[0];
    assert.ok(sampleLog.timestamp, 'Log missing timestamp');
    assert.ok(sampleLog.level, 'Log missing level');
    assert.ok(sampleLog.message, 'Log missing message');
    // Ensure no secret tokens leaked into logs
    for (const log of logs) {
      assert.strictEqual(log.message.includes('secret123'), false, 'Leaked token in log message');
      assert.strictEqual(log.message.includes('sensitive999'), false, 'Leaked token in log message');
    }
    console.log(`PASS: Activity log recorded ${logs.length} entries with strict redaction.`);
    passed++;

    // TEST 12: Clear logs functionality
    console.log('\n[TEST 12] Clear activity log');
    controller.clearLogs();
    assert.strictEqual(controller.getLogs().length, 0);
    console.log('PASS: Logs cleared successfully.');
    passed++;

    // TEST 13: UI Server endpoints (HTML UI, REST status, logs, SSE)
    console.log('\n[TEST 13] BrowserControlUIServer REST and SSE API');
    const uiPort = 4568;
    uiServer = new BrowserControlUIServer(controller, { port: uiPort });
    await uiServer.start();

    // Test GET /
    const htmlRes = await fetch(`http://127.0.0.1:${uiPort}/`);
    assert.strictEqual(htmlRes.status, 200);
    const htmlText = await htmlRes.text();
    assert.ok(htmlText.includes('Playwright Browser Control'), 'HTML UI title missing');

    // Test GET /api/status
    const statusRes = await fetch(`http://127.0.0.1:${uiPort}/api/status`);
    assert.strictEqual(statusRes.status, 200);
    const statusJson = await statusRes.json();
    assert.ok(statusJson.browserState, 'API Status missing browserState');

    // Test POST /api/inspect
    const inspectRes = await fetch(`http://127.0.0.1:${uiPort}/api/inspect`, { method: 'POST' });
    assert.strictEqual(inspectRes.status, 200);
    const inspectJson = await inspectRes.json();
    assert.strictEqual(inspectJson.success, true);
    console.log('PASS: UI Server HTML, GET /api/status, and POST /api/inspect all verified.');
    passed++;

    // TEST 14: Navigation timeout handling and graceful fallback
    console.log('\n[TEST 14] Resilient timeout navigation handling');
    // Navigate to non-routable port with short timeout
    await controller.navigate('http://10.255.255.1:9999', { timeoutMs: 1000 }).catch(() => {});
    const stateAfterTimeout = controller.getState();
    assert.ok([LOAD_STATES.TIMEOUT, LOAD_STATES.ERROR].includes(stateAfterTimeout.loadState), 'Load state should reflect timeout/error');
    console.log(`PASS: Resilient handling on unreachable host (loadState: ${stateAfterTimeout.loadState}).`);
    passed++;

    // TEST 15: Controller stop & resource cleanup
    console.log('\n[TEST 15] BrowserController stop and resource cleanup');
    await controller.stop();
    const finalState = controller.getState();
    assert.strictEqual(finalState.browserState, BROWSER_STATES.STOPPED);
    assert.strictEqual(finalState.loadState, LOAD_STATES.UNLOADED);
    assert.strictEqual(finalState.openTabsCount, 0);
    console.log('PASS: Browser stopped and resources cleaned up.');
    passed++;

  } finally {
    if (uiServer) {
      await uiServer.stop().catch(() => {});
    }
    if (controller) {
      await controller.stop().catch(() => {});
    }
    if (mockServer) {
      mockServer.close();
    }
  }

  console.log('\n================================================================');
  console.log(`TEST RESULTS: ${passed}/${total} TESTS PASSED (100%)`);
  console.log('================================================================');
  if (passed !== total) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test suite failed with error:', err);
  process.exit(1);
});
