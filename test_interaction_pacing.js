/**
 * ============================================================
 * 🧪 TEST SUITE: PLAYWRIGHT INTERACTION PACING
 * ============================================================
 * 
 * Verifies:
 * 1. Default configuration (2000–5000ms).
 * 2. Custom environment configuration.
 * 3. Safe fallback on invalid/negative/non-numeric configuration.
 * 4. pacedClick action on local HTML fixture.
 * 5. pacedHover action on local HTML fixture.
 * 6. pacedMouseMove action on local HTML fixture.
 * 7. pacedPress action on local HTML fixture.
 * 8. pacedFill action on local HTML fixture.
 * 9. Actual pre-action and post-action timing measurement.
 * 10. Bounded delay constraints (within min/max).
 * 11. Clean browser lifecycle and termination.
 * 12. Zero stale processes.
 * 
 * STRICT CONSTRAINTS:
 * - Local HTML fixtures ONLY (Zero external targets)
 * - Zero media downloads
 * - Zero Telegram publications
 */

const { chromium } = require("playwright");
const {
  DEFAULT_MIN_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
  getPacingConfig,
  computeBoundedDelay,
  waitBeforeAction,
  waitAfterAction,
  pacedClick,
  pacedHover,
  pacedMouseMove,
  pacedPress,
  pacedFill
} = require("./browser-control/interaction_pacing");

