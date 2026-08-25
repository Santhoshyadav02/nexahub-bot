const https = require('https');

const candidates = [
  'ruliweb', 'MARBLEX_official_ENG', 'MARBLEX_official_KR', 'wemix_official', 'wemix_kr',
  'wemade_official', 'com2us_official', 'kakaogames_kr', 'pearlabyss_official', 'krafton_official',
  'nexon_kr', 'nexon_official', 'smilegate_official', 'gamemeca', 'hungryapp',
  'thisisgame', 'gamechosun', 'gametoc', 'inven', 'inven_kr',
  'game_kr', 'esports_kr', 'lol_kr', 'steam_kr', 'indiegame_kr',
  'maplestory_kr', 'lostark_kr', 'genshin_kr', 'tft_kr', 'overwatch_kr'
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
  console.log("Verifying Gaming candidates...");
  const valid = [];
  for (const u of candidates) {
    const r = await verify(u);
    if (r.exists) {
      valid.push(r);
      console.log(`  [${valid.length}] ${r.username} | ${r.name} | KR: ${r.isKorean}`);
    }
  }
  console.log(`\nTotal verified gaming: ${valid.length}`);
}

run();
