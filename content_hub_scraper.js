const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const crypto = require("crypto");

const CACHE_FILE = path.join(__dirname, "content_hub_cache.json");
const TMP_CACHE_FILE = path.join(__dirname, "content_hub_cache.tmp.json");
const DATASET_FILE = path.join(__dirname, "content_hub_dataset.json");
const SYNC_INTERVAL_MS = 600000; // 10 minutes (600,000 ms)
const DEFAULT_URL = "https://majorlink3.com/";

const CATEGORY_CONFIG = [
  {
    id: "adult_broadcast",
    title: "성인방송",
    icon: "🔞",
    matchPatterns: ["성인방송", "/성인방송"],
    defaultDescription: "실시간 라이브 방송 플랫폼"
  },
  {
    id: "community",
    title: "인기커뮤니티",
    icon: "💬",
    matchPatterns: ["인기커뮤니티", "커뮤니티", "/커뮤니티"],
    defaultDescription: "인기 인터넷 커뮤니티 및 정보 포털"
  },
  {
    id: "ai_tools",
    title: "AI 도구",
    icon: "🤖",
    matchPatterns: ["AI 도구", "AI도구", "/AI도구"],
    defaultDescription: "인공지능 도구 및 생산성 솔루션"
  },
  {
    id: "utilities",
    title: "유틸/도구",
    icon: "🛠️",
    matchPatterns: ["유틸/도구", "유틸-도구", "/유틸-도구", "유틸도구"],
    defaultDescription: "온라인 웹 유틸리티 및 변환 도구"
  },
  {
    id: "overseas_shopping",
    title: "해외직구",
    icon: "🛍️",
    matchPatterns: ["해외직구", "/해외직구"],
    defaultDescription: "글로벌 전자상거래 및 쇼핑 플랫폼"
  },
  {
    id: "psychology",
    title: "심리",
    icon: "🧠",
    matchPatterns: ["심리", "/심리"],
    defaultDescription: "성격 및 심리 분석 테스트"
  },
  {
    id: "dating",
    title: "미팅/연애",
    icon: "💘",
    matchPatterns: ["미팅/연애", "미팅-연애", "/미팅-연애", "미팅연애"],
    defaultDescription: "소셜 매칭 및 데이팅 서비스"
  },
  {
    id: "korean_diaspora",
    title: "한인교민",
    icon: "🌏",
    matchPatterns: ["한인교민", "/한인교민"],
    defaultDescription: "해외 교민 커뮤니티 및 생활 정보 포털"
  }
];

let inMemoryDataset = null;
let currentDatasetHash = "";
let syncTimer = null;
let isSyncing = false;

function decodeHtmlEntities(str) {
  if (!str) return "";
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function generateItemId(name, url, index) {
  const cleanName = name
    .toLowerCase()
    .replace(/\[[^\]]+\]/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "_");
  
  if (cleanName && cleanName.length >= 2) {
    return cleanName.slice(0, 30);
  }
  
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "").split(".")[0];
    if (host && host.length >= 2) return host;
  } catch (e) {}

  return `item_${index + 1}`;
}

function loadFallbackDataset() {
  try {
    if (fs.existsSync(DATASET_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATASET_FILE, "utf8"));
      if (data && Array.isArray(data.categories) && data.categories.length > 0) {
        return data;
      }
    }
  } catch (err) {
    console.error("[ContentHub] Error reading fallback dataset:", err.message);
  }
  return { version: "1.0.0", updated_at: new Date().toISOString(), categories: [] };
}

function loadCachedDataset() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      if (validateDataset(data)) {
        return data;
      }
    }
  } catch (err) {
    console.error("[ContentHub] Error reading cache file:", err.message);
  }
  return null;
}

function isValidUrl(url) {
  if (!url || typeof url !== "string") return false;
  const trimmed = url.trim();
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) return false;
  if (trimmed.startsWith("javascript:") || trimmed.startsWith("#") || trimmed.includes("javascript:")) return false;
  try {
    const parsed = new URL(trimmed);
    if (!parsed.hostname || parsed.hostname.length < 3 || !parsed.hostname.includes(".")) return false;
    return true;
  } catch (e) {
    return false;
  }
}

