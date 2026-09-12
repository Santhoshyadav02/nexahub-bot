/**
 * Browser Controller Module for Playwright Browser Control.
 * Manages Chromium browser lifecycle, coordinate navigation recovery,
 * frame and video inspection, and emits real-time timestamped logs and events.
 */

const { EventEmitter } = require('events');
const { chromium } = require('playwright');
const { NavigationRecovery, redactUrl, CHALLENGE_STATES } = require('./navigation_recovery');
const { inspectFrames } = require('./frame_inspector');
const { inspectVideos } = require('./video_inspector');
const {
  pacedClick,
  pacedHover,
  pacedMouseMove,
  pacedPress,
  pacedFill
} = require('./interaction_pacing');

const BROWSER_STATES = {
  STOPPED: 'STOPPED',
  STARTING: 'STARTING',
  RUNNING: 'RUNNING',
  ERROR: 'ERROR'
};

const LOAD_STATES = {
  UNLOADED: 'UNLOADED',
  LOADING: 'LOADING',
  DOM_LOADED: 'DOM_LOADED',
  NETWORK_IDLE: 'NETWORK_IDLE',
  TIMEOUT: 'TIMEOUT',
  ERROR: 'ERROR'
};

class BrowserController extends EventEmitter {
  constructor(options = {}) {
    super();
    this.maxLogs = options.maxLogs || 500;
    this.logs = [];
    this.browserState = BROWSER_STATES.STOPPED;
    this.loadState = LOAD_STATES.UNLOADED;
    this.currentPageUrl = '';
    this.mainPageUrl = '';
    this.pageTitle = '';
    this.error = null;

    this.browser = null;
    this.context = null;
    this.mainPage = null;

    this.recovery = new NavigationRecovery({
      logger: (msg) => this.addLog('INFO', msg),
      onPopupClosed: (data) => this.emit('popup_closed', data),
      onChallengeStateChanged: (state) => this.emit('challenge_changed', state)
    });

    this.framesData = { totalFrames: 0, frames: [], candidatePlayerFrames: [] };
    this.videosData = { videoCount: 0, videos: [] };
    this.pollTimer = null;

    this.manualWaitStatus = {
      isWaiting: false,
      reason: null,
      challengeDetectedAt: null
    };
  }

