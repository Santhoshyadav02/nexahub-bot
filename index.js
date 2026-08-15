try {
  require("dotenv").config();
} catch (e) {
  // dotenv is optional in production
}

const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const { startScraperScheduler } = require("./scraper");

// ============================
// 🤖 MAIN BOT TOKEN & INIT
// ============================
const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error("❌ ERROR: BOT_TOKEN environment variable is not defined!");
  console.error("Please set BOT_TOKEN in your environment or .env file.");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

bot.on("polling_error", (error) => {
  console.error("⚠️ Telegram Bot Polling Error:", error.code || "", error.message || error);
});

// ============================
// 🖼️ WELCOME IMAGE
// ============================
const WELCOME_IMAGE = "https://raw.githubusercontent.com/hiruboyz/news-bot/main/Magnifying%20wealth%20with%20vibrant%20colors.png";

// ============================
// 📢 CHANNEL LISTS
// ============================
const CHANNELS = {
  ai: [
    { name: "🎬 DASS-891 [The most special day in life - that's the wedding]", user: "posting_02/89" },
    { name: "🎬 ADN-409 Unparalleled woman control, super staying power, intense insemination and intercourse by stepfather", user: "posting_02/91" },
    { name: "🎬 ADN-762 For you, I...the sweaty young wife looking for excuses to cheat on her", user: "posting_02/93" },
    { name: "🎬 CAWD-259 Uncensored Chinese", user: "posting_02/98" },
  ],
  bitcoin: [
    { name: "🎬 🌟Bunny Garden🔞Rin-chan🌟 The incredibly accurate Bunny Garu Rin cosplay is so hot! In the cowgirl position ", user: "posting01/262" },
    { name: "🎬 Tide x Cosplay x Tide Squirting Rapid-Fire Sex Rin Yoda", user: "posting01/295" },
    { name: "🎬 Tide Gushing Rapid-Fire Sex Rin Yoda with Panties", user: "posting01/307" },
    { name: "🎬 Tide Rapid-fire Cumshot Sex Rin Yoda with Panties and Photos", user: "posting01/311" },
  ],
  tesla: [
    { name: "🎬 极品奶油风网红，电子魅魔女友，前凸后翘性感身材，一对巨乳摇摇欲坠，情趣丝袜淫荡肥臀，高清写真诱惑十足！", user: "postiingNew03/106" },
    { name: "🎬 抖音少妇微信定制福利视频，高颜值反差婊，性感情趣丝袜淫荡诱惑，各种剧情足交挑逗，年轻的妈妈勾引骚狗儿子，果然戴眼镜的才是最骚的~", user: "postiingNew03/112" },
    { name: "🎬 高颜值抖音博主，脸足同框私密定制，极品美女御姐黑丝、裸足，美脚诱惑，抹油搓脚心诱惑榨精，这么漂亮的美女帮哥哥打飞机，足交，绝对的视觉盛宴！", user: "postiingNew03/118" },
    { name: "🎬 足控福音！微博百万粉丝玉足女神，单人定制美脚诱惑资源，白里透红的食品级玉足，三寸金莲小脚丫令人垂涎三尺，真想含住脚趾猛吸一口~", user: "postiingNew03/124" },
    { name: "🎬 这才是抖音的正确打开方式！吃瓜网友视角VS土豪裸聊视角，以为是一本正经的女主播，没想到幻龙骑乘骚得一笔，红底高跟裤里丝，这谁顶得住啊！", user: "postiingNew03/130" },
  ],
  openai: [
    { name: "🌐 Test-04", user: "postiingNew", members: "620K" },
  ],
};

