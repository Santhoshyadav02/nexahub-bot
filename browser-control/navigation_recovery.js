/**
 * Navigation and Recovery Module for Playwright Browser Control.
 * Handles tab tracking, popup detection, auto-closing unwanted popups,
 * refocusing main page, and legitimate challenge detection.
 */

const { URL } = require('url');

const CHALLENGE_STATES = {
  CLEAR: 'CLEAR',
  DETECTED: 'DETECTED',
  MANUAL_REQUIRED: 'LEGITIMATE/MANUAL ACTION REQUIRED'
};

/**
 * Redact sensitive query parameters from URLs.
 * @param {string} urlStr
 * @returns {string}
 */
function redactUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return urlStr || '';
  try {
    let result = urlStr;
    // Redact tokens in path (e.g. /bcdn_token=XXX&expires=YYY&token_path=ZZZ/)
    result = result.replace(/(bcdn_token=)[^&/]+/gi, '$1REDACTED');
    result = result.replace(/(expires=)[^&/]+/gi, '$1REDACTED');
    result = result.replace(/(token_path=)[^&/]+/gi, '$1REDACTED');
    result = result.replace(/(signature=)[^&/]+/gi, '$1REDACTED');
    result = result.replace(/(sig=)[^&/]+/gi, '$1REDACTED');
    result = result.replace(/(auth=)[^&/]+/gi, '$1REDACTED');
    result = result.replace(/(secret=)[^&/]+/gi, '$1REDACTED');
    result = result.replace(/(token=)[^&/]+/gi, '$1REDACTED');

    const parsed = new URL(result);
    const sensitiveKeys = ['token', 'bcdn_token', 'key', 'auth', 'sig', 'signature', 'expires', 'secret', 'token_path'];
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (sensitiveKeys.some(s => key.toLowerCase().includes(s))) {
        parsed.searchParams.set(key, 'REDACTED');
      }
    }
    return parsed.toString();
  } catch (e) {
    return urlStr.replace(/(bcdn_token|token|key|auth|sig|signature|expires|token_path)=[^&/\s]+/gi, '$1=REDACTED');
  }
}

