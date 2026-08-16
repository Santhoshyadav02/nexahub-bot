try {
  require("dotenv").config();
} catch (e) {
  // dotenv is optional in production
}

const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const https = require("https");
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

const isMainModule = require.main === module;
const bot = new TelegramBot(TOKEN, { polling: isMainModule });

bot.on("polling_error", (error) => {
  console.error("⚠️ Telegram Bot Polling Error:", error.code || "", error.message || error);
});

// ============================
// 🖼️ WELCOME IMAGE
// ============================
const WELCOME_IMAGE = "https://raw.githubusercontent.com/hiruboyz/news-bot/main/Magnifying%20wealth%20with%20vibrant%20colors.png";

// ============================
// 🌐 DYNAMIC TRANSLATION HELPER
// ============================
const translationCache = new Map();

async function translateText(text, targetLang = "en") {
  if (!text || typeof text !== "string") {
    return text || "";
  }

  const cacheKey = `${targetLang}:${text}`;
  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }

  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
    const translated = await new Promise((resolve) => {
      const req = https.get(url, { timeout: 3000 }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed && parsed[0] && parsed[0][0] && parsed[0][0][0]) {
              const fullText = parsed[0].map((item) => item[0]).filter(Boolean).join("");
              resolve(fullText);
            } else {
              resolve(text);
            }
          } catch (e) {
            resolve(text);
          }
        });
      });
      req.on("error", () => resolve(text));
      req.on("timeout", () => {
        req.destroy();
        resolve(text);
      });
    });

    translationCache.set(cacheKey, translated);
    return translated;
  } catch (err) {
    return text;
  }
}

// ============================
// 📢 CHANNEL LISTS
// ============================
const CHANNELS = {
  ai: [
    { name: "🎬 DASS-891 [The most special day in life - that's the wedding]", user: "fancha07" },
    { name: "🎬 ADN-409 Unparalleled woman control, super staying power, intense insemination and intercourse by stepfather", user: "sesedeCB" },
    { name: "🎬 ADN-762 For you, I...the sweaty young wife looking for excuses to cheat on her", user: "fanchaku8" },
    { name: "🎬 CAWD-259 Uncensored Chinese", user: "yuziyuzi111" },
  ],
  bitcoin: [
    { name: "🎬 🌟Bunny Garden🔞Rin-chan🌟 The incredibly accurate Bunny Garu Rin cosplay is so hot! In the cowgirl position ", user: "zzkbraxk" },
    { name: "🎬 Tide x Cosplay x Tide Squirting Rapid-Fire Sex Rin Yoda", user: "LaiCai123688" },
    { name: "🎬 Tide Gushing Rapid-Fire Sex Rin Yoda with Panties", user: "wuxisk112/245" },
    { name: "🎬 Tide Rapid-fire Cumshot Sex Rin Yoda with Panties and Photos", user: "quanzhou99990000/221" },
  ],
  tesla: [
    { name: "🎬 极品奶油风网红，电子魅魔女友，前凸后翘性感身材，一对巨乳摇摇欲坠，情趣丝袜淫荡肥臀，高清写真诱惑十足！", user: "edxrfvtgb111/2319" },
    { name: "🎬 抖音少妇微信定制福利视频，高颜值反差婊，性感情趣丝袜淫荡诱惑，各种剧情足交挑逗，年轻的妈妈勾引骚狗儿子，果然戴眼镜的才是最骚的~", user: "youshengyueju1/65938" },
    { name: "🎬 高颜值抖音博主，脸足同框私密定制，极品美女御姐黑丝、裸足，美脚诱惑，抹油搓脚心诱惑榨精，这么漂亮的美女帮哥哥打飞机，足交，绝对의 视觉盛宴！", user: "postiingNew03/118" },
    { name: "🎬 足控福音！微博百万粉丝玉足女神，单人定制美脚诱惑资源，白里透红的食品级玉足，三寸金莲小脚丫令人垂涎三尺，真想含住脚趾猛吸一口~", user: "postiingNew03/124" },
    { name: "🎬 这才是抖音的正确打开方式！吃瓜网友视角VS土豪裸聊视角，以为是一本正经的女主播，没想到幻龙骑乘骚得一笔，红底高跟裤里丝，这谁顶得住啊！", user: "postiingNew03/130" },
  ],
  openai: [
    { name: "🌐 Test-04", user: "postiingNew", members: "620K" },
  ],
};

