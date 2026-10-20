"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  recordRecentFill,
  computeRecentWinRate,
  recordSymbolOutcome,
  evaluateTrailingStop,
  computeAdaptiveTargetOffset,
  getWorstSymbols,
  getBestSymbols,
} = require("../src/trading-logic");

// ---------------------------------------------------------------------------
// P10-1: recordRecentFill — knownPnl vs entryPrices lookup ordering
// ---------------------------------------------------------------------------

test("recordRecentFill uses knownPnl when provided (P10-1 fix)", () => {
  const fills = [];
  const entryPrices = new Map();
  entryPrices.set("AAPL", 150);
  const rec = recordRecentFill(fills, 20, entryPrices, "AAPL", "SELL", 160, 10, 1234.5);
  assert.equal(rec.pnl, 1234.5, "must use provided knownPnl, not lookup");
  assert.equal(fills.length, 1);
});

test("recordRecentFill computes P&L from entryPrices when knownPnl absent", () => {
  const fills = [];
  const entryPrices = new Map();
  entryPrices.set("005930", 70000);
  const rec = recordRecentFill(fills, 20, entryPrices, "005930", "SELL", 73500, 2);
  assert.equal(rec.pnl, (73500 - 70000) * 2);
});

test("recordRecentFill pnl is null for BUY fills", () => {
  const fills = [];
  const entryPrices = new Map();
  const rec = recordRecentFill(fills, 20, entryPrices, "AAPL", "BUY", 150, 5);
  assert.equal(rec.pnl, null);
});

test("recordRecentFill pnl is null for SELL with no tracked entry", () => {
  const fills = [];
  const entryPrices = new Map();
  const rec = recordRecentFill(fills, 20, entryPrices, "TSLA", "SELL", 200, 1);
  assert.equal(rec.pnl, null);
});

test("recordRecentFill P10-1 regression: works after entryPrices deleted (P&L from knownPnl)", () => {
  // Simulates the fixed monitorPendingOrders flow:
  //  1. entryPrices.set on BUY fill
  //  2. SELL fill arrives → compute sellPnl from entryPrices (before delete)
  //  3. entryPrices.delete
  //  4. recordRecentFill called with knownPnl → still has correct pnl
  const fills = [];
  const entryPrices = new Map();

  // BUY fill
  recordRecentFill(fills, 20, entryPrices, "AAPL", "BUY", 100, 10);
  entryPrices.set("AAPL", 100);

  // SELL fill: compute pnl BEFORE delete (fixed order)
  const entryPrice = entryPrices.get("AAPL");
  const sellPnl = (110 - entryPrice) * 10;
  entryPrices.delete("AAPL");

  const rec = recordRecentFill(fills, 20, entryPrices, "AAPL", "SELL", 110, 10, sellPnl);
  assert.equal(rec.pnl, 100, "pnl = (110-100)*10 = 100, even after entryPrices deleted");
});

// ---------------------------------------------------------------------------
// P10-3: computeRecentWinRate — ADAPTIVE_TARGET_WINDOW + two-tier fallback
// ---------------------------------------------------------------------------

function makeSells(fills, pnls) {
  for (const p of pnls) {
    fills.push({ symbol: "S", side: "SELL", price: 1, quantity: 1, pnl: p, at: new Date().toISOString() });
  }
}

test("computeRecentWinRate uses recent SELL fills when >= 3 available", () => {
  const fills = [];
  makeSells(fills, [100, -50, 200]); // 2 wins / 3 = 0.667
  const perf = new Map();
  const rate = computeRecentWinRate(fills, perf, 20);
  assert.ok(Math.abs(rate - 2 / 3) < 0.001);
});