  addLog(level, message, details = null) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level: level.toUpperCase(),
      message,
      details: details ? redactUrl(JSON.stringify(details)) : null
    };

    this.logs.push(logEntry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    this.emit('log', logEntry);
    this.emit('state_updated', this.getState());
  }

  getLogs() {
    return [...this.logs];
  }

  clearLogs() {
    this.logs = [];
    this.emit('logs_cleared');
  }

  getState() {
    const elapsedSeconds = (this.manualWaitStatus.isWaiting && this.manualWaitStatus.challengeDetectedAt)
      ? Math.max(0, Math.floor((Date.now() - new Date(this.manualWaitStatus.challengeDetectedAt).getTime()) / 1000))
      : 0;

    return {
      browserState: this.browserState,
      loadState: this.loadState,
      currentPageUrl: redactUrl(this.currentPageUrl),
      mainPageUrl: redactUrl(this.mainPageUrl),
      pageTitle: this.pageTitle,
      openTabsCount: this.recovery.getOpenTabsCount(),
      recoveryStatus: this.recovery.getStatus(),
      manualWaitStatus: {
        isWaiting: this.manualWaitStatus.isWaiting,
        reason: this.manualWaitStatus.reason,
        challengeDetectedAt: this.manualWaitStatus.challengeDetectedAt,
        elapsedSeconds
      },
      frameInspection: this.framesData,
      videoInspection: this.videosData,
      error: this.error
    };
  }

  /**
   * Launch browser and open initial URL.
   * @param {string} url
   * @param {Object} [options]
   */
  async start(url, options = {}) {
    if (this.browserState === BROWSER_STATES.STARTING || this.browserState === BROWSER_STATES.RUNNING) {
      if (url && url !== this.currentPageUrl) {
        return this.navigate(url, options);
      }
      return this.getState();
    }

    this.browserState = BROWSER_STATES.STARTING;
    this.loadState = LOAD_STATES.LOADING;
    this.error = null;
    this.addLog('INFO', `[BROWSER LAUNCH] Launching Chromium (headless: ${options.headless !== false})...`);

    try {
      const headless = options.headless !== false;
      const launchOptions = {
        headless,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled'
        ]
      };
      if (options.proxy) {
        launchOptions.proxy = options.proxy;
      }

      this.browser = await chromium.launch(launchOptions);

      this.context = await this.browser.newContext({
        userAgent: options.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 720 },
        ignoreHTTPSErrors: true
      });

      this.mainPage = await this.context.newPage();
      this.recovery.attach(this.context, this.mainPage);

      this.browserState = BROWSER_STATES.RUNNING;
      this.addLog('INFO', '[BROWSER READY] Chromium instance active and attached to navigation recovery.');

      // Setup page event listeners
      this.mainPage.on('framenavigated', async (frame) => {
        if (frame === this.mainPage.mainFrame()) {
          this.currentPageUrl = this.mainPage.url();
          this.pageTitle = await this.mainPage.title().catch(() => '');
          this.addLog('INFO', `[MAIN FRAME NAVIGATED] URL: ${redactUrl(this.currentPageUrl)} | Title: ${this.pageTitle}`);
        } else {
          this.addLog('INFO', `[CHILD FRAME NAVIGATED] Frame (${frame.name() || 'unnamed'}): ${redactUrl(frame.url())}`);
        }
        await this.inspect().catch(() => {});
      });

      this.mainPage.on('crash', () => {
        this.browserState = BROWSER_STATES.ERROR;
        this.loadState = LOAD_STATES.ERROR;
        this.error = 'Page crashed unexpectedly';
        this.addLog('ERROR', '[PAGE CRASH] Main page crashed.');
      });

      if (url) {
        await this.navigate(url, options);
      }

      this._startAutoPoll();

      return this.getState();
    } catch (err) {
      this.browserState = BROWSER_STATES.ERROR;
      this.loadState = LOAD_STATES.ERROR;
      this.error = err.message;
      this.addLog('ERROR', `[BROWSER LAUNCH FAILED] ${err.message}`);
      await this.stop().catch(() => {});
      throw err;
    }
  }

  /**
   * Navigate main page to target URL.
   * @param {string} url
   * @param {Object} [options]
   */
  async navigate(url, options = {}) {
    if (!this.mainPage || this.mainPage.isClosed()) {
      throw new Error('Browser is not running. Please start the browser first.');
    }

    const safeTarget = redactUrl(url);
    this.loadState = LOAD_STATES.LOADING;
    this.addLog('INFO', `[NAVIGATION START] Navigating to ${safeTarget}...`);

    try {
      const timeoutMs = options.timeoutMs || 30000;
      
      // Navigate to domcontentloaded first
      await this.mainPage.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs
      });

      this.currentPageUrl = this.mainPage.url();
      this.mainPageUrl = this.currentPageUrl;
      this.pageTitle = await this.mainPage.title().catch(() => '');
      this.loadState = LOAD_STATES.DOM_LOADED;
      this.addLog('INFO', `[DOM LOADED] Page ready. Title: ${this.pageTitle}`);

      // Check for challenge
      const challenge = await this.recovery.checkChallenge(this.mainPage);
      if (challenge === CHALLENGE_STATES.MANUAL_REQUIRED) {
        this.addLog('WARN', '[CHALLENGE DETECTED] Legitimate security challenge detected. Manual/authorized action required. Standing by.');
      }

      // Try waiting for networkidle gracefully
      try {
        await this.mainPage.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        this.loadState = LOAD_STATES.NETWORK_IDLE;
        this.addLog('INFO', '[NETWORK IDLE] Network activity stabilized.');
      } catch (e) {
        // networkidle timeout is non-fatal
      }

      await this.inspect();
      return this.getState();
    } catch (err) {
      if (err.name === 'TimeoutError') {
        this.loadState = LOAD_STATES.TIMEOUT;
        this.addLog('WARN', `[NAVIGATION TIMEOUT] Navigation to ${safeTarget} timed out, inspecting available DOM.`);
        await this.inspect().catch(() => {});
        return this.getState();
      } else {
        this.loadState = LOAD_STATES.ERROR;
        this.error = err.message;
        this.addLog('ERROR', `[NAVIGATION ERROR] ${err.message}`);
        throw err;
      }
    }
  }

  /**
   * Run frame and video inspection on the current page.
   */
  async inspect() {
    if (!this.mainPage || this.mainPage.isClosed()) {
      return this.getState();
    }

    try {
      this.currentPageUrl = this.mainPage.url();
      this.pageTitle = await this.mainPage.title().catch(() => '');
      
      // Update challenge check
      const challengeState = await this.recovery.checkChallenge(this.mainPage);

      if (challengeState === CHALLENGE_STATES.MANUAL_REQUIRED) {
        if (!this.manualWaitStatus.isWaiting) {
          this.manualWaitStatus.isWaiting = true;
          this.manualWaitStatus.challengeDetectedAt = new Date().toISOString();
          this.manualWaitStatus.reason = 'Security challenge detected (Cloudflare Managed Challenge / Turnstile)';
          this.addLog('WARN', '[MANUAL_ACTION_REQUIRED] Browser remaining open in manual verification state. Waiting for authorization/resolution.');
          this.emit('manual_action_required', this.getState());
        }
      } else if (challengeState === CHALLENGE_STATES.CLEAR) {
        if (this.manualWaitStatus.isWaiting) {
          this.manualWaitStatus.isWaiting = false;
          this.manualWaitStatus.challengeDetectedAt = null;
          this.manualWaitStatus.reason = null;
          this.addLog('INFO', '[MANUAL VERIFICATION CLEARED] Challenge resolved! Automatically resumed player & frame inspection.');
          this.emit('resumed', this.getState());
        }
      }

      // Frame inspection
      const frames = await inspectFrames(this.mainPage);
      this.framesData = frames;

      // Video inspection
      const videos = await inspectVideos(this.mainPage);
      this.videosData = videos;

      if (videos.videoCount > 0) {
        this.addLog('INFO', `[VIDEO DISCOVERED] Found ${videos.videoCount} <video> element(s). Active source: ${videos.videos[0].currentSrc || 'pending'}`);
      }

      this.emit('inspected', this.getState());
      return this.getState();
    } catch (err) {
      this.addLog('WARN', `[INSPECTION WARNING] ${err.message}`);
      return this.getState();
    }
  }

  /**
   * Resume inspection after manual user verification.
   */
  async resume() {
    this.addLog('INFO', '[RESUME TRIGGERED] Re-evaluating browser challenge state and inspecting media player...');
    if (!this.mainPage || this.mainPage.isClosed()) {
      throw new Error('Cannot resume: browser is not running.');
    }

    const challenge = await this.recovery.checkChallenge(this.mainPage);
    if (challenge === CHALLENGE_STATES.CLEAR) {
      this.manualWaitStatus.isWaiting = false;
      this.manualWaitStatus.challengeDetectedAt = null;
      this.manualWaitStatus.reason = null;
      this.addLog('INFO', '[RESUME SUCCESS] Security challenge cleared. Full inspection active.');
    } else {
      this.addLog('WARN', '[RESUME PENDING] Challenge still active. Please complete manual verification.');
    }

    await this.inspect();
    this.emit('state_updated', this.getState());
    return this.getState();
  }

  /**
   * Performs a paced click on a target selector or locator on the main page.
   * @param {string|object} selector 
   * @param {object} [options] 
   */
  async click(selector, options = {}) {
    if (!this.mainPage || this.mainPage.isClosed()) {
      throw new Error('Browser is not running.');
    }
    this.addLog('INFO', `[PACED CLICK] Target: ${typeof selector === 'string' ? selector : 'locator'}`);
    const res = await pacedClick(this.mainPage, selector, options);
    await this.inspect().catch(() => {});
    return res;
  }

  /**
   * Performs a paced hover over a target selector or locator on the main page.
   * @param {string|object} selector 
   * @param {object} [options] 
   */
  async hover(selector, options = {}) {
    if (!this.mainPage || this.mainPage.isClosed()) {
      throw new Error('Browser is not running.');
    }
    this.addLog('INFO', `[PACED HOVER] Target: ${typeof selector === 'string' ? selector : 'locator'}`);
    const res = await pacedHover(this.mainPage, selector, options);
    return res;
  }

  /**
   * Performs a paced mouse movement to coordinates (x, y).
   * @param {number} x 
   * @param {number} y 
   * @param {object} [options] 
   */
  async mouseMove(x, y, options = {}) {
    if (!this.mainPage || this.mainPage.isClosed()) {
      throw new Error('Browser is not running.');
    }
    this.addLog('INFO', `[PACED MOUSE MOVE] Coordinates: (${x}, ${y})`);
    return await pacedMouseMove(this.mainPage, x, y, options);
  }

  /**
   * Performs a paced key press.
   * @param {string|object} selectorOrKey 
   * @param {string|object} [keyOrOptions] 
   * @param {object} [options] 
   */
  async press(selectorOrKey, keyOrOptions, options = {}) {
    if (!this.mainPage || this.mainPage.isClosed()) {
      throw new Error('Browser is not running.');
    }
    this.addLog('INFO', '[PACED KEY PRESS] Executing keyboard press.');
    const res = await pacedPress(this.mainPage, selectorOrKey, keyOrOptions, options);
    await this.inspect().catch(() => {});
    return res;
  }

  /**
   * Performs a paced form/input fill.
   * @param {string|object} selector 
   * @param {string} text 
   * @param {object} [options] 
   */
  async fill(selector, text, options = {}) {
    if (!this.mainPage || this.mainPage.isClosed()) {
      throw new Error('Browser is not running.');
    }
    this.addLog('INFO', `[PACED FILL] Target: ${typeof selector === 'string' ? selector : 'locator'}`);
    const res = await pacedFill(this.mainPage, selector, text, options);
    await this.inspect().catch(() => {});
    return res;
  }

  _startAutoPoll() {
    this._stopAutoPoll();
    this.pollTimer = setInterval(async () => {
      if (this.browserState === BROWSER_STATES.RUNNING && this.mainPage && !this.mainPage.isClosed()) {
        try {
          await this.inspect();
        } catch (e) {
          // ignore background poll errors
        }
      }
    }, 3000);
  }

  _stopAutoPoll() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Stop browser, cleanup resources and reset states.
   */
  async stop() {
    this._stopAutoPoll();
    this.browserState = BROWSER_STATES.STOPPED;
    this.loadState = LOAD_STATES.UNLOADED;

    try {
      if (this.context) {
        await this.context.close().catch(() => {});
      }
      if (this.browser) {
        await this.browser.close().catch(() => {});
      }
    } catch (e) {
      // ignore
    } finally {
      this.browser = null;
      this.context = null;
      this.mainPage = null;
      this.recovery.reset();
      this.addLog('INFO', '[BROWSER STOPPED] Browser resources cleaned up successfully.');
    }

    this.emit('state_updated', this.getState());
    return this.getState();
  }
}

module.exports = {
  BrowserController,
  BROWSER_STATES,
  LOAD_STATES,
  CHALLENGE_STATES,
  redactUrl
};
