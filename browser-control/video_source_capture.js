/**
 * ============================================================
 * 🎥 PHASE 1: PLAYWRIGHT VIDEO SOURCE OBSERVATION MODULE
 * ============================================================
 * Isolated, read-only Playwright browser-action flow for observing
 * video playback source metadata from authorized target post & player iframe.
 * 
 * Safety & Compliance:
 * - Read-only DOM & video element observation.
 * - ZERO media downloading or curl requests.
 * - ZERO Telegram publication.
 * - ZERO Cloudflare bypasses or automated challenge solvers.
 * - Strict MANUAL_ACTION_REQUIRED pausing if challenges arise.
 * - Strict redaction of query signatures/tokens from logs and stdout.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { redactUrl, detectChallenge } = require('./navigation_recovery');
const { pacedClick } = require('./interaction_pacing');

const ACTION_DELAY_MIN_MS = 3000;
const ACTION_DELAY_MAX_MS = 5000;

const CAPTURE_STATES = Object.freeze({
  IDLE: 'IDLE',
  NAVIGATING: 'NAVIGATING',
  NO_POST: 'NO_POST',
  CLOUDFLARE_MANUAL_ACTION_REQUIRED: 'CLOUDFLARE_MANUAL_ACTION_REQUIRED',
  POST_ACCESSIBLE: 'POST_ACCESSIBLE',
  PLAYER_NOT_FOUND: 'PLAYER_NOT_FOUND',
  VIDEO_NOT_FOUND: 'VIDEO_NOT_FOUND',
  VIDEO_SOURCE_NOT_FOUND: 'VIDEO_SOURCE_NOT_FOUND',
  VIDEO_SOURCE_CAPTURED: 'VIDEO_SOURCE_CAPTURED'
});

/**
 * Human delay helper between major browser actions.
 * @param {string} label Action description
 * @param {import('playwright').Page} [page] Playwright page
 * @param {number} [minMs=ACTION_DELAY_MIN_MS] Minimum delay in ms
 * @param {number} [maxMs=ACTION_DELAY_MAX_MS] Maximum delay in ms
 * @returns {Promise<number>} Delay milliseconds waited
 */
