/**
 * ============================================================
 * 🎬 VIP-2 SCRAPERS MANAGER (BJ & AV ONLY)
 * ============================================================
 * Manages scraping, downloading, and publishing for:
 *   1. BJ  (bj_scraper.py, bj_downloader.py, bj_videos.json)
 *   2. AV  (av_scraper.py, av_downloader.py, av_videos.json)
 * 
 * Uploads scraped videos to V.I.P 정보공유 & >> V.I.P 정보공유 <<
 * and registers them in @VIP_2211bot catalog.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '.env') });

const SCRAPERS_DIR = path.resolve(__dirname, 'scrapers');
const STATE_PATH = path.resolve(__dirname, 'scraper_state.json');

class Vip2ScraperManager {
  constructor(pipeline = null) {
    this.pipeline = pipeline;
    this.scrapersDir = SCRAPERS_DIR;
    this.state = this._loadState();
    this.isScraping = false;
  }

  _loadState() {
    try {
      if (fs.existsSync(STATE_PATH)) {
        return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
      }
    } catch (e) {
      console.warn('⚠️ [VIP2_SCRAPER] Could not load state:', e.message);
    }
    return {
      publishedUrls: {},
      lastRun: { BJ: null, AV: null }
    };
  }

  _saveState() {
    try {
      fs.writeFileSync(STATE_PATH, JSON.stringify(this.state, null, 2), 'utf8');
    } catch (e) {
      console.error('❌ [VIP2_SCRAPER] Failed to save state:', e.message);
    }
  }

  /**
   * Runs Python scraper script with timeout
   */
  async runScraper(category = 'BJ') {
    const scriptName = category.toUpperCase() === 'AV' ? 'av_scraper.py' : 'bj_scraper.py';
    const scriptPath = path.resolve(this.scrapersDir, scriptName);

    if (!fs.existsSync(scriptPath)) {
      console.warn(`⚠️ [VIP2_SCRAPER] Script ${scriptPath} not found.`);
      return false;
    }

    console.log(`🕷️ [VIP2_SCRAPER] Running ${scriptName}...`);
    return new Promise((resolve) => {
      const proc = spawn('python3', [scriptPath], {
        cwd: this.scrapersDir,
        timeout: 180000 // 3 min
      });

      proc.stdout.on('data', d => process.stdout.write(`[${category}_SCRAPER] ${d}`));
      proc.stderr.on('data', d => process.stderr.write(`[${category}_SCRAPER_ERR] ${d}`));

      proc.on('close', (code) => {
        console.log(`✅ [VIP2_SCRAPER] ${scriptName} exited with code ${code}`);
        resolve(code === 0);
      });
      proc.on('error', (err) => {
        console.warn(`⚠️ [VIP2_SCRAPER] Error running ${scriptName} (trying python):`, err.message);
        // Fallback to 'python'
        const proc2 = spawn('python', [scriptPath], { cwd: this.scrapersDir, timeout: 180000 });
        proc2.on('close', (c) => resolve(c === 0));
        proc2.on('error', () => resolve(false));
      });
    });
  }

  /**
   * Reads scraped items from bj_videos.json / av_videos.json
   */
  getScrapedItems(category = 'BJ') {
    const jsonName = category.toUpperCase() === 'AV' ? 'av_videos.json' : 'bj_videos.json';
    const jsonPath = path.resolve(this.scrapersDir, jsonName);

    try {
      if (fs.existsSync(jsonPath)) {
        const raw = fs.readFileSync(jsonPath, 'utf8');
        return JSON.parse(raw);
      }
    } catch (e) {
      console.error(`❌ [VIP2_SCRAPER] Failed to read ${jsonName}:`, e.message);
    }
    return [];
  }

  /**
   * Returns catalog list for BJ or AV videos
   */
  getCategoryVideos(category = 'BJ', limit = 20) {
    const items = this.getScrapedItems(category);
    return items.slice(0, limit);
  }
}

module.exports = {
  Vip2ScraperManager
};