function calculateHash(dataset) {
  if (!dataset || !Array.isArray(dataset.categories)) return "";
  const normalized = dataset.categories.map(c => ({
    id: c.id,
    title: c.title,
    items: (c.items || []).map(it => ({
      id: it.id,
      name: it.name,
      url: it.url,
      sub_items: Array.isArray(it.sub_items) ? it.sub_items.map(s => ({ id: s.id, name: s.name, url: s.url })) : []
    }))
  }));
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function validateDataset(dataset) {
  if (!dataset || typeof dataset !== "object") return false;
  if (!Array.isArray(dataset.categories) || dataset.categories.length < 4) {
    return false;
  }

  let totalItems = 0;
  const categoryIds = new Set();

  for (const cat of dataset.categories) {
    if (!cat.id || !cat.title || typeof cat.id !== "string" || typeof cat.title !== "string") {
      return false;
    }
    if (categoryIds.has(cat.id)) return false;
    categoryIds.add(cat.id);

    if (!Array.isArray(cat.items) || cat.items.length === 0) {
      return false;
    }

    const itemIds = new Set();
    const itemUrls = new Set();

    for (const item of cat.items) {
      if (!item.name || !item.url || typeof item.name !== "string" || typeof item.url !== "string") {
        return false;
      }
      if (!isValidUrl(item.url)) {
        return false;
      }
      if (itemUrls.has(item.url)) {
        return false;
      }
      itemUrls.add(item.url);
      itemIds.add(item.id || item.name);

      if (Array.isArray(item.sub_items)) {
        const subUrls = new Set();
        for (const sub of item.sub_items) {
          if (!sub.name || !sub.url || typeof sub.name !== "string" || typeof sub.url !== "string") {
            return false;
          }
          if (!isValidUrl(sub.url)) {
            return false;
          }
          if (subUrls.has(sub.url)) {
            return false;
          }
          subUrls.add(sub.url);
        }
      }

      totalItems++;
    }
  }

  // Minimum threshold check to prevent saving truncated or empty scrapes
  if (totalItems < 30) {
    return false;
  }

  return true;
}

function saveCacheAtomic(dataset) {
  try {
    const payload = JSON.stringify(dataset, null, 2);
    fs.writeFileSync(TMP_CACHE_FILE, payload, "utf8");

    // Validate written tmp file
    const verified = JSON.parse(fs.readFileSync(TMP_CACHE_FILE, "utf8"));
    if (!validateDataset(verified)) {
      throw new Error("Temporary cache validation failed");
    }

    fs.renameSync(TMP_CACHE_FILE, CACHE_FILE);
    return true;
  } catch (err) {
    console.error("[ContentHub] Atomic cache write failed:", err.message);
    try {
      if (fs.existsSync(TMP_CACHE_FILE)) fs.unlinkSync(TMP_CACHE_FILE);
    } catch (e) {}
    return false;
  }
}

function parseHtml(html, fallbackData = null) {
  if (!html || typeof html !== "string") return null;

  const fallbackMap = new Map();
  if (fallbackData && Array.isArray(fallbackData.categories)) {
    for (const cat of fallbackData.categories) {
      if (Array.isArray(cat.items)) {
        for (const it of cat.items) {
          fallbackMap.set(`${cat.id}:${it.name}`, it);
          fallbackMap.set(`${cat.id}:${it.url}`, it);
        }
      }
    }
  }

  const parsedCategories = [];

  for (const conf of CATEGORY_CONFIG) {
    let catIdx = -1;
    for (const pat of conf.matchPatterns) {
      const idx = html.indexOf(pat);
      if (idx !== -1) {
        catIdx = idx;
        break;
      }
    }

    if (catIdx === -1) {
      // If a category is not found in HTML, try to retain from fallback dataset
      if (fallbackData && Array.isArray(fallbackData.categories)) {
        const existing = fallbackData.categories.find(c => c.id === conf.id);
        if (existing) {
          parsedCategories.push(existing);
        }
      }
      continue;
    }

    // Find bounding container around category header
    const startChunk = html.lastIndexOf("<div class=\"link_box", catIdx) !== -1
      ? html.lastIndexOf("<div class=\"link_box", catIdx)
      : Math.max(0, catIdx - 200);

    const chunk = html.substring(startChunk, startChunk + 4500);

    // Extract all <a> tags
    const aRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let aMatch;
    const categoryItems = [];
    const seenUrls = new Set();
    const seenIds = new Set();
    let itemIdx = 0;

    while ((aMatch = aRegex.exec(chunk)) !== null) {
      let href = aMatch[1].trim();
      let rawText = aMatch[2].replace(/<[^>]+>/g, "").trim();

      // Check if text is in img alt
      if (!rawText && aMatch[2].includes("img")) {
        const altMatch = aMatch[2].match(/alt=["']([^"']+)["']/i);
        rawText = altMatch ? altMatch[1] : "";
      }

      rawText = decodeHtmlEntities(rawText);

      // Filter out empty, pagination, navigation, or internal directory anchors
      if (!rawText || rawText === "[+]" || rawText === "전체보기" || rawText === "더보기") {
        continue;
      }
      if (!href || href === "#" || href.startsWith("javascript:") || href.startsWith("/") && !href.startsWith("/postact/")) {
        continue;
      }

      // If next category header reached, break
      const isNextCategoryHeader = CATEGORY_CONFIG.some(
        c => c.id !== conf.id && (rawText === c.title || rawText === `[+]` && href.includes(c.id))
      );
      if (isNextCategoryHeader && categoryItems.length >= 5) {
        break;
      }

      // Normalize URL
      let validUrl = href;
      if (!validUrl.startsWith("http://") && !validUrl.startsWith("https://")) {
        continue;
      }

      if (seenUrls.has(validUrl)) {
        continue;
      }
      seenUrls.add(validUrl);

      // Match fallback metadata for stable ID and rich description
      const matchedFallback = fallbackMap.get(`${conf.id}:${rawText}`) || fallbackMap.get(`${conf.id}:${validUrl}`);
      let itemId = matchedFallback ? matchedFallback.id : generateItemId(rawText, validUrl, itemIdx);
      let desc = (matchedFallback && matchedFallback.description) ? matchedFallback.description : conf.defaultDescription;
      const subItems = (matchedFallback && Array.isArray(matchedFallback.sub_items)) ? matchedFallback.sub_items : [];

      // Ensure item ID uniqueness within category
      if (seenIds.has(itemId)) {
        itemId = `${itemId}_${itemIdx + 1}`;
      }
      seenIds.add(itemId);

      categoryItems.push({
        id: itemId,
        name: rawText,
        url: validUrl,
        description: desc,
        ...(subItems.length > 0 ? { sub_items: subItems } : {})
      });

      itemIdx++;
    }

    // If parsed items are found, add category
    if (categoryItems.length > 0) {
      parsedCategories.push({
        id: conf.id,
        title: conf.title,
        icon: conf.icon,
        items: categoryItems
      });
    } else if (fallbackData && Array.isArray(fallbackData.categories)) {
      const existing = fallbackData.categories.find(c => c.id === conf.id);
      if (existing) {
        parsedCategories.push(existing);
      }
    }
  }

  if (parsedCategories.length === 0) {
    return null;
  }

  return {
    version: "1.0.0",
    updated_at: new Date().toISOString(),
    categories: parsedCategories
  };
}

function fetchUrl(targetUrl = DEFAULT_URL, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    try {
      const parsedUrl = new URL(targetUrl);
      const client = parsedUrl.protocol === "https:" ? https : http;

      const req = client.get(targetUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7"
        },
        timeout: timeoutMs
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(fetchUrl(res.headers.location, timeoutMs));
        }

        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }

        let data = "";
        res.on("data", chunk => (data += chunk));
        res.on("end", () => resolve(data));
      });

      req.on("error", err => reject(err));
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Request timeout"));
      });
    } catch (e) {
      reject(e);
    }
  });
}

