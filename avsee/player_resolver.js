/**
 * ============================================================
 * 🌐 AVSEE PLAYER RESOLVER (STAGE 1 ISOLATED MODULE)
 * ============================================================
 * Headless browser resolver for authorized, non-explicit media players.
 * 
 * Safety & Compliance:
 * - Read-only DOM/frame inspection.
 * - Does NOT automate F12 or DevTools UI.
 * - Does NOT bypass Cloudflare, Turnstile, or access controls.
 * - Redacts sensitive tokens/query parameters from logs.
 * - Strict timeouts on navigation, challenge resolution, and player init.
 */

const { chromium } = require("playwright");
const { URL } = require("url");
const fs = require("fs");
const { execSync } = require("child_process");

const RESOLVER_STATES = Object.freeze({
  SUCCESS: "SUCCESS",
  PAGE_LOAD_FAILED: "PAGE_LOAD_FAILED",
  CHALLENGE_DETECTED: "CHALLENGE_DETECTED",
  CHALLENGE_TIMEOUT: "CHALLENGE_TIMEOUT",
  PLAYER_FRAME_NOT_FOUND: "PLAYER_FRAME_NOT_FOUND",
  VIDEO_ELEMENT_NOT_FOUND: "VIDEO_ELEMENT_NOT_FOUND",
  VIDEO_NOT_INITIALIZED: "VIDEO_NOT_INITIALIZED",
  MEDIA_SOURCE_NOT_FOUND: "MEDIA_SOURCE_NOT_FOUND",
  INVALID_VIDEO_METADATA: "INVALID_VIDEO_METADATA"
});

const DEFAULT_OPTIONS = Object.freeze({
  headless: true,
  pageTimeoutMs: 60000,
  challengeTimeoutMs: 120000,
  playerTimeoutMs: 30000,
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  viewport: { width: 1280, height: 720 },
  logDiagnostics: true
});

/**
 * Locate system Chromium executable if available
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

  return null;
}

/**
 * Redacts sensitive tokens and signature params from a URL string for safe logging.
 * @param {string} urlStr 
 * @returns {string}
 */
function redactUrl(urlStr) {
  if (!urlStr || typeof urlStr !== "string") return urlStr;
  try {
    const parsed = new URL(urlStr);
    const sensitiveKeys = ["token", "bcdn_token", "key", "auth", "sig", "signature", "expires", "secret", "token_path"];
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (sensitiveKeys.some(s => key.toLowerCase().includes(s))) {
        parsed.searchParams.set(key, "REDACTED");
      }
    }
    return parsed.toString();
  } catch (e) {
    return urlStr.replace(/(bcdn_token|token|key|auth|sig|signature|expires)=[^&]+/gi, "$1=REDACTED");
  }
}

/**
 * Check if the current page presents an active Cloudflare/Turnstile/Bot challenge.
 * @param {import('playwright').Page} page 
 * @returns {Promise<boolean>}
 */
async function detectChallenge(page) {
  if (!page || page.isClosed()) return false;
  try {
    const title = (await page.title().catch(() => "")).toLowerCase();
    if (
      title.includes("just a moment") ||
      title.includes("cloudflare") ||
      title.includes("attention required") ||
      title.includes("security check") ||
      title.includes("checking your browser")
    ) {
      return true;
    }

    const hasChallengeEl = await page.evaluate(() => {
      const selectors = [
        "#challenge-running",
        "#cf-challenge-running",
        "#challenge-form",
        ".cf-browser-verification",
        "iframe[src*='cloudflare']",
        "iframe[src*='turnstile']",
        "#turnstile-wrapper"
      ];
      return selectors.some(sel => Boolean(document.querySelector(sel)));
    }).catch(() => false);

    return Boolean(hasChallengeEl);
  } catch (e) {
    return false;
  }
}

/**
 * Waits for an authorized/manual challenge to complete with a hard timeout.
 * Does NOT attempt to bypass or automate challenge interaction.
 * @param {import('playwright').Page} page 
 * @param {number} timeoutMs 
 * @returns {Promise<boolean>} true if challenge cleared, false if timed out
 */