test("computeRecentWinRate applies ADAPTIVE_TARGET_WINDOW (P10-3)", () => {
  const fills = [];
  // 25 fills: first 20 are losses (pnl=-1), last 5 are wins (pnl=+1)
  // With window=5 → only last 5 seen → 100% win rate
  for (let i = 0; i < 20; i++) fills.push({ symbol: "S", side: "SELL", price: 1, quantity: 1, pnl: -1, at: new Date().toISOString() });
  for (let i = 0; i < 5; i++) fills.push({ symbol: "S", side: "SELL", price: 1, quantity: 1, pnl: 1, at: new Date().toISOString() });
  const perf = new Map();
  const rate = computeRecentWinRate(fills, perf, 5);
  assert.equal(rate, 1, "window=5 should only see last 5 (all wins)");
});

test("computeRecentWinRate falls back to cumulative when < 3 recent SELLs", () => {
  const fills = [];
  makeSells(fills, [100, 200]); // only 2 — below threshold
  const perf = new Map();
  recordSymbolOutcome(perf, "AAPL", 500);
  recordSymbolOutcome(perf, "AAPL", 300);
  recordSymbolOutcome(perf, "AAPL", -100);
  recordSymbolOutcome(perf, "TSLA", 200);
  recordSymbolOutcome(perf, "TSLA", -50);
  // 5 trades, 3 wins → 0.6
  const rate = computeRecentWinRate(fills, perf, 20);
  assert.ok(Math.abs(rate - 0.6) < 0.001);
});

test("computeRecentWinRate returns null when no data at all", () => {
  const rate = computeRecentWinRate([], new Map(), 20);
  assert.strictEqual(rate, null);
});

// ---------------------------------------------------------------------------
// P8-1: evaluateTrailingStop — peak tracking, min-profit gate, trigger logic
// ---------------------------------------------------------------------------

test("evaluateTrailingStop skips invalid positions", () => {
  assert.equal(evaluateTrailingStop("", 100, 5, 90, undefined, -3, 1).reason, "invalid_position");
  assert.equal(evaluateTrailingStop("X", 0, 5, 90, undefined, -3, 1).reason, "invalid_position");
  assert.equal(evaluateTrailingStop("X", 100, 0, 90, undefined, -3, 1).reason, "invalid_position");
  assert.equal(evaluateTrailingStop("X", 100, 5, 0, undefined, -3, 1).reason, "no_entry");
});

test("evaluateTrailingStop skips below min-profit threshold and clears peak", () => {
  // entry=100, price=100.5 → 0.5% profit < 1% min → skip
  const r = evaluateTrailingStop("AAPL", 100.5, 10, 100, 101, -3, 1);
  assert.equal(r.skip, true);
  assert.equal(r.reason, "below_min_profit");
  assert.equal(r.clearPeak, true);
});

test("evaluateTrailingStop min-profit boundary: exactly at threshold does NOT skip", () => {
  // entry=100, price=101 → exactly 1.0% profit → >= 1 → proceeds to peak tracking
  const r = evaluateTrailingStop("AAPL", 101, 10, 100, undefined, -3, 1);
  assert.equal(r.skip, undefined, "should not skip at exactly 1% profit");
});

test("evaluateTrailingStop peak reset on new entry (P10-2a scenario)", () => {
  // Simulate: old peak=105 exists, but profitPct recalculated from new entry=100
  // price=101 → 1% profit → peak initialized to entry=100 (old peak ignored via peak=undefined)
  const r = evaluateTrailingStop("AAPL", 101, 10, 100, undefined, -3, 1);
  assert.equal(r.peak, 101, "peak starts from entry, updated to current price");
  assert.equal(r.peakUpdated, true);
});

test("evaluateTrailingStop updates peak when price exceeds it", () => {
  const r = evaluateTrailingStop("AAPL", 110, 10, 100, 105, -3, 1);
  assert.equal(r.peak, 110);
  assert.equal(r.peakUpdated, true);
  assert.equal(r.triggered, false);
});

test("evaluateTrailingStop does not update peak when price is below it", () => {
  const r = evaluateTrailingStop("AAPL", 103, 10, 100, 105, -3, 1);
  assert.equal(r.peak, 105);
  assert.equal(r.peakUpdated, false);
  assert.equal(r.triggered, false);
});

