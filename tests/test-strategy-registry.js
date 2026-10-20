"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createStrategyRegistry } = require("../src/strategy/registry");
const { generateSignal } = require("../src/strategy/signals");

const baseCtx = {
  lastClose: 105000, sma5: 104000, sma20: 100000,
  ema9: 103500, ema21: 101000, vwap: 104500,
  rsi14: 55, changePct5d: 3.2,
  macd: { macdLine: 120, signal: 100, histogram: 20 },
  bollinger: { upper: 110000, middle: 104000, lower: 98000 },
  atr14: 1500,
};

test("register and list strategies", () => {
  const reg = createStrategyRegistry();
  reg.register({ name: "base", generateSignal });
  const list = reg.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "base");
  assert.equal(list[0].enabled, true);
});

test("duplicate registration throws", () => {
  const reg = createStrategyRegistry();
  reg.register({ name: "base", generateSignal });
  assert.throws(() => reg.register({ name: "base", generateSignal }), /already registered/);
});

test("invalid plugin throws", () => {
  const reg = createStrategyRegistry();
  assert.throws(() => reg.register({ name: "bad" }), /must have/);
  assert.throws(() => reg.register(null), /must have/);
});

test("generateAll returns signals from enabled strategies", () => {
  const reg = createStrategyRegistry();
  reg.register({ name: "base", generateSignal });
  const results = reg.generateAll(baseCtx, null);
  assert.equal(results.length, 1);
  assert.equal(results[0].name, "base");
  assert.ok(results[0].action);
});

test("disabled strategy excluded from generateAll", () => {
  const reg = createStrategyRegistry();
  reg.register({ name: "base", generateSignal });
  reg.disable("base");
  const results = reg.generateAll(baseCtx, null);
  assert.equal(results.length, 0);
});

test("consensus returns BUY when signal is strong", () => {
  const reg = createStrategyRegistry();
  reg.register({ name: "base", generateSignal });
  const result = reg.consensus(baseCtx, null);
  assert.equal(result.action, "BUY");
  assert.ok(result.sources.includes("base"));
});

test("consensus returns HOLD with no strategies", () => {
  const reg = createStrategyRegistry();
  const result = reg.consensus(baseCtx, null);
  assert.equal(result.action, "HOLD");
});

test("multiple strategies contribute to consensus", () => {
  const reg = createStrategyRegistry();
  reg.register({ name: "base", generateSignal });
  reg.register({
    name: "simple_momentum",
    generateSignal(ctx) {
      if (ctx.sma5 > ctx.sma20) return { action: "BUY", score: 3, reasons: ["sma cross"], strategy: "momentum" };
      return { action: "HOLD", score: 0, reasons: [], strategy: null };
    },
  });
  const result = reg.consensus(baseCtx, null);
  assert.equal(result.action, "BUY");
  assert.ok(result.sources.length === 2);
});

test("risk_exit takes priority in consensus", () => {
  const reg = createStrategyRegistry();
  reg.register({ name: "base", generateSignal });
  const pos = { avgPrice: 110000, qty: 10 }; // -4.5% triggers stop
  const result = reg.consensus(baseCtx, pos);
  assert.equal(result.action, "SELL");
  assert.equal(result.strategy, "risk_exit");
});

test("weights affect weighted score", () => {
  const reg = createStrategyRegistry({ weights: { base: 0.5 } });
  reg.register({ name: "base", generateSignal });
  const results = reg.generateAll(baseCtx, null);
  const rawScore = results[0].score;
  assert.ok(Math.abs(results[0].weightedScore - rawScore * 0.5) < 0.01);
});

test("unregister removes strategy", () => {
  const reg = createStrategyRegistry();
  reg.register({ name: "base", generateSignal });
  assert.equal(reg.list().length, 1);
  reg.unregister("base");
  assert.equal(reg.list().length, 0);
});
