/**
 * ============================================================
 * ⏱️ PLAYWRIGHT INTERACTION PACING MODULE
 * ============================================================
 * Reusable interaction-pacing layer for Playwright Chromium.
 * Improves reliability of UI interactions by introducing configurable,
 * bounded pauses around mouse and keyboard actions.
 * 
 * Safety & Compliance:
 * - NO stealth / fingerprint spoofing
 * - NO artificial human-cursor trajectories
 * - NO Cloudflare / bot-detection evasion
 * - Standard Playwright API calls only
 */

const DEFAULT_MIN_DELAY_MS = 2000;
const DEFAULT_MAX_DELAY_MS = 5000;

/**
 * Parses and validates pacing configuration from environment variables or custom overrides.
 * 
 * @param {object} [customEnv=process.env]
 * @returns {{ minDelayMs: number, maxDelayMs: number }}
 */
function getPacingConfig(customEnv = process.env) {
  const env = customEnv || {};

  let min = DEFAULT_MIN_DELAY_MS;
  let max = DEFAULT_MAX_DELAY_MS;

  if (env.PLAYWRIGHT_ACTION_DELAY_MIN_MS !== undefined && env.PLAYWRIGHT_ACTION_DELAY_MIN_MS !== null) {
    const parsedMin = parseInt(env.PLAYWRIGHT_ACTION_DELAY_MIN_MS, 10);
    if (!Number.isNaN(parsedMin) && parsedMin >= 0) {
      min = parsedMin;
    }
  }

  if (env.PLAYWRIGHT_ACTION_DELAY_MAX_MS !== undefined && env.PLAYWRIGHT_ACTION_DELAY_MAX_MS !== null) {
    const parsedMax = parseInt(env.PLAYWRIGHT_ACTION_DELAY_MAX_MS, 10);
    if (!Number.isNaN(parsedMax) && parsedMax >= 0) {
      max = parsedMax;
    }
  }

  // Ensure max is never less than min
  if (max < min) {
    max = min;
  }

  return {
    minDelayMs: min,
    maxDelayMs: max
  };
}

/**
 * Computes a random integer delay bounded between min and max inclusive.
 * 
 * @param {number} min 
 * @param {number} max 
 * @returns {number}
 */
function computeBoundedDelay(min, max) {
  const safeMin = Math.max(0, Math.floor(min));
  const safeMax = Math.max(safeMin, Math.floor(max));
  if (safeMin === safeMax) return safeMin;
  return Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin;
}

/**
 * Sleep helper.
 * @param {number} ms 
 * @returns {Promise<void>}
 */
function sleep(ms) {
  const safeMs = Math.max(0, ms || 0);
  return new Promise(resolve => setTimeout(resolve, safeMs));
}

/**
 * Applies a pre-action delay.
 * 
 * @param {object} [options={}]
 * @returns {Promise<number>} Delay in ms that was applied
 */
async function waitBeforeAction(options = {}) {
  let delayMs;
  if (typeof options.preDelayMs === "number" && options.preDelayMs >= 0) {
    delayMs = options.preDelayMs;
  } else {
    const config = getPacingConfig(options.env);
    const min = typeof options.minDelayMs === "number" ? options.minDelayMs : config.minDelayMs;
    const max = typeof options.maxDelayMs === "number" ? options.maxDelayMs : config.maxDelayMs;
    delayMs = computeBoundedDelay(min, max);
  }

  if (delayMs > 0) {
    await sleep(delayMs);
  }
  return delayMs;
}

/**
 * Applies a post-action delay.
 * 
 * @param {object} [options={}]
 * @returns {Promise<number>} Delay in ms that was applied
 */
async function waitAfterAction(options = {}) {
  let delayMs;
  if (typeof options.postDelayMs === "number" && options.postDelayMs >= 0) {
    delayMs = options.postDelayMs;
  } else {
    const config = getPacingConfig(options.env);
    const min = typeof options.minDelayMs === "number" ? options.minDelayMs : config.minDelayMs;
    const max = typeof options.maxDelayMs === "number" ? options.maxDelayMs : config.maxDelayMs;
    delayMs = computeBoundedDelay(min, max);
  }

  if (delayMs > 0) {
    await sleep(delayMs);
  }
  return delayMs;
}

/**
 * Helper to resolve locator from page and selector, or return locator directly.
 * @private
 */
function resolveLocator(pageOrLocator, selector) {
  if (typeof pageOrLocator.locator === "function" && typeof selector === "string") {
    return pageOrLocator.locator(selector);
  }
  return pageOrLocator;
}

/**
 * Performs a paced click on a target element.
 * 
 * @param {object} pageOrLocator 
 * @param {string|object} [selectorOrOptions] 
 * @param {object} [options={}] 
 * @returns {Promise<{ action: string, preWaitMs: number, postWaitMs: number, success: boolean }>}
 */
async function pacedClick(pageOrLocator, selectorOrOptions, options = {}) {
  let selector = null;
  let opts = options;

  if (typeof selectorOrOptions === "string") {
    selector = selectorOrOptions;
  } else if (selectorOrOptions && typeof selectorOrOptions === "object") {
    opts = { ...selectorOrOptions, ...options };
  }

  const target = selector ? resolveLocator(pageOrLocator, selector) : pageOrLocator;

  // 1. Verify target usability where applicable
  if (typeof target.waitFor === "function" && opts.waitForElement !== false) {
    await target.waitFor({ state: "visible", timeout: opts.timeout || 10000 });
  }

  // 2. Pre-action wait
  const preWaitMs = await waitBeforeAction(opts);

  // 3. Normal Playwright click
  if (typeof target.click === "function") {
    await target.click(opts.clickOptions || {});
  } else if (typeof pageOrLocator.click === "function" && selector) {
    await pageOrLocator.click(selector, opts.clickOptions || {});
  }

  // 4. Post-action wait
  const postWaitMs = await waitAfterAction(opts);

  return {
    action: "click",
    preWaitMs,
    postWaitMs,
    success: true
  };
}

