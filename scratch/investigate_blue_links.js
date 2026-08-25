const https = require('https');
const http = require('http');

function fetchText(url) {
  return new Promise(resolve => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      timeout: 6000
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', err => resolve(''));
  });
}

/**
 * Resolves Google RSS link or shortener to final destination URL.
 */
function resolveRedirect(url) {
  return new Promise(resolve => {
    if (!url || !url.startsWith('http')) return resolve(url);
    try {
      const client = url.startsWith('https') ? https : http;
      const req = client.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        timeout: 5000
      }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          resolve(res.headers.location);
        } else {
          resolve(url);
        }
      });
      req.on('error', () => resolve(url));
      req.on('timeout', () => { req.destroy(); resolve(url); });
    } catch (e) {
      resolve(url);
    }
  });
}

async function getArticleUrlForKeyword(keyword) {
  // Method A: Google KR News RSS for keyword
  try {
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(keyword)}&hl=ko&gl=KR&ceid=KR:ko`;
    const xml = await fetchText(rssUrl);
    const linkMatch = xml.match(/<item>[\s\S]*?<link>(https?:\/\/[^<]+)<\/link>/i);
    if (linkMatch && linkMatch[1]) {
      const rawUrl = linkMatch[1].trim();
      const finalUrl = await resolveRedirect(rawUrl);
      if (finalUrl && finalUrl.startsWith('http') && !finalUrl.includes('search.naver.com')) {
        return finalUrl;
      }
    }
  } catch (e) {}

  // Method B: Scrape top news link from Naver search HTML
  try {
    const searchUrl = `https://search.naver.com/search.naver?where=news&query=${encodeURIComponent(keyword)}`;
    const html = await fetchText(searchUrl);
    // Look for news title links (class="news_tit" or href with news article)
    const match = html.match(/class="news_tit"[^>]*href="(https?:\/\/[^"]+)"/i) || html.match(/href="(https:\/\/[n]?\.news\.naver\.com\/mnews\/article\/[^"]+)"/i);
    if (match && match[1]) {
      return match[1].replace(/&amp;/g, '&');
    }
  } catch (e) {}

  // Fallback: Naver search URL if no news article found
  return `https://search.naver.com/search.naver?where=nexearch&sm=top_hty&fbm=0&ie=utf8&query=${encodeURIComponent(keyword)}`;
}

async function testTop10() {
  const rankingScraper = require('../ranking_scraper');
  const data = await rankingScraper.scrapeRealtimeRankings();
  const rankings = data ? data.rankings : [];

  console.log("==================================================");
  console.log("🔍 TESTING ACTUAL BLUE ARTICLE RESULT URL RESOLUTION");
  console.log("==================================================\n");

  for (const item of rankings) {
    const articleUrl = await getArticleUrlForKeyword(item.keyword);
    console.log(`Rank #${item.rank}: "${item.keyword}"`);
    console.log(`  Naver Search URL: ${item.url}`);
    console.log(`  Actual Article URL: ${articleUrl}`);
    console.log(`  Is Direct Article Page: ${!articleUrl.includes('search.naver.com') ? 'YES ✅' : 'NO ❌'}`);
    console.log("--------------------------------------------------");
  }
}

testTop10();
