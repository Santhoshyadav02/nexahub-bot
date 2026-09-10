/**
 * ============================================================
 * 🧪 TEST SUITE: AUTOMATED MEDIA RESOLUTION FLOW
 * ============================================================
 * Tests automatic post discovery from board listings, dedupe selection,
 * headless player resolution, streaming download, deep MP4 validation,
 * canonical normalization, topic classification, and dry-run ledger recording.
 * 
 * Safety & Compliance:
 * - Uses ONLY the authorized 30-minute H.264 test vector.
 * - Zero production Telegram publication.
 * - EXTERNAL_PUBLISH_ENABLED=false
 * - AVSEE_DRY_RUN=true
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { runAutomatedFlow } = require("./avsee/automated_flow");
const { discoverBoardPosts, filterNewPosts } = require("./avsee/board_discovery");
const { AvseePipelineOrchestrator } = require("./avsee/pipeline_orchestrator");
const { ExternalSourceState } = require("./external_source_state");

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
 * Creates mock board server
 */
function createMockBoardServer(port = 9248) {
  const mp4Buffer = buildLongFormH264Mp4(1800, 720, 1280, 30);
  const shortMp4 = buildLongFormH264Mp4(20, 720, 1280, 30);

  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url, `http://127.0.0.1:${port}`);

    // Board page or Detail page
    if (parsed.pathname === "/bbs/board.php") {
      const wrId = parsed.searchParams.get("wr_id");

      // Detail post 9001
      if (wrId === "9001") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><title>#myanmar Northern Women Exclusive Feature</title></head>
          <body>
            <div class="view-wrap">
              <h1>#myanmar Northern Women Exclusive Feature</h1>
              <iframe id="player" src="/player.php?id=9001&bcdn_token=AUTH_9001" width="720" height="1280"></iframe>
            </div>
          </body>
          </html>
        `);
        return;
      }

      // Detail post 9002
      if (wrId === "9002") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><title>Evergrande Troupe Performance Special</title></head>
          <body>
            <div class="view-wrap">
              <h1>Evergrande Troupe Performance Special</h1>
              <iframe id="player" src="/player.php?id=9002&bcdn_token=AUTH_9002" width="720" height="1280"></iframe>
            </div>
          </body>
          </html>
        `);
        return;
      }

      const mode = parsed.searchParams.get("mode") || "normal";

      if (mode === "empty") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html><html><body><div class="list-wrap"><p>No posts available</p></div></body></html>`);
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Authorized Board Listings</title></head>
        <body>
          <div class="list-wrap">
            <div class="item-row">
              <a href="/bbs/board.php?bo_table=korea&wr_id=9001" class="wr-subject">#myanmar Northern Women Exclusive Feature</a>
              <span class="sp-date">2026-09-10 14:00</span>
            </div>
            <div class="item-row">
              <a href="/bbs/board.php?bo_table=korea&wr_id=9002" class="wr-subject">Evergrande Troupe Performance Special</a>
              <span class="sp-date">2026-09-10 13:30</span>
            </div>
          </div>
        </body>
        </html>
      `);
      return;
    }

    // Player embed
    if (parsed.pathname === "/player.php") {
      const mode = parsed.searchParams.get("mode");
      const id = parsed.searchParams.get("id");
      const streamUrl = mode === "mismatch" ? "/stream/short.mp4" : (mode === "corrupt" ? "/stream/corrupt.mp4" : `/stream/video_${id}.mp4`);

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`
        <!DOCTYPE html>
        <html>
        <body style="margin:0;background:#000;">
          <video id="html5_v" width="720" height="1280" controls src="${streamUrl}?bcdn_token=AUTH_OK&expires=1799999999"></video>
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
        "Content-Length": mp4Buffer.length,
        "Accept-Ranges": "bytes"
      });
      res.end(mp4Buffer);
      return;
    }

    if (parsed.pathname === "/stream/short.mp4") {
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": shortMp4.length });
      res.end(shortMp4);
      return;
    }

    if (parsed.pathname === "/stream/corrupt.mp4") {
      res.writeHead(200, { "Content-Type": "video/mp4" });
      res.end(Buffer.from([0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70]));
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

async function runAutomatedFlowTests() {
  console.log("============================================================");
  console.log("🧪 STARTING AUTOMATED MEDIA RESOLUTION FLOW TESTS");
  console.log("============================================================");

  const testPort = 9248;
  const { server } = await createMockBoardServer(testPort);
  const tempDir = path.join(__dirname, "scratch", "auto_flow_temp_" + Date.now());
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tempDir, { recursive: true });

  const boardUrl = `http://127.0.0.1:${testPort}/bbs/board.php?bo_table=korea`;

  const orchestrator = new AvseePipelineOrchestrator({
    dryRun: true,
    tempDir: tempDir,
    stateFilePath: path.join(tempDir, "auto_state.json"),
    apiUrl: `http://127.0.0.1:${testPort}`,
    allowedDomains: ["127.0.0.1", "localhost", "data.cdn.avsee.is"]
  });

  let flowResult = null;

  try {
    // -----------------------------------------------------------------
    // TEST 1: End-to-End Automated Flow (Board -> Discovery -> Player -> Download -> Ledger)
    // -----------------------------------------------------------------
    console.log("\n--- [1] Full Automated Board Discovery & Resolution Flow ---");
    flowResult = await runAutomatedFlow(boardUrl, {
      orchestrator,
      discoveryTimeoutMs: 15000,
      postTimeoutMs: 15000,
      playerTimeoutMs: 10000
    });

    console.log("\nAutomated Flow Diagnostics:\n" + flowResult.diagnosticsText);

    assert(flowResult.success === true, "Automated flow succeeded (success: true)");
    assert(flowResult.discoveryPass === true, "Board discovery: PASS");
    assert(flowResult.totalDiscovered === 2, `Total discovered posts: ${flowResult.totalDiscovered}`);
    assert(flowResult.newPostsFound === 2, `New un-seen posts found: ${flowResult.newPostsFound}`);
    assert(flowResult.selectedPostId === "korea_9001", `Selected first new post: ${flowResult.selectedPostId}`);

    const pr = flowResult.pipelineResult;
    assert(pr.playerResolverPass === true, "Player Resolver: PASS");
    assert(pr.mediaUrlResolved === true, "Media Source Found: true");
    assert(pr.downloadPass === true, "Authorized Download: PASS");
    assert(pr.mp4ValidationPass === true, "Deep MP4 Validation: PASS");
    assert(pr.playerDuration === 1800, `Player duration: ${pr.playerDuration}s`);
    assert(pr.downloadedDuration === 1800, `Downloaded duration: ${pr.downloadedDuration}s`);
    assert(pr.durationDelta === 0, `Duration delta: ${pr.durationDelta}s`);
    assert(pr.normalizationPass === true, "Normalization: PASS");
    assert(pr.classificationPass === true, "Classification: PASS");
    assert(pr.routingPass === true, "Routing: PASS");
    assert(pr.dedupeCheckPass === true, "Dedupe Check: PASS");
    assert(pr.ledgerDecision === "DRY_RUN", `Ledger: ${pr.ledgerDecision}`);
    assert(pr.telegramPublish === "SKIPPED", `Telegram: ${pr.telegramPublish}`);

    // -----------------------------------------------------------------
    // TEST 2: Second Run with Remaining Un-seen Post
    // -----------------------------------------------------------------
    console.log("\n--- [2] Second Run Processes Next Un-seen Post (korea_9002) ---");
    const flow2 = await runAutomatedFlow(boardUrl, {
      orchestrator,
      discoveryTimeoutMs: 15000,
      postTimeoutMs: 15000
    });
    assert(flow2.success === true, "Second run succeeded");
    assert(flow2.newPostsFound === 1, `Remaining new post count: ${flow2.newPostsFound}`);
    assert(flow2.selectedPostId === "korea_9002", `Selected next new post: ${flow2.selectedPostId}`);

    // -----------------------------------------------------------------
    // TEST 3: Third Run — No New Posts (All in Ledger)
    // -----------------------------------------------------------------
    console.log("\n--- [3] Third Run — All Posts Already Seen (No New Posts) ---");
    const flow3 = await runAutomatedFlow(boardUrl, {
      orchestrator,
      discoveryTimeoutMs: 15000
    });
    assert(flow3.success === true, "Run with no new posts completes safely");
    assert(flow3.newPostsFound === 0, "newPostsFound is 0");
    assert(flow3.status === "NO_NEW_POSTS", "Status is NO_NEW_POSTS");

    // -----------------------------------------------------------------
    // TEST 4: Empty Board Handling
    // -----------------------------------------------------------------
    console.log("\n--- [4] Empty Board Page Handling ---");
    const emptyBoardUrl = `http://127.0.0.1:${testPort}/bbs/board.php?mode=empty`;
    const emptyFlow = await runAutomatedFlow(emptyBoardUrl, {
      orchestrator,
      discoveryTimeoutMs: 10000
    });
    assert(emptyFlow.success === true, "Empty board handled cleanly");
    assert(emptyFlow.totalDiscovered === 0, "totalDiscovered is 0");
    assert(emptyFlow.newPostsFound === 0, "newPostsFound is 0");

    // -----------------------------------------------------------------
    // TEST 5: Unreachable Board URL Handling
    // -----------------------------------------------------------------
    console.log("\n--- [5] Unreachable Board URL Failure Handling ---");
    const unreachableUrl = `http://127.0.0.1:9998/bbs/board.php`;
    const unreachFlow = await runAutomatedFlow(unreachableUrl, {
      orchestrator,
      discoveryTimeoutMs: 3000
    });
    assert(unreachFlow.success === false, "Unreachable board returns success: false");
    assert(unreachFlow.discoveryPass === false, "discoveryPass is false");

  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (e) {}
    }
  }

  console.log("\n============================================================");
  console.log("📊 REQUIRED AUTOMATED FLOW DIAGNOSTIC OUTPUT");
  console.log("============================================================");
  if (flowResult && flowResult.pipelineResult) {
    console.log(flowResult.diagnosticsText);
  }
  console.log("============================================================");
  console.log(`Total tests: ${passCount + failCount}, Passed: ${passCount}, Failed: ${failCount}`);

  if (failCount > 0) {
    process.exit(1);
  }
}

runAutomatedFlowTests().catch((err) => {
  console.error("Fatal automated flow test error:", err);
  process.exit(1);
});
