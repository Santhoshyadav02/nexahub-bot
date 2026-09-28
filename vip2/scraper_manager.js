/**
 * ============================================================
 * 🕷️ VIP-2 SCRAPERS & AUTO-UPLOADER ENGINE (BJ & AV)
 * ============================================================
 * - Automatically executes BJ and AV scrapers & downloaders
 * - Daily quota: 5-7 videos per category
 * - Uploads native MP4 videos to:
 *   1. Channel: V.I.P 정보공유 (-1004361683750)
 *   2. Discussion: V.I.P 정보공유 chat (-1004442518512)
 *   3. Group: >> V.I.P 정보공유 << (-1003983458986)
 * - Updates @VIP_2211bot catalog
 * - Auto-cleans downloaded local MP4 files post-upload
 * - Deduplication tracking in scraper_published.json
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '.env') });

const SCRAPERS_DIR = path.resolve(__dirname, 'scrapers');
const PUBLISHED_PATH = path.resolve(__dirname, 'scraper_published.json');
const DOWNLOADS_DIR = path.resolve(__dirname, 'downloads');

class Vip2ScraperManager {
  constructor(pipeline = null) {
    this.pipeline = pipeline;
    this.scrapersDir = SCRAPERS_DIR;
    this.publishedUrls = this._loadPublishedUrls();
    this.isProcessing = false;
    this.quotaPerRun = 5; // 5 videos per category per cycle
  }

  _loadPublishedUrls() {
    try {
      if (fs.existsSync(PUBLISHED_PATH)) {
        const data = JSON.parse(fs.readFileSync(PUBLISHED_PATH, 'utf8'));
        return new Set(data);
      }
    } catch (e) {
      console.warn('⚠️ [VIP2_SCRAPER] Could not load published URLs:', e.message);
    }
    return new Set();
  }

  _savePublishedUrls() {
    try {
      const arr = Array.from(this.publishedUrls).slice(-5000);
      fs.writeFileSync(PUBLISHED_PATH, JSON.stringify(arr, null, 2), 'utf8');
    } catch (e) {
      console.error('❌ [VIP2_SCRAPER] Failed to save published URLs:', e.message);
    }
  }

  /**
   * Runs Python scraper to refresh video links
   */
  async runPythonScraper(category = 'BJ') {
    const script = category.toUpperCase() === 'AV' ? 'av_scraper.py' : 'bj_scraper.py';
    const scriptPath = path.resolve(this.scrapersDir, script);

    if (!fs.existsSync(scriptPath)) {
      console.warn(`⚠️ [VIP2_SCRAPER] ${scriptPath} not found.`);
      return false;
    }

    console.log(`🕷️ [VIP2_SCRAPER] Running ${script}...`);
    return new Promise((resolve) => {
      const pyCmd = process.platform === 'win32' ? 'python' : 'python3';
      const proc = spawn(pyCmd, [script], {
        cwd: this.scrapersDir,
        timeout: 180000
      });

      proc.stdout.on('data', d => process.stdout.write(`[${category}] ${d}`));
      proc.stderr.on('data', d => process.stderr.write(`[${category}_ERR] ${d}`));

      proc.on('close', (code) => {
        console.log(`✅ [VIP2_SCRAPER] ${script} finished with code ${code}`);
        resolve(code === 0);
      });
      proc.on('error', (err) => {
        console.warn(`⚠️ [VIP2_SCRAPER] Error running ${script}:`, err.message);
        resolve(false);
      });
    });
  }

  getScrapedItems(category = 'BJ') {
    const jsonName = category.toUpperCase() === 'AV' ? 'av_videos.json' : 'bj_videos.json';
    const jsonPath = path.resolve(this.scrapersDir, jsonName);

    try {
      if (fs.existsSync(jsonPath)) {
        return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      }
    } catch (e) {
      console.error(`❌ [VIP2_SCRAPER] Error reading ${jsonName}:`, e.message);
    }
    return [];
  }

  /**
   * Fast stream downloader for MP4 with retry and timeout
   */
  async downloadFile(url, destPath, maxRetries = 3) {
    if (!fs.existsSync(path.dirname(destPath))) {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
    }

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Referer': 'https://02.avsee.is/'
    };

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`⬇️ [VIP2_DOWNLOAD] Downloading (attempt ${attempt}): ${path.basename(destPath)}...`);
        await new Promise((resolve, reject) => {
          const fileStream = fs.createWriteStream(destPath);
          const reqModule = url.startsWith('https') ? https : http;
          
          const req = reqModule.get(url, { headers, timeout: 60000 }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              return this.downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200 && res.statusCode !== 206) {
              return reject(new Error(`HTTP status ${res.statusCode}`));
            }

            res.pipe(fileStream);
            fileStream.on('finish', () => {
              fileStream.close();
              resolve();
            });
            fileStream.on('error', reject);
          });

          req.on('error', reject);
          req.on('timeout', () => {
            req.destroy();
            reject(new Error('Download timeout'));
          });
        });

        const stats = fs.statSync(destPath);
        if (stats.size > 1024 * 100) { // at least 100KB
          console.log(`✅ [VIP2_DOWNLOAD] Download complete: ${(stats.size / (1024 * 1024)).toFixed(1)} MB`);
          return true;
        }
      } catch (err) {
        console.warn(`⚠️ [VIP2_DOWNLOAD] Download attempt ${attempt} failed:`, err.message);
        if (fs.existsSync(destPath)) {
          try { fs.unlinkSync(destPath); } catch (_) {}
        }
        await new Promise(r => setTimeout(r, 3000));
      }
    }
    return false;
  }

  /**
   * Process, download, and publish 5-7 videos for a given category (BJ or AV)
   */
  async processAndPublishCategory(category = 'BJ', limit = 5) {
    if (!this.pipeline) {
      console.warn('⚠️ [VIP2_SCRAPER] Pipeline not connected.');
      return { count: 0, status: 'no_pipeline' };
    }

    const items = this.getScrapedItems(category);
    if (!items || items.length === 0) {
      console.log(`ℹ️ [VIP2_SCRAPER] No items in ${category} JSON. Refreshing scraper...`);
      await this.runPythonScraper(category);
    }

    const freshItems = this.getScrapedItems(category);
    const pending = freshItems.filter(item => {
      const key = item.post_url || item.mp4_download_url || item.title;
      return key && !this.publishedUrls.has(key);
    });

    console.log(`📦 [VIP2_SCRAPER] [${category}] Found ${pending.length} unpublished videos (target: ${limit}).`);

    let publishedCount = 0;
    const toProcess = pending.slice(0, limit);

    for (const item of toProcess) {
      const itemKey = item.post_url || item.mp4_download_url || item.title;
      const cleanTitle = (item.title || `${category} 고화질 영상`).replace(/\s+/g, ' ').trim();
      const safeName = cleanTitle.replace(/[\\/*?:"<>|]/g, '').substring(0, 50);
      const tempPath = path.resolve(DOWNLOADS_DIR, `${category.toLowerCase()}_${Date.now()}_${safeName}.mp4`);

      try {
        if (!item.mp4_download_url) {
          console.log(`[-] Skipped '${cleanTitle}' - No MP4 URL.`);
          this.publishedUrls.add(itemKey);
          this._savePublishedUrls();
          continue;
        }

        // 1. Download MP4
        const downloaded = await this.downloadFile(item.mp4_download_url, tempPath);
        if (!downloaded || !fs.existsSync(tempPath)) {
          console.warn(`❌ [VIP2_SCRAPER] Failed to download video: ${cleanTitle}`);
          continue;
        }

        // 2. Format Korean Caption
        const categoryTag = category.toUpperCase() === 'AV' ? '#VIP #AV #고화질 #자막' : '#VIP #BJ #고화질 #한국BJ';
        const formattedCaption = `👑 <b>V.I.P 정보공유 (${category.toUpperCase()} 전용)</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `🏷️ <code>${categoryTag}</code>\n\n` +
          `🎬 <b>${cleanTitle}</b>\n\n` +
          `👉 <b><a href="${this.pipeline.destInviteLink}">V.I.P 정보공유 채널 입장하기 ↗️</a></b>\n` +
          `💬 <b>전체 풀버전 영상은 아래 [댓글 / Leave a comment]에서 확인하세요! ⬇️</b>`;

        await this.pipeline.init();

        // 3. Upload to Primary Channel (V.I.P 정보공유 / -1004361683750)
        console.log(`📤 [VIP2_SCRAPER] Uploading ${category} video to Channel: "${cleanTitle}"...`);
        const sentChan = await this.pipeline.client.sendFile(this.pipeline.destChatId, {
          file: tempPath,
          caption: formattedCaption,
          parseMode: 'html',
          forceDocument: false
        });

        if (sentChan) {
          const pubId = Array.isArray(sentChan) ? sentChan[0].id : sentChan.id;
          const cleanChatId = String(this.pipeline.destChatId).replace(/^-100/, '').replace(/^-/, '');
          const postLink = `https://t.me/c/${cleanChatId}/${pubId}`;

          console.log(`✅ [VIP2_SCRAPER] Published to Channel: ${postLink}`);

          // 4. Send Confirmation into Discussion Thread (-1004442518512)
          const discRootId = await this.pipeline._findDiscussionRootMsgId(pubId);
          if (discRootId) {
            await this.pipeline.client.sendMessage(this.pipeline.discussionChatId, {
              message: `🎬 <b>[${category.toUpperCase()} 풀버전 고화질 영상]</b> 정상 등록되었습니다. 편안하게 시청하세요! 👑`,
              replyTo: discRootId,
              parseMode: 'html'
            });
            console.log(`💬 [VIP2_SCRAPER] Discussion thread linked.`);
          }

          // 5. Broadcast to Extra Group (>> V.I.P 정보공유 << / -1003983458986)
          for (const extraChat of this.pipeline.extraDestChats) {
            try {
              await this.pipeline.client.sendFile(extraChat, {
                file: tempPath,
                caption: formattedCaption,
                parseMode: 'html',
                forceDocument: false
              });
              console.log(`📢 [VIP2_SCRAPER] Broadcasted to Group (${extraChat})!`);
            } catch (extraErr) {
              console.warn(`⚠️ [VIP2_SCRAPER] Failed to broadcast to ${extraChat}:`, extraErr.message);
            }
          }

          // 6. Update Catalog & Deduplication
          this.pipeline.catalogManager.addVideo({
            messageId: pubId,
            title: `[${category.toUpperCase()}] ${cleanTitle}`,
            link: postLink,
            date: new Date().toISOString()
          });

          this.publishedUrls.add(itemKey);
          this._savePublishedUrls();
          publishedCount++;

          // 7. Delete local file post-upload
          if (fs.existsSync(tempPath)) {
            try {
              fs.unlinkSync(tempPath);
              console.log(`🧹 [VIP2_SCRAPER] Cleaned up temporary local file.`);
            } catch (_) {}
          }

          // Rate-limit delay
          await new Promise(r => setTimeout(r, 4000));
        }
      } catch (uploadErr) {
        console.error(`❌ [VIP2_SCRAPER] Upload error for "${cleanTitle}":`, uploadErr.message);
        if (fs.existsSync(tempPath)) {
          try { fs.unlinkSync(tempPath); } catch (_) {}
        }
      }
    }

    console.log(`🎉 [VIP2_SCRAPER] [${category}] Finished cycle. Published: ${publishedCount} video(s).`);
    return { count: publishedCount, status: 'success' };
  }

  /**
   * Periodic scraper scheduler (Runs every 4 hours to download 5-7 BJ and AV videos)
   */
  startPeriodicScraper(intervalHours = 4) {
    if (this.scraperTimer) clearInterval(this.scraperTimer);
    const ms = Math.max(1, intervalHours) * 60 * 60 * 1000;

    console.log(`⏰ [VIP2_SCRAPER] Periodic scraper scheduled every ${intervalHours} hour(s).`);

    // Initial run after 1 minute warmup
    setTimeout(async () => {
      console.log('🚀 [VIP2_SCRAPER] Running initial BJ & AV auto-publish cycle...');
      await this.processAndPublishCategory('BJ', 5);
      await this.processAndPublishCategory('AV', 5);
    }, 60000);

    this.scraperTimer = setInterval(async () => {
      console.log(`\n⏰ [VIP2_SCRAPER] Scheduled cycle triggered. Processing BJ & AV...`);
      await this.processAndPublishCategory('BJ', 5);
      await this.processAndPublishCategory('AV', 5);
    }, ms);
  }

  stop() {
    if (this.scraperTimer) {
      clearInterval(this.scraperTimer);
      this.scraperTimer = null;
    }
  }
}

module.exports = {
  Vip2ScraperManager
};
