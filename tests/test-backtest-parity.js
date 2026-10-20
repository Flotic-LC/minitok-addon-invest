"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { decide } = require("../backtest");
const { generateSignal } = require("../src/strategy/signals");

function uptrendCloses(n = 30) {
  // Gentle uptrend: ~0.15%/day -> 5d change ~0.75% (positive, not overheated)
  const out = [];
  let p = 100000;
  for (let i = 0; i < n; i++) { p *= 1.0015; out.push(Math.round(p)); }
  return out;
}

test("backtest decide uses shared signal engine (parity)", () => {
  const closes = uptrendCloses(30);
  const portfolio = { positions: new Map() };
  const d = decide(closes, portfolio, "005930", { stopLoss: -2, takeProfit: 5 });

  // Same decision via direct signal call with equivalent ctx
  const last = closes[closes.length - 1];
  const sma5 = closes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const sma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const chg = ((last - closes[closes.length - 6]) / closes[closes.length - 6]) * 100;
  const macd = { macdLine: 10, signal: 5, histogram: 5 }; // bullish
  const s = generateSignal({ lastClose: last, sma5, sma20, changePct5d: chg, macd }, null, { stopLossPct: -2, takeProfitPct: 5 });

  // [P1-FITNESS] backtest now provides full indicator set (ema, rsi, macd, bollinger, atr, vwap)
  // so decide() should produce the same BUY as the direct signal engine.
  assert.equal(d.action, "BUY");
  assert.equal(s.action, "BUY");  // with MACD, full momentum signal fires
  assert.ok(s.score >= 2);
});

test("backtest decide exits at stop-loss like signal engine", () => {
  const closes = uptrendCloses(30);
  const portfolio = { positions: new Map([["005930", { qty: 2, avgPrice: closes[closes.length - 1] * 1.05 }]]) };
  const d = decide(closes, portfolio, "005930", { stopLoss: -2, takeProfit: 5 });
  assert.equal(d.action, "SELL");
  assert.ok(d.reason.includes("stop-loss"));
});

test("module still exports legacy helpers", () => {
  const { sma, changePct, runBacktest, parseArgs } = require("../backtest");
  assert.equal(typeof sma, "function");
  assert.equal(typeof changePct, "function");
  assert.equal(typeof runBacktest, "function");
});
