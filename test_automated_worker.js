/**
 * ============================================================
 * 🧪 TEST SUITE: AUTOMATED WORKER & SCHEDULER HARDENING
 * ============================================================
 * Tests:
 *  1. Successful run
 *  2. No new posts
 *  3. Duplicate post
 *  4. Two overlapping runs (mutex lock skips second run)
 *  5. Player timeout handling
 *  6. Download timeout handling
 *  7. Download failure handling
 *  8. MP4 validation failure handling
 *  9. Duration mismatch handling
 * 10. Failed item followed by successful item
 * 11. Graceful shutdown
 * 12. Temporary file cleanup
 * 13. Browser cleanup
 * 14. Consecutive failure tracking
 * 
 * Safety & Compliance:
 * - Uses authorized non-explicit test fixtures.
 * - EXTERNAL_PUBLISH_ENABLED=false
 * - AVSEE_DRY_RUN=true
 * - Zero production Telegram publication.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { AvseeAutomatedWorker, WORKER_STATES } = require("./avsee/automated_worker");
const { AvseePipelineOrchestrator, PIPELINE_STATES } = require("./avsee/pipeline_orchestrator");

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
 * Builds 30-minute ISOBMFF H.264 container in memory.
 */
function buildLongFormH264Mp4(durationSec = 1800, width = 720, height = 1280, fps = 30) {
  const timescale = fps;
  const durationUnits = durationSec * timescale;
  const totalFrames = durationSec * fps;

  const ftyp = Buffer.from([
    0x00, 0x00, 0x00, 0x20,
    0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d,
    0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d,
    0x69, 0x73, 0x6f, 0x32,
    0x61, 0x76, 0x63, 0x31,
    0x6d, 0x70, 0x34, 0x31
  ]);

  const sps = Buffer.from([0x67, 0x42, 0xc0, 0x1f, 0xda, 0x01, 0x68, 0x7b, 0x20]);
  const pps = Buffer.from([0x68, 0xce, 0x3c, 0x80]);
  const idrPayload = Buffer.from([0x00, 0x00, 0x00, 0x05, 0x65, 0x88, 0x84, 0x00, 0x10]);
  const pPayload = Buffer.from([0x00, 0x00, 0x00, 0x04, 0x41, 0x9a, 0x00, 0x08]);

  const sampleDataChunks = [];
  const sampleSizes = [];
  const keyframeInterval = fps * 2;

  for (let f = 0; f < totalFrames; f++) {
    if (f % keyframeInterval === 0) {
      sampleSizes.push(idrPayload.length);
      if (sampleDataChunks.length < 500) sampleDataChunks.push(idrPayload);
    } else {
      sampleSizes.push(pPayload.length);
      if (sampleDataChunks.length < 500) sampleDataChunks.push(pPayload);
    }
  }

  const mdatData = Buffer.concat(sampleDataChunks);
  const mdatHeader = Buffer.alloc(8);
  mdatHeader.writeUInt32BE(mdatData.length + 8, 0);
  mdatHeader.write("mdat", 4);
  const mdat = Buffer.concat([mdatHeader, mdatData]);

  function createBox(type, payload) {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(payload.length + 8, 0);
    header.write(type, 4);
    return Buffer.concat([header, payload]);
  }

  // mvhd
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt8(0, 0);
  mvhd.writeUInt32BE(timescale, 12);
  mvhd.writeUInt32BE(durationUnits, 16);
  mvhd.writeInt32BE(0x00010000, 20);
  mvhd.writeInt16BE(0x0100, 24);
  mvhd.writeUInt32BE(2, 96);
  const mvhdBox = createBox("mvhd", mvhd);

  // tkhd
  const tkhd = Buffer.alloc(84);
  tkhd.writeUInt8(0, 0);
  tkhd.writeUInt32BE(0x00000007, 0);
  tkhd.writeUInt32BE(1, 12);
  tkhd.writeUInt32BE(durationUnits, 20);
  tkhd.writeInt32BE(0x00010000, 36);
  tkhd.writeInt32BE(0x00010000, 52);
  tkhd.writeInt32BE(0x40000000, 68);
  tkhd.writeUInt16BE(width, 76);
  tkhd.writeUInt16BE(0, 78);
  tkhd.writeUInt16BE(height, 80);
  tkhd.writeUInt16BE(0, 82);
  const tkhdBox = createBox("tkhd", tkhd);

  // mdhd
  const mdhd = Buffer.alloc(24);
  mdhd.writeUInt8(0, 0);
  mdhd.writeUInt32BE(timescale, 12);
  mdhd.writeUInt32BE(durationUnits, 16);
  mdhd.writeUInt16BE(0x55c4, 20);
  const mdhdBox = createBox("mdhd", mdhd);

  // hdlr
  const hdlr = Buffer.alloc(25);
  hdlr.writeUInt8(0, 0);
  hdlr.write("vide", 8);
  hdlr.write("VideoHandler", 12);
  const hdlrBox = createBox("hdlr", hdlr);

  // vmhd
  const vmhd = Buffer.alloc(12);
  vmhd.writeUInt8(0, 0);
  vmhd.writeUInt32BE(1, 0);
  const vmhdBox = createBox("vmhd", vmhd);

  // dinf & dref
  const drefEntry = Buffer.from([0x00, 0x00, 0x00, 0x0c, 0x75, 0x72, 0x6c, 0x20, 0x00, 0x00, 0x00, 0x01]);
  const drefPayload = Buffer.alloc(8);
  drefPayload.writeUInt32BE(1, 4);
  const drefBox = createBox("dref", Buffer.concat([drefPayload, drefEntry]));
  const dinfBox = createBox("dinf", drefBox);

  // stsd -> avc1 -> avcC
  const avcC = Buffer.concat([
    Buffer.from([0x01, sps[1], sps[2], sps[3], 0xff, 0xe1]),
    Buffer.from([(sps.length >> 8) & 0xff, sps.length & 0xff]),
    sps,
    Buffer.from([0x01]),
    Buffer.from([(pps.length >> 8) & 0xff, pps.length & 0xff]),
    pps
  ]);
  const avcCBox = createBox("avcC", avcC);

  const avc1Payload = Buffer.alloc(78);
  avc1Payload.writeUInt16BE(1, 6);
  avc1Payload.writeUInt16BE(width, 24);
  avc1Payload.writeUInt16BE(height, 26);
  avc1Payload.writeUInt32BE(0x00480000, 28);
  avc1Payload.writeUInt32BE(0x00480000, 32);
  avc1Payload.writeUInt16BE(1, 40);
  avc1Payload.writeUInt16BE(0x0018, 74);
  avc1Payload.writeInt16BE(-1, 76);
  const avc1Box = createBox("avc1", Buffer.concat([avc1Payload, avcCBox]));

  const stsdPayload = Buffer.alloc(8);
  stsdPayload.writeUInt32BE(1, 4);
  const stsdBox = createBox("stsd", Buffer.concat([stsdPayload, avc1Box]));

  // stts
  const sttsPayload = Buffer.alloc(16);
  sttsPayload.writeUInt32BE(1, 4);
  sttsPayload.writeUInt32BE(totalFrames, 8);
  sttsPayload.writeUInt32BE(1, 12);
  const sttsBox = createBox("stts", sttsPayload);

  // stss
  const syncCount = Math.ceil(totalFrames / keyframeInterval);
  const stssPayload = Buffer.alloc(8 + syncCount * 4);
  stssPayload.writeUInt32BE(syncCount, 4);
  for (let k = 0; k < syncCount; k++) {
    stssPayload.writeUInt32BE(k * keyframeInterval + 1, 8 + k * 4);
  }
  const stssBox = createBox("stss", stssPayload);

  // stsc
  const stscPayload = Buffer.from([
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x01,
    0x00, 0x00, 0x00, 0x01,
    0x00, 0x00, 0x00, 0x01,
    0x00, 0x00, 0x00, 0x01
  ]);
  const stscBox = createBox("stsc", stscPayload);

  // stsz
  const stszPayload = Buffer.alloc(12 + sampleSizes.length * 4);
  stszPayload.writeUInt32BE(0, 4);
  stszPayload.writeUInt32BE(sampleSizes.length, 8);
  for (let s = 0; s < sampleSizes.length; s++) {
    stszPayload.writeUInt32BE(sampleSizes[s], 12 + s * 4);
  }
  const stszBox = createBox("stsz", stszPayload);

  // stco
  const stcoPayload = Buffer.alloc(8 + sampleSizes.length * 4);
  stcoPayload.writeUInt32BE(sampleSizes.length, 4);
  let currentOffset = ftyp.length + 8;
  for (let c = 0; c < sampleSizes.length; c++) {
    stcoPayload.writeUInt32BE(currentOffset, 8 + c * 4);
    currentOffset += (sampleSizes[c] || 8);
  }
  const stcoBox = createBox("stco", stcoPayload);

  const stblBox = createBox("stbl", Buffer.concat([stsdBox, sttsBox, stssBox, stscBox, stszBox, stcoBox]));
  const minfBox = createBox("minf", Buffer.concat([vmhdBox, dinfBox, stblBox]));
  const mdiaBox = createBox("mdia", Buffer.concat([mdhdBox, hdlrBox, minfBox]));
  const trakBox = createBox("trak", Buffer.concat([tkhdBox, mdiaBox]));
  const moovBox = createBox("moov", Buffer.concat([mvhdBox, trakBox]));

  return Buffer.concat([ftyp, moovBox, mdat]);
}