async function syncContentHub() {
  if (isSyncing) return inMemoryDataset;
  isSyncing = true;

  console.log("[ContentHub] Sync started");

  try {
    const html = await fetchUrl(DEFAULT_URL);
    const parsed = parseHtml(html, inMemoryDataset || loadFallbackDataset());

    if (!parsed || !validateDataset(parsed)) {
      console.warn("[ContentHub] Rejecting incomplete sync; retaining previous cache.");
      isSyncing = false;
      return inMemoryDataset;
    }

    const newHash = calculateHash(parsed);
    const totalItems = parsed.categories.reduce((acc, c) => acc + (c.items ? c.items.length : 0), 0);

    if (newHash !== currentDatasetHash) {
      const saved = saveCacheAtomic(parsed);
      if (saved) {
        inMemoryDataset = parsed;
        currentDatasetHash = newHash;
        console.log(`[ContentHub] Sync successful: categories=${parsed.categories.length} items=${totalItems}`);
        parsed.categories.forEach(c => {
          console.log(`[ContentHub] Category "${c.title}": ${c.items.length} items`);
        });
        console.log("[ContentHub] Cache updated");
      }
    } else {
      console.log("[ContentHub] No directory changes detected.");
    }
  } catch (err) {
    console.error(`[ContentHub] Sync failed: ${err.message}; retaining previous cache.`);
  } finally {
    isSyncing = false;
    console.log(`[ContentHub] Next sync in 10 minutes`);
  }

  return inMemoryDataset;
}