/**
 * Check if the page or any child frame contains a security/CAPTCHA/Cloudflare challenge.
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
async function detectChallenge(page) {
  if (!page || page.isClosed()) return false;
  try {
    const frames = page.frames();
    for (const f of frames) {
      const title = (await f.title().catch(() => '')) || '';
      const lowerTitle = title.toLowerCase();
      if (
        lowerTitle.includes('just a moment') ||
        lowerTitle.includes('cloudflare') ||
        lowerTitle.includes('attention required') ||
        lowerTitle.includes('security check') ||
        lowerTitle.includes('checking your browser') ||
        lowerTitle.includes('ddos-guard') ||
        lowerTitle.includes('human verification')
      ) {
        return true;
      }

      const hasChallengeInFrame = await f.evaluate(() => {
        const selectors = [
          '#challenge-running',
          '#cf-challenge-running',
          '#challenge-form',
          '.cf-browser-verification',
          'iframe[src*="cloudflare"]',
          'iframe[src*="turnstile"]',
          '#turnstile-wrapper',
          '#cf-turnstile',
          '.h-captcha',
          'iframe[src*="hcaptcha"]',
          '.g-recaptcha',
          'iframe[src*="recaptcha"]'
        ];
        const matchSelector = selectors.some(sel => Boolean(document.querySelector(sel)));
        if (matchSelector) return true;

        const bodyText = (document.body ? document.body.innerText : '').toLowerCase();
        if (
          bodyText.includes('performing security verification') ||
          bodyText.includes('checking your browser before accessing') ||
          bodyText.includes('verify you are human')
        ) {
          return true;
        }

        return false;
      }).catch(() => false);

      if (hasChallengeInFrame) {
        return true;
      }
    }

    return false;
  } catch (e) {
    return false;
  }
}

class NavigationRecovery {
  constructor(options = {}) {
    this.logger = options.logger || console.log;
    this.closedPopupsCount = 0;
    this.lastClosedPopupUrl = null;
    this.challengeState = CHALLENGE_STATES.CLEAR;
    this.mainPage = null;
    this.context = null;
    this.isRefocused = true;
    this.onPopupClosed = options.onPopupClosed || null;
    this.onChallengeStateChanged = options.onChallengeStateChanged || null;
  }

  /**
   * Attach recovery and popup listeners to a browser context and identify mainPage.
   * @param {import('playwright').BrowserContext} context
   * @param {import('playwright').Page} mainPage
   */
  attach(context, mainPage) {
    this.context = context;
    this.mainPage = mainPage;
    this.isRefocused = true;

    context.on('page', async (newPage) => {
      if (newPage === this.mainPage) return;

      try {
        let popupUrl = 'about:blank';
        try {
          popupUrl = newPage.url();
        } catch (e) {
          // ignore
        }

        const safeUrl = redactUrl(popupUrl);
        this.closedPopupsCount++;
        this.lastClosedPopupUrl = safeUrl;
        this.isRefocused = false;

        this.logger(`[POPUP DETECTED] Popup tab detected (${safeUrl}). Initiating auto-close...`);

        // Close the popup tab
        if (!newPage.isClosed()) {
          await newPage.close().catch(() => {});
        }

        // Refocus main page
        if (this.mainPage && !this.mainPage.isClosed()) {
          await this.mainPage.bringToFront().catch(() => {});
          this.isRefocused = true;
          this.logger(`[FOCUS RESTORED] Refocused on main page (${redactUrl(this.mainPage.url())}).`);
        }

        if (typeof this.onPopupClosed === 'function') {
          this.onPopupClosed({
            closedPopupsCount: this.closedPopupsCount,
            lastClosedPopupUrl: this.lastClosedPopupUrl,
            isRefocused: this.isRefocused
          });
        }
      } catch (err) {
        this.logger(`[POPUP RECOVERY ERROR] ${err.message}`);
      }
    });
  }

  /**
   * Evaluates current challenge state on mainPage and updates status.
   * @param {import('playwright').Page} [page]
   * @returns {Promise<string>}
   */
  async checkChallenge(page = this.mainPage) {
    if (!page || page.isClosed()) {
      this.setChallengeState(CHALLENGE_STATES.CLEAR);
      return this.challengeState;
    }

    const hasChallenge = await detectChallenge(page);
    if (hasChallenge) {
      this.setChallengeState(CHALLENGE_STATES.MANUAL_REQUIRED);
    } else {
      this.setChallengeState(CHALLENGE_STATES.CLEAR);
    }
    return this.challengeState;
  }

  /**
   * Set challenge state and notify if changed.
   * @param {string} newState
   */
  setChallengeState(newState) {
    if (this.challengeState !== newState) {
      const oldState = this.challengeState;
      this.challengeState = newState;
      this.logger(`[CHALLENGE STATE] Transitioned from ${oldState} -> ${newState}`);
      if (typeof this.onChallengeStateChanged === 'function') {
        this.onChallengeStateChanged(newState);
      }
    }
  }

  /**
   * Get total open pages count in context.
   * @returns {number}
   */
  getOpenTabsCount() {
    if (!this.context) return 0;
    try {
      return this.context.pages().filter(p => !p.isClosed()).length;
    } catch (e) {
      return 0;
    }
  }

  /**
   * Get snapshot of recovery status.
   */
  getStatus() {
    return {
      challengeState: this.challengeState,
      closedPopupsCount: this.closedPopupsCount,
      lastClosedPopupUrl: this.lastClosedPopupUrl,
      isRefocused: this.isRefocused,
      openTabsCount: this.getOpenTabsCount()
    };
  }

  reset() {
    this.closedPopupsCount = 0;
    this.lastClosedPopupUrl = null;
    this.challengeState = CHALLENGE_STATES.CLEAR;
    this.isRefocused = true;
  }
}

module.exports = {
  NavigationRecovery,
  detectChallenge,
  redactUrl,
  CHALLENGE_STATES
};