// ============================
// 📹 VIDEO FILE_ID CACHE & HISTORY TRACKING
// ============================
const VIDEO_CACHE_FILE = "video_cache.json";
let videoFileIdCache = {};
const userMessageHistory = new Map();

function loadVideoCache() {
  try {
    if (fs.existsSync(VIDEO_CACHE_FILE)) {
      videoFileIdCache = JSON.parse(fs.readFileSync(VIDEO_CACHE_FILE, "utf8"));
    }
  } catch (err) {
    console.error("Error reading video_cache.json:", err.message);
    videoFileIdCache = {};
  }
}

function saveVideoCache(resId, fileId) {
  try {
    videoFileIdCache[String(resId)] = fileId;
    fs.writeFileSync(VIDEO_CACHE_FILE, JSON.stringify(videoFileIdCache, null, 2), "utf8");
  } catch (err) {
    console.error("Error writing video_cache.json:", err.message);
  }
}

function getCachedFileId(resId) {
  return videoFileIdCache[String(resId)] || null;
}

loadVideoCache();

function trackMessage(chatId, messageId) {
  if (!chatId || !messageId) return;
  if (!userMessageHistory.has(chatId)) {
    userMessageHistory.set(chatId, new Set());
  }
  userMessageHistory.get(chatId).add(messageId);
}

async function clearUserHistory(chatId) {
  if (!userMessageHistory.has(chatId)) return 0;
  const msgIds = Array.from(userMessageHistory.get(chatId));
  let deletedCount = 0;
  for (const msgId of msgIds) {
    try {
      await bot.deleteMessage(chatId, msgId);
      deletedCount++;
    } catch (e) {
      // Ignore if already deleted or > 48h
    }
  }
  userMessageHistory.delete(chatId);
  return deletedCount;
}

// ============================
// 📜 USER SEARCH HISTORY TRACKING
// ============================
const userSearchHistoryMap = new Map();

function recordUserSearch(chatId, query) {
  if (!chatId || !query || typeof query !== "string") return;
  const cleanQuery = query.trim();
  if (!cleanQuery || cleanQuery.startsWith("/")) return;

  if (!userSearchHistoryMap.has(chatId)) {
    userSearchHistoryMap.set(chatId, []);
  }
  const history = userSearchHistoryMap.get(chatId);
  const filtered = history.filter(q => q.toLowerCase() !== cleanQuery.toLowerCase());
  filtered.unshift(cleanQuery);
  if (filtered.length > 5) filtered.length = 5;
  userSearchHistoryMap.set(chatId, filtered);
}

function getUserSearchHistory(chatId) {
  return userSearchHistoryMap.get(chatId) || [];
}

function clearUserSearchHistory(chatId) {
  userSearchHistoryMap.delete(chatId);
}

// ============================
// ⌨️ PERSISTENT NAVIGATION KEYBOARD
// ============================
function getPersistentNavigationKeyboard() {
  return {
    keyboard: [
      [
        { text: "🏠 Home" },
        { text: "ℹ️ About" },
        { text: "🗑️ History" }
      ]
    ],
    resize_keyboard: true,
    persistent: true,
    is_persistent: true
  };
}

const getPersistentKeyboard = getPersistentNavigationKeyboard;

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
    const res = await bot.sendMessage(chatId, text, options);
    if (res && res.message_id) trackMessage(chatId, res.message_id);
    return res;
  } catch (err) {
    console.error(`❌ Error sending message to chat ${chatId}:`, err.message);
  }
}

