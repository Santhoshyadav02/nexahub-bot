const https = require('https');

// A large, curated pool of known, real Korean Telegram public channels across all 8 categories
const categoryCandidates = {
  games: [
    'ruliweb', 'inven', 'gamemeca', 'hungryapp', 'gamechosun',
    'gameverse_kr', 'leagueoflegends_kr', 'steam_kr', 'indiegame_kr', 'esports_kr',
    'maplestory_kr', 'lostark_kr', 'tft_kr', 'genshin_kr', 'overwatch_kr',
    'nexon_kr', 'ncsoft_kr', 'netmarble_kr', 'krafton_kr', 'smilegate_kr'
  ],
  ai_tools: [
    'itfoxn', 'aipost', 'aiinnovationstudio', 'chatgpt_kr', 'ai_news_kr',
    'ai_tools_kr', 'dev_kr', 'tech_kr', 'coding_kr', 'it_news_kr',
    'python_kr', 'ai_research_kr', 'openai_kr', 'deeplearning_kr', 'gai_kr',
    'ai_korea', 'aitrends_kr', 'data_kr', 'algorithm_kr', 'cloud_kr'
  ],
  stories: [
    'book_kr', 'reading_kr', 'poem_kr', 'story_kr', 'novel_kr',
    'literature_kr', 'essay_kr', 'mind_healing_kr', 'good_words_kr', 'heart_story_kr',
    'life_quote_kr', 'morning_letter_kr', 'today_quote_kr', 'booklog_kr', 'korea_books',
    'fiction_kr', 'k_novel', 'healing_kr', 'wisdom_kr', 'emotion_kr'
  ],
  papers: [
    'science_kr', 'paper_kr', 'research_kr', 'study_kr', 'academic_kr',
    'thesis_kr', 'education_kr', 'tech_paper_kr', 'medical_paper_kr', 'korea_science',
    'nature_kr', 'science_daily_kr', 'korea_research', 'phd_kr', 'scholar_kr',
    'bio_kr', 'physics_kr', 'chemistry_kr', 'math_kr', 'history_kr'
  ],
  opening_up: [
    'info_kr', 'tip_kr', 'life_info_kr', 'issue_kr', 'trend_kr',
    'daily_info_kr', 'useful_kr', 'knowledge_kr', 'fun_kr', 'humor_kr',
    'media_kr', 'community_kr', 'viral_kr', 'hot_issue_kr', 'today_info_kr',
    'headline_kr', 'realtime_kr', 'today_news_kr', 'broadcasting_kr', 'culture_kr'
  ],
  food_source: [
    'food_kr', 'recipe_kr', 'cooking_kr', 'matjib_kr', 'eat_kr',
    'yammy_kr', 'chef_kr', 'baking_kr', 'homecook_kr', 'dish_kr',
    'kfood_kr', 'taste_kr', 'dinner_kr', 'mukbang_kr', 'gourmet_kr',
    'restaurant_kr', 'snack_kr', 'coffee_kr', 'dessert_kr', 'wine_kr'
  ],
  finance: [
    'FastStockNews', 'FastStockNewsUSA', 'FastBitNews', 'FastLandNews', 'TNBfolio',
    'dartquickai', 'dartcorpdis', 'wowtv_official', 'upbit_news', 'DecenterGlobal',
    'buffettlab', 'gateiokr', 'stock_kr', 'coin_kr', 'realestate_kr',
    'economy_kr', 'investment_kr', 'wealth_kr', 'us_stock_kr', 'kr_stock_kr'
  ],
  adult: [
    'bgcgw1', 'weme_downIoad', 'xahvh', 'Daoyusmlie', 'tianjin2023',
    'SGPAVCN', 'flapxz3', 'biaojie128', 'dongman98', 'v131312',
    'tunjing66666', 'minixue', 'baiyisizu', 'daydayACG', 'OFOSSS',
    'happylibrary', 'wumingzhidao123', 'avav131', 'skkt888', 'r18cg'
  ]
};

function checkTelegramPublicPage(username) {
  return new Promise((resolve) => {
    const cleanUser = username.replace(/^@/, '').trim();
    const url = `https://t.me/s/${cleanUser}`;
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
      },
      timeout: 4000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const titleMatch = data.match(/<meta property="og:title" content="([^"]+)"/i);
        const title = titleMatch ? titleMatch[1] : null;
        const exists = res.statusCode === 200 && title && !title.includes('Telegram: Contact') && !title.includes('Telegram Web');
        const isKorean = /[\uac00-\ud7af]/.test(data);
        const cleanTitle = title ? title.replace(' – Telegram', '').trim() : cleanUser;
        resolve({
          username: `@${cleanUser}`,
          url: `https://t.me/${cleanUser}`,
          name: cleanTitle,
          exists: !!exists,
          isKorean: isKorean
        });
      });
    }).on('error', () => resolve({ username: `@${cleanUser}`, exists: false, isKorean: false }))
      .on('timeout', function() { this.destroy(); resolve({ username: `@${cleanUser}`, exists: false, isKorean: false }); });
  });
}

async function runAudit() {
  console.log("Checking candidate channels for all 8 categories...\n");
  const results = {};

  for (const [cat, list] of Object.entries(categoryCandidates)) {
    results[cat] = [];
    console.log(`=== CHECKING CATEGORY: ${cat} ===`);
    for (const u of list) {
      const res = await checkTelegramPublicPage(u);
      if (res.exists) {
        results[cat].push(res);
        console.log(` ✅ FOUND [${res.username}] -> Name: "${res.name}" (isKorean: ${res.isKorean})`);
      }
    }
    console.log(`Total verified for ${cat}: ${results[cat].length}\n`);
  }
}

runAudit();
