"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { generateSignal, DEFAULT_PARAMS } = require("../src/strategy/signals");

const baseCtx = {
  lastClose: 105000, sma5: 104000, sma20: 100000,
  ema9: 103500, ema21: 101000, vwap: 104500,
  rsi14: 55, changePct5d: 3.2,
  macd: { macdLine: 120, signal: 100, histogram: 20 },
  bollinger: { upper: 110000, middle: 104000, lower: 98000 },
  atr14: 1500,
};

test("strong uptrend produces BUY with momentum strategy", () => {
  const s = generateSignal(baseCtx, null);
  assert.equal(s.action, "BUY");
  assert.equal(s.strategy, "momentum");
  assert.ok(s.score >= DEFAULT_PARAMS.minScore);
  assert.ok(s.reasons.length >= 2);
});

test("overbought RSI penalizes score into HOLD", () => {
  const ctx = { ...baseCtx, rsi14: 78 };
  const s = generateSignal(ctx, null);
  // score = 5 (trend evidences) - 2 (overbought) = 3, still >= 2 -> BUY but weaker
  assert.ok(s.score < 5);
});

test("no data returns safe HOLD", () => {
  const s = generateSignal({}, null);
  assert.equal(s.action, "HOLD");
  assert.equal(s.score, 0);
});

test("weak evidence below minScore returns HOLD", () => {
  const ctx = { lastClose: 100000, sma5: 100000, sma20: 100000, rsi14: 50, changePct5d: -1 };
  const s = generateSignal(ctx, null);
  assert.equal(s.action, "HOLD");
});

test("position stop-loss triggers SELL", () => {
  const pos = { avgPrice: 110000, qty: 10 };
  // lastClose 105000 -> -4.5% < -2% stop
  const s = generateSignal(baseCtx, pos);
  assert.equal(s.action, "SELL");
  assert.equal(s.strategy, "risk_exit");
});

test("position take-profit triggers SELL", () => {
  // [Tier 2] default takeProfitPct = 12%, so use avgPrice that yields >12% return.
  // 105000/92000 -> +14.13% >= 12%
  const pos = { avgPrice: 92000, qty: 10 };
  const s = generateSignal(baseCtx, pos);
  assert.equal(s.action, "SELL");
  assert.ok(s.reasons.some((r) => r.includes("take-profit")));
});

test("position near take-profit threshold stays HOLD", () => {
  // [Tier 2] +6% is NOT enough to trigger take-profit (threshold is 12%)
  const pos = { avgPrice: 99000, qty: 10 };
  const s = generateSignal(baseCtx, pos);
  assert.notEqual(s.action, "SELL");
});

test("trend breakdown exits position even without stop hit", () => {
  const ctx = {
    ...baseCtx,
    lastClose: 103500, sma5: 104000, // price < sma5
    macd: { macdLine: 90, signal: 100, histogram: -10 },
    ema9: 100500, ema21: 101000, // ema9 < ema21
  };
  const pos = { avgPrice: 103000, qty: 5 }; // +0.49%, no stop/tp
  const s = generateSignal(ctx, pos);
  assert.equal(s.action, "SELL");
  assert.equal(s.strategy, "trend_exit");
});

test("mean-reversion BUY on oversold + lower band touch", () => {
  const ctx = {
    lastClose: 97500, sma5: 99000, sma20: 100000,
    rsi14: 25, changePct5d: -6,
    bollinger: { upper: 108000, middle: 102000, lower: 97600 },
    macd: { macdLine: -50, signal: -40, histogram: -10 },
  };
  const s = generateSignal(ctx, null);
  assert.equal(s.action, "BUY");
  assert.ok(s.strategy.includes("mean_reversion"));
});