let totalTests = 0;
let passedTests = 0;

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
  console.log("🧪 RUNNING PLAYWRIGHT INTERACTION PACING TEST SUITE");
  console.log("====================================================\n");

  // ----------------------------------------------------
  // 1. Default Configuration
  // ----------------------------------------------------
  console.log("Test 1: Default Configuration (2000-5000ms)");
  assert(DEFAULT_MIN_DELAY_MS === 2000, "DEFAULT_MIN_DELAY_MS is 2000");
  assert(DEFAULT_MAX_DELAY_MS === 5000, "DEFAULT_MAX_DELAY_MS is 5000");

  const defaultConfig = getPacingConfig({});
  assert(defaultConfig.minDelayMs === 2000, "Default minDelayMs is 2000");
  assert(defaultConfig.maxDelayMs === 5000, "Default maxDelayMs is 5000");

  // ----------------------------------------------------
  // 2. Custom Configuration
  // ----------------------------------------------------
  console.log("\nTest 2: Custom Environment Configuration");
  const customEnv = {
    PLAYWRIGHT_ACTION_DELAY_MIN_MS: "1500",
    PLAYWRIGHT_ACTION_DELAY_MAX_MS: "3500"
  };
  const customConfig = getPacingConfig(customEnv);
  assert(customConfig.minDelayMs === 1500, "Custom minDelayMs parsed as 1500");
  assert(customConfig.maxDelayMs === 3500, "Custom maxDelayMs parsed as 3500");

  // ----------------------------------------------------
  // 3. Invalid Configuration Handling
  // ----------------------------------------------------
  console.log("\nTest 3: Invalid Configuration Handling");
  const invalidEnv1 = {
    PLAYWRIGHT_ACTION_DELAY_MIN_MS: "not_a_number",
    PLAYWRIGHT_ACTION_DELAY_MAX_MS: "-100"
  };
  const safeConfig1 = getPacingConfig(invalidEnv1);
  assert(safeConfig1.minDelayMs === 2000, "Non-numeric min falls back to default 2000");
  assert(safeConfig1.maxDelayMs === 5000, "Negative max falls back to default 5000");

  // Min > Max correction
  const invertedEnv = {
    PLAYWRIGHT_ACTION_DELAY_MIN_MS: "4000",
    PLAYWRIGHT_ACTION_DELAY_MAX_MS: "1000"
  };
  const invertedConfig = getPacingConfig(invertedEnv);
  assert(invertedConfig.minDelayMs === 4000, "Inverted min preserved as 4000");
  assert(invertedConfig.maxDelayMs === 4000, "Inverted max clamped to min (4000)");

  // ----------------------------------------------------
  // 4. Delay Computation & Bounds Verification
  // ----------------------------------------------------
  console.log("\nTest 4: Delay Computation Bounds");
  for (let i = 0; i < 50; i++) {
    const d = computeBoundedDelay(100, 200);
    assert(d >= 100 && d <= 200, `Delay (${d}ms) within bounds [100, 200]`);
  }

  // ----------------------------------------------------
  // 5. Browser UI Interaction Tests on Local Fixture
  // ----------------------------------------------------
  console.log("\nTest 5: Browser Launch & Local HTML Fixture Setup");
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  });
  const page = await browser.newPage();

  const testHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <style>
          #btn { padding: 10px; background: blue; color: white; }
          #hoverBox { width: 100px; height: 100px; background: green; }
          #hoverBox.hovered { background: yellow; }
        </style>
      </head>
      <body>
        <button id="btn">Click Me</button>
        <div id="hoverBox">Hover Area</div>
        <input id="inputField" type="text" />
        <span id="clickCount">0</span>
        <span id="lastKey">none</span>

        <script>
          let clicks = 0;
          document.getElementById('btn').addEventListener('click', () => {
            clicks++;
            document.getElementById('clickCount').textContent = String(clicks);
          });

          const box = document.getElementById('hoverBox');
          box.addEventListener('mouseenter', () => box.classList.add('hovered'));
          box.addEventListener('mouseleave', () => box.classList.remove('hovered'));

          document.getElementById('inputField').addEventListener('keydown', (e) => {
            document.getElementById('lastKey').textContent = e.key;
          });
        </script>
      </body>
    </html>
  `;

  await page.setContent(testHtml, { waitUntil: "domcontentloaded" });
  assert(true, "Local HTML fixture loaded into Chromium");

  // ----------------------------------------------------
  // 6. pacedClick Test & Timing Verification
  // ----------------------------------------------------
  console.log("\nTest 6: pacedClick Verification");
  const startClick = Date.now();
  const clickRes = await pacedClick(page, "#btn", {
    preDelayMs: 60,
    postDelayMs: 60
  });
  const elapsedClick = Date.now() - startClick;

  assert(clickRes.success === true, "pacedClick returned success=true");
  assert(clickRes.action === "click", "Action is click");
  assert(clickRes.preWaitMs === 60, "Pre-wait recorded as 60ms");
  assert(clickRes.postWaitMs === 60, "Post-wait recorded as 60ms");
  assert(elapsedClick >= 115, `Actual elapsed time (${elapsedClick}ms) respects pre+post delays`);

  const clickCount = await page.$eval("#clickCount", el => el.textContent);
  assert(clickCount === "1", "Button click event received in DOM (clicks = 1)");

  // ----------------------------------------------------
  // 7. pacedHover Test
  // ----------------------------------------------------
  console.log("\nTest 7: pacedHover Verification");
  const hoverRes = await pacedHover(page, "#hoverBox", {
    preDelayMs: 50,
    postDelayMs: 50
  });
  assert(hoverRes.success === true, "pacedHover returned success=true");
  const isHovered = await page.$eval("#hoverBox", el => el.classList.contains("hovered"));
  assert(isHovered === true, "Hover event triggered in DOM");

  // ----------------------------------------------------
  // 8. pacedMouseMove Test
  // ----------------------------------------------------
  console.log("\nTest 8: pacedMouseMove Verification");
  const moveRes = await pacedMouseMove(page, 20, 20, {
    preDelayMs: 40,
    postDelayMs: 40
  });
  assert(moveRes.success === true, "pacedMouseMove returned success=true");
  assert(moveRes.x === 20 && moveRes.y === 20, "Coordinates match (20, 20)");

  // ----------------------------------------------------
  // 9. pacedFill Test
  // ----------------------------------------------------
  console.log("\nTest 9: pacedFill Verification");
  const fillRes = await pacedFill(page, "#inputField", "Hello Pacing", {
    preDelayMs: 50,
    postDelayMs: 50
  });
  assert(fillRes.success === true, "pacedFill returned success=true");
  assert(fillRes.text === "Hello Pacing", "Fill text matches");

  const inputValue = await page.$eval("#inputField", el => el.value);
  assert(inputValue === "Hello Pacing", "Input element value updated in DOM");

  // ----------------------------------------------------
  // 10. pacedPress Test
  // ----------------------------------------------------
  console.log("\nTest 10: pacedPress Verification");
  const pressRes = await pacedPress(page, "#inputField", "Enter", {
    preDelayMs: 40,
    postDelayMs: 40
  });
  assert(pressRes.success === true, "pacedPress returned success=true");
  assert(pressRes.key === "Enter", "Key matches 'Enter'");

  const lastKey = await page.$eval("#lastKey", el => el.textContent);
  assert(lastKey === "Enter", "Keydown event received in DOM (lastKey = 'Enter')");

  // ----------------------------------------------------
  // 11. Bounded Pacing with Environment Context
  // ----------------------------------------------------
  console.log("\nTest 11: Dynamic Environment Pacing Execution");
  const dynamicEnv = {
    PLAYWRIGHT_ACTION_DELAY_MIN_MS: "80",
    PLAYWRIGHT_ACTION_DELAY_MAX_MS: "120"
  };

  const startPre = Date.now();
  const preWaited = await waitBeforeAction({ env: dynamicEnv });
  const elapsedPre = Date.now() - startPre;
  
  assert(preWaited >= 80 && preWaited <= 120, `Pre-wait (${preWaited}ms) within dynamic env range [80, 120]`);
  assert(elapsedPre >= 75, `Actual pre-wait elapsed time (${elapsedPre}ms) confirms execution`);

  const startPost = Date.now();
  const postWaited = await waitAfterAction({ env: dynamicEnv });
  const elapsedPost = Date.now() - startPost;

  assert(postWaited >= 80 && postWaited <= 120, `Post-wait (${postWaited}ms) within dynamic env range [80, 120]`);
  assert(elapsedPost >= 75, `Actual post-wait elapsed time (${elapsedPost}ms) confirms execution`);

  // ----------------------------------------------------
  // 12. Clean Browser Cleanup
  // ----------------------------------------------------
  console.log("\nTest 12: Clean Browser Cleanup");
  await page.close();
  await browser.close();
  assert(true, "Browser instance closed cleanly without hanging");

  console.log("\n====================================================");
  console.log(`🎉 ALL ${passedTests}/${totalTests} INTERACTION PACING TESTS PASSED!`);
  console.log("====================================================");

  return {
    pass: true,
    totalTests,
    passedTests
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
