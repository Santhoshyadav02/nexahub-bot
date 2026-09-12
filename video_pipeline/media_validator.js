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
 */

const fs = require('fs');
const { spawnSync } = require('child_process');

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

function binaryAvailable(binPath) {
  try {
    const res = spawnSync(binPath, ['-version'], { encoding: 'utf8', timeout: 5000 });
    return res.status === 0;
  } catch (e) {
    return false;
  }
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
 * @returns {{success: boolean, data?: object, error?: string}}
 */
function probeMedia(filePath) {
  const probeBin = getFFprobePath();
  if (!binaryAvailable(probeBin)) {
    return { success: false, error: 'ffprobe not available', unavailable: true };
  }
  try {
    const res = spawnSync(probeBin, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath
    ], { encoding: 'utf8' });

    if (res.status !== 0) {
      return { success: false, error: `FFprobe exited with code ${res.status}: ${(res.stderr || 'Unknown error').trim()}` };
    }

    const json = JSON.parse(res.stdout);
    const videoStream = (json.streams || []).find(s => s.codec_type === 'video');
    if (!videoStream) {
      return { success: false, error: 'No video stream found in media container' };
    }

    return {
      success: true,
      data: {
        format: json.format ? json.format.format_name : 'unknown',
        duration: json.format && json.format.duration ? parseFloat(json.format.duration) : 0,
        codec: videoStream.codec_name || 'unknown',
        width: videoStream.width || 0,
        height: videoStream.height || 0
      }
    };
  } catch (err) {
    return { success: false, error: `Failed to execute FFprobe: ${err.message}` };
  }
}

/**
 * Runs a full FFmpeg decode pass (output discarded) to catch corruption a
 * valid-looking container/header can still hide.
 * @param {string} filePath
 * @returns {{passed: boolean, error?: string, unavailable?: boolean}}
 */
function decodeCheck(filePath) {
  const ffmpegBin = getFFmpegPath();
  if (!binaryAvailable(ffmpegBin)) {
    return { passed: false, error: 'ffmpeg not available', unavailable: true };
  }
  const nullTarget = process.platform === 'win32' ? 'NUL' : '/dev/null';
  try {
    const res = spawnSync(ffmpegBin, ['-v', 'error', '-i', filePath, '-f', 'null', nullTarget], { encoding: 'utf8' });
    const stderr = (res.stderr || '').trim();
    const passed = res.status === 0 && stderr.length === 0;
    return { passed, error: passed ? null : (stderr || `FFmpeg exited with code ${res.status}`) };
  } catch (err) {
    return { passed: false, error: `Failed to execute FFmpeg: ${err.message}` };
  }
}

/**
 * Full validation pipeline for a completed (stable) media file.
 * @param {string} filePath
 * @returns {{
 *   valid: boolean, hasVideoTrack: boolean, error: string|null,
 *   duration: number|null, width: number|null, height: number|null,
 *   codec: string|null, ffprobeUsed: boolean, ffmpegDecodeUsed: boolean
 * }}
 */
function validateMediaFile(filePath) {
  const result = {
    valid: false,
    hasVideoTrack: false,
    error: null,
    duration: null,
    width: null,
    height: null,
    codec: null,
    ffprobeUsed: false,
    ffmpegDecodeUsed: false,
    toolingUnavailable: false
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

  const probeRes = probeMedia(filePath);
  if (probeRes.unavailable) {
    // Fail closed: ffprobe is required evidence, not optional. A missing
    // binary must never be silently treated as "validated" - that would let
    // an unverified file reach READY/publish just because tooling was absent.
    const message = 'ffprobe is required for media validation but was not found '
      + '(checked FFPROBE_PATH and the system PATH). Refusing to mark this media as valid.';
    console.error(`[MEDIA_VALIDATOR] ${message}`);
    result.valid = false;
    result.toolingUnavailable = true;
    result.error = message;
    return result;
  }
  if (!probeRes.success) {
    result.error = `FFprobe validation failed: ${probeRes.error}`;
    return result;
  }
  result.ffprobeUsed = true;
  result.duration = probeRes.data.duration;
  result.width = probeRes.data.width;
  result.height = probeRes.data.height;
  result.codec = probeRes.data.codec;

  const decodeRes = decodeCheck(filePath);
  if (decodeRes.unavailable) {
    const message = 'ffmpeg is required for media validation but was not found '
      + '(checked FFMPEG_PATH and the system PATH). Refusing to mark this media as valid.';
    console.error(`[MEDIA_VALIDATOR] ${message}`);
    result.valid = false;
    result.toolingUnavailable = true;
    result.error = message;
    return result;
  }
  if (!decodeRes.passed) {
    result.error = `FFmpeg decode failed: ${decodeRes.error}`;
    return result;
  }
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
  validateMediaFile,
  getFFmpegPath,
  getFFprobePath
};