// ============================
// 🔧 HELPER FUNCTIONS & API WRAPPERS
// ============================
function escapeHTML(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function sendMessageSafe(chatId, text, options = {}) {
  try {
    return await bot.sendMessage(chatId, text, options);
  } catch (err) {
    console.error(`❌ Error sending message to chat ${chatId}:`, err.message);
  }
}

async function sendPhotoSafe(chatId, photo, options = {}) {
  try {
    return await bot.sendPhoto(chatId, photo, options);
  } catch (err) {
    console.error(`❌ Error sending photo to chat ${chatId}:`, err.message);
  }
}

async function answerCallbackQuerySafe(queryId, options = {}) {
  try {
    return await bot.answerCallbackQuery(queryId, options);
  } catch (err) {
    console.error(`❌ Error answering callback query ${queryId}:`, err.message);
  }
}

function getMainKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "Perverted Woman", callback_data: "topic:ai" },
        { text: "BeautyFilterRendering", callback_data: "topic:bitcoin" },
      ],
    ],
  };
}

function searchResources(query) {
  if (!query || typeof query !== "string") return [];
  const rawQuery = query.trim().toLowerCase();
  if (!rawQuery) return [];

  const compactQuery = rawQuery.replace(/[\s\-_]+/g, "");
  const tokens = rawQuery.split(/[\s\-_]+/).filter(t => t.length > 0);

  const matchedItems = [];

  for (const [catKey, items] of Object.entries(CHANNELS)) {
    if (!Array.isArray(items)) continue;

    for (const item of items) {
      if (!item || !item.name) continue;

      const nameLower = item.name.toLowerCase();
      const userLower = (item.user || "").toLowerCase();
      const catLower = catKey.toLowerCase();
      const nameCompact = nameLower.replace(/[\s\-_]+/g, "");
      const userCompact = userLower.replace(/[\s\-_]+/g, "");

      let score = 0;

      // 1. Exact phrase or code match (Highest priority)
      if (nameLower.includes(rawQuery) || (compactQuery.length > 1 && nameCompact.includes(compactQuery))) {
        score += 100;
      }
      if (userLower.includes(rawQuery) || (compactQuery.length > 1 && userCompact.includes(compactQuery))) {
        score += 90;
      }

      // 2. Token relevance matching in name
      for (const t of tokens) {
        const compactToken = t.replace(/[\s\-_]+/g, "");
        if (nameLower.includes(t)) {
          score += 30;
        } else if (compactToken.length > 1 && nameCompact.includes(compactToken)) {
          score += 25;
        }
      }

      // 3. Category matching
      if (catLower.includes(rawQuery) || tokens.some(t => catLower.includes(t))) {
        score += 15;
      }

      // 4. Token relevance matching in user field
      for (const t of tokens) {
        if (userLower.includes(t)) {
          score += 10;
        }
      }

      if (score > 0) {
        matchedItems.push({
          name: item.name,
          user: item.user,
          category: catKey,
          score: score,
        });
      }
    }
  }

  // Deduplicate by user URL if duplicate items exist across categories, keeping highest score
  const uniqueMap = new Map();
  for (const item of matchedItems) {
    const existing = uniqueMap.get(item.user);
    if (!existing || item.score > existing.score) {
      uniqueMap.set(item.user, item);
    }
  }

  // Sort by score descending
  return Array.from(uniqueMap.values()).sort((a, b) => b.score - a.score);
}

function getTrendingKeywords() {
  try {
    if (fs.existsSync("trending.json")) {
      const data = JSON.parse(fs.readFileSync("trending.json", "utf8"));
      return data.keywords || [];
    }
  } catch (err) {
    console.error("Error reading trending.json:", err.message);
  }
  return ["키워드1", "키워드2", "키워드3", "키워드4", "키워드5"];
}

function getBreakingNews() {
  try {
    if (fs.existsSync("breaking.json")) {
      const data = JSON.parse(fs.readFileSync("breaking.json", "utf8"));
      return data.news || [];
    }
  } catch (err) {
    console.error("Error reading breaking.json:", err.message);
  }
  return [];
}

function truncateUTF8(str, maxBytes) {
  if (!str) return "";
  const buf = Buffer.from(String(str), "utf8");
  if (buf.length <= maxBytes) {
    return str;
  }
  let sliceLen = maxBytes;
  while (sliceLen > 0 && (buf[sliceLen] & 0xc0) === 0x80) {
    sliceLen--;
  }
  return buf.slice(0, sliceLen).toString("utf8");
}

