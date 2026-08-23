const fs = require('fs');
const https = require('https');
const path = require('path');

const RANKING_FILE = path.join(__dirname, 'ranking.json');
const RANKING_REFRESH_INTERVAL_MS = parseInt(process.env.RANKING_REFRESH_INTERVAL_MS, 10) || (5 * 60 * 1000); // 5 minutes default
const SIGNAL_API_URL = "https://api.signal.bz/news/realtime";

/**
 * Reads local ranking.json file safely.
 */
function getLocalRankings() {
  try {
    if (fs.existsSync(RANKING_FILE)) {
      const raw = fs.readFileSync(RANKING_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.rankings) && data.rankings.length === 10) {
        return data;
      }
    }
  } catch (err) {
    console.error("⚠️ Error reading local ranking.json:", err.message);
  }
  return null;
}

/**
 * Validates array of 10 ranking items.
 */
function validateRankings(rankings) {
  if (!Array.isArray(rankings) || rankings.length < 10) {
    return false;
  }
  for (let i = 0; i < 10; i++) {
    const item = rankings[i];
    if (!item || typeof item !== 'object') return false;
    if (typeof item.rank !== 'number' || item.rank < 1 || item.rank > 10) return false;
    if (typeof item.keyword !== 'string' || item.keyword.trim().length === 0) return false;
    if (typeof item.url !== 'string' || !item.url.startsWith('http')) return false;
    if (item.keyword.includes('[object Object]') || item.url.includes('[object Object]')) return false;
  }
  return true;
}

/**
 * Fetches JSON data over HTTPS with timeout.
 */
function fetchJSON(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*"
      },
      timeout: timeoutMs
    }, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP Status ${res.statusCode}`));
      }
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          resolve(parsed);
        } catch (e) {
          reject(new Error("Malformed JSON response"));
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
  });
}

/**
 * Scrapes Real-Time Korean Top 10 Search Rankings.
 * Uses atomic file write and last-known-good fallback on failure.
 */
async function scrapeRealtimeRankings() {
  console.log("🔥 [Ranking] Fetching latest Korean real-time Top 10 rankings...");
  
  try {
    const data = await fetchJSON(SIGNAL_API_URL, 8000);
    if (!data || !Array.isArray(data.top10) || data.top10.length < 10) {
      throw new Error("Invalid or incomplete Top 10 data from API");
    }

    const cleanRankings = [];
    for (let i = 0; i < 10; i++) {
      const raw = data.top10[i];
      if (!raw || !raw.keyword) continue;

      const keyword = String(raw.keyword).trim();
      const rank = i + 1;
      const searchUrl = `https://search.naver.com/search.naver?where=nexearch&sm=top_hty&fbm=0&ie=utf8&query=${encodeURIComponent(keyword)}`;

      cleanRankings.push({
        rank: rank,
        keyword: keyword,
        url: searchUrl
      });
    }

    if (!validateRankings(cleanRankings)) {
      throw new Error("Rankings failed strict Top 10 validation");
    }

    const payload = {
      updatedAt: new Date().toISOString(),
      source: "signal.bz",
      rankings: cleanRankings
    };

    // Atomic write
    const tempFile = `${RANKING_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tempFile, RANKING_FILE);

    console.log(`✅ [Ranking] Successfully fetched and updated 10 rankings in ranking.json`);
    return payload;

  } catch (err) {
    console.error(`⚠️ [Ranking] Fetch failed: ${err.message}. Keeping previous valid ranking data.`);
    const fallback = getLocalRankings();
    if (fallback) {
      console.log(`ℹ️ [Ranking] Using existing valid ranking.json fallback (${fallback.rankings.length} items)`);
      return fallback;
    }
    return null;
  }
}

/**
 * Starts continuous background polling for rankings.
 */
function startRankingScheduler() {
  console.log(`⏱️ [Ranking] Starting scheduler (refresh interval: ${RANKING_REFRESH_INTERVAL_MS / 1000}s)...`);
  scrapeRealtimeRankings().catch(err => console.error("Initial ranking scrape error:", err.message));
  setInterval(() => {
    scrapeRealtimeRankings().catch(err => console.error("Scheduled ranking scrape error:", err.message));
  }, RANKING_REFRESH_INTERVAL_MS);
}

module.exports = {
  scrapeRealtimeRankings,
  getLocalRankings,
  startRankingScheduler,
  validateRankings,
  RANKING_REFRESH_INTERVAL_MS
};
