const https = require('https');
const http = require('http');

/**
 * Follows HTTP 301/302/307/308 redirects & HTML meta refresh tags to find final publisher URL.
 */
function resolveFinalPublisherUrl(initialUrl, maxRedirects = 10) {
  return new Promise(async (resolve) => {
    let currentUrl = initialUrl;
    let redirectsCount = 0;

    while (currentUrl && redirectsCount < maxRedirects) {
      if (!currentUrl.startsWith('http')) break;
      
      // Stop if already resolved to non-Google/non-Naver-Search publisher URL
      if (!currentUrl.includes('news.google.com') && 
          !currentUrl.includes('search.naver.com') && 
          !currentUrl.includes('google.com/search')) {
        return resolve(currentUrl);
      }

      try {
        const res = await fetchResponse(currentUrl);
        
        // 1. Check Location header
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          let loc = res.headers.location;
          if (loc.startsWith('/')) {
            const u = new URL(currentUrl);
            loc = `${u.protocol}//${u.host}${loc}`;
          }
          currentUrl = loc;
          redirectsCount++;
          continue;
        }

        // 2. Check HTML meta refresh tag or JavaScript redirect
        if (res.body) {
          const metaMatch = res.body.match(/<meta[^>]*http-equiv=["']?refresh["']?[^>]*content=["']?[0-9]+;\s*url=([^"'>\s]+)["']?/i) ||
                            res.body.match(/window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i) ||
                            res.body.match(/c-wiz[^>]*data-n-au=["']([^"']+)["']/i);
          if (metaMatch && metaMatch[1]) {
            let loc = metaMatch[1].replace(/&amp;/g, '&');
            if (loc.startsWith('/')) {
              const u = new URL(currentUrl);
              loc = `${u.protocol}//${u.host}${loc}`;
            }
            if (loc !== currentUrl) {
              currentUrl = loc;
              redirectsCount++;
              continue;
            }
          }
        }

        break;
      } catch (err) {
        break;
      }
    }

    resolve(currentUrl);
  });
}

function fetchResponse(url) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      timeout: 8000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });

    req.on('error', () => resolve({ statusCode: 500, headers: {}, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ statusCode: 508, headers: {}, body: '' }); });
  });
}

async function runTest() {
  const sampleRssUrls = [
    "https://news.google.com/rss/articles/CBMiV0FVX3lxTE5XazV2MXBxVlQ4VzFManpXdmpLSTVDbFRHVGpSVE9zYWpZd1JrcTN4bXVrQU5kanFvb3M4aXpjWHJTZXRBbGFRNUYwN0t3Q2tKUjAtWDc3c9IBXEFVX3lxTE1qRU9US0pKLVdtNzhzNWE5U1NyWmo2c0tzd2syVUF1WTVxaThDYkhUMzlIaEtrNEtDVlZwWlY1eE1rczJUaGdNajlXNDQxaFZ0TVZ6ZVpiaHNubGpp?oc=5&hl=ko&gl=KR&ceid=KR:ko",
    "https://news.google.com/rss/articles/CBMiXkFVX3lxTE5SbDVPZ0llVTV6bnRtUUlUcG1QYjQ5VGJNckhIXzhUeDdaa0lIVWEzZDQ1MWkxWG9rN19JbEZWOXlGczlHaGI0dTZoalhKTXJZeGpDTmF5eUZnWjMzMXfSAWNBVV95cUxPemdQX2dXcE9ieTY3V0pqa2RZZXk4SXg0Q3hVQ0JjSmpELWJVR2lvblRjYTA5WlpRR0NhdDJaS2RyN2U3Q0kyNmhNVS1sVV9FaHBGMmlUd3d3SDU3UnppOXNQS28?oc=5&hl=ko&gl=KR&ceid=KR:ko"
  ];

  console.log("==================================================");
  console.log("🧪 TESTING GOOGLE NEWS RSS RESOLVER TO FINAL PUBLISHER URL");
  console.log("==================================================\n");

  for (const rss of sampleRssUrls) {
    console.log("Original RSS URL:", rss.substring(0, 70) + "...");
    const finalPublisher = await resolveFinalPublisherUrl(rss);
    console.log("Resolved Final Publisher URL:", finalPublisher);
    console.log("Is Google News RSS Link?:", finalPublisher.includes('news.google.com') ? 'YES ❌' : 'NO ✅');
    console.log("--------------------------------------------------");
  }
}

runTest();
