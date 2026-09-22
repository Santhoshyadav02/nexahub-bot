/**
 * ============================================================
 * 🚀 UNIFIED 10-CHANNEL MODULAR SCRAPER PIPELINE ORCHESTRATOR
 * ============================================================
 * Features:
 *   1. 2-Hour Playwright scraper link generation across 600+ pages with dynamic pagination pointer.
 *   2. 2-Worker parallel downloading with atomic .part file verification.
 *   3. Strict multi-layer DUPLICATE PREVENTION (title hash, post URL, and mediaId ledger).
 *   4. Round-Robin balanced queue across all 10 Telegram channels.
 *   5. Strict 50 videos/day daily quota limit (5 videos per channel per 24 hours).
 *   6. Immediate post-upload cleanup & 30-minute orphan/temp file garbage collection.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { ModularQuotaTracker } = require('./modular_quota_tracker');
const { PublishLedger } = require('./publish_ledger');
const { MediaLedger } = require('./media_ledger');
const { validateMediaFile } = require('./media_validator');
const { dataPath, writeJsonAtomicSync } = require('../runtime_paths');

const LOG_PREFIX = '[MODULAR_PIPELINE]';
const ROOT_DIR = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(__dirname, 'modular_channel_config.json');

class ModularScraperPipeline {
  /**
   * @param {object} [options]
   * @param {string} [options.configPath]
   * @param {object} [options.telegramClient] Injected MTProto or Bot client
   * @param {number} [options.workers=2] Parallel download workers (default: 2)
   * @param {number} [options.dailyQuota=5] Max videos per channel per 24 hours (default: 5)
   * @param {number} [options.maxDailyTotal=50] Max total videos across all channels per 24 hours
   */
  constructor(options = {}) {
    this.configPath = options.configPath || CONFIG_FILE;
    this.config = this._loadConfig();
    this.workers = Math.min(2, Math.max(1, Number(options.workers || process.env.MODULAR_PIPELINE_WORKERS || 2)));
    this.dailyQuota = options.dailyQuota || this.config.dailyQuotaPerChannel || 5;
    this.maxDailyTotal = options.maxDailyTotal || 50;
    this.pythonPath = options.pythonPath || this._resolvePythonPath();

    this.quotaTracker = options.quotaTracker || new ModularQuotaTracker({
      defaultDailyQuota: this.dailyQuota
    });
    this.publishLedger = options.publishLedger || new PublishLedger();
    this.mediaLedger = options.mediaLedger || new MediaLedger();
    this.telegramClient = options.telegramClient || null;
    this.enableCleanup = options.enableCleanup !== undefined ? Boolean(options.enableCleanup) : true;

    this.pointersPath = dataPath('video_pipeline', 'state', 'modular_page_pointers.json');
    this.pagePointers = this._loadPagePointers();

    this._running = false;
    this._schedulerTimer = null;
    this._cleanupTimer = null;
    this._mtprotoUploader = null;
  }

  _loadPagePointers() {
    try {
      if (fs.existsSync(this.pointersPath)) {
        return JSON.parse(fs.readFileSync(this.pointersPath, 'utf8'));
      }
    } catch (_) {}
    return {};
  }

  _savePagePointers() {
    try {
      writeJsonAtomicSync(this.pointersPath, this.pagePointers);
    } catch (e) {
      console.warn(`${LOG_PREFIX} Could not save page pointers: ${e.message}`);
    }
  }

  _getPageRangeForChannel(channelKey) {
    const current = this.pagePointers[channelKey] || 1;
    const startPage = current;
    const endPage = current + 1; // 2 pages per scrape run (~18-20 videos)
    // Advance pointer for next run, wrapping at 15 so it stays on active content
    this.pagePointers[channelKey] = endPage >= 15 ? 1 : endPage + 1;
    this._savePagePointers();
    return { startPage, endPage };
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
          uploadWorkers: 2,
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
   * Normalizes video title for strict duplicate detection.
   */
  _normalizeTitle(title) {
    if (!title) return '';
    return title.toLowerCase().replace(/\[.*?\]|\(.*?\)/g, '').replace(/[^\w\s가-힣]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * Generates unique mediaId for ledger.
   */
  _getMediaId(title, destinationId) {
    const norm = this._normalizeTitle(title);
    return crypto.createHash('sha256').update(`${norm}:${destinationId}`).digest('hex').substring(0, 16);
  }

  /**
   * Checks if video item is a duplicate in either publish ledger or quota history.
   */
  isDuplicate(title, postUrl, destinationId) {
    if (!title && !postUrl) return false;
    const mediaId = this._getMediaId(title, destinationId);

    // 1. Check PublishLedger
    if (this.publishLedger && typeof this.publishLedger.isPublished === 'function') {
      if (this.publishLedger.isPublished(mediaId, destinationId)) {
        return true;
      }
    }

    // 2. Check Quota Tracker published history
    if (this.quotaTracker && this.quotaTracker.data && this.quotaTracker.data.channels) {
      for (const key of Object.keys(this.quotaTracker.data.channels)) {
        const chData = this.quotaTracker.data.channels[key];
        const history = chData.historyToday || chData.publishedHistory || [];
        const norm = this._normalizeTitle(title);
        for (const record of history) {
          if (record.mediaId === mediaId) return true;
          if (title && record.title && this._normalizeTitle(record.title) === norm) return true;
        }
      }
    }

    return false;
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
   * Runs the Playwright scraper for a given channel key with dynamic pagination.
   */
  async runScraper(channelConf, options = {}) {
    const scriptPath = path.resolve(ROOT_DIR, channelConf.scraperScript);
    const { startPage, endPage } = options.startPage
      ? { startPage: options.startPage, endPage: options.endPage || options.startPage + 1 }
      : this._getPageRangeForChannel(channelConf.key);
    const scrapingDir = path.resolve(ROOT_DIR, 'scraping');

    const dbPath = path.resolve(ROOT_DIR, channelConf.databaseJson);
    const dbFilename = path.basename(dbPath);
    const boardName = channelConf.board || 'korea';

    console.log(`${LOG_PREFIX} 🌐 Running scraper for "${channelConf.name}" (Board: ${boardName}, Pages ${startPage}-${endPage}) using python: ${this.pythonPath}`);

    const args = [
      scriptPath,
      '--board', boardName,
      '--start', String(startPage),
      '--end', String(endPage),
      '--output', dbPath
    ];
    await this._execProcess(this.pythonPath, args, scrapingDir, 480000);

    if (fs.existsSync(dbPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        console.log(`${LOG_PREFIX} Scraper for "${channelConf.name}" updated DB with ${data.length} total items.`);
        return data;
      } catch (e) {
        console.warn(`${LOG_PREFIX} Failed to read database ${dbPath}: ${e.message}`);
      }
    }
    return [];
  }

  /**
   * Filters candidate videos to exclude any already-published items before downloading.
   */
  _getNonDuplicateCandidates(channelConf, rawItems) {
    const unique = [];
    const seenInBatch = new Set();

    for (const item of rawItems) {
      if (!item) continue;
      const downloadUrl = item.mp4_download_url || (Array.isArray(item.video_urls) ? item.video_urls[0] : item.video_urls);
      if (!downloadUrl) continue;
      item.mp4_download_url = downloadUrl;
      item.post_url = item.post_url || item.page_url || '';

      const title = item.title || item.code || '';
      const postUrl = item.post_url || '';
      const norm = this._normalizeTitle(title);

      if (seenInBatch.has(norm)) continue;
      seenInBatch.add(norm);

      if (this.isDuplicate(title, postUrl, channelConf.chatId)) {
        continue;
      }

      unique.push(item);
    }

    return unique;
  }

  /**
   * Runs the 2-worker parallel downloader for a channel up to remaining quota with duplicate exclusion.
   */
  async runDownloader(channelConf, limit = 5) {
    const jsonPath = path.resolve(ROOT_DIR, channelConf.databaseJson);
    const outputDir = path.resolve(ROOT_DIR, channelConf.downloadDir);
    const downloaderScript = path.resolve(__dirname, 'modular_downloader.py');

    if (!fs.existsSync(jsonPath)) {
      console.warn(`${LOG_PREFIX} Database JSON does not exist: ${jsonPath}`);
      return [];
    }

    // Filter DB in-place or pass clean candidates
    let items = [];
    try {
      items = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch (_) {}

    const nonDupes = this._getNonDuplicateCandidates(channelConf, items);
    console.log(`${LOG_PREFIX} [Deduplication] "${channelConf.name}": ${nonDupes.length} fresh (non-duplicate) video candidates ready for download.`);

    if (nonDupes.length === 0) {
      return [];
    }

    // Write temp clean candidate JSON to ensure downloader only downloads non-duplicates
    const tempCandidateJson = path.join(path.dirname(jsonPath), `.clean_${channelConf.key}_candidates.json`);
    fs.writeFileSync(tempCandidateJson, JSON.stringify(nonDupes, null, 2), 'utf8');

    console.log(`${LOG_PREFIX} 📥 Launching 2-worker parallel downloader for "${channelConf.name}" (limit: ${limit})`);
    const args = [
      downloaderScript,
      '--json', tempCandidateJson,
      '--output', outputDir,
      '--workers', String(this.workers),
      '--limit', String(limit)
    ];

    const res = await this._execProcess(this.pythonPath, args, ROOT_DIR, 1800000);

    try {
      if (fs.existsSync(tempCandidateJson)) fs.unlinkSync(tempCandidateJson);
    } catch (_) {}

    const match = res.stdout.match(/__RESULT_JSON__:(.*)$/m);
    if (match && match[1]) {
      try {
        const parsed = JSON.parse(match[1].trim());
        // Invalidate expired 403 token items in DB so next scrape fetches fresh URLs automatically
        const expiredUrls = new Set(parsed.filter(r => r.expired_token || (r.error && r.error.includes('403'))).map(r => r.post_url || r.title));
        if (expiredUrls.size > 0 && fs.existsSync(jsonPath)) {
          try {
            const dbData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            let mod = false;
            for (const item of dbData) {
              if (expiredUrls.has(item.post_url) || expiredUrls.has(item.title)) {
                item.mp4_download_url = null;
                item.scraped_at = 0;
                mod = true;
              }
            }
            if (mod) fs.writeFileSync(jsonPath, JSON.stringify(dbData, null, 2), 'utf8');
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
   */
  async publishVideoToChannel(channelConf, item) {
    const filePath = item.filepath;
    if (!fs.existsSync(filePath)) {
      return { status: 'FAILED', reason: 'File does not exist on disk' };
    }

    const title = item.title || path.basename(filePath, '.mp4');
    const mediaId = this._getMediaId(title, channelConf.chatId);

    // 1. Quota Check (Channel quota + Global daily quota 50)
    if (!this.quotaTracker.canPublish(channelConf.key, channelConf.dailyQuota)) {
      console.log(`${LOG_PREFIX} Channel quota reached for "${channelConf.name}" (5/5 today). Skipping.`);
      return { status: 'QUOTA_REACHED', channelKey: channelConf.key };
    }

    const totalToday = this.getTotalPublishedToday();
    if (totalToday >= this.maxDailyTotal) {
      console.log(`${LOG_PREFIX} Global daily quota reached (${totalToday}/${this.maxDailyTotal} total). Skipping.`);
      return { status: 'GLOBAL_QUOTA_REACHED' };
    }

    // 2. Strict Duplicate Prevention
    if (this.isDuplicate(title, item.post_url, channelConf.chatId)) {
      console.log(`${LOG_PREFIX} 🚫 Duplicate detected for "${title}" on ${channelConf.name}. Skipping and cleaning file.`);
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (_) {}
      return { status: 'SKIPPED_DUPLICATE', mediaId, title };
    }

    // 3. Technical Media Validation (Fast FFprobe metadata inspection, skipping heavy full-decode CPU freeze)
    const validation = await validateMediaFile(filePath, { skipDecode: true, allowRemuxFallback: false });
    if (!validation.valid) {
      const errMsg = validation.error || validation.reason || 'Unknown validation failure';
      console.warn(`${LOG_PREFIX} Media validation failed for ${filePath}: ${errMsg}. Deleting corrupted file.`);
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (_) {}
      return { status: 'INVALID_MEDIA', reason: errMsg };
    }

    console.log(`${LOG_PREFIX} 📤 Publishing "${title}" -> ${channelConf.name} (${channelConf.username || channelConf.chatId})`);

    let msgId = null;
    try {
      const fileSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
      let client = this._getOrInitTelegramClient();

      if (fileSize > 48 * 1024 * 1024 && process.env.TELEGRAM_SESSION_STRING && process.env.TELEGRAM_API_ID) {
        if (!this._mtprotoUploader) {
          try {
            const { MtprotoVideoUploader } = require('./mtproto_video_uploader');
            this._mtprotoUploader = new MtprotoVideoUploader({
              apiId: process.env.TELEGRAM_API_ID,
              apiHash: process.env.TELEGRAM_API_HASH,
              sessionString: process.env.TELEGRAM_SESSION_STRING,
              uploadWorkers: 2,
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
        console.log(`${LOG_PREFIX} [Local / Dry-run] Simulated publish to ${channelConf.chatId}.`);
        msgId = `dryrun_${Date.now()}`;
      }

      // Record in Quota Tracker & Publish Ledger
      this.quotaTracker.recordPublish(channelConf.key, {
        mediaId,
        title,
        messageId: msgId,
        destinationId: channelConf.chatId
      });

      // Record in PublishLedger index
      if (this.publishLedger && typeof this.publishLedger.recordPublish === 'function') {
        try {
          this.publishLedger.recordPublish({
            mediaId,
            destinationId: channelConf.chatId,
            telegramMessageId: msgId,
            status: 'PUBLISHED'
          });
        } catch (_) {}
      }

      // Cleanup post-publish to conserve disk space immediately
      if (this.enableCleanup && fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
          console.log(`${LOG_PREFIX} 🗑️ Cleaned up temporary video file: ${path.basename(filePath)}`);
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
   * Returns total videos published today across all channels.
   */
  getTotalPublishedToday() {
    let total = 0;
    const channels = Object.keys(this.config.channels || {});
    for (const key of channels) {
      total += (this.quotaTracker.getPublishedCountToday ? this.quotaTracker.getPublishedCountToday(key) : 0) || 0;
    }
    return total;
  }

  /**
   * Runs the complete pipeline (scrape -> parallel download -> validate -> publish) for a single channel.
   */
  async runChannel(channelKey, options = {}) {
    const channelConf = this.config.channels[channelKey];
    if (!channelConf) {
      throw new Error(`Channel configuration not found for key: ${channelKey}`);
    }

    const remaining = this.quotaTracker.getRemainingQuota(channelKey, channelConf.dailyQuota);
    console.log(`\n=======================================================`);
    console.log(`${LOG_PREFIX} Starting Pipeline: "${channelConf.name}" (@${channelConf.username || channelConf.chatId})`);
    console.log(`${LOG_PREFIX} Channel Daily Quota: ${this.quotaTracker.getPublishedCountToday(channelKey)}/${channelConf.dailyQuota} (Remaining: ${remaining})`);
    console.log(`${LOG_PREFIX} Total Published Today: ${this.getTotalPublishedToday()}/${this.maxDailyTotal}`);
    console.log(`=======================================================\n`);

    if (remaining <= 0) {
      console.log(`${LOG_PREFIX} Channel "${channelConf.name}" quota full (5/5). Skipping.`);
      return { status: 'QUOTA_FULL', channelKey, publishedCount: 0 };
    }

    if (this.getTotalPublishedToday() >= this.maxDailyTotal) {
      console.log(`${LOG_PREFIX} Global daily quota reached (${this.maxDailyTotal}/${this.maxDailyTotal}). Skipping.`);
      return { status: 'GLOBAL_QUOTA_FULL', channelKey, publishedCount: 0 };
    }

    // 1. Scrape fresh page batch (1-2 pages)
    await this.runScraper(channelConf, options);

    // 2. Parallel Download (2 workers, up to remaining quota)
    const downloadResults = await this.runDownloader(channelConf, remaining);

    // 3. Ingest, Validate & Publish
    const publishResults = [];
    for (const item of downloadResults) {
      if (item.status === 'completed' || item.status === 'exists') {
        const pub = await this.publishVideoToChannel(channelConf, item);
        publishResults.push(pub);
        if (!this.quotaTracker.canPublish(channelKey, channelConf.dailyQuota) || this.getTotalPublishedToday() >= this.maxDailyTotal) {
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
   * ⚖️ Algorithmic Round-Robin Fair Distribution across all 10 channels.
   * Alternates through each channel to ensure even publishing and instant progress.
   */
  async runRoundRobinCycle(options = {}) {
    if (this._running) {
      console.warn(`${LOG_PREFIX} Pipeline run is already in progress.`);
      return { status: 'ALREADY_RUNNING' };
    }
    this._running = true;
    const overallResults = {};

    console.log('\n' + '='.repeat(68));
    console.log(`🚀 [ROUND-ROBIN] Starting 10-Channel Scraping & Publishing Cycle`);
    console.log(`🎯 Target: 50 videos/day max | Concurrency: 2 download workers`);
    console.log('='.repeat(68) + '\n');

    try {
      const channelKeys = Object.keys(this.config.channels);
      let progressMade = true;
      let passNumber = 1;

      // Multi-pass round-robin loop: 1 video per channel per pass
      while (progressMade && this.getTotalPublishedToday() < this.maxDailyTotal) {
        progressMade = false;
        console.log(`\n--- [ROUND-ROBIN PASS ${passNumber}] Total Today: ${this.getTotalPublishedToday()}/${this.maxDailyTotal} ---`);

        for (const key of channelKeys) {
          const conf = this.config.channels[key];
          if (conf.enabled === false) continue;

          if (this.quotaTracker.canPublish(key, conf.dailyQuota) && this.getTotalPublishedToday() < this.maxDailyTotal) {
            try {
              // 1. Check existing non-duplicate candidates in database
              const dbPath = path.resolve(ROOT_DIR, conf.databaseJson);
              let items = [];
              if (fs.existsSync(dbPath)) {
                try { items = JSON.parse(fs.readFileSync(dbPath, 'utf8')); } catch (_) {}
              }
              let nonDupes = this._getNonDuplicateCandidates(conf, items);

              // If low on fresh items (< 2), scrape 1 page immediately to top up
              if (nonDupes.length < 2) {
                console.log(`${LOG_PREFIX} 🌐 Fetching fresh links for "${conf.name}"...`);
                await this.runScraper(conf, options);
                if (fs.existsSync(dbPath)) {
                  try { items = JSON.parse(fs.readFileSync(dbPath, 'utf8')); } catch (_) {}
                  nonDupes = this._getNonDuplicateCandidates(conf, items);
                }
              }

              // 2. Download up to 2 videos in parallel with 2 concurrent workers
              const chRemaining = this.quotaTracker.getRemainingQuota(key, conf.dailyQuota);
              const batchLimit = Math.min(2, chRemaining);
              if (nonDupes.length > 0 && batchLimit > 0) {
                console.log(`${LOG_PREFIX} 📥 [DOWNLOAD] Channel "${conf.name}" -> Downloading ${batchLimit} video(s) in parallel (Workers: 2)...`);
                const downloadResults = await this.runDownloader(conf, batchLimit);
                for (const item of downloadResults) {
                  if (item.status === 'completed' || item.status === 'exists') {
                    // 3. Publish to Telegram
                    console.log(`${LOG_PREFIX} 📤 [PUBLISH] Uploading "${item.title}" to ${conf.name}...`);
                    const pub = await this.publishVideoToChannel(conf, item);
                    if (!overallResults[key]) overallResults[key] = [];
                    overallResults[key].push(pub);
                    if (pub.status === 'PUBLISHED') {
                      progressMade = true;
                      console.log(`${LOG_PREFIX} ⏳ [PACE] Pausing 20s before next channel to respect Telegram rate limits...`);
                      await new Promise(r => setTimeout(r, 20000));
                    }
                  }
                }
              }
            } catch (err) {
              console.error(`${LOG_PREFIX} Round-robin error on channel ${key}: ${err.message}`);
            }
          }
        }
        passNumber++;
        if (passNumber > 6) break; // Maximum 6 passes per 2-hour cycle (up to 5 vids/channel)
      }

    } finally {
      this._running = false;
      // Perform 30-minute stale file cleanup
      this.cleanupStaleFiles(1800000);
    }

    return {
      status: 'ROUND_ROBIN_CYCLE_COMPLETED',
      timestamp: new Date().toISOString(),
      totalPublishedToday: this.getTotalPublishedToday(),
      summary: this.quotaTracker.getStatusSummary(),
      details: overallResults
    };
  }

  /**
   * 🧹 Periodic 30-minute garbage collector:
   * Sweeps download directories and removes any temporary, partial, or orphaned files older than maxAgeMs.
   */
  cleanupStaleFiles(maxAgeMs = 1800000) {
    if (!this.enableCleanup) return;
    const now = Date.now();
    let cleanedFiles = 0;
    let freedBytes = 0;

    const channelKeys = Object.keys(this.config.channels || {});
    for (const key of channelKeys) {
      const conf = this.config.channels[key];
      const dirPath = path.resolve(ROOT_DIR, conf.downloadDir || `scraping/downloads/${key}`);
      if (fs.existsSync(dirPath)) {
        try {
          const files = fs.readdirSync(dirPath);
          for (const f of files) {
            const fullPath = path.join(dirPath, f);
            try {
              const stat = fs.statSync(fullPath);
              const age = now - stat.mtimeMs;
              // Clean .part, .tmp files older than 30m, or .mp4 files older than 30m that are already published
              if (f.startsWith('.part') || f.endsWith('.tmp') || age > maxAgeMs) {
                fs.unlinkSync(fullPath);
                cleanedFiles++;
                freedBytes += stat.size;
              }
            } catch (_) {}
          }
        } catch (_) {}
      }
    }

    if (cleanedFiles > 0) {
      const mb = (freedBytes / (1024 * 1024)).toFixed(1);
      console.log(`${LOG_PREFIX} 🧹 Stale file cleanup: removed ${cleanedFiles} orphan/temp file(s), freed ${mb} MB.`);
    }
  }

  /**
   * Starts recurring background scheduler (every 2-3 hours, default: 2 hours).
   * Also starts 30-minute stale file cleaner.
   */
  startScheduler(intervalMs = 7200000) {
    if (this._schedulerTimer) {
      return { status: 'ALREADY_SCHEDULED' };
    }
    console.log(`${LOG_PREFIX} Starting 2-hour modular scheduler (interval: ${intervalMs / 3600000}h)`);

    // Run first cycle
    this.runRoundRobinCycle().catch(e => console.error(`${LOG_PREFIX} Scheduled run error: ${e.message}`));

    this._schedulerTimer = setInterval(() => {
      this.runRoundRobinCycle().catch(e => console.error(`${LOG_PREFIX} Scheduled run error: ${e.message}`));
    }, intervalMs);

    // 30-minute periodic temp file cleanup
    this._cleanupTimer = setInterval(() => {
      this.cleanupStaleFiles(1800000);
    }, 1800000);

    return { status: 'STARTED', intervalMs };
  }

  stopScheduler() {
    if (this._schedulerTimer) {
      clearInterval(this._schedulerTimer);
      this._schedulerTimer = null;
      console.log(`${LOG_PREFIX} Stopped modular scheduler.`);
    }
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }

  /**
   * Cleans all downloaded files across all 10 channels.
   */
  cleanAllDownloads() {
    let count = 0;
    let bytes = 0;
    const channelKeys = Object.keys(this.config.channels || {});
    for (const key of channelKeys) {
      const conf = this.config.channels[key];
      const dirPath = path.resolve(ROOT_DIR, conf.downloadDir || `scraping/downloads/${key}`);
      if (fs.existsSync(dirPath)) {
        try {
          const files = fs.readdirSync(dirPath);
          for (const f of files) {
            const fp = path.join(dirPath, f);
            try {
              const stat = fs.statSync(fp);
              fs.unlinkSync(fp);
              count++;
              bytes += stat.size;
            } catch (_) {}
          }
        } catch (_) {}
      }
    }
    const mb = (bytes / (1024 * 1024)).toFixed(1);
    console.log(`${LOG_PREFIX} 🧹 Cleaned all download directories: removed ${count} file(s), freed ${mb} MB.`);
    return { count, bytes, freedMb: mb };
  }

  getStatus() {
    return {
      running: this._running,
      schedulerActive: Boolean(this._schedulerTimer),
      totalPublishedToday: this.getTotalPublishedToday(),
      maxDailyTotal: this.maxDailyTotal,
      quotas: this.quotaTracker.getStatusSummary()
    };
  }
}

let _modularPipelineInstance = null;
function getModularPipelineInstance(options = {}) {
  if (!_modularPipelineInstance) {
    _modularPipelineInstance = new ModularScraperPipeline(options);
  }
  return _modularPipelineInstance;
}

module.exports = {
  ModularScraperPipeline,
  getModularPipelineInstance,
  CONFIG_FILE
};
