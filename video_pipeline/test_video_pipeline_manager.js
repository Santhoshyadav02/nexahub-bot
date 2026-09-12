/**
 * ============================================================
 * 🧪 VIDEO PIPELINE MANAGER - LOCAL AUTHORIZED FIXTURE TEST
 * ============================================================
 * Proves the VideoPipelineManager correctly starts/monitors/stops the
 * existing, UNMODIFIED video-tools pipeline as a child process, using a
 * local-only authorized HTTP fixture (127.0.0.1) - no external site, no
 * adult content, no live network access of any kind.
 *
 * This test does not modify video-tools. It only calls its existing
 * run_pipeline.ps1 through the new manager, exactly as a human would from
 * a terminal, and checks the same JSON/MP4 outputs video-tools already
 * produces on its own.
 *
 * Reuses the existing local fixture MP4 already present in this repo at
 * scratch/real_video_test.mp4 (read-only) - same one scratch/test_pipeline_e2e.js
 * already relies on.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { VideoPipelineManager } = require("./video_pipeline_manager");

const ROOT_DIR = path.resolve(__dirname, "..");
const FIXTURE_MP4 = path.join(ROOT_DIR, "scratch", "real_video_test.mp4");
const TEST_DIR = path.join(ROOT_DIR, "scratch", "video_pipeline_manager_test_workspace");

let passed = 0;
let failed = 0;

function check(label, condition, detail = "") {
  if (condition) {
    console.log(`✅ ${label}`);
    passed++;
  } else {
    console.error(`❌ ${label}${detail ? " - " + detail : ""}`);
    failed++;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicateFn, { timeoutMs = 20000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicateFn()) return true;
    await sleep(intervalMs);
  }
  return false;
}

function isPidAlive(pid) {
  try {
    // Signal 0 does not kill the process; it only checks existence/permission.
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

async function main() {
  if (!fs.existsSync(FIXTURE_MP4)) {
    console.error(`Fixture MP4 missing at: ${FIXTURE_MP4}`);
    process.exit(1);
  }
  const fixtureBytes = fs.readFileSync(FIXTURE_MP4);
  const fixtureSha256 = crypto.createHash("sha256").update(fixtureBytes).digest("hex");

  // video-tools' own optional proxy config (.proxy.local.json, gitignored, not part of its
  // shipped implementation) would otherwise route this local-fixture test's browser traffic
  // through a real external proxy that cannot reach 127.0.0.1. Temporarily move it aside for
  // the duration of this test only, and restore it unconditionally afterward - video-tools
  // itself is never edited, only this one runtime config artifact is set aside and put back.
  const proxyConfigPath = path.join(ROOT_DIR, "video-scrapper", "video-tools", ".proxy.local.json");
  const proxyConfigBackupPath = `${proxyConfigPath}.set-aside-by-nexahub-test`;
  const hadProxyConfig = fs.existsSync(proxyConfigPath);
  if (hadProxyConfig) {
    fs.renameSync(proxyConfigPath, proxyConfigBackupPath);
    console.log("Temporarily set aside video-tools/.proxy.local.json for this local-only test (will restore after).");
  }

  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const outputDir = path.join(TEST_DIR, "output");
  const downloadsDir = path.join(TEST_DIR, "downloads");

  // ------------------------------------------------------------
  // Local authorized fixture server - matches video-tools' CURRENT
  // selectors (#fboardlist .list-row a[href*="wr_id"] / .jw-media video.jw-video)
  // ------------------------------------------------------------
  const POST_COUNT = 3;
  const server = http.createServer((req, res) => {
    const url = req.url.split("?")[0];

    if (url === "/" || url === "/listing") {
      const rows = Array.from({ length: POST_COUNT }, (_, i) =>
        `<div class="list-row"><div class="list-item"><a href="/post/${i + 1}?wr_id=${i + 1}">Post ${i + 1}</a></div></div>`
      ).join("\n");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><html><body><form id="fboardlist">${rows}</form></body></html>`);
      return;
    }

    const postMatch = url.match(/^\/post\/(\d+)$/);
    if (postMatch) {
      const id = postMatch[1];
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><html><body>
        <div class="jw-media"><video class="jw-video" src="/media/video${id}.mp4"></video></div>
      </body></html>`);
      return;
    }

    const mediaMatch = url.match(/^\/media\/video[1-9][0-9]*\.mp4$/);
    if (mediaMatch) {
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": fixtureBytes.length,
        "Accept-Ranges": "bytes"
      });
      res.end(fixtureBytes);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/`;
  console.log(`Local authorized fixture server listening on ${baseUrl}`);

  let sawPlaywrightStart = false;
  const managerWithObserver = new VideoPipelineManager({
    gracefulTimeoutMs: 5000,
    forceTimeoutMs: 3000,
    onLine: (tag, line) => {
      if (/Starting Playwright browser/i.test(line)) sawPlaywrightStart = true;
    }
  });

  try {
    console.log("\n============================================================");
    console.log("TEST 1: Manager starts video-tools");
    console.log("============================================================");
    const startResult = managerWithObserver.start({
      url: baseUrl,
      output: outputDir,
      downloads: downloadsDir,
      workers: 2,
      standalone: true,      // no CDP/verified-browser bootstrap needed for a local fixture
      targetLinks: POST_COUNT,
      maxPages: 1,
      interval: 10,
      timeoutSec: 15
    });
    check("start() returns STARTED with a PID", startResult.status === "STARTED" && Number.isInteger(startResult.pid), JSON.stringify(startResult));

    console.log("\n============================================================");
    console.log("TEST 5: Manager reports the child process as running");
    console.log("============================================================");
    check("getStatus().running is true immediately after start", managerWithObserver.getStatus().running === true);
    check("getStatus().pid matches the started PID", managerWithObserver.getStatus().pid === startResult.pid);

    console.log("\n============================================================");
    console.log("TEST 2/3/4: Playwright starts, discovery JSON appears, downloader runs automatically");
    console.log("============================================================");
    const postLinksPath = path.join(outputDir, "post_links.json");
    const videosJsonPath = path.join(outputDir, "videos.json");
    const reportPath = path.join(downloadsDir, "download_report.json");

    const sawDiscovery = await waitFor(() => sawPlaywrightStart, { timeoutMs: 15000 });
    check("video-tools logged that it started Playwright", sawDiscovery);

    let postLinks = [];
    const sawPostLinks = await waitFor(() => {
      if (!fs.existsSync(postLinksPath)) return false;
      try {
        const p = JSON.parse(fs.readFileSync(postLinksPath, "utf8"));
        if (Array.isArray(p) && p.length >= POST_COUNT) {
          postLinks = p;
          return true;
        }
        return false;
      } catch (e) {
        return false;
      }
    }, { timeoutMs: 20000 });
    check("post_links.json was created", sawPostLinks);
    if (sawPostLinks) {
      check(`post_links.json contains ${POST_COUNT} link(s)`, postLinks.length === POST_COUNT, `got ${postLinks.length}`);
    }

    const sawVideosJson = await waitFor(() => {
      if (!fs.existsSync(videosJsonPath)) return false;
      try {
        const v = JSON.parse(fs.readFileSync(videosJsonPath, "utf8"));
        return Array.isArray(v) && v.length >= POST_COUNT;
      } catch (e) {
        return false;
      }
    }, { timeoutMs: 20000 });
    check("videos.json was populated with discovered video records", sawVideosJson);

    const sawDownloadReport = await waitFor(() => {
      if (!fs.existsSync(reportPath)) return false;
      try {
        const r = JSON.parse(fs.readFileSync(reportPath, "utf8"));
        return Array.isArray(r) && r.length >= POST_COUNT;
      } catch (e) {
        return false;
      }
    }, { timeoutMs: 20000 });
    check("download_report.json shows the downloader ran automatically (no manual trigger)", sawDownloadReport);

    let downloadedFiles = [];
    if (fs.existsSync(downloadsDir)) {
      downloadedFiles = fs.readdirSync(downloadsDir).filter((f) => f.endsWith(".mp4"));
    }
    check(`${POST_COUNT} MP4 file(s) were downloaded`, downloadedFiles.length === POST_COUNT, `got ${downloadedFiles.length}`);

    console.log("\n============================================================");
    console.log("TEST 9: Existing local scraper/downloader E2E behavior is unchanged (checksum match)");
    console.log("============================================================");
    let allChecksumsMatch = downloadedFiles.length > 0;
    for (const f of downloadedFiles) {
      const bytes = fs.readFileSync(path.join(downloadsDir, f));
      const hash = crypto.createHash("sha256").update(bytes).digest("hex");
      if (hash !== fixtureSha256) allChecksumsMatch = false;
    }
    check("All downloaded MP4s match the fixture's SHA-256 checksum exactly", allChecksumsMatch);

    console.log("\n============================================================");
    console.log("TEST 6: Duplicate start does not create a second process");
    console.log("============================================================");
    const dupResult = managerWithObserver.start({ url: baseUrl });
    check("Second start() call returns ALREADY_RUNNING", dupResult.status === "ALREADY_RUNNING");
    check("Second start() reports the SAME PID (no second process spawned)", dupResult.pid === startResult.pid);

    console.log("\n============================================================");
    console.log("TEST 7: Manager stop terminates the child cleanly");
    console.log("============================================================");
    const pidBeforeStop = managerWithObserver.getStatus().pid;
    const stopResult = await managerWithObserver.stop();
    check("stop() reports a terminal status", stopResult.status === "STOPPED" || stopResult.status === "STOPPED_FORCED", stopResult.status);
    check("getStatus().running is false after stop()", managerWithObserver.getStatus().running === false);

    console.log("\n============================================================");
    console.log("TEST 8: No orphan video-tools process remains");
    console.log("============================================================");
    await sleep(1000); // let Windows finish tearing down the tree
    const orphanStillAlive = isPidAlive(pidBeforeStop);
    check("The original child PID is no longer alive", !orphanStillAlive);

    console.log("\n============================================================");
    console.log("Additional: stop() on an already-stopped manager is a safe no-op");
    console.log("============================================================");
    const secondStop = await managerWithObserver.stop();
    check("stop() when not running returns NOT_RUNNING", secondStop.status === "NOT_RUNNING");

    console.log("\n============================================================");
    console.log("Additional: start() after preventFurtherStarts() is refused");
    console.log("============================================================");
    managerWithObserver.preventFurtherStarts();
    const refused = managerWithObserver.start({ url: baseUrl });
    check("start() after preventFurtherStarts() returns SHUTTING_DOWN", refused.status === "SHUTTING_DOWN");
  } finally {
    // Belt-and-braces cleanup even if an assertion threw above.
    try {
      if (managerWithObserver.isRunning()) {
        await managerWithObserver.stop();
      }
    } catch (e) {}
    server.close();
    if (hadProxyConfig && fs.existsSync(proxyConfigBackupPath)) {
      fs.renameSync(proxyConfigBackupPath, proxyConfigPath);
      console.log("Restored video-tools/.proxy.local.json.");
    }
  }

  console.log("\n============================================================");
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log("============================================================");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test suite crashed:", err);
  process.exit(1);
});
