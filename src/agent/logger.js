"use strict";

/**
 * Structured logger — JSON-per-line logs parseable by log aggregators
 * (Loki/ELK/CloudWatch). Drop-in console replacement: logger.info/warn/error.
 *
 * Set LOG_FORMAT=json for production, LOG_FORMAT=text (default) for dev.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const COMPONENT = process.env.LOG_COMPONENT || "tossinvest";

function emit(level, msg, fields) {
  const minLevel = LEVELS[(process.env.LOG_LEVEL || "info").toLowerCase()] || 20;
  const format = (process.env.LOG_FORMAT || "text").toLowerCase();
  if (LEVELS[level] < minLevel) return;
  const ts = new Date().toISOString();
  if (format === "json") {
    process.stdout.write(JSON.stringify({
      ts, level, component: COMPONENT, msg, ...(fields || {}),
    }) + "\n");
  } else {
    const extra = fields && Object.keys(fields).length > 0 ? " " + JSON.stringify(fields) : "";
    const line = "[" + ts + "] [" + level.toUpperCase() + "] " + msg + extra;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }
}

module.exports = {
  debug: (msg, fields) => emit("debug", msg, fields),
  info: (msg, fields) => emit("info", msg, fields),
  warn: (msg, fields) => emit("warn", msg, fields),
  error: (msg, fields) => emit("error", msg, fields),
  // Bind a sub-component name for per-module tracing
  child: (sub) => ({
    debug: (msg, fields) => emit("debug", msg, { sub, ...fields }),
    info: (msg, fields) => emit("info", msg, { sub, ...fields }),
    warn: (msg, fields) => emit("warn", msg, { sub, ...fields }),
    error: (msg, fields) => emit("error", msg, { sub, ...fields }),
  }),
};
