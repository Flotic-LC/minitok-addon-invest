"use strict";

/**
 * Performance Monitor — Phase R-6.
 * Monitors trading performance, triggers automatic upgrade cycles
 * when degradation is detected.
 *
 * Metrics: rolling win rate, Sharpe, max drawdown, profit factor.
 * Triggers: sustained degradation → auto-generates hypotheses.
 */

var DEFAULTS = Object.freeze({
  windowSize: Number(process.env.PERF_MON_WINDOW || 50),
  winRateThreshold: Number(process.env.PERF_WIN_RATE_THRESH || 0.4),
  sharpeThreshold: Number(process.env.PERF_SHARPE_THRESH || -0.5),
  drawdownMultiplier: Number(process.env.PERF_DD_MULT || 2.0),
  profitFactorThreshold: Number(process.env.PERF_PF_THRESH || 1.0),
  consecutivePeriods: Number(process.env.PERF_CONSEC_PERIODS || 3),
  cooldownMs: Number(process.env.PERF_COOLDOWN_MS || 3600000),
});

function createPerformanceMonitor(options) {
  var cfg = Object.assign({}, DEFAULTS, options || {});
  var hypothesisEngine = cfg.hypothesisEngine || null;
  var selfHealer = cfg.selfHealer || null;
  var notify = cfg.notify || function() {};

  var trades = [];
  var periods = [];
  var counters = { checks: 0, degradations: 0, hypothesesGenerated: 0 };
  var lastTriggerAt = 0;

  function recordTrade(trade) {
    if (!trade || typeof trade.pnl !== "number") return { ok: false, reason: "invalid trade" };
    trades.push({
      ts: trade.ts || new Date().toISOString(),
      pnl: trade.pnl,
      symbol: trade.symbol || "UNKNOWN",
      strategy: trade.strategy || "unknown",
      duration: trade.duration || null,
    });
    if (trades.length > cfg.windowSize * 2) trades.shift();
    return { ok: true, total: trades.length };
  }

  function computeMetrics(wt) {
    if (wt.length < 10) return null;
    var wins = 0, losses = 0, totalPnl = 0, maxDD = 0, peak = 0, equity = 0;
    for (var i = 0; i < wt.length; i++) {
      var p = wt[i].pnl;
      if (p > 0) wins++; else losses++;
      totalPnl += p; equity += p;
      if (equity > peak) peak = equity;
      var dd = peak - equity;
      if (dd > maxDD) maxDD = dd;
    }
    var winRate = wins / wt.length;
    var avgRet = totalPnl / wt.length;
    var variance = 0;
    for (var j = 0; j < wt.length; j++) variance += Math.pow(wt[j].pnl - avgRet, 2);
    variance /= wt.length;
    var stdDev = Math.sqrt(variance);
    var sharpe = stdDev > 0 ? avgRet / stdDev : 0;
    var grossWins = 0, grossLosses = 0;
    for (var k = 0; k < wt.length; k++) {
      if (wt[k].pnl > 0) grossWins += wt[k].pnl;
      else grossLosses += Math.abs(wt[k].pnl);
    }
    var pf = grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? 999 : 0);
    return { winRate: winRate, profitFactor: pf, sharpe: sharpe, maxDrawdown: maxDD, totalPnl: totalPnl, avgReturn: avgRet, trades: wt.length };
  }

  function canTrigger() { return Date.now() - lastTriggerAt >= cfg.cooldownMs; }

  function pushHypothesis(hyp) {
    if (typeof hypothesisEngine.addHypothesis === "function") { hypothesisEngine.addHypothesis(hyp); return true; }
    if (hypothesisEngine._hypotheses && Array.isArray(hypothesisEngine._hypotheses)) { hypothesisEngine._hypotheses.push(hyp); return true; }
    return false;
  }

  function generateHypothesis(type, statement, action) {
    if (!hypothesisEngine) return null;
    var id = "hyp_r6perf_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
    var hyp = {
      id: id, type: type, source: "performance_monitor",
      statement: statement, action: action,
      confidence: 0.75, expectedImpact: "high",
      createdAt: new Date().toISOString(), status: "pending",
    };
    if (pushHypothesis(hyp)) {
      counters.hypothesesGenerated++;
      lastTriggerAt = Date.now();
      notify("[perf-monitor] Generated: " + statement);
      return hyp;
    }
    return null;
  }

  function check() {
    counters.checks++;
    var window = trades.slice(-cfg.windowSize);
    var metrics = computeMetrics(window);
    if (!metrics) return { ok: true, skipped: true, reason: "insufficient_trades", trades: trades.length };

    periods.push({ ts: new Date().toISOString(), metrics: metrics });
    if (periods.length > 20) periods.shift();

    if (!canTrigger()) return { ok: true, skipped: true, reason: "cooldown", metrics: metrics };

    var degraded = false;
    var reasons = [];

    if (metrics.winRate < cfg.winRateThreshold) {
      degraded = true;
      reasons.push("win_rate_low (" + (metrics.winRate * 100).toFixed(1) + "%)");
    }
    if (metrics.sharpe < cfg.sharpeThreshold) {
      degraded = true;
      reasons.push("sharpe_negative (" + metrics.sharpe.toFixed(2) + ")");
    }
    if (metrics.profitFactor < cfg.profitFactorThreshold && metrics.profitFactor < 900) {
      degraded = true;
      reasons.push("profit_factor_low (" + metrics.profitFactor.toFixed(2) + ")");
    }

    if (degraded) {
      counters.degradations++;
      var generated = [];

      var h1 = generateHypothesis(
        "performance_degradation",
        "System performance degraded: " + reasons.join(", ") + ". Review and adjust parameters.",
        "Tighten risk controls, reduce position sizes, review strategy weights"
      );
      if (h1) generated.push(h1);

      var h2 = generateHypothesis(
        "strategy_rebalance",
        "Performance degradation detected. Rebalance strategy allocation based on recent outcomes.",
        "Shift weight toward higher-performing strategies"
      );
      if (h2) generated.push(h2);

      if (selfHealer && typeof selfHealer.tick === "function") {
        try { selfHealer.tick({ performanceDegradation: true, reasons: reasons }); } catch (e) {}
      }

      return { ok: true, degraded: true, reasons: reasons, metrics: metrics, hypotheses: generated };
    }

    return { ok: true, degraded: false, metrics: metrics };
  }

  function getMetrics() {
    var window = trades.slice(-cfg.windowSize);
    return computeMetrics(window);
  }

  function getTrades(limit) { return trades.slice(-(limit || 50)); }

  function stats() {
    return {
      checks: counters.checks, degradations: counters.degradations,
      hypothesesGenerated: counters.hypothesesGenerated,
      totalTrades: trades.length, periods: periods.length, config: cfg,
    };
  }

  function clear() {
    trades.length = 0; periods.length = 0;
    counters.checks = 0; counters.degradations = 0; counters.hypothesesGenerated = 0;
    lastTriggerAt = 0;
  }

  return {
    recordTrade: recordTrade, check: check, getMetrics: getMetrics,
    getTrades: getTrades, stats: stats, clear: clear, _cfg: cfg,
  };
}

module.exports = { createPerformanceMonitor, DEFAULTS };
