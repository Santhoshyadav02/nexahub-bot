const https = require('https');

const financeChannels = [
  'FastStockNews', 'FastStockNewsUSA', 'FastBitNews', 'FastLandNews', 'TNBfolio',
  'dartquickai', 'wowtv_official', 'upbit_news', 'buffettlab', 'coin_kr',
  'blockmedia', 'DecenterGlobal', 'dartcorpdis', 'gateiokr', 'signal_report',
  'kiwoom_official', 'samsung_asset', 'miraeasset_official'
];

function verify(username) {
  return new Promise((resolve) => {
    const url = `https://t.me/s/${username}`;
    https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 3000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const titleMatch = data.match(/<meta property="og:title" content="([^"]+)"/i);
        const title = titleMatch ? titleMatch[1] : null;
        const exists = res.statusCode === 200 && title && !title.includes('Telegram: Contact');
        const isKorean = /[\uac00-\ud7af]/.test(data);
        const cleanTitle = title ? title.replace(' – Telegram', '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim() : username;
        resolve({ username: `@${username}`, name: cleanTitle, exists: !!exists, isKorean });
      });
    }).on('error', () => resolve({ username: `@${username}`, exists: false }))
      .on('timeout', function() { this.destroy(); resolve({ username: `@${username}`, exists: false }); });
  });
}

async function run() {
  console.log("Verifying Finance Channels...");
  const valid = [];
  for (const u of financeChannels) {
    const r = await verify(u);
    if (r.exists && r.isKorean) {
      valid.push(r);
      console.log(` ✅ [${valid.length}] ${r.username} | ${r.name}`);
    } else {
      console.log(` ❌ ${r.username} | exists:${r.exists} | kr:${r.isKorean}`);
    }
  }
  console.log(`\nTotal verified Korean Finance channels: ${valid.length}`);
}

run();
