/**
 * ============================================================
 * 🧪 TEST: AUTHORIZED-SOURCE PROVENANCE (CDN VIDEO) + INGEST DECODE REUSE
 * ============================================================
 *  1. Authorized media: page on the configured source origin passes even when the video is on another host
 *  2. Authorized media: page on a different origin fails
 *  3. No configured source / fixture media: original same-origin rule unchanged
 *  4. validateMediaFile({skipDecode}) re-runs header + ffprobe, skips the decode
 *  5. Publisher with reuseIngestDecode + matching SHA256 skips the decode and publishes
 *  6. Publisher with reuseIngestDecode + changed bytes runs the full decode and blocks publish
 *  7. Publisher without reuseIngestDecode always runs the full decode
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const { validateSourceProvenance } = require('./source_provenance_validator');
const { validateMediaFile, getFFmpegPath } = require('./media_validator');
const { VideoBatchPublisher } = require('./video_batch_publisher');
const { BatchState } = require('./batch_state');
const { PublishLedger } = require('./publish_ledger');

const ROOT_DIR = path.resolve(__dirname, '..');
const TEST_DIR = path.join(ROOT_DIR, 'scratch', 'test_provenance_cdn_and_decode_reuse_workspace');

let passed = 0, failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.error(`  ❌ ${label}${detail ? ' - ' + detail : ''}`); failed++; }
}
function section(title) { console.log(`\n--- ${title} ---`); }

const SOURCE = 'https://source.test/board?list=1';
const base = {
  sourceMode: 'authorized',
  isFixtureMedia: false,
  sourcePageUrl: 'https://source.test/post/1',
  sourceVideoUrl: 'https://cdn.other-host.test/v/1.mp4',
  contentSha256: 'a'.repeat(64)
};

function sha256(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function makePublisher(dir, { reuseIngestDecode, calls }) {
  return new VideoBatchPublisher({
    stagingChatId: 'me',
    telegramClient: { publish: async () => ({ messageId: 42 }) },
    batchState: new BatchState({ statePath: path.join(dir, 'batch_state.json') }),
    publishLedger: new PublishLedger({ ledgerPath: path.join(dir, 'publish_state.json') }),
    rateLimitDelayMs: 0,
    authorizedSourceUrl: SOURCE,
    reuseIngestDecode,
    mediaValidator: async (filePath, options) => {
      calls.push(options || null);
      return validateMediaFile(filePath, options);
    }
  });
}

async function main() {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  section('1-3. Provenance');
  check('authorized: CDN video with page on source origin passes',
    validateSourceProvenance(base, { authorizedSourceUrl: SOURCE }).valid);
  const offSource = validateSourceProvenance({ ...base, sourcePageUrl: 'https://elsewhere.test/post/1' }, { authorizedSourceUrl: SOURCE });
  check('authorized: page on another origin fails', !offSource.valid && /sourceVideoUrlConsistentWithPage/.test(offSource.error), offSource.error);
  check('no configured source: CDN video still fails same-origin rule', !validateSourceProvenance(base).valid);
  check('no configured source: same-origin video passes',
    validateSourceProvenance({ ...base, sourceVideoUrl: 'https://source.test/v/1.mp4' }).valid);
  check('fixture media ignores authorizedSourceUrl (same-origin rule)',
    !validateSourceProvenance({ ...base, sourceMode: 'fixture', isFixtureMedia: true }, { authorizedSourceUrl: SOURCE }).valid);

  const source = path.join(TEST_DIR, 'clip.mp4');
  const gen = spawnSync(getFFmpegPath(), ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=10',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source], { encoding: 'utf8' });
  if (gen.status !== 0) {
    console.error('ffmpeg is required for this test:', gen.stderr || gen.error);
    process.exit(1);
  }

  section('4. validateMediaFile skipDecode');
  const full = await validateMediaFile(source);
  const light = await validateMediaFile(source, { skipDecode: true });
  check('full validation decodes', full.valid && full.ffmpegDecodeUsed === true);
  check('skipDecode validates without decoding', light.valid && light.ffprobeUsed === true && light.ffmpegDecodeUsed === false);
  const garbage = path.join(TEST_DIR, 'garbage.mp4');
  fs.writeFileSync(garbage, 'not a video');
  check('skipDecode still rejects a non-video', !(await validateMediaFile(garbage, { skipDecode: true })).valid);

  const recordFor = (filePath, overrides = {}) => ({
    ...base,
    mediaId: `m_${Math.random().toString(36).slice(2)}`,
    title: 'T',
    filePath,
    size: fs.statSync(filePath).size,
    contentSha256: sha256(filePath),
    duration: full.duration,
    width: full.width,
    height: full.height,
    codec: full.codec,
    ...overrides
  });

  section('5. reuseIngestDecode + matching SHA256');
  {
    const dir = path.join(TEST_DIR, 'reuse_match'); fs.mkdirSync(dir);
    const calls = [];
    const res = await makePublisher(dir, { reuseIngestDecode: true, calls }).publishSingleItem('b1', recordFor(source));
    check('published', res.status === 'PUBLISHED', JSON.stringify(res));
    check('validator called once with skipDecode', calls.length === 1 && calls[0] && calls[0].skipDecode === true, JSON.stringify(calls));
  }

  section('6. reuseIngestDecode + changed bytes');
  {
    const dir = path.join(TEST_DIR, 'reuse_mismatch'); fs.mkdirSync(dir);
    const calls = [];
    const res = await makePublisher(dir, { reuseIngestDecode: true, calls }).publishSingleItem('b2', recordFor(source, { contentSha256: 'b'.repeat(64) }));
    check('full decode used when hash differs', calls.length === 1 && calls[0] === null, JSON.stringify(calls));
    check('publish blocked on SHA256 mismatch', res.status === 'FAILED' && /SHA256 mismatch/.test(res.reason || ''), JSON.stringify(res));
  }

  section('7. reuseIngestDecode off');
  {
    const dir = path.join(TEST_DIR, 'no_reuse'); fs.mkdirSync(dir);
    const calls = [];
    const res = await makePublisher(dir, { reuseIngestDecode: false, calls }).publishSingleItem('b3', recordFor(source));
    check('published', res.status === 'PUBLISHED', JSON.stringify(res));
    check('full decode used', calls.length === 1 && calls[0] === null, JSON.stringify(calls));
  }

  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('Test crashed:', err);
  process.exit(1);
});