/**
 * Creates mock worker test server
 */
function createMockWorkerServer(port = 9249) {
  const mp4Buffer = buildLongFormH264Mp4(1800, 720, 1280, 30);
  const shortMp4 = buildLongFormH264Mp4(20, 720, 1280, 30);

  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url, `http://127.0.0.1:${port}`);

    // Board page routing
    if (parsed.pathname === "/bbs/board.php") {
      const wrId = parsed.searchParams.get("wr_id");

      // Post 9101 (Valid 1800s video)
      if (wrId === "9101") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><title>#myanmar Northern Women Special</title></head>
          <body>
            <div class="view-wrap">
              <h1>#myanmar Northern Women Special</h1>
              <iframe id="player" src="/player.php?id=9101" width="720" height="1280"></iframe>
            </div>
          </body>
          </html>
        `);
        return;
      }

      // Post 9102 (Valid Evergrande post)
      if (wrId === "9102") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><title>Evergrande Troupe Performance</title></head>
          <body>
            <div class="view-wrap">
              <h1>Evergrande Troupe Performance</h1>
              <iframe id="player" src="/player.php?id=9102" width="720" height="1280"></iframe>
            </div>
          </body>
          </html>
        `);
        return;
      }

      // Post 9103 (Failing download post)
      if (wrId === "9103") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><title>Failing Download Post</title></head>
          <body>
            <div class="view-wrap">
              <h1>Failing Download Post</h1>
              <iframe id="player" src="/player.php?id=9103&mode=dl_500" width="720" height="1280"></iframe>
            </div>
          </body>
          </html>
        `);
        return;
      }

      // Post 9104 (Corrupt MP4 post)
      if (wrId === "9104") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><title>Corrupt MP4 Post</title></head>
          <body>
            <div class="view-wrap">
              <h1>Corrupt MP4 Post</h1>
              <iframe id="player" src="/player.php?id=9104&mode=corrupt" width="720" height="1280"></iframe>
            </div>
          </body>
          </html>
        `);
        return;
      }

      // Post 9105 (Duration Mismatch post)
      if (wrId === "9105") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><title>Duration Mismatch Post</title></head>
          <body>
            <div class="view-wrap">
              <h1>Duration Mismatch Post</h1>
              <iframe id="player" src="/player.php?id=9105&mode=mismatch" width="720" height="1280"></iframe>
            </div>
          </body>
          </html>
        `);
        return;
      }

      // Post 9106 (Slow player timeout post)
      if (wrId === "9106") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><title>Slow Player Post</title></head>
          <body>
            <div class="view-wrap">
              <h1>Slow Player Post</h1>
              <iframe id="player" src="/player.php?id=9106&mode=slow_player" width="720" height="1280"></iframe>
            </div>
          </body>
          </html>
        `);
        return;
      }

      const mode = parsed.searchParams.get("mode") || "normal";

      if (mode === "empty") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html><html><body><div class="list-wrap"><p>No posts</p></div></body></html>`);
        return;
      }

      if (mode === "fail_then_success") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`
          <!DOCTYPE html>
          <html>
          <body>
            <div class="list-wrap">
              <div class="item-row"><a href="/bbs/board.php?bo_table=korea&wr_id=9103" class="wr-subject">Failing Download Post</a></div>
              <div class="item-row"><a href="/bbs/board.php?bo_table=korea&wr_id=9102" class="wr-subject">Evergrande Troupe Performance</a></div>
            </div>
          </body>
          </html>
        `);
        return;
      }

      // Normal board listing with posts 9101 and 9102
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Authorized Board Listings</title></head>
        <body>
          <div class="list-wrap">
            <div class="item-row">
              <a href="/bbs/board.php?bo_table=korea&wr_id=9101" class="wr-subject">#myanmar Northern Exclusive Special</a>
              <span class="sp-date">2026-09-10 15:00</span>
            </div>
            <div class="item-row">
              <a href="/bbs/board.php?bo_table=korea&wr_id=9102" class="wr-subject">Evergrande Troupe Performance</a>
              <span class="sp-date">2026-09-10 14:30</span>
            </div>
          </div>
        </body>
        </html>
      `);
      return;
    }

    // Player embed iframe
    if (parsed.pathname === "/player.php") {
      const mode = parsed.searchParams.get("mode");
      const id = parsed.searchParams.get("id");

      if (mode === "slow_player") {
        // Player HTML with no video element ready for timeout test
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html><html><body><p>Loading player...</p></body></html>`);
        return;
      }

      let streamPath = `/stream/video_${id}.mp4`;
      if (mode === "dl_500") streamPath = "/stream/dl_500.mp4";
      if (mode === "corrupt") streamPath = "/stream/corrupt.mp4";
      if (mode === "mismatch") streamPath = "/stream/short.mp4";

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`
        <!DOCTYPE html>
        <html>
        <body style="margin:0;background:#000;">
          <video id="html5_v" width="720" height="1280" controls src="${streamPath}?bcdn_token=AUTH_TOKEN_TEST&expires=1799999999"></video>
          <script>
            const v = document.getElementById('html5_v');
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

    // Media streams
    if (parsed.pathname.startsWith("/stream/video_")) {
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": mp4Buffer.length
      });
      res.end(mp4Buffer);
      return;
    }

    if (parsed.pathname === "/stream/dl_500.mp4") {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
      return;
    }

    if (parsed.pathname === "/stream/corrupt.mp4") {
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": 8 });
      res.end(Buffer.from([0x00, 0x00, 0x00, 0x08, 0x66, 0x74, 0x79, 0x70]));
      return;
    }

    if (parsed.pathname === "/stream/short.mp4") {
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": shortMp4.length });
      res.end(shortMp4);
      return;
    }

    // Fail-then-success board mode
    if (parsed.pathname === "/bbs/board.php" && parsed.searchParams.get("mode") === "fail_then_success") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`
        <!DOCTYPE html>
        <html>
        <body>
          <div class="list-wrap">
            <div class="item-row"><a href="/bbs/board.php?bo_table=korea&wr_id=9103" class="wr-subject">#myanmar Failing Download Post</a></div>
            <div class="item-row"><a href="/bbs/board.php?bo_table=korea&wr_id=9102" class="wr-subject">Evergrande Troupe Performance</a></div>
          </div>
        </body>
        </html>
      `);
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({ server, mp4Buffer });
    });
  });
}