async function waitForChallengeCompletion(page, timeoutMs = 120000) {
  const startTime = Date.now();
  const pollIntervalMs = 1000;

  while (Date.now() - startTime < timeoutMs) {
    if (page.isClosed()) return false;
    const inChallenge = await detectChallenge(page);
    if (!inChallenge) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
  return false;
}

/**
 * Inspect all frames in page to locate the player frame and video element.
 * @param {import('playwright').Page} page 
 * @returns {Promise<{ playerFrame: import('playwright').Frame|null, playerFrameUrl: string|null }>}
 */
async function findPlayerFrame(page) {
  const frames = page.frames();

  // 1. Look for specific player frame URL patterns
  for (const frame of frames) {
    const url = frame.url();
    if (/player\.php|player\.html|embed|\/play\/|\/video\//i.test(url)) {
      return { playerFrame: frame, playerFrameUrl: url };
    }
  }

  // 2. Check each frame for a <video> element or player container
  for (const frame of frames) {
    try {
      const hasVideo = await frame.evaluate(() => {
        return Boolean(document.querySelector("video") || document.querySelector(".jwplayer, #player, .video-js"));
      }).catch(() => false);

      if (hasVideo) {
        return { playerFrame: frame, playerFrameUrl: frame.url() };
      }
    } catch (e) {}
  }

  // 3. Fall back to main frame if it contains a <video> element
  const mainFrame = page.mainFrame();
  try {
    const mainHasVideo = await mainFrame.evaluate(() => {
      return Boolean(document.querySelector("video"));
    }).catch(() => false);

    if (mainHasVideo) {
      return { playerFrame: mainFrame, playerFrameUrl: mainFrame.url() };
    }
  } catch (e) {}

  return { playerFrame: null, playerFrameUrl: null };
}

/**
 * Resolves the media player metadata from an authorized post URL.
 * 
 * @param {string} postUrl Authorized post URL
 * @param {object} [options] Resolver options
 * @returns {Promise<{
 *   success: boolean,
 *   state: string,
 *   error?: string,
 *   postUrl: string,
 *   playerFrameUrl: string|null,
 *   mediaUrl: string|null,
 *   duration: number|null,
 *   width: number|null,
 *   height: number|null,
 *   readyState: number|null,
 *   networkState: number|null
 * }>}
 */
async function resolvePlayer(postUrl, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const log = (msg) => {
    if (opts.logDiagnostics) console.log(`[PlayerResolver] ${msg}`);
  };

  let browser = null;
  let ownsBrowser = false;

  if (!postUrl || typeof postUrl !== "string") {
    return {
      success: false,
      state: RESOLVER_STATES.PAGE_LOAD_FAILED,
      error: "Invalid or missing postUrl parameter",
      postUrl: postUrl || null,
      playerFrameUrl: null,
      mediaUrl: null,
      duration: null,
      width: null,
      height: null,
      readyState: null,
      networkState: null
    };
  }

  try {
    // 1. Launch / reuse browser instance
    if (opts.browser) {
      browser = opts.browser;
    } else {
      const execPath = getSystemChromiumPath();
      const launchOpts = {
        headless: opts.headless !== false,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--mute-audio",
          "--disable-blink-features=AutomationControlled"
        ]
      };
      if (execPath) {
        launchOpts.executablePath = execPath;
      }
      browser = await chromium.launch(launchOpts);
      ownsBrowser = true;
    }

    const context = opts.context || await browser.newContext({
      userAgent: opts.userAgent,
      viewport: opts.viewport
    });

    const page = opts.page || await context.newPage();

    log(`Navigating to ${redactUrl(postUrl)} (timeout: ${opts.pageTimeoutMs}ms)...`);

    // 2. Navigate to post URL
    let navResponse;
    try {
      navResponse = await page.goto(postUrl, {
        waitUntil: "domcontentloaded",
        timeout: opts.pageTimeoutMs
      });
    } catch (navErr) {
      log(`Page navigation failed: ${navErr.message}`);
      return {
        success: false,
        state: RESOLVER_STATES.PAGE_LOAD_FAILED,
        error: `Page load failed: ${navErr.message}`,
        postUrl,
        playerFrameUrl: null,
        mediaUrl: null,
        duration: null,
        width: null,
        height: null,
        readyState: null,
        networkState: null
      };
    }

    // 3. Challenge detection and graceful wait
    const challengePresent = await detectChallenge(page);
    if (challengePresent) {
      log(`Challenge detected on page. Waiting up to ${opts.challengeTimeoutMs}ms for authorized completion...`);
      const cleared = await waitForChallengeCompletion(page, opts.challengeTimeoutMs);
      if (!cleared) {
        log(`Challenge timed out after ${opts.challengeTimeoutMs}ms`);
        return {
          success: false,
          state: RESOLVER_STATES.CHALLENGE_TIMEOUT,
          error: `Challenge was detected but did not complete within ${opts.challengeTimeoutMs}ms`,
          postUrl,
          playerFrameUrl: null,
          mediaUrl: null,
          duration: null,
          width: null,
          height: null,
          readyState: null,
          networkState: null
        };
      }
      log("Challenge cleared successfully.");
    }

    // 4. Locate player frame
    log("Inspecting frames for media player...");
    let { playerFrame, playerFrameUrl } = await findPlayerFrame(page);

    // If not immediately found, wait briefly for dynamic iframes
    if (!playerFrame) {
      const waitStart = Date.now();
      while (Date.now() - waitStart < 5000 && !playerFrame) {
        await new Promise(r => setTimeout(r, 500));
        const found = await findPlayerFrame(page);
        playerFrame = found.playerFrame;
        playerFrameUrl = found.playerFrameUrl;
      }
    }

    if (!playerFrame) {
      log("Player frame not found.");
      return {
        success: false,
        state: RESOLVER_STATES.PLAYER_FRAME_NOT_FOUND,
        error: "Could not locate a player frame or player container in the page DOM",
        postUrl,
        playerFrameUrl: null,
        mediaUrl: null,
        duration: null,
        width: null,
        height: null,
        readyState: null,
        networkState: null
      };
    }

    log(`Player frame identified: ${redactUrl(playerFrameUrl || "embedded")}`);

    // 5. Inspect player frame for video element and wait for initialization
    log(`Waiting up to ${opts.playerTimeoutMs}ms for video element initialization...`);
    const initStart = Date.now();
    let videoMetadata = null;

    while (Date.now() - initStart < opts.playerTimeoutMs) {
      if (page.isClosed()) break;

      try {
        videoMetadata = await playerFrame.evaluate(() => {
          const v = document.querySelector("video");
          if (!v) {
            // Check JWPlayer instance if present
            if (window.jwplayer && typeof window.jwplayer === "function") {
              const jw = window.jwplayer();
              if (jw && typeof jw.getPlaylistItem === "function") {
                const item = jw.getPlaylistItem();
                if (item && item.file) {
                  return {
                    hasVideoEl: true,
                    src: item.file,
                    currentSrc: item.file,
                    duration: typeof jw.getDuration === "function" ? jw.getDuration() : 0,
                    videoWidth: typeof jw.getWidth === "function" ? parseInt(jw.getWidth(), 10) || 0 : 0,
                    videoHeight: typeof jw.getHeight === "function" ? parseInt(jw.getHeight(), 10) || 0 : 0,
                    readyState: 4,
                    networkState: 1
                  };
                }
              }
            }
            return { hasVideoEl: false };
          }

          const src = v.currentSrc || v.src || (v.querySelector("source") ? v.querySelector("source").src : null);
          return {
            hasVideoEl: true,
            src: src || null,
            currentSrc: v.currentSrc || null,
            duration: typeof v.duration === "number" && !isNaN(v.duration) ? v.duration : 0,
            videoWidth: typeof v.videoWidth === "number" ? v.videoWidth : 0,
            videoHeight: typeof v.videoHeight === "number" ? v.videoHeight : 0,
            readyState: v.readyState,
            networkState: v.networkState
          };
        }).catch(() => null);

        if (videoMetadata && videoMetadata.hasVideoEl) {
          const hasSrc = Boolean(videoMetadata.currentSrc || videoMetadata.src);
          const isInitialized = videoMetadata.readyState >= 1 || videoMetadata.duration > 0;

          if (hasSrc && isInitialized) {
            break;
          }
        }
      } catch (evalErr) {}

      await new Promise(r => setTimeout(r, 500));
    }

    if (!videoMetadata || !videoMetadata.hasVideoEl) {
      log("HTML5 <video> element not found inside player frame.");
      return {
        success: false,
        state: RESOLVER_STATES.VIDEO_ELEMENT_NOT_FOUND,
        error: "No <video> element found inside the resolved player frame",
        postUrl,
        playerFrameUrl,
        mediaUrl: null,
        duration: null,
        width: null,
        height: null,
        readyState: null,
        networkState: null
      };
    }

    const resolvedMediaUrl = videoMetadata.currentSrc || videoMetadata.src;

    if (!resolvedMediaUrl) {
      log("Media source URL not found on video element.");
      return {
        success: false,
        state: RESOLVER_STATES.MEDIA_SOURCE_NOT_FOUND,
        error: "The video element exists but does not have a populated src or currentSrc",
        postUrl,
        playerFrameUrl,
        mediaUrl: null,
        duration: videoMetadata.duration || null,
        width: videoMetadata.videoWidth || null,
        height: videoMetadata.videoHeight || null,
        readyState: videoMetadata.readyState,
        networkState: videoMetadata.networkState
      };
    }

    if (videoMetadata.readyState === 0 && (!videoMetadata.duration || videoMetadata.duration <= 0)) {
      log("Video element did not initialize within timeout.");
      return {
        success: false,
        state: RESOLVER_STATES.VIDEO_NOT_INITIALIZED,
        error: "Video element readyState remained HAVE_NOTHING (0) and duration was unavailable",
        postUrl,
        playerFrameUrl,
        mediaUrl: resolvedMediaUrl,
        duration: null,
        width: null,
        height: null,
        readyState: videoMetadata.readyState,
        networkState: videoMetadata.networkState
      };
    }

    log(`Successfully resolved player: duration=${videoMetadata.duration}s, dimensions=${videoMetadata.videoWidth}x${videoMetadata.videoHeight}, readyState=${videoMetadata.readyState}`);
    log(`Resolved media URL: ${redactUrl(resolvedMediaUrl)}`);

    return {
      success: true,
      state: RESOLVER_STATES.SUCCESS,
      postUrl,
      playerFrameUrl,
      mediaUrl: resolvedMediaUrl,
      duration: Math.round((videoMetadata.duration || 0) * 100) / 100,
      width: videoMetadata.videoWidth || 0,
      height: videoMetadata.videoHeight || 0,
      readyState: videoMetadata.readyState,
      networkState: videoMetadata.networkState
    };

  } catch (err) {
    log(`Unexpected error during player resolution: ${err.message}`);
    return {
      success: false,
      state: RESOLVER_STATES.PAGE_LOAD_FAILED,
      error: `Unexpected error: ${err.message}`,
      postUrl,
      playerFrameUrl: null,
      mediaUrl: null,
      duration: null,
      width: null,
      height: null,
      readyState: null,
      networkState: null
    };
  } finally {
    if (ownsBrowser && browser) {
      await browser.close().catch(() => {});
    }
  }
}

module.exports = {
  resolvePlayer,
  detectChallenge,
  waitForChallengeCompletion,
  findPlayerFrame,
  redactUrl,
  RESOLVER_STATES,
  DEFAULT_OPTIONS
};
