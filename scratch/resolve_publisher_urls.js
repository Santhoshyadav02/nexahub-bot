const https = require('https');
const http = require('http');

function fetchText(url) {
  return new Promise(resolve => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      timeout: 8000
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    }).on('error', () => resolve({ statusCode: 500, headers: {}, body: '' }));
  });
}

function followRedirects(initialUrl, maxRedirects = 5) {
  return new Promise(async resolve => {
    let curr = initialUrl;
    for (let i = 0; i < maxRedirects; i++) {
      if (!curr || !curr.startsWith('http')) break;
      const res = await fetchText(curr);
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let loc = res.headers.location;
        if (loc.startsWith('/')) {
          const u = new URL(curr);
          loc = `${u.protocol}//${u.host}${loc}`;
        }
        curr = loc;
      } else {
        break;
      }
    }
    resolve(curr);
  });
}

async function getDirectArticleUrl(keyword) {
  // 1. Try Naver News Search first for direct Naver News Article
  try {
    const naverNewsSearch = `https://search.naver.com/search.naver?where=news&query=${encodeURIComponent(keyword)}`;
    const res = await fetchText(naverNewsSearch);
    const html = res.body;

    // Match n.news.naver.com link or news_tit link
    const matchNav = html.match(/href="(https?:\/\/n\.news\.naver\.com\/mnews\/article\/[^"]+)"/i);
    if (matchNav && matchNav[1]) {
      return matchNav[1].replace(/&amp;/g, '&');
    }

    const matchTit = html.match(/class="news_tit"[^>]*href="([^"]+)"/i);
    if (matchTit && matchTit[1] && matchTit[1].startsWith('http')) {
      return matchTit[1].replace(/&amp;/g, '&');
    }
  } catch (e) {}

  // 2. Try Google KR RSS for keyword and follow redirect to publisher
  try {
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(keyword)}&hl=ko&gl=KR&ceid=KR:ko`;
    const res = await fetchText(rssUrl);
    const xml = res.body;
    const linkMatch = xml.match(/<item>[\s\S]*?<link>(https?:\/\/[^<]+)<\/link>/i);
    if (linkMatch && linkMatch[1]) {
      const rawUrl = linkMatch[1].trim();
      const finalUrl = await followRedirects(rawUrl);
      if (finalUrl && finalUrl.startsWith('http') && !finalUrl.includes('search.naver.com')) {
        return finalUrl;
      }
    }
  } catch (e) {}

  // Fallback to Naver Search URL if no article found
  return `https://search.naver.com/search.naver?where=nexearch&sm=top_hty&fbm=0&ie=utf8&query=${encodeURIComponent(keyword)}`;
}

async function testResolution() {
  const rankingScraper = require('../ranking_scraper');
  const data = await rankingScraper.scrapeRealtimeRankings();
  const rankings = data ? data.rankings : [];

  console.log("==================================================");
  console.log("📌 RESOLVING EXACT DIRECT KOREAN ARTICLE URLS FOR TOP 10");
  console.log("==================================================\n");

  for (const item of rankings) {
    const directArticleUrl = await getDirectArticleUrl(item.keyword);
    console.log(`Rank #${item.rank}: "${item.keyword}"`);
    console.log(`  Current Naver Search URL: ${item.url}`);
    console.log(`  Actual Blue Article URL:  ${directArticleUrl}`);
    console.log(`  Is Naver Search Page:     ${directArticleUrl.includes('search.naver.com') ? 'YES ❌' : 'NO (DIRECT ARTICLE) ✅'}`);
    console.log("--------------------------------------------------");
  }
}

testResolution();
