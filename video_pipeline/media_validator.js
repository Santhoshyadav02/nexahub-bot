/**
 * ============================================================
 * 🔍 MEDIA VALIDATOR (Phase 2 - Media Ingestor support module)
 * ============================================================
 * Self-contained MP4 validation helpers. Does NOT modify or depend on
 * video-tools' own download_videos.py validator (frozen, untouched) - this
 * is an independent, JS-side check applied AFTER video-tools has already
 * produced a completed file, following the same approach already proven in
 * tools/import_authorized_media.js (read as reference only, not required
 * here, to avoid coupling to its CLI/AvseeSourceAdapter concerns).
 *
 * Layers, cheapest first:
 *   1. ISOBMFF header check (ftyp/moov box in the first 32 bytes) - mirrors
 *      download_videos.py's is_valid_mp4_header() logic, reimplemented in JS.
 *   2. FFprobe (if available) - container/stream metadata as real evidence,
 *      not a hand-rolled codec parser.
 *   3. FFmpeg full decode pass (if available) - catches corruption that a
 *      valid-looking header can still hide.
 *
 * FFprobe/FFmpeg are REQUIRED for a media file to be considered valid. There
 * is no developer-machine hardcoded path here (removed - it only ever worked
 * on one Windows dev box and silently meant nothing in production, where
 * nixpacks.toml now installs a real `ffmpeg` package providing both binaries
 * on PATH). Resolution order is exactly:
 *   1. FFMPEG_PATH / FFPROBE_PATH env var, if set and it exists.
 *   2. The bare `ffmpeg` / `ffprobe` command, resolved via the system PATH.
 * If neither resolves to a working binary, validation FAILS CLOSED (valid:
 * false) with toolingUnavailable:true and a clear error - it never silently
 * downgrades to a weaker check and calls it "valid".
 *
 * All external tooling runs ASYNCHRONOUSLY (child_process.spawn wrapped in a
 * Promise) with a hard timeout that kills the child. A full decode of a large
 * file can take minutes; running it via spawnSync would freeze the whole
 * bot's event loop (Telegram polling, commands, other schedulers) meanwhile.
 *   - VIDEO_PIPELINE_PROBE_TIMEOUT_MS      (default 60s)  - ffprobe
 *   - VIDEO_PIPELINE_VALIDATION_TIMEOUT_MS (default 5min) - ffmpeg full decode
 */

const fs = require('fs');
const { spawn } = require('child_process');

const LOG_PREFIX = '[MEDIA_VALIDATOR]';
const DEFAULT_PROBE_TIMEOUT_MS = 60 * 1000;
const DEFAULT_DECODE_TIMEOUT_MS = 5 * 60 * 1000;
const VERSION_CHECK_TIMEOUT_MS = 5000;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

// ffmpeg writes plenty of harmless diagnostics to stderr even at -v error
// (e.g. a few damaged-but-concealed frames, non-monotonic DTS). A clean exit
// code with only such noise is a PASS; these patterns mean the file is
// genuinely unusable even when ffmpeg still exits 0.
const FATAL_DECODE_PATTERNS = [
  /moov atom not found/i,
  /Invalid data found when processing input/i,
  /could not find codec parameters/i,
  /partial file/i
];

function readPositiveIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function getProbeTimeoutMs() {
  return readPositiveIntEnv('VIDEO_PIPELINE_PROBE_TIMEOUT_MS', DEFAULT_PROBE_TIMEOUT_MS);
}

function getDecodeTimeoutMs() {
  return readPositiveIntEnv('VIDEO_PIPELINE_VALIDATION_TIMEOUT_MS', DEFAULT_DECODE_TIMEOUT_MS);
}

function getFFmpegPath() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    return process.env.FFMPEG_PATH;
  }
  return 'ffmpeg';
}

function getFFprobePath() {
  if (process.env.FFPROBE_PATH && fs.existsSync(process.env.FFPROBE_PATH)) {
    return process.env.FFPROBE_PATH;
  }
  return 'ffprobe';
}

