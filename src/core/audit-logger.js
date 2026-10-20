"use strict";

/**
 * Append-only audit logger for trading operations.
 *
 * Writes newline-delimited JSON (JSON Lines) to a rotating daily file.
 * Uses SYNCHRONOUS append so records are durable before the caller
 * continues — critical for post-incident forensics. Volume is low
 * (tens per second at most) so sync I/O cost is negligible.
 *
 * File layout: <dir>/audit-YYYY-MM-DD.jsonl
 *
 * Usage:
 *   const audit = createAuditLogger({ dir: ".logs" });
 *   audit.order({ symbol: "005930", side: "BUY", qty: 5, price: 71000 });
 *   audit.decision({ symbol: "005930", action: "BUY", score: 3, source: "ai" });
 *   audit.halt({ reason: "daily_hard_stop", phase: 1 });
 */

const fs = require("node:fs");
const path = require("node:path");

const SCHEMA_VERSION = 1;
const MAX_LINE_BYTES = 8192;
const MAX_BUFFER_LINES = 100;

function pad2(n) { return n < 10 ? "0" + n : String(n); }

function dateKey(d) {
  return d.getUTCFullYear() + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
}

function createAuditLogger(options = {}) {
  const {
    dir = path.join(process.cwd(), ".audit"),
    enabled = process.env.AUDIT_LOG_ENABLED !== "false",
    now = () => new Date(),
    maxBufferLines = MAX_BUFFER_LINES,
  } = options;

  let currentFile = null;
  let currentDateKey = null;
  let seq = 0;
  const buffer = []; // in-memory fallback when disk write fails
  let dropped = 0;

  function ensureDir() {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      return true;
    } catch (e) {
      // [DEEP-DEBUG FIX] Audit directory creation failure is a compliance
      // concern — all subsequent audit writes will fail silently without this.
      console.error("[audit] ensureDir failed for " + dir + ": " + (e && e.message ? e.message : String(e)));
      return false;
    }
  }

  function resolveFile(dateStr) {
    return path.join(dir, "audit-" + dateStr + ".jsonl");
  }

  function appendSync(dateStr, line) {
    if (!ensureDir()) return false;
    if (currentDateKey !== dateStr) {
      currentFile = resolveFile(dateStr);
      currentDateKey = dateStr;
    }
    try {
      fs.appendFileSync(currentFile, line + "\n", "utf8");
      return true;
    } catch (e) {
      console.error("[audit] append failed: " + e.message);
      return false;
    }
  }

  function formatLine(record) {
    try {
      const json = JSON.stringify(record);
      if (Buffer.byteLength(json, "utf8") > MAX_LINE_BYTES) {
        const slim = { ...record, _truncated: true };
        for (const k of Object.keys(slim)) {
          if (typeof slim[k] === "string" && slim[k].length > 500) {
            slim[k] = slim[k].slice(0, 500) + "…";
          }
        }
        return JSON.stringify(slim);
      }
      return json;
    } catch (e) {
      // [DEEP-DEBUG FIX] Log serialization failures — circular references or
      // BigInt values in audit payloads are a compliance concern and should
      // not fail silently. The record is still dropped (returns null below),
      // but the failure is now visible in stderr for investigation.
      console.error("[audit] formatLine JSON.stringify failed (possible circular ref or BigInt): " + (e && e.message ? e.message : String(e)));
      return null;
    }
  }

  function write(type, payload) {
    if (!enabled) return false;
    const d = now();
    const key = dateKey(d);
    seq += 1;
    const record = { v: SCHEMA_VERSION, seq, ts: d.toISOString(), type, ...payload };
    const line = formatLine(record);
    if (!line) { dropped++; return false; }
    if (appendSync(key, line)) return true;
    if (buffer.length < maxBufferLines) buffer.push({ key, line });
    else dropped++;
    return false;
  }

  function flushBuffer() {
    let flushed = 0;
    while (buffer.length > 0) {
      const item = buffer[0];
      if (!appendSync(item.key, item.line)) break;
      buffer.shift();
      flushed++;
    }
    return flushed;
  }

  // Convenience wrappers (each normalizes payload shape)
  const api = {
    order(p) {
      return write("order", {
        symbol: p.symbol, side: p.side, qty: p.quantity ?? p.qty,
        price: p.price, orderId: p.orderId, dryRun: !!p.dryRun,
        reason: p.reason, code: p.code, status: p.status,
      });
    },
    decision(p) {
      return write("decision", {
        symbol: p.symbol, action: p.action, score: p.score,
        strategy: p.strategy, source: p.source || "ai",
        fallback: !!p.fallback, cached: !!p.cached,
        reasons: p.reasons, budgetKrw: p.budgetKrw,
      });
    },
    signal(p) {
      return write("signal", {
        symbol: p.symbol, action: p.action, score: p.score,
        strategy: p.strategy, reasons: p.reasons,
      });
    },
    fallback(p) {
      return write("fallback", {
        symbol: p.symbol, action: p.action, reason: p.reason,
        providerCount: p.providerCount,
      });
    },
    halt(p) {
      return write("halt", { reason: p.reason, phase: p.phase, trigger: p.trigger });
    },
    resume(p) {
      return write("resume", { reason: p.reason, phase: p.phase });
    },
    phase(p) {
      return write("phase", { from: p.from, to: p.to, reason: p.reason });
    },
    config(p) {
      return write("config", { key: p.key, oldValue: p.oldValue, newValue: p.newValue, source: p.source });
    },
    error(p) {
      return write("error", {
        source: p.source, code: p.code, message: p.message,
        symbol: p.symbol, stack: p.stack,
      });
    },
    custom(type, payload) {
      return write(type, payload || {});
    },
    stats() {
      return {
        seq, dropped, buffered: buffer.length, enabled,
        currentFile, currentDateKey,
      };
    },
    flush: flushBuffer,
    close() {
      flushBuffer();
    },
  };

  return api;
}

module.exports = { createAuditLogger, SCHEMA_VERSION };

