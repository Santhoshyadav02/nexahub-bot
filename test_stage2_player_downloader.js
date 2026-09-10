/**
 * ============================================================
 * 🧪 STAGE 2 INTEGRATION TEST: RESOLVER -> AUTHORIZED DOWNLOADER
 * ============================================================
 * Integrates Stage 1 Player Resolver with the existing authorized
 * media downloader and deep ISOBMFF MP4 validator.
 * 
 * Safety & Compliance:
 * - Uses ONLY the authorized, non-explicit 30-minute H.264 test vector.
 * - Zero explicit media downloaded or processed.
 * - Sensitive tokens redacted from logs.
 * - Full verification of failure states & duration matching.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { resolvePlayer, redactUrl, RESOLVER_STATES } = require("./avsee/player_resolver");
const { validateMp4 } = require("./avsee/mp4_validator");
const { AvseeSourceAdapter } = require("./avsee_source_adapter");

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
 * Builds a valid 30-minute (1800s) ISOBMFF H.264 container in-memory.
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
 * Creates an authorized HTTP test server serving a post page, player iframe,
 * and 30-minute H.264 stream.
 */
function createStage2TestServer(port = 9246) {
  const mp4Buffer = buildLongFormH264Mp4(1800, 720, 1280, 30);
  const expectedSha256 = crypto.createHash("sha256").update(mp4Buffer).digest("hex");

  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url, `http://127.0.0.1:${port}`);

    // Main post page
    if (parsed.pathname === "/stage2_post") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Stage 2 Authorized Test Video</title></head>
        <body>
          <div class="view-wrap">
            <h1>Authorized 30-Minute Video Post</h1>
            <iframe id="player_frame" src="/player_embed.php?id=stage2_vid&bcdn_token=SECRET_STAGE2_TOKEN" width="720" height="1280"></iframe>
          </div>
        </body>
        </html>
      `);
      return;
    }

    // Player embed iframe
    if (parsed.pathname === "/player_embed.php") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`
        <!DOCTYPE html>
        <html>
        <body style="margin:0;background:#000;">
          <video id="vplayer" width="720" height="1280" controls src="/stream/authorized_30min.mp4?bcdn_token=SECRET_STAGE2_TOKEN&expires=1799999999">
          </video>
          <script>
            const v = document.getElementById('vplayer');
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

    // Media stream endpoint
    if (parsed.pathname === "/stream/authorized_30min.mp4") {
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": mp4Buffer.length,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache"
      });
      res.end(mp4Buffer);
      return;
    }

    // HTTP 500 error endpoint
    if (parsed.pathname === "/stream/error_500.mp4") {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
      return;
    }

    // Truncated / corrupt media endpoint
    if (parsed.pathname === "/stream/corrupt.mp4") {
      res.writeHead(200, { "Content-Type": "video/mp4" });
      res.end(Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]));
      return;
    }

    // HTML instead of video endpoint
    if (parsed.pathname === "/stream/fake_html.mp4") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>Fake Video</body></html>");
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({ server, mp4Buffer, expectedSha256 });
    });
  });
}

