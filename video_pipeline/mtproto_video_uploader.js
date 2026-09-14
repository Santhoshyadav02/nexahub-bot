/**
 * ============================================================
 * 📤 MTPROTO VIDEO UPLOADER
 * ============================================================
 * Telegram client adapter for VideoBatchPublisher (its `publish()` hook) that
 * uploads through the shared MTProto USER session instead of the Bot API.
 *
 *   - Bot API uploads stop at 50 MB; a user session accepts files up to 2 GB.
 *   - Files above maxPartBytes are split with ffmpeg stream copy (no
 *     re-encode, cut on keyframes) into standalone MP4 parts, each uploaded
 *     as its own streamable video with a "(i/n)" caption suffix.
 *   - Reuses the MTProtoChannelReader singleton: a second client on the same
 *     session string gets the session revoked (AUTH_KEY_DUPLICATED).
 *   - Every sent message is checked for a document of the exact uploaded
 *     size; any mismatch throws, so the publisher records a failure and keeps
 *     the source file.
 *   - Temporary parts live outside the downloads directory and are always
 *     removed afterwards.
 */

const fs = require('fs');
const path = require('path');

const { runProcess, probeMedia, getFFmpegPath } = require('./media_validator');

const LOG_PREFIX = '[MTPROTO_VIDEO_UPLOADER]';

