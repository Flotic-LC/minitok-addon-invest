"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createPerformanceMonitor } = require("../src/agent/performance-monitor");

test("report returns zeros with no data", () => {
  const pm = createPerformanceMonitor();
  const r = pm.report();
  assert.equal(r.sharpe, 0);
  assert.equal(r.sortino, 0);
  assert.equal(r.maxDrawdownPct, 0);
  assert.equal(r.totalTrades, 0);
  assert.equal(r.winRatePct, 0);
});

test("equity recording tracks drawdown", () => {
  const pm = createPerformanceMonitor();
  pm.recordEquity(1000000);
  pm.recordEquity(1100000);
  pm.recordEquity(900000);  // drawdown from 1100000
  pm.recordEquity(1050000);
  const r = pm.report();
  // MaxDD = (1100000-900000)/1100000 = 18.18%
  assert.ok(r.maxDrawdownPct > 18 && r.maxDrawdownPct < 19);
  assert.equal(r.highWaterMark, 1100000);
});

test("trade recording computes win rate", () => {
  const pm = createPerformanceMonitor();
  pm.recordTrade({ symbol: "A", side: "SELL", pnl: 5000 });
  pm.recordTrade({ symbol: "B", side: "SELL", pnl: -2000 });
  pm.recordTrade({ symbol: "C", side: "SELL", pnl: 3000 });
  pm.recordTrade({ symbol: "D", side: "SELL", pnl: -1000 });
  const r = pm.report();
  assert.equal(r.totalTrades, 4);
  assert.equal(r.wins, 2);
  assert.equal(r.losses, 2);
  assert.equal(r.winRatePct, 50);
  assert.equal(r.totalPnl, 5000);
});

test("profit factor computed correctly", () => {
  const pm = createPerformanceMonitor();
  pm.recordTrade({ symbol: "A", side: "SELL", pnl: 10000 });
  pm.recordTrade({ symbol: "B", side: "SELL", pnl: -5000 });
  const r = pm.report();
  assert.equal(r.profitFactor, 2);
});

test("sharpe ratio positive for consistent gains", () => {
  const pm = createPerformanceMonitor();
  for (let i = 0; i < 50; i++) {
    pm.recordEquity(1000000 + i * 10000);
  }
  const r = pm.report();
  assert.ok(r.sharpe > 0, `expected positive sharpe, got ${r.sharpe}`);
});

test("toPrometheus returns valid text format", () => {
  const pm = createPerformanceMonitor();
  pm.recordEquity(1000000);
  pm.recordTrade({ symbol: "X", side: "SELL", pnl: 100 });
  const text = pm.toPrometheus();
  assert.ok(text.includes("tossinvest_sharpe_ratio"));
  assert.ok(text.includes("tossinvest_max_drawdown_pct"));
  assert.ok(text.includes("tossinvest_total_trades 1"));
  assert.ok(text.includes("# TYPE"));
});

test("equity history respects max length", () => {
  const pm = createPerformanceMonitor({ maxEquityHistory: 5 });
  for (let i = 0; i < 20; i++) pm.recordEquity(1000000 + i);
  const r = pm.report();
  assert.equal(r.equitySamples, 5);
});

test("invalid equity values are ignored", () => {
  const pm = createPerformanceMonitor();
  pm.recordEquity(1000000);
  pm.recordEquity(-100);
  pm.recordEquity("bad");
  pm.recordEquity(null);
  const r = pm.report();
  assert.equal(r.equitySamples, 1);
});

// ---------------------------------------------------------------------------
// [DEEP-DEBUG] Sortino blind-spot fix
// ---------------------------------------------------------------------------

test("sortino is non-zero with a single negative return (no blind spot)", () => {
  const pm = createPerformanceMonitor();
  // 9 positive returns, 1 negative — old code returned sortino=0 because
  // downsideStd required >= 2 negative samples.
  pm.recordEquity(1000000);
  for (let i = 0; i < 9; i++) pm.recordEquity(1010000 + i * 5000);
  pm.recordEquity(995000); // one dip
  pm.recordEquity(1020000);
  const r = pm.report();
  assert.ok(r.sortino > 0, `sortino should be positive with mostly gains, got ${r.sortino}`);
});

test("sortino reflects downside risk correctly", () => {
  const pm = createPerformanceMonitor();
  // Alternating gains and losses
  pm.recordEquity(1000000);
  pm.recordEquity(1050000); // +5%
  pm.recordEquity(1020000); // -2.86%
  pm.recordEquity(1080000); // +5.88%
  pm.recordEquity(1040000); // -3.70%
  pm.recordEquity(1100000); // +5.77%
  const r = pm.report();
  assert.ok(r.sortino > 0, `sortino should be positive (net gain), got ${r.sortino}`);
  assert.ok(r.maxDrawdownPct > 0, `max drawdown should be positive, got ${r.maxDrawdownPct}`);
});

test("sortino is 0 when all returns are positive (no downside)", () => {
  const pm = createPerformanceMonitor();
  pm.recordEquity(1000000);
  pm.recordEquity(1010000);
  pm.recordEquity(1020000);
  pm.recordEquity(1030000);
  const r = pm.report();
  assert.equal(r.sortino, 0, "no downside deviation means sortino denominator is 0");
});