function makeSearchCallbackData(keyword) {
  const safeKw = truncateUTF8(keyword, 57);
  return `search:${safeKw}`;
}

function getTrendingKeyboard() {
  const keywords = getTrendingKeywords();
  const breaking = getBreakingNews();
  const rows = [];

  for (let i = 0; i < keywords.length; i += 2) {
    const row = [
      { text: `${i + 1}. ${keywords[i]}`, callback_data: makeSearchCallbackData(keywords[i]) },
    ];
    if (keywords[i + 1]) {
      row.push({
        text: `${i + 2}. ${keywords[i + 1]}`,
        callback_data: makeSearchCallbackData(keywords[i + 1]),
      });
    }
    rows.push(row);
  }

  // Breaking news at bottom (after trending)
  if (breaking.length > 0) {
    rows.push([{ text: "🔴 Breaking News", callback_data: "none" }]);
    breaking.forEach((news) => {
      rows.push([{ text: `📰 ${news}`, url: `https://www.google.com/search?q=${encodeURIComponent(news)}` }]);
    });
  }
  
  rows.push([{ text: "🔄 Refresh Trending", callback_data: "refresh_trending" }]);
  return { inline_keyboard: rows };
}

async function renderSearchResults(chatId, query) {
  const results = searchResources(query);
  if (results.length > 0) {
    const rows = results.map(ch => ([
      { text: `${ch.name}`, url: `https://t.me/${ch.user}` }
    ]));
    rows.push([{ text: "🏠 Back to Main Menu", callback_data: "menu" }]);

    return await sendMessageSafe(chatId,
      `🔍 <b>Search Results for:</b> <code>"${escapeHTML(query)}"</code>\n\nFound <b>${results.length}</b> resource(s):`,
      {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: rows },
      }
    );
  } else {
    return await sendMessageSafe(chatId,
      `🔍 <b>No resources found for:</b> <code>"${escapeHTML(query)}"</code>\n\nTry searching with different keywords or explore hot topics below 👇`,
      {
        parse_mode: "HTML",
        reply_markup: getMainKeyboard(),
      }
    );
  }
}

function getChannelButtons(channels, topic) {
  const rows = channels.map(ch => ([
    { text: `${ch.name}`, url: `https://t.me/${ch.user}` }
  ]));
  rows.push([{ text: "🏠 Back to Main Menu", callback_data: "menu" }]);
  return { inline_keyboard: rows };
}

function formatChannelList(channels, topicName) {
  return `📢 <b>${escapeHTML(topicName)}</b>\n\n👇 Tap any post below:`;
}

const TOPIC_NAMES = {
  ai: " Test-01",
  bitcoin: " Test-02",
  tesla: " Test-03",
  openai: "🌐 Test-04",
};

// ============================
// 🚀 /start COMMAND
// ============================
bot.onText(/\/start/, async (msg) => {
  try {
    const chatId = msg.chat.id;
    const firstName = msg.from.first_name || "there";

    // Welcome image + text
    await sendPhotoSafe(chatId, WELCOME_IMAGE, {
      caption:
        `📡 <b>Welcome to NexaHub, ${escapeHTML(firstName)}!</b>\n\n` +
        `🔍This is a Telegram resource search engine. Send keywords to find groups, channels, videos, and music.\n\n` +
        `👇 Tap any topic to see the best channels!`,
      parse_mode: "HTML",
    });

    // Topic buttons + Trending combined
    await new Promise(r => setTimeout(r, 800));
    
    const mainKeys = getMainKeyboard().inline_keyboard;
    const trendingKeys = getTrendingKeyboard().inline_keyboard;
    const combinedKeyboard = {
      inline_keyboard: [...trendingKeys, ...mainKeys]
    };

    await sendMessageSafe(chatId,
      `🔥 <b>Hot Topics</b>\n\nChoose a topic to explore channels 👇`,
      {
        parse_mode: "HTML",
        reply_markup: combinedKeyboard,
      }
    );
  } catch (err) {
    console.error("❌ Error handling /start:", err.message);
  }
}); 

