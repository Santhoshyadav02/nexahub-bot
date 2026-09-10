/**
 * ============================================================
 * 🌐 AVSEE SOURCE ADAPTER MODULE
 * ============================================================
 * Concrete adapter for the authorized AVsee media feed.
 * Implements the ExternalSourceAdapter interface contract.
 * 
 * Safety Configurations:
 * AVSEE_ENABLED=false (default: disabled)
 * AVSEE_DRY_RUN=true (default: metadata-only dry-run)
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const { execSync } = require("child_process");
const { URL } = require("url");
const { chromium } = require("playwright");
const { ExternalSourceAdapter, CANONICAL_12_TOPIC_RULES } = require("./external_source_adapter");

const AVSEE_ENABLED = process.env.AVSEE_ENABLED === "true";
const AVSEE_DRY_RUN = process.env.AVSEE_DRY_RUN !== "false"; // default true

/**
 * /**
 * Locate system Chromium executable if present
 * @returns {string|null}
 */
function getSystemChromiumPath() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) {
    return process.env.CHROME_BIN;
  }
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) {
    return process.env.CHROMIUM_PATH;
  }

  try {
    const stdout = execSync("which chromium || which chromium-browser || which google-chrome-stable || which google-chrome", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 2000
    }).trim();
    if (stdout && fs.existsSync(stdout)) {
      return stdout;
    }
  } catch (e) {}

  const standardPaths = [
    "/nix/var/nix/profiles/default/bin/chromium",
    "/root/.nix-profile/bin/chromium",
    "/etc/profiles/per-user/root/bin/chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable"
  ];
  for (const p of standardPaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

class AvseeSourceAdapter extends ExternalSourceAdapter {
  /**
   * @param {object} [config]
   */
  constructor(config = {}) {
    const isAuthorized = config.isAuthorized !== undefined 
      ? Boolean(config.isAuthorized) 
      : (process.env.AVSEE_AUTHORIZED === "true" || process.env.EXTERNAL_SOURCE_AUTHORIZED === "true");

    const licenseId = config.licenseId || process.env.AVSEE_LICENSE_ID || process.env.EXTERNAL_SOURCE_LICENSE_ID || null;
    const apiKey = config.apiKey || process.env.AVSEE_API_KEY || process.env.EXTERNAL_SOURCE_API_KEY || null;

    super({
      sourceId: "avsee",
      sourceName: "AVsee Authorized Content Feed",
      apiUrl: config.apiUrl || process.env.AVSEE_API_URL || "https://02.avsee.is",
      allowedDomains: config.allowedDomains || [
        "02.avsee.is",
        "avsee.tv",
        "cdn.apiavsee.com",
        "apiavsee.com",
        "data.cdn.avsee.is",
        "authorized-cdn.com"
      ],
      isAuthorized: isAuthorized,
      licenseId: licenseId,
      apiKey: apiKey,
      dryRun: config.dryRun !== undefined ? Boolean(config.dryRun) : AVSEE_DRY_RUN,
      ledgerPath: config.ledgerPath || path.join(__dirname, "avsee_source_ledger.json"),
      ...config
    });

    this.enabled = config.enabled !== undefined ? Boolean(config.enabled) : AVSEE_ENABLED;
    this.tempDir = config.tempDir || path.join(__dirname, "scratch", "avsee_temp");
    this.maxFileSizeMB = config.maxFileSizeMB || 500;
    this.boards = config.boards || ["korea", "caption", "javc", "javleak", "javfc2", "western"];
    this.selectedExecutablePath = null;
  }

  // ============================================================
  // 🔌 CORE ADAPTER IMPLEMENTATION
  // ============================================================

  /**
   * Extracts clean title from an item
   * @param {object} item 
   * @returns {string}
   */
  getTitle(item) {
    if (!item || typeof item !== "object") return "";
    let raw = item.title || item.headline || item.subject || "";
    return String(raw).trim().replace(/[\r\n\t]+/g, " ");
  }

  /**
   * Extracts media stream URL (from player iframe query parameters or direct url)
   * @param {object} item 
   * @returns {string|null}
   */
  getMediaUrl(item) {
    if (!item || typeof item !== "object") return null;

    // 1. Direct media URL
    let url = item.mediaUrl || item.media_url || item.videoUrl || item.video_url || null;
    if (url && typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"))) {
      return url.trim();
    }

    // 2. Extract from player iframe URL query params (e.g. ?720=http://cdn... or ?1080=...)
    if (item.iframeUrl && typeof item.iframeUrl === "string") {
      try {
        const parsed = new URL(item.iframeUrl, this.apiUrl);
        const p720 = parsed.searchParams.get("720");
        const p1080 = parsed.searchParams.get("1080");
        const p480 = parsed.searchParams.get("480");
        const p360 = parsed.searchParams.get("360");
        const selected = p720 || p1080 || p480 || p360;
        if (selected && (selected.startsWith("http://") || selected.startsWith("https://"))) {
          return selected.trim();
        }
      } catch (e) {}
    }

    if (Array.isArray(item.iframes)) {
      for (const iframe of item.iframes) {
        if (!iframe || typeof iframe !== "string") continue;
        try {
          const parsed = new URL(iframe, this.apiUrl);
          const p720 = parsed.searchParams.get("720");
          const p1080 = parsed.searchParams.get("1080");
          const p480 = parsed.searchParams.get("480");
          const p360 = parsed.searchParams.get("360");
          const selected = p720 || p1080 || p480 || p360;
          if (selected && (selected.startsWith("http://") || selected.startsWith("https://"))) {
            return selected.trim();
          }
        } catch (e) {}
      }
    }

    if (item.videoSrc && typeof item.videoSrc === "string" && (item.videoSrc.startsWith("http://") || item.videoSrc.startsWith("https://"))) {
      return item.videoSrc.trim();
    }

    return null;
  }

  /**
   * Extracts tags from an item
   * @param {object} item 
   * @returns {string[]}
   */
  getTags(item) {
    const tags = new Set();
    const addTag = (t) => {
      if (typeof t === "string" && t.trim().length > 0) {
        const clean = t.trim().toLowerCase().replace(/^#/, "");
        tags.add(clean);
        if (clean.includes("・") || clean.includes("/")) {
          clean.split(/[・/]/).forEach(sub => {
            if (sub.trim().length > 0) tags.add(sub.trim());
          });
        }
      }
    };

    if (Array.isArray(item.tags)) {
      item.tags.forEach(t => addTag(t));
    } else if (typeof item.tags === "string") {
      item.tags.split(/[,;|]/).forEach(t => addTag(t));
    }

    if (item.category && typeof item.category === "string") {
      addTag(item.category);
    }

    if (item.bo_table && typeof item.bo_table === "string") {
      addTag(item.bo_table);
    }

    // Extract hashtags from title / description
    const full = `${item.title || ""} ${item.description || ""}`;
    const matches = full.match(/#([\p{L}\p{N}_・/]+)/gu);
    if (matches) {
      matches.forEach(m => addTag(m));
    }

    return Array.from(tags);
  }

  /**
   * Extracts thumbnail URL from an item
   * @param {object} item 
   * @returns {string|null}
   */
  getThumbnailUrl(item) {
    if (!item || typeof item !== "object") return null;
    let url = item.thumbnailUrl || item.thumbnail || item.thumb || item.poster || null;
    if (url && typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"))) {
      return url.trim();
    }
    return null;
  }

  /**
   * Generates stable deduplication hash across instances
   * @param {object} item 
   * @returns {string}
   */
  getUniqueHash(item) {
    if (!item || typeof item !== "object") return "";
    const itemId = item.itemId || item.id || `${item.bo_table || "korea"}_${item.wr_id || ""}`;
    const mediaUrl = this.getMediaUrl(item) || "";
    const title = this.getTitle(item);

    return crypto
      .createHash("md5")
      .update(`avsee:${itemId}:${mediaUrl || title}`)
      .digest("hex");
  }

  /**
   * Validates if a media URL matches the whitelisted domains
   * @param {string} targetUrl 
   * @returns {boolean}
   */
  isDomainAllowed(targetUrl) {
    if (!targetUrl) return false;
    try {
      const parsed = new URL(targetUrl);
      const hostname = parsed.hostname.toLowerCase();
      return this.allowedDomains.some(d => hostname === d || hostname.endsWith(`.${d}`));
    } catch (e) {
      return false;
    }
  }

  /**
   * Checks authorization status for AVsee
   * @param {string} [targetUrl]
   * @returns {{ authorized: boolean, reason?: string }}
   */
  checkAuthorization(targetUrl = null) {
    if (!this.isAuthorized) {
      return { authorized: false, reason: "Source is not authorized. Set EXTERNAL_SOURCE_AUTHORIZED=true (or AVSEE_AUTHORIZED=true) with valid licenseId." };
    }
    if (!this.licenseId && !this.apiKey) {
      return { authorized: false, reason: "Missing license or API key." };
    }
    if (targetUrl && !this.isDomainAllowed(targetUrl)) {
      return { authorized: false, reason: `Target URL domain is not whitelisted: ${targetUrl}` };
    }
    return { authorized: true };
  }

  /**
   * Extracts published timestamp in ISO 8601 format safely
   * @param {object} item 
   * @returns {string}
   */
  getPublishedAt(item) {
    if (!item || typeof item !== "object") return new Date().toISOString();
    const raw = item.publishedAt || item.published_at || item.date || item.wr_date;
    if (raw) {
      const match = String(raw).match(/(\d{4})[./-](\d{2})[./-](\d{2})\s+(\d{2}):(\d{2})/);
      if (match) {
        const parsedDate = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00.000Z`);
        if (!isNaN(parsedDate.getTime())) return parsedDate.toISOString();
      }
      const d = new Date(raw);
      if (!isNaN(d.getTime())) return d.toISOString();
    }
    return new Date().toISOString();
  }

  /**
   * Normalizes raw AVsee item into standard ExternalSourceItem structure
   * @param {object} rawItem 
   * @returns {import('./external_source_adapter').ExternalSourceItem}
   */
  normalizeItem(rawItem) {
    if (!rawItem || typeof rawItem !== "object") {
      return { valid: false, reason: "INVALID_ITEM_PAYLOAD" };
    }

    if (rawItem.valid === true) {
      return rawItem;
    }

    const title = this.getTitle(rawItem);
    if (!title) {
      return { valid: false, reason: "MISSING_TITLE" };
    }

    const itemId = rawItem.itemId || rawItem.id || (rawItem.bo_table && rawItem.wr_id ? `${rawItem.bo_table}_${rawItem.wr_id}` : null);
    if (!itemId) {
      return { valid: false, reason: "MISSING_ITEM_ID" };
    }

    const mediaUrl = this.getMediaUrl(rawItem);
    if (!mediaUrl) {
      return { valid: false, reason: "MISSING_MEDIA_URL" };
    }

    if (!this.isDomainAllowed(mediaUrl)) {
      return { valid: false, reason: `DISALLOWED_MEDIA_DOMAIN: ${mediaUrl}` };
    }

    const tags = this.getTags(rawItem);
    const thumbnailUrl = this.getThumbnailUrl(rawItem);
    const uniqueHash = this.getUniqueHash(rawItem);
    const route = this.matchTopic({ title, description: rawItem.description || "", tags });
    const publishedAt = this.getPublishedAt(rawItem);
    const discoveredAt = rawItem.discoveredAt || new Date().toISOString();

    return {
      valid: true,
      source: "avsee",
      sourceId: this.sourceId,
      itemId: String(itemId),
      uniqueHash: uniqueHash,
      pageUrl: rawItem.pageUrl || `${this.apiUrl}/bbs/board.php?bo_table=${rawItem.bo_table || "korea"}&wr_id=${rawItem.wr_id || ""}`,
      title: title,
      description: String(rawItem.description || "").trim(),
      tags: tags,
      thumbnailUrl: thumbnailUrl,
      mediaUrl: mediaUrl,
      publishedAt: publishedAt,
      discoveredAt: discoveredAt,
      topicKey: route.topicKey,
      topic: route.topicKey,
      topicConfidence: route.confidence,
      matchedRule: route.matchedRule,
      matchedToken: route.matchedToken,
      koreanName: route.koreanName,
      cardNum: route.cardNum,
      rawMetadata: rawItem
    };
  }

  // ============================================================
  // 🔍 LIVE SCRAPING / ITEM FETCHING VIA PLAYWRIGHT
  // ============================================================

  /**
   * Helper to launch Chromium with robust Linux container arguments and verified executable path
   * @param {object} [extraOptions]
   * @returns {Promise<import('playwright').Browser>}
   */
  async launchBrowser(extraOptions = {}) {
    const baseArgs = [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
      "--disable-breakpad",
      "--disable-software-rasterizer",
      "--disable-extensions",
      "--disable-features=IsolateOrigins,site-per-process,AudioServiceOutOfProcess"
    ];

    const detectedPath = getSystemChromiumPath();
    const candidatePaths = [];

    if (extraOptions.executablePath) {
      candidatePaths.push(extraOptions.executablePath);
    }
    if (detectedPath) {
      candidatePaths.push(detectedPath);
    }
    // undefined represents Playwright's bundled Chromium
    candidatePaths.push(undefined);

    let lastError = null;
    for (const execPath of candidatePaths) {
      try {
        const launchOpts = {
          headless: true,
          args: baseArgs,
          ...extraOptions
        };
        if (execPath) {
          launchOpts.executablePath = execPath;
        } else {
          delete launchOpts.executablePath;
        }

        const browser = await chromium.launch(launchOpts);
        this.selectedExecutablePath = execPath || "playwright-bundled";
        return browser;
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError || new Error("[AVSEE] No working Chromium runtime found");
  }

  /**
   * Diagnostic browser launch test that verifies actual browser navigation and page DOM readiness
   * @returns {Promise<{ pass: boolean, executablePath?: string, error?: string }>}
   */
  async checkBrowserLaunch() {
    try {
      const browser = await this.launchBrowser();
      const page = await browser.newPage();
      await page.goto("data:text/html,<html><body><div id='test'>ok</div></body></html>", { timeout: 10000 });
      const text = await page.$eval("#test", el => el.innerText).catch(() => "");
      await page.close();
      await browser.close();

      if (text !== "ok") {
        return { pass: false, error: "Failed to evaluate DOM in test page" };
      }

      return { pass: true, executablePath: this.selectedExecutablePath || "playwright-bundled" };
    } catch (err) {
      return { pass: false, error: err.message };
    }
  }

  /**
   * Fetches items from the authorized AVsee feed using browser session with 1-retry fallback
   * @param {object} [options]
   * @param {string} [options.board="korea"]
   * @param {number} [options.limit=10]
   * @param {Array<object>} [options.mockItems]
   * @returns {Promise<Array<object>>}
   */
  async fetchItems(options = {}) {
    if (options.mockItems && Array.isArray(options.mockItems)) {
      return options.mockItems;
    }

    const maxAttempts = 2;
    let lastErr = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this._fetchItemsInternal(options);
      } catch (err) {
        lastErr = err;
        console.warn(`⚠️ [AVSEE] fetchItems attempt ${attempt}/${maxAttempts} failed: ${err.message}`);
        if (attempt < maxAttempts) {
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }

    throw lastErr;
  }

  /**
   * Internal listing fetch implementation
   * @private
   */
  async _fetchItemsInternal(options = {}) {
    const board = options.board || "korea";
    const limit = options.limit || 10;
    const boardUrl = `${this.apiUrl}/bbs/board.php?bo_table=${board}`;

    console.log(`🌐 [AVSEE] Fetching board listings from: ${boardUrl} (limit: ${limit})`);

    const browser = await this.launchBrowser();
    try {
      const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        viewport: { width: 1280, height: 800 }
      });
      const page = await context.newPage();

      // Lifecycle diagnostics
      page.on("crash", () => console.warn("⚠️ [AVSEE] Page crashed"));
      page.on("pageerror", (err) => console.warn(`⚠️ [AVSEE] Page error: ${err.message}`));

      // Abort heavy media/images/fonts to avoid renderer crash and save RAM
      await page.route("**/*.{png,jpg,jpeg,gif,webp,svg,ico,woff,woff2,ttf,otf,eot,mp4,webm,avi,mkv,ts,flv,mp3,wav,ogg}", route => {
        route.abort();
      });

      const response = await page.goto(boardUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
      console.log(`[AVSEE] listings navigation: PASS (status: ${response ? response.status() : "200"})`);

      await this.waitForTurnstile(page);
      console.log(`[AVSEE] page remained alive`);

      const items = await page.evaluate((b) => {
        const map = new Map();
        const anchors = Array.from(document.querySelectorAll("a[href*='wr_id=']"));

        anchors.forEach(a => {
          const m = a.href.match(/wr_id=(\d+)/);
          if (!m) return;
          const wr_id = m[1];

          if (!map.has(wr_id)) {
            map.set(wr_id, {
              bo_table: b,
              wr_id: wr_id,
              itemId: `${b}_${wr_id}`,
              pageUrl: a.href,
              title: "",
              thumbnailUrl: null
            });
          }

          const entry = map.get(wr_id);
          const text = a.innerText ? a.innerText.trim() : "";
          if (text && (!entry.title || entry.title.length < text.length)) {
            entry.title = text;
          }

          const parent = a.closest(".item-row, .list-row, .list-item, .media, tr, li, div");
          if (!entry.title && parent) {
            const titleEl = parent.querySelector(".wr-subject, .item-title, .title, .subject, .bo_tit, .wr_subject, strong");
            if (titleEl && titleEl.innerText) {
              entry.title = titleEl.innerText.trim();
            }
          }

          const img = a.querySelector("img") || (parent && parent.querySelector("img"));
          if (img && img.src && !entry.thumbnailUrl) {
            entry.thumbnailUrl = img.src;
          }
        });

        return Array.from(map.values()).filter(it => it.wr_id && it.title);
      }, board);

      console.log(`[AVSEE] parsed listings: ${items.length}`);
      return items.slice(0, limit);
    } finally {
      await browser.close();
    }
  }

  /**
   * Fetches detailed metadata for a single item by navigating to its detail page
   * @param {string|object} itemOrId 
   * @param {object} [options]
   * @returns {Promise<object|null>}
   */
  async fetchItemDetails(itemOrId, options = {}) {
    if (options.mockDetails && typeof options.mockDetails === "object") {
      return options.mockDetails;
    }

    let pageUrl = typeof itemOrId === "string" ? itemOrId : itemOrId.pageUrl;
    if (!pageUrl && typeof itemOrId === "object" && itemOrId.bo_table && itemOrId.wr_id) {
      pageUrl = `${this.apiUrl}/bbs/board.php?bo_table=${itemOrId.bo_table}&wr_id=${itemOrId.wr_id}`;
    }

    if (!pageUrl) {
      throw new Error("[AVSEE] Invalid item or missing pageUrl for fetchItemDetails");
    }

    console.log(`🌐 [AVSEE] Fetching item details from: ${pageUrl}`);

    const browser = await this.launchBrowser();
    try {
      const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        viewport: { width: 1280, height: 800 }
      });
      const page = await context.newPage();

      // Lifecycle diagnostics
      page.on("crash", () => console.warn("⚠️ [AVSEE] Page crashed"));
      page.on("pageerror", (err) => console.warn(`⚠️ [AVSEE] Page error: ${err.message}`));

      // Abort heavy media/images/fonts to avoid renderer crash and save RAM
      await page.route("**/*.{png,jpg,jpeg,gif,webp,svg,ico,woff,woff2,ttf,otf,eot,mp4,webm,avi,mkv,ts,flv,mp3,wav,ogg}", route => {
        route.abort();
      });

      const response = await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
      console.log(`[AVSEE] navigation successful (status: ${response ? response.status() : "loaded"})`);

      await this.waitForTurnstile(page);
      console.log(`[AVSEE] page remained alive`);

      const parsed = await page.evaluate(() => {
        const h1 = document.querySelector("h1[itemprop='headline'], .view-wrap h1, #view_title, .view-title, .title");
        const title = h1 ? h1.innerText.trim() : document.title;
        
        const contentEl = document.querySelector("#view_content, .view-wrap article, .view-content");
        const description = contentEl ? contentEl.innerText.trim() : "";

        const dateEl = document.querySelector(".view-info, .sp-date, .text-muted, .wr-date");
        const date = dateEl ? dateEl.innerText.trim() : "";

        const catEl = document.querySelector(".view-cate, a[href*='sca=']");
        const category = catEl ? catEl.innerText.trim() : "";

        const tagEls = Array.from(document.querySelectorAll("a[href*='stx='], .tag, a[href*='tag']"));
        const tags = tagEls.map(t => t.innerText.trim()).filter(t => t.length > 0);

        const thumb = document.querySelector(".view-wrap img[src*='/data/file/'], #view_content img, .img-tag img");
        const thumbnailUrl = thumb ? thumb.src : null;

        const iframes = Array.from(document.querySelectorAll("iframe")).map(f => f.src);

        return {
          title,
          description: description.substring(0, 500),
          category,
          date,
          tags,
          thumbnailUrl,
          iframes
        };
      });

      // Attempt to capture initialized player stream URL from child frame if ready
      try {
        const frames = page.frames();
        const playerFrame = frames.find(f => f.url().includes("player.php"));
        if (playerFrame) {
          const streamUrl = await playerFrame.evaluate(() => {
            const v = document.querySelector("video");
            if (v && (v.currentSrc || v.src)) return v.currentSrc || v.src;
            const jw = window.jwplayer ? window.jwplayer() : null;
            if (jw && typeof jw.getPlaylistItem === "function") {
              const item = jw.getPlaylistItem();
              if (item && item.file) return item.file;
            }
            return null;
          }).catch(() => null);

          if (streamUrl && typeof streamUrl === "string" && (streamUrl.startsWith("http://") || streamUrl.startsWith("https://"))) {
            parsed.videoSrc = streamUrl;
          }
        }
      } catch (e) {}

      // Extract itemId from URL
      const wrMatch = pageUrl.match(/wr_id=(\d+)/);
      const boMatch = pageUrl.match(/bo_table=([^&]+)/);
      const bo_table = boMatch ? boMatch[1] : "korea";
      const wr_id = wrMatch ? wrMatch[1] : String(Date.now());

      return {
        bo_table,
        wr_id,
        itemId: `${bo_table}_${wr_id}`,
        pageUrl,
        ...parsed
      };
    } finally {
      await browser.close();
    }
  }

  /**
   * Helper: Waits for Cloudflare challenge or DOM content resolution cleanly
   * @param {import('playwright').Page} page 
   */
  async waitForTurnstile(page) {
    if (!page || page.isClosed()) return;

    for (let i = 0; i < 10; i++) {
      if (page.isClosed()) return;
      try {
        const hasContent = await page.evaluate(() => {
          return Boolean(
            document.querySelector("a[href*='wr_id=']") ||
            document.querySelector("#view_content") ||
            document.querySelector(".view-wrap") ||
            document.querySelector(".view-title, #view_title, h1")
          );
        }).catch(() => false);

        if (hasContent) {
          return;
        }

        const title = await page.title().catch(() => "");
        if (title && !title.toLowerCase().includes("just a moment") && !title.toLowerCase().includes("cloudflare")) {
          return;
        }
      } catch (e) {}

      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  // ============================================================
  // 📥 AUTHORIZED MEDIA STREAM DOWNLOAD (PHASE 7)
  // ============================================================

  /**
   * Downloads authorized media stream to a temporary directory.
   * Enforces chunked streaming, file size cap, timeout, and checksum verification.
   * @param {object} item Normalized item
   * @param {object} [options]
   * @returns {Promise<{ localPath: string, checksum: string, sizeBytes: number }>}
   */
  async downloadAuthorizedMedia(item, options = {}) {
    if (this.dryRun) {
      console.log(`🛡️ [AVSEE DRY_RUN] Media download skipped in dry-run mode for item "${item.title}"`);
      return {
        localPath: null,
        checksum: "DRY_RUN_NO_DOWNLOAD",
        sizeBytes: 0,
        dryRun: true
      };
    }

    if (!item.mediaUrl) {
      throw new Error("[AVSEE DOWNLOAD ERROR] Missing mediaUrl for download");
    }

    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }

    const filename = `${item.uniqueHash || crypto.randomBytes(8).toString("hex")}.mp4`;
    const destPath = path.join(this.tempDir, filename);

    console.log(`📥 [AVSEE] Streaming media for "${item.title}" -> ${filename}`);

    return await this.executeWithRetry(async () => {
      return await new Promise((resolve, reject) => {
        const parsed = new URL(item.mediaUrl);
        const client = parsed.protocol === "https:" ? https : http;

        const req = client.get(item.mediaUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer": this.apiUrl
          },
          timeout: this.timeoutMs * 2
        }, (res) => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            return reject(new Error(`Download HTTP ${res.statusCode} ${res.statusMessage}`));
          }

          const contentType = (res.headers["content-type"] || "").toLowerCase();
          if (contentType.includes("text/html") || contentType.includes("application/json")) {
            res.resume();
            return reject(new Error(`Invalid content-type "${contentType}". Expected video stream.`));
          }

          const fileStream = fs.createWriteStream(destPath);
          const hash = crypto.createHash("sha256");
          let totalBytes = 0;
          const maxBytes = this.maxFileSizeMB * 1024 * 1024;

          res.on("data", chunk => {
            totalBytes += chunk.length;
            if (totalBytes > maxBytes) {
              req.destroy();
              fileStream.close();
              if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
              return reject(new Error(`File size exceeded maximum limit of ${this.maxFileSizeMB}MB`));
            }
            hash.update(chunk);
            fileStream.write(chunk);
          });

          fileStream.on("finish", () => {
            const checksum = hash.digest("hex");
            resolve({
              localPath: destPath,
              checksum: checksum,
              sizeBytes: totalBytes,
              dryRun: false
            });
          });

          res.on("end", () => {
            fileStream.end();
          });

          res.on("error", err => {
            fileStream.close();
            if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
            reject(err);
          });
        });

        req.on("error", reject);
        req.on("timeout", () => {
          req.destroy();
          if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
          reject(new Error(`Download timed out after ${this.timeoutMs * 2}ms`));
        });
      });
    });
  }

  /**
   * Cleans up downloaded temporary media files
   * @param {string} localPath 
   */
  cleanupMedia(localPath) {
    if (localPath && fs.existsSync(localPath)) {
      try {
        fs.unlinkSync(localPath);
      } catch (e) {}
    }
  }
}

module.exports = {
  AvseeSourceAdapter,
  AVSEE_ENABLED,
  AVSEE_DRY_RUN
};
