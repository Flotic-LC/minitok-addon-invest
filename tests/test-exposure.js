"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { checkExposure, marketOf } = require("../src/agent/exposure");

test("marketOf classifies KR/US correctly", () => {
  assert.equal(marketOf("005930"), "KR");
  assert.equal(marketOf("AAPL"), "US");
  assert.equal(marketOf("7203.T"), "OTHER");
});

test("blocks symbol concentration above limit", () => {
  const r = checkExposure({
    symbol: "005930", orderValueKrw: 1_000_000, equity: 5_000_000,
    positions: [{ symbol: "005930", qty: 10, avgPrice: 70000, currentPrice: 70000 }], // 700k already
  });
  // 700k + 1M = 1.7M / 5M = 34% > 15%
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.includes("005930")));
});

test("blocks market concentration", () => {
  const r = checkExposure({
    symbol: "AAPL", orderValueKrw: 500_000, equity: 1_800_000,
    positions: [{ symbol: "MSFT", qty: 2, avgPrice: 300, currentPrice: 300, fxRate: 1400 }], // 840k US
  });
  // 840k + 500k = 1.34M / 1.8M = 74% > 70%
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.includes("market US")));
});

test("blocks too many open positions", () => {
  const positions = Array.from({ length: 12 }, (_, i) => ({ symbol: "SYM" + i, qty: 1, avgPrice: 1000 }));
  const r = checkExposure({ symbol: "NEW", orderValueKrw: 10_000, equity: 10_000_000, positions });
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.includes("12 open positions")));
});

test("allows adding to existing symbol even at max count", () => {
  const positions = Array.from({ length: 8 }, (_, i) => ({ symbol: "SYM" + i, qty: 1, avgPrice: 1000 }));
  const r = checkExposure({ symbol: "SYM0", orderValueKrw: 10_000, equity: 10_000_000, positions });
  assert.equal(r.ok, true); // SYM0 already held, not a new position
});

test("correlated strategy exposure blocks", () => {
  const r = checkExposure({
    symbol: "NVDA", orderValueKrw: 300_000, equity: 2_000_000, strategy: "momentum",
    positions: [{ symbol: "AAPL", qty: 2, avgPrice: 100, currentPrice: 100, fxRate: 1400, strategy: "momentum" }], // 280k momentum
  });
  // 280k + 300k = 580k / 2M = 29% > 25%
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.includes("strategy momentum")));
});

test("healthy portfolio passes", () => {
  const r = checkExposure({
    symbol: "035420", orderValueKrw: 200_000, equity: 10_000_000,
    positions: [{ symbol: "005930", qty: 2, avgPrice: 70000, currentPrice: 70000 }], // 140k = 1.4%
  });
  assert.equal(r.ok, true);
  assert.equal(r.violations.length, 0);
  assert.ok(r.exposures.investedPct < 5);
});
