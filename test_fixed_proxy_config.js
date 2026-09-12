/**
 * ============================================================
 * 🧪 TEST SUITE: FIXED PROXY CONFIGURATION & PLAYWRIGHT EGRESS
 * ============================================================
 * 
 * Verifies:
 * A. Direct-network behavior when no proxy is configured.
 * B. Launch options injection and safe proxy status exposure.
 * C. Public exit IP verification through fixed proxy (harmless endpoint).
 * D. HTTPS navigation, JS evaluation, and readyState through fixed proxy.
 * E. Multi-session consistency (identical exit IP across browser restarts).
 * F. Credential redaction and privacy preservation.
 * G. Graceful failure handling on unreachable proxy endpoint.
 * 
 * STRICT RULES:
 * - NO target site access
 * - NO Cloudflare bypass
 * - ZERO media downloads
 * - ZERO Telegram publications
 */

const { chromium } = require("playwright");
const {
  getFixedProxyConfig,
  getSafeProxyStatus,
  redactProxyUrl,
  applyProxyToLaunchOptions
} = require("./browser_proxy_config");

const KNOWN_PROXY = {
  server: process.env.FIXED_PROXY_SERVER || "http://104.207.58.0:3129",
  username: process.env.FIXED_PROXY_USERNAME || "proxy_user",
  password: process.env.FIXED_PROXY_PASSWORD || "proxy_pass",
  expectedExitIp: "104.207.58.0"
};

let passedTests = 0;
let totalTests = 0;