/**
 * Runs a child process asynchronously, collecting (bounded) stdout/stderr.
 * Never rejects: spawn failures (e.g. ENOENT) are reported via `error`, and a
 * child still running at timeoutMs is SIGKILLed and reported via `timedOut`.
 * @param {string} bin
 * @param {string[]} args
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{code: number|null, signal: string|null, stdout: string, stderr: string, timedOut: boolean, error: Error|null}>}
 */
function runProcess(bin, args, { timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        code: null,
        signal: null,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        timedOut,
        error: null,
        ...result
      });
    };

    try {
      child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      finish({ error: err });
      return;
    }

    child.stdout.on('data', (chunk) => {
      if (stdoutBytes < MAX_STDOUT_BYTES) {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      }
    });
    child.stderr.on('data', (chunk) => {
      if (stderrBytes < MAX_STDERR_BYTES) {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      }
    });

    child.on('error', (err) => finish({ error: err }));
    child.on('close', (code, signal) => finish({ code, signal }));

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGKILL'); } catch (e) {}
        // 'close' normally follows the kill almost immediately; this is only a
        // backstop so a wedged pipe can never leave the caller hanging.
        setTimeout(() => finish({ code: null, signal: 'SIGKILL' }), 2000).unref();
      }, timeoutMs);
    }
  });
}

// Positive availability results are cached per (binary, PATH) so every file
// validated doesn't pay for two extra `-version` process launches. Negative
// results are never cached - installing ffmpeg must take effect without a restart.
const availabilityCache = new Set();

async function binaryAvailable(binPath) {
  const cacheKey = `${binPath}|${process.env.PATH || ''}`;
  if (availabilityCache.has(cacheKey)) return true;
  const res = await runProcess(binPath, ['-version'], { timeoutMs: VERSION_CHECK_TIMEOUT_MS });
  const ok = !res.error && !res.timedOut && res.code === 0;
  if (ok) availabilityCache.add(cacheKey);
  return ok;
}

/**
 * Checks the first 32 bytes of a file for an ISOBMFF ftyp/moov box, exactly
 * mirroring download_videos.py's is_valid_mp4_header() check.
 * @param {Buffer} prefix
 * @returns {boolean}
 */
function hasValidMp4Header(prefix) {
  if (!prefix || prefix.length < 8) return false;
  const boxType = prefix.subarray(4, 8).toString('latin1');
  return boxType === 'ftyp' || boxType === 'moov';
}

function readHeaderPrefix(filePath, length = 32) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buf, 0, length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Runs ffprobe and extracts duration/codec/resolution for the first video stream.
 * @param {string} filePath
 * @param {object} [options]
 * @param {number} [options.timeoutMs] Defaults to VIDEO_PIPELINE_PROBE_TIMEOUT_MS / 60s
 * @returns {Promise<{success: boolean, data?: object, error?: string, unavailable?: boolean, timedOut?: boolean}>}
 */
async function probeMedia(filePath, { timeoutMs = getProbeTimeoutMs() } = {}) {
  const probeBin = getFFprobePath();
  if (!(await binaryAvailable(probeBin))) {
    return { success: false, error: 'ffprobe not available', unavailable: true };
  }
  try {
    const res = await runProcess(probeBin, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath
    ], { timeoutMs });

    if (res.error) {
      return { success: false, error: `Failed to execute FFprobe: ${res.error.message}` };
    }
    if (res.timedOut) {
      return { success: false, timedOut: true, error: `FFprobe timed out after ${timeoutMs}ms and was killed` };
    }
    if (res.code !== 0) {
      return { success: false, error: `FFprobe exited with code ${res.code}: ${(res.stderr || 'Unknown error').trim()}` };
    }

    const json = JSON.parse(res.stdout);
    const videoStream = (json.streams || []).find(s => s.codec_type === 'video');
    if (!videoStream) {
      return { success: false, error: 'No video stream found in media container' };
    }
    const audioStream = (json.streams || []).find(s => s.codec_type === 'audio');

    const containerFormat = json.format ? json.format.format_name : 'unknown';
    // ffprobe's format_name is often a comma-separated alias list (e.g.
    // "mov,mp4,m4a,3gp,3g2,mj2") - the container is genuinely ambiguous
    // among those without also inspecting the file extension/ftyp brand, so
    // report the first (most specific/primary) alias rather than guessing.
    const container = containerFormat && containerFormat !== 'unknown' ? containerFormat.split(',')[0] : 'unknown';
    const mimeType = container === 'mp4' || container === 'mov' || container === 'm4v'
      ? 'video/mp4'
      : (container && container !== 'unknown' ? `video/${container}` : 'application/octet-stream');

    let frameRate = null;
    const rate = videoStream.avg_frame_rate || videoStream.r_frame_rate;
    if (rate && rate !== '0/0') {
      const [num, den] = rate.split('/').map(Number);
      if (den) frameRate = Math.round((num / den) * 100) / 100;
    }

    return {
      success: true,
      data: {
        format: containerFormat,
        container,
        mimeType,
        duration: json.format && json.format.duration ? parseFloat(json.format.duration) : 0,
        codec: videoStream.codec_name || 'unknown',
        width: videoStream.width || 0,
        height: videoStream.height || 0,
        frameRate,
        hasAudio: Boolean(audioStream),
        audioCodec: audioStream ? (audioStream.codec_name || 'unknown') : null
      }
    };
  } catch (err) {
    return { success: false, error: `Failed to execute FFprobe: ${err.message}` };
  }
}

