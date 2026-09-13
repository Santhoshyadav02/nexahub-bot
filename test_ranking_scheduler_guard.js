/**
 * ============================================================
 * 🧪 OFFLINE TEST: RANKING FETCH TIMEOUTS & SCHEDULER IN-FLIGHT GUARD
 * ============================================================
 * Uses only a local 127.0.0.1 HTTP server (no internet):
 * - fetchText() rejects (and destroys the request) on idle timeout.
 * - fetchText() rejects when the overall deadline passes on a trickling response.
 * - startRankingScheduler() never runs overlapping refreshes.
 * - stopRankingScheduler() clears the interval.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

process.env.NEXAHUB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nexahub-ranking-test-"));

const ranking = require("./ranking_scraper");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

async function run() {
  console.log("==================================================");
  console.log("🚀 RUNNING RANKING TIMEOUT & SCHEDULER GUARD TESTS (OFFLINE)");
  console.log("==================================================\n");

  const trickleTimers = new Set();
  const server = http.createServer((req, res) => {
    if (req.url === "/ok") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("hello");
    } else if (req.url === "/hang") {
      // never respond
    } else if (req.url === "/trickle") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      const t = setInterval(() => res.write("."), 50);
      trickleTimers.add(t);
      res.on("close", () => { clearInterval(t); trickleTimers.delete(t); });
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  await check("1. RANKING_FILE lives in NEXAHUB_DATA_DIR", () => {
    assert.strictEqual(path.dirname(ranking.RANKING_FILE), path.resolve(process.env.NEXAHUB_DATA_DIR));
  });

  await check("2. fetchText() returns body for a normal response", async () => {
    assert.strictEqual(await ranking.fetchText(`${base}/ok`), "hello");
  });

  await check("3. fetchText() rejects on idle timeout instead of hanging", async () => {
    const start = Date.now();
    await assert.rejects(ranking.fetchText(`${base}/hang`, {}, { timeoutMs: 200, deadlineMs: 5000 }), /timeout/i);
    assert.ok(Date.now() - start < 2000, "must reject promptly");
  });

  await check("4. fetchText() rejects when the overall deadline passes (trickling server)", async () => {
    const start = Date.now();
    await assert.rejects(ranking.fetchText(`${base}/trickle`, {}, { timeoutMs: 1000, deadlineMs: 400 }), /deadline/i);
    assert.ok(Date.now() - start < 2000, "deadline must cap total request time");
  });

  await check("5. Scheduler in-flight guard prevents overlapping refreshes; stop clears the interval", async () => {
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const scrapeFn = async () => {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(250);
      active--;
      return null;
    };

    const stop = ranking.startRankingScheduler({ intervalMs: 40, scrapeFn });
    assert.strictEqual(typeof stop, "function");
    assert.strictEqual(ranking.isRankingSchedulerRunning(), true);

    // Duplicate start must not create a second timer
    ranking.startRankingScheduler({ intervalMs: 40, scrapeFn });

    await sleep(700);
    ranking.stopRankingScheduler();
    assert.strictEqual(ranking.isRankingSchedulerRunning(), false);

    assert.strictEqual(maxActive, 1, "refreshes must never overlap");
    assert.ok(calls >= 2 && calls <= 4, `expected 2-4 guarded refreshes in 700ms (got ${calls}) instead of ~17 ticks`);

    await sleep(350); // let the in-flight refresh finish
    const callsAfterStop = calls;
    await sleep(300);
    assert.strictEqual(calls, callsAfterStop, "no refresh may start after stop");
    assert.strictEqual(ranking.isRankingRefreshInFlight(), false);
  });

  await check("6. stopRankingScheduler() is safe when not running", () => {
    ranking.stopRankingScheduler();
    assert.strictEqual(ranking.isRankingSchedulerRunning(), false);
  });

  for (const t of trickleTimers) clearInterval(t);
  if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));

  console.log("\n==================================================");
  console.log(`📊 SUMMARY: ${passed} / ${passed + failed} TESTS PASSED`);
  console.log("==================================================\n");
  process.exit(failed === 0 ? 0 : 1);
}

run().catch(err => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