function assert(condition, message) {
  totalTests++;
  if (condition) {
    console.log(`  ✅ [PASS] ${message}`);
    passedTests++;
  } else {
    console.error(`  ❌ [FAIL] ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runTests() {
  console.log("====================================================");
  console.log("🧪 RUNNING FIXED PROXY CONFIGURATION TEST SUITE");
  console.log("====================================================\n");

  // ----------------------------------------------------
  // TEST A: No Proxy Configured (Direct Network Mode)
  // ----------------------------------------------------
  console.log("Test A: Direct Network Mode (No Proxy)");
  const emptyEnv = {};
  const noProxyConfig = getFixedProxyConfig(emptyEnv);
  assert(noProxyConfig === undefined, "getFixedProxyConfig returns undefined when env is empty");

  const noProxyStatus = getSafeProxyStatus(emptyEnv);
  assert(noProxyStatus.proxyConfigured === false, "getSafeProxyStatus reports proxyConfigured=false");
  assert(noProxyStatus.proxyServer === null, "getSafeProxyStatus reports proxyServer=null");

  const baseLaunchOpts = { headless: true };
  const appliedNoProxy = applyProxyToLaunchOptions(baseLaunchOpts, emptyEnv);
  assert(appliedNoProxy.proxy === undefined, "applyProxyToLaunchOptions leaves proxy undefined");

  // Test direct browser launch & evaluate
  const directBrowser = await chromium.launch(appliedNoProxy);
  const directPage = await directBrowser.newPage();
  await directPage.setContent("<html><body><span id='val'>direct</span></body></html>");
  const directText = await directPage.$eval("#val", el => el.textContent);
  assert(directText === "direct", "Direct Chromium launches and evaluates DOM cleanly");
  await directBrowser.close();

  // ----------------------------------------------------
  // TEST B: Proxy Configuration Parsing & Status
  // ----------------------------------------------------
  console.log("\nTest B: Proxy Configuration Parsing & Status");
  const testEnv = {
    FIXED_PROXY_SERVER: KNOWN_PROXY.server,
    FIXED_PROXY_USERNAME: KNOWN_PROXY.username,
    FIXED_PROXY_PASSWORD: KNOWN_PROXY.password
  };

  const parsedConfig = getFixedProxyConfig(testEnv);
  assert(parsedConfig !== undefined, "getFixedProxyConfig returns configuration object");
  assert(parsedConfig.server === "http://104.207.58.0:3129", "Parsed server matches expected normalized server URL");
  assert(parsedConfig.username === KNOWN_PROXY.username, "Parsed username matches");
  assert(parsedConfig.password === KNOWN_PROXY.password, "Parsed password matches");

  const safeStatus = getSafeProxyStatus(testEnv);
  assert(safeStatus.proxyConfigured === true, "Safe status reports proxyConfigured=true");
  assert(safeStatus.proxyServer === "http://104.207.58.0:3129", "Safe status reports normalized server URL");
  assert(safeStatus.password === undefined, "Safe status does not expose password property");
  assert(safeStatus.username === undefined, "Safe status does not expose username property");

  // Also test embedded credentials in URL string
  const embeddedEnv = {
    FIXED_PROXY_SERVER: `http://${KNOWN_PROXY.username}:${KNOWN_PROXY.password}@104.207.58.0:3129`
  };
  const embeddedConfig = getFixedProxyConfig(embeddedEnv);
  assert(embeddedConfig.server === "http://104.207.58.0:3129", "Embedded credentials stripped from server URL");
  assert(embeddedConfig.username === KNOWN_PROXY.username, "Embedded username extracted properly");
  assert(embeddedConfig.password === KNOWN_PROXY.password, "Embedded password extracted properly");

/**
 * Safely fetches the public IP from reliable public IP echo services.
 * Robustly parses both JSON and plain-text IP responses.
 */
async function fetchObservedExitIp(page) {
  const endpoints = [
    "https://api.ipify.org?format=json",
    "https://ipinfo.io/ip",
    "https://api.ipify.org",
    "https://checkip.amazonaws.com",
    "https://httpbin.org/ip"
  ];

  let lastError = null;
  for (const url of endpoints) {
    try {
      const response = await page.goto(url, { timeout: 15000, waitUntil: "domcontentloaded" });
      if (!response || !response.ok()) continue;
      const text = await page.textContent("body");
      if (!text) continue;

      try {
        const data = JSON.parse(text);
        const ipFromJson = data.ip || data.origin;
        if (ipFromJson) {
          const match = String(ipFromJson).match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
          if (match) return match[0];
        }
      } catch (e) {
        // Fallback to text parsing
      }

      const match = text.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
      if (match) {
        return match[0];
      }
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error("Failed to retrieve public exit IP from available echo endpoints");
}

  // ----------------------------------------------------
  // TEST C: Public IP Verification through Fixed Proxy
  // ----------------------------------------------------
  console.log("\nTest C: Public IP Verification Through Fixed Proxy");
  const launchOptsProxy = applyProxyToLaunchOptions({ headless: true }, testEnv);
  assert(launchOptsProxy.proxy !== undefined, "Launch options include proxy configuration");

  const proxyBrowser1 = await chromium.launch(launchOptsProxy);
  const page1 = await proxyBrowser1.newPage();
  
  const session1ExitIp = await fetchObservedExitIp(page1);
  
  console.log(`    Session 1 Exit IP: ${session1ExitIp}`);
  assert(session1ExitIp === KNOWN_PROXY.expectedExitIp, `Observed exit IP (${session1ExitIp}) matches configured proxy (${KNOWN_PROXY.expectedExitIp})`);

  // ----------------------------------------------------
  // TEST D: HTTPS Navigation & JavaScript Execution
  // ----------------------------------------------------
  console.log("\nTest D: HTTPS Navigation & JavaScript Execution");
  const respExample = await page1.goto("https://example.com", { timeout: 20000, waitUntil: "domcontentloaded" });
  assert(respExample.status() === 200, "https://example.com returns HTTP 200");
  
  const pageTitle = await page1.title();
  assert(pageTitle === "Example Domain", "Page title is 'Example Domain'");

  const jsResult = await page1.evaluate(() => {
    return {
      sum: 25 + 17,
      readyState: document.readyState
    };
  });
  assert(jsResult.sum === 42, "JavaScript evaluation executes properly");
  assert(jsResult.readyState === "complete", "document.readyState is complete");

  await proxyBrowser1.close();
  assert(true, "Session 1 Chromium instance closed cleanly");

  // ----------------------------------------------------
  // TEST E: Browser Restart Consistency (Session 2)
  // ----------------------------------------------------
  console.log("\nTest E: Browser Restart Consistency (Session 2)");
  const proxyBrowser2 = await chromium.launch(launchOptsProxy);
  const page2 = await proxyBrowser2.newPage();

  const session2ExitIp = await fetchObservedExitIp(page2);

  console.log(`    Session 2 Exit IP: ${session2ExitIp}`);
  assert(session2ExitIp === session1ExitIp, "Session 2 reports identical exit IP as Session 1 (Stable Fixed Egress)");
  assert(session2ExitIp === KNOWN_PROXY.expectedExitIp, "Session 2 matches expected proxy IP");

  await proxyBrowser2.close();
  assert(true, "Session 2 Chromium instance closed cleanly");

  // ----------------------------------------------------
  // TEST F: Credential Safety & Redaction
  // ----------------------------------------------------
  console.log("\nTest F: Credential Safety & Redaction");
  const rawUrlWithAuth = `http://${KNOWN_PROXY.username}:${KNOWN_PROXY.password}@104.207.58.0:3129`;
  const redactedUrl = redactProxyUrl(rawUrlWithAuth);
  
  assert(!redactedUrl.includes(KNOWN_PROXY.password), "Redacted URL does NOT contain raw password");
  assert(redactedUrl.includes("***:***@"), "Redacted URL replaces credentials with ***:***@");

  const safeJson = JSON.stringify(safeStatus);
  assert(!safeJson.includes(KNOWN_PROXY.password), "Serialized safe status does NOT contain raw password");
  assert(!safeJson.includes(KNOWN_PROXY.username), "Serialized safe status does NOT contain raw username");

  // ----------------------------------------------------
  // TEST G: Invalid / Unreachable Proxy Handling
  // ----------------------------------------------------
  console.log("\nTest G: Invalid Proxy Handling");
  const invalidEnv = {
    FIXED_PROXY_SERVER: "http://127.0.0.1:59999" // Non-existent local port
  };
  const invalidLaunchOpts = applyProxyToLaunchOptions({ headless: true }, invalidEnv);
  
  let invalidBrowser = null;
  let navigationErrorCaught = false;

  try {
    invalidBrowser = await chromium.launch(invalidLaunchOpts);
    const invalidPage = await invalidBrowser.newPage();
    await invalidPage.goto("https://api.ipify.org", { timeout: 4000 });
  } catch (err) {
    navigationErrorCaught = true;
    assert(err !== null, "Clean navigation failure recorded on unreachable proxy");
  } finally {
    if (invalidBrowser) {
      await invalidBrowser.close().catch(() => {});
    }
  }
  assert(navigationErrorCaught, "Unreachable proxy triggers handled exception without crash");

  console.log("\n====================================================");
  console.log(`🎉 ALL ${passedTests}/${totalTests} FIXED PROXY TESTS PASSED!`);
  console.log("====================================================");

  return {
    pass: true,
    totalTests,
    passedTests,
    session1ExitIp,
    session2ExitIp,
    expectedExitIp: KNOWN_PROXY.expectedExitIp
  };
}

if (require.main === module) {
  runTests()
    .then(() => process.exit(0))
    .catch(err => {
      console.error("\n❌ Test Suite Failed:", err);
      process.exit(1);
    });
}

module.exports = { runTests };
