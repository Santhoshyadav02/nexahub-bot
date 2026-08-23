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

function fetchText(url, extraHeaders = {}) {
  return new Promise(resolve => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        ...extraHeaders
      },
      timeout: 8000
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', () => resolve(''));
  });
}

/**
 * Decodes Google News RSS article URL base64 protobuf payload if needed.
 */
function decodeGoogleRssUrl(rssUrl) {
  try {
    const match = rssUrl.match(/articles\/([A-Za-z0-9_-]+)/);
    if (match && match[1]) {
      const b64 = match[1].replace(/-/g, '+').replace(/_/g, '/');
      const buf = Buffer.from(b64, 'base64');
      const str = buf.toString('latin1');
      const urlMatch = str.match(/https?:\/\/[a-zA-Z0-9_.~!*';:@&=+$,/?%#[\]-]+/);
      if (urlMatch && urlMatch[0] && !urlMatch[0].includes('google.com') && !urlMatch[0].includes('search.naver.com')) {
        return urlMatch[0];
      }
    }
  } catch (e) {}
  return null;
}

/**
 * Resolves the actual direct publisher article URL for a ranking keyword.
 * Strictly rejects search.naver.com, google.com/search, news.google.com/rss/articles, translate.google.com.
 */
async function getDirectArticleUrl(keyword) {
  // Method 1: Naver News Search (where=news) - extract direct Naver News Article or publisher article
  try {
    const naverNewsUrl = `https://search.naver.com/search.naver?where=news&query=${encodeURIComponent(keyword)}`;
    const html = await fetchText(naverNewsUrl);

    // 1a. Naver news article link (n.news.naver.com)
    const m1 = html.match(/href="(https?:\/\/n\.news\.naver\.com\/mnews\/article\/[^"]+)"/i);
    if (m1 && m1[1]) return m1[1].replace(/&amp;/g, '&');

    // 1b. Direct press news_tit link
    const m2 = html.match(/class="news_tit"[^>]*href="([^"]+)"/i);
    if (m2 && m2[1] && m2[1].startsWith('http') && !m2[1].includes('naver.com') && !m2[1].includes('google.com')) {
      return m2[1].replace(/&amp;/g, '&');
    }
  } catch (e) {}

  // Method 2: Naver Main Search (where=nexearch) - extract top organic search result link
  try {
    const naverMainUrl = `https://search.naver.com/search.naver?where=nexearch&query=${encodeURIComponent(keyword)}`;
    const html = await fetchText(naverMainUrl);

    const m3 = html.match(/class="link_tit"[^>]*href="([^"]+)"/i) ||
               html.match(/class="api_txt_lines total_tit"[^>]*href="([^"]+)"/i) ||
               html.match(/href="(https?:\/\/n\.news\.naver\.com\/mnews\/article\/[^"]+)"/i);
    if (m3 && m3[1] && m3[1].startsWith('http') && !m3[1].includes('search.naver.com') && !m3[1].includes('google.com')) {
      return m3[1].replace(/&amp;/g, '&');
    }
  } catch (e) {}

  // Method 3: Daum / Kakao News Search fallback
  try {
    const daumUrl = `https://search.daum.net/search?w=news&q=${encodeURIComponent(keyword)}`;
    const html = await fetchText(daumUrl);
    const m4 = html.match(/class="tit_main fn_tit_u"[^>]*href="([^"]+)"/i) ||
               html.match(/href="(https?:\/\/v\.daum\.net\/v\/[^"]+)"/i);
    if (m4 && m4[1] && m4[1].startsWith('http') && !m4[1].includes('google.com')) {
      return m4[1].replace(/&amp;/g, '&');
    }
  } catch (e) {}

  // Method 4: Google RSS decoded URL
  try {
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(keyword)}&hl=ko&gl=KR&ceid=KR:ko`;
    const xml = await fetchText(rssUrl);
    const linkMatch = xml.match(/<item>[\s\S]*?<link>(https?:\/\/[^<]+)<\/link>/i);
    if (linkMatch && linkMatch[1]) {
      const decoded = decodeGoogleRssUrl(linkMatch[1].trim());
      if (decoded && !decoded.includes('google.com') && !decoded.includes('search.naver.com')) {
        return decoded;
      }
    }
  } catch (e) {}

  // Fallback to Naver Search URL if no article link could be resolved
  return `https://search.naver.com/search.naver?where=nexearch&sm=top_hty&fbm=0&ie=utf8&query=${encodeURIComponent(keyword)}`;
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
      const articleUrl = await getDirectArticleUrl(keyword);

      cleanRankings.push({
        rank: rank,
        keyword: keyword,
        url: articleUrl
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
