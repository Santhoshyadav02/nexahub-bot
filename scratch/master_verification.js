const https = require('https');
const fs = require('fs');

const masterCandidates = {
  games: [
    'ruliweb', 'wemix_official', 'wemix_kr', 'game_kr', 'gamechoseon',
    'gamemeca', 'hungryapp', 'thisisgame', 'inven', 'inven_kr',
    'leagueoflegends_kr', 'steam_kr', 'indiegame_kr', 'esports_kr', 'maplestory_kr',
    'lostark_kr', 'tft_kr', 'genshin_kr', 'overwatch_kr', 'nexon_kr',
    'ncsoft_kr', 'netmarble_kr', 'krafton_kr', 'smilegate_kr', 'MARBLEX_official_ENG',
    'game_news_kr', 'koreagame', 'esports_korea', 'lol_korea', 'tft_korea',
    'steam_korea', 'playstation_kr', 'xbox_kr', 'nintendo_kr', 'blizzard_kr'
  ],
  ai_tools: [
    'itfoxn', 'blockmedia', 'aiinnovationstudio', 'ai_korea', 'generativeai_gpt',
    'aichads', 'chatgpt_kr', 'ai_news_kr', 'ai_tools_kr', 'dev_kr',
    'tech_kr', 'coding_kr', 'it_news_kr', 'python_kr', 'ai_research_kr',
    'openai_kr', 'deeplearning_kr', 'gai_kr', 'aitrends_kr', 'data_kr',
    'algorithm_kr', 'cloud_kr', 'itnews_kr', 'techkorea', 'ai_korea_community',
    'gpt_korea', 'sd_korea', 'midjourney_kr', 'developer_kr', 'chatgpt_korea'
  ],
  stories: [
    'book_kr', 'reading_kr', 'poem_kr', 'story_kr', 'novel_kr',
    'literature_kr', 'essay_kr', 'mind_healing_kr', 'good_words_kr', 'heart_story_kr',
    'life_quote_kr', 'morning_letter_kr', 'today_quote_kr', 'booklog_kr', 'korea_books',
    'fiction_kr', 'k_novel', 'healing_kr', 'wisdom_kr', 'emotion_kr',
    'bookstagram_kr', 'storytelling_kr', 'words_kr', 'reading_time_kr', 'korea_edu'
  ],
  papers: [
    'science_kr', 'paper_kr', 'research_kr', 'study_kr', 'academic_kr',
    'thesis_kr', 'education_kr', 'tech_paper_kr', 'medical_paper_kr', 'korea_science',
    'nature_kr', 'science_daily_kr', 'korea_research', 'phd_kr', 'scholar_kr',
    'biological_kr', 'physics_kr', 'chemistry_kr', 'math_kr', 'history_kr',
    'science_korea', 'paper_korea', 'journal_kr', 'korea_edu', 'builders'
  ],
  opening_up: [
    'info_kr', 'tip_kr', 'life_info_kr', 'issue_kr', 'trend_kr',
    'daily_info_kr', 'useful_kr', 'knowledge_kr', 'fun_kr', 'humor_kr',
    'media_kr', 'community_kr', 'viral_kr', 'hot_issue_kr', 'today_info_kr',
    'headline_kr', 'realtime_kr', 'today_news_kr', 'broadcasting_kr', 'culture_kr',
    'korea_info', 'issue_korea', 'taliekdramasupdates', 'TikTok_Centrall'
  ],
  food_source: [
    'food_kr', 'recipe_kr', 'cooking_kr', 'matjib_kr', 'eat_kr',
    'yammy_kr', 'chef_kr', 'baking_kr', 'homecook_kr', 'dish_kr',
    'kfood_kr', 'taste_kr', 'dinner_kr', 'mukbang_kr', 'gourmet_kr',
    'restaurant_kr', 'snack_kr', 'coffee_kr', 'dessert_kr', 'wine_kr',
    'cooking_korea', 'food_korea', 'recipe_korea', 'matjib_korea'
  ],
  finance: [
    'FastStockNews', 'FastStockNewsUSA', 'FastBitNews', 'FastLandNews', 'TNBfolio',
    'dartquickai', 'wowtv_official', 'buffettlab', 'coin_kr', 'blockmedia',
    'kwusa', 'hanaresearch', 'meritz_research', 'BChoSN', 'mujammin123',
    'shrimp_notice', 'MBMweb3', 'morefaternews', 'godmulzoo', 'coinkcgchannel',
    'Bounty_ATM', 'Raoni1', 'hedgecat0301', 'ehdwl', 'marshallog',
    'HANAchina'
  ],
  adult: [
    'bgcgw1', 'weme_downIoad', 'xahvh', 'Daoyusmlie', 'tianjin2023',
    'SGPAVCN', 'flapxz3', 'biaojie128', 'dongman98', 'v131312',
    'tunjing66666', 'minixue', 'baiyisizu', 'daydayACG', 'OFOSSS',
    'happylibrary', 'wumingzhidao123', 'avav131', 'skkt888', 'r18cg'
  ]
};

function verify(username) {
  return new Promise((resolve) => {
    const cleanUser = username.replace(/^@/, '').trim();
    const url = `https://t.me/s/${cleanUser}`;
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
        const cleanTitle = title ? title.replace(' – Telegram', '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim() : cleanUser;
        resolve({
          name: cleanTitle,
          username: `@${cleanUser}`,
          url: `https://t.me/${cleanUser}`,
          exists: !!exists,
          isKorean: isKorean,
          length: data.length
        });
      });
    }).on('error', () => resolve({ username: `@${cleanUser}`, exists: false }))
      .on('timeout', function() { this.destroy(); resolve({ username: `@${cleanUser}`, exists: false }); });
  });
}

async function run() {
  const verifiedResults = {};
  console.log("==================================================");
  console.log("🔍 MASTER KOREAN TELEGRAM CHANNEL VERIFICATION");
  console.log("==================================================\n");

  for (const [catKey, list] of Object.entries(masterCandidates)) {
    verifiedResults[catKey] = [];
    console.log(`Checking category: [${catKey}]...`);
    for (const u of list) {
      const res = await verify(u);
      if (res.exists) {
        verifiedResults[catKey].push(res);
        console.log(`  ✅ [FOUND] ${res.username} | Title: "${res.name}" | KR: ${res.isKorean}`);
      }
    }
    console.log(`Summary for [${catKey}]: ${verifiedResults[catKey].length} active public channels.\n`);
  }

  fs.writeFileSync('scratch/master_verified.json', JSON.stringify(verifiedResults, null, 2));
  console.log("Saved master verified channels to scratch/master_verified.json");
}

run();
