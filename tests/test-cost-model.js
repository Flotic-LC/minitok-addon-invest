"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { costProfile, roundTripCostPct, applyExecutionCosts, costGate, atrMovePct } = require("../src/agent/cost-model");
const { computeRoundTripPnl, resolveFees } = require("../src/agent/pnl");
const { runBacktest, runCostSensitivity } = require("../backtest");
const { generateSignal, DEFAULT_PARAMS } = require("../src/strategy/signals");

// ---------------------------------------------------------------------------
// A deterministic, VALID candle series. The validator rejects a zero close, a
// NaN, a high below the open and fewer than 30 candles per symbol, so the
// generator has to produce coherent bars or the test would measure nothing.
// ---------------------------------------------------------------------------
function makeCandles(symbol, bars, startPrice, driftPct, volPct, seed) {
  let s = seed >>> 0;
  const rnd = function() {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const norm = function() {
    const u = Math.max(1e-9, rnd());
    const v = Math.max(1e-9, rnd());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const out = [];
  let price = startPrice;
  for (let i = 0; i < bars; i++) {
    const open = price;
    const close = Math.max(0.5, open * (1 + driftPct / 100 + (norm() * volPct) / 100));
    const high = Math.max(open, close) * (1 + Math.abs(norm()) * 0.004);
    const low = Math.min(open, close) * (1 - Math.abs(norm()) * 0.004);
    const date = "2025-01-" + String((i % 28) + 1).padStart(2, "0") + "T00:00:00Z";
    out.push({
      symbol: symbol, date: date,
      open: Number(open.toFixed(4)), high: Number(high.toFixed(4)),
      low: Number(low.toFixed(4)), close: Number(close.toFixed(4)),
      volume: Math.round(500000 + rnd() * 4000000),
    });
    price = close;
  }
  return out;
}

const BASE_OPTS = {
  initial: 10000,
  stopLoss: -8,
  takeProfit: 8,
  maxOrderValueKrw: 1500,
  market: "US",
  commissionPct: 0,
};

// ---------------------------------------------------------------------------
// 1. The cost model
// ---------------------------------------------------------------------------
test("the US round-trip cost is the fee schedule plus the spread and the slippage", function() {
  const cost = roundTripCostPct("US", costProfile("base"));
  const fees = resolveFees("US");
  const expected = fees.buyCommissionPct + fees.sellCommissionPct + fees.sellTaxPct + 0.02 * 2 + 0.05 * 2;
  assert.ok(Math.abs(cost - expected) < 1e-9, "expected " + expected + ", got " + cost);
  // The live bot's measured friction was ~0.49% of the round-tripped notional;
  // the model must be in the same ballpark or the gate is mis-calibrated.
  assert.ok(cost > 0.4 && cost < 0.9, "the round-trip cost should be in the 0.4-0.9% band, got " + cost);
});

test("the cost breakdown sums to the total and separates the cost classes", function() {
  const r = applyExecutionCosts({
    side: "BUY", symbol: "AAPL", price: 100, quantity: 10, notional: 1000,
    avgVolume: 1000000, market: "US", config: costProfile("base"),
  });
  const c = r.costs;
  const sum = c.commission + c.spread + c.slippage + c.impact + c.tax;
  assert.ok(Math.abs(sum - r.totalCost) < 1e-9, "the parts must sum to the total");
  assert.ok(c.commission > 0, "the commission must be charged");
  assert.ok(c.spread > 0, "the spread must be charged — it used to be zero everywhere");
  assert.ok(c.slippage > 0, "the slippage must be charged");
  assert.ok(r.executedPrice > 100, "a BUY must execute above the signal price");
});

test("a SELL executes below the signal price and is charged the tax", function() {
  const r = applyExecutionCosts({
    side: "SELL", symbol: "AAPL", price: 100, quantity: 10, notional: 1000,
    avgVolume: 1000000, market: "US", config: costProfile("base"),
  });
  assert.ok(r.executedPrice < 100, "a SELL must execute below the signal price");
  assert.ok(r.costs.tax > 0, "the US regulatory fee must be charged on the sell side");
  assert.ok(r.costs.commission > 0);
});

// ---------------------------------------------------------------------------
// 2. More cost -> less net P&L
// ---------------------------------------------------------------------------
test("raising the costs lowers the net P&L and the return", function() {
  const candles = makeCandles("AAPL", 120, 100, 0.25, 1.6, 7);
  const cheap = runBacktest(candles, Object.assign({}, BASE_OPTS, { spreadPct: 0.001, slippagePct: 0.001 }));
  const dear = runBacktest(candles, Object.assign({}, BASE_OPTS, { spreadPct: 0.05, slippagePct: 0.2 }));
  assert.ok(cheap.trades > 0 && dear.trades > 0, "both runs must trade");
  assert.ok(dear.netPnl < cheap.netPnl, "a dearer cost model must produce a smaller net P&L: "
    + dear.netPnl + " vs " + cheap.netPnl);
  assert.ok(dear.totalReturnPct < cheap.totalReturnPct, "and a smaller return");
  assert.ok(dear.totalCosts > cheap.totalCosts, "and a bigger cost bill");
});

test("raising the slippage lowers the return", function() {
  const candles = makeCandles("MSFT", 120, 200, 0.25, 1.6, 11);
  const tight = runBacktest(candles, Object.assign({}, BASE_OPTS, { slippagePct: 0.01 }));
  const loose = runBacktest(candles, Object.assign({}, BASE_OPTS, { slippagePct: 0.5 }));
  assert.ok(tight.trades > 0 && loose.trades > 0, "both runs must trade");
  assert.ok(loose.totalReturnPct < tight.totalReturnPct,
    "more slippage must lower the return: " + loose.totalReturnPct + " vs " + tight.totalReturnPct);
});

test("a partial fill is reflected in the return", function() {
  const candles = makeCandles("NVDA", 120, 50, 0.3, 1.8, 13);
  const full = runBacktest(candles, Object.assign({}, BASE_OPTS, { partialFillRate: 1.0 }));
  const partial = runBacktest(candles, Object.assign({}, BASE_OPTS, { partialFillRate: 0.5 }));
  assert.ok(full.trades > 0, "the full-fill run must trade");
  assert.ok(partial.partialFillTrades > 0, "the partial run must record partial fills");
  assert.ok(partial.totalReturnPct < full.totalReturnPct,
    "a partial fill must lower the return: " + partial.totalReturnPct + " vs " + full.totalReturnPct);
});

// ---------------------------------------------------------------------------
// 3. A gross profit can be a net loss
// ---------------------------------------------------------------------------
test("a gross profit smaller than the round-trip cost is a net loss", function() {
  // A 0.4% move is a gross profit but the round trip costs ~0.64%.
  const pnl = computeRoundTripPnl({
    symbol: "AAPL", market: "US",
    entryPrice: 100, exitPrice: 100.4, quantity: 10,
    signalEntryPrice: 100, signalExitPrice: 100.4,
  });
  assert.ok(pnl.grossPnl > 0, "the gross must be a profit");
  assert.ok(pnl.netPnl < 0, "the net must be a loss");
  assert.ok(pnl.costRatio > 1, "the cost ratio must be above 1: " + pnl.costRatio);
  assert.ok(pnl.grossPnlPct > 0 && pnl.pnlPct < 0, "gross and net must disagree in sign");
});

test("the backtest reports gross and net separately, and they can disagree", function() {
  const candles = makeCandles("AAPL", 120, 100, 0.05, 0.9, 17);
  const r = runBacktest(candles, BASE_OPTS);
  assert.ok(r.trades > 0, "the run must trade");
  assert.ok(typeof r.grossPnl === "number", "the result must carry a gross P&L");
  assert.ok(typeof r.netPnl === "number", "the result must carry a net P&L");
  assert.ok(typeof r.totalCosts === "number" && r.totalCosts > 0, "and a cost total");
  assert.ok(r.costBreakdown && r.costBreakdown.spread >= 0, "and a cost breakdown");
  // The equity return is the NET result: the realised net P&L plus the open
  // positions marked to the last close. The small gap is the exit cost that
  // has not been paid yet.
  const expectedReturn = ((r.netPnl + r.unrealizedPnl) / r.initialEquity) * 100;
  assert.ok(Math.abs(r.totalReturnPct - expectedReturn) < 1.0,
    "the return must be the net one: " + r.totalReturnPct + " vs " + expectedReturn);
  assert.ok(typeof r.unrealizedPnl === "number", "the open positions must be marked");
  assert.ok(typeof r.equityChange === "number", "the equity change must be reported");
  // The per-trade records carry the full breakdown.
  const sells = r.tradeLog.filter(function(t) { return t.side === "SELL"; });
  assert.ok(sells.length > 0, "there must be closed round trips");
  for (const t of sells) {
    assert.ok(typeof t.grossPnl === "number", "each trade records a gross P&L");
    assert.ok(typeof t.netPnl === "number", "each trade records a net P&L");
    assert.ok(t.costs && typeof t.costs.total === "number", "each trade records its costs");
    assert.ok("costRatio" in t, "each trade records a cost ratio");
    assert.ok("spread" in t.costs, "each trade records the spread");
    assert.ok("commission" in t.costs, "each trade records the commission");
    assert.ok("tax" in t.costs, "each trade records the tax");
  }
});

test("the per-strategy classification separates the survivors from the killed", function() {
  const candles = makeCandles("AAPL", 120, 100, 0.25, 1.6, 19);
  const r = runBacktest(candles, BASE_OPTS);
  assert.ok(r.byStrategy && r.byStrategy.length > 0, "the result must classify the strategies");
  for (const s of r.byStrategy) {
    assert.ok(typeof s.grossPnl === "number" && typeof s.netPnl === "number", "gross and net per strategy");
    assert.ok(typeof s.survivesCosts === "boolean", "and a survival verdict");
    assert.ok(s.survivesCosts === (s.netPnl > 0), "the verdict must follow the net P&L");
  }
});

// ---------------------------------------------------------------------------
// 4. The cost sensitivity analysis
// ---------------------------------------------------------------------------
test("the cost sensitivity analysis is reproducible and ordered", function() {
  const candles = makeCandles("AAPL", 120, 100, 0.25, 1.6, 23);
  const a = runCostSensitivity(candles, BASE_OPTS);
  const b = runCostSensitivity(candles, BASE_OPTS);
  assert.deepStrictEqual(
    [a.runs.optimistic.netPnl, a.runs.base.netPnl, a.runs.pessimistic.netPnl],
    [b.runs.optimistic.netPnl, b.runs.base.netPnl, b.runs.pessimistic.netPnl],
    "the analysis must be reproducible");
  assert.ok(a.runs.optimistic.netPnl >= a.runs.base.netPnl,
    "the optimistic scenario cannot be worse than the base one");
  assert.ok(a.runs.base.netPnl >= a.runs.pessimistic.netPnl,
    "the base scenario cannot be worse than the pessimistic one");
  assert.ok(a.runs.pessimistic.totalCosts > a.runs.optimistic.totalCosts, "and the costs must order too");
  assert.ok(Array.isArray(a.survivors) && Array.isArray(a.killedByCosts), "the classification must be reported");
});

test("a strategy that only wins gross is reported as killed by the costs", function() {
  const candles = makeCandles("AAPL", 120, 100, 0.02, 0.6, 29);
  const sens = runCostSensitivity(candles, BASE_OPTS);
  const killed = sens.byStrategy.filter(function(s) { return !s.survivesCosts; });
  for (const s of killed) {
    if (s.grossPositive) {
      assert.ok(s.verdict.indexOf("gross") >= 0 || s.verdict.indexOf("killed") >= 0,
        "a gross-positive but net-negative strategy must say so: " + s.verdict);
    }
  }
});

// ---------------------------------------------------------------------------
// 5. The cost gate
// ---------------------------------------------------------------------------
test("the cost gate blocks a signal whose expected move cannot cover the cost", function() {
  const base = { lastClose: 100, atr14: 1.0 };  // 1.0% expected move
  const cost = roundTripCostPct("US", costProfile("base"));
  // A move of 0.1% cannot cover a 0.64% round trip.
  const tiny = costGate({ lastClose: 100, atr14: 0.1 }, costProfile("base"), "US");
  assert.strictEqual(tiny.ok, false, "a 0.1% move must be blocked");
  assert.ok(tiny.reason.indexOf("below") >= 0, "the reason must say why");
  // A move of 3% covers it comfortably.
  const big = costGate({ lastClose: 100, atr14: 3.0 }, costProfile("base"), "US");
  assert.strictEqual(big.ok, true, "a 3% move must pass");
  assert.ok(big.costPct > 0 && big.requiredPct > 0, "the gate must report the numbers");
  // A missing ATR leaves the gate open — refusing would stop every signal.
  const unknown = costGate({ lastClose: 100 }, costProfile("base"), "US");
  assert.strictEqual(unknown.ok, true, "without an ATR the gate cannot judge and must not block");
});

test("the signal engine refuses an entry whose expected move is below the cost", function() {
  const ctx = {
    lastClose: 100, sma5: 99, sma20: 98, changePct5d: 3, ema9: 99.5, ema21: 98,
    rsi14: 55, macd: { macdLine: 1, signal: 0.5, histogram: 0.4 },
    bollinger: { upper: 102, middle: 100, lower: 98 }, atr14: 0.1, vwap: 99.5,
  };
  const blocked = generateSignal(ctx, null, { market: "US" });
  assert.strictEqual(blocked.action, "HOLD", "an entry below the cost band must be blocked");
  assert.ok(blocked.reasons.join(" ").indexOf("cost gate") >= 0, "and the reason must say so");
  // The same signal with a real ATR passes.
  const wide = Object.assign({}, ctx, { atr14: 3 });
  const allowed = generateSignal(wide, null, { market: "US" });
  assert.notStrictEqual(allowed.action, "HOLD", "a signal with a real expected move must not be blocked by the cost gate");
});

test("the signal engine does not realise a gain smaller than the cost", function() {
  const position = { avgPrice: 100, qty: 10 };
  // A +0.3% move: above the stop, below the take, and below the cost band.
  const ctx = {
    lastClose: 100.3, sma5: 101, sma20: 100, changePct5d: -0.2, ema9: 100.2, ema21: 100.1,
    rsi14: 50, macd: { macdLine: 0, signal: 0.1, histogram: -0.1 },
    bollinger: { upper: 102, middle: 100, lower: 98 }, atr14: 1.5, vwap: 100.2,
  };
  const sig = generateSignal(ctx, position, { market: "US" });
  assert.notStrictEqual(sig.action, "SELL", "a sub-cost gain must not be realised");
});

test("the stop-loss always fires, whatever the cost", function() {
  const position = { avgPrice: 100, qty: 10 };
  const ctx = {
    lastClose: 90, sma5: 95, sma20: 96, changePct5d: -9, ema9: 94, ema21: 95,
    rsi14: 25, macd: { macdLine: -1, signal: 0, histogram: -1 },
    bollinger: { upper: 102, middle: 100, lower: 98 }, atr14: 2, vwap: 99,
  };
  const sig = generateSignal(ctx, position, { market: "US" });
  assert.strictEqual(sig.action, "SELL", "a risk control must never be blocked by the cost gate");
  assert.ok(sig.strategy === "risk_exit", "and it must be a risk exit");
});

// ---------------------------------------------------------------------------
// 6. The live P&L engine
// ---------------------------------------------------------------------------
test("the P&L engine measures the gross between the decision prices and books the execution cost", function() {
  const pnl = computeRoundTripPnl({
    symbol: "AAPL", market: "US",
    entryPrice: 100.1, exitPrice: 99.9,          // the fills
    signalEntryPrice: 100, signalExitPrice: 100.5, // the decision prices
    quantity: 10,
  });
  assert.ok(pnl.entrySlippage > 0, "the entry slippage must be booked");
  assert.ok(pnl.exitSlippage > 0, "the exit slippage must be booked");
  assert.ok(pnl.slippage > 0, "and reported");
  // The gross is the move between the decision prices: +0.5% of 1000 = +5.
  assert.ok(Math.abs(pnl.grossPnl - 5) < 0.01, "the gross must be the decision-price move: " + pnl.grossPnl);
  assert.ok(pnl.netPnl < pnl.grossPnl, "the net must be below the gross");
  assert.ok(pnl.spreadEstimate === 0, "the spread estimate is 0 when none was supplied");
});

test("the P&L engine can carry a spread estimate without charging it twice", function() {
  const withSpread = computeRoundTripPnl({
    symbol: "AAPL", market: "US", entryPrice: 100, exitPrice: 100.5, quantity: 10,
    spreadEstimate: 1.23,
  });
  const without = computeRoundTripPnl({
    symbol: "AAPL", market: "US", entryPrice: 100, exitPrice: 100.5, quantity: 10,
  });
  assert.strictEqual(withSpread.netPnl, without.netPnl,
    "the spread estimate is a diagnostic subset of the execution cost, not an extra charge");
  assert.strictEqual(withSpread.spreadEstimate, 1.23);
});

test("the FX move between entry and exit is visible in the trade P&L", function() {
  const same = computeRoundTripPnl({
    symbol: "AAPL", market: "US", entryPrice: 100, exitPrice: 101, quantity: 10,
    fxRateEntry: 1300, fxRateExit: 1300,
  });
  const moved = computeRoundTripPnl({
    symbol: "AAPL", market: "US", entryPrice: 100, exitPrice: 101, quantity: 10,
    fxRateEntry: 1300, fxRateExit: 1400,
  });
  assert.ok(moved.grossPnl > same.grossPnl, "a weaker currency must reduce the KRW gross");
  assert.ok(moved.netPnl > same.netPnl, "and the net");
});
