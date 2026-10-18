"use strict";

/**
 * Performance monitor — computes risk-adjusted return metrics and exports
 * them in Prometheus text format for external dashboards.
 *
 * Metrics computed:
 *   - Sharpe ratio (annualized)
 *   - Sortino ratio (annualized)
 *   - Max drawdown %
 *   - Win rate, profit factor
 *   - Average trade PnL
 *
 * Usage:
 *   const { createPerformanceMonitor } = require("./performance-monitor");
 *   const pm = createPerformanceMonitor();
 *   pm.recordTrade({ symbol, side, pnl, timestamp });
 *   pm.recordEquity(5230000);
 *   const report = pm.report();
 *   const prom = pm.toPrometheus();
 */

const DEFAULTS = Object.freeze({
  riskFreeRatePct: Number(process.env.PERF_RISK_FREE_PCT || 3.0),
  annualizationFactor: 252,
  maxEquityHistory: 500,
  maxTradeHistory: 1000,
});

function createPerformanceMonitor(options = {}) {
  const p = { ...DEFAULTS, ...options };
  const equityHistory = [];
  const tradeHistory = [];
  let highWaterMark = 0;
  let maxDrawdownPct = 0;

  function recordEquity(equity, date) {
    const e = Number(equity);
    if (!Number.isFinite(e) || e <= 0) return;
    equityHistory.push({ equity: e, date: date || new Date().toISOString() });
    if (equityHistory.length > p.maxEquityHistory) equityHistory.shift();
    if (e > highWaterMark) highWaterMark = e;
    const dd = highWaterMark > 0 ? ((highWaterMark - e) / highWaterMark) * 100 : 0;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
  }

  function recordTrade(trade) {
    tradeHistory.push({
      symbol: trade.symbol,
      side: trade.side,
      pnl: Number(trade.pnl) || 0,
      suppressed: !!trade.suppressed,
      timestamp: trade.timestamp || new Date().toISOString(),
    });
    if (tradeHistory.length > p.maxTradeHistory) tradeHistory.shift();
  }

  function computeReturns() {
    if (equityHistory.length < 2) return [];
    const returns = [];
    for (let i = 1; i < equityHistory.length; i++) {
      const prev = equityHistory[i - 1].equity;
      const curr = equityHistory[i].equity;
      if (prev > 0) returns.push((curr - prev) / prev);
    }
    return returns;
  }

  function mean(arr) {
    if (!arr.length) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  function std(arr) {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    const variance = arr.reduce((s, r) => s + (r - m) ** 2, 0) / (arr.length - 1);
    return Math.sqrt(variance);
  }

  function downsideStd(returns) {
    // [DEEP-DEBUG FIX] Sortino uses downside deviation measured vs 0 (or MAR),
    // not vs the mean of negatives. The previous implementation computed the
    // sample std of negative returns only, which:
    //   (a) returned 0 when < 2 negative returns existed (blind spot for
    //       high-win-rate strategies), and
    //   (b) underestimated downside risk when negatives clustered tightly
    //       far below zero.
    // Standard formula: sqrt( mean( min(r,0)^2 ) ).
    if (returns.length === 0) return 0;
    const sumSq = returns.reduce((s, r) => s + (r < 0 ? r * r : 0), 0);
    return Math.sqrt(sumSq / returns.length);
  }

  function report() {
    const returns = computeReturns();
    const dailyRf = p.riskFreeRatePct / 100 / p.annualizationFactor;
    const excessReturns = returns.map(r => r - dailyRf);
    const avgReturn = mean(excessReturns);
    const vol = std(excessReturns);
    const sharpe = vol > 0 ? (avgReturn / vol) * Math.sqrt(p.annualizationFactor) : 0;
    // [FIX] Sortino 분모를 excess returns 기준으로 통일 (MAR = rf)
    const downVol = downsideStd(excessReturns);
    const sortino = downVol > 0 ? (avgReturn / downVol) * Math.sqrt(p.annualizationFactor) : 0;

    // [FIX] suppressed trade는 win rate 분모에서 제외
    const wins = tradeHistory.filter(t => t.pnl > 0 && !t.suppressed);
    const losses = tradeHistory.filter(t => t.pnl < 0 && !t.suppressed);
    const suppressed = tradeHistory.filter(t => t.suppressed);
    const totalPnl = tradeHistory.reduce((s, t) => s + t.pnl, 0);
    const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
    const countedTrades = tradeHistory.filter(t => !t.suppressed);
    const winRate = countedTrades.length > 0 ? (wins.length / countedTrades.length) * 100 : 0;
    const avgTradePnl = tradeHistory.length > 0 ? totalPnl / tradeHistory.length : 0;

    return {
      sharpe: Number(sharpe.toFixed(3)),
      sortino: Number(sortino.toFixed(3)),
      maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
      totalTrades: tradeHistory.length,
      wins: wins.length,
      losses: losses.length,
      suppressedTrades: suppressed.length,
      winRatePct: Number(winRate.toFixed(1)),
      profitFactor: Number.isFinite(profitFactor) ? Number(profitFactor.toFixed(2)) : null,
      totalPnl: Math.round(totalPnl),
      avgTradePnl: Math.round(avgTradePnl),
      highWaterMark: Math.round(highWaterMark),
      currentEquity: equityHistory.length > 0 ? equityHistory[equityHistory.length - 1].equity : 0,
      equitySamples: equityHistory.length,
    };
  }

  function toPrometheus() {
    const r = report();
    const lines = [
      "# HELP tossinvest_sharpe_ratio Annualized Sharpe ratio",
      "# TYPE tossinvest_sharpe_ratio gauge",
      `tossinvest_sharpe_ratio ${r.sharpe}`,
      "# HELP tossinvest_sortino_ratio Annualized Sortino ratio",
      "# TYPE tossinvest_sortino_ratio gauge",
      `tossinvest_sortino_ratio ${r.sortino}`,
      "# HELP tossinvest_max_drawdown_pct Maximum drawdown percentage",
      "# TYPE tossinvest_max_drawdown_pct gauge",
      `tossinvest_max_drawdown_pct ${r.maxDrawdownPct}`,
      "# HELP tossinvest_total_trades Total number of trades",
      "# TYPE tossinvest_total_trades counter",
      `tossinvest_total_trades ${r.totalTrades}`,
      "# HELP tossinvest_win_rate_pct Win rate percentage",
      "# TYPE tossinvest_win_rate_pct gauge",
      `tossinvest_win_rate_pct ${r.winRatePct}`,
      "# HELP tossinvest_profit_factor Profit factor",
      "# TYPE tossinvest_profit_factor gauge",
      `tossinvest_profit_factor ${r.profitFactor || 0}`,
      "# HELP tossinvest_total_pnl Total PnL in KRW",
      "# TYPE tossinvest_total_pnl gauge",
      `tossinvest_total_pnl ${r.totalPnl}`,
      "# HELP tossinvest_equity_krw Current equity in KRW",
      "# TYPE tossinvest_equity_krw gauge",
      `tossinvest_equity_krw ${r.currentEquity}`,
    ];
    return lines.join("\n") + "\n";
  }

  return { recordEquity, recordTrade, report, toPrometheus, DEFAULTS: p };
}

module.exports = { createPerformanceMonitor, DEFAULTS };