async function sendPhotoSafe(chatId, photo, options = {}) {
  try {
    const res = await bot.sendPhoto(chatId, photo, options);
    if (res && res.message_id) trackMessage(chatId, res.message_id);
    return res;
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

async function editMessageTextSafe(chatId, messageId, text, options = {}) {
  try {
    const opts = {
      chat_id: chatId,
      message_id: messageId,
      ...options
    };
    return await bot.editMessageText(text, opts);
  } catch (err) {
    if (err.message && err.message.includes("message is not modified")) {
      return true;
    }
    console.warn(`⚠️ Error editing message ${messageId} in chat ${chatId}:`, err.message);
    return await sendMessageSafe(chatId, text, options);
  }
}

// ============================
// 📹 DATASET FEATURED POSTS RESOLVER & RENDERER
// ============================
let FEATURED_DATASET = {};
try {
  if (fs.existsSync("featured_dataset.json")) {
    FEATURED_DATASET = JSON.parse(fs.readFileSync("featured_dataset.json", "utf8"));
  }
} catch (err) {
  console.error("Error reading featured_dataset.json:", err.message);
}

function getFeaturedPosts(cardId) {
  const cardData = FEATURED_DATASET[String(cardId)];
  if (!cardData || !Array.isArray(cardData.posts)) {
    return [];
  }
  return cardData.posts;
}

function extractChannelInfo(url, title) {
  if (!url || typeof url !== "string") {
    return { key: "unknown", name: "Unknown Channel", type: "other" };
  }

  // Private invite link t.me/+hash
  if (url.includes("/+") || url.includes("joinchat")) {
    const inviteHash = url.split("/+")[1] ? url.split("/+")[1].split("?")[0] : "private";
    return {
      key: `invite_${inviteHash}`,
      name: `🔒 Private Group (+${inviteHash.slice(0, 8)}...)`,
      type: "private"
    };
  }

  // Standard username t.me/username/123 or t.me/username
  const match = url.match(/t\.me\/([^/?#]+)(?:\/(\d+))?/);
  if (match) {
    const username = match[1];
    return {
      key: `user_${username.toLowerCase()}`,
      name: `@${username}`,
      username: username,
      type: "channel"
    };
  }

  return { key: "other", name: "Other Resource", type: "other" };
}

function getFeaturedChannels(cardId) {
  const posts = getFeaturedPosts(cardId);
  if (!posts || posts.length === 0) return [];

  const channelMap = {};
  posts.forEach(post => {
    const ch = extractChannelInfo(post.url, post.title);
    if (!channelMap[ch.key]) {
      channelMap[ch.key] = {
        key: ch.key,
        name: ch.name,
        type: ch.type,
        posts: []
      };
    }
    channelMap[ch.key].posts.push(post);
  });

  return Object.values(channelMap);
}

async function renderFeaturedCardPosts(chatId, cardId, page = 1, messageId = null) {
  const cardInfo = FEATURED_RESOURCES.find(r => r.id === cardId);
  const cardName = cardInfo ? cardInfo.name : `Card ${cardId}`;
  const posts = getFeaturedPosts(cardId);

  if (!posts || posts.length === 0) {
    const emptyText = `🔥 <b>${escapeHTML(cardName)}</b>\n\nNo posts found for this category.`;
    const emptyOpts = {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🏠 Back to Main Menu", callback_data: "menu" }]
        ]
      }
    };
    if (messageId) {
      return await editMessageTextSafe(chatId, messageId, emptyText, emptyOpts);
    } else {
      return await sendMessageSafe(chatId, emptyText, emptyOpts);
    }
  }

  const itemsPerPage = 10;
  const totalPages = Math.ceil(posts.length / itemsPerPage);
  const currentPage = Math.max(1, Math.min(page, totalPages));

  const startIndex = (currentPage - 1) * itemsPerPage;
  const pagePosts = posts.slice(startIndex, startIndex + itemsPerPage);

  const rows = pagePosts.map(p => {
    let displayTitle = String(p.title || "").trim();
    let icon = "";

    // Check if title already contains media icon or starts with bracket
    if (displayTitle.includes("▶") || displayTitle.includes("🎬") || displayTitle.includes("🖼️") || displayTitle.includes("📄") || displayTitle.includes("📹") || displayTitle.includes("🔘")) {
      icon = "";
    } else if (p.url.includes("img") || displayTitle.toLowerCase().includes("photo")) {
      icon = "🖼️ ";
    } else if (displayTitle.startsWith("[")) {
      icon = "▶️ ";
    } else {
      icon = "🎬 ";
    }

    const fullTitle = `${icon}${displayTitle}`.trim();
    const titleText = truncateUTF8(fullTitle, 55);
    return [{ text: titleText, url: p.url }];
  });

  // Pagination row if totalPages > 1
  if (totalPages > 1) {
    const navRow = [];
    if (currentPage > 1) {
      navRow.push({ text: "◀ Previous", callback_data: `featured_page:${cardId}:${currentPage - 1}` });
    }
    navRow.push({ text: `Page ${currentPage}/${totalPages}`, callback_data: "none" });
    if (currentPage < totalPages) {
      navRow.push({ text: "Next ▶", callback_data: `featured_page:${cardId}:${currentPage + 1}` });
    }
    rows.push(navRow);
  }

  rows.push([{ text: "🏠 Back to Main Menu", callback_data: "menu" }]);

  const messageText = `🔥 <b>${escapeHTML(cardName)}</b>\n\nFound <b>${posts.length}</b> post(s):`;
  const messageOptions = {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: rows },
  };

  if (messageId) {
    return await editMessageTextSafe(chatId, messageId, messageText, messageOptions);
  } else {
    return await sendMessageSafe(chatId, messageText, messageOptions);
  }
}

async function renderFeaturedChannelPosts(chatId, cardId, channelIndex, page = 1, messageId = null) {
  const cardInfo = FEATURED_RESOURCES.find(r => r.id === cardId);
  const channels = getFeaturedChannels(cardId);
  const channel = channels[channelIndex];

  if (!channel || !channel.posts || channel.posts.length === 0) {
    const text = `📺 <b>Channel Not Found</b>\n\nNo posts available.`;
    const opts = {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "◀ Back to Channels", callback_data: `featured:${cardId}:1` }],
          [{ text: "🏠 Back to Main Menu", callback_data: "menu" }]
        ]
      }
    };
    if (messageId) {
      return await editMessageTextSafe(chatId, messageId, text, opts);
    } else {
      return await sendMessageSafe(chatId, text, opts);
    }
  }

  const posts = channel.posts;
  const itemsPerPage = 10;
  const totalPages = Math.ceil(posts.length / itemsPerPage);
  const currentPage = Math.max(1, Math.min(page, totalPages));

  const startIndex = (currentPage - 1) * itemsPerPage;
  const pagePosts = posts.slice(startIndex, startIndex + itemsPerPage);

  const channelUrl = channel.username
    ? `https://t.me/${channel.username}`
    : (channel.posts[0] ? channel.posts[0].url.split("/").slice(0, 4).join("/") : null);

  const rows = pagePosts.map(p => {
    const titleText = truncateUTF8(p.title, 55);
    let icon = "🎬";
    if (p.url.includes("img") || p.title.toLowerCase().includes("photo") || p.title.includes("🖼️")) {
      icon = "🖼️";
    } else if (p.title.includes("▶️") || p.title.toLowerCase().includes("video")) {
      icon = "▶️";
    }
    return [{ text: `${icon} ${titleText}`, url: p.url }];
  });

  // Pagination row if totalPages > 1
  if (totalPages > 1) {
    const navRow = [];
    if (currentPage > 1) {
      navRow.push({ text: "◀ Previous", callback_data: `featured_ch:${cardId}:${channelIndex}:${currentPage - 1}` });
    }
    navRow.push({ text: `Page ${currentPage}/${totalPages}`, callback_data: "none" });
    if (currentPage < totalPages) {
      navRow.push({ text: "Next ▶", callback_data: `featured_ch:${cardId}:${channelIndex}:${currentPage + 1}` });
    }
    rows.push(navRow);
  }

  // Open Channel button if valid channelUrl exists
  if (channelUrl) {
    rows.push([{ text: `🔗 Open ${channel.name} Channel`, url: channelUrl }]);
  }

  rows.push([
    { text: "◀ Back to Channels", callback_data: `featured:${cardId}:1` },
    { text: "🏠 Back to Main Menu", callback_data: "menu" }
  ]);
  const opts = {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: rows },
  };

  if (messageId) {
    return await editMessageTextSafe(chatId, messageId, text, opts);
  } else {
    return await sendMessageSafe(chatId, text, opts);
  }
}

function getMainKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "🎯 Perverted Woman", callback_data: "topic:ai" },
        { text: "💎 BeautyFilterRendering", callback_data: "topic:bitcoin" },
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

// ============================
// 🌟 FEATURED RESOURCES (TOP 8 CARDS)
// ============================
const FEATURED_RESOURCES = [
  { id: 1, name: "🔥 Huangguo Short Dramas" },
  { id: 2, name: "⭐ Li Meng" },
  { id: 3, name: "🎤 Dong Qing" },
  { id: 4, name: "👁️ Hypnotic Divine Eye" },
  { id: 5, name: "🖤 pinkchyu" },
  { id: 6, name: "🔥 Teng Teng Cai" },
  { id: 7, name: "⚽ World Cup" },
  { id: 8, name: "🎲 Baccarat / Dice / Gaming" }
];

function getFeaturedKeyboard() {
  const rows = [];
  for (let i = 0; i < FEATURED_RESOURCES.length; i += 2) {
    const r1 = FEATURED_RESOURCES[i];
    const r2 = FEATURED_RESOURCES[i + 1];

    const row = [
      { text: `${r1.name}`, callback_data: `featured:${r1.id}` }
    ];
    if (r2) {
      row.push({ text: `${r2.name}`, callback_data: `featured:${r2.id}` });
    }
    rows.push(row);
  }
  return rows;
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

async function getTrendingKeyboard() {
  const featuredRows = getFeaturedKeyboard();
  const breaking = getBreakingNews();
  const mainKeys = getMainKeyboard().inline_keyboard;
  
  const rows = [...featuredRows];

  // Breaking news at bottom (after featured cards)
  if (breaking.length > 0) {
    rows.push([{ text: "📰 BREAKING NEWS", callback_data: "none" }]);
    for (const news of breaking) {
      const displayNews = await translateText(news, "en");
      rows.push([{ text: `📰 ${displayNews}`, url: `https://www.google.com/search?q=${encodeURIComponent(news)}` }]);
    }
  }
  
  rows.push([{ text: "🔄 REFRESH TRENDING", callback_data: "refresh_trending" }]);
  rows.push(...mainKeys);

  return { inline_keyboard: rows };
}

async function renderSearchResults(chatId, query, messageId = null) {
  recordUserSearch(chatId, query);
  const results = searchResources(query);
  const displayQuery = await translateText(query, "en");

  if (!messageId) {
    await sendMessageSafe(chatId,
      `🔍 <b>Searching:</b> <code>"${escapeHTML(displayQuery)}"</code>`,
      {
        parse_mode: "HTML",
        reply_markup: getPersistentNavigationKeyboard()
      }
    );
  }

  if (results.length > 0) {
    const rows = results.map(ch => ([
      { text: `${ch.name}`, url: `https://t.me/${ch.user}` }
    ]));
    rows.push([{ text: "🏠 Back to Main Menu", callback_data: "menu" }]);

    const text = `🔍 <b>Search Results for:</b> <code>"${escapeHTML(displayQuery)}"</code>\n\nFound <b>${results.length}</b> resource(s):`;
    const opts = {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: rows },
    };

    if (messageId) {
      return await editMessageTextSafe(chatId, messageId, text, opts);
    } else {
      return await sendMessageSafe(chatId, text, opts);
    }
  } else {
    const trendingKeys = await getTrendingKeyboard();
    const text = `🔍 <b>No resources found for:</b> <code>"${escapeHTML(displayQuery)}"</code>\n\nTry searching with different keywords or explore hot topics below 👇`;
    const opts = {
      parse_mode: "HTML",
      reply_markup: trendingKeys,
    };

    if (messageId) {
      return await editMessageTextSafe(chatId, messageId, text, opts);
    } else {
      return await sendMessageSafe(chatId, text, opts);
    }
  }
}

