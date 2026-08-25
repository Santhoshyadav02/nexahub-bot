const https = require('https');

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
 * Resolves Google News RSS base64/protobuf payload or decodes the target URL directly.
 */
function decodeGoogleRssUrl(rssUrl) {
  try {
    const match = rssUrl.match(/articles\/([A-Za-z0-9_-]+)/);
    if (match && match[1]) {
      const b64 = match[1].replace(/-/g, '+').replace(/_/g, '/');
      const buf = Buffer.from(b64, 'base64');
      const str = buf.toString('latin1');
      // Look for http/https URL inside the decoded protobuf binary
      const urlMatch = str.match(/https?:\/\/[a-zA-Z0-9_.~!*';:@&=+$,/?%#[\]-]+/);
      if (urlMatch && urlMatch[0] && !urlMatch[0].includes('google.com')) {
        return urlMatch[0];
      }
    }
  } catch (e) {}
  return null;
}

async function getPublisherArticleUrl(keyword) {
  // Method 1: Naver News Search (where=news) - extract direct Naver News Article or publisher article
  try {
    const naverNewsUrl = `https://search.naver.com/search.naver?where=news&query=${encodeURIComponent(keyword)}`;
    const html = await fetchText(naverNewsUrl);

    // 1a. Naver news article link (n.news.naver.com)
    const m1 = html.match(/href="(https?:\/\/n\.news\.naver\.com\/mnews\/article\/[^"]+)"/i);
    if (m1 && m1[1]) return m1[1].replace(/&amp;/g, '&');

    // 1b. Direct press news_tit link
    const m2 = html.match(/class="news_tit"[^>]*href="([^"]+)"/i);
    if (m2 && m2[1] && m2[1].startsWith('http') && !m2[1].includes('naver.com')) {
      return m2[1].replace(/&amp;/g, '&');
    }
  } catch (e) {}

  // Method 2: Naver Main Search (where=nexearch) - extract top organic search result link
  try {
    const naverMainUrl = `https://search.naver.com/search.naver?where=nexearch&query=${encodeURIComponent(keyword)}`;
    const html = await fetchText(naverMainUrl);

    // Look for organic article links or news links in main search
    const m3 = html.match(/class="link_tit"[^>]*href="([^"]+)"/i) ||
               html.match(/class="api_txt_lines total_tit"[^>]*href="([^"]+)"/i) ||
               html.match(/href="(https?:\/\/n\.news\.naver\.com\/mnews\/article\/[^"]+)"/i);
    if (m3 && m3[1] && m3[1].startsWith('http') && !m3[1].includes('search.naver.com')) {
      return m3[1].replace(/&amp;/g, '&');
    }
  } catch (e) {}

  // Method 3: Daum / Kakao News Search fallback
  try {
    const daumUrl = `https://search.daum.net/search?w=news&q=${encodeURIComponent(keyword)}`;
    const html = await fetchText(daumUrl);
    const m4 = html.match(/class="tit_main fn_tit_u"[^>]*href="([^"]+)"/i) ||
               html.match(/href="(https?:\/\/v\.daum\.net\/v\/[^"]+)"/i);
    if (m4 && m4[1] && m4[1].startsWith('http')) {
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

  return null;
}

async function testAll10() {
  const rankingScraper = require('../ranking_scraper');
  const data = await rankingScraper.scrapeRealtimeRankings();
  const rankings = data ? data.rankings : [];

  console.log("==================================================");
  console.log("📌 MULTI-SOURCE RESOLVER TEST FOR ALL 10 RANKINGS");
  console.log("==================================================\n");

  for (const item of rankings) {
    const finalUrl = await getPublisherArticleUrl(item.keyword);
    const isGoogleRss = finalUrl && finalUrl.includes('news.google.com/rss');
    const isNaverSearch = finalUrl && finalUrl.includes('search.naver.com');
    const isGoogleSearch = finalUrl && finalUrl.includes('google.com/search');
    const isTranslate = finalUrl && finalUrl.includes('translate.google.com');

    const isRejected = isGoogleRss || isNaverSearch || isGoogleSearch || isTranslate || !finalUrl;

    console.log(`Rank #${item.rank}: "${item.keyword}"`);
    console.log(`  Resolved Publisher URL: ${finalUrl}`);
    console.log(`  Is Rejected URL?:       ${isRejected ? 'YES ❌ (REJECTED)' : 'NO ✅ (ACCEPTED PUBLISHER URL)'}`);
    console.log("--------------------------------------------------");
  }
}

testAll10();
