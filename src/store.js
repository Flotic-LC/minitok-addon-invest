"use strict";

/**
 * Append-only JSONL event store — single durable record for fills, journal
 * entries, and runner events. Replaces the split journal/state JSON files.
 *
 * - One file per day: <dir>/events-YYYY-MM-DD.jsonl (KST date by default)
 * - Synchronous append with best-effort durability (no external deps)
 * - Query helpers load recent N events across days, filtered by type
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const DEFAULT_DIR = path.join(os.homedir(), ".minitok-addon-invest", "events");
const MAX_AGE_DAYS = Number(process.env.STORE_RETENTION_DAYS || 90);

function kstDateString(d = new Date()) {
  // KST = UTC+9
  const kst = new Date(d.getTime() + 9 * 3600 * 1000);
  return kst.toISOString().slice(0, 10);
}

function createStore(options = {}) {
  const dir = options.dir || process.env.STORE_DIR || DEFAULT_DIR;
  const dateFn = options.dateFn || kstDateString;

  let _dirEnsured = false;
  function ensureDir() {
    if (_dirEnsured) return;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    _dirEnsured = true;
  }

  function fileFor(dateStr) {
    return path.join(dir, `events-${dateStr}.jsonl`);
  }

  /** Append one event. Returns the stored record or null on failure. */
  function append(type, data = {}) {
    const rec = { type, ts: new Date().toISOString(), ...data };
    try {
      ensureDir();
      fs.appendFileSync(fileFor(dateFn()), JSON.stringify(rec) + "\n", "utf8");
      return rec;
    } catch (e) {
      console.error("[store] append failed: " + e.message);
      return null;
    }
  }

  function listFiles() {
    try {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir)
        .filter((f) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .sort();
    } catch { return []; }
  }

  /**
   * Load recent events (newest last), optionally filtered.
   * @param {object} q - { limit=500, types=null|string[], sinceTs=null }
   */
  function query(q = {}) {
    const limit = q.limit || 500;
    const types = q.types ? new Set(Array.isArray(q.types) ? q.types : [q.types]) : null;
    const sinceTs = q.sinceTs ? new Date(q.sinceTs).getTime() : 0;
    const files = listFiles().reverse(); // newest day first
    const collected = []; // newest-first order
    for (const f of files) {
      let lines;
      try { lines = fs.readFileSync(path.join(dir, f), "utf8").split("\n"); } catch { continue; }
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (types && !types.has(rec.type)) continue;
        if (sinceTs && new Date(rec.ts).getTime() < sinceTs) continue;
        collected.push(rec);
        if (collected.length >= limit) break;
      }
      if (collected.length >= limit) break;
    }
    // Reverse to chronological order
    collected.reverse();
    return collected.slice(0, limit);
  }

  /** Delete event files older than retention. Returns count removed. */
  function prune() {
    const cutoff = Date.now() - MAX_AGE_DAYS * 86400_000;
    let removed = 0;
    for (const f of listFiles()) {
      const m = f.match(/events-(\d{4}-\d{2}-\d{2})\.jsonl/);
      if (!m) continue;
      if (new Date(m[1] + "T00:00:00+09:00").getTime() < cutoff) {
        try { fs.unlinkSync(path.join(dir, f)); removed++; } catch {}
      }
    }
    return removed;
  }

  return { dir, append, query, listFiles, prune, kstDateString };
}

module.exports = { createStore, kstDateString, DEFAULT_DIR };