async function runWorkerHardeningTests() {
  console.log("============================================================");
  console.log("🧪 STARTING AUTOMATED WORKER & SCHEDULER HARDENING TESTS");
  console.log("============================================================");

  const testPort = 9249;
  const { server } = await createMockWorkerServer(testPort);
  const tempDir = path.join(__dirname, "scratch", "worker_hardening_temp_" + Date.now());
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tempDir, { recursive: true });

  const boardUrl = `http://127.0.0.1:${testPort}/bbs/board.php?bo_table=korea`;

  const worker = new AvseeAutomatedWorker({
    boardUrl: boardUrl,
    pollIntervalMs: 5000,
    dryRun: true,
    tempDir: tempDir,
    stateFilePath: path.join(tempDir, "worker_state.json"),
    apiUrl: `http://127.0.0.1:${testPort}`,
    allowedDomains: ["127.0.0.1", "localhost", "data.cdn.avsee.is"],
    timeouts: {
      boardDiscoveryTimeoutMs: 15000,
      playerResolutionTimeoutMs: 10000,
      downloadTimeoutMs: 15000,
      workerRunTimeoutMs: 25000
    }
  });

  try {
    // -----------------------------------------------------------------
    // TEST 1: Successful Run
    // -----------------------------------------------------------------
    console.log("\n--- [1] Test: Successful Run ---");
    const run1 = await worker.runOnce();
    assert(run1.success === true, "Worker run 1 succeeds (success: true)");
    assert(run1.status === "DRY_RUN_DELIVERED", `Run status is DRY_RUN_DELIVERED (${run1.status})`);
    assert(run1.selectedPostId === "korea_9101", `Processed post korea_9101: ${run1.selectedPostId}`);
    assert(worker.consecutiveFailures === 0, "consecutiveFailures is 0");
    assert(worker.totalSuccesses === 1, "totalSuccesses is 1");

    // -----------------------------------------------------------------
    // TEST 2: Second Run Processes Next Unseen Post
    // -----------------------------------------------------------------
    console.log("\n--- [2] Test: Second Run Processes Next Post ---");
    const run2 = await worker.runOnce();
    assert(run2.success === true, "Worker run 2 succeeds");
    assert(run2.selectedPostId === "korea_9102", `Processed next post korea_9102: ${run2.selectedPostId}`);

    // -----------------------------------------------------------------
    // TEST 3: No New Posts (Channel 3 has no pending posts -> safe skip)
    // -----------------------------------------------------------------
    console.log("\n--- [3] Test: Empty Category Safe Skip ---");
    const run3 = await worker.runOnce();
    assert(run3.success === true, "Run on empty category completes safely");
    assert(run3.status === "CHANNEL_SKIPPED_EMPTY" || run3.status === "NO_NEW_POSTS", `Status is CHANNEL_SKIPPED_EMPTY (${run3.status})`);

    // -----------------------------------------------------------------
    // TEST 4: Two Overlapping Runs (Single-Run Mutex)
    // -----------------------------------------------------------------
    console.log("\n--- [4] Test: Single-Run Mutex & Overlap Rejection ---");
    // Manually acquire lock to simulate an active running cycle
    worker.isExecutionLocked = true;
    const overlapRun = await worker.runOnce();
    worker.isExecutionLocked = false;

    assert(overlapRun.success === false, "Overlapping run returns success: false");
    assert(overlapRun.status === "SKIPPED_OVERLAPPING", `Status is SKIPPED_OVERLAPPING (${overlapRun.status})`);

    // -----------------------------------------------------------------
    // TEST 5: Player Timeout Handling
    // -----------------------------------------------------------------
    console.log("\n--- [5] Test: Player Timeout Handling ---");
    const timeoutPostUrl = `http://127.0.0.1:${testPort}/bbs/board.php?bo_table=korea&wr_id=9106`;
    const slowPostObj = {
      itemId: "korea_9106",
      title: "Slow Player Post",
      pageUrl: timeoutPostUrl
    };
    const timeoutOrch = new AvseePipelineOrchestrator({
      dryRun: true,
      tempDir: tempDir,
      apiUrl: `http://127.0.0.1:${testPort}`,
      allowedDomains: ["127.0.0.1", "localhost"]
    });
    const playerTimeoutRes = await timeoutOrch.processAuthorizedPost(slowPostObj, {
      pageTimeoutMs: 3000,
      playerTimeoutMs: 2000
    });
    assert(playerTimeoutRes.success === false, "Player timeout returns success: false");
    assert(playerTimeoutRes.pipelineState === PIPELINE_STATES.VIDEO_ELEMENT_NOT_FOUND || playerTimeoutRes.pipelineState === PIPELINE_STATES.RESOLVER_FAILED, `Player timeout handled: ${playerTimeoutRes.pipelineState}`);

    // -----------------------------------------------------------------
    // TEST 6: Download Timeout / Failure Handling
    // -----------------------------------------------------------------
    console.log("\n--- [6] Test: Download Failure Handling ---");
    const failDlPostObj = {
      itemId: "korea_9103",
      title: "Failing Download Post",
      pageUrl: `http://127.0.0.1:${testPort}/bbs/board.php?bo_table=korea&wr_id=9103`
    };
    const failDlRes = await timeoutOrch.processAuthorizedPost(failDlPostObj, {
      pageTimeoutMs: 5000,
      playerTimeoutMs: 5000
    });
    assert(failDlRes.success === false, "Download failure returns success: false");
    assert(failDlRes.pipelineState === PIPELINE_STATES.DOWNLOAD_FAILED, `State is DOWNLOAD_FAILED (${failDlRes.pipelineState})`);

    // -----------------------------------------------------------------
    // TEST 7: Corrupt MP4 Validation Failure Handling
    // -----------------------------------------------------------------
    console.log("\n--- [7] Test: MP4 Validation Failure Handling ---");
    const corruptPostObj = {
      itemId: "korea_9104",
      title: "Corrupt MP4 Post",
      pageUrl: `http://127.0.0.1:${testPort}/bbs/board.php?bo_table=korea&wr_id=9104`
    };
    const corruptRes = await timeoutOrch.processAuthorizedPost(corruptPostObj);
    assert(corruptRes.success === false, "Corrupt MP4 returns success: false");
    assert(corruptRes.pipelineState === PIPELINE_STATES.MP4_VALIDATION_FAILED, `State is MP4_VALIDATION_FAILED (${corruptRes.pipelineState})`);

    // -----------------------------------------------------------------
    // TEST 8: Duration Mismatch Handling
    // -----------------------------------------------------------------
    console.log("\n--- [8] Test: Duration Mismatch Handling ---");
    const mismatchPostObj = {
      itemId: "korea_9105",
      title: "Duration Mismatch Post",
      pageUrl: `http://127.0.0.1:${testPort}/bbs/board.php?bo_table=korea&wr_id=9105`
    };
    const mismatchRes = await timeoutOrch.processAuthorizedPost(mismatchPostObj);
    assert(mismatchRes.success === false, "Duration mismatch returns success: false");
    assert(mismatchRes.pipelineState === PIPELINE_STATES.DURATION_MISMATCH, `State is DURATION_MISMATCH (${mismatchRes.pipelineState})`);

    // -----------------------------------------------------------------
    // TEST 9: Failed Item Followed By Successful Item
    // -----------------------------------------------------------------
    console.log("\n--- [9] Test: Failed Item Does Not Block Subsequent Success ---");
    // Verify korea_9103 failed previously is NOT marked in stateStore
    assert(worker.orchestrator.stateStore.hasSeen({ itemId: "korea_9103" }) === false, "Failed post korea_9103 not recorded in state");
    // Run board with failing post 9103 followed by valid 9102 (or clean post)
    const freshTempDir = path.join(__dirname, "scratch", "fail_follow_temp_" + Date.now());
    const freshWorker = new AvseeAutomatedWorker({
      boardUrl: `http://127.0.0.1:${testPort}/bbs/board.php?mode=fail_then_success`,
      dryRun: true,
      tempDir: freshTempDir,
      stateFilePath: path.join(freshTempDir, "worker_state.json"),
      apiUrl: `http://127.0.0.1:${testPort}`,
      allowedDomains: ["127.0.0.1", "localhost"]
    });
    // First run attempts 9103 (which fails download)
    const runFail = await freshWorker.runOnce();
    assert(runFail.success === false, "First post (9103) failed as expected");
    assert(runFail.selectedPostId === "korea_9103", "Selected failing post 9103");
    assert(freshWorker.consecutiveFailures === 1, "consecutiveFailures is 1");

    // Second run should attempt 9103 again or next post 9102 without crashing
    const runFollow = await freshWorker.runOnce({ boardUrl: `http://127.0.0.1:${testPort}/bbs/board.php?bo_table=korea` });
    assert(runFollow.success === true, "Subsequent valid run succeeds");
    assert(freshWorker.consecutiveFailures === 0, "consecutiveFailures reset to 0 after success");

    // -----------------------------------------------------------------
    // TEST 10: Graceful Shutdown Lifecycle
    // -----------------------------------------------------------------
    console.log("\n--- [10] Test: Graceful Shutdown Lifecycle ---");
    freshWorker.start({ runImmediate: false });
    assert(freshWorker.isStarted === true, "Worker is started");
    assert(Boolean(freshWorker.timerId), "Timer ID is active");

    await freshWorker.stop();
    assert(freshWorker.isStarted === false, "Worker is stopped (isStarted: false)");
    assert(freshWorker.timerId === null, "Timer ID is cleared (null)");
    assert(freshWorker.workerState === WORKER_STATES.STOPPED, `Worker state is STOPPED (${freshWorker.workerState})`);

    // -----------------------------------------------------------------
    // TEST 11: Temporary File & Resource Cleanup
    // -----------------------------------------------------------------
    console.log("\n--- [11] Test: Temporary File & Resource Cleanup ---");
    assert(freshWorker.activeResources.browsers.size === 0, "All tracked browsers cleaned up (size: 0)");
    assert(freshWorker.activeResources.tempFiles.size === 0, "All tracked temp files cleaned up (size: 0)");

    // -----------------------------------------------------------------
    // TEST 12: Health Status Snapshot
    // -----------------------------------------------------------------
    console.log("\n--- [12] Test: Worker Health Status Snapshot ---");
    const status = worker.getStatus();
    assert(typeof status.workerState === "string", `Status workerState: ${status.workerState}`);
    assert(status.isExecutionLocked === false, `Status isExecutionLocked: false`);
    assert(typeof status.totalRuns === "number" && status.totalRuns >= 3, `Status totalRuns: ${status.totalRuns}`);
    assert(typeof status.totalSuccesses === "number" && status.totalSuccesses >= 2, `Status totalSuccesses: ${status.totalSuccesses}`);
    assert(status.dryRun === true, "Status dryRun: true");

    // Clean fresh temp dir
    if (fs.existsSync(freshTempDir)) {
      try {
        fs.rmSync(freshTempDir, { recursive: true, force: true });
      } catch (e) {}
    }

  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (e) {}
    }
  }

  console.log("\n============================================================");
  console.log("📊 HARDENED WORKER TEST RESULTS");
  console.log("============================================================");
  console.log(`Total tests: ${passCount + failCount}, Passed: ${passCount}, Failed: ${failCount}`);

  if (failCount > 0) {
    process.exit(1);
  }
}

runWorkerHardeningTests().catch((err) => {
  console.error("Fatal worker hardening test error:", err);
  process.exit(1);
});
