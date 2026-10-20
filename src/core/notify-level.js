"use strict";

/**
 * Telegram notification severity filter — shared by the runner and the admin
 * so both classify alerts the same way.
 *
 * NOTIFY_LEVEL:
 *   "critical" — only critical alerts reach Telegram (default)
 *   "warn"     — critical + warn
 *   "all"      — everything, including info
 *
 * Severity vocabulary:
 *   critical — killswitch, hard stop, trading halt, WS circuit breaker,
 *              self-healing escalation, bot down, auth failure
 *   warn     — blocked order, partial fill, equity snapshot failure,
 *              walk-forward rejection, manual FX exchange required
 *   info     — periodic/scheduled summaries
 *
 * Scheduled reports (the admin's end-of-session daily summary) are not alerts
 * and deliberately bypass this filter — they are sent by the report path, not
 * by the alert path.
 */

const LEVELS = Object.freeze(["critical", "warn", "all"]);

function createNotifyLevel(env) {
  const raw = String((env && env.NOTIFY_LEVEL) || "critical").toLowerCase().trim();
  const level = LEVELS.indexOf(raw) !== -1 ? raw : "critical";
  return {
    level: level,
    /** Is an alert of this severity allowed through to Telegram? */
    allowed(severity) {
      const sev = String(severity || "info").toLowerCase();
      if (level === "all") return true;
      if (level === "warn") return sev === "critical" || sev === "warn";
      return sev === "critical";
    },
  };
}

module.exports = { createNotifyLevel, LEVELS };
