"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { computeDynamicRisk } = require("../src/strategy/dynamic-risk");

test("normal volatility returns baseline parameters", () => {
  const r = computeDynamicRisk({ portfolioAtrPct: 1.5, vixProxy: 18 });
  assert.equal(r.regime, "normal");
  assert.ok(r.positionMultiplier >= 0.9 && r.positionMultiplier <= 1.1);
  assert.ok(r.dynamicHardStopPct < 0 && r.dynamicHardStopPct >= -4);
});

test("low volatility increases position size", () => {
  const r = computeDynamicRisk({ portfolioAtrPct: 0.5, vixProxy: 12 });
  assert.equal(r.regime, "calm");
  assert.ok(r.positionMultiplier > 1.0);
});

test("high volatility reduces position size", () => {
  const r = computeDynamicRisk({ portfolioAtrPct: 4.0, vixProxy: 28 });
  assert.ok(r.regime.includes("turbulent") || r.regime.includes("elevated"));
  assert.ok(r.positionMultiplier < 1.0);
});

test("VIX panic triggers massive reduction", () => {
  const r = computeDynamicRisk({ portfolioAtrPct: 2.0, vixProxy: 40 });
  assert.equal(r.regime, "panic");
  assert.ok(r.positionMultiplier < 0.5);
});

test("dynamic hard-stop scales with ATR", () => {
  const calm = computeDynamicRisk({ portfolioAtrPct: 0.8 });
  const wild = computeDynamicRisk({ portfolioAtrPct: 5.0 });
  // wild should have tighter (more negative) stop
  assert.ok(wild.dynamicHardStopPct < calm.dynamicHardStopPct);
});

test("drawdown amplifies position reduction", () => {
  const noDd = computeDynamicRisk({ portfolioAtrPct: 2.0, recentDrawdownPct: 0 });
  const withDd = computeDynamicRisk({ portfolioAtrPct: 2.0, recentDrawdownPct: -5 });
  assert.ok(withDd.positionMultiplier < noDd.positionMultiplier);
});

test("trailing stop tightens in turbulence", () => {
  const calm = computeDynamicRisk({ portfolioAtrPct: 0.8 });
  const wild = computeDynamicRisk({ portfolioAtrPct: 4.0 });
  assert.ok(wild.trailingStopAdjust < calm.trailingStopAdjust);
});

test("multiplier clamped to [0.1, 2.0]", () => {
  const extreme = computeDynamicRisk({ portfolioAtrPct: 10.0, vixProxy: 50, recentDrawdownPct: -10 });
  assert.ok(extreme.positionMultiplier >= 0.1);
  assert.ok(extreme.positionMultiplier <= 2.0);
});

test("missing context uses safe defaults", () => {
  const r = computeDynamicRisk({});
  assert.ok(r.dynamicHardStopPct < 0);
  assert.ok(r.positionMultiplier > 0);
  assert.equal(r.regime, "normal");
});
