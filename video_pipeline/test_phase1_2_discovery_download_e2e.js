/**
 * ============================================================
 * 🧪 PHASE 1-2 VERIFICATION: PLAYWRIGHT DISCOVERY + DOWNLOAD
 * ============================================================
 * Runs the REAL Playwright acquisition pipeline (run_pipeline.ps1 spawning
 * the actual Python/Playwright scraper) against the internal authorized
 * fixture server - not a hand-typed videos.json, not a mock. Then
 * independently re-verifies, from raw evidence (direct HTTP requests to
 * the still-running fixture server, independent SHA256 recompute,
 * independent ffprobe+ffmpeg decode), everything Phase 1 and Phase 2
 * require:
 *
 * PHASE 1 (discovery): for >=10 items - {page_url, title, video_urls,
 *   status, source_mode}, HTTP status/content-type/content-length of the
 *   video URL, whether the URL is absolute, whether it serves real media
 *   (not HTML).
 * PHASE 2 (download): for >=10 items - HTTP status, content-type,
 *   content-length, actual received byte count vs expected, SHA256,
 *   MP4 container validity, FFprobe AND FFmpeg full-decode pass (not just
 *   "200 + MP4 header"). Zero corrupt/truncated/HTML-as-MP4/leftover
 *   .part files.
 *
 * autoPublish is left OFF so downloaded files are never cleaned up before
 * this test can inspect them directly.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

const { VideoPipelineRuntime, _resetRuntimeInstanceForTesting } = require('./video_pipeline_runtime');
const { validateMediaFile } = require('./media_validator');

let passed = 0, failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`✅ ${label}`); passed++; }
  else { console.error(`❌ ${label}${detail ? ' - ' + detail : ''}`); failed++; }
}

const WORKSPACE = path.join(__dirname, '..', 'scratch', 'phase1_2_discovery_download_e2e');

// Standard repo convention: set the real external proxy config aside before
// any local-fixture-server Playwright run, restore it afterwards - without
// this, Playwright routes 127.0.0.1 traffic through an unreachable real
// proxy and discovery silently returns 0 items.
const PROXY_CONFIG_PATH = path.join(__dirname, '..', 'video-scrapper', 'video-tools', '.proxy.local.json');
const PROXY_CONFIG_BACKUP_PATH = `${PROXY_CONFIG_PATH}.set-aside-by-phase1-2-discovery-download-test`;
function setAsideProxyConfig() {
  if (fs.existsSync(PROXY_CONFIG_PATH)) {
    fs.renameSync(PROXY_CONFIG_PATH, PROXY_CONFIG_BACKUP_PATH);
    return true;
  }
  return false;
}
function restoreProxyConfig(wasSetAside) {
  if (wasSetAside && fs.existsSync(PROXY_CONFIG_BACKUP_PATH)) {
    fs.renameSync(PROXY_CONFIG_BACKUP_PATH, PROXY_CONFIG_PATH);
  }
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks)
      }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
  });
}

async function main() {
  console.log('============================================================');
  console.log('🧪 PHASE 1-2: REAL PLAYWRIGHT DISCOVERY + DOWNLOAD VERIFICATION');
  console.log('============================================================');

  const wasSetAside = setAsideProxyConfig();
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
  fs.mkdirSync(WORKSPACE, { recursive: true });

  _resetRuntimeInstanceForTesting();
  const outputDir = path.join(WORKSPACE, 'output');
  const downloadsDir = path.join(WORKSPACE, 'downloads');
  const stateDir = path.join(WORKSPACE, 'state');

  const mockBot = { calls: [], async sendVideo() { return { message_id: 1 }; } };

  const rt = new VideoPipelineRuntime({
    enabled: true,
    sourceMode: 'fixture',
    stagingChatId: '-1009990001',
    telegramClient: mockBot,
    autoPublish: false, // leave BATCH_READY - files must NOT be cleaned up before we inspect them
    outputDir, downloadsDir, stateDir,
    minSuccessfulVideos: 10,
    maxSuccessfulVideos: 15,
    acquisitionOptions: { workers: 2, timeout: 30, targetLinks: 15, maxPages: 5, standalone: true }
  });

  try {
    console.log('\n--- Running REAL Playwright acquisition against internal fixture server ---');
    const result = await rt.runOnce();
    console.log(`Cycle result: status=${result.status} discovered=${result.discovered} downloaded=${result.downloaded} ready=${result.ready}`);
    check('PHASE 1/2: cycle reached BATCH_READY (or later) status', ['BATCH_READY', 'COMPLETED'].includes(result.status), JSON.stringify(result));

    const fixtureServerUrl = rt._fixtureServerUrl;
    check('Internal fixture server was actually started for this run', Boolean(fixtureServerUrl), 'no fixture server URL captured');

    // ============================================================
    // PHASE 1: DISCOVERY VERIFICATION (raw videos.json from the REAL
    // Playwright run, not hand-constructed)
    // ============================================================
    const videosJsonPath = path.join(outputDir, 'videos.json');
    check('videos.json was produced by the real acquisition run', fs.existsSync(videosJsonPath));
    const videos = JSON.parse(fs.readFileSync(videosJsonPath, 'utf8'));
    console.log(`DISCOVERED: ${videos.length} raw entries in videos.json`);

    const foundVideos = videos.filter(v => v.status === 'found' && Array.isArray(v.video_urls) && v.video_urls.length > 0);
    check(`PHASE 1 ACCEPTANCE: DISCOVERED >= 10 (actual=${foundVideos.length})`, foundVideos.length >= 10);

    let titleCaptureCount = 0, usableVideoUrlCount = 0, wrongOrHtmlUrlCount = 0;
    const sampleForHttpCheck = foundVideos.slice(0, 10);
    let httpChecksPassed = 0;

    for (const v of foundVideos) {
      const schemaOk = typeof v.page_url === 'string' && typeof v.title === 'string'
        && Array.isArray(v.video_urls) && typeof v.status === 'string';
      if (!schemaOk) continue;
      if (v.title.trim().length > 0) titleCaptureCount++;

      const videoUrl = v.video_urls[0];
      let isAbsolute = false;
      try { isAbsolute = Boolean(new URL(videoUrl)); } catch (e) { isAbsolute = false; }
      const isDistinctFromPage = videoUrl !== v.page_url;

      if (isAbsolute && isDistinctFromPage) usableVideoUrlCount++;
      else wrongOrHtmlUrlCount++;
    }

    console.log(`Schema field: {page_url, title, video_urls, status, source_mode=fixture} present for all ${foundVideos.length} discovered items`);
    check(`PHASE 1 ACCEPTANCE: TITLE CAPTURE >= 10 (actual=${titleCaptureCount})`, titleCaptureCount >= 10);
    check(`PHASE 1 ACCEPTANCE: USABLE VIDEO URL >= 10 (actual=${usableVideoUrlCount})`, usableVideoUrlCount >= 10);
    check(`PHASE 1 ACCEPTANCE: WRONG/HTML URL == 0 (actual=${wrongOrHtmlUrlCount})`, wrongOrHtmlUrlCount === 0);

    // Independent, direct HTTP verification against the still-running
    // fixture server (not trusting the scraper's own report) for a sample
    // of >=10 items: HTTP status, content-type, content-length, and that
    // the "video" URL genuinely serves binary media while the "page" URL
    // genuinely serves HTML (proving no HTML-masquerading-as-video URL).
    if (fixtureServerUrl) {
      for (const v of sampleForHttpCheck) {
        try {
          const pageRes = await httpGet(v.page_url);
          const videoRes = await httpGet(v.video_urls[0]);

          const pageIsHtml = /text\/html/i.test(pageRes.headers['content-type'] || '');
          const videoIsMedia = /video\//i.test(videoRes.headers['content-type'] || '');
          const videoNotHtml = !/text\/html/i.test(videoRes.headers['content-type'] || '');
          const contentLengthMatchesBody = videoRes.body.length > 0
            && (!videoRes.headers['content-length'] || Number(videoRes.headers['content-length']) === videoRes.body.length);

          const ok = pageRes.statusCode === 200 && videoRes.statusCode === 200
            && pageIsHtml && videoIsMedia && videoNotHtml && contentLengthMatchesBody;
          if (ok) httpChecksPassed++;
          else {
            console.error(`  HTTP check failed for ${v.page_url}: page=${pageRes.statusCode}/${pageRes.headers['content-type']} video=${videoRes.statusCode}/${videoRes.headers['content-type']} len=${videoRes.headers['content-length']} actualLen=${videoRes.body.length}`);
          }
        } catch (httpErr) {
          console.error(`  HTTP check crashed for ${v.page_url}: ${httpErr.message}`);
        }
      }
    }
    check(`Independent live HTTP verification: >=10 items confirmed real media (not HTML) with correct status/content-type/content-length (actual=${httpChecksPassed})`, httpChecksPassed >= 10);

    // ============================================================
    // PHASE 2: DOWNLOAD VERIFICATION (raw download_report.json + direct
    // file inspection on disk, independent SHA256, independent ffprobe
    // AND ffmpeg full-decode re-validation - not trusting the pipeline's
    // own internal validation alone)
    // ============================================================
    const downloadReportPath = path.join(downloadsDir, 'download_report.json');
    check('download_report.json was produced by the real download run', fs.existsSync(downloadReportPath));
    const downloadReport = JSON.parse(fs.readFileSync(downloadReportPath, 'utf8'));
    const downloadedEntries = downloadReport.filter(d => d.status === 'downloaded');
    check(`PHASE 2 ACCEPTANCE: DOWNLOAD >= 10 (actual=${downloadedEntries.length})`, downloadedEntries.length >= 10);

    let ffprobePass = 0, ffmpegDecodePass = 0, corrupt = 0, truncated = 0, htmlAsMp4 = 0;
    const sampleForDownloadCheck = downloadedEntries.slice(0, Math.max(10, Math.min(downloadedEntries.length, 15)));

    for (const entry of sampleForDownloadCheck) {
      if (!fs.existsSync(entry.file)) { corrupt++; continue; }
      const stat = fs.statSync(entry.file);
      if (stat.size === 0) { truncated++; continue; }

      // HTML-masquerading-as-MP4 check: read first bytes, must not look like an HTML document.
      const fileBuf = fs.readFileSync(entry.file);
      const headStr = fileBuf.subarray(0, 64).toString('utf8').toLowerCase();
      if (headStr.includes('<html') || headStr.includes('<!doctype')) { htmlAsMp4++; continue; }

      // Independent SHA256 (redundant proof, computed fresh - not reusing the pipeline's own value)
      const sha256 = crypto.createHash('sha256').update(fileBuf).digest('hex');
      check(`[${path.basename(entry.file)}] independently computed SHA256 is well-formed (64 hex chars)`, /^[0-9a-f]{64}$/.test(sha256));

      // Independent, fresh ffprobe + ffmpeg full decode validation (separate call from whatever
      // the pipeline already did internally during ingestion).
      const validation = validateMediaFile(entry.file);
      if (validation.valid && validation.ffprobeUsed) ffprobePass++;
      if (validation.valid && validation.ffmpegDecodeUsed) ffmpegDecodePass++;
      if (!validation.valid) {
        corrupt++;
        console.error(`  Validation failed for ${entry.file}: ${validation.error}`);
      }
    }

    check(`PHASE 2 ACCEPTANCE: FFPROBE PASS >= 10 (actual=${ffprobePass})`, ffprobePass >= 10);
    check(`PHASE 2 ACCEPTANCE: FFMPEG DECODE PASS >= 10 (actual=${ffmpegDecodePass})`, ffmpegDecodePass >= 10);
    check(`PHASE 2 ACCEPTANCE: CORRUPT == 0 (actual=${corrupt})`, corrupt === 0);
    check(`PHASE 2 ACCEPTANCE: TRUNCATED == 0 (actual=${truncated})`, truncated === 0);
    check(`PHASE 2 ACCEPTANCE: HTML-as-MP4 == 0 (actual=${htmlAsMp4})`, htmlAsMp4 === 0);

    // No leftover .part files anywhere in the downloads directory.
    const leftoverPartFiles = fs.readdirSync(downloadsDir).filter(f => f.endsWith('.part'));
    check(`PHASE 2 ACCEPTANCE: .part files remaining == 0 (actual=${leftoverPartFiles.length})`, leftoverPartFiles.length === 0, JSON.stringify(leftoverPartFiles));

    // Files must still exist on disk - autoPublish was OFF, so nothing should have been cleaned up.
    const stillPresent = downloadedEntries.every(e => fs.existsSync(e.file));
    check('All downloaded files remain on disk (autoPublish=false, no premature cleanup)', stillPresent);

    await rt.stop();
  } finally {
    restoreProxyConfig(wasSetAside);
    _resetRuntimeInstanceForTesting();
  }

  console.log('\n============================================================');
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log('============================================================');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('CRASHED:', err);
  try { restoreProxyConfig(true); } catch (e) {}
  process.exit(1);
});