/**
 * Performs a paced hover over a target element.
 * 
 * @param {object} pageOrLocator 
 * @param {string|object} [selectorOrOptions] 
 * @param {object} [options={}] 
 * @returns {Promise<{ action: string, preWaitMs: number, postWaitMs: number, success: boolean }>}
 */
async function pacedHover(pageOrLocator, selectorOrOptions, options = {}) {
  let selector = null;
  let opts = options;

  if (typeof selectorOrOptions === "string") {
    selector = selectorOrOptions;
  } else if (selectorOrOptions && typeof selectorOrOptions === "object") {
    opts = { ...selectorOrOptions, ...options };
  }

  const target = selector ? resolveLocator(pageOrLocator, selector) : pageOrLocator;

  if (typeof target.waitFor === "function" && opts.waitForElement !== false) {
    await target.waitFor({ state: "visible", timeout: opts.timeout || 10000 });
  }

  const preWaitMs = await waitBeforeAction(opts);

  if (typeof target.hover === "function") {
    await target.hover(opts.hoverOptions || {});
  } else if (typeof pageOrLocator.hover === "function" && selector) {
    await pageOrLocator.hover(selector, opts.hoverOptions || {});
  }

  const postWaitMs = await waitAfterAction(opts);

  return {
    action: "hover",
    preWaitMs,
    postWaitMs,
    success: true
  };
}

/**
 * Performs a paced mouse movement to coordinates (x, y) using standard Playwright mouse APIs.
 * 
 * @param {object} page 
 * @param {number} x 
 * @param {number} y 
 * @param {object} [options={}] 
 * @returns {Promise<{ action: string, x: number, y: number, preWaitMs: number, postWaitMs: number, success: boolean }>}
 */
async function pacedMouseMove(page, x, y, options = {}) {
  const preWaitMs = await waitBeforeAction(options);

  if (page && page.mouse && typeof page.mouse.move === "function") {
    await page.mouse.move(x, y, options.mouseOptions || {});
  }

  const postWaitMs = await waitAfterAction(options);

  return {
    action: "mouseMove",
    x,
    y,
    preWaitMs,
    postWaitMs,
    success: true
  };
}

/**
 * Performs a paced key press on a target element or page.
 * 
 * @param {object} pageOrLocator 
 * @param {string} selectorOrKey 
 * @param {string|object} [keyOrOptions] 
 * @param {object} [options={}] 
 * @returns {Promise<{ action: string, key: string, preWaitMs: number, postWaitMs: number, success: boolean }>}
 */
async function pacedPress(pageOrLocator, selectorOrKey, keyOrOptions, options = {}) {
  let selector = null;
  let key = "";
  let opts = options;

  if (typeof keyOrOptions === "string") {
    selector = selectorOrKey;
    key = keyOrOptions;
  } else {
    key = selectorOrKey;
    if (keyOrOptions && typeof keyOrOptions === "object") {
      opts = { ...keyOrOptions, ...options };
    }
  }

  const target = selector ? resolveLocator(pageOrLocator, selector) : pageOrLocator;

  if (selector && typeof target.waitFor === "function" && opts.waitForElement !== false) {
    await target.waitFor({ state: "visible", timeout: opts.timeout || 10000 });
  }

  const preWaitMs = await waitBeforeAction(opts);

  if (typeof target.press === "function") {
    await target.press(key, opts.pressOptions || {});
  } else if (pageOrLocator.keyboard && typeof pageOrLocator.keyboard.press === "function") {
    await pageOrLocator.keyboard.press(key, opts.pressOptions || {});
  }

  const postWaitMs = await waitAfterAction(opts);

  return {
    action: "press",
    key,
    preWaitMs,
    postWaitMs,
    success: true
  };
}

/**
 * Performs a paced text fill on an input / textarea element.
 * 
 * @param {object} pageOrLocator 
 * @param {string} selectorOrText 
 * @param {string|object} [textOrOptions] 
 * @param {object} [options={}] 
 * @returns {Promise<{ action: string, text: string, preWaitMs: number, postWaitMs: number, success: boolean }>}
 */
async function pacedFill(pageOrLocator, selectorOrText, textOrOptions, options = {}) {
  let selector = null;
  let text = "";
  let opts = options;

  if (typeof textOrOptions === "string") {
    selector = selectorOrText;
    text = textOrOptions;
  } else {
    text = selectorOrText;
    if (textOrOptions && typeof textOrOptions === "object") {
      opts = { ...textOrOptions, ...options };
    }
  }

  const target = selector ? resolveLocator(pageOrLocator, selector) : pageOrLocator;

  if (typeof target.waitFor === "function" && opts.waitForElement !== false) {
    await target.waitFor({ state: "visible", timeout: opts.timeout || 10000 });
  }

  const preWaitMs = await waitBeforeAction(opts);

  if (typeof target.fill === "function") {
    await target.fill(text, opts.fillOptions || {});
  } else if (typeof pageOrLocator.fill === "function" && selector) {
    await pageOrLocator.fill(selector, text, opts.fillOptions || {});
  }

  const postWaitMs = await waitAfterAction(opts);

  return {
    action: "fill",
    text,
    preWaitMs,
    postWaitMs,
    success: true
  };
}

module.exports = {
  DEFAULT_MIN_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
  getPacingConfig,
  computeBoundedDelay,
  sleep,
  waitBeforeAction,
  waitAfterAction,
  pacedClick,
  pacedHover,
  pacedMouseMove,
  pacedPress,
  pacedFill
};
