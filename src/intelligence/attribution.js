"use strict";

/**
 * Attribution Engine — Phase R-3.
 * Decomposes PnL by subsystem dimension so we know which component
 * is creating or destroying value.
 *
 * Dimensions:
 *   - symbol        (which ticker contributed)
 *   - strategy      (which strategy: base_signals, lifecycle, etc.)
 *   - source        (decision source: ai, fallback, rule)
 *   - metaCog       (whether meta-cognition intervened)
 *   - side          (BUY→SELL round-trip profitability)
 *
 * Usage:
 *   const { createAttributionEngine } = require("./src/intelligence/attribution");
 *   const attr = createAttributionEngine();
 *   attr.recordFill({ symbol, strategy, source, metaCogIntervened, pnl });
 *   attr.recordDecision({ symbol, strategy, source, action });
 *   const rep = attr.report();
 */

var DEFAULTS = Object.freeze({
  maxHistory: Number(process.env.ATTRIBUTION_MAX_HISTORY || 5000),
});

function createAttributionEngine(options) {
  var cfg = Object.assign({}, DEFAULTS, options || {});
  var fills = [];
  var decisions = [];

  function recordFill(f) {
    if (!f) return;
    fills.push({
      symbol: f.symbol || "unknown",
      strategy: f.strategy || "base_signals",
      source: f.source || "ai",
      metaCogIntervened: !!f.metaCogIntervened,
      side: f.side || "SELL",
      pnl: typeof f.pnl === "number" ? f.pnl : 0,
      ts: Date.now(),
    });
    if (fills.length > cfg.maxHistory) fills.shift();
  }

  function recordDecision(d) {
    if (!d) return;
    decisions.push({
      symbol: d.symbol || "unknown",
      strategy: d.strategy || "base_signals",
      source: d.source || "ai",
      action: d.action || "HOLD",
      ts: Date.now(),
    });
    if (decisions.length > cfg.maxHistory) decisions.shift();
  }

  function groupBy(list, keyFn) {
    var out = {};
    for (var i = 0; i < list.length; i++) {
      var k = keyFn(list[i]);
      if (!out[k]) out[k] = { count: 0, pnl: 0, wins: 0, losses: 0 };
      out[k].count++;
      out[k].pnl += list[i].pnl;
      if (list[i].pnl > 0) out[k].wins++;
      else if (list[i].pnl < 0) out[k].losses++;
    }
    return out;
  }

  function report() {
    var bySymbol = groupBy(fills, function(f) { return f.symbol; });
    var byStrategy = groupBy(fills, function(f) { return f.strategy; });
    var bySource = groupBy(fills, function(f) { return f.source; });
    var byMetaCog = groupBy(fills, function(f) { return f.metaCogIntervened ? "intervened" : "baseline"; });
    var totalPnl = 0;
    for (var i = 0; i < fills.length; i++) totalPnl += fills[i].pnl;
    return {
      generatedAt: new Date().toISOString(),
      totalFills: fills.length,
      totalDecisions: decisions.length,
      totalPnl: totalPnl,
      bySymbol: bySymbol,
      byStrategy: byStrategy,
      bySource: bySource,
      byMetaCog: byMetaCog,
    };
  }

  function topContributors(n) {
    var rep = report();
    var arr = [];
    var keys = Object.keys(rep.bySymbol);
    for (var i = 0; i < keys.length; i++) {
      var v = rep.bySymbol[keys[i]];
      arr.push({ symbol: keys[i], pnl: v.pnl, count: v.count, winRate: v.count > 0 ? v.wins / v.count : 0 });
    }
    arr.sort(function(a, b) { return b.pnl - a.pnl; });
    return arr.slice(0, n || 5);
  }

  function bottomContributors(n) {
    var rep = report();
    var arr = [];
    var keys = Object.keys(rep.bySymbol);
    for (var i = 0; i < keys.length; i++) {
      var v = rep.bySymbol[keys[i]];
      arr.push({ symbol: keys[i], pnl: v.pnl, count: v.count });
    }
    arr.sort(function(a, b) { return a.pnl - b.pnl; });
    return arr.slice(0, n || 5);
  }

  function stats() {
    return { totalFills: fills.length, totalDecisions: decisions.length, maxHistory: cfg.maxHistory };
  }

  function clear() { fills.length = 0; decisions.length = 0; }

  return {
    recordFill: recordFill, recordDecision: recordDecision,
    report: report, topContributors: topContributors, bottomContributors: bottomContributors,
    stats: stats, clear: clear,
  };
}

module.exports = { createAttributionEngine, DEFAULTS };
