/**
 * ============================================================
 * 🧭 SHARED CHROMIUM EXECUTABLE RESOLUTION & SAFE LAUNCH
 * ============================================================
 * Single place that decides which Chromium binary Playwright launches.
 *
 * - An env-provided path (PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, CHROME_BIN,
 *   CHROMIUM_PATH) is only used when the file actually exists.
 * - Otherwise `undefined` is returned so Playwright uses the browser it
 *   installed itself (`npx playwright install --with-deps chromium`).
 * - No `which chromium` lookups (Ubuntu's snap chromium-browser wrapper does
 *   not work under PM2/systemd/root) and no hardcoded Nix profile paths.
 * - If a custom executable fails to launch, the launch is retried once with
 *   Playwright's bundled Chromium.
 * - Every launch is forced to include --no-sandbox and --disable-dev-shm-usage
 *   (required for root/containers and small /dev/shm on a VPS).
 */

const fs = require("fs");

const EXECUTABLE_ENV_VARS = Object.freeze([
  "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH",
  "CHROME_BIN",
  "CHROMIUM_PATH"
]);

const REQUIRED_CHROMIUM_ARGS = Object.freeze([
  "--no-sandbox",
  "--disable-dev-shm-usage"
]);

const BUNDLED_EXECUTABLE_LABEL = "playwright-bundled";

const warnedMissingPaths = new Set();

/**
 * Resolves a custom Chromium executable from the environment.
 * @param {object} [env=process.env]
 * @param {object} [deps]
 * @param {Function} [deps.existsSync] Injectable for tests
 * @returns {string|undefined} Existing custom path, or undefined for Playwright's bundled browser
 */
function resolveChromiumExecutablePath(env = process.env, deps = {}) {
  const existsSync = typeof deps.existsSync === "function" ? deps.existsSync : fs.existsSync;
  const source = env || {};

  for (const name of EXECUTABLE_ENV_VARS) {
    const raw = source[name] ? String(source[name]).trim() : "";
    if (!raw) continue;

    let exists = false;
    try {
      exists = Boolean(existsSync(raw));
    } catch (e) {
      exists = false;
    }

    if (exists) {
      return raw;
    }

    const warnKey = `${name}=${raw}`;
    if (!warnedMissingPaths.has(warnKey)) {
      warnedMissingPaths.add(warnKey);
      console.warn(`⚠️ [CHROMIUM] ${name} points to a missing file (${raw}); ignoring it and using Playwright's bundled Chromium.`);
    }
  }

  return undefined;
}

/**
 * Returns launch args with the required VPS-safe flags present exactly once.
 * @param {string[]} [args]
 * @returns {string[]}
 */
function withRequiredChromiumArgs(args = []) {
  const merged = Array.isArray(args) ? [...args] : [];
  for (const flag of REQUIRED_CHROMIUM_ARGS) {
    if (!merged.includes(flag)) {
      merged.push(flag);
    }
  }
  return merged;
}

/**
 * Launches via `launchFn(options)` using a custom executable when one is
 * configured, falling back once to Playwright's bundled Chromium on failure.
 *
 * @param {Function} launchFn e.g. (opts) => chromium.launch(opts)
 * @param {object} [launchOptions]
 * @param {object} [settings]
 * @param {string|null} [settings.executablePath] Explicit override; resolved from env when omitted
 * @param {string} [settings.logPrefix="[CHROMIUM]"]
 * @returns {Promise<{ browser: any, executablePath: string }>}
 */
async function launchWithExecutableFallback(launchFn, launchOptions = {}, settings = {}) {
  if (typeof launchFn !== "function") {
    throw new Error("[CHROMIUM] launchWithExecutableFallback requires a launch function");
  }
  const logPrefix = settings.logPrefix || "[CHROMIUM]";

  const baseOptions = { ...launchOptions };
  delete baseOptions.executablePath;
  baseOptions.args = withRequiredChromiumArgs(baseOptions.args);
  if (baseOptions.headless === undefined) {
    baseOptions.headless = true;
  }

  const customPath = settings.executablePath !== undefined && settings.executablePath !== null
    ? settings.executablePath
    : resolveChromiumExecutablePath();

  if (customPath) {
    try {
      const browser = await launchFn({ ...baseOptions, executablePath: customPath });
      return { browser, executablePath: customPath };
    } catch (err) {
      console.warn(`⚠️ ${logPrefix} Custom Chromium at ${customPath} failed to launch (${err.message}). Retrying once with Playwright's bundled Chromium.`);
    }
  }

  const browser = await launchFn(baseOptions);
  return { browser, executablePath: BUNDLED_EXECUTABLE_LABEL };
}

/**
 * Convenience wrapper for `chromium.launch` with executable fallback.
 * @param {import('playwright').BrowserType} chromium
 * @param {object} [launchOptions]
 * @param {object} [settings]
 * @returns {Promise<{ browser: import('playwright').Browser, executablePath: string }>}
 */
function launchChromium(chromium, launchOptions = {}, settings = {}) {
  return launchWithExecutableFallback((opts) => chromium.launch(opts), launchOptions, settings);
}

module.exports = {
  resolveChromiumExecutablePath,
  withRequiredChromiumArgs,
  launchWithExecutableFallback,
  launchChromium,
  EXECUTABLE_ENV_VARS,
  REQUIRED_CHROMIUM_ARGS,
  BUNDLED_EXECUTABLE_LABEL
};