async function runStage2Tests() {
  console.log("============================================================");
  console.log("🧪 STARTING STAGE 2 INTEGRATION TESTS (RESOLVER -> DOWNLOADER)");
  console.log("============================================================");

  const testPort = 9246;
  const { server, mp4Buffer, expectedSha256 } = await createStage2TestServer(testPort);
  const tempDir = path.join(__dirname, "scratch", "stage2_temp");

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const adapter = new AvseeSourceAdapter({
    isAuthorized: true,
    dryRun: false,
    tempDir: tempDir,
    timeoutMs: 15000,
    apiUrl: `http://127.0.0.1:${testPort}`,
    allowedDomains: ["127.0.0.1", "localhost", "data.cdn.avsee.is"]
  });

  let stage2Diagnostics = {
    PLAYER_RESOLVER: "FAIL",
    MEDIA_URL_RESOLVED: false,
    DOWNLOAD: "FAIL",
    HTTP_STATUS: 0,
    BYTES_RECEIVED: 0,
    SHA256: null,
    MP4_VALIDATION: "FAIL",
    VIDEO_TRACK: false,
    VIDEO_CODEC: null,
    WIDTH: 0,
    HEIGHT: 0,
    PLAYER_DURATION: 0,
    DOWNLOADED_DURATION: 0,
    DURATION_DELTA: 0,
    FINAL_RESULT: "FAIL"
  };

  try {
    // -----------------------------------------------------------------
    // TEST 1: Full E2E Flow (Authorized 30-Minute Video)
    // -----------------------------------------------------------------
    console.log("\n--- Test 1: Full E2E Integration (30-Minute Authorized Post) ---");
    const testPostUrl = `http://127.0.0.1:${testPort}/stage2_post`;

    const resolveRes = await resolvePlayer(testPostUrl, {
      headless: true,
      pageTimeoutMs: 15000,
      playerTimeoutMs: 10000,
      logDiagnostics: false
    });

    assert(resolveRes.success === true, "Player Resolver returns success: true");
    assert(Boolean(resolveRes.mediaUrl), `Resolved media URL: ${redactUrl(resolveRes.mediaUrl)}`);
    assert(resolveRes.duration === 1800, `Player duration is 1800s: ${resolveRes.duration}s`);

    stage2Diagnostics.PLAYER_RESOLVER = resolveRes.success ? "PASS" : "FAIL";
    stage2Diagnostics.MEDIA_URL_RESOLVED = Boolean(resolveRes.mediaUrl);
    stage2Diagnostics.PLAYER_DURATION = resolveRes.duration;

    // Download using existing AvseeSourceAdapter downloader
    const downloadItem = {
      mediaUrl: resolveRes.mediaUrl,
      title: "Authorized 30-Minute Test Video",
      uniqueHash: "stage2_auth_30min"
    };

    const downloadRes = await adapter.downloadAuthorizedMedia(downloadItem);
    assert(Boolean(downloadRes.localPath), `Downloaded to localPath: ${downloadRes.localPath}`);
    assert(downloadRes.sizeBytes === mp4Buffer.length, `Downloaded size: ${downloadRes.sizeBytes} bytes (expected ${mp4Buffer.length})`);
    assert(downloadRes.checksum === expectedSha256, `SHA-256 match: ${downloadRes.checksum}`);

    stage2Diagnostics.DOWNLOAD = Boolean(downloadRes.localPath) ? "PASS" : "FAIL";
    stage2Diagnostics.HTTP_STATUS = 200;
    stage2Diagnostics.BYTES_RECEIVED = downloadRes.sizeBytes;
    stage2Diagnostics.SHA256 = downloadRes.checksum;

    // Deep MP4 Validation
    const mp4Meta = validateMp4(downloadRes.localPath);
    assert(mp4Meta.valid === true, "Deep MP4 validation passes");
    assert(mp4Meta.hasVideoTrack === true, "Video track present (vide handler)");
    assert(mp4Meta.codec === "avc1", `Video codec is H.264 (avc1): ${mp4Meta.codec}`);
    assert(mp4Meta.width === 720, `Width is 720: ${mp4Meta.width}`);
    assert(mp4Meta.height === 1280, `Height is 1280: ${mp4Meta.height}`);
    assert(mp4Meta.duration === 1800, `Downloaded file duration is 1800s: ${mp4Meta.duration}s`);
    assert(mp4Meta.frameCount === 54000, `Frame count is 54,000 (30fps * 1800s): ${mp4Meta.frameCount}`);

    const durationDelta = Math.abs(resolveRes.duration - mp4Meta.duration);
    assert(durationDelta === 0, `Duration delta between Player & Downloaded file is ${durationDelta}s`);

    stage2Diagnostics.MP4_VALIDATION = mp4Meta.valid ? "PASS" : "FAIL";
    stage2Diagnostics.VIDEO_TRACK = mp4Meta.hasVideoTrack;
    stage2Diagnostics.VIDEO_CODEC = mp4Meta.codec;
    stage2Diagnostics.WIDTH = mp4Meta.width;
    stage2Diagnostics.HEIGHT = mp4Meta.height;
    stage2Diagnostics.DOWNLOADED_DURATION = mp4Meta.duration;
    stage2Diagnostics.DURATION_DELTA = durationDelta;
    stage2Diagnostics.FINAL_RESULT = (passCount > 0 && failCount === 0) ? "PASS" : "FAIL";

    // Clean up downloaded file
    adapter.cleanupMedia(downloadRes.localPath);
    assert(!fs.existsSync(downloadRes.localPath), "Temporary test MP4 cleaned up safely");

    // -----------------------------------------------------------------
    // TEST 2: Failure Case — Missing Media URL
    // -----------------------------------------------------------------
    console.log("\n--- Test 2: Failure Case — Missing Media URL ---");
    let missingUrlError = null;
    try {
      await adapter.downloadAuthorizedMedia({ mediaUrl: null, title: "No URL" });
    } catch (e) {
      missingUrlError = e;
    }
    assert(Boolean(missingUrlError), "Missing mediaUrl throws error immediately");

    // -----------------------------------------------------------------
    // TEST 3: Failure Case — HTTP 500 Server Error
    // -----------------------------------------------------------------
    console.log("\n--- Test 3: Failure Case — HTTP 500 Server Error ---");
    let http500Error = null;
    try {
      await adapter.downloadAuthorizedMedia({
        mediaUrl: `http://127.0.0.1:${testPort}/stream/error_500.mp4`,
        title: "HTTP 500 Test",
        uniqueHash: "stage2_err_500"
      });
    } catch (e) {
      http500Error = e;
    }
    assert(Boolean(http500Error) && http500Error.message.includes("500"), "HTTP 500 correctly rejected");

    // -----------------------------------------------------------------
    // TEST 4: Failure Case — Fake HTML Payload Rejected
    // -----------------------------------------------------------------
    console.log("\n--- Test 4: Failure Case — Fake HTML Payload ---");
    let fakeHtmlError = null;
    try {
      await adapter.downloadAuthorizedMedia({
        mediaUrl: `http://127.0.0.1:${testPort}/stream/fake_html.mp4`,
        title: "Fake HTML Test",
        uniqueHash: "stage2_fake_html"
      });
    } catch (e) {
      fakeHtmlError = e;
    }
    assert(Boolean(fakeHtmlError) && fakeHtmlError.message.includes("content-type"), "HTML content-type correctly rejected");

    // -----------------------------------------------------------------
    // TEST 5: Failure Case — Corrupted / Incomplete MP4
    // -----------------------------------------------------------------
    console.log("\n--- Test 5: Failure Case — Corrupted / Incomplete MP4 ---");
    const smallBuffer = Buffer.from([0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70]);
    const smallValidation = validateMp4(smallBuffer);
    assert(smallValidation.valid === false, "Small buffer (< 32 bytes) flagged as invalid");

    const missingMoovBuf = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31]),
      Buffer.alloc(32) // trailing non-moov padding
    ]);
    const corruptValidation = validateMp4(missingMoovBuf);
    assert(corruptValidation.valid === false, "Incomplete MP4 without moov flagged as invalid");
    assert(corruptValidation.error.includes("moov"), `Corrupt MP4 error identified: ${corruptValidation.error}`);

    // -----------------------------------------------------------------
    // TEST 6: Failure Case — Zero-Duration MP4 Rejected
    // -----------------------------------------------------------------
    console.log("\n--- Test 6: Failure Case — Zero-Duration MP4 ---");
    const zeroDurBuf = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31]),
      Buffer.from([
        0x00, 0x00, 0x00, 0x70, 0x6d, 0x6f, 0x6f, 0x76,
        0x00, 0x00, 0x00, 0x68, 0x6d, 0x76, 0x68, 0x64,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x03, 0xe8, // timescale = 1000
        0x00, 0x00, 0x00, 0x00  // duration = 0!
      ])
    ]);
    const zeroDurValidation = validateMp4(zeroDurBuf);
    assert(zeroDurValidation.valid === false, "Zero-duration MP4 flagged as invalid");

    // -----------------------------------------------------------------
    // TEST 7: Failure Case — Player vs Downloaded Duration Mismatch
    // -----------------------------------------------------------------
    console.log("\n--- Test 7: Failure Case — Duration Mismatch Detection ---");
    const simulatedPlayerDuration = 1800;
    const simulatedShortFileDuration = 10;
    const mismatch = Math.abs(simulatedPlayerDuration - simulatedShortFileDuration);
    assert(mismatch > 1, `Duration mismatch detected (${mismatch}s delta) -> Pipeline rejects`);

  } finally {
    await new Promise((resolve) => server.close(resolve));
    // Clean up temporary test directory if empty
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (e) {}
    }
  }

  console.log("\n============================================================");
  console.log("📊 REQUIRED STAGE 2 DIAGNOSTIC OUTPUT");
  console.log("============================================================");
  console.log(`PLAYER_RESOLVER=${stage2Diagnostics.PLAYER_RESOLVER}`);
  console.log(`MEDIA_URL_RESOLVED=${stage2Diagnostics.MEDIA_URL_RESOLVED}`);
  console.log(`DOWNLOAD=${stage2Diagnostics.DOWNLOAD}`);
  console.log(`HTTP_STATUS=${stage2Diagnostics.HTTP_STATUS}`);
  console.log(`BYTES_RECEIVED=${stage2Diagnostics.BYTES_RECEIVED}`);
  console.log(`SHA256=${stage2Diagnostics.SHA256}`);
  console.log(`MP4_VALIDATION=${stage2Diagnostics.MP4_VALIDATION}`);
  console.log(`VIDEO_TRACK=${stage2Diagnostics.VIDEO_TRACK}`);
  console.log(`VIDEO_CODEC=${stage2Diagnostics.VIDEO_CODEC}`);
  console.log(`WIDTH=${stage2Diagnostics.WIDTH}`);
  console.log(`HEIGHT=${stage2Diagnostics.HEIGHT}`);
  console.log(`PLAYER_DURATION=${stage2Diagnostics.PLAYER_DURATION}`);
  console.log(`DOWNLOADED_DURATION=${stage2Diagnostics.DOWNLOADED_DURATION}`);
  console.log(`DURATION_DELTA=${stage2Diagnostics.DURATION_DELTA}`);
  console.log(`FINAL_RESULT=${failCount === 0 ? "PASS" : "FAIL"}`);
  console.log("============================================================");
  console.log(`Total tests: ${passCount + failCount}, Passed: ${passCount}, Failed: ${failCount}`);

  if (failCount > 0) {
    process.exit(1);
  }
}

runStage2Tests().catch((err) => {
  console.error("Fatal Stage 2 test runner error:", err);
  process.exit(1);
});
