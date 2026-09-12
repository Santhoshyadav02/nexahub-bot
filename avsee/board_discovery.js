/**
 * ============================================================
 * 🔍 AVSEE BOARD DISCOVERY MODULE
 * ============================================================
 * Headless browser parser for authorized board/listing pages.
 * 
 * Safety & Compliance:
 * - Read-only DOM inspection.
 * - Does NOT automate DevTools/F12.
 * - Detects and waits for authorized/manual challenges with hard timeouts.
 * - Redacts sensitive tokens from diagnostic logging.
 */

const { chromium } = require("playwright");
const { URL } = require("url");
const fs = require("fs");
const { execSync } = require("child_process");
const { detectChallenge, waitForChallengeCompletion, redactUrl } = require("./player_resolver");
const { applyProxyToLaunchOptions } = require("./proxy_config");

/**
 * Locate system Chromium executable if available
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

  return null;
}

/**
 * Discovers and extracts post listings from an authorized board page.
 * 
 * @param {string} boardUrl
 * @param {object} [options]
 * @returns {Promise<{
 *   success: boolean,
 *   boardUrl: string,
 *   posts: Array<{
 *     postId: string,
 *     itemId: string,
 *     title: string,
 *     postUrl: string,
 *     pageUrl: string,
 *     thumbnailUrl: string|null,
 *     publishedAt?: string|null,
 *     tags?: string[]
 *   }>,
 *   error?: string
 * }>}
 */
async function discoverBoardPosts(boardUrl, options = {}) {
  const timeoutMs = options.pageTimeoutMs || 30000;
  const challengeTimeoutMs = options.challengeTimeoutMs || 60000;
  const limit = options.limit || 20;

  if (!boardUrl || typeof boardUrl !== "string") {
    return {
      success: false,
      boardUrl: boardUrl || null,
      posts: [],
      error: "Invalid boardUrl parameter"
    };
  }

  let browser = null;
  let ownsBrowser = false;

  try {
    if (options.browser) {
      browser = options.browser;
    } else {
      const execPath = getSystemChromiumPath();
      const launchOpts = applyProxyToLaunchOptions({
        headless: options.headless !== false,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--mute-audio",
          "--disable-blink-features=AutomationControlled"
        ]
      });
      if (execPath) {
        launchOpts.executablePath = execPath;
      }
      browser = await chromium.launch(launchOpts);
      ownsBrowser = true;
    }

    const context = options.context || await browser.newContext({
      userAgent: options.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 }
    });

    const page = options.page || await context.newPage();

    // Abort heavy media to save memory and avoid hangs
    await page.route("**/*.{png,jpg,jpeg,gif,webp,svg,ico,woff,woff2,ttf,otf,eot,mp4,webm,avi,mkv,ts,flv,mp3,wav,ogg}", route => {
      route.abort();
    });

    try {
      const resp = await page.goto(boardUrl, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs
      });
      if (resp && resp.status() >= 400) {
        return {
          success: false,
          boardUrl,
          posts: [],
          error: `Board navigation HTTP ${resp.status()}`
        };
      }
    } catch (navErr) {
      return {
        success: false,
        boardUrl,
        posts: [],
        error: `Board navigation failed: ${navErr.message}`
      };
    }

    // Check for challenge
    const inChallenge = await detectChallenge(page);
    if (inChallenge) {
      const cleared = await waitForChallengeCompletion(page, challengeTimeoutMs);
      if (!cleared) {
        return {
          success: false,
          boardUrl,
          posts: [],
          error: "Challenge did not complete within timeout"
        };
      }
    }

    // Extract post listings from page DOM
    const rawPosts = await page.evaluate(() => {
      const map = new Map();
      const anchors = Array.from(document.querySelectorAll("a[href*='wr_id='], a[href*='/view/'], a[href*='/post/'], .post-link, .video-card a"));

      anchors.forEach(a => {
        let wr_id = null;
        let bo_table = "board";

        const mWr = a.href.match(/wr_id=(\d+)/);
        const mBo = a.href.match(/bo_table=([^&]+)/);
        if (mWr) {
          wr_id = mWr[1];
          if (mBo) bo_table = mBo[1];
        } else {
          const mPath = a.href.match(/\/(\d+)(?:\.html|\/|$)/);
          if (mPath) {
            wr_id = mPath[1];
          }
        }

        if (!wr_id) return;
        const itemId = `${bo_table}_${wr_id}`;

        if (!map.has(itemId)) {
          map.set(itemId, {
            postId: itemId,
            itemId: itemId,
            bo_table: bo_table,
            wr_id: wr_id,
            postUrl: a.href,
            pageUrl: a.href,
            title: "",
            thumbnailUrl: null,
            publishedAt: null,
            tags: []
          });
        }

        const entry = map.get(itemId);
        const anchorText = a.innerText ? a.innerText.trim() : "";
        if (anchorText && (!entry.title || entry.title.length < anchorText.length)) {
          entry.title = anchorText;
        }

        const parent = a.closest(".item-row, .list-row, .list-item, .media, tr, li, div, article");
        if (parent) {
          if (!entry.title) {
            const titleEl = parent.querySelector(".wr-subject, .item-title, .title, .subject, .bo_tit, .wr_subject, strong, h2, h3");
            if (titleEl && titleEl.innerText) {
              entry.title = titleEl.innerText.trim();
            }
          }
          const img = parent.querySelector("img");
          if (img && img.src && !entry.thumbnailUrl) {
            entry.thumbnailUrl = img.src;
          }
          const dateEl = parent.querySelector(".sp-date, .text-muted, .date, .wr-date, time");
          if (dateEl && dateEl.innerText) {
            entry.publishedAt = dateEl.innerText.trim();
          }
        }
      });

      return Array.from(map.values()).filter(p => p.itemId && p.title && p.postUrl);
    });

    const posts = rawPosts.slice(0, limit);

    return {
      success: true,
      boardUrl,
      posts,
      error: null
    };

  } catch (err) {
    return {
      success: false,
      boardUrl,
      posts: [],
      error: `Discovery error: ${err.message}`
    };
  } finally {
    if (ownsBrowser && browser) {
      await browser.close().catch(() => {});
    }
  }
}

/**
 * Filters discovered posts against existing stateStore / dedupe ledger.
 * @param {Array<object>} posts 
 * @param {import('../external_source_state').ExternalSourceState} stateStore 
 * @returns {Array<object>} Genuinely new posts
 */
function filterNewPosts(posts, stateStore) {
  if (!Array.isArray(posts) || posts.length === 0) return [];
  if (!stateStore || typeof stateStore.hasSeen !== "function") return posts;

  return posts.filter(post => {
    const isSeen = stateStore.hasSeen({
      itemId: post.itemId || post.postId,
      canonicalUrl: post.postUrl || post.pageUrl
    });
    return !isSeen;
  });
}

module.exports = {
  discoverBoardPosts,
  filterNewPosts
};
