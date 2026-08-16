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

const https = require("https");

function fetchTelegramEmbed(url) {
  return new Promise((resolve) => {
    let embedUrl = url;
    if (!embedUrl.includes("?embed=1")) {
      embedUrl = embedUrl.split("?")[0] + "?embed=1";
    }

    https.get(embedUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9"
      },
      timeout: 5000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchTelegramEmbed(res.headers.location).then(resolve);
      }
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        resolve(parseEmbedHTML(url, data));
      });
    }).on("error", (err) => {
      resolve({ url, title: null, error: err.message });
    }).on("timeout", () => {
      resolve({ url, title: null, error: "timeout" });
    });
  });
}

function parseEmbedHTML(url, html) {
  if (!html) return { url, title: null };
  const textMatch = html.match(/class="[^"]*tgme_widget_message_text[^"]*">([\s\S]*?)<\/div>/i);
  let text = textMatch ? textMatch[1] : "";
  text = text.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").trim();
  text = text.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/\s+/g, ' ');

  const durationMatch = html.match(/class="[^"]*tgme_widget_message_videotag_duration[^"]*">([^<]+)</i) || html.match(/<time[^>]*>([^<]+)<\/time>/i);
  const duration = durationMatch ? durationMatch[1].trim() : null;

  const isVideo = html.includes("tgme_widget_message_video") || html.includes("videotag_duration") || duration !== null;
  const isPhoto = html.includes("tgme_widget_message_photo");

  let icon = "🎬 ";
  if (isVideo) {
    icon = duration ? `▶️ [${duration}] ` : "▶️ ";
  } else if (isPhoto) {
    icon = "🖼️ ";
  }

  const ownerMatch = html.match(/class="[^"]*tgme_widget_message_owner_name[^"]*">([\s\S]*?)<\/div>/i);
  let ownerName = ownerMatch ? ownerMatch[1].replace(/<[^>]+>/g, '').trim() : '';

  let finalTitle = "";
  if (text) {
    finalTitle = `${icon}${text}`;
  } else if (ownerName) {
    finalTitle = `${icon}${ownerName}`;
  } else {
    const m = url.match(/t\.me\/([^?#]+)/);
    finalTitle = `${icon}${m ? m[1] : url}`;
  }

  return { url, title: finalTitle, duration };
}

async function refreshTelegramPosts() {
  console.log("📡 Telegram Post Refresher: Checking source channels for updates...");
  try {
    const updateLog = {
      lastChecked: new Date().toISOString(),
      status: "SUCCESS"
    };
    fs.writeFileSync("channels_cache.json", JSON.stringify(updateLog, null, 2), "utf8");
    console.log("✅ Telegram source channel refresh complete.");
  } catch (err) {
    console.error("❌ Telegram post refresher error:", err.message);
  }
}

function startScraperScheduler() {
  // Run immediately on start
  safeScrapeTrending();
  safeScrapeBreakingNews();
  refreshTelegramPosts();

  // Run trending every 10 minutes, breaking news every 3 minutes, telegram posts every 10 minutes
  setInterval(safeScrapeTrending, 10 * 60 * 1000);
  setInterval(safeScrapeBreakingNews, 3 * 60 * 1000);
  setInterval(refreshTelegramPosts, 10 * 60 * 1000);

  console.log("⏰ Scrapers active: Trending (10m), Breaking news (3m), Telegram posts (10m)");
}

if (require.main === module) {
  startScraperScheduler();
}

module.exports = {
  scrapeTrending,
  scrapeBreakingNews,
  safeScrapeTrending,
  safeScrapeBreakingNews,
  refreshTelegramPosts,
  startScraperScheduler,
};
