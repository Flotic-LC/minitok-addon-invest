"use strict";

/**
 * Trading Memory — persists individual decision snapshots with technical
 * context for similarity-based recall. Complements knowledge-store.js
 * (which aggregates win rates per symbol) by storing raw experiences
 * that can be searched by market context.
 *
 * Usage:
 *   const { createTradingMemory } = require("./src/memory/trading-memory");
 *   const memory = createTradingMemory({ dir: path.join(__dirname, ".memory") });
 *   memory.recordDecision({ symbol, action, reason, technicals, regime, pnl });
 *   const similar = memory.recallSimilar({ symbol, rsi14, macd }, 5);
 */

const fs = require("node:fs");
const path = require("node:path");
const { atomicWriteFileSync } = require("../core/atomic-write");

const DEFAULTS = Object.freeze({
  dir: path.join(process.cwd(), ".memory"),
  maxEntries: Number(process.env.TRADING_MEMORY_MAX || 2000),
  minSimilarityScore: Number(process.env.TRADING_MEMORY_MIN_SCORE || 2),
});

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
    console.error("[memory] mkdir failed: " + (e && e.message ? e.message : String(e)));
  }
}

function loadFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { entries: [], version: 1 };
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return {
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      version: parsed.version || 1,
    };
  } catch (e) {
    console.error("[memory] load failed: " + (e && e.message ? e.message : String(e)));
    return { entries: [], version: 1 };
  }
}

function saveFile(filePath, data) {
  try {
    const content = JSON.stringify(data, null, 2);
    const result = atomicWriteFileSync(filePath, content);
    if (!result.ok) {
      console.error("[memory] save failed (" + result.method + "): " + result.error);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[memory] save failed: " + (e && e.message ? e.message : String(e)));
    return false;
  }
}

function priceBracket(price) {
  if (!price || price <= 0) return 0;
  return Math.floor(Math.log10(price) * 10);
}

function computeSimilarity(entry, ctx) {
  let score = 0;
  if (entry.symbol && ctx.symbol && String(entry.symbol).toUpperCase() === String(ctx.symbol).toUpperCase()) score += 3;
  if (entry.regime && ctx.regime && entry.regime === ctx.regime) score += 2;
  if (entry.technicals && entry.technicals.rsi14 != null && ctx.rsi14 != null) {
    const diff = Math.abs(entry.technicals.rsi14 - ctx.rsi14);
    if (diff < 5) score += 2; else if (diff < 10) score += 1;
  }
  if (entry.technicals && entry.technicals.macd && ctx.macd) {
    const eH = entry.technicals.macd.histogram || 0;
    const cH = ctx.macd.histogram || 0;
    if ((eH > 0) === (cH > 0) && eH !== 0 && cH !== 0) score += 1;
  }
  if (entry.price && ctx.lastClose && priceBracket(entry.price) === priceBracket(ctx.lastClose)) score += 1;
  if (entry.action && ctx.action && entry.action === ctx.action) score += 1;
  return score;
}

function createTradingMemory(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  ensureDir(cfg.dir);
  const filePath = path.join(cfg.dir, "trading-memory.json");
  let data = loadFile(filePath);
  let dirty = false;

  function schedulePersist() { persist(); }
  function persist() {
    if (!dirty) return;
    saveFile(filePath, data);
    dirty = false;
  }
  function flushPersist() { persist(); }

  function recordDecision(decision) {
    if (!decision || !decision.symbol) return false;
    const entry = {
      id: "mem-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
      symbol: String(decision.symbol).toUpperCase(),
      action: decision.action || "HOLD",
      reason: decision.reason || null,
      strategy: decision.strategy || null,
      price: decision.price != null ? Number(decision.price) : null,
      quantity: decision.quantity != null ? Number(decision.quantity) : null,
      regime: decision.regime || null,
      technicals: decision.technicals || null,
      sentiment: decision.sentiment || null,
      pnl: decision.pnl != null ? Number(decision.pnl) : null,
      outcome: decision.outcome || null,
      ts: new Date().toISOString(),
    };
    data.entries.push(entry);
    if (data.entries.length > cfg.maxEntries) {
      data.entries = data.entries.slice(-cfg.maxEntries);
    }
    dirty = true;
    schedulePersist();
    return entry.id;
  }

  function updateOutcome(entryId, outcome) {
    const entry = data.entries.find(e => e.id === entryId);
    if (!entry) return false;
    if (outcome.pnl != null) entry.pnl = Number(outcome.pnl);
    if (outcome.outcome) entry.outcome = outcome.outcome;
    entry.updatedAt = new Date().toISOString();
    dirty = true;
    schedulePersist();
    return true;
  }

  function recallSimilar(ctx, topK = 5) {
    if (!ctx) return [];
    // Limit scan to most recent entries to avoid O(n log n) on large history
    const scanLimit = Math.min(data.entries.length, 500);
    const recent = data.entries.slice(-scanLimit);
    const scored = recent.map(entry => ({
      entry, score: computeSimilarity(entry, ctx),
    }));
    // Partial sort: only sort filtered results (typically small)
    const filtered = scored.filter(s => s.score >= cfg.minSimilarityScore);
    filtered.sort((a, b) => b.score - a.score);
    return filtered
      .slice(0, topK)
      .map(s => Object.assign({}, s.entry, { similarityScore: s.score }));
  }

  function getByRegime(regime, limit = 50) {
    return data.entries.filter(e => e.regime === regime).slice(-limit);
  }

  function getBySymbol(symbol, limit = 50) {
    const sym = String(symbol).toUpperCase();
    return data.entries.filter(e => e.symbol === sym).slice(-limit);
  }

  function getWinLossStats(symbol) {
    const sym = symbol ? String(symbol).toUpperCase() : null;
    const relevant = sym
      ? data.entries.filter(e => e.symbol === sym && e.pnl != null)
      : data.entries.filter(e => e.pnl != null);
    let wins = 0, losses = 0, totalPnl = 0;
    for (const e of relevant) {
      if (e.pnl > 0) wins++;
      else if (e.pnl < 0) losses++;
      totalPnl += e.pnl;
    }
    const total = wins + losses;
    return {
      symbol: sym || "ALL", total, wins, losses,
      winRate: total > 0 ? wins / total : 0, totalPnl,
    };
  }

  function stats() {
    const symbols = new Set(data.entries.map(e => e.symbol));
    const withPnl = data.entries.filter(e => e.pnl != null).length;
    return {
      totalEntries: data.entries.length,
      uniqueSymbols: symbols.size,
      entriesWithPnl: withPnl,
      maxEntries: cfg.maxEntries,
      filePath,
    };
  }

  function clear() {
    data = { entries: [], version: 1 };
    dirty = true;
    schedulePersist();
  }

  return {
    recordDecision, updateOutcome, recallSimilar,
    getByRegime, getBySymbol, getWinLossStats, stats, clear,
    persist: flushPersist,
  };
}

module.exports = { createTradingMemory };
