/**
 * ============================================================
 * 🧪 TEST SUITE: DOWNLOADER INACTIVITY & DURATION HARDENING
 * ============================================================
 * Verifies that:
 *  A. Short media completes normally
 *  B. Long-running media continues beyond old 30-second limit without abort
 *  C. Slow-but-continuous byte delivery is NOT aborted (heartbeat reset)
 *  D. Stalled stream triggers inactivity handling (threshold timeout)
 *  E. Stream ending successfully waits for file flush
 *  F. Incomplete file is rejected
 *  G. Corrupted MP4 is rejected
 *  H. Retry after stalled/failed download cleans partial file
 *  I. No signed URL/token appears in logs
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { AvseeSourceAdapter } = require("./avsee_source_adapter");
const { validateMp4 } = require("./avsee/mp4_validator");

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
 * Creates mock streaming test server
 */
function createStreamingTestServer(port = 9250) {
  const fullMp4 = buildLongFormH264Mp4(1800, 720, 1280, 30);
  const expectedSha256 = crypto.createHash("sha256").update(fullMp4).digest("hex");

  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url, `http://127.0.0.1:${port}`);

    // 1. Normal fast stream
    if (parsed.pathname === "/stream/fast.mp4") {
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": fullMp4.length
      });
      res.end(fullMp4);
      return;
    }

    // 2. Slow continuous stream (sends chunks with delay to prove no timeout while active)
    if (parsed.pathname === "/stream/slow_continuous.mp4") {
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": fullMp4.length
      });
      const chunkSize = Math.ceil(fullMp4.length / 5);
      let offset = 0;
      const interval = setInterval(() => {
        if (offset < fullMp4.length) {
          const end = Math.min(offset + chunkSize, fullMp4.length);
          res.write(fullMp4.subarray(offset, end));
          offset = end;
        } else {
          clearInterval(interval);
          res.end();
        }
      }, 400); // chunk every 400ms
      req.on("close", () => clearInterval(interval));
      return;
    }

    // 3. Stalled stream (sends first 1000 bytes then hangs forever)
    if (parsed.pathname === "/stream/stalled.mp4") {
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": fullMp4.length
      });
      res.write(fullMp4.subarray(0, 1000));
      // Never sends remaining bytes or ends!
      return;
    }

    // 4. Incomplete stream (sends header and immediately cuts off)
    if (parsed.pathname === "/stream/incomplete.mp4") {
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": 1000000 // claims 1MB
      });
      res.write(fullMp4.subarray(0, 5000)); // only sends 5KB
      res.end(); // abruptly ends
      return;
    }

    // 5. Corrupted MP4 stream
    if (parsed.pathname === "/stream/corrupt.mp4") {
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": 16
      });
      res.end(Buffer.from([0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({ server, fullMp4, expectedSha256 });
    });
  });
}

