"use strict";

/**
 * Knowledge Store — persists decision outcomes and uses them to bias
 * future signals (self-improvement loop).
 *
 *   1. recordOutcome({ symbol, action, strategy, score, pnl })
 *   2. lookup(symbol, strategy?) → historical stats
 *   3. adjustScore(baseScore, symbol, strategy) → biased score
 *      - winRate >60%: +1 bonus
 *      - winRate <30%: -1 penalty
 *      - negative EV:  -2 strong penalty
 *
 * Persistence: atomic JSON file (temp + rename).
 */

const fs = require("node:fs");
const path = require("node:path");

const DEFAULTS = Object.freeze({
  path: path.join(process.cwd(), ".knowledge.json"),
  winRateBonusThreshold: Number(process.env.KS_BONUS_THRESHOLD || 0.6),
  winRatePenaltyThreshold: Number(process.env.KS_PENALTY_THRESHOLD || 0.3),
  minTradesForBias: Number(process.env.KS_MIN_TRADES || 3),
  maxHistory: Number(process.env.KS_MAX_HISTORY || 5000),
  scoreBonus: Number(process.env.KS_SCORE_BONUS || 1),
  scorePenalty: Number(process.env.KS_SCORE_PENALTY || 1),
});

function loadFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { outcomes: [], symbols: {}, strategies: {} };
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return {
      outcomes: Array.isArray(parsed.outcomes) ? parsed.outcomes : [],
      symbols: parsed.symbols || {},
      strategies: parsed.strategies || {},
    };
  } catch (e) {
    // [DEEP-DEBUG FIX] Log knowledge store load failures — corrupted JSON
    // means historical decision outcomes are lost, degrading the
    // self-improvement loop silently.
    console.error("[knowledge] load failed: " + (e && e.message ? e.message : String(e)));
    return { outcomes: [], symbols: {}, strategies: {} };
  }
}

const { atomicWriteFileSync } = require("../core/atomic-write");

function saveFile(filePath, data) {
  try {
    const content = JSON.stringify(data, null, 2);
    const result = atomicWriteFileSync(filePath, content);
    if (!result.ok) {
      console.error("[knowledge] save failed (" + result.method + "): " + result.error);
      return false;
    }
    return true;
  } catch (e) { console.error("[knowledge] save failed: " + e.message); return false; }
}

function createKnowledgeStore(options = {}) {
  const p = { ...DEFAULTS, ...options };
  let data = loadFile(p.path);

  let _persistTimer = null;
  function schedulePersist() {
    if (_persistTimer) return;
    _persistTimer = setTimeout(function() {
      _persistTimer = null;
      saveFile(p.path, data);
    }, 5000);
  }
  function persist() { saveFile(p.path, data); }
  function flushPersist() {
    if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
    saveFile(p.path, data);
  }

  function updateAggregates(symbol, strategy, pnl) {
    if (!data.symbols[symbol]) {
      data.symbols[symbol] = { trades: 0, wins: 0, losses: 0, totalPnl: 0 };
    }
    const sym = data.symbols[symbol];
    sym.trades += 1;
    if (pnl > 0) sym.wins += 1;
    else if (pnl < 0) sym.losses += 1;
    sym.totalPnl += pnl;

    if (strategy) {
      const key = symbol + ":" + strategy;
      if (!data.strategies[key]) {
        data.strategies[key] = { trades: 0, wins: 0, losses: 0, totalPnl: 0 };
      }
      const st = data.strategies[key];
      st.trades += 1;
      if (pnl > 0) st.wins += 1;
      else if (pnl < 0) st.losses += 1;
      st.totalPnl += pnl;
    }
  }

  function recordOutcome(outcome) {
    if (!outcome || !outcome.symbol) return false;
    const rec = {
      symbol: String(outcome.symbol).toUpperCase(),
      action: outcome.action,
      strategy: outcome.strategy || null,
      score: Number(outcome.score) || 0,
      pnl: Number(outcome.pnl) || 0,
      reason: outcome.reason || null,
      ts: new Date().toISOString(),
    };
    data.outcomes.push(rec);
    if (data.outcomes.length > p.maxHistory) {
      data.outcomes.splice(0, data.outcomes.length - p.maxHistory);
    }
    updateAggregates(rec.symbol, rec.strategy, rec.pnl);
    schedulePersist();
    return true;
  }

  function lookup(symbol, strategy = null) {
    const sym = String(symbol).toUpperCase();
    const key = strategy ? sym + ":" + strategy : sym;
    const agg = strategy ? data.strategies[key] : data.symbols[sym];
    if (!agg || agg.trades === 0) {
      return { symbol: sym, strategy, trades: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0, expectedValue: 0 };
    }
    return {
      symbol: sym, strategy, trades: agg.trades, wins: agg.wins, losses: agg.losses,
      winRate: agg.trades > 0 ? agg.wins / agg.trades : 0,
      totalPnl: agg.totalPnl,
      expectedValue: agg.trades > 0 ? agg.totalPnl / agg.trades : 0,
    };
  }

  function adjustScore(baseScore, symbol, strategy = null) {
    const info = lookup(symbol, strategy);
    if (info.trades < p.minTradesForBias) {
      return { score: baseScore, adjustment: 0, reason: "insufficient history", lookup: info };
    }
    let adjustment = 0, reason = "";
    if (info.expectedValue < 0) {
      adjustment = -p.scorePenalty * 2;
      reason = "negative EV (" + Math.round(info.expectedValue) + " KRW/trade)";
    } else if (info.winRate >= p.winRateBonusThreshold) {
      adjustment = p.scoreBonus;
      reason = "high win rate " + (info.winRate * 100).toFixed(0) + "%";
    } else if (info.winRate <= p.winRatePenaltyThreshold) {
      adjustment = -p.scorePenalty;
      reason = "low win rate " + (info.winRate * 100).toFixed(0) + "%";
    } else {
      reason = "neutral win rate " + (info.winRate * 100).toFixed(0) + "%";
    }
    return { score: baseScore + adjustment, adjustment, reason, lookup: info };
  }

  function stats() {
    return {
      totalOutcomes: data.outcomes.length,
      uniqueSymbols: Object.keys(data.symbols).length,
      uniqueStrategies: Object.keys(data.strategies).length,
      path: p.path,
    };
  }

  function reset() {
    data = { outcomes: [], symbols: {}, strategies: {} };
    persist();
  }

  return { recordOutcome, lookup, adjustScore, stats, reset, DEFAULTS: p };
}

module.exports = { createKnowledgeStore, DEFAULTS };