function getChannelButtons(channels) {
  const rows = channels.map(ch => ([
    { text: `${ch.name}`, url: `https://t.me/${ch.user}` }
  ]));
  rows.push([{ text: "🏠 Back to Main Menu", callback_data: "menu" }]);
  return { inline_keyboard: rows };
}

function formatChannelList(channels, topicName) {
  const displayTopicName = TOPIC_NAMES[topicName] || topicName;
  return `📢 <b>${escapeHTML(displayTopicName)}</b>\n\n👇 Tap any post below:`;
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
      reply_markup: getPersistentNavigationKeyboard()
    });

    // Topic buttons + Trending combined
    await new Promise(r => setTimeout(r, 800));
    
    const combinedKeyboard = await getTrendingKeyboard();

    await sendMessageSafe(chatId,
      `🔥 <b>HOT TOPICS</b>\n\nChoose a topic to explore channels 👇`,
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
// 🔒 PER-USER CONCURRENCY LOCK
// ============================
const activeUserLocks = new Set();

function acquireUserLock(chatId) {
  const key = String(chatId);
  if (activeUserLocks.has(key)) {
    return false;
  }
  activeUserLocks.add(key);
  return true;
}

function releaseUserLock(chatId) {
  const key = String(chatId);
  activeUserLocks.delete(key);
}

// ============================
// 🔘 BUTTON CALLBACKS
// ============================
bot.on("callback_query", async (query) => {
  try {
    const chatId = query.message.chat.id;
    const data = query.data;

    const messageId = query.message ? query.message.message_id : null;

    if (data.startsWith("featured_page:")) {
      const parts = data.split(":");
      const cardId = parseInt(parts[1], 10);
      const page = parseInt(parts[2], 10);
      await renderFeaturedCardPosts(chatId, cardId, page, messageId);
    } else if (data.startsWith("featured_ch:")) {
      const parts = data.split(":");
      const cardId = parseInt(parts[1], 10);
      const chIndex = parseInt(parts[2], 10);
      const page = parseInt(parts[3] || "1", 10);
      await renderFeaturedChannelPosts(chatId, cardId, chIndex, page, messageId);
    } else if (data.startsWith("featured:")) {
      const parts = data.split(":");
      const cardId = parseInt(parts[1], 10);
      const page = parseInt(parts[2] || "1", 10);
      await renderFeaturedCardPosts(chatId, cardId, page, messageId);
    } else if (data.startsWith("search:")) {
      const keyword = data.replace("search:", "");
      await renderSearchResults(chatId, keyword, messageId);
    } else if (data.startsWith("topic:")) {
      const topic = data.replace("topic:", "");
      const channels = CHANNELS[topic] || [];
      const text = formatChannelList(channels, topic);
      const opts = {
        parse_mode: "HTML",
        reply_markup: getChannelButtons(channels),
      };
      if (messageId) {
        await editMessageTextSafe(chatId, messageId, text, opts);
      } else {
        await sendMessageSafe(chatId, text, opts);
      }
    } else if (data === "refresh_trending") {
      const combinedKeyboard = await getTrendingKeyboard();
      const text = `🔥 <b>HOT TOPICS</b>\n\nChoose a topic to explore channels 👇`;
      const opts = {
        parse_mode: "HTML",
        reply_markup: combinedKeyboard,
      };
      if (messageId) {
        await editMessageTextSafe(chatId, messageId, text, opts);
      } else {
        await sendMessageSafe(chatId, text, opts);
      }
    } else if (data === "menu") {
      const combinedKeyboard = await getTrendingKeyboard();
      const text = `🔥 <b>HOT TOPICS</b>\n\nChoose a topic to explore channels 👇`;
      const opts = {
        parse_mode: "HTML",
        reply_markup: combinedKeyboard,
      };
      if (messageId) {
        await editMessageTextSafe(chatId, messageId, text, opts);
      } else {
        await sendMessageSafe(chatId, text, opts);
      }
    } else if (data === "confirm_clear_history") {
        if (query.message && query.message.message_id) {
          trackMessage(chatId, query.message.message_id);
        }
        clearUserSearchHistory(chatId);
        await clearUserHistory(chatId);

        const combinedKeyboard = await getTrendingKeyboard();
        await sendMessageSafe(chatId,
          `🔥 <b>HOT TOPICS</b>\n\nChoose a topic to explore channels 👇`,
          {
            parse_mode: "HTML",
            reply_markup: combinedKeyboard,
          }
        );
        await sendMessageSafe(chatId,
          `✨ <b>Fresh session started!</b>`,
          {
            parse_mode: "HTML",
            reply_markup: getPersistentNavigationKeyboard()
          }
        );
      } else if (data === "cancel_clear_history") {
        if (query.message && query.message.message_id) {
          try {
            await bot.deleteMessage(chatId, query.message.message_id);
          } catch (e) {}
        }
        await sendMessageSafe(chatId,
          `❌ History clearing cancelled.`,
          {
            parse_mode: "HTML",
            reply_markup: getPersistentNavigationKeyboard()
          }
        );
      }
  } catch (err) {
    console.error("❌ Error handling callback_query:", err.message);
  }
});

// ============================
// 💬 MESSAGES & NAVIGATION KEYBOARD
// ============================
bot.on("message", async (msg) => {
  try {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (msg.message_id) trackMessage(chatId, msg.message_id);
    if (!text) return;

    if (text === "🏠 Home") {
      const combinedKeyboard = await getTrendingKeyboard();

      await sendMessageSafe(chatId,
        `🔥 <b>HOT TOPICS</b>\n\nChoose a topic to explore channels 👇`,
        {
          parse_mode: "HTML",
          reply_markup: combinedKeyboard,
        }
      );
      return;
    }

    if (text === "ℹ️ About") {
      const aboutText =
        `ℹ️ <b>About NexaHub</b>\n\n` +
        `NexaHub is a fast, intelligent Telegram resource search engine.\n\n` +
        `• Send any keyword to search groups, channels, and videos.\n` +
        `• Explore Hot Topics, Trending searches, and Breaking News.\n` +
        `• Access featured media & direct channel links instantly.`;

      await sendMessageSafe(chatId, aboutText, {
        parse_mode: "HTML",
        reply_markup: getPersistentNavigationKeyboard()
      });
      return;
    }

    if (text === "🗑️ History" || text === "🗑️ Clear History") {
      const confirmText =
        `⚠️ <b>Clear Chat History?</b>\n\n` +
        `This will remove the recent NexaHub messages from this conversation and start a fresh session.\n\n` +
        `Are you sure?`;

      await sendMessageSafe(chatId, confirmText, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Yes, Clear", callback_data: "confirm_clear_history" },
              { text: "❌ Cancel", callback_data: "cancel_clear_history" }
            ]
          ]
        }
      });
      return;
    }

    if (text.startsWith("/")) return;

    await renderSearchResults(chatId, text);
  } catch (err) {
    console.error("❌ Error handling message:", err.message);
  }
});

// ============================
// 🚀 SINGLE-PROCESS INIT
// ============================
if (isMainModule) {
  startScraperScheduler();
  console.log("✅ NewsSearch Main Bot is running...");
  console.log("🔗 Channels shown directly in main bot!");
}

module.exports = {
  searchResources,
  CHANNELS,
  FEATURED_RESOURCES,
  truncateUTF8,
  makeSearchCallbackData,
  escapeHTML,
  translateText,
  getMainKeyboard,
  getTrendingKeyboard,
  getPersistentKeyboard,
  getPersistentNavigationKeyboard,
  getFeaturedPosts,
  getFeaturedChannels,
  renderFeaturedCardPosts,
  renderFeaturedChannelPosts,
  clearUserHistory,
  videoFileIdCache,
  saveVideoCache,
  getCachedFileId,
  acquireUserLock,
  releaseUserLock,
};