// Command: /19guide
bot.onText(/\/19guide/, async (msg) => {
  try {
    const chatId = msg.chat.id;

    const message = `<b>How to Access Restricted/Sensitive Content on Telegram (iOS)</b>\n\n` +
      `If you encounter the following message when joining a group or channel:\n\n` +
      `<i>"This channel can't be displayed because it was used to spread pornographic content."</i>\n\n` +
      `<b>The Reason:</b>\n` +
      `The channel or group has been restricted by Telegram for containing adult or sensitive content.\n\n` +
      `<b>✅ The Fix:</b>\n\n` +
      `Log in to Telegram Web: https://web.telegram.org (Open this link in your mobile or desktop browser).\n\n` +
      `Follow these steps:\n` +
      `➊ Go to Settings\n` +
      `➋ Select Privacy and Security\n` +
      `➌ Scroll down to the Sensitive Content section\n` +
      `➍ Enable "Disable filtering"\n\n` +
      `Restart the Telegram app on your iOS device, and you should now have full access.`;

    await sendMessageSafe(chatId, message, {
      parse_mode: "HTML",
      disable_web_page_preview: true
    });
  } catch (err) {
    console.error("❌ Error handling /19guide:", err.message);
  }
});

// ============================
// 🔘 BUTTON CALLBACKS
// ============================
bot.on("callback_query", async (query) => {
  try {
    const chatId = query.message.chat.id;
    const data = query.data;
    await answerCallbackQuerySafe(query.id);

    if (data.startsWith("search:")) {
      const keyword = data.replace("search:", "");
      await renderSearchResults(chatId, keyword);
    } else if (data.startsWith("topic:")) {
      const topic = data.replace("topic:", "");
      const channels = CHANNELS[topic] || [];
      const topicName = TOPIC_NAMES[topic] || topic;

      await sendMessageSafe(chatId,
        formatChannelList(channels, topicName),
        {
          parse_mode: "HTML",
          reply_markup: getChannelButtons(channels, topic),
        }
      );
    } else if (data === "refresh_trending") {
      const trendingKeys = getTrendingKeyboard().inline_keyboard;
      trendingKeys.push([{ text: "🏠 Back to Main Menu", callback_data: "menu" }]);
      await sendMessageSafe(chatId,
        `🔥 <b>Real-time Trending</b>\n\nTap any keyword to search 👇`,
        {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: trendingKeys },
        }
      );
    } else if (data === "menu") {
      const mainKeys = getMainKeyboard().inline_keyboard;
      const trendingKeys = getTrendingKeyboard().inline_keyboard;
      const combinedKeyboard = {
        inline_keyboard: [...trendingKeys, ...mainKeys]
      };

      await sendMessageSafe(chatId,
        `🔥 <b>Hot Topics</b>\n\nChoose a topic to explore channels 👇`,
        {
          parse_mode: "HTML",
          reply_markup: combinedKeyboard,
        }
      );
    }
  } catch (err) {
    console.error("❌ Error handling callback_query:", err.message);
  }
});

// ============================
// 💬 FREE TEXT SEARCH
// ============================
bot.on("message", async (msg) => {
  try {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!text || text.startsWith("/")) return;

    await renderSearchResults(chatId, text);
  } catch (err) {
    console.error("❌ Error handling message search:", err.message);
  }
});

// ============================
// 🚀 SINGLE-PROCESS INIT
// ============================
startScraperScheduler();

console.log("✅ NewsSearch Main Bot is running...");
console.log("🔗 Channels shown directly in main bot!");

module.exports = {
  searchResources,
  CHANNELS,
  truncateUTF8,
  makeSearchCallbackData,
  escapeHTML,
};
