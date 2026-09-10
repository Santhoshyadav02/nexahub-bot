/**
 * ============================================================
 * 🧪 STAGE 3 INTEGRATION TEST SUITE: END-TO-END PIPELINE
 * ============================================================
 * Validates the complete pipeline:
 * Discovery -> Resolver -> Downloader -> MP4 Validation ->
 * Normalization -> Classification -> Routing -> Dedupe -> Dry-Run Publisher.
 * 
 * Safety & Compliance:
 * - Uses ONLY the authorized 30-minute H.264 test vector.
 * - EXTERNAL_PUBLISH_ENABLED=false
 * - AVSEE_DRY_RUN=true
 * - Zero production Telegram traffic.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { AvseePipelineOrchestrator, PIPELINE_STATES } = require("./avsee/pipeline_orchestrator");
const { validateMp4 } = require("./avsee/mp4_validator");
const { redactUrl } = require("./avsee/player_resolver");

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
 * Creates Stage 3 HTTP test server
 */
function createStage3TestServer(port = 9247) {
  const mp4Buffer = buildLongFormH264Mp4(1800, 720, 1280, 30);
  const shortMp4Buffer = buildLongFormH264Mp4(30, 720, 1280, 30); // 30s short duration for mismatch test

  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url, `http://127.0.0.1:${port}`);

    // Main Myanmar topic post
    if (parsed.pathname === "/myanmar_post") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Myanmar Northern Women Exclusive</title></head>
        <body>
          <div class="view-wrap">
            <h1>Myanmar Northern Women Exclusive Special</h1>
            <div id="view_content">
              <iframe id="player_iframe" src="/player.php?id=myanmar_1001&bcdn_token=SECRET_AUTH_TOKEN_ABC" width="720" height="1280"></iframe>
            </div>
          </div>
        </body>
        </html>
      `);
      return;
    }

    // Player iframe
    if (parsed.pathname === "/player.php") {
      const mode = parsed.searchParams.get("mode") || "normal";
      const streamPath = mode === "mismatch" ? "/stream/short_30s.mp4" : (mode === "corrupt" ? "/stream/corrupt.mp4" : "/stream/video_1800s.mp4");
      const playerDuration = mode === "mismatch" ? 1800 : 1800; // Player reports 1800, but stream is 30s in mismatch mode

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`
        <!DOCTYPE html>
        <html>
        <body style="margin:0;background:#000;">
          <video id="v" width="720" height="1280" controls src="${streamPath}?bcdn_token=SECRET_AUTH_TOKEN_ABC&expires=1799999999"></video>
          <script>
            const v = document.getElementById('v');
            Object.defineProperty(v, 'duration', { value: ${playerDuration}, writable: false });
            Object.defineProperty(v, 'videoWidth', { value: 720, writable: false });
            Object.defineProperty(v, 'videoHeight', { value: 1280, writable: false });
            Object.defineProperty(v, 'readyState', { value: 4, writable: false });
          </script>
        </body>
        </html>
      `);
      return;
    }

    // Normal 1800s media stream
    if (parsed.pathname === "/stream/video_1800s.mp4") {
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": mp4Buffer.length,
        "Accept-Ranges": "bytes"
      });
      res.end(mp4Buffer);
      return;
    }

    // 30s media stream for duration mismatch test
    if (parsed.pathname === "/stream/short_30s.mp4") {
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": shortMp4Buffer.length,
        "Accept-Ranges": "bytes"
      });
      res.end(shortMp4Buffer);
      return;
    }

    // Corrupt stream
    if (parsed.pathname === "/stream/corrupt.mp4") {
      res.writeHead(200, { "Content-Type": "video/mp4" });
      res.end(Buffer.from([0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70]));
      return;
    }

    // Post with failing resolver (no iframe)
    if (parsed.pathname === "/no_player_post") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><html><body><h1>No player here</h1></body></html>`);
      return;
    }

    // Post with failing download
    if (parsed.pathname === "/failing_download_post") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`
        <!DOCTYPE html>
        <html><body><iframe src="/player_500.php"></iframe></body></html>
      `);
      return;
    }

    if (parsed.pathname === "/player_500.php") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`
        <!DOCTYPE html>
        <html><body>
          <video id="v" src="/stream/500_error.mp4"></video>
          <script>
            const v = document.getElementById('v');
            Object.defineProperty(v, 'duration', { value: 1800, writable: false });
            Object.defineProperty(v, 'readyState', { value: 4, writable: false });
          </script>
        </body></html>
      `);
      return;
    }

    if (parsed.pathname === "/stream/500_error.mp4") {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Server Error");
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

async function runStage3Tests() {
  console.log("============================================================");
  console.log("🧪 STARTING STAGE 3 INTEGRATED PIPELINE TESTS");
  console.log("============================================================");

  const testPort = 9247;
  const { server, mp4Buffer } = await createStage3TestServer(testPort);
  const tempDir = path.join(__dirname, "scratch", "stage3_temp_" + Date.now());
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tempDir, { recursive: true });

  const orchestrator = new AvseePipelineOrchestrator({
    dryRun: true,
    tempDir: tempDir,
    stateFilePath: path.join(tempDir, "stage3_state.json"),
    apiUrl: `http://127.0.0.1:${testPort}`,
    allowedDomains: ["127.0.0.1", "localhost", "data.cdn.avsee.is"]
  });

  let e2eResult = null;

  try {
    // -----------------------------------------------------------------
    // TEST 1: Full E2E Integration (30-Minute Authorized Post)
    // -----------------------------------------------------------------
    console.log("\n--- [1] Full End-to-End Authorized Pipeline Run ---");
    const validPost = {
      itemId: "myanmar_1001",
      id: "myanmar_1001",
      title: "Myanmar Northern Women Exclusive Special Feature",
      pageUrl: `http://127.0.0.1:${testPort}/myanmar_post`,
      description: "Exclusive report on Myanmar women daily stories",
      tags: ["#myanmar", "special", "documentary"]
    };

    e2eResult = await orchestrator.processAuthorizedPost(validPost, {
      pageTimeoutMs: 15000,
      playerTimeoutMs: 10000
    });

    console.log("Orchestrator Result Diagnostics:", JSON.stringify(e2eResult.diagnostics, null, 2));

    assert(e2eResult.postDiscoveryPass === true, "1. Post Discovery: PASS");
    assert(e2eResult.playerResolverPass === true, "2. Player Resolver: PASS");
    assert(e2eResult.mediaUrlResolved === true, "3. Media URL Resolved: true");
    assert(e2eResult.downloadPass === true, "4. Authorized Downloader: PASS");
    assert(e2eResult.mp4ValidationPass === true, "5. Deep MP4 Validation: PASS");
    assert(e2eResult.playerDuration === 1800, `6. Player Duration: ${e2eResult.playerDuration}s`);
    assert(e2eResult.downloadedDuration === 1800, `7. Downloaded Duration: ${e2eResult.downloadedDuration}s`);
    assert(e2eResult.durationDelta === 0, `8. Duration Delta: ${e2eResult.durationDelta}s`);
    assert(e2eResult.normalizationPass === true, "9. Normalization: PASS");
    assert(e2eResult.classificationPass === true, "10. Classification: PASS");
    assert(e2eResult.routingPass === true, "11. 10-Channel Routing: PASS");
    assert(e2eResult.dedupeCheckPass === true, "12. Dedupe Check: PASS");
    assert(e2eResult.ledgerDecision === "DRY_RUN", `13. Ledger Decision: ${e2eResult.ledgerDecision}`);
    assert(e2eResult.telegramPublish === "SKIPPED", `14. Telegram Publish: ${e2eResult.telegramPublish}`);
    assert(e2eResult.success === true, "15. Final Result: PASS");

    // Check specific classification & destination mapping
    assert(e2eResult.classification.topicKey === "Myanmar", `Matched Topic: ${e2eResult.classification.topicKey} (Card ${e2eResult.classification.cardNum})`);
    assert(e2eResult.destination.destinationChannelId === "-1002000000001", `Routed to DESTINATION_1: ${e2eResult.destination.destinationChannelId}`);

    // -----------------------------------------------------------------
    // TEST 2: Duplicate Prevention
    // -----------------------------------------------------------------
    console.log("\n--- [2] Duplicate Prevention & Persistent Ledger ---");
    const dupResult = await orchestrator.processAuthorizedPost(validPost, {
      pageTimeoutMs: 15000,
      playerTimeoutMs: 10000
    });
    assert(dupResult.isDuplicate === true, "Duplicate post is identified (isDuplicate: true)");
    assert(dupResult.ledgerDecision === "SKIPPED_DUPLICATE", "Duplicate ledger decision is SKIPPED_DUPLICATE");
    assert(dupResult.telegramPublish === "SKIPPED", "Duplicate telegram publish is SKIPPED");

    // -----------------------------------------------------------------
    // TEST 3: Resolver Failure Stops Pipeline
    // -----------------------------------------------------------------
    console.log("\n--- [3] Resolver Failure Stops Pipeline ---");
    const failResolverPost = {
      itemId: "fail_res_1",
      title: "No Player Post",
      pageUrl: `http://127.0.0.1:${testPort}/no_player_post`
    };
    const failRes = await orchestrator.processAuthorizedPost(failResolverPost);
    assert(failRes.success === false, "Resolver failure stops pipeline (success: false)");
    assert(failRes.pipelineState === PIPELINE_STATES.RESOLVER_FAILED, `State is RESOLVER_FAILED (${failRes.pipelineState})`);
    assert(failRes.downloadPass === false, "Download was NOT attempted");

    // -----------------------------------------------------------------
    // TEST 4: Download Failure Stops Pipeline
    // -----------------------------------------------------------------
    console.log("\n--- [4] Download Failure Stops Pipeline ---");
    const failDlPost = {
      itemId: "fail_dl_1",
      title: "Failing Download Post",
      pageUrl: `http://127.0.0.1:${testPort}/failing_download_post`
    };
    const failDlRes = await orchestrator.processAuthorizedPost(failDlPost);
    assert(failDlRes.success === false, "Download failure stops pipeline (success: false)");
    assert(failDlRes.pipelineState === PIPELINE_STATES.DOWNLOAD_FAILED, `State is DOWNLOAD_FAILED (${failDlRes.pipelineState})`);
    assert(failDlRes.mp4ValidationPass === false, "MP4 validation was NOT attempted");

    // -----------------------------------------------------------------
    // TEST 5: Duration Mismatch Stops Pipeline
    // -----------------------------------------------------------------
    console.log("\n--- [5] Duration Mismatch Stops Pipeline ---");
    const mismatchServerUrl = `http://127.0.0.1:${testPort}/player.php?mode=mismatch`;
    const mismatchPostObj = {
      itemId: "mismatch_1",
      title: "Mismatch Post",
      pageUrl: mismatchServerUrl
    };
    const mismatchRes = await orchestrator.processAuthorizedPost(mismatchPostObj);
    assert(mismatchRes.success === false, "Duration mismatch stops pipeline (success: false)");
    assert(mismatchRes.pipelineState === PIPELINE_STATES.DURATION_MISMATCH, `State is DURATION_MISMATCH (${mismatchRes.pipelineState})`);
    assert(mismatchRes.normalizationPass === false, "Normalization was NOT attempted after mismatch");

    // -----------------------------------------------------------------
    // TEST 6: Invalid MP4 Stops Pipeline
    // -----------------------------------------------------------------
    console.log("\n--- [6] Corrupt MP4 Stops Pipeline ---");
    const corruptServerUrl = `http://127.0.0.1:${testPort}/player.php?mode=corrupt`;
    const corruptPostObj = {
      itemId: "corrupt_1",
      title: "Corrupt MP4 Post",
      pageUrl: corruptServerUrl
    };
    const corruptRes = await orchestrator.processAuthorizedPost(corruptPostObj);
    assert(corruptRes.success === false, "Corrupt MP4 stops pipeline (success: false)");
    assert(corruptRes.pipelineState === PIPELINE_STATES.MP4_VALIDATION_FAILED, `State is MP4_VALIDATION_FAILED (${corruptRes.pipelineState})`);

    // -----------------------------------------------------------------
    // TEST 7: Failed Items Never Become DELIVERED
    // -----------------------------------------------------------------
    console.log("\n--- [7] Failed Item Never Marked Delivered in State ---");
    const hasSeenFailed = orchestrator.stateStore.hasSeen({ itemId: "fail_res_1" });
    assert(hasSeenFailed === false, "Failed item is NOT recorded in stateStore");

    // -----------------------------------------------------------------
    // TEST 8: DRY_RUN Flag Enforced
    // -----------------------------------------------------------------
    console.log("\n--- [8] DRY_RUN Mode Enforced ---");
    assert(orchestrator.dryRun === true, "Orchestrator dryRun is true");
    assert(process.env.EXTERNAL_PUBLISH_ENABLED !== "true", "EXTERNAL_PUBLISH_ENABLED is false");

  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (e) {}
    }
  }

  console.log("\n============================================================");
  console.log("📊 DRY-RUN OUTPUT SUMMARY");
  console.log("============================================================");
  const isAllPass = failCount === 0 && e2eResult && e2eResult.success;

  console.log(`POST_DISCOVERY=${e2eResult && e2eResult.postDiscoveryPass ? "PASS" : "FAIL"}`);
  console.log(`PLAYER_RESOLVER=${e2eResult && e2eResult.playerResolverPass ? "PASS" : "FAIL"}`);
  console.log(`MEDIA_URL_RESOLVED=${e2eResult && e2eResult.mediaUrlResolved ? "true" : "false"}`);
  console.log(`DOWNLOAD=${e2eResult && e2eResult.downloadPass ? "PASS" : "FAIL"}`);
  console.log(`MP4_VALIDATION=${e2eResult && e2eResult.mp4ValidationPass ? "PASS" : "FAIL"}`);
  console.log(`PLAYER_DURATION=${e2eResult ? e2eResult.playerDuration : 0}`);
  console.log(`DOWNLOADED_DURATION=${e2eResult ? e2eResult.downloadedDuration : 0}`);
  console.log(`DURATION_DELTA=${e2eResult ? e2eResult.durationDelta : 0}`);
  console.log(`NORMALIZATION=${e2eResult && e2eResult.normalizationPass ? "PASS" : "FAIL"}`);
  console.log(`CLASSIFICATION=${e2eResult && e2eResult.classificationPass ? "PASS" : "FAIL"}`);
  console.log(`ROUTING=${e2eResult && e2eResult.routingPass ? "PASS" : "FAIL"}`);
  console.log(`DEDUPE_CHECK=${e2eResult && e2eResult.dedupeCheckPass ? "PASS" : "FAIL"}`);
  console.log(`LEDGER_DECISION=${e2eResult ? e2eResult.ledgerDecision : "NONE"}`);
  console.log(`TELEGRAM_PUBLISH=${e2eResult ? e2eResult.telegramPublish : "SKIPPED"}`);
  console.log(`FINAL_RESULT=${isAllPass ? "PASS" : "FAIL"}`);
  console.log("============================================================");
  console.log(`Total tests: ${passCount + failCount}, Passed: ${passCount}, Failed: ${failCount}`);

  if (failCount > 0) {
    process.exit(1);
  }
}

runStage3Tests().catch((err) => {
  console.error("Fatal Stage 3 test runner error:", err);
  process.exit(1);
});
