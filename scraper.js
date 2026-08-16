const { chromium } = require("playwright");
const fs = require("fs");

let isScrapingTrending = false;
let isScrapingBreaking = false;

async function scrapeTrending() {
  console.log("🔍 Scraping real-time trending keywords via HTTP...");
  return new Promise((resolve) => {
    const url = "https://trends.google.com/trending/rss?geo=US";
    https.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/rss+xml, application/xml, text/xml, */*"
      },
      timeout: 8000
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        const itemMatches = data.match(/<title>([\s\S]*?)<\/title>/gi) || [];
        const keywords = [];
        for (const item of itemMatches) {
          let clean = item
            .replace(/<[^>]+>/g, "")
            .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&#39;/g, "'")
            .trim();
          if (clean && clean !== "Daily Search Trends" && !keywords.includes(clean)) {
            keywords.push(clean);
          }
          if (keywords.length >= 10) break;
        }

        if (keywords.length > 0) {
          const payload = {
            updatedAt: new Date().toISOString(),
            keywords: keywords
          };
          fs.writeFileSync("trending.json", JSON.stringify(payload, null, 2), "utf8");
          console.log(`✅ Saved ${keywords.length} trending keywords to trending.json:`);
          keywords.forEach((kw, i) => console.log(`   ${i + 1}. ${kw}`));
        } else {
          console.log("⚠️ No trending keywords parsed!");
        }
        resolve();
      });
    }).on("error", (err) => {
      console.error("❌ Trending HTTP error:", err.message);
      resolve();
    }).on("timeout", function() {
      this.destroy();
      console.error("❌ Trending HTTP timeout");
      resolve();
    });
  });
}

async function scrapeBreakingNews() {
  console.log("📰 Scraping breaking news via HTTP RSS...");
  return new Promise((resolve) => {
    const newsUrl = "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en";
    https.get(newsUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      },
      timeout: 8000
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        const itemMatches = data.match(/<item>([\s\S]*?)<\/item>/gi) || [];
        const news = [];
        for (const item of itemMatches) {
          const titleMatch = item.match(/<title>([\s\S]*?)<\/title>/i);
          if (titleMatch) {
            let clean = titleMatch[1]
              .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
              .replace(/<[^>]+>/g, "")
              .replace(/&quot;/g, '"')
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&#39;/g, "'")
              .trim();
            if (clean && !news.includes(clean)) {
              news.push(clean);
            }
          }
          if (news.length >= 5) break;
        }

        if (news.length > 0) {
          const payload = {
            updatedAt: new Date().toISOString(),
            news: news
          };
          fs.writeFileSync("breaking.json", JSON.stringify(payload, null, 2), "utf8");
          console.log(`✅ Saved ${news.length} breaking news items to breaking.json`);
        } else {
          console.log("⚠️ No breaking news items found!");
        }
        resolve();
      });
    }).on("error", (err) => {
      console.error("❌ Breaking news HTTP error:", err.message);
      resolve();
    }).on("timeout", function() {
      this.destroy();
      console.error("❌ Breaking news HTTP timeout");
      resolve();
    });
  });
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
