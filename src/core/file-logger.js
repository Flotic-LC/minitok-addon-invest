"use strict";

/**
 * Structured log directory with daily rotation.
 *
 * Tees console.log/warn/error to rotating daily files in a logs/ directory.
 * Designed to be non-intrusive: hooks into existing console methods without
 * requiring changes to call sites.
 *
 * File layout: <dir>/bot-YYYY-MM-DD.log (combined), bot-YYYY-MM-DD.err.log (errors only)
 *
 * Usage:
 *   const { createFileLogger } = require("./src/core/file-logger");
 *   const logger = createFileLogger({ dir: path.join(__dirname, "logs") });
 *   // All subsequent console.log/warn/error calls are now also written to files.
 *   // Call logger.close() on shutdown to flush and restore original console.
 */

const fs = require("node:fs");
const path = require("node:path");
const util = require("node:util");

function pad2(n) { return n < 10 ? "0" + n : String(n); }

function dateKey(d) {
  return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
}

function createFileLogger(options = {}) {
  const {
    dir = path.join(process.cwd(), "logs"),
    enabled = process.env.LOG_TO_FILE !== "false",
    maxAgeDays = Number(process.env.LOG_RETENTION_DAYS || 30),
    now = () => new Date(),
  } = options;

  const noop = { close() {}, stats() { return { enabled: false }; }, prune() { return 0; } };

  if (!enabled) return noop;

  // Ensure log directory exists
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    // Cannot use console.error here since we're about to hook it
    process.stderr.write("[file-logger] Failed to create log directory: " + e.message + "\n");
    return { ...noop, stats() { return { enabled: false, error: e.message }; } };
  }

  let currentDateKey = null;
  let logFd = null;    // combined log file descriptor
  let errFd = null;    // error-only file descriptor
  let bytesWritten = 0;
  let linesWritten = 0;

  function rotateIfNeeded() {
    const key = dateKey(now());
    if (key === currentDateKey && logFd !== null) return;
    // Close previous files
    if (logFd !== null) { try { fs.closeSync(logFd); } catch {} logFd = null; }
    if (errFd !== null) { try { fs.closeSync(errFd); } catch {} errFd = null; }
    currentDateKey = key;
    try {
      const logPath = path.join(dir, "bot-" + key + ".log");
      const errPath = path.join(dir, "bot-" + key + ".err.log");
      logFd = fs.openSync(logPath, "a");
      errFd = fs.openSync(errPath, "a");
    } catch (e) {
      process.stderr.write("[file-logger] Failed to open log files: " + e.message + "\n");
      logFd = null;
      errFd = null;
    }
  }

  function formatArgs(args) {
    return args.map(a => typeof a === "string" ? a : util.inspect(a, { depth: 3, breakLength: 120 })).join(" ");
  }

  function writeLine(fd, line) {
    if (fd === null) return;
    try {
      fs.writeSync(fd, line + "\n");
      bytesWritten += line.length + 1;
      linesWritten++;
    } catch {
      // Disk full or fd closed — degrade gracefully, console still works
    }
  }

  function logLine(level, args) {
    rotateIfNeeded();
    const ts = now().toISOString();
    const msg = formatArgs(args);
    const line = ts + " [" + level + "] " + msg;
    if (logFd !== null) writeLine(logFd, line);
    if (level === "ERROR" && errFd !== null) writeLine(errFd, line);
  }

  // Hook console methods
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;

  console.log = function(...args) {
    origLog.apply(console, args);
    logLine("INFO", args);
  };
  console.warn = function(...args) {
    origWarn.apply(console, args);
    logLine("WARN", args);
  };
  console.error = function(...args) {
    origError.apply(console, args);
    logLine("ERROR", args);
  };

  function close() {
    // Restore original console methods
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
    if (logFd !== null) { try { fs.closeSync(logFd); } catch {} logFd = null; }
    if (errFd !== null) { try { fs.closeSync(errFd); } catch {} errFd = null; }
  }

  function prune() {
    const cutoff = Date.now() - maxAgeDays * 86400_000;
    let removed = 0;
    try {
      const files = fs.readdirSync(dir);
      for (const f of files) {
        const m = f.match(/^bot-(\d{4}-\d{2}-\d{2})/);
        if (!m) continue;
        if (new Date(m[1] + "T00:00:00Z").getTime() < cutoff) {
          try { fs.unlinkSync(path.join(dir, f)); removed++; } catch {}
        }
      }
    } catch {}
    return removed;
  }

  function stats() {
    return {
      enabled: true,
      dir,
      currentDateKey,
      bytesWritten,
      linesWritten,
      maxAgeDays,
    };
  }

  return { close, prune, stats };
}

module.exports = { createFileLogger };
