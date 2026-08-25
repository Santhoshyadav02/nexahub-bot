const https = require('https');
const fs = require('fs');

const pool = {
  games: [
    'ruliweb', 'inven', 'gamemeca', 'hungryapp', 'gamechosun',
    'gameverse_kr', 'leagueoflegends_kr', 'steam_kr', 'indiegame_kr', 'esports_kr',
    'maplestory_kr', 'lostark_kr', 'tft_kr', 'genshin_kr', 'overwatch_kr',
    'nexon_kr', 'ncsoft_kr', 'netmarble_kr', 'krafton_kr', 'smilegate_kr',
    'game_kr', 'gamer_kr', 'game_news', 'esports_korea', 'lol_korea',
    'tft_korea', 'steam_korea', 'inven_kr', 'gametoc', 'thisisgame'
  ],
  ai_tools: [
    'itfoxn', 'blockmedia', 'aiinnovationstudio', 'chatgpt_kr', 'ai_news_kr',
    'ai_tools_kr', 'dev_kr', 'tech_kr', 'coding_kr', 'it_news_kr',
    'python_kr', 'ai_research_kr', 'openai_kr', 'deeplearning_kr', 'gai_kr',
    'ai_korea', 'aitrends_kr', 'data_kr', 'algorithm_kr', 'cloud_kr',
    'itnews_kr', 'techkorea', 'ai_korea_community', 'gpt_korea', 'sd_korea', 'midjourney_kr'
  ],
  stories: [
    'book_kr', 'reading_kr', 'poem_kr', 'story_kr', 'novel_kr',
    'literature_kr', 'essay_kr', 'mind_healing_kr', 'good_words_kr', 'heart_story_kr',
    'life_quote_kr', 'morning_letter_kr', 'today_quote_kr', 'booklog_kr', 'korea_books',
    'fiction_kr', 'k_novel', 'healing_kr', 'wisdom_kr', 'emotion_kr',
    'bookstagram_kr', 'storytelling_kr', 'words_kr'
  ],
  papers: [
    'science_kr', 'paper_kr', 'research_kr', 'study_kr', 'academic_kr',
    'thesis_kr', 'education_kr', 'tech_paper_kr', 'medical_paper_kr', 'korea_science',
    'nature_kr', 'science_daily_kr', 'korea_research', 'phd_kr', 'scholar_kr',
    'bio_kr', 'physics_kr', 'chemistry_kr', 'math_kr', 'history_kr',
    'science_korea', 'paper_korea'
  ],
  opening_up: [
    'info_kr', 'tip_kr', 'life_info_kr', 'issue_kr', 'trend_kr',
    'daily_info_kr', 'useful_kr', 'knowledge_kr', 'fun_kr', 'humor_kr',
    'media_kr', 'community_kr', 'viral_kr', 'hot_issue_kr', 'today_info_kr',
    'headline_kr', 'realtime_kr', 'today_news_kr', 'broadcasting_kr', 'culture_kr',
    'korea_info', 'issue_korea'
  ],
  food_source: [
    'food_kr', 'recipe_kr', 'cooking_kr', 'matjib_kr', 'eat_kr',
    'yammy_kr', 'chef_kr', 'baking_kr', 'homecook_kr', 'dish_kr',
    'kfood_kr', 'taste_kr', 'dinner_kr', 'mukbang_kr', 'gourmet_kr',
    'restaurant_kr', 'snack_kr', 'coffee_kr', 'dessert_kr', 'wine_kr',
    'cooking_korea', 'food_korea'
  ],
  finance: [
    'FastStockNews', 'FastStockNewsUSA', 'FastBitNews', 'FastLandNews', 'TNBfolio',
    'dartquickai', 'dartcorpdis', 'wowtv_official', 'upbit_news', 'DecenterGlobal',
    'buffettlab', 'gateiokr', 'blockmedia', 'coin_kr', 'stock_kr',
    'realestate_kr', 'economy_kr', 'investment_kr', 'wealth_kr', 'us_stock_kr'
  ],
  adult: [
    'bgcgw1', 'weme_downIoad', 'xahvh', 'Daoyusmlie', 'tianjin2023',
    'SGPAVCN', 'flapxz3', 'biaojie128', 'dongman98', 'v131312',
    'tunjing66666', 'minixue', 'baiyisizu', 'daydayACG', 'OFOSSS',
    'happylibrary', 'wumingzhidao123', 'avav131', 'skkt888', 'r18cg'
  ]
};

function verifyUsername(username) {
  return new Promise((resolve) => {
    const cleanUser = username.replace(/^@/, '').trim();
    const url = `https://t.me/s/${cleanUser}`;
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 3000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const titleMatch = data.match(/<meta property="og:title" content="([^"]+)"/i);
        const title = titleMatch ? titleMatch[1] : null;
        const exists = res.statusCode === 200 && title && !title.includes('Telegram: Contact');
        const isKorean = /[\uac00-\ud7af]/.test(data);
        const cleanTitle = title ? title.replace(' – Telegram', '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim() : cleanUser;
        resolve({
          username: `@${cleanUser}`,
          url: `https://t.me/${cleanUser}`,
          name: cleanTitle,
          exists: !!exists,
          isKorean: isKorean,
          rawLength: data.length
        });
      });
    }).on('error', () => resolve({ username: `@${cleanUser}`, exists: false }))
      .on('timeout', function() { this.destroy(); resolve({ username: `@${cleanUser}`, exists: false }); });
  });
}

async function run() {
  const verifiedMap = {};
  for (const [cat, list] of Object.entries(pool)) {
    verifiedMap[cat] = [];
    console.log(`Checking category: ${cat}...`);
    for (const u of list) {
      const res = await verifyUsername(u);
      if (res.exists) {
        verifiedMap[cat].push(res);
        console.log(`  [OK] ${res.username} -> ${res.name} (KR: ${res.isKorean})`);
      }
    }
    console.log(`Summary for ${cat}: ${verifiedMap[cat].length} valid channels.\n`);
  }
  fs.writeFileSync('scratch/verified_channels_result.json', JSON.stringify(verifiedMap, null, 2));
  console.log("Done writing scratch/verified_channels_result.json");
}

run();
