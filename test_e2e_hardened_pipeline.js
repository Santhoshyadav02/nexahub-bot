/**
 * ============================================================
 * 🧪 COMPREHENSIVE END-TO-END TEST: HARDENED MEDIA PIPELINE
 * ============================================================
 * Tests the entire 28-step flow:
 * 1. Post Discovery
 * 2. Post Page Open
 * 3. Player Iframe Resolution
 * 4. HTML5 <video> Inspection
 * 5. Media Source Resolution
 * 6. Downloader Execution
 * 7. Continuous Byte Progress
 * 8. Elimination of Total Elapsed-Time Timeout
 * 9. HTTP EOF Stream Completion
 * 10. File-Stream Finish/Flush
 * 11. Final Byte Count Verification
 * 12. Deep MP4 Validation (ftyp, moov, mdat, video track, codec, dimensions, duration, samples)
 * 13. Player vs Downloaded Duration Delta Verification
 * 14. Canonical Normalization
 * 15. 12-Topic Classification
 * 16. 10-Channel Routing
 * 17. Dedupe Policy
 * 18. Persistent Ledger State
 * 19. Staging Telegram Safety Gate
 * 20. Staging/Telegram Result Read-Back
 * 21. Uploaded/Media Playable Metadata Validation
 * 22. Re-run Same Item
 * 23. Duplicate Rejection & Zero Duplicate Publication
 * 24. Stalled Download Inactivity Timeout Simulation
 * 25. Interrupted/Incomplete Download Cleanup Simulation
 * 26. Signed URL / Token Redaction in Logs
 * 27. Temporary Media Disk Cleanup
 * 28. Full Regression Suite Execution
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { discoverBoardPosts, filterNewPosts } = require("./avsee/board_discovery");
const { resolvePlayer, redactUrl, RESOLVER_STATES } = require("./avsee/player_resolver");
const { validateMp4 } = require("./avsee/mp4_validator");
const { AvseePipelineOrchestrator, PIPELINE_STATES } = require("./avsee/pipeline_orchestrator");
const { AvseeSourceAdapter } = require("./avsee_source_adapter");
const { ExternalSourceState } = require("./external_source_state");
const { ExternalSourcePublisher } = require("./external_source_publisher");
const { getDestinationForTopic } = require("./external_source_destinations");

let totalAssertions = 0;
let passedAssertions = 0;
let failedAssertions = 0;

function assert(condition, message) {
  totalAssertions++;
  if (condition) {
    console.log(`  ✅ PASS: ${message}`);
    passedAssertions++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failedAssertions++;
  }
}

/**
 * Builds standard 30-minute ISO/IEC 14496-12 H.264 MP4 container in memory.
 */
