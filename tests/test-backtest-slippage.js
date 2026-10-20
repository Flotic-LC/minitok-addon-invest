"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { runBacktest, parseArgs, applySlippage } = require("../backtest");

// Build a simple 30-day uptrend candle series for a single symbol
function makeCandles(symbol, startPrice, days, driftPct) {
  const candles = [];
  let p = startPrice;
  const baseDate = new Date("2025-01-02");
  for (let i = 0; i < days; i++) {
    const d = new Date(baseDate);
    d.setDate(d.getDate() + i);
    const high = p * 1.015;
    const low = p * 0.985;
    const close = p * (1 + driftPct / 100);
    candles.push({
      symbol, date: d.toISOString().slice(0, 10),
      open: p, high, low, close: Number(close.toFixed(2)),
      volume: 1000000,
    });
    p = close;
  }
  return candles;
}

test("parseArgs accepts slippage CLI flags", () => {
  const a = parseArgs([
    "node", "backtest.js",
    "--data", "x.json",
    "--slippage", "0.2",
    "--impact", "0.5",
    "--partial-fill", "0.8",
    "--commission", "0.02",
  ]);
  assert.equal(a.slippagePct, 0.2);
  assert.equal(a.impactCoefficient, 0.5);
  assert.equal(a.partialFillRate, 0.8);
  assert.equal(a.commissionPct, 0.02);
});

test("parseArgs has safe defaults (slippage off by default except commission)", () => {
  const a = parseArgs(["node", "backtest.js"]);
  assert.equal(a.slippagePct, 0.1);
  assert.equal(a.impactCoefficient, 0);
  assert.equal(a.partialFillRate, 1.0);
  assert.equal(a.commissionPct, 0.015);
});

test("applySlippage raises BUY price", () => {
  const r = applySlippage(100000, "BUY", 1000000, 100000000, {
    slippagePct: 0.2, impactCoefficient: 0, commissionPct: 0.015, partialFillRate: 1.0,
  });
  assert.ok(r.executedPrice > 100000, `BUY price should be higher, got ${r.executedPrice}`);
  assert.ok(r.effectiveCost > r.executedPrice, "commission adds to cost");
  assert.equal(r.fillRate, 1.0);
});

test("applySlippage lowers SELL price", () => {
  const r = applySlippage(100000, "SELL", 1000000, 100000000, {
    slippagePct: 0.2, impactCoefficient: 0, commissionPct: 0.015, partialFillRate: 1.0,
  });
  assert.ok(r.executedPrice < 100000, `SELL price should be lower, got ${r.executedPrice}`);
  assert.ok(r.effectiveCost < r.executedPrice, "commission subtracts from proceeds");
});

test("applySlippage with impact coefficient increases cost for large orders", () => {
  const small = applySlippage(100000, "BUY", 100000, 10000000, {
    slippagePct: 0, impactCoefficient: 5, commissionPct: 0, partialFillRate: 1.0,
  });
  const large = applySlippage(100000, "BUY", 5000000, 10000000, {
    slippagePct: 0, impactCoefficient: 5, commissionPct: 0, partialFillRate: 1.0,
  });
  assert.ok(large.impactPct > small.impactPct,
    `larger order should have higher impact: ${large.impactPct} vs ${small.impactPct}`);
});

test("applySlippage partial fill reduces quantity", () => {
  const r = applySlippage(100000, "BUY", 1000000, 100000000, {
    slippagePct: 0.1, impactCoefficient: 0, commissionPct: 0, partialFillRate: 0.7,
  });
  assert.equal(r.fillRate, 0.7);
});

test("runBacktest with slippage produces worse return than without", () => {
  const candles = makeCandles("005930", 70000, 60, 0.4); // mild uptrend
  const optsClean = {
    initial: 10000000, stopLoss: -5, takeProfit: 10, maxOrderValueKrw: 1000000,
    slippagePct: 0, impactCoefficient: 0, partialFillRate: 1.0, commissionPct: 0,
  };
  const optsDirty = {
    ...optsClean,
    slippagePct: 0.3, impactCoefficient: 2, partialFillRate: 0.85, commissionPct: 0.02,
  };
  const rClean = runBacktest(candles, optsClean);
  const rDirty = runBacktest(candles, optsDirty);
  // Slippage should either leave returns equal (no trades) or make them worse
  assert.ok(rDirty.totalReturnPct <= rClean.totalReturnPct + 0.01,
    `slippage should not improve returns: ${rDirty.totalReturnPct} vs ${rClean.totalReturnPct}`);
  // Slippage cost should be non-negative
  assert.ok(rDirty.totalSlippageCostKrw >= 0);
});

test("runBacktest result includes slippageConfig and stats", () => {
  const candles = makeCandles("AAPL", 200, 30, 0.2);
  const r = runBacktest(candles, {
    initial: 10000000, stopLoss: -3, takeProfit: 5, maxOrderValueKrw: 500000,
    slippagePct: 0.15, impactCoefficient: 1, partialFillRate: 0.9, commissionPct: 0.01,
  });
  assert.ok(r.slippageConfig, "slippageConfig missing");
  assert.equal(r.slippageConfig.slippagePct, 0.15);
  assert.equal(r.slippageConfig.impactCoefficient, 1);
  assert.equal(r.slippageConfig.partialFillRate, 0.9);
  assert.equal(typeof r.totalSlippageCostKrw, "number");
  assert.equal(typeof r.partialFillTrades, "number");
});

test("runBacktest with full slippage still produces valid sharpe/drawdown", () => {
  const candles = makeCandles("MSFT", 400, 40, 0.3);
  const r = runBacktest(candles, {
    initial: 5000000, stopLoss: -4, takeProfit: 8, maxOrderValueKrw: 800000,
    slippagePct: 0.2, impactCoefficient: 1.5, partialFillRate: 0.9, commissionPct: 0.015,
  });
  assert.ok(Number.isFinite(r.sharpe));
  assert.ok(r.maxDrawdownPct >= 0);
  assert.ok(Number.isFinite(r.totalReturnPct));
  assert.equal(r.initialEquity, 5000000);
});