async function humanDelay(label, page = null, minMs = ACTION_DELAY_MIN_MS, maxMs = ACTION_DELAY_MAX_MS) {
  const actualMin = Math.max(0, minMs);
  const actualMax = Math.max(actualMin, maxMs);
  const delay = actualMin + Math.floor(Math.random() * (actualMax - actualMin + 1));

  console.log(`[browser-action] ${label}: waiting ${delay}ms`);
  if (page && !page.isClosed()) {
    await page.waitForTimeout(delay).catch(() => {});
  } else if (delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return delay;
}

class VideoSourceCapture {
  /**
   * @param {object} [options]
   */
  constructor(options = {}) {
    this.boardUrl = options.boardUrl || process.env.AVSEE_API_URL || 'https://02.avsee.is/bbs/board.php?bo_table=korea';
    this.postUrl = options.postUrl || null;
    this.userDataDir = options.userDataDir || path.join(__dirname, '..', 'scratch', 'video_capture_profile');
    this.outputPath = options.outputPath || path.join(__dirname, '..', 'artifacts', 'video_source_capture.json');
    this.headless = options.headless !== undefined ? Boolean(options.headless) : true;
    this.actionDelayMinMs = typeof options.actionDelayMinMs === 'number' ? options.actionDelayMinMs : ACTION_DELAY_MIN_MS;
    this.actionDelayMaxMs = typeof options.actionDelayMaxMs === 'number' ? options.actionDelayMaxMs : ACTION_DELAY_MAX_MS;
    this.proxy = options.proxy || null;
    this.manualChallengeTimeoutMs = options.manualChallengeTimeoutMs || 30000;
    this.playInteractionSelector = options.playInteractionSelector || '.vjs-big-play-button, .play-btn, #play, button.play, .dplayer-mobile-play, .jw-display-icon-container, .play-control, .video-player-play';

    this.usePersistentContext = options.usePersistentContext !== undefined ? Boolean(options.usePersistentContext) : false;

    this.state = CAPTURE_STATES.IDLE;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.actionLog = [];
  }

  logAction(actionName, details = {}) {
    const entry = {
      action: actionName,
      timestamp: new Date().toISOString(),
      state: this.state,
      details
    };
    this.actionLog.push(entry);
    console.log(`[video-source-capture] [${this.state}] ${actionName}`, Object.keys(details).length ? JSON.stringify(details) : '');
  }

  /**
   * Waits for a human/manual challenge clearance if a challenge is present.
   * @param {import('playwright').Page} page
   * @param {number} timeoutMs
   * @returns {Promise<boolean>}
   */
  async waitForManualChallengeClearance(page, timeoutMs = 30000) {
    const start = Date.now();
    const pollInterval = 1000;

    while (Date.now() - start < timeoutMs) {
      if (!page || page.isClosed()) return false;
      const isChallenged = await detectChallenge(page);
      if (!isChallenged) {
        return true;
      }
      await page.waitForTimeout(pollInterval).catch(() => {});
    }
    return !(await detectChallenge(page));
  }

  /**
   * Executes the full sequential observation flow.
   * @returns {Promise<object>} Result metadata object
   */
  async observeAndCapture() {
    const result = {
      success: false,
      state: CAPTURE_STATES.IDLE,
      capturedAt: new Date().toISOString(),
      actionSequence: [],
      delaysUsed: [],
      post: {
        id: null,
        title: null,
        url: null,
        accessible: false
      },
      player: {
        frameUrl: null,
        found: false,
        domLoaded: false
      },
      video: {
        found: false,
        currentSrc: null,
        src: null,
        duration: null,
        width: null,
        height: null,
        readyState: null
      },
      error: null
    };

    try {
      if (this.usePersistentContext && !fs.existsSync(this.userDataDir)) {
        fs.mkdirSync(this.userDataDir, { recursive: true });
      }

      // Step 1: Launch Chromium browser context
      this.state = CAPTURE_STATES.NAVIGATING;
      this.logAction('LAUNCH_BROWSER', { headless: this.headless, persistent: this.usePersistentContext });
      result.actionSequence.push('1. Launch Chromium browser context');

      const launchOptions = {
        headless: this.headless,
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        ignoreHTTPSErrors: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-first-run',
          '--no-zygote',
          '--disable-breakpad',
          '--disable-software-rasterizer',
          '--disable-extensions',
          '--disable-features=IsolateOrigins,site-per-process,AudioServiceOutOfProcess'
        ]
      };

      if (this.proxy) {
        launchOptions.proxy = this.proxy;
      }

      if (this.usePersistentContext) {
        this.context = await chromium.launchPersistentContext(this.userDataDir, launchOptions);
        this.page = this.context.pages().length > 0 ? this.context.pages()[0] : await this.context.newPage();
      } else {
        const launchArgs = {
          headless: this.headless,
          args: launchOptions.args
        };
        if (this.proxy) launchArgs.proxy = this.proxy;
        this.browser = await chromium.launch(launchArgs);
        this.context = await this.browser.newContext({
          userAgent: launchOptions.userAgent,
          viewport: launchOptions.viewport,
          ignoreHTTPSErrors: launchOptions.ignoreHTTPSErrors
        });
        this.page = await this.context.newPage();
      }

      // Step 2: Navigate to configured test website / board
      const initialNavUrl = this.postUrl || this.boardUrl;
      this.logAction('NAVIGATE_INITIAL', { url: redactUrl(initialNavUrl) });
      result.actionSequence.push(`2. Navigate to initial URL (${redactUrl(initialNavUrl)})`);

      await this.page.goto(initialNavUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => {
        console.warn(`[navigation-warning] Initial navigation: ${e.message}`);
      });

      // Step 3: Wait 3–5 seconds after navigation
      const d1 = await humanDelay('after_initial_navigation', this.page, this.actionDelayMinMs, this.actionDelayMaxMs);
      result.delaysUsed.push({ step: 'after_initial_navigation', delayMs: d1 });
      result.actionSequence.push(`3. Wait ${d1}ms after initial navigation`);

      // Step 4: Inspect page state
      this.logAction('INSPECT_PAGE_STATE', { currentUrl: redactUrl(this.page.url()) });
      result.actionSequence.push('4. Inspect initial page state');

      // Step 5: Identify the target / newest post
      let targetPost = null;
      if (this.postUrl) {
        targetPost = {
          id: (this.postUrl.match(/wr_id=(\d+)/) || [, 'manual_post'])[1],
          title: 'Configured Target Post',
          url: this.postUrl
        };
      } else {
        const discovered = await this.page.evaluate(() => {
          const links = Array.from(document.querySelectorAll('a[href*="wr_id="], a.post-link, .post-title a'));
          return links.map((a) => ({
            href: a.href,
            text: (a.textContent || '').trim()
          })).filter((item) => item.href.includes('wr_id=') || item.text.length > 0);
        }).catch(() => []);

        if (discovered && discovered.length > 0) {
          const first = discovered[0];
          const match = first.href.match(/wr_id=(\d+)/);
          targetPost = {
            id: match ? match[1] : 'discovered_1',
            title: first.text || 'Discovered Post',
            url: first.href
          };
        }
      }

      if (!targetPost) {
        this.state = CAPTURE_STATES.NO_POST;
        result.state = CAPTURE_STATES.NO_POST;
        result.error = 'No candidate post found on initial page';
        this.logAction('NO_POST_FOUND');
        return result;
      }

      result.post.id = targetPost.id;
      result.post.title = targetPost.title;
      result.post.url = redactUrl(targetPost.url);
      this.logAction('POST_IDENTIFIED', { id: targetPost.id, title: targetPost.title, url: result.post.url });
      result.actionSequence.push(`5. Identify target post: ID=${targetPost.id}`);

      // Step 6: Wait 3–5 seconds
      const d2 = await humanDelay('after_post_discovery', this.page, this.actionDelayMinMs, this.actionDelayMaxMs);
      result.delaysUsed.push({ step: 'after_post_discovery', delayMs: d2 });
      result.actionSequence.push(`6. Wait ${d2}ms after post discovery`);

      // Step 7: Open the post if not already there
      if (this.page.url() !== targetPost.url) {
        this.logAction('OPEN_POST', { url: redactUrl(targetPost.url) });
        await this.page.goto(targetPost.url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => {
          console.warn(`[navigation-warning] Post navigation: ${e.message}`);
        });
      }
      result.actionSequence.push('7. Open target post page');

      // Step 8: Wait 3–5 seconds
      const d3 = await humanDelay('after_post_navigation', this.page, this.actionDelayMinMs, this.actionDelayMaxMs);
      result.delaysUsed.push({ step: 'after_post_navigation', delayMs: d3 });
      result.actionSequence.push(`8. Wait ${d3}ms after post navigation`);

      // Step 9: Detect whether Cloudflare / security challenge is present
      const hasPostChallenge = await detectChallenge(this.page);
      result.actionSequence.push(`9. Detect security challenge (present=${hasPostChallenge})`);

      // Step 10: Handle Cloudflare challenge if present
      if (hasPostChallenge) {
        this.state = CAPTURE_STATES.CLOUDFLARE_MANUAL_ACTION_REQUIRED;
        result.state = CAPTURE_STATES.CLOUDFLARE_MANUAL_ACTION_REQUIRED;
        this.logAction('CLOUDFLARE_DETECTED_POST', { message: 'MANUAL_ACTION_REQUIRED: Pausing for manual clearance. Zero bypass attempts.' });
        result.actionSequence.push('10. Report CLOUDFLARE_MANUAL_ACTION_REQUIRED and observe for clearance');

        const cleared = await this.waitForManualChallengeClearance(this.page, this.manualChallengeTimeoutMs);
        if (!cleared) {
          result.error = 'Cloudflare challenge remained active after manual observation window';
          this.logAction('CHALLENGE_TIMEOUT_OR_UNSOLVED');
          return result;
        }
      }

      // Step 11: Post is accessible
      result.post.accessible = true;
      this.state = CAPTURE_STATES.POST_ACCESSIBLE;
      this.logAction('POST_ACCESSIBLE', { title: await this.page.title().catch(() => '') });
      result.actionSequence.push('11. Post verified accessible');

      const d4 = await humanDelay('after_post_accessible', this.page, this.actionDelayMinMs, this.actionDelayMaxMs);
      result.delaysUsed.push({ step: 'after_post_accessible', delayMs: d4 });
      result.actionSequence.push(`11b. Wait ${d4}ms after post accessibility confirmed`);

      // Step 12: Inspect all frames
      this.logAction('INSPECT_ALL_FRAMES');
      const allFrames = this.page.frames();
      result.actionSequence.push(`12. Inspect all frames (total=${allFrames.length})`);

      // Step 13: Wait 3–5 seconds
      const d5 = await humanDelay('after_frame_inspection', this.page, this.actionDelayMinMs, this.actionDelayMaxMs);
      result.delaysUsed.push({ step: 'after_frame_inspection', delayMs: d5 });
      result.actionSequence.push(`13. Wait ${d5}ms after frame inspection`);

      // Step 14: Identify the player iframe
      let playerFrame = allFrames.find((f) => {
        const u = (f.url() || '').toLowerCase();
        return u.includes('player.php') || u.includes('/player/') || u.includes('embed') || u.includes('iframe');
      });

      if (!playerFrame) {
        // Fallback: search main document for iframe
        const frameSrc = await this.page.evaluate(() => {
          const ifr = document.querySelector('iframe[src*="player"], iframe[src*="embed"], iframe#player-iframe, iframe');
          return ifr ? ifr.src : null;
        }).catch(() => null);

        if (frameSrc) {
          playerFrame = allFrames.find((f) => f.url() === frameSrc || (frameSrc && f.url().includes(frameSrc.split('?')[0])));
        }
      }

      if (!playerFrame) {
        this.state = CAPTURE_STATES.PLAYER_NOT_FOUND;
        result.state = CAPTURE_STATES.PLAYER_NOT_FOUND;
        result.error = 'Player iframe not found in frame hierarchy';
        this.logAction('PLAYER_NOT_FOUND');
        return result;
      }

      result.player.found = true;
      result.player.frameUrl = redactUrl(playerFrame.url());
      this.logAction('PLAYER_IFRAME_IDENTIFIED', { frameUrl: result.player.frameUrl });
      result.actionSequence.push(`14. Identify player iframe (${result.player.frameUrl})`);

      // Step 15: Wait 3–5 seconds
      const d6 = await humanDelay('after_player_iframe_identification', this.page, this.actionDelayMinMs, this.actionDelayMaxMs);
      result.delaysUsed.push({ step: 'after_player_iframe_identification', delayMs: d6 });
      result.actionSequence.push(`15. Wait ${d6}ms after player iframe identification`);

      // Step 16: Inspect the player iframe
      this.logAction('INSPECT_PLAYER_IFRAME');
      result.actionSequence.push('16. Inspect player iframe content & DOM');

      // Check for challenge inside the player iframe
      const frameTitle = (await playerFrame.title().catch(() => '')).toLowerCase();
      const frameContent = await playerFrame.content().catch(() => '');
      const isPlayerChallenged = frameTitle.includes('just a moment') || frameContent.includes('challenge-running') || frameContent.includes('cf-browser-verification');

      if (isPlayerChallenged) {
        this.state = CAPTURE_STATES.CLOUDFLARE_MANUAL_ACTION_REQUIRED;
        result.state = CAPTURE_STATES.CLOUDFLARE_MANUAL_ACTION_REQUIRED;
        this.logAction('CLOUDFLARE_DETECTED_PLAYER', { message: 'Player iframe returned Cloudflare Managed Challenge' });
        result.error = 'Player iframe gated by Cloudflare challenge';
        return result;
      }

      result.player.domLoaded = true;

      // Step 17: If player requires normal user interaction to initialize, perform legitimate UI interaction
      this.logAction('CHECK_PLAYER_INTERACTION');
      let interacted = false;
      try {
        const hasPlayButton = await playerFrame.$(this.playInteractionSelector);
        if (hasPlayButton) {
          this.logAction('PERFORM_PLAY_INTERACTION', { selector: this.playInteractionSelector });
          await pacedClick(playerFrame, this.playInteractionSelector, {
            timeout: 3000,
            preDelayMs: 200,
            postDelayMs: 200
          }).catch(() => {});
          interacted = true;
        } else {
          // Check for video click-to-play
          const videoEl = await playerFrame.$('video');
          if (videoEl) {
            await pacedClick(playerFrame, 'video', {
              timeout: 2000,
              preDelayMs: 200,
              postDelayMs: 200
            }).catch(() => {});
          }
        }
      } catch (e) {
        console.warn(`[player-interaction] Interaction note: ${e.message}`);
      }
      result.actionSequence.push(`17. Player initialization UI interaction (interacted=${interacted})`);

      // Step 18: Wait 3–5 seconds
      const d7 = await humanDelay('after_player_interaction', this.page, this.actionDelayMinMs, this.actionDelayMaxMs);
      result.delaysUsed.push({ step: 'after_player_interaction', delayMs: d7 });
      result.actionSequence.push(`18. Wait ${d7}ms after player interaction`);

      // Step 19: Inspect for HTML5 <video>
      this.logAction('INSPECT_HTML5_VIDEO');
      result.actionSequence.push('19. Inspect for HTML5 <video> element');

      const videoData = await playerFrame.evaluate(() => {
        const v = document.querySelector('video');
        if (!v) return null;
        let activeSrc = v.currentSrc || v.src || '';
        if (!activeSrc) {
          const sourceEl = v.querySelector('source');
          if (sourceEl) activeSrc = sourceEl.src || sourceEl.getAttribute('src') || '';
        }
        return {
          currentSrc: v.currentSrc || activeSrc || '',
          src: v.src || v.getAttribute('src') || '',
          duration: (typeof v.duration === 'number' && !isNaN(v.duration) && isFinite(v.duration)) ? v.duration : null,
          videoWidth: v.videoWidth || 0,
          videoHeight: v.videoHeight || 0,
          readyState: v.readyState
        };
      }).catch(() => null);

      // Step 20: Wait 3–5 seconds
      const d8 = await humanDelay('after_video_inspection', this.page, this.actionDelayMinMs, this.actionDelayMaxMs);
      result.delaysUsed.push({ step: 'after_video_inspection', delayMs: d8 });
      result.actionSequence.push(`20. Wait ${d8}ms after video element inspection`);

      if (!videoData) {
        this.state = CAPTURE_STATES.VIDEO_NOT_FOUND;
        result.state = CAPTURE_STATES.VIDEO_NOT_FOUND;
        result.error = 'No HTML5 <video> element found in player frame';
        this.logAction('VIDEO_NOT_FOUND');
        return result;
      }

      result.video.found = true;
      result.video.duration = videoData.duration;
      result.video.width = videoData.videoWidth;
      result.video.height = videoData.videoHeight;
      result.video.readyState = videoData.readyState;

      // Step 21: Read video currentSrc and src
      const rawCurrentSrc = videoData.currentSrc || videoData.src;
      result.video.currentSrc = rawCurrentSrc;
      result.video.src = videoData.src;
      result.actionSequence.push('21. Read video playback metadata (readyState, dimensions, duration, currentSrc)');

      if (!rawCurrentSrc) {
        this.state = CAPTURE_STATES.VIDEO_SOURCE_NOT_FOUND;
        result.state = CAPTURE_STATES.VIDEO_SOURCE_NOT_FOUND;
        result.error = 'HTML5 <video> element found but currentSrc is empty';
        this.logAction('VIDEO_SOURCE_NOT_FOUND');
        return result;
      }

      // Step 22 & 23: Store in output JSON with redacted logs
      this.state = CAPTURE_STATES.VIDEO_SOURCE_CAPTURED;
      result.state = CAPTURE_STATES.VIDEO_SOURCE_CAPTURED;
      result.success = true;

      this.logAction('VIDEO_SOURCE_CAPTURED', {
        duration: result.video.duration,
        width: result.video.width,
        height: result.video.height,
        readyState: result.video.readyState,
        redactedCurrentSrc: redactUrl(rawCurrentSrc)
      });
      result.actionSequence.push('22. Video source captured and validated');

      // Save output JSON
      const outDir = path.dirname(this.outputPath);
      if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
      }

      let srcHost = null;
      try {
        if (result.video.currentSrc) {
          srcHost = new URL(result.video.currentSrc).hostname;
        }
      } catch (e) {}

      const jsonToSave = {
        success: true,
        capturedAt: result.capturedAt,
        state: result.state,
        post: result.post,
        player: result.player,
        video: {
          found: result.video.found,
          currentSrcPresent: Boolean(result.video.currentSrc),
          currentSrcHost: srcHost,
          currentSrcRedacted: true,
          currentSrc: redactUrl(result.video.currentSrc),
          duration: result.video.duration,
          width: result.video.width,
          height: result.video.height,
          readyState: result.video.readyState
        }
      };

      fs.writeFileSync(this.outputPath, JSON.stringify(jsonToSave, null, 2), 'utf8');
      this.logAction('SAVED_OUTPUT_JSON', { outputPath: this.outputPath });
      result.actionSequence.push(`23. Saved output to ${this.outputPath}`);

      return result;

    } catch (err) {
      this.logAction('OBSERVATION_ERROR', { error: err.message });
      result.error = err.message;
      return result;
    } finally {
      if (this.context) {
        await this.context.close().catch(() => {});
        this.logAction('CLOSED_BROWSER_CONTEXT');
      }
      if (this.browser) {
        await this.browser.close().catch(() => {});
        this.logAction('CLOSED_BROWSER_INSTANCE');
      }
    }
  }
}

module.exports = {
  VideoSourceCapture,
  CAPTURE_STATES,
  ACTION_DELAY_MIN_MS,
  ACTION_DELAY_MAX_MS,
  humanDelay,
  redactUrl
};
