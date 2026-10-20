"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createVaREngine, zScore } = require("../src/risk/var-engine");

// --- zScore tests ---
test("zScore(0.95) returns ~1.645", () => {
  const z = zScore(0.95);
  assert.ok(Math.abs(z - 1.6449) < 0.01, "expected ~1.645, got " + z);
});

test("zScore(0.99) returns ~2.326", () => {
  const z = zScore(0.99);
  assert.ok(Math.abs(z - 2.3263) < 0.01, "expected ~2.326, got " + z);
});

test("zScore throws on boundary values", () => {
  assert.throws(() => zScore(0), RangeError);
  assert.throws(() => zScore(1), RangeError);
});

// --- Parametric VaR ---
test("parametric VaR returns positive loss for zero-mean returns", () => {
  const engine = createVaREngine({ confidence: 0.95 });
  // Returns with mean ~0, std ~0.02
  const returns = [];
  for (let i = 0; i < 252; i++) returns.push((Math.random() - 0.5) * 0.04);
  const result = engine.parametricVaR(returns);
  assert.ok(result.var > 0, "VaR should be positive loss");
  assert.equal(result.method, "parametric");
  assert.ok(result.std > 0);
});

test("parametric VaR handles insufficient data", () => {
  const engine = createVaREngine();
  const result = engine.parametricVaR([0.01]);
  assert.equal(result.var, 0);
  assert.equal(result.error, "insufficient data");
});

test("parametric VaR scales with holding period", () => {
  const engine = createVaREngine({ confidence: 0.95 });
  const returns = Array.from({ length: 100 }, () => (Math.random() - 0.5) * 0.04);
  const v1 = engine.parametricVaR(returns, 0.95, 1);
  const v10 = engine.parametricVaR(returns, 0.95, 10);
  assert.ok(v10.var > v1.var, "10-day VaR should exceed 1-day VaR");
});

test("higher confidence yields higher parametric VaR", () => {
  const engine = createVaREngine();
  const returns = Array.from({ length: 252 }, () => (Math.random() - 0.5) * 0.04);
  const v95 = engine.parametricVaR(returns, 0.95);
  const v99 = engine.parametricVaR(returns, 0.99);
  assert.ok(v99.var > v95.var, "99% VaR should exceed 95% VaR");
});

// --- Historical VaR ---
test("historical VaR returns empirical quantile", () => {
  const engine = createVaREngine({ confidence: 0.95 });
  const returns = Array.from({ length: 1000 }, (_, i) => (i - 500) / 5000); // -0.1 to +0.1
  const result = engine.historicalVaR(returns);
  assert.ok(result.var > 0, "historical VaR should be positive");
  assert.equal(result.method, "historical");
  assert.equal(result.sampleSize, 1000);
});

test("historical VaR handles insufficient data", () => {
  const engine = createVaREngine();
  const result = engine.historicalVaR([]);
  assert.equal(result.var, 0);
  assert.equal(result.error, "insufficient data");
});

// --- Monte Carlo VaR ---
test("monte carlo VaR produces reasonable results with seed", () => {
  const engine = createVaREngine({ mcSeed: 42, mcPaths: 5000, mcDays: 10 });
  const result = engine.monteCarloVaR({ drift: 0, vol: 0.02 });
  assert.ok(result.var > 0, "MC VaR should be positive");
  assert.ok(result.cvar >= result.var, "CVaR should be >= VaR");
  assert.equal(result.paths, 5000);
  assert.equal(result.method, "monte_carlo");
});

test("monte carlo VaR is reproducible with same seed", () => {
  const e1 = createVaREngine({ mcSeed: 123, mcPaths: 1000 });
  const e2 = createVaREngine({ mcSeed: 123, mcPaths: 1000 });
  const r1 = e1.monteCarloVaR({ drift: 0.0003, vol: 0.02, days: 5 });
  const r2 = e2.monteCarloVaR({ drift: 0.0003, vol: 0.02, days: 5 });
  assert.equal(r1.var, r2.var, "same seed should yield same VaR");
  assert.equal(r1.cvar, r2.cvar);
});

test("monte carlo higher vol produces higher VaR", () => {
  const engine = createVaREngine({ mcSeed: 42, mcPaths: 5000 });
  const low = engine.monteCarloVaR({ vol: 0.01, drift: 0 });
  const high = engine.monteCarloVaR({ vol: 0.04, drift: 0 });
  assert.ok(high.var > low.var, "higher vol should yield higher VaR");
});

// --- CVaR ---
test("CVaR exceeds VaR for historical returns", () => {
  const engine = createVaREngine({ confidence: 0.95 });
  const returns = Array.from({ length: 1000 }, () => (Math.random() - 0.5) * 0.06);
  const result = engine.cvar(returns);
  assert.ok(result.cvar >= result.var, "CVaR should be >= VaR");
  assert.ok(result.tailSize > 0);
  assert.equal(result.method, "historical_cvar");
});

test("CVaR handles insufficient data", () => {
  const engine = createVaREngine();
  const result = engine.cvar([0.01]);
  assert.equal(result.cvar, 0);
  assert.equal(result.error, "insufficient data");
});

// --- Full Report ---
test("fullReport returns all three methods", () => {
  const engine = createVaREngine({ confidence: 0.95 });
  const returns = Array.from({ length: 500 }, () => (Math.random() - 0.5) * 0.04);
  const report = engine.fullReport(returns);
  assert.ok(report.parametric);
  assert.ok(report.historical);
  assert.ok(report.cvar);
  assert.ok(report.summary);
  assert.equal(report.summary.confidence, 0.95);
  assert.ok(report.summary.parametricVaR > 0);
  assert.ok(report.summary.historicalVaR > 0);
  assert.ok(report.summary.cvar > 0);
});

// --- Config ---
test("engine exposes config", () => {
  const engine = createVaREngine({ confidence: 0.99, holdingDays: 5 });
  assert.equal(engine.config.confidence, 0.99);
  assert.equal(engine.config.holdingDays, 5);
});