/**
 * Pure decision function for an ffmpeg decode pass. Failure is based on the
 * exit code; stderr alone is only fatal when it matches a clearly-fatal
 * pattern - otherwise it is kept as non-fatal warnings.
 * @param {{code: number|null, stderr?: string, timedOut?: boolean, error?: Error|null}} res
 * @returns {{passed: boolean, error: string|null, warnings: string|null, timedOut?: boolean}}
 */
function evaluateDecodeResult(res) {
  const stderr = String((res && res.stderr) || '').trim();
  if (res && res.error) {
    return { passed: false, error: `Failed to execute FFmpeg: ${res.error.message}`, warnings: null };
  }
  if (res && res.timedOut) {
    return { passed: false, timedOut: true, error: 'FFmpeg decode timed out and was killed', warnings: stderr || null };
  }
  if (!res || res.code !== 0) {
    return { passed: false, error: stderr || `FFmpeg exited with code ${res ? res.code : 'unknown'}`, warnings: null };
  }
  const fatal = FATAL_DECODE_PATTERNS.find(pattern => pattern.test(stderr));
  if (fatal) {
    return { passed: false, error: stderr, warnings: null };
  }
  return { passed: true, error: null, warnings: stderr || null };
}

/**
 * Runs a full FFmpeg decode pass (output discarded) to catch corruption a
 * valid-looking container/header can still hide.
 * @param {string} filePath
 * @param {object} [options]
 * @param {number} [options.timeoutMs] Defaults to VIDEO_PIPELINE_VALIDATION_TIMEOUT_MS / 5min
 * @returns {Promise<{passed: boolean, error?: string, warnings?: string, unavailable?: boolean, timedOut?: boolean}>}
 */
async function decodeCheck(filePath, { timeoutMs = getDecodeTimeoutMs() } = {}) {
  const ffmpegBin = getFFmpegPath();
  if (!(await binaryAvailable(ffmpegBin))) {
    return { passed: false, error: 'ffmpeg not available', unavailable: true };
  }
  const nullTarget = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const res = await runProcess(ffmpegBin, ['-nostdin', '-v', 'error', '-i', filePath, '-f', 'null', nullTarget], { timeoutMs });
  const evaluated = evaluateDecodeResult(res);
  if (evaluated.timedOut) {
    evaluated.error = `FFmpeg decode timed out after ${timeoutMs}ms and was killed`;
  }
  return evaluated;
}

/**
 * Full validation pipeline for a completed (stable) media file.
 * @param {string} filePath
 * @param {object} [options]
 * @param {number} [options.probeTimeoutMs]
 * @param {number} [options.decodeTimeoutMs]
 * @returns {Promise<{
 *   valid: boolean, hasVideoTrack: boolean, error: string|null,
 *   duration: number|null, width: number|null, height: number|null,
 *   codec: string|null, ffprobeUsed: boolean, ffmpegDecodeUsed: boolean,
 *   toolingUnavailable: boolean, timedOut: boolean
 * }>}
 */