// 4000 parts x 512 KiB is the non-premium ceiling (~1.95 GiB); stay below it.
const DEFAULT_MAX_PART_BYTES = 1900 * 1024 * 1024;
// Keyframe-aligned cuts overshoot the estimate, so aim well under the ceiling.
const SPLIT_TARGET_RATIO = 0.8;
const MAX_SPLIT_ATTEMPTS = 4;
// Only guards against a zero/negative segment time; a higher floor would stop
// the retry loop from ever shrinking below it.
const MIN_SEGMENT_SEC = 1;
const SPLIT_TIMEOUT_MS = 60 * 60 * 1000;
const UPLOAD_WORKERS = 4;
// Upload deadline per part: a fixed base plus a floor throughput of 256 KiB/s.
const UPLOAD_BASE_TIMEOUT_MS = 10 * 60 * 1000;
const UPLOAD_MIN_BYTES_PER_SEC = 256 * 1024;

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`TIMEOUT: ${label} did not complete within ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function readPositiveIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * @param {object} entity GramJS User/Chat/Channel
 * @returns {string|null} why the session account cannot post videos there, or null if it can
 */
function postingDeniedReason(entity) {
  if (!entity) return 'chat not found';
  const kind = entity.className;
  if (kind === 'User') return null; // "me" / private chats
  if (kind === 'ChannelForbidden' || kind === 'ChatForbidden') return 'account was removed or banned from this chat';
  if (entity.left) return 'account is not a member';
  if (entity.deactivated) return 'chat is deactivated';
  if (entity.creator) return null;

  const admin = entity.adminRights;
  if (kind === 'Channel' && entity.broadcast) {
    return admin && admin.postMessages ? null : 'broadcast channel: account is not an admin with "post messages" right';
  }
  if (admin) return null;
  for (const rights of [entity.bannedRights, entity.defaultBannedRights]) {
    if (rights && (rights.sendMessages || rights.sendMedia || rights.sendVideos)) {
      return 'group restricts sending videos for this account';
    }
  }
  return null;
}

class MtprotoVideoUploader {
  /**
   * @param {object} [config]
   * @param {object} [config.reader] MTProtoChannelReader-like object (connect(), client, getCachedEntity(), noteFloodWait()); defaults to the shared singleton
   * @param {string} [config.partsDir] Scratch directory for split parts (must not be the downloads directory)
   * @param {number} [config.maxPartBytes] Largest single upload (default VIDEO_PIPELINE_MTPROTO_MAX_PART_BYTES or 1900 MiB)
   */
  constructor(config = {}) {
    this._reader = config.reader || null;
    this.partsDir = config.partsDir || null;
    this.maxPartBytes = config.maxPartBytes || readPositiveIntEnv('VIDEO_PIPELINE_MTPROTO_MAX_PART_BYTES', DEFAULT_MAX_PART_BYTES);
    this.uploadWorkers = config.uploadWorkers || UPLOAD_WORKERS;
  }

  get reader() {
    if (!this._reader) {
      const MTProtoChannelReader = require('../mtproto_reader');
      this._reader = new MTProtoChannelReader();
    }
    return this._reader;
  }

  /**
   * VideoBatchPublisher `publish()` hook.
   * @returns {Promise<{messageId: number, messageIds: number[], parts: number}>}
   */
  async publish({ destinationId, filePath, caption, media }) {
    const reader = this.reader;
    const connected = await reader.connect();
    if (!connected || !reader.client) {
      throw new Error(`MTProto user session is not connected${reader.fatalError ? `: ${reader.fatalError}` : ''}`);
    }

    const entity = await this._resolveEntity(reader, destinationId);
    const size = fs.statSync(filePath).size;

    let parts = [filePath];
    let partsWorkDir = null;
    try {
      if (size > this.maxPartBytes) {
        partsWorkDir = this._makeWorkDir(media, filePath);
        parts = await this._split(filePath, size, media, partsWorkDir);
        console.log(`${LOG_PREFIX} ${path.basename(filePath)} (${size} bytes) split into ${parts.length} part(s).`);
      }

      const messageIds = [];
      for (let i = 0; i < parts.length; i++) {
        const partCaption = parts.length > 1 ? `${caption}\n\n(${i + 1}/${parts.length})` : caption;
        const message = await this._uploadPart(reader, entity, parts[i], partCaption, i + 1, parts.length);
        messageIds.push(message.id);
      }

      return { messageId: messageIds[0], messageIds, parts: parts.length };
    } finally {
      if (partsWorkDir) {
        fs.rmSync(partsWorkDir, { recursive: true, force: true });
      }
    }
  }

  /**
   * Resolves "me", @usernames and numeric (-100...) chat ids. Numeric ids are
   * only resolvable from the session's entity cache, so on a miss the dialog
   * list is loaded once more (connect() only preloads the first 100).
   */
  async _resolveEntity(reader, destinationId) {
    const id = String(destinationId).trim();
    const peer = /^-?\d+$/.test(id) ? require('big-integer')(id) : id;
    try {
      return await reader.getCachedEntity(peer);
    } catch (err) {
      if (!(peer instanceof Object) || this._dialogsReloaded) throw err;
      this._dialogsReloaded = true;
      console.warn(`${LOG_PREFIX} ${id} not in entity cache; loading dialogs and retrying.`);
      await withTimeout(reader.client.getDialogs({ limit: 1000 }), 120000, 'getDialogs(1000)');
      return reader.getCachedEntity(peer);
    }
  }

  /**
   * Checks, without sending anything, whether the session account can post
   * videos to each chat.
   * @param {string[]} ids
   * @returns {Promise<{ok: string[], denied: {id: string, reason: string}[]}>}
   */
  async checkDestinations(ids) {
    const reader = this.reader;
    const connected = await reader.connect();
    if (!connected || !reader.client) {
      throw new Error(`MTProto user session is not connected${reader.fatalError ? `: ${reader.fatalError}` : ''}`);
    }
    const ok = [];
    const denied = [];
    for (const id of ids) {
      try {
        const entity = await this._resolveEntity(reader, id);
        const reason = postingDeniedReason(entity);
        if (reason) denied.push({ id, reason });
        else ok.push(id);
      } catch (err) {
        denied.push({ id, reason: `cannot resolve chat (${err.message})` });
      }
    }
    return { ok, denied };
  }

  _makeWorkDir(media, filePath) {
    if (!this.partsDir) {
      throw new Error('MtprotoVideoUploader requires partsDir to split files larger than maxPartBytes.');
    }
    const id = (media && media.mediaId) || path.basename(filePath, path.extname(filePath));
    const dir = path.join(this.partsDir, `${id}_${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  async _split(filePath, size, media, workDir) {
    let duration = media && media.duration > 0 ? media.duration : null;
    if (!duration) {
      const probe = await probeMedia(filePath);
      if (!probe.success || !(probe.data.duration > 0)) {
        throw new Error(`Cannot split ${path.basename(filePath)}: duration unknown (${probe.error || 'ffprobe returned no duration'})`);
      }
      duration = probe.data.duration;
    }

    let segmentSec = Math.max(MIN_SEGMENT_SEC, Math.floor(duration * (this.maxPartBytes * SPLIT_TARGET_RATIO) / size));
    for (let attempt = 1; attempt <= MAX_SPLIT_ATTEMPTS; attempt++) {
      for (const name of fs.readdirSync(workDir)) fs.rmSync(path.join(workDir, name), { force: true });

      const pattern = path.join(workDir, 'part_%03d.mp4');
      const res = await runProcess(getFFmpegPath(), [
        '-nostdin', '-v', 'error', '-i', filePath,
        '-map', '0:v:0', '-map', '0:a?', '-c', 'copy',
        '-f', 'segment', '-segment_time', String(segmentSec), '-reset_timestamps', '1',
        '-segment_format', 'mp4', '-segment_format_options', 'movflags=+faststart',
        pattern
      ], { timeoutMs: SPLIT_TIMEOUT_MS });
      if (res.timedOut || res.code !== 0) {
        throw new Error(`ffmpeg split failed (code=${res.code}${res.timedOut ? ', timed out' : ''}): ${String(res.stderr || '').slice(0, 500)}`);
      }

      const parts = fs.readdirSync(workDir).filter(n => n.endsWith('.mp4')).sort().map(n => path.join(workDir, n));
      if (parts.length === 0) {
        throw new Error('ffmpeg split produced no parts');
      }
      const largest = Math.max(...parts.map(p => fs.statSync(p).size));
      if (largest <= this.maxPartBytes) {
        return parts;
      }
      console.warn(`${LOG_PREFIX} Split attempt ${attempt}: largest part ${largest} bytes exceeds ${this.maxPartBytes}; retrying with shorter segments.`);
      segmentSec = Math.max(MIN_SEGMENT_SEC, Math.floor(segmentSec * (this.maxPartBytes * SPLIT_TARGET_RATIO) / largest));
    }
    throw new Error(`Could not split ${path.basename(filePath)} into parts of at most ${this.maxPartBytes} bytes`);
  }

  async _uploadPart(reader, entity, partPath, caption, index, total) {
    const { Api } = require('telegram');
    const partSize = fs.statSync(partPath).size;

    const probe = await probeMedia(partPath);
    const attributes = [];
    if (probe.success) {
      attributes.push(new Api.DocumentAttributeVideo({
        duration: Math.max(1, Math.round(probe.data.duration || 0)),
        w: probe.data.width || 0,
        h: probe.data.height || 0,
        supportsStreaming: true
      }));
    }

    const timeoutMs = UPLOAD_BASE_TIMEOUT_MS + Math.ceil(partSize / UPLOAD_MIN_BYTES_PER_SEC) * 1000;
    console.log(`${LOG_PREFIX} Uploading part ${index}/${total} (${partSize} bytes) via MTProto user session...`);

    let message;
    try {
      message = await withTimeout(reader.client.sendFile(entity, {
        file: partPath,
        caption,
        supportsStreaming: true,
        attributes: attributes.length ? attributes : undefined,
        workers: this.uploadWorkers
      }), timeoutMs, `MTProto upload of part ${index}/${total}`);
    } catch (err) {
      if (typeof reader.noteFloodWait === 'function') reader.noteFloodWait(err);
      throw err;
    }

    const document = message && message.media && message.media.document;
    if (!message || !message.id || !document) {
      throw new Error(`MTProto upload of part ${index}/${total} returned no document message`);
    }
    const sentSize = Number(String(document.size));
    if (sentSize !== partSize) {
      throw new Error(`MTProto read-back size mismatch on part ${index}/${total}: local=${partSize} telegram=${sentSize} (msgId ${message.id})`);
    }
    console.log(`${LOG_PREFIX} Part ${index}/${total} uploaded -> msgId ${message.id}`);
    return message;
  }
}

module.exports = { MtprotoVideoUploader, DEFAULT_MAX_PART_BYTES, postingDeniedReason };
