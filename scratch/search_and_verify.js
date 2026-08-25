const https = require('https');
const fs = require('fs');

// Candidate pool across all 8 categories
const candidatesPool = {
  games: [
    'ruliweb', 'inven', 'gamemeca', 'hungryapp', 'gamechosun',
    'gameverse_kr', 'leagueoflegends_kr', 'steam_kr', 'indiegame_kr', 'esports_kr',
    'maplestory_kr', 'lostark_kr', 'tft_kr', 'genshin_kr', 'overwatch_kr',
    'nexon_kr', 'ncsoft_kr', 'netmarble_kr', 'krafton_kr', 'smilegate_kr',
    'game_kr', 'gamer_kr', 'game_news', 'esports_korea', 'lol_korea',
    'tft_korea', 'steam_korea', 'inven_kr', 'gametoc', 'thisisgame',
    'playstation_kr', 'xbox_kr', 'nintendo_kr', 'blizzard_kr', 'riotgames_kr',
    'valorant_kr', 'pubg_kr', 'diablo_kr', 'hearthstone_kr', 'fifa_kr',
    'game_talk_kr', 'game_info_kr', 'esports_news_kr', 'indie_game_kr', 'mobile_game_kr',
    'game_community_kr', 'pc_game_kr', 'console_game_kr', 'game_deal_kr', 'hotdeal_game'
  ],
  ai_tools: [
    'itfoxn', 'blockmedia', 'aiinnovationstudio', 'chatgpt_kr', 'ai_news_kr',
    'ai_tools_kr', 'dev_kr', 'tech_kr', 'coding_kr', 'it_news_kr',
    'python_kr', 'ai_research_kr', 'openai_kr', 'deeplearning_kr', 'gai_kr',
    'ai_korea', 'aitrends_kr', 'data_kr', 'algorithm_kr', 'cloud_kr',
    'itnews_kr', 'techkorea', 'ai_korea_community', 'gpt_korea', 'sd_korea', 'midjourney_kr',
    'developer_kr', 'frontend_kr', 'backend_kr', 'fullstack_kr', 'sw_kr',
    'ai_lab_kr', 'chatgpt_korea', 'claude_kr', 'llm_kr', 'generative_ai_kr',
    'tech_news_kr', 'it_trend_kr', 'startup_tech_kr', 'future_tech_kr', 'ai_study_kr'
  ],
  stories: [
    'book_kr', 'reading_kr', 'poem_kr', 'story_kr', 'novel_kr',
    'literature_kr', 'essay_kr', 'mind_healing_kr', 'good_words_kr', 'heart_story_kr',
    'life_quote_kr', 'morning_letter_kr', 'today_quote_kr', 'booklog_kr', 'korea_books',
    'fiction_kr', 'k_novel', 'healing_kr', 'wisdom_kr', 'emotion_kr',
    'bookstagram_kr', 'storytelling_kr', 'words_kr', 'reading_time_kr', 'book_recommend_kr',
    'short_story_kr', 'webnovel_kr', 'webtoon_kr', 'culture_story_kr', 'essay_quote_kr',
    'mind_quote_kr', 'daily_quote_kr', 'healing_words_kr', 'love_quote_kr', 'life_story_kr',
    'morning_reading_kr', 'night_reading_kr', 'quiet_reading_kr', 'book_club_kr', 'library_kr'
  ],
  papers: [
    'science_kr', 'paper_kr', 'research_kr', 'study_kr', 'academic_kr',
    'thesis_kr', 'education_kr', 'tech_paper_kr', 'medical_paper_kr', 'korea_science',
    'nature_kr', 'science_daily_kr', 'korea_research', 'phd_kr', 'scholar_kr',
     'biological_kr', 'physics_kr', 'chemistry_kr', 'math_kr', 'history_kr',
    'science_korea', 'paper_korea', 'journal_kr', 'lab_kr', 'university_kr',
    'research_news_kr', 'study_note_kr', 'academic_news_kr', 'science_news_kr', 'tech_research_kr',
    'medical_research_kr', 'ai_paper_kr', 'deep_research_kr', 'data_research_kr', 'scholar_news_kr'
  ],
  opening_up: [
    'info_kr', 'tip_kr', 'life_info_kr', 'issue_kr', 'trend_kr',
    'daily_info_kr', 'useful_kr', 'knowledge_kr', 'fun_kr', 'humor_kr',
    'media_kr', 'community_kr', 'viral_kr', 'hot_issue_kr', 'today_info_kr',
    'headline_kr', 'realtime_kr', 'today_news_kr', 'broadcasting_kr', 'culture_kr',
    'korea_info', 'issue_korea', 'trend_korea', 'media_korea', 'life_hack_kr',
    'useful_info_kr', 'daily_news_kr', 'fact_check_kr', 'today_trend_kr', 'viral_news_kr',
    'community_news_kr', 'sns_issue_kr', 'hot_trend_kr', 'topic_kr', 'focus_kr'
  ],
  food_source: [
    'food_kr', 'recipe_kr', 'cooking_kr', 'matjib_kr', 'eat_kr',
    'yammy_kr', 'chef_kr', 'baking_kr', 'homecook_kr', 'dish_kr',
    'kfood_kr', 'taste_kr', 'dinner_kr', 'mukbang_kr', 'gourmet_kr',
    'restaurant_kr', 'snack_kr', 'coffee_kr', 'dessert_kr', 'wine_kr',
    'cooking_korea', 'food_korea', 'recipe_korea', 'matjib_korea', 'homecook_korea',
    'daily_recipe_kr', 'easy_recipe_kr', 'simple_cooking_kr', 'korean_food_kr', 'baking_recipe_kr',
    'cafe_kr', 'dessert_recipe_kr', 'lunch_kr', 'breakfast_kr', 'late_night_snack_kr'
  ],
  finance: [
    'FastStockNews', 'FastStockNewsUSA', 'FastBitNews', 'FastLandNews', 'TNBfolio',
    'dartquickai', 'wowtv_official', 'upbit_news', 'buffettlab', 'coin_kr',
    'blockmedia', 'kwusa', 'hanaresearch', 'meritz_research', 'shinhan_research',
    'samsungsec', 'kiwoomsec', 'miraeassetsec', 'nhinvest', 'koreainvestment',
    'stock_kr', 'realestate_kr', 'economy_kr', 'investment_kr', 'wealth_kr',
    'us_stock_kr', 'kr_stock_kr', 'crypto_kr', 'bitcoin_kr', 'dividend_kr'
  ],
  adult: [
    'romance_kr', 'secret_kr', 'night_kr', 'vibe_kr', 'adult_kr',
    'love_kr', 'couple_kr', 'date_kr', 'scandal_kr', 'gossip_kr',
    'private_kr', 'club_kr', 'party_kr', 'glamour_kr', 'beauty_kr',
    'model_kr', 'fashion_kr', 'style_kr', 'mood_kr', 'passion_kr'
  ]
};

function verify(username) {
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
          dataLength: data.length
        });
      });
    }).on('error', () => resolve({ username: `@${cleanUser}`, exists: false }))
      .on('timeout', function() { this.destroy(); resolve({ username: `@${cleanUser}`, exists: false }); });
  });
}

async function run() {
  const verifiedMap = {};
  console.log("Starting full verification sweep across all candidates...\n");

  for (const [cat, list] of Object.entries(candidatesPool)) {
    verifiedMap[cat] = [];
    console.log(`=== CATEGORY: ${cat} ===`);
    for (const u of list) {
      const res = await verify(u);
      if (res.exists) {
        verifiedMap[cat].push(res);
        console.log(`  [FOUND] ${res.username} | Title: "${res.name}" | KR: ${res.isKorean}`);
      }
    }
    console.log(`Total found in ${cat}: ${verifiedMap[cat].length}\n`);
  }

  fs.writeFileSync('scratch/all_verified_sweep.json', JSON.stringify(verifiedMap, null, 2));
  console.log("Saved results to scratch/all_verified_sweep.json");
}

run();
