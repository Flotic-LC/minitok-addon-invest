"use strict";

/**
 * Notification router — severity-based routing with rate limiting.
 * Prevents Telegram spam storms (e.g. repeated halt alerts) while ensuring
 * critical events always reach the operator.
 *
 * Severities: info (daily reports), warn (blocked orders, partial fills),
 * critical (halt, killswitch, hard stop, API auth failure).
 */

const DEFAULTS = Object.freeze({
  minIntervalWarnMs: Number(process.env.NOTIFY_WARN_INTERVAL_MS || 1800000),   // 30 min between same warn [notify-minimal]
  minIntervalInfoMs: Number(process.env.NOTIFY_INFO_INTERVAL_MS || 21600000),  // 6 h between same info [notify-minimal]
  criticalBypass: true,                                                        // critical never rate-limited
});

function createNotifier(sender, opts = {}) {
  // sender: async (message, severity) => void — e.g. wraps sendTelegramAlert
  const p = { ...DEFAULTS, ...opts };
  const lastSent = new Map(); // dedupeKey -> timestamp

  function key(severity, msg) {
    // Dedupe by first 25 chars — "ORDER_BLOCKED 005930" same event type+symbol = same key
    return severity + ":" + msg.slice(0, 25);
  }

  async function send(severity, message) {
    const k = key(severity, message);
    const now = Date.now();
    const last = lastSent.get(k) || 0;

    if (severity === "critical" && p.criticalBypass) {
      await sender(message, severity);
      lastSent.set(k, now);
      return { sent: true, severity };
    }
    const minInterval = severity === "warn" ? p.minIntervalWarnMs : p.minIntervalInfoMs;
    if (now - last < minInterval) {
      return { sent: false, severity, suppressed: true, retryInMs: minInterval - (now - last) };
    }
    await sender(message, severity);
    lastSent.set(k, now);
    return { sent: true, severity };
  }

  return {
    info: (msg) => send("info", msg),
    warn: (msg) => send("warn", msg),
    warning: (msg) => send("warn", msg),  // alias: many call-sites use "warning"
    error: (msg) => send("warn", msg),    // alias: treat as warn
    critical: (msg) => send("critical", msg),
    // Clear rate limit (e.g. after daily reset)
    resetLimits: () => lastSent.clear(),
    getSuppressedCount: () => lastSent.size,
  };
}

module.exports = { createNotifier, DEFAULTS };
