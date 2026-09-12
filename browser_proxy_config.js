/**
 * ============================================================
 * 🔒 BROWSER PROXY CONFIGURATION MODULE
 * ============================================================
 * Isolated, reusable fixed-proxy configuration layer for Playwright Chromium.
 * 
 * Safety & Security Guarantees:
 * - Single fixed proxy egress (Zero proxy rotation)
 * - Zero hard-coded credentials
 * - Strict credential redaction in all logs and status methods
 * - Preserves direct-network behavior when FIXED_PROXY_SERVER is unset
 */

const { URL } = require("url");

/**
 * Parses and sanitizes proxy configuration from environment variables or custom overrides.
 * 
 * @param {object} [customEnv=process.env]
 * @returns {{ server: string, username?: string, password?: string } | undefined}
 */
function getFixedProxyConfig(customEnv = process.env) {
  const env = customEnv || {};
  let server = env.FIXED_PROXY_SERVER ? String(env.FIXED_PROXY_SERVER).trim() : "";
  let username = env.FIXED_PROXY_USERNAME ? String(env.FIXED_PROXY_USERNAME).trim() : "";
  let password = env.FIXED_PROXY_PASSWORD ? String(env.FIXED_PROXY_PASSWORD).trim() : "";

  if (!server) {
    return undefined;
  }

  // Ensure protocol is present
  if (!/^https?:\/\//i.test(server) && !/^socks5?:\/\//i.test(server)) {
    server = `http://${server}`;
  }

  try {
    const parsed = new URL(server);

    // Extract credentials if embedded in server URL
    if (parsed.username && !username) {
      username = decodeURIComponent(parsed.username);
    }
    if (parsed.password && !password) {
      password = decodeURIComponent(parsed.password);
    }

    // Server must not contain credentials in the URL string passed to Playwright
    const sanitizedServer = `${parsed.protocol}//${parsed.host}`;

    const config = {
      server: sanitizedServer
    };

    if (username) {
      config.username = username;
    }
    if (password) {
      config.password = password;
    }

    return config;
  } catch (err) {
    // If URL parsing fails, return raw server string without credentials
    return { server: server.replace(/\/\/[^@]+@/, "//") };
  }
}

/**
 * Returns a safe, fully redacted proxy status object for logs and monitoring.
 * 
 * @param {object} [customEnv=process.env]
 * @returns {{ proxyConfigured: boolean, proxyServer: string | null }}
 */
function getSafeProxyStatus(customEnv = process.env) {
  const config = getFixedProxyConfig(customEnv);
  if (!config || !config.server) {
    return {
      proxyConfigured: false,
      proxyServer: null
    };
  }

  return {
    proxyConfigured: true,
    proxyServer: config.server
  };
}

/**
 * Redacts any credentials present in a proxy URL string.
 * 
 * @param {string} urlStr
 * @returns {string}
 */
function redactProxyUrl(urlStr) {
  if (!urlStr || typeof urlStr !== "string") return "";
  return urlStr.replace(/(https?:\/\/|socks5?:\/\/)[^:]+:[^@]+@/gi, "$1***:***@");
}

/**
 * Injects fixed proxy settings into Playwright launch options if configured.
 * 
 * @param {object} [launchOptions={}]
 * @param {object} [customEnv=process.env]
 * @returns {object}
 */
function applyProxyToLaunchOptions(launchOptions = {}, customEnv = process.env) {
  const opts = { ...launchOptions };
  if (!opts.proxy) {
    const proxyConfig = getFixedProxyConfig(customEnv);
    if (proxyConfig) {
      opts.proxy = proxyConfig;
    }
  }
  return opts;
}

module.exports = {
  getFixedProxyConfig,
  getSafeProxyStatus,
  redactProxyUrl,
  applyProxyToLaunchOptions
};
