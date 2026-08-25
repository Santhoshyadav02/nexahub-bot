const fs = require('fs');
const scraper = require('../scraper');

async function run() {
  console.log("Inspecting current scraper and breaking.json...");
  await scraper.scrapeBreakingNews();

  if (fs.existsSync("breaking.json")) {
    const raw = fs.readFileSync("breaking.json", "utf8");
    console.log("breaking.json content:\n", raw);
    try {
      const parsed = JSON.parse(raw);
      console.log("Parsed news array length:", parsed.news ? parsed.news.length : 0);
      if (parsed.news && parsed.news.length > 0) {
        console.log("Sample item 0 type:", typeof parsed.news[0]);
        console.log("Sample item 0:", JSON.stringify(parsed.news[0]));
      }
    } catch (e) {
      console.error("Error parsing breaking.json:", e);
    }
  } else {
    console.log("breaking.json does not exist!");
  }
}

run();
