/**
 * ============================================================
 * 🚀 MODULAR SCRAPER PIPELINE ORCHESTRATOR
 * ============================================================
 * End-to-end orchestration connecting 6 modular Playwright scrapers,
 * 4-worker parallel downloading, media validation, 24-hour quota management
 * (5 videos/day per channel), and direct dedicated channel Telegram MTProto publishing.
 *
 * Channel Mappings:
 *   1. bj_scraper      -> @tfccdet    (-1004416217845, Topic: BJ.)
 *   2. javleak_scraper -> @ccsfvk     (-1003780478806, Topic: KR)
 *   3. caption_scraper -> @vsdxda     (-1003725861834, Topic: JP)
 *   4. javc_scraper    -> @ccdjxc     (-1004419758275, Topic: CN)
 *   5. javmgs_scraper  -> @ddkicr     (-1004481385613, Topic: 18..)
 *   6. javm_scraper    -> @cccddghhgf (-1004483241550, Topic: AV)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { ModularQuotaTracker } = require('./modular_quota_tracker');
const { PublishLedger } = require('./publish_ledger');
const { MediaLedger } = require('./media_ledger');
const { validateMediaFile } = require('./media_validator');
const { VipTopicRouter } = require('./vip_topic_router');
const { dataPath } = require('../runtime_paths');

const LOG_PREFIX = '[MODULAR_PIPELINE]';
const ROOT_DIR = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(__dirname, 'modular_channel_config.json');

class ModularScraperPipeline {
  /**
   * @param {object} [options]
   * @param {string} [options.configPath]
   * @param {object} [options.telegramClient] Injected MTProto or Bot client
   * @param {object} [options.vipTopicRouter] Injected VIP Topic Router
   * @param {number} [options.workers=4] Parallel download workers
   * @param {number} [options.dailyQuota=5] Max videos per channel per 24 hours
   */
  constructor(options = {}) {
    this.configPath = options.configPath || CONFIG_FILE;
    this.config = this._loadConfig();
    this.workers = options.workers || 4;
    this.dailyQuota = options.dailyQuota || this.config.dailyQuotaPerChannel || 5;
    this.pythonPath = options.pythonPath || this._resolvePythonPath();

    this.quotaTracker = options.quotaTracker || new ModularQuotaTracker({
      defaultDailyQuota: this.dailyQuota
    });
    this.publishLedger = options.publishLedger || new PublishLedger();
    this.mediaLedger = options.mediaLedger || new MediaLedger();
    this.vipTopicRouter = options.vipTopicRouter || new VipTopicRouter();
    this.telegramClient = options.telegramClient || null;
    this.enableCleanup = options.enableCleanup !== undefined ? Boolean(options.enableCleanup) : true;

    this._running = false;
    this._schedulerTimer = null;
    this._mtprotoUploader = null;
  }

  _resolvePythonPath() {
    if (process.env.PYTHON_PATH && fs.existsSync(process.env.PYTHON_PATH)) {
      return process.env.PYTHON_PATH;
    }
    const candidatePaths = [
      '/opt/nexahub-bot/.venv/bin/python',
      '/opt/nexahub-bot/.venv/bin/python3',
      path.join(ROOT_DIR, '.venv', 'bin', 'python'),
      path.join(ROOT_DIR, '.venv', 'Scripts', 'python.exe'),
      path.join(ROOT_DIR, 'scraping', '.venv', 'Scripts', 'python.exe'),
      'python3',
      'python'
    ];
    for (const p of candidatePaths) {
      if (p.includes(path.sep) || p.startsWith('/')) {
        if (fs.existsSync(p)) return p;
      }
    }
    return process.env.PYTHON_PATH || 'python';
  }

  _getOrInitTelegramClient() {
    if (this.telegramClient) return this.telegramClient;
    if (this._mtprotoUploader) return this._mtprotoUploader;
    if (process.env.TELEGRAM_SESSION_STRING && process.env.TELEGRAM_API_ID) {
      try {
        const { MtprotoVideoUploader } = require('./mtproto_video_uploader');
        this._mtprotoUploader = new MtprotoVideoUploader({
          apiId: process.env.TELEGRAM_API_ID,
          apiHash: process.env.TELEGRAM_API_HASH,
          sessionString: process.env.TELEGRAM_SESSION_STRING,
          uploadWorkers: 4,
          uploadPartsDir: dataPath('video_pipeline', 'upload_parts')
        });
        return this._mtprotoUploader;
      } catch (e) {
        console.warn(`${LOG_PREFIX} Could not init MTProto uploader: ${e.message}`);
      }
    }
    return null;
  }

  _loadConfig() {
    if (fs.existsSync(this.configPath)) {
      try {
        return JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      } catch (e) {
        console.warn(`${LOG_PREFIX} Warning: Failed to parse ${this.configPath}: ${e.message}`);
      }
    }
    return { dailyQuotaPerChannel: 5, channels: {} };
  }

  /**
   * Executes a CLI command using child_process.spawn with promise wrap.
   */
  _execProcess(command, args, cwd = ROOT_DIR, timeoutMs = 600000) {
    return new Promise((resolve) => {
      console.log(`${LOG_PREFIX} Spawning: ${command} ${args.join(' ')} (cwd=${cwd})`);
      const child = spawn(command, args, {
        cwd,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
        windowsHide: true
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        process.stdout.write(`[Child] ${text}`);
      });

      child.stderr.on('data', (data) => {
        const text = data.toString();
        stderr += text;
        process.stderr.write(`[Child ERR] ${text}`);
      });

      const timer = setTimeout(() => {
        console.warn(`${LOG_PREFIX} Process timed out after ${timeoutMs}ms, killing.`);
        try { child.kill('SIGKILL'); } catch (_) {}
        resolve({ code: -1, stdout, stderr, timedOut: true });
      }, timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut: false });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        console.error(`${LOG_PREFIX} Process error: ${err.message}`);
        resolve({ code: 1, stdout, stderr, error: err.message });
      });
    });
  }

  /**
   * Runs the Playwright scraper for a given channel key.
   * @param {object} channelConf
   * @param {object} [options]
   */
  async runScraper(channelConf, options = {}) {
    const scriptPath = path.resolve(ROOT_DIR, channelConf.scraperScript);
    const startPage = options.startPage || 1;
    const endPage = options.endPage || 2;
    const scrapingDir = path.resolve(ROOT_DIR, 'scraping');

    console.log(`${LOG_PREFIX} Running scraper for "${channelConf.name}" (script: ${path.basename(scriptPath)}) using python: ${this.pythonPath}`);

    const args = [scriptPath, '--start', String(startPage), '--end', String(endPage)];
    await this._execProcess(this.pythonPath, args, scrapingDir, 180000);

    const dbPath = path.resolve(ROOT_DIR, channelConf.databaseJson);
    if (fs.existsSync(dbPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        console.log(`${LOG_PREFIX} Scraper for "${channelConf.name}" found ${data.length} total videos in database.`);
        return data;
      } catch (e) {
        console.warn(`${LOG_PREFIX} Failed to read database ${dbPath}: ${e.message}`);
      }
    }
    return [];
  }

  /**
   * Runs the 4-worker parallel downloader for a channel up to the remaining quota.
   * @param {object} channelConf
   * @param {number} limit
   */
  async runDownloader(channelConf, limit = 5) {
    const jsonPath = path.resolve(ROOT_DIR, channelConf.databaseJson);
    const outputDir = path.resolve(ROOT_DIR, channelConf.downloadDir);
    const downloaderScript = path.resolve(__dirname, 'modular_downloader.py');

    if (!fs.existsSync(jsonPath)) {
      console.warn(`${LOG_PREFIX} Database JSON does not exist: ${jsonPath}`);
      return [];
    }

    console.log(`${LOG_PREFIX} Launching 4-worker parallel downloader for "${channelConf.name}" (limit: ${limit})`);
    const args = [
      downloaderScript,
      '--json', jsonPath,
      '--output', outputDir,
      '--workers', String(this.workers),
      '--limit', String(limit)
    ];

    const res = await this._execProcess(this.pythonPath, args, ROOT_DIR, 600000);
    const match = res.stdout.match(/__RESULT_JSON__:(.*)$/m);
    if (match && match[1]) {
      try {
        const parsed = JSON.parse(match[1].trim());
        // Invalidate stale 403 items from JSON cache so next run extracts fresh video URLs
        const failed403Titles = new Set(parsed.filter(r => r.error && r.error.includes('403')).map(r => r.title));
        if (failed403Titles.size > 0 && fs.existsSync(jsonPath)) {
          try {
            const currentDb = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            let modified = false;
            for (const it of currentDb) {
              if (failed403Titles.has(it.title)) {
                it.scraped_at = 0;
                modified = true;
              }
            }
            if (modified) {
              fs.writeFileSync(jsonPath, JSON.stringify(currentDb, null, 2), 'utf8');
            }
          } catch (_) {}
        }
        return parsed;
      } catch (_) {}
    }

    // Fallback: scan output directory for downloaded MP4 files
    const downloadedFiles = [];
    if (fs.existsSync(outputDir)) {
      const files = fs.readdirSync(outputDir).filter(f => f.endsWith('.mp4'));
      for (const f of files) {
        const fp = path.join(outputDir, f);
        if (fs.statSync(fp).size > 1024 * 1024) {
          downloadedFiles.push({
            status: 'completed',
            title: path.basename(f, '.mp4'),
            filepath: fp,
            size_mb: fs.statSync(fp).size / (1024 * 1024)
          });
        }
      }
    }
    return downloadedFiles;
  }

  /**
   * Publishes a validated video file directly to the dedicated channel.
   * @param {object} channelConf
   * @param {object} item
   */
  async publishVideoToChannel(channelConf, item) {
    const filePath = item.filepath;
    if (!fs.existsSync(filePath)) {
      return { status: 'FAILED', reason: 'File does not exist on disk' };
    }

    const title = item.title || path.basename(filePath, '.mp4');
    const mediaId = crypto.createHash('sha256').update(title + channelConf.chatId).digest('hex').substring(0, 16);

    // 1. Quota Check
    if (!this.quotaTracker.canPublish(channelConf.key, channelConf.dailyQuota)) {
      console.log(`${LOG_PREFIX} Quota reached for "${channelConf.name}" (5/5 today). Skipping upload.`);
      return { status: 'QUOTA_REACHED', channelKey: channelConf.key };
    }

    // 2. Technical Validation
    const validation = await validateMediaFile(filePath, { allowRemuxFallback: false });
    if (!validation.valid) {
      const errMsg = validation.error || validation.reason || 'Unknown validation failure';
      console.warn(`${LOG_PREFIX} Media validation failed for ${filePath}: ${errMsg}. Deleting corrupted/partial file.`);
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log(`${LOG_PREFIX} 🗑️ Deleted corrupt/partial media file from disk: ${path.basename(filePath)}`);
        }
      } catch (delErr) {
        console.warn(`${LOG_PREFIX} Could not delete invalid media file ${filePath}: ${delErr.message}`);
      }
      return { status: 'INVALID_MEDIA', reason: errMsg };
    }

    // 3. Idempotency Check
    if (this.publishLedger.isPublished(mediaId, channelConf.chatId)) {
      console.log(`${LOG_PREFIX} Item "${title}" already published to ${channelConf.username}. Skipping.`);
      return { status: 'SKIPPED_ALREADY_PUBLISHED', mediaId };
    }

    console.log(`${LOG_PREFIX} 📤 Publishing "${title}" -> ${channelConf.name} (${channelConf.username}, ${channelConf.chatId})`);

    let msgId = null;
    try {
      const fileSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
      let client = this._getOrInitTelegramClient();

      // If file > 48 MB and client is the standard HTTP bot, switch to MTProto uploader
      if (fileSize > 48 * 1024 * 1024 && process.env.TELEGRAM_SESSION_STRING && process.env.TELEGRAM_API_ID) {
        if (!this._mtprotoUploader) {
          try {
            const { MtprotoVideoUploader } = require('./mtproto_video_uploader');
            this._mtprotoUploader = new MtprotoVideoUploader({
              apiId: process.env.TELEGRAM_API_ID,
              apiHash: process.env.TELEGRAM_API_HASH,
              sessionString: process.env.TELEGRAM_SESSION_STRING,
              uploadWorkers: 4,
              uploadPartsDir: dataPath('video_pipeline', 'upload_parts')
            });
          } catch (e) {
            console.warn(`${LOG_PREFIX} Could not init MTProto uploader: ${e.message}`);
          }
        }
        if (this._mtprotoUploader) {
          client = this._mtprotoUploader;
        }
      }

      if (client) {
        let uploadTarget = channelConf.chatId;
        if (typeof client.getEntity === 'function') {
          try {
            uploadTarget = await client.getEntity(channelConf.username ? `@${channelConf.username}` : channelConf.chatId);
          } catch (_) {
            uploadTarget = channelConf.chatId;
          }
        }

        const caption = `🎬 <b>${title}</b>\n\n📌 <i>Channel: ${channelConf.name}</i>`;
        let pubRes = null;

        if (typeof client.publish === 'function') {
          pubRes = await client.publish({
            destinationId: channelConf.chatId,
            filePath,
            caption
          });
        } else if (typeof client.sendFile === 'function') {
          pubRes = await client.sendFile(uploadTarget, {
            file: filePath,
            caption,
            parseMode: 'html'
          });
        } else if (typeof client.sendVideo === 'function') {
          pubRes = await client.sendVideo(channelConf.chatId, filePath, {
            caption,
            parse_mode: 'HTML'
          });
        }

        msgId = pubRes ? (pubRes.id || pubRes.message_id || pubRes.telegramMessageId) : 'simulated_id';
      } else {
        // Dry-run / Local simulation
        console.log(`${LOG_PREFIX} [Local / Dry-run] Telegram client not connected; simulated publish to ${channelConf.chatId}.`);
        msgId = `dryrun_${Date.now()}`;
      }

      // Record in Quota Tracker & Publish Ledger
      this.quotaTracker.recordPublish(channelConf.key, {
        mediaId,
        title,
        messageId: msgId,
        destinationId: channelConf.chatId
      });

      // Post update & direct link card to VIP group
      if (this.vipTopicRouter) {
        try {
          await this.vipTopicRouter.onVideoPublished({
            channelId: channelConf.chatId,
            messageId: msgId,
            title,
            channelUsername: channelConf.username
          });
        } catch (vipErr) {
          console.warn(`${LOG_PREFIX} VIP router notify error: ${vipErr.message}`);
        }
      }

      // Cleanup post-publish to conserve disk space
      if (this.enableCleanup && fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
          console.log(`${LOG_PREFIX} Cleaned up temporary video file: ${path.basename(filePath)}`);
        } catch (_) {}
      }

      return {
        status: 'PUBLISHED',
        channelKey: channelConf.key,
        destinationId: channelConf.chatId,
        messageId: msgId,
        title
      };

    } catch (err) {
      console.error(`${LOG_PREFIX} Upload error for "${title}" -> ${channelConf.name}: ${err.message}`);
      return { status: 'FAILED', error: err.message };
    }
  }

  /**
   * Runs the complete pipeline (scrape -> parallel download -> validate -> publish) for a single channel.
   * @param {string} channelKey
   * @param {object} [options]
   */
  async runChannel(channelKey, options = {}) {
    const channelConf = this.config.channels[channelKey];
    if (!channelConf) {
      throw new Error(`Channel configuration not found for key: ${channelKey}`);
    }

    const remaining = this.quotaTracker.getRemainingQuota(channelKey, channelConf.dailyQuota);
    console.log(`\n=======================================================`);
    console.log(`${LOG_PREFIX} Starting Pipeline: "${channelConf.name}" (@${channelConf.username})`);
    console.log(`${LOG_PREFIX} Daily Quota: ${this.quotaTracker.getPublishedCountToday(channelKey)}/${channelConf.dailyQuota} (Remaining: ${remaining})`);
    console.log(`=======================================================\n`);

    if (remaining <= 0) {
      console.log(`${LOG_PREFIX} Channel "${channelConf.name}" has reached today's 24-hour limit (${channelConf.dailyQuota}/${channelConf.dailyQuota}). Skipping.`);
      return { status: 'QUOTA_FULL', channelKey, publishedCount: 0 };
    }

    // 1. Scrape
    await this.runScraper(channelConf, options);

    // 2. Parallel Download (3-4 workers, up to remaining quota)
    const downloadResults = await this.runDownloader(channelConf, remaining);

    // 3. Ingest & Publish
    const publishResults = [];
    for (const item of downloadResults) {
      if (item.status === 'completed' || item.status === 'exists') {
        const pub = await this.publishVideoToChannel(channelConf, item);
        publishResults.push(pub);
        if (!this.quotaTracker.canPublish(channelKey, channelConf.dailyQuota)) {
          console.log(`${LOG_PREFIX} Hit daily ceiling during publishing loop.`);
          break;
        }
      }
    }

    const successCount = publishResults.filter(p => p.status === 'PUBLISHED').length;
    console.log(`${LOG_PREFIX} Pipeline completed for "${channelConf.name}": Published ${successCount} video(s).`);

    return {
      status: 'COMPLETED',
      channelKey,
      publishedCount: successCount,
      results: publishResults
    };
  }

  /**
   * Sequentially runs all 6 channels through the pipeline.
   * @param {object} [options]
   */
  async runAllChannels(options = {}) {
    if (this._running) {
      console.warn(`${LOG_PREFIX} Pipeline run is already in progress.`);
      return { status: 'ALREADY_RUNNING' };
    }
    this._running = true;
    const overallResults = {};

    try {
      for (const key of Object.keys(this.config.channels)) {
        const conf = this.config.channels[key];
        if (conf.enabled !== false) {
          try {
            overallResults[key] = await this.runChannel(key, options);
          } catch (err) {
            console.error(`${LOG_PREFIX} Error running channel ${key}: ${err.message}`);
            overallResults[key] = { status: 'ERROR', error: err.message };
          }
        }
      }
    } finally {
      this._running = false;
    }

    return {
      status: 'ALL_CHANNELS_COMPLETED',
      timestamp: new Date().toISOString(),
      summary: this.quotaTracker.getStatusSummary(),
      details: overallResults
    };
  }

  /**
   * Starts a recurring background scheduler (e.g. every 6 hours).
   * @param {number} [intervalMs=21600000]
   */
  startScheduler(intervalMs = 21600000) {
    if (this._schedulerTimer) {
      return { status: 'ALREADY_SCHEDULED' };
    }
    console.log(`${LOG_PREFIX} Starting recurring modular scheduler (interval: ${intervalMs / 3600000}h)`);
    this.runAllChannels().catch(e => console.error(`${LOG_PREFIX} Scheduled run error: ${e.message}`));
    this._schedulerTimer = setInterval(() => {
      this.runAllChannels().catch(e => console.error(`${LOG_PREFIX} Scheduled run error: ${e.message}`));
    }, intervalMs);
    return { status: 'STARTED', intervalMs };
  }

  stopScheduler() {
    if (this._schedulerTimer) {
      clearInterval(this._schedulerTimer);
      this._schedulerTimer = null;
      console.log(`${LOG_PREFIX} Stopped modular scheduler.`);
    }
  }

  getStatus() {
    return {
      running: this._running,
      schedulerActive: Boolean(this._schedulerTimer),
      quotas: this.quotaTracker.getStatusSummary()
    };
  }
}

module.exports = {
  ModularScraperPipeline,
  CONFIG_FILE
};
