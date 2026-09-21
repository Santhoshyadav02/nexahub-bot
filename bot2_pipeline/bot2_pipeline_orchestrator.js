/**
 * ============================================================
 * 🚀 BOT 2 MODULAR SCRAPER PIPELINE ORCHESTRATOR (Scraping-1)
 * ============================================================
 * Manages 6-channel automated scraping, parallel downloading,
 * deduplication, and publishing for Bot 2.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { Bot2QuotaTracker } = require('./bot2_quota_tracker');
const { validateMediaFile } = require('../video_pipeline/media_validator');
const { dataPath, writeJsonAtomicSync } = require('../runtime_paths');

const LOG_PREFIX = '[BOT2_PIPELINE]';
const ROOT_DIR = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(__dirname, 'bot2_channel_config.json');

class Bot2PipelineOrchestrator {
  /**
   * @param {object} [options]
   * @param {string} [options.configPath]
   * @param {object} [options.telegramClient] Injected Telegram Bot or MTProto client for Bot 2
   * @param {number} [options.workers=2] Parallel download workers (clamped to 2)
   * @param {number} [options.dailyQuota=5] Max videos per channel per 24 hours (default: 5)
   * @param {number} [options.maxDailyTotal=30] Max total videos across 6 channels per 24 hours
   */
  constructor(options = {}) {
    this.configPath = options.configPath || CONFIG_FILE;
    this.config = this._loadConfig();
    this.workers = Math.min(2, Math.max(1, Number(options.workers || process.env.BOT2_PIPELINE_WORKERS || 2)));
    this.dailyQuota = options.dailyQuota || this.config.dailyQuotaPerChannel || 5;
    this.maxDailyTotal = options.maxDailyTotal || this.config.maxDailyTotal || 30;
    this.pythonPath = options.pythonPath || this._resolvePythonPath();

    this.quotaTracker = options.quotaTracker || new Bot2QuotaTracker({
      defaultDailyQuota: this.dailyQuota
    });
    this.telegramClient = options.telegramClient || null;
    this.enableCleanup = options.enableCleanup !== undefined ? Boolean(options.enableCleanup) : true;

    this.pointersPath = dataPath('bot2_pipeline', 'state', 'bot2_page_pointers.json');
    this.pagePointers = this._loadPagePointers();

    this._running = false;
    this._schedulerTimer = null;
    this._cleanupTimer = null;
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
    const endPage = current + 1; // 2 pages per scrape run (~18-20 candidates)
    this.pagePointers[channelKey] = endPage >= 600 ? 1 : endPage + 1;
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
      path.join(ROOT_DIR, 'scraping-1', '.venv', 'Scripts', 'python.exe'),
      path.join(ROOT_DIR, 'scraping', '.venv', 'Scripts', 'python.exe'),
      'python3',
      'python'
    ];
    for (const p of candidatePaths) {
      if (p.includes(path.sep) && fs.existsSync(p)) return p;
    }
    return candidatePaths[candidatePaths.length - 1];
  }

  _loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        return JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      }
    } catch (e) {
      console.error(`${LOG_PREFIX} Failed to load config from ${this.configPath}: ${e.message}`);
    }
    return { channels: {}, dailyQuotaPerChannel: 5, maxDailyTotal: 30 };
  }

  _execProcess(cmd, args, cwd = ROOT_DIR, timeoutMs = 600000) {
    return new Promise((resolve) => {
      console.log(`${LOG_PREFIX} Spawning: ${cmd} ${args.join(' ')} (cwd=${cwd})`);
      const child = spawn(cmd, args, { cwd, env: process.env, shell: false });
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (d) => {
        const str = d.toString();
        stdout += str;
        process.stdout.write(`[Bot 2 Child] ${str}`);
      });

      child.stderr.on('data', (d) => {
        const str = d.toString();
        stderr += str;
        process.stderr.write(`[Bot 2 Child ERR] ${str}`);
      });

      const timer = setTimeout(() => {
        console.error(`${LOG_PREFIX} Process timed out (${timeoutMs}ms). Terminating...`);
        child.kill('SIGKILL');
      }, timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        console.error(`${LOG_PREFIX} Process spawn error: ${err.message}`);
        resolve({ code: -1, stdout, stderr, error: err });
      });
    });
  }

  generateMediaId(title, postUrl) {
    const raw = `${(title || '').trim().toLowerCase()}::${(postUrl || '').trim()}`;
    return crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);
  }

  isDuplicate(title, postUrl) {
    if (this.quotaTracker.isDuplicateTitle(title)) return true;
    return false;
  }

  _getNonDuplicateCandidates(channelConf, items) {
    const fresh = [];
    for (const item of items) {
      if (!item.mp4_download_url) continue;
      const title = item.title || 'untitled';
      const postUrl = item.post_url || '';

      if (this.isDuplicate(title, postUrl)) {
        continue;
      }
      fresh.push(item);
    }
    return fresh;
  }

  async runScraper(channelConf, options = {}) {
    const scraperScript = path.resolve(ROOT_DIR, channelConf.scraperScript);
    const outputFile = path.resolve(ROOT_DIR, channelConf.databaseJson);

    if (!fs.existsSync(scraperScript)) {
      console.warn(`${LOG_PREFIX} Scraper script not found: ${scraperScript}`);
      return { success: false, error: 'Script not found' };
    }

    const { startPage, endPage } = options.startPage && options.endPage
      ? { startPage: options.startPage, endPage: options.endPage }
      : this._getPageRangeForChannel(channelConf.key);

    console.log(`\n${LOG_PREFIX} 🌐 Running Scraper for "${channelConf.name}" (Pages ${startPage} to ${endPage})...`);
    const args = [
      scraperScript,
      '--board', channelConf.board || channelConf.key,
      '--start', String(startPage),
      '--end', String(endPage),
      '--output', outputFile
    ];

    const res = await this._execProcess(this.pythonPath, args, ROOT_DIR, 900000);
    return {
      success: res.code === 0,
      code: res.code,
      startPage,
      endPage
    };
  }

  async runDownloader(channelConf, limit = 5) {
    const jsonPath = path.resolve(ROOT_DIR, channelConf.databaseJson);
    const outputDir = path.resolve(ROOT_DIR, channelConf.downloadDir);
    const downloaderScript = path.resolve(__dirname, 'bot2_downloader.py');

    if (!fs.existsSync(jsonPath)) {
      console.warn(`${LOG_PREFIX} Database JSON does not exist: ${jsonPath}`);
      return [];
    }

    let items = [];
    try {
      items = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch (_) {}

    const nonDupes = this._getNonDuplicateCandidates(channelConf, items);
    console.log(`${LOG_PREFIX} [Deduplication] "${channelConf.name}": ${nonDupes.length} fresh video candidates ready for download.`);

    if (nonDupes.length === 0) {
      return [];
    }

    const tempCandidateJson = path.join(path.dirname(jsonPath), `.clean_bot2_${channelConf.key}_candidates.json`);
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
        return parsed;
      } catch (e) {
        console.error(`${LOG_PREFIX} Failed to parse downloader JSON output: ${e.message}`);
      }
    }
    return [];
  }

  async publishVideoToChannel(channelConf, item) {
    const title = item.title || 'untitled';
    const filePath = item.filepath;
    const mediaId = this.generateMediaId(title, item.post_url);

    if (!this.quotaTracker.canPublish(channelConf.key, channelConf.dailyQuota)) {
      console.log(`${LOG_PREFIX} Channel quota reached for "${channelConf.name}" (5/5 today). Skipping.`);
      return { status: 'QUOTA_REACHED', channelKey: channelConf.key };
    }

    if (this.getTotalPublishedToday() >= this.maxDailyTotal) {
      console.log(`${LOG_PREFIX} Global daily quota reached (${this.getTotalPublishedToday()}/${this.maxDailyTotal} total). Skipping.`);
      return { status: 'GLOBAL_QUOTA_REACHED' };
    }

    if (this.isDuplicate(title, item.post_url)) {
      console.log(`${LOG_PREFIX} 🚫 Duplicate detected for "${title}" on ${channelConf.name}. Skipping.`);
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (_) {}
      return { status: 'SKIPPED_DUPLICATE', mediaId, title };
    }

    // Fast container inspection, skip heavy CPU decode
    const validation = await validateMediaFile(filePath, { skipDecode: true, allowRemuxFallback: false });
    if (!validation.valid) {
      const errMsg = validation.error || validation.reason || 'Unknown validation failure';
      console.warn(`${LOG_PREFIX} Media validation failed for ${filePath}: ${errMsg}. Deleting file.`);
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (_) {}
      return { status: 'INVALID_MEDIA', reason: errMsg };
    }

    console.log(`${LOG_PREFIX} 📤 Publishing "${title}" -> ${channelConf.name} (${channelConf.username || channelConf.chatId})`);

    let msgId = null;
    try {
      const client = this.telegramClient;
      if (client) {
        const caption = `🎬 <b>${title}</b>\n\n📌 <i>Channel: ${channelConf.name}</i>`;
        let pubRes = null;

        if (typeof client.sendVideo === 'function') {
          pubRes = await client.sendVideo(channelConf.chatId, filePath, {
            caption,
            parse_mode: 'HTML'
          });
        }
        msgId = pubRes ? (pubRes.message_id || pubRes.id) : 'bot2_msg';
      } else {
        console.log(`${LOG_PREFIX} [Local / Dry-run] Simulated publish to ${channelConf.chatId}.`);
        msgId = `dryrun_bot2_${Date.now()}`;
      }

      this.quotaTracker.recordPublish(channelConf.key, {
        mediaId,
        title,
        messageId: msgId,
        destinationId: channelConf.chatId
      });

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

  getTotalPublishedToday() {
    let total = 0;
    const channels = Object.keys(this.config.channels || {});
    for (const key of channels) {
      total += (this.quotaTracker.getPublishedCountToday ? this.quotaTracker.getPublishedCountToday(key) : 0) || 0;
    }
    return total;
  }

  async runRoundRobinCycle(options = {}) {
    if (this._running) {
      console.warn(`${LOG_PREFIX} Pipeline run is already in progress.`);
      return { status: 'ALREADY_RUNNING' };
    }
    this._running = true;
    const overallResults = {};

    console.log('\n' + '='.repeat(68));
    console.log(`🚀 [BOT 2 ROUND-ROBIN] Starting 6-Channel Scraping & Publishing Cycle`);
    console.log(`🎯 Target: 30 videos/day max | Concurrency: 2 download workers`);
    console.log('='.repeat(68) + '\n');

    try {
      const channelKeys = Object.keys(this.config.channels);
      let progressMade = true;
      let passNumber = 1;

      while (progressMade && this.getTotalPublishedToday() < this.maxDailyTotal) {
        progressMade = false;
        console.log(`\n--- [BOT 2 PASS ${passNumber}] Total Today: ${this.getTotalPublishedToday()}/${this.maxDailyTotal} ---`);

        for (const key of channelKeys) {
          const conf = this.config.channels[key];
          if (conf.enabled === false) continue;

          if (this.quotaTracker.canPublish(key, conf.dailyQuota) && this.getTotalPublishedToday() < this.maxDailyTotal) {
            try {
              const dbPath = path.resolve(ROOT_DIR, conf.databaseJson);
              let items = [];
              if (fs.existsSync(dbPath)) {
                try { items = JSON.parse(fs.readFileSync(dbPath, 'utf8')); } catch (_) {}
              }
              let nonDupes = this._getNonDuplicateCandidates(conf, items);

              if (nonDupes.length < 2) {
                console.log(`${LOG_PREFIX} 🌐 Fetching fresh links for "${conf.name}"...`);
                await this.runScraper(conf, options);
                if (fs.existsSync(dbPath)) {
                  try { items = JSON.parse(fs.readFileSync(dbPath, 'utf8')); } catch (_) {}
                  nonDupes = this._getNonDuplicateCandidates(conf, items);
                }
              }

              const chRemaining = this.quotaTracker.getRemainingQuota(key, conf.dailyQuota);
              const batchLimit = Math.min(2, chRemaining);
              if (nonDupes.length > 0 && batchLimit > 0) {
                console.log(`${LOG_PREFIX} 📥 [DOWNLOAD] Channel "${conf.name}" -> Downloading ${batchLimit} video(s) (Workers: 2)...`);
                const downloadResults = await this.runDownloader(conf, batchLimit);
                for (const item of downloadResults) {
                  if (item.status === 'completed' || item.status === 'exists') {
                    console.log(`${LOG_PREFIX} 📤 [PUBLISH] Uploading "${item.title}" to ${conf.name}...`);
                    const pub = await this.publishVideoToChannel(conf, item);
                    if (!overallResults[key]) overallResults[key] = [];
                    overallResults[key].push(pub);
                    if (pub.status === 'PUBLISHED') {
                      progressMade = true;
                      await new Promise(r => setTimeout(r, 10000));
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
        if (passNumber > 6) break;
      }
    } finally {
      this._running = false;
      this.cleanupStaleFiles(1800000);
    }

    return {
      status: 'BOT2_ROUND_ROBIN_COMPLETED',
      timestamp: new Date().toISOString(),
      totalPublishedToday: this.getTotalPublishedToday(),
      summary: this.quotaTracker.getStatusSummary(),
      details: overallResults
    };
  }

  cleanupStaleFiles(maxAgeMs = 1800000) {
    if (!this.enableCleanup) return;
    const now = Date.now();
    const channelKeys = Object.keys(this.config.channels || {});
    for (const key of channelKeys) {
      const conf = this.config.channels[key];
      const dirPath = path.resolve(ROOT_DIR, conf.downloadDir || `scraping-1/downloads/${key}`);
      if (fs.existsSync(dirPath)) {
        try {
          const files = fs.readdirSync(dirPath);
          for (const f of files) {
            const fullPath = path.join(dirPath, f);
            try {
              const stat = fs.statSync(fullPath);
              const age = now - stat.mtimeMs;
              if (f.startsWith('.part') || f.endsWith('.tmp') || age > maxAgeMs) {
                fs.unlinkSync(fullPath);
              }
            } catch (_) {}
          }
        } catch (_) {}
      }
    }
  }

  startScheduler(intervalMs = 2 * 60 * 60 * 1000) {
    if (this._schedulerTimer) return;
    console.log(`${LOG_PREFIX} Starting Bot 2 modular scheduler (interval: ${intervalMs / 1000 / 60}m)`);
    setImmediate(() => this.runRoundRobinCycle().catch(e => console.error(`${LOG_PREFIX} Cycle failed: ${e.message}`)));
    this._schedulerTimer = setInterval(() => {
      this.runRoundRobinCycle().catch(e => console.error(`${LOG_PREFIX} Cycle failed: ${e.message}`));
    }, intervalMs);

    this._cleanupTimer = setInterval(() => this.cleanupStaleFiles(1800000), 30 * 60 * 1000);
  }

  stopScheduler() {
    if (this._schedulerTimer) {
      clearInterval(this._schedulerTimer);
      this._schedulerTimer = null;
    }
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }
}

let _bot2Instance = null;
function getBot2PipelineInstance(options = {}) {
  if (!_bot2Instance) {
    _bot2Instance = new Bot2PipelineOrchestrator(options);
  }
  return _bot2Instance;
}

module.exports = {
  Bot2PipelineOrchestrator,
  getBot2PipelineInstance,
  LOG_PREFIX
};