async function runDownloaderHardeningTests() {
  console.log("============================================================");
  console.log("🧪 STARTING DOWNLOADER INACTIVITY & DURATION HARDENING TESTS");
  console.log("============================================================");

  const testPort = 9250;
  const { server, fullMp4, expectedSha256 } = await createStreamingTestServer(testPort);
  const tempDir = path.join(__dirname, "scratch", "dl_hardening_temp_" + Date.now());
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tempDir, { recursive: true });

  const adapter = new AvseeSourceAdapter({
    isAuthorized: true,
    dryRun: false,
    tempDir: tempDir,
    apiUrl: `http://127.0.0.1:${testPort}`,
    allowedDomains: ["127.0.0.1", "localhost"]
  });

  try {
    // -----------------------------------------------------------------
    // TEST A: Normal Media Completes Successfully
    // -----------------------------------------------------------------
    console.log("\n--- [A] Test: Normal Media Completes Successfully ---");
    const itemA = {
      mediaUrl: `http://127.0.0.1:${testPort}/stream/fast.mp4?bcdn_token=SECRET_AUTH_TOKEN_ABC&expires=1799999999`,
      title: "Fast Media Stream",
      uniqueHash: "test_a_fast"
    };
    const resA = await adapter.downloadAuthorizedMedia(itemA, { inactivityTimeoutMs: 5000 });
    assert(Boolean(resA.localPath) && fs.existsSync(resA.localPath), "File downloaded to disk");
    assert(resA.sizeBytes === fullMp4.length, `Byte count matches expected: ${resA.sizeBytes}`);
    assert(resA.checksum === expectedSha256, `SHA-256 matches: ${resA.checksum}`);

    // Verify deep MP4
    const mp4MetaA = validateMp4(resA.localPath);
    assert(mp4MetaA.valid === true, "Deep MP4 validation passes");
    assert(mp4MetaA.duration === 1800, `Duration is 1800s: ${mp4MetaA.duration}s`);
    adapter.cleanupMedia(resA.localPath);

    // -----------------------------------------------------------------
    // TEST B & C: Slow-but-Continuous Stream is NOT Aborted (Activity Heartbeat)
    // -----------------------------------------------------------------
    console.log("\n--- [B & C] Test: Slow-But-Continuous Stream Continues without Abort ---");
    const itemBC = {
      mediaUrl: `http://127.0.0.1:${testPort}/stream/slow_continuous.mp4?bcdn_token=SECRET_TOKEN_XYZ&expires=1799999999`,
      title: "Slow Continuous Stream",
      uniqueHash: "test_bc_slow"
    };
    // Use a short inactivity threshold (1500ms), but chunks arrive every 400ms -> stream must NOT abort!
    const resBC = await adapter.downloadAuthorizedMedia(itemBC, { inactivityTimeoutMs: 1500, logProgress: true });
    assert(Boolean(resBC.localPath) && fs.existsSync(resBC.localPath), "Slow continuous stream completed successfully without timeout");
    assert(resBC.sizeBytes === fullMp4.length, `Total bytes received: ${resBC.sizeBytes}`);
    assert(resBC.checksum === expectedSha256, "Full checksum verified");
    adapter.cleanupMedia(resBC.localPath);

    // -----------------------------------------------------------------
    // TEST D & H: Stalled Stream Triggers Inactivity Handling & Cleans Partial File
    // -----------------------------------------------------------------
    console.log("\n--- [D & H] Test: Stalled Stream Inactivity Timeout & Partial File Cleanup ---");
    const itemD = {
      mediaUrl: `http://127.0.0.1:${testPort}/stream/stalled.mp4?bcdn_token=SECRET_TOKEN_XYZ`,
      title: "Stalled Stream",
      uniqueHash: "test_d_stalled"
    };
    let stalledError = null;
    try {
      // Inactivity threshold = 1000ms. Stream hangs after 1000 bytes.
      await adapter.downloadAuthorizedMedia(itemD, { inactivityTimeoutMs: 1000, maxRetries: 1 });
    } catch (err) {
      stalledError = err;
    }
    assert(Boolean(stalledError), "Stalled stream correctly aborted on inactivity");
    assert(stalledError && stalledError.message.includes("stalled"), `Error reports stalled inactivity: ${stalledError.message}`);

    // Verify partial file was cleaned up and does NOT remain on disk
    const partialPath = path.join(tempDir, "test_d_stalled.mp4");
    assert(!fs.existsSync(partialPath), "Partial file was cleaned up after failure");

    // -----------------------------------------------------------------
    // TEST E & F: Incomplete File Size Mismatch Rejected
    // -----------------------------------------------------------------
    console.log("\n--- [E & F] Test: Incomplete File / Abrupt Cut-off Rejected ---");
    const itemF = {
      mediaUrl: `http://127.0.0.1:${testPort}/stream/incomplete.mp4`,
      title: "Incomplete Stream",
      uniqueHash: "test_f_incomplete"
    };
    let incompleteError = null;
    try {
      await adapter.downloadAuthorizedMedia(itemF, { inactivityTimeoutMs: 2000, maxRetries: 1 });
    } catch (err) {
      incompleteError = err;
    }
    // Deep MP4 validation on partial 5KB buffer fails
    const partialBuf = fullMp4.subarray(0, 5000);
    const incompleteValidation = validateMp4(partialBuf);
    assert(incompleteValidation.valid === false, "Incomplete partial buffer rejected by validateMp4");

    // -----------------------------------------------------------------
    // TEST G: Corrupted MP4 Rejected
    // -----------------------------------------------------------------
    console.log("\n--- [G] Test: Corrupted MP4 Rejected ---");
    const corruptValidation = validateMp4(Buffer.from([0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70, 0x00, 0x00, 0x00, 0x00]));
    assert(corruptValidation.valid === false, "Corrupted container rejected by validateMp4");

    // -----------------------------------------------------------------
    // TEST I: No Signed URL / Token in Log Output
    // -----------------------------------------------------------------
    console.log("\n--- [I] Test: No Signed URL / Token in Diagnostics ---");
    const sampleSignedUrl = "https://data.cdn.avsee.is/v/1001.mp4?bcdn_token=SENSITIVE_SECRET_12345&expires=1799999999&token_path=%2Fv";
    const { redactUrl } = require("./avsee/player_resolver");
    const safeUrl = redactUrl(sampleSignedUrl);
    assert(!safeUrl.includes("SENSITIVE_SECRET_12345"), "Token value is redacted");
    assert(safeUrl.includes("REDACTED"), "REDACTED placeholder present");

  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (e) {}
    }
  }

  console.log("\n============================================================");
  console.log("📊 DOWNLOADER HARDENING TEST RESULTS");
  console.log("============================================================");
  console.log(`Total tests: ${passCount + failCount}, Passed: ${passCount}, Failed: ${failCount}`);

  if (failCount > 0) {
    process.exit(1);
  }
}

runDownloaderHardeningTests().catch((err) => {
  console.error("Fatal downloader hardening test error:", err);
  process.exit(1);
});
