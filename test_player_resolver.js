/**
 * ============================================================
 * 🧪 TEST SUITE: AVSEE PLAYER RESOLVER (STAGE 1)
 * ============================================================
 * Validates the isolated player resolver module against authorized,
 * non-explicit test sources and local controlled mock fixtures.
 * 
 * Safety:
 * - Uses only authorized test fixtures / env-supplied authorized URLs.
 * - No explicit media downloaded or processed.
 * - Redacts sensitive tokens.
 * - Hard timeouts on all assertions.
 */

const http = require("http");
const { resolvePlayer, redactUrl, detectChallenge, RESOLVER_STATES } = require("./avsee/player_resolver");

let passCount = 0;
let failCount = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ PASS: ${message}`);
    passCount++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failCount++;
  }
}

/**
 * Creates an authorized local HTTP test server serving a parent page
 * with an iframe embedding a mock HTML5 video player.
 */
function createLocalPlayerTestServer(port = 9245) {
  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url, `http://127.0.0.1:${port}`);

    // Main post page with iframe
    if (parsed.pathname === "/test_post") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Authorized Test Post</title></head>
        <body>
          <div class="view-wrap">
            <h1>Authorized Video Test Post</h1>
            <div id="view_content">
              <iframe id="player_iframe" src="/player.php?id=test_1001&bcdn_token=SECRET_AUTH_TOKEN_XYZ" width="720" height="1280" allowfullscreen></iframe>
            </div>
          </div>
        </body>
        </html>
      `);
      return;
    }

    // Player iframe
    if (parsed.pathname === "/player.php") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Player</title></head>
        <body style="margin:0;background:#000;">
          <video id="html5_player" width="720" height="1280" controls autoplay src="/stream/video.mp4?bcdn_token=SECRET_AUTH_TOKEN_XYZ&expires=1799999999">
          </video>
          <script>
            const v = document.getElementById('html5_player');
            // Mock HTML5 video duration and dimensions for headless chromium
            Object.defineProperty(v, 'duration', { value: 1800, writable: false });
            Object.defineProperty(v, 'videoWidth', { value: 720, writable: false });
            Object.defineProperty(v, 'videoHeight', { value: 1280, writable: false });
            Object.defineProperty(v, 'readyState', { value: 4, writable: false });
          </script>
        </body>
        </html>
      `);
      return;
    }

    // Page with missing video element
    if (parsed.pathname === "/no_video_player") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`
        <!DOCTYPE html>
        <html><body><iframe src="/empty_iframe"></iframe></body></html>
      `);
      return;
    }

    if (parsed.pathname === "/empty_iframe") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><html><body><p>No video player here</p></body></html>`);
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve(server);
    });
  });
}

async function runTests() {
  console.log("============================================================");
  console.log("🧪 STARTING STAGE 1 AVSEE PLAYER RESOLVER TESTS");
  console.log("============================================================");

  // Test 1: URL Redaction utility
  console.log("\n--- Test 1: URL Token Redaction ---");
  const testUrl = "https://data.cdn.avsee.is/media/v.mp4?bcdn_token=secret123&expires=1799999999&token_path=%2Fmedia";
  const redacted = redactUrl(testUrl);
  assert(!redacted.includes("secret123"), "Sensitive bcdn_token is redacted");
  assert(redacted.includes("REDACTED"), "Redacted placeholder present in URL");

  // Start local server
  const server = await createLocalPlayerTestServer(9245);
  const localPostUrl = "http://127.0.0.1:9245/test_post";

  const targetUrl = process.env.AUTHORIZED_TEST_POST_URL || process.env.TEST_POST_URL || localPostUrl;
  console.log(`\n--- Test 2: Resolve Authorized Player (${redactUrl(targetUrl)}) ---`);

  let resolutionResult = null;
  try {
    resolutionResult = await resolvePlayer(targetUrl, {
      headless: true,
      pageTimeoutMs: 15000,
      playerTimeoutMs: 10000,
      logDiagnostics: true
    });

    console.log("\nResolution Output:", JSON.stringify({
      ...resolutionResult,
      mediaUrl: redactUrl(resolutionResult.mediaUrl)
    }, null, 2));

    assert(resolutionResult.success === true, "Resolver returns success: true");
    assert(resolutionResult.state === RESOLVER_STATES.SUCCESS, "State is SUCCESS");
    assert(Boolean(resolutionResult.playerFrameUrl), "Player frame URL is resolved");
    assert(Boolean(resolutionResult.mediaUrl), "Media stream URL is resolved");
    assert(resolutionResult.duration === 1800, `Duration matches expected: ${resolutionResult.duration}s`);
    assert(resolutionResult.width === 720, `Width is 720: ${resolutionResult.width}`);
    assert(resolutionResult.height === 1280, `Height is 1280: ${resolutionResult.height}`);
    assert(resolutionResult.readyState === 4, `ReadyState is 4 (HAVE_ENOUGH_DATA): ${resolutionResult.readyState}`);

  } catch (err) {
    console.error(`Resolution error: ${err.message}`);
    assert(false, `Resolution threw unexpected error: ${err.message}`);
  }

  // Test 3: Missing player frame error handling
  console.log("\n--- Test 3: Missing Video Error State ---");
  const noVideoResult = await resolvePlayer("http://127.0.0.1:9245/no_video_player", {
    headless: true,
    pageTimeoutMs: 10000,
    playerTimeoutMs: 3000,
    logDiagnostics: false
  });
  assert(noVideoResult.success === false, "Missing video returns success: false");
  assert(
    noVideoResult.state === RESOLVER_STATES.VIDEO_ELEMENT_NOT_FOUND ||
    noVideoResult.state === RESOLVER_STATES.PLAYER_FRAME_NOT_FOUND,
    `Error state accurately reported (${noVideoResult.state})`
  );

  // Test 4: Navigation failure error handling
  console.log("\n--- Test 4: Navigation Failure Error State ---");
  const navFailResult = await resolvePlayer("http://127.0.0.1:9999/unreachable_page", {
    headless: true,
    pageTimeoutMs: 3000,
    playerTimeoutMs: 2000,
    logDiagnostics: false
  });
  assert(navFailResult.success === false, "Unreachable page returns success: false");
  assert(navFailResult.state === RESOLVER_STATES.PAGE_LOAD_FAILED, "State is PAGE_LOAD_FAILED");

  // Clean up server
  await new Promise((resolve) => server.close(resolve));

  console.log("\n============================================================");
  console.log("📊 REQUIRED DIAGNOSTIC OUTPUT");
  console.log("============================================================");
  const isPass = failCount === 0 && resolutionResult && resolutionResult.success;

  console.log(`PLAYER_RESOLVER_RESULT=${isPass ? "PASS" : "FAIL"}`);
  console.log(`PLAYER_FRAME_FOUND=${Boolean(resolutionResult && resolutionResult.playerFrameUrl)}`);
  console.log(`VIDEO_FOUND=${Boolean(resolutionResult && resolutionResult.mediaUrl)}`);
  console.log(`READY_STATE=${resolutionResult ? resolutionResult.readyState : "null"}`);
  console.log(`DURATION_SECONDS=${resolutionResult ? resolutionResult.duration : "null"}`);
  console.log(`VIDEO_WIDTH=${resolutionResult ? resolutionResult.width : "null"}`);
  console.log(`VIDEO_HEIGHT=${resolutionResult ? resolutionResult.height : "null"}`);
  console.log(`MEDIA_SOURCE_FOUND=${Boolean(resolutionResult && resolutionResult.mediaUrl)}`);
  console.log("============================================================");
  console.log(`Total tests: ${passCount + failCount}, Passed: ${passCount}, Failed: ${failCount}`);

  if (failCount > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Fatal test runner error:", err);
  process.exit(1);
});
