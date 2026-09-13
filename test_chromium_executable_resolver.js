/**
 * ============================================================
 * 🧪 OFFLINE TEST: SHARED CHROMIUM RESOLVER & BROWSER LIFECYCLE
 * ============================================================
 * No real browser is launched and no network is used:
 * - Env executable paths are only used when the file exists.
 * - Missing env path -> undefined (Playwright bundled Chromium).
 * - Custom executable launch failure -> one retry with bundled Chromium.
 * - Required --no-sandbox / --disable-dev-shm-usage flags + headless default.
 * - checkBrowserLaunch() closes the browser when newPage() throws (L8).
 * - fetchItemDetails() uses ONE browser and lends it to resolvePlayer (M11).
 * - resolvePlayer() closes the context it creates on a borrowed browser.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.NEXAHUB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nexahub-chromium-test-"));
for (const name of ["PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH", "CHROME_BIN", "CHROMIUM_PATH"]) {
  delete process.env[name];
}

const {
  resolveChromiumExecutablePath,
  withRequiredChromiumArgs,
  launchWithExecutableFallback,
  BUNDLED_EXECUTABLE_LABEL
} = require("./avsee/chromium_executable");

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ [PASS] ${name}`);
  } catch (err) {
    failed++;
    console.error(`❌ [FAIL] ${name} - ${err.message}`);
  }
}

function makeFakeBrowser(label = "browser") {
  const events = [];
  const browser = {
    label,
    events,
    closed: false,
    on() {},
    async close() { browser.closed = true; events.push("browser.close"); }
  };
  return browser;
}

async function run() {
  console.log("==================================================");
  console.log("🚀 RUNNING CHROMIUM RESOLVER & BROWSER LIFECYCLE TESTS (OFFLINE)");
  console.log("==================================================\n");

  await check("1. No env paths -> undefined (Playwright bundled browser)", () => {
    assert.strictEqual(resolveChromiumExecutablePath({}), undefined);
  });

  await check("2. Env path that does not exist is ignored", () => {
    const res = resolveChromiumExecutablePath(
      { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: "/root/.nix-profile/bin/chromium" },
      { existsSync: () => false }
    );
    assert.strictEqual(res, undefined);
  });

  await check("3. Falls through a missing env path to an existing one (CHROME_BIN)", () => {
    const res = resolveChromiumExecutablePath(
      { PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: "/missing/chromium", CHROME_BIN: "/usr/bin/google-chrome" },
      { existsSync: (p) => p === "/usr/bin/google-chrome" }
    );
    assert.strictEqual(res, "/usr/bin/google-chrome");
  });

  await check("4. Real existing file on disk is accepted", () => {
    const res = resolveChromiumExecutablePath({ CHROMIUM_PATH: process.execPath });
    assert.strictEqual(res, process.execPath);
  });

  await check("5. Required VPS flags are added exactly once", () => {
    const args = withRequiredChromiumArgs(["--disable-gpu", "--no-sandbox"]);
    assert.strictEqual(args.filter(a => a === "--no-sandbox").length, 1);
    assert.strictEqual(args.filter(a => a === "--disable-dev-shm-usage").length, 1);
    assert.ok(args.includes("--disable-gpu"));
  });

  await check("6. Custom executable launch failure retries ONCE with bundled Chromium", async () => {
    const calls = [];
    const launchFn = async (opts) => {
      calls.push(opts);
      if (opts.executablePath) throw new Error("spawn EACCES");
      return makeFakeBrowser("bundled");
    };
    const res = await launchWithExecutableFallback(launchFn, { args: ["--disable-gpu"] }, { executablePath: "/snap/bin/chromium" });
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].executablePath, "/snap/bin/chromium");
    assert.ok(!("executablePath" in calls[1]), "bundled retry must not pass executablePath");
    assert.strictEqual(res.executablePath, BUNDLED_EXECUTABLE_LABEL);
    assert.strictEqual(res.browser.label, "bundled");
    for (const opts of calls) {
      assert.strictEqual(opts.headless, true);
      assert.ok(opts.args.includes("--no-sandbox") && opts.args.includes("--disable-dev-shm-usage"));
    }
  });

  await check("7. Working custom executable is launched once", async () => {
    const calls = [];
    const res = await launchWithExecutableFallback(async (opts) => { calls.push(opts); return makeFakeBrowser(); }, {}, { executablePath: "/usr/bin/chromium" });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(res.executablePath, "/usr/bin/chromium");
  });

  await check("8. No custom path -> single bundled launch without executablePath", async () => {
    const calls = [];
    const res = await launchWithExecutableFallback(async (opts) => { calls.push(opts); return makeFakeBrowser(); }, { executablePath: "/ignored" });
    assert.strictEqual(calls.length, 1);
    assert.ok(!("executablePath" in calls[0]));
    assert.strictEqual(res.executablePath, BUNDLED_EXECUTABLE_LABEL);
  });

  await check("9. Bundled launch failure propagates (no infinite retry)", async () => {
    let count = 0;
    await assert.rejects(
      launchWithExecutableFallback(async () => { count++; throw new Error("boom"); }, {}, { executablePath: "/custom" }),
      /boom/
    );
    assert.strictEqual(count, 2);
  });

  const { AvseeSourceAdapter } = require("./avsee_source_adapter");

  await check("10. checkBrowserLaunch() closes the browser when newPage() throws (L8)", async () => {
    const adapter = new AvseeSourceAdapter({
      isAuthorized: true,
      licenseId: "LIC-TEST",
      ledgerPath: path.join(process.env.NEXAHUB_DATA_DIR, "ledger_10.json")
    });
    const browser = makeFakeBrowser();
    browser.newPage = async () => { throw new Error("Target closed"); };
    adapter.launchBrowser = async () => { adapter.activeBrowsers.add(browser); return browser; };
    const res = await adapter.checkBrowserLaunch();
    assert.strictEqual(res.pass, false);
    assert.strictEqual(browser.closed, true, "browser must be closed");
    assert.strictEqual(adapter.activeBrowsers.size, 0);
  });

  await check("11. resolvePlayer() closes the context it created on a borrowed browser", async () => {
    const { resolvePlayer } = require("./avsee/player_resolver");
    const browser = makeFakeBrowser();
    let contextClosed = false;
    browser.newContext = async () => ({
      async newPage() {
        return { async goto() { throw new Error("net::ERR_CONNECTION_REFUSED"); }, isClosed: () => false };
      },
      async close() { contextClosed = true; }
    });
    const res = await resolvePlayer("http://127.0.0.1:1/post", { browser, logDiagnostics: false });
    assert.strictEqual(res.success, false);
    assert.strictEqual(contextClosed, true, "borrowed-browser context must be closed");
    assert.strictEqual(browser.closed, false, "borrowed browser must NOT be closed by resolvePlayer");
  });

  await check("12. fetchItemDetails() launches one browser and lends it to resolvePlayer (M11)", async () => {
    const order = [];
    const browser = makeFakeBrowser();
    browser.newContext = async () => ({
      async newPage() {
        return {
          on() {},
          async route() {},
          async goto() { return { status: () => 200 }; },
          isClosed: () => false,
          async title() { return "post"; },
          frames: () => [],
          async evaluate(fn) {
            if (String(fn).includes("iframes")) {
              return { title: "Test Post", description: "", category: "", date: "", tags: [], thumbnailUrl: null, iframes: [], videoSrc: null };
            }
            return true;
          }
        };
      },
      async close() { order.push("context.close"); }
    });

    // Stub the lazily-required player resolver
    const resolverPath = require.resolve("./avsee/player_resolver");
    const realResolverModule = require.cache[resolverPath];
    let lentBrowser = null;
    require.cache[resolverPath] = {
      id: resolverPath,
      filename: resolverPath,
      loaded: true,
      exports: {
        resolvePlayer: async (url, opts) => {
          order.push("resolvePlayer");
          lentBrowser = opts.browser;
          return { success: true, mediaUrl: "http://cdn.apiavsee.com/test.mp4", duration: 12 };
        }
      }
    };

    try {
      const adapter = new AvseeSourceAdapter({
        isAuthorized: true,
        licenseId: "LIC-TEST",
        ledgerPath: path.join(process.env.NEXAHUB_DATA_DIR, "ledger_12.json")
      });
      let launches = 0;
      adapter.launchBrowser = async () => { launches++; adapter.activeBrowsers.add(browser); return browser; };

      const details = await adapter.fetchItemDetails("https://02.avsee.is/bbs/board.php?bo_table=korea&wr_id=42");
      assert.strictEqual(launches, 1, "exactly one Chromium per item");
      assert.strictEqual(lentBrowser, browser, "resolvePlayer must reuse the same browser");
      assert.strictEqual(details.videoSrc, "http://cdn.apiavsee.com/test.mp4");
      assert.ok(order.indexOf("context.close") < order.indexOf("resolvePlayer"), "detail context released before player resolution");
      assert.strictEqual(browser.closed, true, "adapter-owned browser closed after the item");
      assert.strictEqual(adapter.activeBrowsers.size, 0);
    } finally {
      if (realResolverModule) {
        require.cache[resolverPath] = realResolverModule;
      } else {
        delete require.cache[resolverPath];
      }
    }
  });

  await check("13. closeActiveBrowsers() closes tracked browsers", async () => {
    const adapter = new AvseeSourceAdapter({
      isAuthorized: true,
      licenseId: "LIC-TEST",
      ledgerPath: path.join(process.env.NEXAHUB_DATA_DIR, "ledger_13.json")
    });
    const b1 = makeFakeBrowser();
    const b2 = makeFakeBrowser();
    adapter.activeBrowsers.add(b1);
    adapter.activeBrowsers.add(b2);
    const closed = await adapter.closeActiveBrowsers();
    assert.strictEqual(closed, 2);
    assert.ok(b1.closed && b2.closed);
  });

  console.log("\n==================================================");
  console.log(`📊 SUMMARY: ${passed} / ${passed + failed} TESTS PASSED`);
  console.log("==================================================\n");
  process.exit(failed === 0 ? 0 : 1);
}

run().catch(err => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