test("evaluateTrailingStop triggers SELL when drop exceeds trailing stop threshold", () => {
  // entry=100, peak=110, price=106 → drop = -3.636% < -3% → trigger
  const r = evaluateTrailingStop("AAPL", 106, 10, 100, 110, -3, 1);
  assert.equal(r.triggered, true);
  assert.equal(r.action, "SELL");
  assert.ok(r.dropPct <= -3, "dropPct should be <= -3, got " + r.dropPct);
});

test("evaluateTrailingStop does not trigger above trailing stop threshold", () => {
  // entry=100, peak=110, price=107 → drop = -2.73% > -3% → no trigger
  const r = evaluateTrailingStop("AAPL", 107, 10, 100, 110, -3, 1);
  assert.equal(r.triggered, false);
});

test("evaluateTrailingStop triggers when price drops to near-entry but peak is high", () => {
  // entry=100, peak=120, price=101 → profit=1% (>= minProfit=1), drop from peak = -15.8% → trigger
  const r = evaluateTrailingStop("AAPL", 101, 10, 100, 120, -3, 1);
  assert.equal(r.triggered, true);
});

test("evaluateTrailingStop full lifecycle: rise, peak, pullback, trigger", () => {
  const entry = 100;
  const stopPct = -3;
  const minProfit = 1;

  // Phase 1: price rises to 110 (10% profit, new peak)
  let r = evaluateTrailingStop("X", 110, 10, entry, undefined, stopPct, minProfit);
  assert.equal(r.peak, 110);
  assert.equal(r.triggered, false);

  // Phase 2: price rises to 115 (new peak)
  r = evaluateTrailingStop("X", 115, 10, entry, r.peak, stopPct, minProfit);
  assert.equal(r.peak, 115);
  assert.equal(r.triggered, false);

  // Phase 3: price pulls back to 112 (drop = -2.6% > -3%, no trigger)
  r = evaluateTrailingStop("X", 112, 10, entry, r.peak, stopPct, minProfit);
  assert.equal(r.triggered, false);
  assert.equal(r.peak, 115, "peak not lowered by pullback");

  // Phase 4: price drops to 111 (drop = -3.48% <= -3%, trigger)
  r = evaluateTrailingStop("X", 111, 10, entry, r.peak, stopPct, minProfit);
  assert.equal(r.triggered, true);
  assert.equal(r.action, "SELL");
  assert.equal(r.profitPct, 11);
});

// ---------------------------------------------------------------------------
// P8-2: computeAdaptiveTargetOffset — threshold boundaries
// ---------------------------------------------------------------------------

test("computeAdaptiveTargetOffset returns bonus at win rate >= 60%", () => {
  assert.equal(computeAdaptiveTargetOffset(0.6, 0.5, -0.3), 0.5);
  assert.equal(computeAdaptiveTargetOffset(0.8, 0.5, -0.3), 0.5);
  assert.equal(computeAdaptiveTargetOffset(1.0, 0.5, -0.3), 0.5);
});

test("computeAdaptiveTargetOffset returns penalty at win rate <= 40%", () => {
  assert.equal(computeAdaptiveTargetOffset(0.4, 0.5, -0.3), -0.3);
  assert.equal(computeAdaptiveTargetOffset(0.2, 0.5, -0.3), -0.3);
  assert.equal(computeAdaptiveTargetOffset(0.0, 0.5, -0.3), -0.3);
});

test("computeAdaptiveTargetOffset returns 0 in neutral zone and for null", () => {
  assert.equal(computeAdaptiveTargetOffset(0.5, 0.5, -0.3), 0);
  assert.equal(computeAdaptiveTargetOffset(0.41, 0.5, -0.3), 0);
  assert.equal(computeAdaptiveTargetOffset(0.59, 0.5, -0.3), 0);
  assert.equal(computeAdaptiveTargetOffset(null, 0.5, -0.3), 0);
  assert.equal(computeAdaptiveTargetOffset(undefined, 0.5, -0.3), 0);
});

// ---------------------------------------------------------------------------
// recordSymbolOutcome + getWorstSymbols / getBestSymbols
// ---------------------------------------------------------------------------