async function validateMediaFile(filePath, options = {}) {
  const result = {
    valid: false,
    hasVideoTrack: false,
    error: null,
    duration: null,
    width: null,
    height: null,
    codec: null,
    container: null,
    mimeType: null,
    frameRate: null,
    hasAudio: null,
    audioCodec: null,
    ffprobeUsed: false,
    ffmpegDecodeUsed: false,
    toolingUnavailable: false,
    timedOut: false,
    decodeWarnings: null
  };

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    result.error = `File does not exist or is not readable: ${err.message}`;
    return result;
  }
  if (!stat.isFile() || stat.size === 0) {
    result.error = 'File is empty or not a regular file';
    return result;
  }

  let prefix;
  try {
    prefix = readHeaderPrefix(filePath, 32);
  } catch (err) {
    result.error = `Failed to read file header: ${err.message}`;
    return result;
  }
  if (!hasValidMp4Header(prefix)) {
    result.error = 'Missing MP4 ftyp/moov header (not a valid ISOBMFF container)';
    return result;
  }

  const probeRes = await probeMedia(filePath, options.probeTimeoutMs ? { timeoutMs: options.probeTimeoutMs } : undefined);
  if (probeRes.unavailable) {
    // Fail closed: ffprobe is required evidence, not optional. A missing
    // binary must never be silently treated as "validated" - that would let
    // an unverified file reach READY/publish just because tooling was absent.
    const message = 'ffprobe is required for media validation but was not found '
      + '(checked FFPROBE_PATH and the system PATH). Refusing to mark this media as valid.';
    console.error(`${LOG_PREFIX} ${message}`);
    result.valid = false;
    result.toolingUnavailable = true;
    result.error = message;
    return result;
  }
  if (!probeRes.success) {
    result.timedOut = Boolean(probeRes.timedOut);
    result.error = `FFprobe validation failed: ${probeRes.error}`;
    return result;
  }
  result.ffprobeUsed = true;
  result.duration = probeRes.data.duration;
  result.width = probeRes.data.width;
  result.height = probeRes.data.height;
  result.codec = probeRes.data.codec;
  result.container = probeRes.data.container;
  result.mimeType = probeRes.data.mimeType;
  result.frameRate = probeRes.data.frameRate;
  result.hasAudio = probeRes.data.hasAudio;
  result.audioCodec = probeRes.data.audioCodec;

  if (!(result.duration > 0)) {
    result.error = `Invalid duration reported by ffprobe: ${result.duration}`;
    return result;
  }
  if (!(result.width > 0) || !(result.height > 0)) {
    result.error = `Invalid resolution reported by ffprobe: ${result.width}x${result.height}`;
    return result;
  }

  // Caller already holds a full-decode verdict for these exact bytes (proven
  // by SHA256): header + ffprobe checks above are re-run, the decode is not.
  if (options.skipDecode) {
    result.valid = true;
    result.hasVideoTrack = true;
    return result;
  }

  const decodeRes = await decodeCheck(filePath, options.decodeTimeoutMs ? { timeoutMs: options.decodeTimeoutMs } : undefined);
  if (decodeRes.unavailable) {
    const message = 'ffmpeg is required for media validation but was not found '
      + '(checked FFMPEG_PATH and the system PATH). Refusing to mark this media as valid.';
    console.error(`${LOG_PREFIX} ${message}`);
    result.valid = false;
    result.toolingUnavailable = true;
    result.error = message;
    return result;
  }
  if (!decodeRes.passed) {
    result.timedOut = Boolean(decodeRes.timedOut);
    result.error = `FFmpeg decode failed: ${decodeRes.error}`;
    return result;
  }
  result.decodeWarnings = decodeRes.warnings || null;
  result.ffmpegDecodeUsed = true;
  result.valid = true;
  result.hasVideoTrack = true;
  return result;
}

module.exports = {
  hasValidMp4Header,
  readHeaderPrefix,
  probeMedia,
  decodeCheck,
  evaluateDecodeResult,
  validateMediaFile,
  runProcess,
  getFFmpegPath,
  getFFprobePath,
  FATAL_DECODE_PATTERNS
};
