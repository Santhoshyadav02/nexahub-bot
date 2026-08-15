const { chromium } = require("playwright");
const fs = require("fs");

let isScrapingTrending = false;
let isScrapingBreaking = false;

async function scrapeTrending() {
  console.log("🔍 Scraping signal.bz...");
  let browser = null;

  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto("https://www.signal.bz", { waitUntil: "domcontentloaded", timeout: 30000 });

    // Wait for content to load
    await page.waitForTimeout(3000);

    // Use correct selector .rank-text
    const keywords = await page.evaluate(() => {
      const items = document.querySelectorAll(".rank-text");
      return Array.from(items)
        .slice(0, 10)
        .map(item => item.innerText.trim())
        .filter(text => text.length > 0);
    });

    if (keywords.length > 0) {
      const data = {
        updatedAt: new Date().toISOString(),
        keywords: keywords,
      };
      fs.writeFileSync("trending.json", JSON.stringify(data, null, 2), "utf8");
      console.log(`✅ Saved ${keywords.length} trending keywords:`);
      keywords.forEach((kw, i) => console.log(`   ${i + 1}. ${kw}`));
    } else {
      console.log("⚠️ No keywords found! Keeping old data.");
    }

  } catch (err) {
    console.error("❌ Scraping error:", err.message);
  } finally {
    if (browser) {
      await browser.close().catch(e => console.error("Error closing trending browser:", e.message));
    }
  }
}

async function scrapeBreakingNews() {
  console.log("📰 Scraping breaking news...");
  let browser = null;

  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto("https://awesome-ui.netlify.app/", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);

    const news = await page.evaluate(() => {
      const items = document.querySelectorAll(".rank-sw .tit");
      return Array.from(items)
        .slice(0, 5)
        .map(item => item.innerText.replace(/<[^>]*>/g, "").trim())
        .filter(text => text.length > 0);
    });

    if (news.length > 0) {
      const data = {
        updatedAt: new Date().toISOString(),
        news: news,
      };
      fs.writeFileSync("breaking.json", JSON.stringify(data, null, 2), "utf8");
      console.log(`✅ Saved ${news.length} breaking news`);
    } else {
      console.log("⚠️ No breaking news found!");
    }

  } catch (err) {
    console.error("❌ Breaking news error:", err.message);
  } finally {
    if (browser) {
      await browser.close().catch(e => console.error("Error closing breaking news browser:", e.message));
    }
  }
}

async function safeScrapeTrending() {
  if (isScrapingTrending) {
    console.log("⏳ Trending scrape already in progress, skipping iteration.");
    return;
  }
  isScrapingTrending = true;
  try {
    await scrapeTrending();
  } finally {
    isScrapingTrending = false;
  }
}

async function safeScrapeBreakingNews() {
  if (isScrapingBreaking) {
    console.log("⏳ Breaking news scrape already in progress, skipping iteration.");
    return;
  }
  isScrapingBreaking = true;
  try {
    await scrapeBreakingNews();
  } finally {
    isScrapingBreaking = false;
  }
}

function startScraperScheduler() {
  // Run immediately on start
  safeScrapeTrending();
  safeScrapeBreakingNews();

  // Run trending every 10 minutes, breaking news every 3 minutes
  setInterval(safeScrapeTrending, 10 * 60 * 1000);
  setInterval(safeScrapeBreakingNews, 3 * 60 * 1000);

  console.log("⏰ Scraper running: Trending every 10 minutes, Breaking news every 3 minutes");
}

if (require.main === module) {
  startScraperScheduler();
}

module.exports = {
  scrapeTrending,
  scrapeBreakingNews,
  safeScrapeTrending,
  safeScrapeBreakingNews,
  startScraperScheduler,
};
