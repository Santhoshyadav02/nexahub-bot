const rankingScraper = require('../ranking_scraper');

async function verifyTop10Urls() {
  const data = await rankingScraper.scrapeRealtimeRankings();
  if (!data || !Array.isArray(data.rankings)) {
    console.error("❌ Failed to fetch rankings!");
    return;
  }

  console.log("==================================================");
  console.log("📌 REAL-TIME KOREAN TOP 10 RANKINGS & DIRECT DESTINATION URLS");
  console.log("==================================================\n");

  data.rankings.forEach(item => {
    // Exact Naver search URL matching source website's link structure
    const naverUrl = `https://search.naver.com/search.naver?where=nexearch&sm=top_hty&fbm=0&ie=utf8&query=${encodeURIComponent(item.keyword)}`;
    console.log(`Rank #${item.rank}:`);
    console.log(`  Keyword: "${item.keyword}"`);
    console.log(`  Destination URL: ${naverUrl}`);
    console.log("--------------------------------------------------");
  });
}

verifyTop10Urls();
