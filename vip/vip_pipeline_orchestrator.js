/**
 * ============================================================
 * 👑 VIP AUTOMATED VIDEO PIPELINE ORCHESTRATOR
 * ============================================================
 * Manages the end-to-end automation for 6 VIP Telegram Channels:
 *   1. VIP-BJ  (-1003977934133)
 *   2. VIP-JP  (-1004484964035)
 *   3. VIP-CN  (-1004304488687)
 *   4. VIP-KR  (-1004435999618)
 *   5. VIP-18+ (-1003845130520)
 *   6. VIP-AV  (-1004352512630)
 *
 * Capabilities:
 *   - 3-hour Playwright link refresh cycle for fresh CDN stream tokens.
 *   - 2 parallel worker concurrency for high-speed download & upload.
 *   - 5 videos / day quota per channel (max 30 total daily).
 *   - Round-robin channel queue rotation.
 *   - Strict deduplication ledger preventing duplicate downloads/posts.
 *   - Direct 2GB MTProto Telegram video uploading with clean title captions.
 *   - Immediate local file deletion post-upload + 1-hour cleanup daemon.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const CONFIG_PATH = path.resolve(__dirname, 'config.json');
const STATE_PATH = path.resolve(__dirname, 'vip_pipeline_state.json');
const SCRAPERS_DIR = path.resolve(__dirname, 'scrapers');

const LOG_PREFIX = '[VIP_PIPELINE]';

const CHANNEL_DEFS = {
  BJ: {
    key: 'BJ',
    tag: 'VIP-BJ',
    chatId: '-1003977934133',
    scraperScript: 'bj_scraper.py',
    downloaderScript: 'bj_downloader.py',
    jsonFile: 'bj_videos.json',
    downloadDir: 'downloads/bj'
  },
  JP: {
    key: 'JP',
    tag: 'VIP-JP',
    chatId: '-1004484964035',
    scraperScript: 'jp_scraper.py',
    downloaderScript: 'jp_downloader.py',
    jsonFile: 'jp_videos.json',
    downloadDir: 'downloads/jp'
  },
  CN: {
    key: 'CN',
    tag: 'VIP-CN',
    chatId: '-1004304488687',
    scraperScript: 'xchina_scraper.py',
    downloaderScript: 'xchina_downloader.py',
    jsonFile: 'xchina_videos.json',
    downloadDir: 'downloads/xchina'
  },
  KR: {
    key: 'KR',
    tag: 'VIP-KR',
    chatId: '-1004435999618',
    scraperScript: 'kr_scraper.py',
    downloaderScript: 'kr_downloader.py',
    jsonFile: 'kr_videos.json',
    downloadDir: 'downloads/kr'
  },
  '18': {
    key: '18',
    tag: 'VIP-18',
    chatId: '-1003845130520',
    scraperScript: 'krx_scraper.py',
    downloaderScript: 'krx_downloader.py',
    jsonFile: 'krx_videos.json',
    downloadDir: 'downloads/18+'
  },
  AV: {
    key: 'AV',
    tag: 'VIP-AV',
    chatId: '-1004352512630',
    scraperScript: 'av_scraper.py',
    downloaderScript: 'av_downloader.py',
    jsonFile: 'av_videos.json',
    downloadDir: 'downloads/av'
  }
};

class VipPipelineOrchestrator {
  constructor(options = {}) {
    this.configPath = options.configPath || CONFIG_PATH;
    this.statePath = options.statePath || STATE_PATH;
    this.scrapersDir = options.scrapersDir || SCRAPERS_DIR;
    this.dryRun = options.dryRun || false;
    this.uploader = options.uploader || null;

    this.config = this._loadConfig();
    this.state = this._loadState();

    this.maxWorkers = (this.config.pipeline && this.config.pipeline.workers) || 2;
    this.dailyQuotaPerChannel = (this.config.pipeline && this.config.pipeline.dailyQuotaPerChannel) || 5;
    this.scrapeIntervalHours = (this.config.pipeline && this.config.pipeline.scrapeIntervalHours) || 3;
    this.roundRobinOrder = (this.config.pipeline && this.config.pipeline.roundRobinOrder) || ['BJ', 'JP', 'CN', 'KR', '18', 'AV'];

    this.isRunning = false;
    this.activeWorkers = 0;
    this._mtprotoUploader = null;
    this._cachedPythonRunner = null;
  }

  _loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        return JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      }
    } catch (e) {
      console.error(`${LOG_PREFIX} Failed to load config: ${e.message}`);
    }
    return { pipeline: { workers: 2, dailyQuotaPerChannel: 5, scrapeIntervalHours: 3 } };
  }

  _loadState() {
    try {
      if (fs.existsSync(this.statePath)) {
        const raw = fs.readFileSync(this.statePath, 'utf8');
        return JSON.parse(raw);
      }
    } catch (e) {
      console.warn(`${LOG_PREFIX} State file unreadable, initializing clean state: ${e.message}`);
    }
    return {
      publishedLedger: {},
      dailyUploadCounts: {},
      roundRobinIndex: 0,
      lastScrapeTimestamp: null
    };
  }

  _saveState() {
    try {
      fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), 'utf8');
    } catch (e) {
      console.error(`${LOG_PREFIX} Failed to save state: ${e.message}`);
    }
  }

  getTodayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  getDailyUploadCount(channelKey) {
    const today = this.getTodayKey();
    if (!this.state.dailyUploadCounts[today]) {
      this.state.dailyUploadCounts[today] = {};
    }
    return this.state.dailyUploadCounts[today][channelKey] || 0;
  }

  incrementDailyUploadCount(channelKey) {
    const today = this.getTodayKey();
    if (!this.state.dailyUploadCounts[today]) {
      this.state.dailyUploadCounts[today] = {};
    }
    this.state.dailyUploadCounts[today][channelKey] = (this.state.dailyUploadCounts[today][channelKey] || 0) + 1;
    this._saveState();
  }

  isDailyQuotaReached(channelKey) {
    return this.getDailyUploadCount(channelKey) >= this.dailyQuotaPerChannel;
  }

  getMediaId(item, channelKey) {
    const postUrl = item.post_url || '';
    const title = (item.title || '').trim().toLowerCase();
    return crypto.createHash('sha256').update(`${channelKey}:${postUrl}:${title}`).digest('hex').substring(0, 16);
  }

  isDuplicate(item, channelKey) {
    const mediaId = this.getMediaId(item, channelKey);
    if (this.state.publishedLedger[mediaId]) return true;

    // Check if post_url already in ledger for this channel
    for (const entry of Object.values(this.state.publishedLedger)) {
      if (entry.channelKey === channelKey && entry.post_url && entry.post_url === item.post_url) {
        return true;
      }
    }
    return false;
  }

  recordPublished(item, channelKey, metadata = {}) {
    const mediaId = this.getMediaId(item, channelKey);
    this.state.publishedLedger[mediaId] = {
      mediaId,
      channelKey,
      chatId: CHANNEL_DEFS[channelKey].chatId,
      title: item.title,
      post_url: item.post_url,
      timestamp: new Date().toISOString(),
      date: this.getTodayKey(),
      ...metadata
    };
    this.incrementDailyUploadCount(channelKey);
    this._saveState();
  }

  recordSkipped(item, channelKey, reason = 'skipped') {
    const mediaId = this.getMediaId(item, channelKey);
    this.state.publishedLedger[mediaId] = {
      mediaId,
      channelKey,
      chatId: CHANNEL_DEFS[channelKey].chatId,
      title: item.title,
      post_url: item.post_url,
      timestamp: new Date().toISOString(),
      date: this.getTodayKey(),
      skipped: true,
      reason
    };
    this._saveState();
  }

  _getOrInitUploader() {
    if (this.uploader) return this.uploader;
    if (this._mtprotoUploader) return this._mtprotoUploader;

    const sessionStr = process.env.TELEGRAM_SESSION_STRING || process.env.VIP_FORWARDER_SESSION;
    const apiId = process.env.TELEGRAM_API_ID;
    const apiHash = process.env.TELEGRAM_API_HASH;

    if (sessionStr && apiId && apiHash) {
      try {
        const { MtprotoVideoUploader } = require('../video_pipeline/mtproto_video_uploader');
        this._mtprotoUploader = new MtprotoVideoUploader({
          apiId: apiId,
          apiHash: apiHash,
          sessionString: sessionStr,
          uploadWorkers: 2
        });
        return this._mtprotoUploader;
      } catch (err) {
        console.warn(`${LOG_PREFIX} MTProtoVideoUploader could not be initialized: ${err.message}`);
      }
    }
    return null;
  }

  _resolvePythonRunner() {
    if (this._cachedPythonRunner) {
      return this._cachedPythonRunner;
    }

    // 1. Check if uv is in PATH or known location
    const uvCandidates = [
      process.env.UV_PATH,
      '/root/.cargo/bin/uv',
      '/root/.local/bin/uv',
      '/usr/local/bin/uv',
      '/usr/bin/uv'
    ].filter(Boolean);

    for (const p of uvCandidates) {
      if (fs.existsSync(p)) {
        this._cachedPythonRunner = { cmd: p, prefixArgs: ['run', 'python'] };
        return this._cachedPythonRunner;
      }
    }

    // 2. Check virtualenvs
    const venvPythonCandidates = [
      process.env.PYTHON_PATH,
      '/opt/nexahub-bot/.venv/bin/python',
      '/opt/nexahub-bot/.venv/bin/python3',
      '/opt/nexahub-bot/venv/bin/python',
      path.resolve(__dirname, '..', '.venv', 'bin', 'python'),
      path.resolve(__dirname, '..', '.venv', 'Scripts', 'python.exe'),
      path.resolve(__dirname, '.venv', 'bin', 'python'),
      path.resolve(__dirname, '.venv', 'Scripts', 'python.exe'),
    ].filter(Boolean);

    for (const p of venvPythonCandidates) {
      if (fs.existsSync(p)) {
        this._cachedPythonRunner = { cmd: p, prefixArgs: [] };
        return this._cachedPythonRunner;
      }
    }

    // 3. Fallback to system python3 or python
    const isWin = process.platform === 'win32';
    this._cachedPythonRunner = { cmd: isWin ? 'python' : 'python3', prefixArgs: [] };
    return this._cachedPythonRunner;
  }

  /**
   * Executes a scraper script via python
   */
  async runScraper(channelKey, { pages = 1, refresh = true } = {}) {
    const def = CHANNEL_DEFS[channelKey];
    if (!def) throw new Error(`Unknown channel key: ${channelKey}`);

    console.log(`\n🔍 ${LOG_PREFIX} [${def.tag}] Launching scraper: ${def.scraperScript} (Pages: 1..${pages}, refresh: ${refresh})`);

    const runner = this._resolvePythonRunner();
    const scriptPath = path.join(this.scrapersDir, def.scraperScript);
    const args = [...runner.prefixArgs, scriptPath, '--start', '1', '--end', String(pages)];
    if (refresh) args.push('--refresh');

    return new Promise((resolve, reject) => {
      const proc = spawn(runner.cmd, args, {
        cwd: this.scrapersDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32'
      });

      let stdout = '';
      let stderr = '';

      proc.on('error', err => {
        reject(new Error(`Failed to spawn ${runner.cmd}: ${err.message}`));
      });

      proc.stdout.on('data', d => {
        const text = d.toString();
        stdout += text;
        process.stdout.write(text);
      });

      proc.stderr.on('data', d => {
        const text = d.toString();
        stderr += text;
        process.stderr.write(text);
      });

      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error(`Scraper timed out for ${def.tag}`));
      }, 10 * 60 * 1000);

      proc.on('close', code => {
        clearTimeout(timer);
        if (code === 0) {
          console.log(`✅ ${LOG_PREFIX} [${def.tag}] Scraper finished successfully.`);
          resolve({ stdout, stderr });
        } else {
          console.error(`❌ ${LOG_PREFIX} [${def.tag}] Scraper exited with code ${code}`);
          resolve({ stdout, stderr, error: `Exited with code ${code}` });
        }
      });
    });
  }

  /**
   * Runs all 6 scrapers sequentially or in controlled parallel
   */
  async runAllScrapers({ pages = 1, refresh = true } = {}) {
    console.log(`\n=======================================================`);
    console.log(`🌐 ${LOG_PREFIX} Starting 3-Hour Scraper Refresh for ALL 6 Channels`);
    console.log(`=======================================================`);

    for (const key of this.roundRobinOrder) {
      try {
        await this.runScraper(key, { pages, refresh });
      } catch (err) {
        console.error(`❌ ${LOG_PREFIX} Scraper error for ${key}: ${err.message}`);
      }
    }
    this.state.lastScrapeTimestamp = new Date().toISOString();
    this._saveState();
    console.log(`\n✨ ${LOG_PREFIX} All 6 Scrapers refreshed at ${this.state.lastScrapeTimestamp}`);
  }

  /**
   * Loads candidate videos from category JSON and returns the next eligible un-uploaded video.
   */
  getNextEligibleVideo(channelKey) {
    if (this.isDailyQuotaReached(channelKey)) {
      return null;
    }

    const def = CHANNEL_DEFS[channelKey];
    const jsonPath = path.join(this.scrapersDir, def.jsonFile);

    if (!fs.existsSync(jsonPath)) return null;

    try {
      const items = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      // Pick newest first
      const reversed = [...items].reverse();

      for (const item of reversed) {
        const url = item.mp4_download_url || item.stream_url || item.video_url || (Array.isArray(item.video_urls) ? item.video_urls[0] : null);
        if (!url) continue;
        item.mp4_download_url = url;
        if (!this.isDuplicate(item, channelKey)) {
          return item;
        }
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} Error reading ${def.jsonFile}: ${err.message}`);
    }
    return null;
  }

  /**
   * Downloads a single video item using the category downloader script
   */
  async downloadVideo(item, channelKey) {
    const def = CHANNEL_DEFS[channelKey];
    const targetDir = path.join(this.scrapersDir, def.downloadDir);
    fs.mkdirSync(targetDir, { recursive: true });

    // Snapshot existing files to detect the newly downloaded file
    const beforeFiles = new Set(fs.readdirSync(targetDir));

    console.log(`\n📥 ${LOG_PREFIX} [${def.tag}] Downloading: "${item.title}"`);
    const tempJsonPath = path.join(this.scrapersDir, `_temp_${channelKey}_task.json`);
    fs.writeFileSync(tempJsonPath, JSON.stringify([item]), 'utf8');

    const runner = this._resolvePythonRunner();
    const scriptPath = path.join(this.scrapersDir, def.downloaderScript);
    const args = [...runner.prefixArgs, scriptPath, '--json', tempJsonPath, '--limit', '1'];

    return new Promise((resolve) => {
      const proc = spawn(runner.cmd, args, {
        cwd: this.scrapersDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32'
      });

      let stdout = '';
      let stderr = '';

      proc.on('error', err => {
        if (fs.existsSync(tempJsonPath)) fs.unlinkSync(tempJsonPath);
        console.warn(`${LOG_PREFIX} Failed to spawn ${runner.cmd}: ${err.message}`);
        resolve({ success: false, reason: `spawn_error: ${err.message}` });
      });

      proc.stdout.on('data', d => {
        const text = d.toString();
        stdout += text;
        process.stdout.write(text);
      });
      proc.stderr.on('data', d => {
        const text = d.toString();
        stderr += text;
        process.stderr.write(text);
      });

      const timer = setTimeout(() => {
        proc.kill();
        if (fs.existsSync(tempJsonPath)) fs.unlinkSync(tempJsonPath);
        console.warn(`${LOG_PREFIX} Download timeout for "${item.title}"`);
        resolve({ success: false, reason: 'download_timeout' });
      }, 20 * 60 * 1000);

      proc.on('close', code => {
        clearTimeout(timer);
        if (fs.existsSync(tempJsonPath)) fs.unlinkSync(tempJsonPath);

        if (stdout.includes('[!] [Skipped]') || stdout.includes('exceeds Telegram')) {
          console.log(`⏩ ${LOG_PREFIX} [${def.tag}] Video "${item.title}" skipped: exceeds Telegram 1.95GB limit.`);
          resolve({ skipped: true, reason: 'exceeds_telegram_1.95gb_limit' });
          return;
        }

        const afterFiles = fs.readdirSync(targetDir);
        const newFiles = afterFiles.filter(f => !beforeFiles.has(f) && f.endsWith('.mp4'));

        let downloadedFile = null;
        if (newFiles.length > 0) {
          downloadedFile = path.join(targetDir, newFiles[0]);
        } else {
          // Find most recently modified .mp4 in targetDir
          const mp4s = afterFiles.filter(f => f.endsWith('.mp4')).map(f => {
            const full = path.join(targetDir, f);
            return { path: full, mtime: fs.statSync(full).mtimeMs, size: fs.statSync(full).size };
          }).sort((a, b) => b.mtime - a.mtime);

          if (mp4s.length > 0 && mp4s[0].size > 10 * 1024) {
            downloadedFile = mp4s[0].path;
          }
        }

        if (downloadedFile && fs.existsSync(downloadedFile) && fs.statSync(downloadedFile).size > 10 * 1024) {
          console.log(`✅ ${LOG_PREFIX} [${def.tag}] Download complete: ${path.basename(downloadedFile)} (${(fs.statSync(downloadedFile).size / (1024*1024)).toFixed(1)} MB)`);
          resolve({ success: true, filePath: downloadedFile });
        } else {
          resolve({ success: false, reason: 'file_not_downloaded_or_empty', stdout, stderr });
        }
      });
    });
  }

  /**
   * Uploads the downloaded video to Telegram channel and deletes it immediately
   */
  async uploadAndPublish(item, channelKey, filePath) {
    const def = CHANNEL_DEFS[channelKey];
    console.log(`\n🚀 ${LOG_PREFIX} [${def.tag}] Uploading to Telegram Channel: ${def.chatId} (${def.tag})`);
    console.log(`   📌 Title: ${item.title}`);
    console.log(`   📁 File:  ${path.basename(filePath)}`);

    if (this.dryRun) {
      console.log(`   [DRY-RUN] Simulating upload of ${path.basename(filePath)} to ${def.chatId}`);
      this.recordPublished(item, channelKey, { dryRun: true });
      this._deleteFileSafely(filePath);
      return { success: true, dryRun: true };
    }

    const uploader = this._getOrInitUploader();
    if (!uploader) {
      throw new Error(`No Telegram MTProto Uploader available in environment! Check TELEGRAM_SESSION_STRING.`);
    }

    try {
      const fileSize = fs.statSync(filePath).size;
      const cleanTitle = item.title || '신규 동영상';

      const result = await uploader.publish({
        destinationId: def.chatId,
        chatId: def.chatId,
        filePath: filePath,
        caption: cleanTitle,
        title: cleanTitle,
        expectedSizeBytes: fileSize
      });

      console.log(`🎉 ${LOG_PREFIX} [${def.tag}] Successfully uploaded to ${def.chatId}!`);
      this.recordPublished(item, channelKey, {
        fileSize,
        telegramMessageId: result && result.messageId
      });

      // Immediate file deletion
      this._deleteFileSafely(filePath);
      return { success: true, result };
    } catch (err) {
      console.error(`❌ ${LOG_PREFIX} [${def.tag}] Upload failed: ${err.message}`);
      throw err;
    }
  }

  _deleteFileSafely(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`🗑️ ${LOG_PREFIX} Deleted local video: ${path.basename(filePath)}`);
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} Could not delete file ${filePath}: ${err.message}`);
    }
  }

  /**
   * Process 1 video for a specific channel with automatic candidate progression
   */
  async processChannel(channelKey) {
    const def = CHANNEL_DEFS[channelKey];
    const todayCount = this.getDailyUploadCount(channelKey);

    if (todayCount >= this.dailyQuotaPerChannel) {
      return { channelKey, status: 'QUOTA_REACHED', count: todayCount };
    }

    // Try up to 5 eligible candidates for this channel per cycle
    for (let candidateAttempt = 0; candidateAttempt < 5; candidateAttempt++) {
      let item = this.getNextEligibleVideo(channelKey);
      if (!item && candidateAttempt === 0) {
        console.log(`🔍 ${LOG_PREFIX} [${def.tag}] No pending fresh links in queue. Scraping new links...`);
        await this.runScraper(channelKey, { pages: 1, refresh: true });
        item = this.getNextEligibleVideo(channelKey);
      }

      if (!item) {
        return { channelKey, status: 'QUEUE_EMPTY', count: todayCount };
      }

      let targetItem = item;
      try {
        const downloadResult = await this.downloadVideo(targetItem, channelKey);

        if (downloadResult && downloadResult.skipped) {
          this.recordSkipped(targetItem, channelKey, downloadResult.reason);
          console.log(`⏩ ${LOG_PREFIX} [${def.tag}] Candidate skipped (${downloadResult.reason}). Fetching next eligible video...`);
          continue;
        }

        if (!downloadResult || !downloadResult.success || !downloadResult.filePath) {
          const reason = (downloadResult && downloadResult.reason) || 'download_failed';
          console.warn(`⚠️ ${LOG_PREFIX} [${def.tag}] Candidate "${targetItem.title}" download failed (${reason}). Marking skipped and trying next video...`);
          this.recordSkipped(targetItem, channelKey, reason);
          continue;
        }

        await this.uploadAndPublish(targetItem, channelKey, downloadResult.filePath);
        return { channelKey, status: 'PUBLISHED', title: targetItem.title };
      } catch (err) {
        console.error(`❌ ${LOG_PREFIX} [${def.tag}] Pipeline error for "${targetItem.title}": ${err.message}`);
        this.recordSkipped(targetItem, channelKey, `error: ${err.message}`);
        continue;
      }
    }
    return { channelKey, status: 'QUEUE_EMPTY', count: todayCount };
  }

  /**
   * Executes 1 round-robin step with 2 worker concurrency
   */
  async executeRoundRobinStep() {
    console.log(`\n=======================================================`);
    console.log(`🔄 ${LOG_PREFIX} Round-Robin Pipeline Dispatch (Workers: ${this.maxWorkers})`);
    console.log(`   Daily Quota Status:`);
    for (const key of this.roundRobinOrder) {
      console.log(`     • ${CHANNEL_DEFS[key].tag.padEnd(8)}: ${this.getDailyUploadCount(key)}/${this.dailyQuotaPerChannel} uploads today`);
    }
    console.log(`=======================================================`);

    // Select candidate channels that have not reached quota
    const candidateChannels = [];
    const totalOrder = this.roundRobinOrder.length;

    for (let i = 0; i < totalOrder; i++) {
      const idx = (this.state.roundRobinIndex + i) % totalOrder;
      const channelKey = this.roundRobinOrder[idx];
      if (!this.isDailyQuotaReached(channelKey)) {
        candidateChannels.push(channelKey);
        if (candidateChannels.length >= this.maxWorkers) break;
      }
    }

    if (candidateChannels.length === 0) {
      console.log(`ℹ️ ${LOG_PREFIX} All channels reached daily quota (${this.dailyQuotaPerChannel}/day) or queues empty. Sleeping.`);
      return { processed: 0, status: 'IDLE' };
    }

    console.log(`⚡ ${LOG_PREFIX} Dispatching ${candidateChannels.length} parallel worker(s): [${candidateChannels.join(', ')}]`);

    // Advance round-robin pointer
    this.state.roundRobinIndex = (this.state.roundRobinIndex + candidateChannels.length) % totalOrder;
    this._saveState();

    // Execute concurrently using Promise.all up to maxWorkers (2)
    const results = await Promise.all(
      candidateChannels.map(key => this.processChannel(key))
    );

    console.log(`📊 ${LOG_PREFIX} Round step results:`, results);
    return { processed: results.length, results };
  }

  /**
   * Cleanup daemon: Deletes any files in downloads older than threshold hours
   */
  cleanupOldDownloads(thresholdHours = 1) {
    const maxAgeMs = thresholdHours * 60 * 60 * 1000;
    const now = Date.now();
    let deletedCount = 0;

    for (const def of Object.values(CHANNEL_DEFS)) {
      const dir = path.join(this.scrapersDir, def.downloadDir);
      if (!fs.existsSync(dir)) continue;

      const files = fs.readdirSync(dir);
      for (const f of files) {
        const fullPath = path.join(dir, f);
        try {
          const stats = fs.statSync(fullPath);
          if (stats.isFile() && (now - stats.mtimeMs) > maxAgeMs) {
            fs.unlinkSync(fullPath);
            deletedCount++;
            console.log(`🧹 ${LOG_PREFIX} Auto-cleanup removed stale file: ${def.tag}/${f}`);
          }
        } catch (e) {}
      }
    }
    return deletedCount;
  }
}

module.exports = {
  VipPipelineOrchestrator,
  CHANNEL_DEFS,
  CONFIG_PATH,
  STATE_PATH
};

if (require.main === module) {
  const orchestrator = new VipPipelineOrchestrator();
  const args = process.argv.slice(2);

  if (args.includes('--scrape-all')) {
    orchestrator.runAllScrapers({ pages: 1, refresh: true })
      .then(() => process.exit(0))
      .catch(e => { console.error(e); process.exit(1); });
  } else if (args.includes('--step')) {
    orchestrator.executeRoundRobinStep()
      .then(() => process.exit(0))
      .catch(e => { console.error(e); process.exit(1); });
  } else if (args.includes('--cleanup')) {
    const count = orchestrator.cleanupOldDownloads(1);
    console.log(`Cleaned ${count} files.`);
    process.exit(0);
  } else {
    console.log(`VIP Pipeline Orchestrator loaded. Run with --scrape-all or --step`);
  }
}
