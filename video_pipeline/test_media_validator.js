/**
 * ============================================================
 * 🧪 MEDIA VALIDATOR - FOCUSED FAIL-CLOSED TEST
 * ============================================================
 * Verifies: (1) real validation still works with ffmpeg/ffprobe available,
 * (2) missing tooling now FAILS CLOSED (valid:false, toolingUnavailable:true)
 * instead of silently passing, (3) no hardcoded developer-machine path
 * remains anywhere in the module.
 */
const fs = require('fs');
const path = require('path');
const { validateMediaFile, getFFmpegPath, getFFprobePath } = require('./media_validator');

let passed = 0, failed = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`✅ ${label}`); passed++; }
  else { console.error(`❌ ${label}${detail ? ' - ' + detail : ''}`); failed++; }
}

const FIXTURE_MP4 = path.join(__dirname, '..', 'scratch', 'real_video_test.mp4');

async function main() {
  console.log('--- No hardcoded developer-machine path remains ---');
  const src = fs.readFileSync(path.join(__dirname, 'media_validator.js'), 'utf8');
  check('Source contains no hardcoded WinGet/C:\\Users path', !/C:\\\\Users\\\\sam|WinGet/i.test(src));

  console.log('\n--- Real validation still works when FFMPEG_PATH/FFPROBE_PATH are set ---');
  check('FFMPEG_PATH env var is set for this test run', !!process.env.FFMPEG_PATH, 'set FFMPEG_PATH before running this test locally');
  check('getFFmpegPath() resolves to the configured env var', getFFmpegPath() === process.env.FFMPEG_PATH);
  check('getFFprobePath() resolves to the configured env var', getFFprobePath() === process.env.FFPROBE_PATH);

  const goodResult = await validateMediaFile(FIXTURE_MP4);
  check('Valid MP4 with real tooling available -> valid:true', goodResult.valid === true, JSON.stringify(goodResult));
  check('ffprobeUsed/ffmpegDecodeUsed both true (real deep validation ran, not degraded)', goodResult.ffprobeUsed && goodResult.ffmpegDecodeUsed);
  check('toolingUnavailable is false on a genuine pass', goodResult.toolingUnavailable === false);

  console.log('\n--- Fail-closed: missing ffprobe/ffmpeg must FAIL, never silently pass ---');
  const savedFFMPEG = process.env.FFMPEG_PATH;
  const savedFFPROBE = process.env.FFPROBE_PATH;
  delete process.env.FFMPEG_PATH;
  delete process.env.FFPROBE_PATH;
  // Force PATH resolution to fail too, by clearing PATH for this check only.
  const savedPath = process.env.PATH;
  process.env.PATH = '';
  try {
    const badResult = await validateMediaFile(FIXTURE_MP4);
    check('Missing tooling -> valid:false (NOT silently true)', badResult.valid === false, JSON.stringify(badResult));
    check('toolingUnavailable is explicitly reported as true', badResult.toolingUnavailable === true);
    check('A clear, non-empty error message is reported', typeof badResult.error === 'string' && badResult.error.length > 0);
  } finally {
    process.env.PATH = savedPath;
    process.env.FFMPEG_PATH = savedFFMPEG;
    process.env.FFPROBE_PATH = savedFFPROBE;
  }

  console.log('\n--- Still correctly rejects genuinely invalid media (unrelated to tooling) ---');
  const htmlPath = path.join(__dirname, '..', 'scratch', '_validator_test_fake.mp4');
  fs.writeFileSync(htmlPath, '<html>not a video</html>');
  const fakeResult = await validateMediaFile(htmlPath);
  check('HTML masquerading as .mp4 -> valid:false', fakeResult.valid === false);
  check('Failure reason mentions the header check, not tooling', /header|ftyp/i.test(fakeResult.error || ''));
  fs.unlinkSync(htmlPath);

  console.log(`\n============================================================`);
  console.log(`MEDIA VALIDATOR RESULT: ${passed} passed, ${failed} failed`);
  console.log(`============================================================`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('CRASHED:', err); process.exit(1); });