function initContentHub() {
  // 1. Try to load cached dataset first
  const cached = loadCachedDataset();
  if (cached) {
    inMemoryDataset = cached;
    currentDatasetHash = calculateHash(cached);
    console.log(`[ContentHub] Loaded cached dataset: categories=${cached.categories.length}`);
  } else {
    // 2. Fallback to bundled dataset
    const fallback = loadFallbackDataset();
    inMemoryDataset = fallback;
    currentDatasetHash = calculateHash(fallback);
    console.log(`[ContentHub] Loaded default fallback dataset: categories=${fallback.categories.length}`);
  }

  return inMemoryDataset;
}

function startContentHubScheduler() {
  if (syncTimer) return;
  initContentHub();

  // Run initial sync asynchronously
  syncContentHub().catch(err => {
    console.error("[ContentHub] Initial sync error:", err.message);
  });

  syncTimer = setInterval(() => {
    syncContentHub().catch(err => {
      console.error("[ContentHub] Periodic sync error:", err.message);
    });
  }, SYNC_INTERVAL_MS);

  console.log(`[ContentHub] Directory sync scheduler started (Interval: ${SYNC_INTERVAL_MS / 1000}s)`);
}

function stopContentHubScheduler() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
    console.log("[ContentHub] Directory sync scheduler stopped");
  }
}

function getDataset() {
  if (!inMemoryDataset) {
    initContentHub();
  }
  return inMemoryDataset;
}

function getCategories() {
  const data = getDataset();
  return (data && Array.isArray(data.categories)) ? data.categories : [];
}

function getCategoryById(catId) {
  const cats = getCategories();
  return cats.find(c => c.id === catId) || null;
}

function getItemById(catId, itemId) {
  const cat = getCategoryById(catId);
  if (!cat || !Array.isArray(cat.items)) return null;
  return cat.items.find(it => it.id === itemId) || null;
}

module.exports = {
  initContentHub,
  syncContentHub,
  startContentHubScheduler,
  stopContentHubScheduler,
  getDataset,
  getCategories,
  getCategoryById,
  getItemById,
  parseHtml,
  validateDataset,
  calculateHash,
  saveCacheAtomic,
  isValidUrl,
  SYNC_INTERVAL_MS,
  CACHE_FILE,
  TMP_CACHE_FILE,
  DATASET_FILE,
  CATEGORY_CONFIG
};