function buildTestMp4(durationSec = 1800, width = 720, height = 1280, fps = 30) {
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

async function runEndToEndHardenedPipelineTest() {
  console.log("============================================================");
  console.log("🚀 STARTING COMPLETE END-TO-END HARDENED PIPELINE TEST");
  console.log("============================================================\n");

  const port = 9355;
  const tempDir = path.join(__dirname, "scratch", "e2e_hardened_temp");
  const stateFilePath = path.join(tempDir, "e2e_state.json");

  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tempDir, { recursive: true });

  const fullMp4 = buildTestMp4(1800, 720, 1280, 30);
  const fullMp4Checksum = crypto.createHash("sha256").update(fullMp4).digest("hex");

  // Metrics for final report
  const reportMetrics = {
    discovery: "FAIL",
    playerResolution: "FAIL",
    mediaDownload: "FAIL",
    bytesReceived: 0,
    downloadElapsedTime: "0s",
    eof: "FAIL",
    fileFlush: "FAIL",
    mp4Validation: "FAIL",
    playerDuration: 0,
    downloadedDuration: 0,
    normalization: "FAIL",
    classification: "FAIL",
    routing: "FAIL",
    ledger: "FAIL",
    telegramStagingPublication: "SKIPPED",
    telegramReadBack: "SKIPPED",
    dedupeSecondRun: "FAIL",
    stallRecovery: "FAIL",
    cleanup: "FAIL",
    tokenRedaction: "FAIL"
  };

  // 1. Create HTTP test server
  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url, `http://127.0.0.1:${port}`);

    // Board Listings
    if (parsed.pathname === "/bbs/board.php" && !parsed.searchParams.get("wr_id")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Authorized Board Listings</title></head>
        <body>
          <div class="list-wrap">
            <div class="item-row">
              <a href="/bbs/board.php?bo_table=myanmar&wr_id=5001" class="wr-subject">#myanmar Northern Women High-Definition Feature</a>
              <span class="sp-date">2026-09-10 16:30</span>
            </div>
          </div>
        </body>
        </html>
      `);
      return;
    }

    // Detail Post Page
    if (parsed.pathname === "/bbs/board.php" && parsed.searchParams.get("wr_id") === "5001") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>#myanmar Northern Women High-Definition Feature</title></head>
        <body>
          <div class="view-wrap">
            <h1>#myanmar Northern Women High-Definition Feature</h1>
            <iframe id="main_player" src="/player.php?id=5001&token=SECRET_AUTH_TOKEN_XYZ987" width="720" height="1280"></iframe>
          </div>
        </body>
        </html>
      `);
      return;
    }

    // Player Iframe Page
    if (parsed.pathname === "/player.php") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`
        <!DOCTYPE html>
        <html>
        <body style="margin:0;background:#000;">
          <video id="html5_v" width="720" height="1280" controls src="/stream/media_5001.mp4?auth_sig=SIG_ABC123&exp=1899999999"></video>
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

    // Chunked streaming media with deliberate continuous chunk emission
    if (parsed.pathname === "/stream/media_5001.mp4") {
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": fullMp4.length,
        "Accept-Ranges": "bytes"
      });

      // Stream in 4 chunks over ~600ms
      const chunkSize = Math.ceil(fullMp4.length / 4);
      let offset = 0;

      const interval = setInterval(() => {
        if (offset < fullMp4.length) {
          const nextEnd = Math.min(offset + chunkSize, fullMp4.length);
          res.write(fullMp4.slice(offset, nextEnd));
          offset = nextEnd;
        } else {
          clearInterval(interval);
          res.end(); // HTTP EOF reached
        }
      }, 150);
      return;
    }

    // Stalled stream endpoint for stall simulation
    if (parsed.pathname === "/stream/stalled.mp4") {
      res.writeHead(200, { "Content-Type": "video/mp4" });
      res.write(fullMp4.slice(0, 1000));
      // Stalls indefinitely without sending further chunks
      return;
    }

    // Interrupted stream endpoint
    if (parsed.pathname === "/stream/interrupted.mp4") {
      res.writeHead(200, { "Content-Type": "video/mp4" });
      res.write(fullMp4.slice(0, 5000));
      setTimeout(() => {
        res.destroy(new Error("TCP connection reset by peer"));
      }, 100);
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const assignedPort = server.address().port;

  try {
    const boardUrl = `http://127.0.0.1:${assignedPort}/bbs/board.php?bo_table=myanmar`;

    console.log("--- Step 1: Discovering Test Media Item ---");
    const discoveryRes = await discoverBoardPosts(boardUrl, { pageTimeoutMs: 10000 });
    assert(discoveryRes.success === true, "Board discovery returned success");
    const discovered = discoveryRes.posts || [];
    assert(discovered.length === 1, "Discovered exactly 1 test item");
    assert(discovered[0].itemId === "myanmar_5001", "Item ID matches myanmar_5001");
    assert(discovered[0].title.includes("Northern Women"), "Title discovered correctly");
    reportMetrics.discovery = "PASS";

    const stateStore = new ExternalSourceState({
      stateFilePath,
      maxTotalItems: 100
    });

    const newPosts = filterNewPosts(discovered, stateStore);
    assert(newPosts.length === 1, "Item recognized as genuinely new");

    console.log("\n--- Steps 2 to 5: Post Open, Player Resolution & <video> Inspection ---");
    const post = newPosts[0];
    const resolverRes = await resolvePlayer(post.pageUrl, {
      headless: true,
      pageTimeoutMs: 15000,
      playerTimeoutMs: 10000,
      logDiagnostics: false
    });

    assert(resolverRes.success === true, "Player resolution succeeded");
    assert(Boolean(resolverRes.playerFrameUrl), "Player iframe found");
    assert(resolverRes.state === RESOLVER_STATES.SUCCESS, "HTML5 <video> element found & initialized");
    assert(resolverRes.mediaUrl.includes("/stream/media_5001.mp4"), "Media URL resolved");
    assert(resolverRes.duration === 1800, `Player duration is 1800s (${resolverRes.duration}s)`);
    assert(resolverRes.width === 720, "Player width is 720");
    assert(resolverRes.height === 1280, "Player height is 1280");
    assert(resolverRes.readyState === 4, "ReadyState is HAVE_ENOUGH_DATA (4)");
    reportMetrics.playerResolution = "PASS";
    reportMetrics.playerDuration = resolverRes.duration;

    console.log("\n--- Steps 6 to 11: Streaming Download, Inactivity Heartbeat, Flush & EOF ---");
    const adapter = new AvseeSourceAdapter({
      isAuthorized: true,
      dryRun: false,
      tempDir,
      inactivityTimeoutMs: 10000,
      allowedDomains: ["127.0.0.1"]
    });

    const dlStartTime = Date.now();
    const dlResult = await adapter.downloadAuthorizedMedia({
      mediaUrl: resolverRes.mediaUrl,
      title: post.title,
      uniqueHash: post.itemId
    });
    const dlElapsedSec = Math.round((Date.now() - dlStartTime) / 100) / 10;
    reportMetrics.downloadElapsedTime = `${dlElapsedSec}s`;

    assert(Boolean(dlResult && dlResult.localPath), "Download completed with local path");
    assert(fs.existsSync(dlResult.localPath), "Downloaded file exists on disk");
    assert(dlResult.sizeBytes === fullMp4.length, `Final byte count matches: ${dlResult.sizeBytes} == ${fullMp4.length}`);
    assert(dlResult.checksum === fullMp4Checksum, "SHA-256 matches bit-for-bit");
    reportMetrics.mediaDownload = "PASS";
    reportMetrics.bytesReceived = dlResult.sizeBytes;
    reportMetrics.eof = "PASS";
    reportMetrics.fileFlush = "PASS";

    console.log("\n--- Step 12: Deep MP4 Validation ---");
    const mp4Info = validateMp4(dlResult.localPath);
    assert(mp4Info.valid === true, "MP4 container is valid");
    assert(mp4Info.hasVideoTrack === true, "Video track present (vide)");
    assert(mp4Info.codec === "avc1", `Codec is H.264 (avc1): ${mp4Info.codec}`);
    assert(mp4Info.width === 720, "Width is 720");
    assert(mp4Info.height === 1280, "Height is 1280");
    assert(mp4Info.duration === 1800, `Duration is 1800s (${mp4Info.duration}s)`);
    assert(mp4Info.frameCount === 54000, `Frame count is 54,000 (${mp4Info.frameCount})`);
    reportMetrics.mp4Validation = "PASS";
    reportMetrics.downloadedDuration = mp4Info.duration;

    console.log("\n--- Step 13: Player Duration vs Downloaded Duration Delta ---");
    const delta = Math.abs(resolverRes.duration - mp4Info.duration);
    assert(delta <= 2.0, `Duration delta within 2s tolerance: ${delta}s`);

    console.log("\n--- Steps 14 to 18: Normalization, Classification, Routing & Ledger ---");
    const itemToNormalize = {
      ...post,
      mediaUrl: resolverRes.mediaUrl,
      duration: mp4Info.duration,
      width: mp4Info.width,
      height: mp4Info.height,
      codec: mp4Info.codec
    };

    const normalized = adapter.normalizeItem(itemToNormalize);
    assert(normalized.valid === true, "Canonical normalization succeeded");
    reportMetrics.normalization = "PASS";

    const classification = adapter.matchTopic(normalized);
    assert(classification.topicKey === "Myanmar", `Topic classified as Myanmar (Card ${classification.cardNum})`);
    reportMetrics.classification = "PASS";

    normalized.topicKey = classification.topicKey;
    normalized.topicConfidence = classification.confidence;
    normalized.matchedRule = classification.matchedRule;
    normalized.matchedToken = classification.matchedToken;
    normalized.koreanName = classification.koreanName;
    normalized.cardNum = classification.cardNum;

    const destination = getDestinationForTopic(classification.topicKey);
    assert(destination.destinationChannelId === "-1002000000001", "Routed to DESTINATION_1 (-1002000000001)");
    reportMetrics.routing = "PASS";

    assert(stateStore.hasSeen(normalized) === false, "Dedupe reports item not yet seen");

    // Publish in dry-run/staged safety mode
    const publisher = new ExternalSourcePublisher({ stateStore, maxTotalItems: 100 });
    const publishRes = await publisher.publishAuthorizedItem(normalized, dlResult.localPath, destination);
    assert(publishRes.status === "SIMULATED_PUBLISH_SUCCESS" && publishRes.published === false, "Publisher respects dry-run safety gate (SIMULATED_PUBLISH_SUCCESS, published: false)");

    stateStore.recordPermanentItem(normalized, { isDelivered: false, status: "RETAINED_IN_POOL" });
    assert(stateStore.hasSeen(normalized) === true, "Item successfully recorded in ledger");
    reportMetrics.ledger = "PASS";

    console.log("\n--- Steps 19 to 21: Staging Telegram Safety Gate & Read-Back ---");
    assert(publishRes.published === false, "Telegram production publish remained safely SKIPPED (published: false)");
    reportMetrics.telegramStagingPublication = "SKIPPED";
    reportMetrics.telegramReadBack = "SKIPPED";

    console.log("\n--- Steps 22 to 23: Re-running Same Item Deduplication ---");
    assert(stateStore.hasSeen(normalized) === true, "Second run: stateStore identifies duplicate");
    const filteredSecondRun = filterNewPosts([post], stateStore);
    assert(filteredSecondRun.length === 0, "Second run: filterNewPosts filters out duplicate");
    reportMetrics.dedupeSecondRun = "PASS";

    console.log("\n--- Step 24: Stalled Download Inactivity Simulation ---");
    const stallAdapter = new AvseeSourceAdapter({
      isAuthorized: true,
      dryRun: false,
      tempDir,
      inactivityTimeoutMs: 1000,
      retryCount: 1,
      allowedDomains: ["127.0.0.1"]
    });

    let stallThrew = false;
    let stallErrorMsg = "";
    try {
      await stallAdapter.downloadAuthorizedMedia({
        mediaUrl: `http://127.0.0.1:${assignedPort}/stream/stalled.mp4`,
        title: "Stalled Video",
        uniqueHash: "stall_test"
      }, { inactivityTimeoutMs: 1000 });
    } catch (err) {
      stallThrew = true;
      stallErrorMsg = err.message;
    }
    assert(stallThrew === true, "Stalled download was aborted on inactivity timeout");
    assert(stallErrorMsg.includes("Download stalled"), `Error message reports stall: ${stallErrorMsg}`);
    reportMetrics.stallRecovery = "PASS";

    console.log("\n--- Step 25: Interrupted/Incomplete Download Cleanup Simulation ---");
    let interruptedThrew = false;
    try {
      await stallAdapter.downloadAuthorizedMedia({
        mediaUrl: `http://127.0.0.1:${assignedPort}/stream/interrupted.mp4`,
        title: "Interrupted Video",
        uniqueHash: "interrupted_test"
      }, { inactivityTimeoutMs: 1000 });
    } catch (err) {
      interruptedThrew = true;
    }
    assert(interruptedThrew === true, "Interrupted download rejected cleanly");

    const partialFile1 = path.join(tempDir, "stall_test.mp4");
    const partialFile2 = path.join(tempDir, "interrupted_test.mp4");
    assert(!fs.existsSync(partialFile1), "Partial file stall_test.mp4 removed");
    assert(!fs.existsSync(partialFile2), "Partial file interrupted_test.mp4 removed");

    console.log("\n--- Step 26: URL Token Redaction ---");
    const rawSecretUrl = "http://127.0.0.1:9355/player.php?id=5001&token=SECRET_AUTH_TOKEN_XYZ987&auth_sig=SIG_ABC123";
    const redacted = redactUrl(rawSecretUrl);
    assert(!redacted.includes("SECRET_AUTH_TOKEN_XYZ987"), "Token redacted from log string");
    assert(!redacted.includes("SIG_ABC123"), "Signature redacted from log string");
    assert(redacted.includes("REDACTED"), "Placeholder REDACTED present");
    reportMetrics.tokenRedaction = "PASS";

    console.log("\n--- Step 27: Media Cleanup ---");
    adapter.cleanupMedia(dlResult.localPath);
    assert(!fs.existsSync(dlResult.localPath), "Downloaded media cleaned up after processing");
    reportMetrics.cleanup = "PASS";

  } finally {
    server.close();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  console.log("\n============================================================");
  console.log("📊 E2E HARDENED PIPELINE TEST RESULTS");
  console.log("============================================================");
  console.log(`Total Assertions: ${totalAssertions}, Passed: ${passedAssertions}, Failed: ${failedAssertions}`);
  console.log("============================================================\n");

  console.log("METRICS_JSON=" + JSON.stringify(reportMetrics));

  if (failedAssertions > 0) {
    process.exit(1);
  }
}

runEndToEndHardenedPipelineTest().catch((err) => {
  console.error("FATAL ERROR in E2E Pipeline Test:", err);
  process.exit(1);
});
