/**
 * ============================================================
 * 🎬 VIDEO PIPELINE RUNTIME (Phase 6B - NexaHub Runtime Manager)
 * ============================================================
 * Standalone orchestration boundary for integrating the batched video pipeline
 * into NexaHub.
 *
 * Core Responsibilities:
 *   - Configuration ingestion from environment with fail-closed validation.
 *   - Singleton lifecycle management (start, stop, runOnce, getStatus).
 *   - Prevents duplicate BatchCycleManager instances and runaway schedulers.
 *   - Strict isolation: errors within the video pipeline never crash parent NexaHub.
 *   - Production safety: refuses to run or publish to production channels in dev.
 *
 * Runtime locations (each overridable by config or env):
 *   - state     VIDEO_PIPELINE_STATE_DIR     default <NEXAHUB_DATA_DIR>/video_pipeline/state
 *   - downloads VIDEO_PIPELINE_DOWNLOADS_DIR default <NEXAHUB_DATA_DIR>/video_pipeline/downloads
 *   - output    VIDEO_PIPELINE_OUTPUT_DIR    default <NEXAHUB_DATA_DIR>/video_pipeline/output
 */

const path = require('path');
const fs = require('fs');

const { BatchCycleManager } = require('./batch_cycle_manager');
const { VideoBatchPublisher } = require('./video_batch_publisher');
const { BatchState } = require('./batch_state');
const { MediaLedger } = require('./media_ledger');
const { PublishLedger } = require('./publish_ledger');
const { MediaCleaner } = require('./media_cleaner');
const { VideoDestinationRouter } = require('./video_destination_router');
const { dataPath } = require('../runtime_paths');

const LOG_PREFIX = '[VIDEO_PIPELINE_RUNTIME]';
const ROOT_DIR = path.resolve(__dirname, '..');

const DEFAULT_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3 hours
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;      // 20 minutes (whole acquisition)
const DEFAULT_PAGE_TIMEOUT_SEC = 60;            // per page/download inside video-tools
const DEFAULT_DISCOVERY_TARGET = 100;
const DEFAULT_DISCOVERY_MAX = 150;
const DEFAULT_MAX_PAGES = 50;
const DEFAULT_MIN_SUCCESSFUL_VIDEOS = 15;
const DEFAULT_MAX_SUCCESSFUL_VIDEOS = 25;
// Hard ceiling on stop(): index.js force-exits after its own shutdown budget,
// so the runtime must always hand control back well before that.
const STOP_DEADLINE_MS = 7500;

// Known production channel usernames/IDs to strictly forbid as staging destinations
const FORBIDDEN_PRODUCTION_DESTINATIONS = new Set([
  'ccsfvk', 'cccsefk', 'e5brygh', 'ccdjxc', 'vsdxda',
  'tfccdet', 'sfgfem', 'ddkicr', 'cccddghhgf', 'bzd4wrf',
  'romantic vibe', 'dating', 'romance', 'crotch', 'mosa',
  'bunny girl cosplay date', 'lustful hostess', 'concubine',
  'saki mizumi', 'a muse', 'romanticvibe', 'sister snake',
  'has work', 'bullying & sex', 'da ci ge', 'senior year love story',
  'sichuan mother & son', 'hu siyuan', 'kept lover'
]);

const SOURCE_MODE_FIXTURE = 'fixture';
const SOURCE_MODE_AUTHORIZED = 'authorized';
const VALID_SOURCE_MODES = new Set([SOURCE_MODE_FIXTURE, SOURCE_MODE_AUTHORIZED]);

const UPLOAD_MODE_BOT = 'bot';
const UPLOAD_MODE_MTPROTO = 'mtproto';
const VALID_UPLOAD_MODES = new Set([UPLOAD_MODE_BOT, UPLOAD_MODE_MTPROTO]);
// Total source-file ceiling in mtproto mode (parts are split below 2 GB each).
const DEFAULT_MTPROTO_MAX_FILE_BYTES = 20 * 1024 * 1024 * 1024;

// Pre-data-dir layout: state lived beside this file, media under the repo root.
const LEGACY_STATE_FILES = ['batch_state.json', 'media_state.json', 'publish_state.json'];

function copyIfMissing(source, target, label) {
  try {
    if (path.resolve(source) === path.resolve(target)) return;
    if (!fs.existsSync(source) || fs.existsSync(target)) return;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    console.log(`${LOG_PREFIX} Migrated legacy ${label} ${source} -> ${target}`);
  } catch (err) {
    console.warn(`${LOG_PREFIX} Could not migrate legacy ${label} ${source}: ${err.message}`);
  }
}

