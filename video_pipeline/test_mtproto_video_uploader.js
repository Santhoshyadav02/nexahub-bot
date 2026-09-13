/**
 * ============================================================
 * 🧪 TEST: MTPROTO VIDEO UPLOADER
 * ============================================================
 * Real ffmpeg split + fake MTProto client:
 *  1. File under maxPartBytes uploads as a single message, no split
 *  2. File over maxPartBytes is split; every part <= maxPartBytes, all uploaded in order with (i/n) captions
 *  3. Parts are real, playable MP4s whose durations add up to the source
 *  4. Temporary parts directory is removed afterwards (success and failure)
 *  5. Read-back size mismatch throws
 *  6. Disconnected session throws before any upload
 *  7. Runtime in mtproto mode wires the uploader into the publisher
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { MtprotoVideoUploader } = require('./mtproto_video_uploader');
const { probeMedia, getFFmpegPath } = require('./media_validator');

const ROOT_DIR = path.resolve(__dirname, '..');
const TEST_DIR = path.join(ROOT_DIR, 'scratch', 'test_mtproto_video_uploader_workspace');

let passed = 0, failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.error(`  ❌ ${label}${detail ? ' - ' + detail : ''}`); failed++; }
}
function section(title) { console.log(`\n--- ${title} ---`); }

function makeFakeReader({ connected = true, sizeOffset = 0 } = {}) {
  const sent = [];
  return {
    sent,
    fatalError: connected ? null : 'test: not connected',
    async connect() { return connected; },
    async getCachedEntity(id) { return { id }; },
    noteFloodWait() { return 0; },
    client: {
      async sendFile(entity, opts) {
        const size = fs.statSync(opts.file).size;
        sent.push({ entity, file: opts.file, caption: opts.caption, size, attributes: opts.attributes, supportsStreaming: opts.supportsStreaming });
        return { id: 1000 + sent.length, media: { document: { size: String(size + sizeOffset) } } };
      }
    }
  };
}

async function main() {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const partsDir = path.join(TEST_DIR, 'parts');
  const source = path.join(TEST_DIR, 'source.mp4');

  // 60s, 1s GOP so stream-copy segmenting has keyframes to cut on.
  const gen = spawnSync(getFFmpegPath(), [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc=duration=60:size=640x360:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=60',
    '-c:v', 'libx264', '-g', '25', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source
  ], { encoding: 'utf8' });
  if (gen.status !== 0 || !fs.existsSync(source)) {
    console.error('ffmpeg is required for this test:', gen.stderr || gen.error);
    process.exit(1);
  }
  const sourceSize = fs.statSync(source).size;
  const sourceProbe = await probeMedia(source);
  const media = { mediaId: 'm_test', duration: sourceProbe.data.duration };

  section('1. Small file: single upload');
  {
    const reader = makeFakeReader();
    const up = new MtprotoVideoUploader({ reader, partsDir, maxPartBytes: sourceSize * 2 });
    const res = await up.publish({ destinationId: 'me', filePath: source, caption: 'Title', media });
    check('one message sent', reader.sent.length === 1, JSON.stringify(res));
    check('original file uploaded directly', reader.sent[0].file === source);
    check('caption unchanged', reader.sent[0].caption === 'Title');
    check('streaming video attribute set', reader.sent[0].supportsStreaming === true && reader.sent[0].attributes && reader.sent[0].attributes.length === 1);
    check('result carries messageId', res.messageId === 1001 && res.parts === 1);
  }

  section('2-4. Large file: split into parts');
  {
    const reader = makeFakeReader();
    const maxPartBytes = Math.floor(sourceSize / 3);
    const up = new MtprotoVideoUploader({ reader, partsDir, maxPartBytes });
    const probes = [];
    const origSend = reader.client.sendFile;
    reader.client.sendFile = async (entity, opts) => {
      probes.push(await probeMedia(opts.file));
      return origSend(entity, opts);
    };
    const res = await up.publish({ destinationId: 'me', filePath: source, caption: 'Title', media });
    const n = reader.sent.length;
    check('split into more than one part', n > 1, `parts=${n}`);
    check('every part <= maxPartBytes', reader.sent.every(s => s.size <= maxPartBytes), JSON.stringify(reader.sent.map(s => s.size)));
    check('captions numbered in order', reader.sent.every((s, i) => s.caption === `Title\n\n(${i + 1}/${n})`));
    check('result lists all message ids', res.parts === n && res.messageIds.length === n && res.messageId === res.messageIds[0]);
    check('every part is a valid video', probes.every(p => p.success && p.data.width === 640 && p.data.height === 360));
    const total = probes.reduce((sum, p) => sum + (p.success ? p.data.duration : 0), 0);
    check('part durations add up to source', Math.abs(total - media.duration) <= 2, `total=${total} source=${media.duration}`);
    check('source file untouched', fs.statSync(source).size === sourceSize);
    check('parts directory cleaned', fs.readdirSync(partsDir).length === 0, fs.readdirSync(partsDir).join(','));
  }

  section('5. Read-back size mismatch');
  {
    const reader = makeFakeReader({ sizeOffset: 1 });
    const up = new MtprotoVideoUploader({ reader, partsDir, maxPartBytes: Math.floor(sourceSize / 3) });
    let error = null;
    try { await up.publish({ destinationId: 'me', filePath: source, caption: 'T', media }); } catch (e) { error = e; }
    check('throws on size mismatch', error && /size mismatch/.test(error.message), error && error.message);
    check('stops after first bad part', reader.sent.length === 1);
    check('parts directory cleaned after failure', fs.readdirSync(partsDir).length === 0);
  }

  section('6. Disconnected session');
  {
    const reader = makeFakeReader({ connected: false });
    const up = new MtprotoVideoUploader({ reader, partsDir, maxPartBytes: sourceSize * 2 });
    let error = null;
    try { await up.publish({ destinationId: 'me', filePath: source, caption: 'T', media }); } catch (e) { error = e; }
    check('throws when not connected', error && /not connected/.test(error.message), error && error.message);
    check('nothing uploaded', reader.sent.length === 0);
  }

  section('7. Runtime wiring (mtproto mode)');
  {
    const saved = { ...process.env };
    process.env.TELEGRAM_SESSION_STRING = 'x';
    process.env.TELEGRAM_API_ID = '1';
    process.env.TELEGRAM_API_HASH = 'y';
    try {
      const { VideoPipelineRuntime } = require('./video_pipeline_runtime');
      const base = {
        enabled: true, sourceMode: 'authorized', authorizedSourceUrl: 'https://example.invalid/list',
        stagingChatId: 'me', stateDir: path.join(TEST_DIR, 'state'), outputDir: path.join(TEST_DIR, 'out'),
        downloadsDir: path.join(TEST_DIR, 'dl'), uploadPartsDir: partsDir, cdpUrl: 'http://127.0.0.1:9222'
      };
      const rt = new VideoPipelineRuntime({ ...base, uploadMode: 'mtproto' });
      check('mtproto config valid without a bot client', rt._configValid, rt._lastConfigError);
      check('cdpUrl passed to acquisition', rt.acquisitionOptions.cdpUrl === 'http://127.0.0.1:9222');
      rt._ensureManagerInitialized();
      const pub = rt.batchCycleManager.videoBatchPublisher;
      check('publisher uses publish() hook', pub.telegramClient && typeof pub.telegramClient.publish === 'function' && typeof pub.telegramClient.sendVideo !== 'function');
      check('publisher size ceiling raised above 50 MB', pub.maxUploadBytes > 1024 * 1024 * 1024, String(pub.maxUploadBytes));

      const bad = new VideoPipelineRuntime({ ...base, uploadMode: 'carrier-pigeon' });
      check('unknown upload mode rejected', !bad._configValid && /UPLOAD_MODE/.test(bad._lastConfigError));

      delete process.env.TELEGRAM_SESSION_STRING;
      const noSession = new VideoPipelineRuntime({ ...base, uploadMode: 'mtproto' });
      check('mtproto mode without session rejected', !noSession._configValid && /TELEGRAM_SESSION_STRING/.test(noSession._lastConfigError));
    } finally {
      process.env = saved;
    }
  }

  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('Test crashed:', err);
  process.exit(1);
});
