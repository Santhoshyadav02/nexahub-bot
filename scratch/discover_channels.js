const https = require('https');

const candidates = {
  games: [
    'newgames', 'GameMartzOfficial', 'TGGames_official', 'FreeGamesNews', 'thenotgames',
    'game_news_kr', 'koreagame', 'esports_kr', 'lol_kr', 'steam_kr',
    'indiegame_kr', 'gamemega', 'inven_kr', 'ruliweb', 'gametoc',
    'thisisgame', 'gamechosun', 'gamemeca', 'inven', 'hungryapp'
  ],
  ai_tools: [
    'aipost', 'Artificial_intelligence_in', 'DeepLearning_ai', 'DataScienceM', 'ai_news_world',
    'ai_news_kr', 'chatgpt_kr', 'ai_tools_kr', 'openai_kr', 'ai_research_kr',
    'tech_kr', 'dev_kr', 'ai_korea', 'coding_kr', 'it_news_kr',
    'python_kr', 'deeplearning_kr', 'machinelearning_kr', 'gai_kr', 'aitrends_kr'
  ],
  stories: [
    'shortstoriesmm', 'tellshorttales', 'english_storyBook', 'book_lists', 'booksmania',
    'book_kr', 'story_kr', 'novel_kr', 'literature_kr', 'reading_kr',
    'poem_kr', 'essay_kr', 'korea_books', 'booklog_kr', 'today_quote_kr',
    'morning_letter_kr', 'mind_healing_kr', 'good_words_kr', 'heart_story_kr', 'life_quote_kr'
  ],
  papers: [
    'science', 'scientific', 'science_talk', 'research_publications', 'assignmentandthesis',
    'science_kr', 'paper_kr', 'research_kr', 'study_kr', 'academic_kr',
    'korea_science', 'thesis_kr', 'education_kr', 'tech_paper_kr', 'medical_paper_kr',
    'nature_kr', 'science_daily_kr', 'korea_research', 'phd_kr', 'scholar_kr'
  ],
  opening_up: [
    'ASMREmily', 'asmrselena', 'videosasmr', 'ASMR_Relaxing_Sound', 'relaxwithasmr',
    'info_kr', 'tip_kr', 'life_info_kr', 'issue_kr', 'trend_kr',
    'daily_info_kr', 'useful_kr', 'knowledge_kr', 'fun_kr', 'humor_kr',
    'media_kr', 'community_kr', 'viral_kr', 'hot_issue_kr', 'today_info_kr'
  ],
  food_source: [
    'culinaryD', 'cookingandcooking', 'cookingdish', 'thevideorecipes', 'JiyasKitchenIndianVegFood',
    'food_kr', 'recipe_kr', 'cooking_kr', 'matjib_kr', 'eat_kr',
    'yammy_kr', 'chef_kr', 'baking_kr', 'homecook_kr', 'dish_kr',
    'kfood_kr', 'taste_kr', 'dinner_kr', 'mukbang_kr', 'gourmet_kr'
  ],
  finance: [
    'FastStockNews', 'FastStockNewsUSA', 'FastBitNews', 'FastLandNews', 'TNBfolio',
    'dartquickai', 'dartcorpdis', 'finance', 'crypto_finance', 'stockstudy',
    'financially_free_in', 'token', 'stock_kr', 'coin_kr', 'realestate_kr',
    'economy_kr', 'investment_kr', 'wealth_kr', 'us_stock_kr', 'kr_stock_kr'
  ],
  adult: [
    'bgcgw1', 'weme_downIoad', 'xahvh', 'Daoyusmlie', 'tianjin2023',
    'adult_kr', 'secret_kr', 'romance_kr', 'vibe_kr', 'night_kr'
  ]
};

function verifyChannel(username) {
  return new Promise((resolve) => {
    const cleanUser = username.replace(/^@/, '').trim();
    const url = `https://t.me/s/${cleanUser}`;
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 4000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const titleMatch = data.match(/<meta property="og:title" content="([^"]+)"/i);
        const descMatch = data.match(/<meta property="og:description" content="([^"]+)"/i);
        const title = titleMatch ? titleMatch[1] : null;
        const desc = descMatch ? descMatch[1] : '';
        const exists = res.statusCode === 200 && title && !title.includes('Telegram: Contact');
        const isKorean = /[\uac00-\ud7af]/.test(data);
        resolve({
          username: `@${cleanUser}`,
          url: `https://t.me/${cleanUser}`,
          title: title ? title.replace(' – Telegram', '').trim() : cleanUser,
          description: desc,
          exists: !!exists,
          isKorean: isKorean
        });
      });
    }).on('error', () => resolve({ username: `@${cleanUser}`, exists: false, isKorean: false }))
      .on('timeout', function() { this.destroy(); resolve({ username: `@${cleanUser}`, exists: false, isKorean: false }); });
  });
}

async function run() {
  console.log("Checking candidate channels...\n");
  for (const [cat, list] of Object.entries(candidates)) {
    console.log(`=== CATEGORY: ${cat} ===`);
    let validCount = 0;
    for (const u of list) {
      const res = await verifyChannel(u);
      if (res.exists) {
        validCount++;
        console.log(` [EXISTS] ${res.username} | Title: ${res.title} | KR: ${res.isKorean}`);
      }
    }
    console.log(`Total valid in ${cat}: ${validCount}\n`);
  }
}

run();
