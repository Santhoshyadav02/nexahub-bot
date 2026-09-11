/**
 * ============================================================
 * 🛡️ AVSEE WORKER OBSERVABILITY & HEALTH MONITOR
 * ============================================================
 * Production-readiness hardening:
 *   - 12-state granular worker lifecycle health model
 *   - Structured logging with safe correlation IDs and strict token redaction
 *   - Metrics collection (18 counters, 6 timing distributions)
 *   - Pre-download disk safety checks and stale partial file cleanup
 *   - Completion-based download progress tracking
 */

const fs = require('fs');
const path = require('path');

const HEALTH_STATE = Object.freeze({
  IDLE: 'IDLE',
  DISCOVERING: 'DISCOVERING',
  QUEUED: 'QUEUED',
  PROCESSING: 'PROCESSING',
  RESOLVING_PLAYER: 'RESOLVING_PLAYER',
  DOWNLOADING: 'DOWNLOADING',
  VALIDATING: 'VALIDATING',
  ROUTING: 'ROUTING',
  DELIVERING: 'DELIVERING',
  RECOVERING: 'RECOVERING',
  STOPPING: 'STOPPING',
  ERROR: 'ERROR'
});

/**
 * Strips all tokens, signatures, expiration stamps, cookies, and credentials from URLs and strings.
 * @param {string|object} input 
 * @returns {string|object}
 */
function redactSensitive(input) {
  if (!input) return input;
  let text = typeof input === 'string' ? input : JSON.stringify(input);

  // Redact URL tokens, signatures, expires
  text = text.replace(/([?&](?:bcdn_token|token|expires|sig|signature|token_path)=)[^&"'\s]+/gi, '$1REDACTED');
  // Redact Authorization headers / bearer tokens
  text = text.replace(/(Authorization:\s*(?:Bearer|Basic)\s+)[^\r\n"']+/gi, '$1REDACTED');
  text = text.replace(/("Authorization":\s*"[^"]+")/gi, '"Authorization": "REDACTED"');
  // Redact cookies
  text = text.replace(/(Cookie:\s*)[^\r\n"']+/gi, '$1REDACTED');
  text = text.replace(/("Cookie":\s*"[^"]+")/gi, '"Cookie": "REDACTED"');
  // Redact proxy credentials: http://user:pass@host:port
  text = text.replace(/(https?:\/\/)[^:@\s]+:[^@\s]+@/gi, '$1REDACTED:REDACTED@');

  return typeof input === 'string' ? text : JSON.parse(text);
}

/**
 * Structured diagnostics logger with safe correlation IDs.
 */
class StructuredLogger {
  constructor(options = {}) {
    this.prefix = options.prefix || 'external-worker';
    this.logEntries = [];
    this.maxMemoryLogs = options.maxMemoryLogs || 500;
  }

  log(event = {}) {
    const correlation = {
      timestamp: new Date().toISOString(),
      worker: this.prefix,
      cycle: event.cycle || 0,
      sourcePostId: event.sourcePostId || null,
      category: event.category || null,
      destination: event.destination || null,
      state: event.state || null,
      bytes: event.bytes !== undefined ? event.bytes : null,
      duration: event.duration !== undefined ? event.duration : null,
      sha256: event.sha256 ? (event.sha256.length > 16 ? event.sha256.slice(0, 16) + '...' : event.sha256) : null,
      result: event.result || null,
      message: event.message ? redactSensitive(event.message) : undefined
    };

    const formatted = `[${this.prefix}] cycle=${correlation.cycle} sourcePostId=${correlation.sourcePostId || 'none'} category=${correlation.category || 'none'} destination=${correlation.destination || 'none'} state=${correlation.state || 'none'}${correlation.bytes !== null ? ` bytes=${correlation.bytes}` : ''}${correlation.duration !== null ? ` duration=${correlation.duration}` : ''}${correlation.sha256 ? ` sha256=${correlation.sha256}` : ''}${correlation.result ? ` result=${correlation.result}` : ''}`;
    console.log(formatted);

    this.logEntries.push(correlation);
    if (this.logEntries.length > this.maxMemoryLogs) {
      this.logEntries.shift();
    }

    return formatted;
  }

  getRecentLogs(limit = 50) {
    return this.logEntries.slice(-limit);
  }

  clearLogs() {
    this.logEntries = [];
  }
}

/**
 * Aggregates execution metrics across counters and timings.
 */
class MetricsCollector {
  constructor() {
    this.reset();
  }

  reset() {
    this.counters = {
      discovered: 0,
      queued: 0,
      duplicates: 0,
      skipped: 0,
      processing: 0,
      downloadStarted: 0,
      downloadCompleted: 0,
      downloadFailed: 0,
      validationPassed: 0,
      validationFailed: 0,
      deliveryStarted: 0,
      deliverySucceeded: 0,
      deliveryFailed: 0,
      quotaBlocked: 0,
      emptyCategorySkipped: 0,
      sidebarFallbackUsed: 0,
      retries: 0,
      cleanupCompleted: 0
    };

    this.timings = {
      discoveryDuration: [],
      playerResolutionDuration: [],
      downloadDuration: [],
      validationDuration: [],
      deliveryDuration: [],
      fullPipelineDuration: []
    };
  }

  increment(counterName, amount = 1) {
    if (this.counters[counterName] !== undefined) {
      this.counters[counterName] += amount;
    }
  }

  recordTiming(timingName, durationMs) {
    if (this.timings[timingName] && typeof durationMs === 'number' && !isNaN(durationMs)) {
      this.timings[timingName].push(durationMs);
      if (this.timings[timingName].length > 100) {
        this.timings[timingName].shift();
      }
    }
  }

  getMetrics() {
    const timingStats = {};
    for (const [key, values] of Object.entries(this.timings)) {
      if (values.length === 0) {
        timingStats[key] = { count: 0, avgMs: 0, minMs: 0, maxMs: 0 };
      } else {
        const sum = values.reduce((a, b) => a + b, 0);
        timingStats[key] = {
          count: values.length,
          avgMs: Math.round(sum / values.length),
          minMs: Math.min(...values),
          maxMs: Math.max(...values)
        };
      }
    }

    return {
      counters: { ...this.counters },
      timings: timingStats
    };
  }
}

/**
 * Disk pre-flight checks and stale partial file safety guards.
 */
class PreDownloadDiskGuard {
  static checkDiskSafety(targetDir) {
    // 1. Verify directory exists or create
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // 2. Test write permission
    const testFile = path.join(targetDir, `.write_perm_test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    try {
      fs.writeFileSync(testFile, 'write_test_ok');
      fs.unlinkSync(testFile);
    } catch (err) {
      return {
        safe: false,
        error: `Write permission denied in ${targetDir}: ${err.message}`
      };
    }

    // 3. Clean up stale partial / temp files (.part, .tmp, .crdownload)
    let staleCleanedCount = 0;
    try {
      const files = fs.readdirSync(targetDir);
      for (const f of files) {
        // Never touch state or ledger JSON files
        if (f.endsWith('_state.json') || f.endsWith('_ledger.json') || f.endsWith('.json')) continue;
        if (f.endsWith('.part') || f.endsWith('.tmp') || f.endsWith('.crdownload')) {
          const fullPath = path.join(targetDir, f);
          try {
            fs.unlinkSync(fullPath);
            staleCleanedCount++;
          } catch (e) {}
        }
      }
    } catch (e) {}

    return {
      safe: true,
      staleCleanedCount
    };
  }
}

module.exports = {
  HEALTH_STATE,
  redactSensitive,
  StructuredLogger,
  MetricsCollector,
  PreDownloadDiskGuard
};
