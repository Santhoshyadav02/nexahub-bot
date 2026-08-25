const https = require('https');

function fetchText(url) {
  return new Promise(resolve => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      timeout: 6000
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', () => resolve(''));
  });
}

async function getNaverBlueArticleUrl(keyword) {
  try {
    const searchUrl = `https://search.naver.com/search.naver?where=news&query=${encodeURIComponent(keyword)}`;
    const html = await fetchText(searchUrl);
    
    // Look for news_tit class href
    const titMatch = html.match(/class="news_tit"[^>]*href="([^"]+)"/i);
    if (titMatch && titMatch[1]) {
      return titMatch[1].replace(/&amp;/g, '&');
    }

    // Look for n.news.naver.com article link
    const naverNewsMatch = html.match(/href="(https?:\/\/n\.news\.naver\.com\/mnews\/article\/[^"]+)"/i);
    if (naverNewsMatch && naverNewsMatch[1]) {
      return naverNewsMatch[1].replace(/&amp;/g, '&');
    }
  } catch (e) {}

  return null;
}

async function run() {
  const rankingScraper = require('../ranking_scraper');
  const data = await rankingScraper.scrapeRealtimeRankings();
  const rankings = data ? data.rankings : [];

  console.log("==================================================");
  console.log("🔍 TESTING NAVER BLUE ARTICLE RESULT URL EXTRACTION");
  console.log("==================================================\n");

  for (const item of rankings) {
    const blueUrl = await getNaverBlueArticleUrl(item.keyword);
    console.log(`Rank #${item.rank}: "${item.keyword}"`);
    console.log(`  Naver Search URL: ${item.url}`);
    console.log(`  Naver Blue Result Article URL: ${blueUrl}`);
    console.log("--------------------------------------------------");
  }
}

run();