test("recordSymbolOutcome accumulates correctly", () => {
  const perf = new Map();
  recordSymbolOutcome(perf, "AAPL", 100);
  recordSymbolOutcome(perf, "AAPL", -50);
  recordSymbolOutcome(perf, "AAPL", 200);
  const p = perf.get("AAPL");
  assert.equal(p.trades, 3);
  assert.equal(p.wins, 2);
  assert.equal(p.losses, 1);
  assert.equal(p.totalPnl, 250);
});

test("recordSymbolOutcome handles zero pnl (not win, not loss)", () => {
  const perf = new Map();
  recordSymbolOutcome(perf, "X", 0);
  const p = perf.get("X");
  assert.equal(p.trades, 1);
  assert.equal(p.wins, 0);
  assert.equal(p.losses, 0);
});

test("recordSymbolOutcome normalizes symbol to uppercase", () => {
  const perf = new Map();
  recordSymbolOutcome(perf, "aapl", 100);
  recordSymbolOutcome(perf, "AAPL", 200);
  assert.equal(perf.size, 1);
  assert.equal(perf.get("AAPL").totalPnl, 300);
});

test("getWorstSymbols sorts ascending by totalPnl", () => {
  const perf = new Map();
  recordSymbolOutcome(perf, "GOOD", 500);
  recordSymbolOutcome(perf, "BAD", -300);
  recordSymbolOutcome(perf, "MID", 100);
  const worst = getWorstSymbols(perf, 1, 3);
  assert.equal(worst[0].symbol, "BAD");
  assert.equal(worst[2].symbol, "GOOD");
});

test("getBestSymbols sorts descending by totalPnl", () => {
  const perf = new Map();
  recordSymbolOutcome(perf, "GOOD", 500);
  recordSymbolOutcome(perf, "BAD", -300);
  recordSymbolOutcome(perf, "MID", 100);
  const best = getBestSymbols(perf, 1, 3);
  assert.equal(best[0].symbol, "GOOD");
  assert.equal(best[2].symbol, "BAD");
});

test("getWorstSymbols filters by minTrades", () => {
  const perf = new Map();
  recordSymbolOutcome(perf, "NEW", -999); // 1 trade — below minTrades=3
  recordSymbolOutcome(perf, "OLD", 100);
  recordSymbolOutcome(perf, "OLD", 100);
  recordSymbolOutcome(perf, "OLD", 100);
  const worst = getWorstSymbols(perf, 3, 5);
  assert.equal(worst.length, 1);
  assert.equal(worst[0].symbol, "OLD");
});

test("computeRecentWinRate returns null when cumulative has < 5 trades", () => {
  const perf = new Map();
  recordSymbolOutcome(perf, "AAPL", 100);
  recordSymbolOutcome(perf, "AAPL", 200);
  recordSymbolOutcome(perf, "AAPL", 300);
  // only 3 cumulative trades, below 5 minimum
  const rate = computeRecentWinRate([], perf, 20);
  assert.equal(rate, null);
});

test("computeRecentWinRate ignores BUY fills (no pnl)", () => {
  const fills = [];
  fills.push({ symbol: "S", side: "BUY", price: 1, quantity: 1, pnl: null, at: new Date().toISOString() });
  fills.push({ symbol: "S", side: "BUY", price: 1, quantity: 1, pnl: null, at: new Date().toISOString() });
  const perf = new Map();
  const rate = computeRecentWinRate(fills, perf, 20);
  assert.equal(rate, null, "BUY fills don't count, no SELLs → null");
});


test("recordRecentFill ring buffer evicts oldest beyond maxFills", () => {
  const fills = [];
  const entryPrices = new Map();
  for (let i = 0; i < 25; i++) {
    recordRecentFill(fills, 20, entryPrices, "X", "BUY", 100 + i, 1);
  }
  assert.equal(fills.length, 20);
  assert.equal(fills[0].price, 105, "oldest 5 evicted");
  assert.equal(fills[19].price, 124);
});