class VideoPipelineRuntime {
  /**
   * @param {object} [config] Optional configuration override (for DI and tests)
   */
  constructor(config = {}) {
    this.enabled = config.enabled !== undefined
      ? Boolean(config.enabled)
      : (process.env.VIDEO_PIPELINE_ENABLED === 'true');

    // Explicit source mode - there is NO default and no automatic fallback
    // between modes anywhere in this runtime. "fixture" uses ONLY the internal
    // synthetic fixture server built below (test videos - never appropriate
    // for production); "authorized" uses ONLY the explicitly configured
    // VIDEO_PIPELINE_AUTHORIZED_SOURCE_URL and fails closed (CONFIG_ERROR) if
    // that URL isn't set. An enabled runtime with no mode configured at all
    // also fails closed, rather than silently publishing fixture videos.
    const configuredSourceMode = String(config.sourceMode || process.env.VIDEO_PIPELINE_SOURCE_MODE || '').trim().toLowerCase();
    this.sourceModeExplicit = configuredSourceMode.length > 0;
    this.sourceMode = this.sourceModeExplicit ? configuredSourceMode : null;
    this.authorizedSourceUrl = config.authorizedSourceUrl || process.env.VIDEO_PIPELINE_AUTHORIZED_SOURCE_URL || null;
    // Documented-inert by design: fallback between source modes is a hard
    // "never" requirement, so this flag is read only for status/logging
    // purposes and never used to trigger any actual fallback behavior.
    this.fixtureFallbackToLive = config.fixtureFallbackToLive !== undefined
      ? Boolean(config.fixtureFallbackToLive)
      : (process.env.VIDEO_PIPELINE_FIXTURE_FALLBACK_TO_LIVE === 'true');
    this.acquisitionUrl = config.acquisitionUrl || process.env.VIDEO_PIPELINE_ACQUISITION_URL || null;
    this.inputLinks = config.inputLinks || process.env.VIDEO_PIPELINE_INPUT_LINKS || null;
    this.stagingChatId = config.stagingChatId || process.env.VIDEO_PIPELINE_STAGING_CHAT_ID || null;
    // "bot" uploads with the injected Bot API client (50 MB limit); "mtproto"
    // uploads through the shared MTProto user session (2 GB per message,
    // larger files split into parts).
    this.uploadMode = String(config.uploadMode || process.env.VIDEO_PIPELINE_UPLOAD_MODE || UPLOAD_MODE_BOT).trim().toLowerCase();
    // Round-robin publishing across these chats (in order) instead of stagingChatId:
    // explicit config/env list, else the chatId fields of destination_routing_config.json.
    const rawDestinations = config.destinationChatIds || process.env.VIDEO_PIPELINE_DESTINATION_CHAT_IDS || '';
    this.destinationChatIds = (Array.isArray(rawDestinations) ? rawDestinations : String(rawDestinations).split(','))
      .map(id => String(id).trim())
      .filter(Boolean);
    if (!this.destinationChatIds.length && config.useRoutingConfigChatIds !== false) {
      this.destinationChatIds = new VideoDestinationRouter(config.routingConfigPath ? { configPath: config.routingConfigPath } : {}).getDestinationChatIds();
    }

    const envInterval = Number(process.env.VIDEO_PIPELINE_INTERVAL_MS);
    this.intervalMs = (config.intervalMs && !isNaN(config.intervalMs))
      ? config.intervalMs
      : (!isNaN(envInterval) && envInterval > 0 ? envInterval : DEFAULT_INTERVAL_MS);

    const envTimeout = Number(process.env.VIDEO_PIPELINE_TIMEOUT_MS);
    this.timeoutMs = (config.timeoutMs && !isNaN(config.timeoutMs))
      ? config.timeoutMs
      : (!isNaN(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS);

    // Per page/download network timeout handed to video-tools (--timeout).
    // Deliberately separate from timeoutMs (the whole-acquisition bound):
    // passing 20 minutes here would let one stuck page stall a cycle for 20 minutes.
    const envPageTimeout = Number(process.env.VIDEO_PIPELINE_PAGE_TIMEOUT_SEC);
    this.pageTimeoutSec = (config.pageTimeoutSec && !isNaN(config.pageTimeoutSec))
      ? config.pageTimeoutSec
      : (!isNaN(envPageTimeout) && envPageTimeout > 0 ? envPageTimeout : DEFAULT_PAGE_TIMEOUT_SEC);

    const envWorkers = Number(process.env.VIDEO_PIPELINE_WORKERS);
    this.workers = (config.workers && !isNaN(config.workers))
      ? config.workers
      : (!isNaN(envWorkers) && envWorkers > 0 ? envWorkers : 1);

    const envDiscoveryTarget = Number(process.env.VIDEO_PIPELINE_DISCOVERY_TARGET);
    this.discoveryTarget = (config.discoveryTarget && !isNaN(config.discoveryTarget))
      ? config.discoveryTarget
      : (!isNaN(envDiscoveryTarget) && envDiscoveryTarget > 0 ? envDiscoveryTarget : DEFAULT_DISCOVERY_TARGET);

    const envDiscoveryMax = Number(process.env.VIDEO_PIPELINE_DISCOVERY_MAX);
    this.discoveryMax = (config.discoveryMax && !isNaN(config.discoveryMax))
      ? config.discoveryMax
      : (!isNaN(envDiscoveryMax) && envDiscoveryMax > 0 ? envDiscoveryMax : DEFAULT_DISCOVERY_MAX);

    const envMaxPages = Number(process.env.VIDEO_PIPELINE_MAX_PAGES);
    this.maxPages = (config.maxPages && !isNaN(config.maxPages))
      ? config.maxPages
      : (!isNaN(envMaxPages) && envMaxPages > 0 ? envMaxPages : DEFAULT_MAX_PAGES);

    const envMinSuccessful = Number(process.env.VIDEO_PIPELINE_MIN_SUCCESSFUL_VIDEOS);
    const defaultMin = (config.acquisitionOptions && config.acquisitionOptions.targetLinks && config.acquisitionOptions.targetLinks < DEFAULT_MIN_SUCCESSFUL_VIDEOS)
      ? config.acquisitionOptions.targetLinks
      : DEFAULT_MIN_SUCCESSFUL_VIDEOS;
    this.minSuccessfulVideos = (config.minSuccessfulVideos !== undefined && !isNaN(config.minSuccessfulVideos))
      ? config.minSuccessfulVideos
      : (!isNaN(envMinSuccessful) && envMinSuccessful > 0 ? envMinSuccessful : defaultMin);

    const envMaxSuccessful = Number(process.env.VIDEO_PIPELINE_MAX_SUCCESSFUL_VIDEOS);
    this.maxSuccessfulVideos = (config.maxSuccessfulVideos && !isNaN(config.maxSuccessfulVideos))
      ? config.maxSuccessfulVideos
      : (!isNaN(envMaxSuccessful) && envMaxSuccessful > 0 ? envMaxSuccessful : DEFAULT_MAX_SUCCESSFUL_VIDEOS);

    // Explicit config/env always wins; otherwise everything mutable lives
    // under the data dir (outside the git checkout when NEXAHUB_DATA_DIR is set).
    this._usingDefaultDownloadsDir = !(config.downloadsDir || process.env.VIDEO_PIPELINE_DOWNLOADS_DIR);
    this._usingDefaultOutputDir = !(config.outputDir || process.env.VIDEO_PIPELINE_OUTPUT_DIR);
    this._usingDefaultStateDir = !(config.stateDir || process.env.VIDEO_PIPELINE_STATE_DIR);
    this.downloadsDir = config.downloadsDir || process.env.VIDEO_PIPELINE_DOWNLOADS_DIR || dataPath('video_pipeline', 'downloads');
    this.outputDir = config.outputDir || process.env.VIDEO_PIPELINE_OUTPUT_DIR || dataPath('video_pipeline', 'output');
    this.stateDir = config.stateDir || process.env.VIDEO_PIPELINE_STATE_DIR || dataPath('video_pipeline', 'state');
    // Scratch space for split upload parts - deliberately outside downloadsDir,
    // which the cycle scans for new media.
    this.uploadPartsDir = config.uploadPartsDir || dataPath('video_pipeline', 'upload_parts');

    this.autoPublish = config.autoPublish !== undefined
      ? Boolean(config.autoPublish)
      : (process.env.VIDEO_PIPELINE_AUTO_PUBLISH !== 'false');

    this.enableCleanup = config.enableCleanup !== undefined
      ? Boolean(config.enableCleanup)
      : (process.env.VIDEO_PIPELINE_ENABLE_CLEANUP !== 'false');

    this.acquisitionOptions = config.acquisitionOptions || {
      workers: this.workers,
      timeoutSec: this.pageTimeoutSec,
      standalone: true,
      targetLinks: this.discoveryTarget,
      maxPages: this.maxPages
    };
    if (!this.acquisitionOptions.targetLinks) {
      this.acquisitionOptions.targetLinks = this.discoveryTarget;
    }
    if (!this.acquisitionOptions.maxPages) {
      this.acquisitionOptions.maxPages = this.maxPages;
    }
    if (this.inputLinks) {
      this.acquisitionOptions.inputLinks = this.inputLinks;
    }
    // Server: attach video-tools to the human-verified Chrome started by
    // deploy/remote_browser_setup.sh instead of launching headless Chromium,
    // which site verification blocks.
    this.cdpUrl = config.cdpUrl || process.env.VIDEO_PIPELINE_CDP_URL || null;
    if (this.cdpUrl && !this.acquisitionOptions.cdpUrl) {
      this.acquisitionOptions.cdpUrl = this.cdpUrl;
    }

    // Injected dependencies (tests)
    this.telegramClient = config.telegramClient || null;
    this.batchCycleManager = config.batchCycleManager || null;
    this.videoBatchPublisher = config.videoBatchPublisher || null;
    this.batchState = config.batchState || null;
    this.mediaLedger = config.mediaLedger || null;
    this.publishLedger = config.publishLedger || null;
    this.mediaCleaner = config.mediaCleaner || null;

    this._started = false;
    this._lastConfigError = null;
    this._configValid = false;
    this._fixtureServer = null;
    this._fixtureServerUrl = null;
    this._fixtureReady = null;
    this._fixtureServerError = null;
    this._usesInternalFixture = false;

    this._validateConfiguration();
  }

  _validateConfiguration() {
    if (!this.enabled) {
      this._configValid = true;
      this._lastConfigError = null;
      return { valid: true, enabled: false };
    }

    // An injected, fully-built batchCycleManager already carries whatever
    // source it was constructed with - this runtime resolves no source then.
    if (!this.sourceModeExplicit && !this.batchCycleManager) {
      const err = 'VIDEO_PIPELINE_SOURCE_MODE is not configured. Set it explicitly to "authorized" (together with '
        + 'VIDEO_PIPELINE_AUTHORIZED_SOURCE_URL) or to "fixture" (internal synthetic test videos only). '
        + 'Refusing to guess a source - there is no default.';
      this._configValid = false;
      this._lastConfigError = err;
      return { valid: false, reason: err };
    }

    if (this.sourceModeExplicit && !VALID_SOURCE_MODES.has(this.sourceMode)) {
      const err = `VIDEO_PIPELINE_SOURCE_MODE must be exactly "fixture" or "authorized" (got: "${this.sourceMode}"). Refusing to guess a source.`;
      this._configValid = false;
      this._lastConfigError = err;
      return { valid: false, reason: err };
    }

    if (this.sourceMode === SOURCE_MODE_AUTHORIZED && !this.authorizedSourceUrl) {
      const err = 'VIDEO_PIPELINE_SOURCE_MODE=authorized requires VIDEO_PIPELINE_AUTHORIZED_SOURCE_URL to be explicitly configured. Refusing to substitute the fixture or any other source.';
      this._configValid = false;
      this._lastConfigError = err;
      return { valid: false, reason: err };
    }
    // Fixture mode needs no acquisitionUrl check here: the internal fixture
    // server supplies one in _ensureManagerInitialized(); acquisitionUrl/
    // inputLinks remain supported as explicit overrides for tests that want
    // fixture mode to point at their own local HTTP server instead.

    if (!VALID_UPLOAD_MODES.has(this.uploadMode)) {
      const err = `VIDEO_PIPELINE_UPLOAD_MODE must be "bot" or "mtproto" (got: "${this.uploadMode}").`;
      this._configValid = false;
      this._lastConfigError = err;
      return { valid: false, reason: err };
    }

    for (const id of this.destinationChatIds) {
      const clean = id.replace(/^@/, '').toLowerCase();
      if (!/^(-?\d+|@?[a-z0-9_]{4,})$/i.test(id) || FORBIDDEN_PRODUCTION_DESTINATIONS.has(clean)) {
        const err = `VIDEO_PIPELINE_DESTINATION_CHAT_IDS contains an invalid or protected destination: "${id}".`;
        this._configValid = false;
        this._lastConfigError = err;
        return { valid: false, reason: err };
      }
    }

    if (this.autoPublish) {
      if (!this.destinationChatIds.length && (!this.stagingChatId || typeof this.stagingChatId !== 'string' || !this.stagingChatId.trim())) {
        const err = 'VIDEO_PIPELINE_STAGING_CHAT_ID is required when autoPublish is enabled.';
        this._configValid = false;
        this._lastConfigError = err;
        return { valid: false, reason: err };
      }

      const cleanTarget = String(this.stagingChatId || '').trim().replace(/^@/, '').toLowerCase();
      if (cleanTarget && FORBIDDEN_PRODUCTION_DESTINATIONS.has(cleanTarget)) {
        const err = `Target destination "${this.stagingChatId}" is a protected production channel. Staging publisher strictly refuses.`;
        this._configValid = false;
        this._lastConfigError = err;
        return { valid: false, reason: err };
      }

      // Fail closed rather than starting a scheduler that would fail every
      // single publish attempt: require either an injected Telegram client
      // (production: the bot instance from index.js), a fully pre-configured
      // publisher, or a fully custom batchCycleManager (whatever publishing
      // setup it has, if any, is that caller's own responsibility - this
      // runtime only guards the paths where IT would build the publisher).
      const needsOwnPublisher = !this.batchCycleManager && !this.videoBatchPublisher;
      if (needsOwnPublisher && this.uploadMode === UPLOAD_MODE_MTPROTO) {
        if (!process.env.TELEGRAM_SESSION_STRING || !process.env.TELEGRAM_API_ID || !process.env.TELEGRAM_API_HASH) {
          const err = 'VIDEO_PIPELINE_UPLOAD_MODE=mtproto requires TELEGRAM_SESSION_STRING, TELEGRAM_API_ID and TELEGRAM_API_HASH.';
          this._configValid = false;
          this._lastConfigError = err;
          return { valid: false, reason: err };
        }
      } else if (needsOwnPublisher && !this.telegramClient) {
        const err = 'A Telegram client is required when autoPublish is enabled (config.telegramClient, or a pre-configured config.videoBatchPublisher/batchCycleManager).';
        this._configValid = false;
        this._lastConfigError = err;
        return { valid: false, reason: err };
      }
    }

    this._configValid = true;
    this._lastConfigError = null;
    return { valid: true, enabled: true };
  }

  _startInternalFixtureServer() {
    if (this._fixtureServer) return this._fixtureServerUrl;
    const http = require('http');
    const crypto = require('crypto');
    const { getFFmpegPath } = require('./media_validator');
    const { spawnSync } = require('child_process');

    const fixtureDir = path.join(this.stateDir, 'fixtures');
    fs.mkdirSync(fixtureDir, { recursive: true });
    const baseMp4Path = path.join(fixtureDir, 'base.mp4');
    if (!fs.existsSync(baseMp4Path)) {
      const ffmpeg = getFFmpegPath();
      // One-off, tiny (1s, 160x120) generation - bounded so a wedged ffmpeg
      // can never hang startup.
      spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=5', '-pix_fmt', 'yuv420p', baseMp4Path], { timeout: 30000, windowsHide: true });
    }
    const baseMp4Buffer = fs.existsSync(baseMp4Path) ? fs.readFileSync(baseMp4Path) : Buffer.from('ftypmp42', 'utf8');

    const TITLES = [
      'Romantic Vibe Sunset Walk with K-Pop Stars',
      'Dating Special Evergrande Troupe Performance',
      'Romance and Intimacy First Love Story',
      'Crotch Fashion Trend and Skirt Style Review',
      'Mosa Uncensored Streamer Behind the Scenes',
      'Bunny Girl Cosplay Date Night in Akihabara',
      'Lustful Hostess Hotel Service Award Story',
      'Concubine Senior Year Love Story Fantrie Special',
      'Saki Mizumi Idol Exclusive Highlights Reel',
      'Shorts Trending Viral Daily Compilation'
    ];

    const runSalt = Date.now().toString(36);
    const posts = [];
    const videoBuffers = new Map();
    for (let i = 1; i <= 25; i++) {
      const titleCategory = TITLES[(i - 1) % TITLES.length];
      const title = `${titleCategory} (Part ${i})`;
      const postId = `${i}_${runSalt}`;
      posts.push({ id: postId, numericId: i, title, videoUrl: `/media/video_${i}_${runSalt}.mp4` });

      const payload = Buffer.from(`FIXTURE_POST_${i}_${title}_${Date.now()}_SALT_${crypto.randomBytes(8).toString('hex')}`, 'utf8');
      const boxLength = 8 + payload.length;
      const freeBox = Buffer.alloc(boxLength);
      freeBox.writeUInt32BE(boxLength, 0);
      freeBox.write('free', 4, 4, 'ascii');
      payload.copy(freeBox, 8);
      videoBuffers.set(i, Buffer.concat([baseMp4Buffer, freeBox]));
    }

    const server = http.createServer((req, res) => {
      const rawUrl = req.url.split('?')[0];
      if (rawUrl === '/' || rawUrl === '/board' || rawUrl === '/index.php') {
        let itemsHtml = posts.map(p => `
          <div class="list-row">
            <a href="/post/${p.id}?wr_id=${p.id}">${p.title}</a>
          </div>
        `).join('\n');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><head><title>Authorized Board</title></head><body><form id="fboardlist">${itemsHtml}</form></body></html>`);
        return;
      }
      const postMatch = rawUrl.match(/\/post\/([^/?#]+)/);
      if (postMatch) {
        const id = postMatch[1];
        const post = posts.find(p => p.id === id);
        if (!post) { res.writeHead(404); res.end('Not Found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><head><title>${post.title}</title></head><body><h1>${post.title}</h1><video id="player" src="${post.videoUrl}"></video></body></html>`);
        return;
      }
      const mediaMatch = rawUrl.match(/\/media\/video_(\d+)/);
      if (mediaMatch) {
        const id = parseInt(mediaMatch[1], 10);
        const buf = videoBuffers.get(id) || baseMp4Buffer;
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': buf.length });
        res.end(buf);
        return;
      }
      res.writeHead(404); res.end('Not Found');
    });

    const port = Number(process.env.VIDEO_PIPELINE_FIXTURE_PORT) || 58923;
    this._fixtureServer = server;
    this._fixtureServerUrl = `http://127.0.0.1:${port}/`;
    this._fixtureServerError = null;

    // listen() is asynchronous and reports failures (EADDRINUSE, EACCES...)
    // via an 'error' event - with no listener that event is an uncaught
    // exception that would take the whole bot down. A busy port falls back to
    // an OS-assigned one; any other failure fails this fixture source cleanly.
    let triedEphemeralPort = false;
    this._fixtureReady = new Promise((resolve) => {
      server.on('listening', () => {
        const address = server.address();
        const url = `http://127.0.0.1:${address.port}/`;
        this._fixtureServerUrl = url;
        if (this.sourceMode !== SOURCE_MODE_AUTHORIZED && this.acquisitionUrl !== url && this._usesInternalFixture) {
          this.acquisitionUrl = url;
          if (this.batchCycleManager) this.batchCycleManager.acquisitionUrl = url;
        }
        console.log(`${LOG_PREFIX} Internal authorized fixture server active at ${url}`);
        resolve(true);
      });
      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE' && !triedEphemeralPort) {
          triedEphemeralPort = true;
          console.warn(`${LOG_PREFIX} Fixture port ${port} is already in use; retrying on an OS-assigned port.`);
          try {
            server.listen(0, '127.0.0.1');
            return;
          } catch (retryErr) {
            err = retryErr;
          }
        }
        this._fixtureServerError = err.message;
        console.error(`${LOG_PREFIX} FIXTURE_SERVER_ERROR: internal fixture server failed (${err.code || 'error'}): ${err.message}`);
        try { server.close(); } catch (e) {}
        if (this._fixtureServer === server) {
          this._fixtureServer = null;
        }
        resolve(false);
      });
    });

    try {
      server.listen(port, '127.0.0.1');
    } catch (err) {
      server.emit('error', err);
    }
    return this._fixtureServerUrl;
  }

  _closeFixtureServer() {
    if (this._fixtureServer) {
      try { this._fixtureServer.close(); } catch (e) {}
      this._fixtureServer = null;
      this._fixtureServerUrl = null;
    }
  }

  /**
   * One-time carry-over from the pre-data-dir layout (state beside this file,
   * media/output under the repo root) so dedupe/publish history and the
   * schedule clock survive the move. Only runs for locations that were NOT
   * explicitly configured, and never overwrites an existing file.
   * @private
   */
  _migrateLegacyState() {
    if (this._usingDefaultStateDir) {
      for (const name of LEGACY_STATE_FILES) {
        copyIfMissing(path.join(__dirname, name), path.join(this.stateDir, name), 'state file');
      }
    }
    if (this._usingDefaultOutputDir) {
      copyIfMissing(path.join(ROOT_DIR, 'output', 'videos.json'), path.join(this.outputDir, 'videos.json'), 'discovery record');
    }
    if (this._usingDefaultDownloadsDir) {
      copyIfMissing(path.join(ROOT_DIR, 'downloads', 'download_report.json'), path.join(this.downloadsDir, 'download_report.json'), 'download report');
    }
  }

  /**
   * Publisher client for mtproto upload mode: VideoBatchPublisher calls its
   * publish() hook, which uploads through the shared MTProto user session.
   * @private
   */
  _createMtprotoClient() {
    const { MtprotoVideoUploader } = require('./mtproto_video_uploader');
    const uploader = new MtprotoVideoUploader({
      partsDir: this.uploadPartsDir
    });
    this._mtprotoUploader = uploader;
    console.log(`${LOG_PREFIX} Upload mode: MTPROTO (user session, parts up to ${uploader.maxPartBytes} bytes).`);
    return { publish: (args) => uploader.publish(args) };
  }

  /**
   * Initializes and constructs the internal BatchCycleManager if not already created.
   * @private
   */
  _ensureManagerInitialized() {
    if (this.batchCycleManager) {
      return this.batchCycleManager;
    }

    // Ensure output and downloads directories exist
    try {
      fs.mkdirSync(this.outputDir, { recursive: true });
      fs.mkdirSync(this.downloadsDir, { recursive: true });
      fs.mkdirSync(this.stateDir, { recursive: true });
    } catch (e) {
      console.warn(`${LOG_PREFIX} Directory ensure warning: ${e.message}`);
    }
    this._migrateLegacyState();

    // Explicit, non-negotiable source resolution - exactly one of these two
    // branches ever runs, chosen solely by this.sourceMode. Neither branch
    // falls back to the other under any condition.
    if (this.sourceMode === SOURCE_MODE_AUTHORIZED) {
      this.acquisitionUrl = this.authorizedSourceUrl;
      console.log(`${LOG_PREFIX} Source mode: AUTHORIZED (explicitly configured source).`);
    } else if (!this.acquisitionUrl || this.acquisitionUrl === 'fixture' || this.acquisitionUrl === 'internal') {
      this._usesInternalFixture = true;
      this.acquisitionUrl = this._startInternalFixtureServer();
      console.log(`${LOG_PREFIX} Source mode: FIXTURE (internal test server, not a live/authorized source).`);
    }

    const batchStatePath = path.join(this.stateDir, 'batch_state.json');
    const mediaLedgerPath = path.join(this.stateDir, 'media_state.json');
    const publishLedgerPath = path.join(this.stateDir, 'publish_state.json');

    const batchState = this.batchState || new BatchState({ statePath: batchStatePath });
    const mediaLedger = this.mediaLedger || new MediaLedger({ ledgerPath: mediaLedgerPath });
    const publishLedger = this.publishLedger || new PublishLedger({ ledgerPath: publishLedgerPath });
    const mediaCleaner = this.mediaCleaner || new MediaCleaner({
      mediaLedger,
      publishLedger,
      allowedDirectory: this.downloadsDir
    });

    let publisher = this.videoBatchPublisher;
    if (!publisher && this.autoPublish) {
      const useMtproto = this.uploadMode === UPLOAD_MODE_MTPROTO;
      const telegramClient = useMtproto ? this._createMtprotoClient() : this.telegramClient;
      publisher = new VideoBatchPublisher({
        stagingChatId: this.stagingChatId,
        telegramClient,
        destinationChatIds: this.destinationChatIds,
        roundRobinStatePath: path.join(this.stateDir, 'round_robin_state.json'),
        destinationAccessCheck: useMtproto && this.destinationChatIds.length
          ? (ids) => this._mtprotoUploader.checkDestinations(ids)
          : null,
        batchState,
        publishLedger,
        mediaCleaner,
        enableCleanup: this.enableCleanup,
        authorizedSourceUrl: this.sourceMode === SOURCE_MODE_AUTHORIZED ? this.authorizedSourceUrl : null,
        // A multi-GB full decode takes 10+ minutes on a small server; set
        // VIDEO_PIPELINE_PUBLISH_FULL_DECODE=true to repeat it before upload anyway.
        reuseIngestDecode: process.env.VIDEO_PIPELINE_PUBLISH_FULL_DECODE !== 'true',
        maxUploadBytes: useMtproto
          ? (Number(process.env.VIDEO_PIPELINE_MTPROTO_MAX_FILE_BYTES) > 0 ? Number(process.env.VIDEO_PIPELINE_MTPROTO_MAX_FILE_BYTES) : DEFAULT_MTPROTO_MAX_FILE_BYTES)
          : undefined
      });
    }

    this.batchCycleManager = new BatchCycleManager({
      acquisitionUrl: this.acquisitionUrl,
      sourceMode: this.sourceMode,
      outputDir: this.outputDir,
      downloadsDir: this.downloadsDir,
      uploadPartsDir: this.uploadPartsDir,
      batchState,
      mediaIngestor: new (require('./media_ingestor').MediaIngestor)({
        downloadsDir: this.downloadsDir,
        ledger: mediaLedger
      }),
      videoBatchPublisher: publisher,
      autoPublish: this.autoPublish,
      enableCleanup: this.enableCleanup,
      acquisitionOptions: this.acquisitionOptions,
      acquisitionTimeoutMs: this.timeoutMs,
      minSuccessfulVideos: this.minSuccessfulVideos,
      maxSuccessfulVideos: this.maxSuccessfulVideos,
      discoveryTarget: this.discoveryTarget,
      discoveryMax: this.discoveryMax
    });

    return this.batchCycleManager;
  }

  /**
   * Starts the 3-hour recurring batch scheduler.
   * Fail-closed: does nothing if disabled or if configuration is invalid.
   * @param {object} [options]
   * @param {boolean} [options.runImmediately=false]
   * @returns {object} Status object
   */
  start(options = {}) {
    if (!this.enabled) {
      console.log(`${LOG_PREFIX} Runtime is DISABLED (VIDEO_PIPELINE_ENABLED !== 'true'). Remaining dormant.`);
      return { status: 'DISABLED', started: false };
    }

    const validation = this._validateConfiguration();
    if (!validation.valid) {
      console.error(`${LOG_PREFIX} CONFIG_ERROR: startup aborted, no cycles will run. ${validation.reason}`);
      return { status: 'CONFIG_ERROR', started: false, error: validation.reason };
    }

    if (this._started) {
      console.log(`${LOG_PREFIX} Runtime is already started. Existing scheduler active.`);
      return { status: 'ALREADY_STARTED', started: true };
    }

    try {
      this._ensureManagerInitialized();
      const runImmediately = options.runImmediately !== undefined
        ? Boolean(options.runImmediately)
        : (process.env.VIDEO_PIPELINE_RUN_ON_STARTUP === 'true');
      this.batchCycleManager.startScheduler(this.intervalMs, { runImmediately, ...options });
      this._started = true;
      if (this._fixtureReady) {
        this._fixtureReady.then((ok) => {
          if (ok) return;
          this._lastConfigError = `Internal fixture server failed to start: ${this._fixtureServerError}`;
          console.error(`${LOG_PREFIX} Stopping scheduler: ${this._lastConfigError}`);
          this._started = false;
          if (this.batchCycleManager) {
            Promise.resolve()
              .then(() => this.batchCycleManager.stop())
              .catch(err => console.error(`${LOG_PREFIX} Scheduler stop after fixture failure errored: ${err.message}`));
          }
        });
      }
      console.log(`${LOG_PREFIX} Runtime started successfully (interval=${this.intervalMs}ms, autoPublish=${this.autoPublish}, runOnStartup=${runImmediately}).`);
      return { status: 'STARTED', started: true, intervalMs: this.intervalMs };
    } catch (err) {
      console.error(`${LOG_PREFIX} Failed to start runtime: ${err.message}`);
      return { status: 'ERROR', started: false, error: err.message };
    }
  }

  /**
   * Stops the recurring scheduler and any in-progress acquisition cleanly.
   * Idempotent: safe to call multiple times. Bounded to STOP_DEADLINE_MS.
   * @returns {Promise<object>}
   */
  async stop() {
    if (!this._started && (!this.batchCycleManager || !this.batchCycleManager.isSchedulerActive())) {
      this._closeFixtureServer();
      return { status: 'NOT_RUNNING', started: false };
    }

    console.log(`${LOG_PREFIX} Stopping runtime...`);
    try {
      if (this.batchCycleManager) {
        let timer = null;
        const outcome = await Promise.race([
          Promise.resolve().then(() => this.batchCycleManager.stop()).then(() => 'stopped'),
          new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), STOP_DEADLINE_MS); })
        ]);
        if (timer) clearTimeout(timer);
        if (outcome === 'timeout') {
          console.warn(`${LOG_PREFIX} Batch cycle manager did not stop within ${STOP_DEADLINE_MS}ms; returning so shutdown can proceed.`);
        }
      }
      this._closeFixtureServer();
      this._started = false;
      console.log(`${LOG_PREFIX} Runtime stopped cleanly.`);
      return { status: 'STOPPED', started: false };
    } catch (err) {
      console.error(`${LOG_PREFIX} Error during runtime stop: ${err.message}`);
      this._closeFixtureServer();
      this._started = false;
      return { status: 'ERROR', started: false, error: err.message };
    }
  }

  /**
   * Manually runs a single batch cycle through the underlying BatchCycleManager.
   * Enforces all configuration and state safety guards.
   * @param {object} [options]
   * @returns {Promise<object>}
   */
  async runOnce(options = {}) {
    if (!this.enabled) {
      return { status: 'SKIPPED', reason: 'Video pipeline runtime is disabled (VIDEO_PIPELINE_ENABLED !== true)' };
    }

    const validation = this._validateConfiguration();
    if (!validation.valid) {
      return { status: 'CONFIG_ERROR', error: validation.reason };
    }

    try {
      this._ensureManagerInitialized();
      if (this._fixtureReady && !(await this._fixtureReady)) {
        return { status: 'FAILED', error: `Internal fixture server failed to start: ${this._fixtureServerError}` };
      }
      return await this.batchCycleManager.runOnce(options);
    } catch (err) {
      console.error(`${LOG_PREFIX} runOnce error: ${err.message}`);
      return { status: 'FAILED', error: err.message };
    }
  }

  /**
   * @returns {boolean} Whether the runtime has been started
   */
  isStarted() {
    return this._started;
  }

  /**
   * Returns a sanitized, safe status snapshot with no secrets.
   * @returns {object}
   */
  getStatus() {
    let state = 'DISABLED';
    let cycleId = null;
    let schedulerActive = false;
    let lastSummary = null;

    if (this.enabled) {
      if (!this._configValid) {
        state = 'CONFIG_ERROR';
      } else if (this.batchCycleManager) {
        state = this.batchCycleManager.batchState.getControllerState();
        cycleId = this.batchCycleManager.batchState.getCurrentCycleId();
        schedulerActive = typeof this.batchCycleManager.isSchedulerActive === 'function'
          ? this.batchCycleManager.isSchedulerActive()
          : Boolean(this.batchCycleManager._timerId);
        lastSummary = typeof this.batchCycleManager.getLastCycleSummary === 'function'
          ? this.batchCycleManager.getLastCycleSummary()
          : (this.batchCycleManager._lastCycleSummary || null);
      } else {
        state = 'IDLE';
      }
    }

    return {
      enabled: this.enabled,
      started: this._started,
      state,
      cycleId,
      schedulerActive,
      configValid: this._configValid,
      lastConfigError: this._lastConfigError,
      lastCycleSummary: lastSummary,
      sourceMode: this.sourceMode,
      uploadMode: this.uploadMode,
      authorizedSourceConfigured: Boolean(this.authorizedSourceUrl)
    };
  }
}

// Module-scoped singleton instance
let _runtimeInstance = null;

/**
 * Returns the singleton VideoPipelineRuntime instance.
 * @param {object} [config] Optional config for initial instantiation
 * @returns {VideoPipelineRuntime}
 */
function getVideoPipelineRuntime(config) {
  if (!_runtimeInstance) {
    _runtimeInstance = new VideoPipelineRuntime(config);
  }
  return _runtimeInstance;
}

/**
 * Resets the module-scoped singleton (for testing only).
 */
function _resetRuntimeInstanceForTesting() {
  if (_runtimeInstance && _runtimeInstance.isStarted()) {
    try {
      _runtimeInstance.stop();
    } catch (_) {}
  }
  _runtimeInstance = null;
}

module.exports = {
  VideoPipelineRuntime,
  getVideoPipelineRuntime,
  _resetRuntimeInstanceForTesting
};
