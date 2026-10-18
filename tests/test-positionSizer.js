"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { sizePosition, DEFAULTS } = require("../src/agent/positionSizer");

test("ATR sizing: volatile stock gets smaller position", () => {
  const noCap = { maxOrderValueKrw: 10_000_000 };
  const calm = sizePosition({ equity: 10_000_000, price: 50000, atr: 500 }, noCap);   // 1% ATR
  const wild = sizePosition({ equity: 10_000_000, price: 50000, atr: 3000 }, noCap);  // 6% ATR
  assert.ok(calm.qty > wild.qty);
  assert.equal(calm.method, "atr");
  // calm: risk 100k / (2*500) = 100 shares
  assert.equal(calm.qty, 100);
  assert.equal(calm.riskKrw, 100 * 2 * 500);
});

test("ATR sizing respects hard order cap", () => {
  const r = sizePosition({ equity: 100_000_000, price: 50000, atr: 500 }, { maxOrderValueKrw: 300000 });
  // ATR wants 1000 shares (50M) but cap is 300k -> 6 shares
  assert.equal(r.qty, 6);
  assert.ok(r.valueKrw <= 300000);
});

test("fallback to equity % when no ATR", () => {
  const r = sizePosition({ equity: 10_000_000, price: 50000, atr: null }, { maxOrderValueKrw: 10_000_000 });
  assert.equal(r.method, "equity_pct");
  // 4% of 10M = 400k / 50k = 8 shares
  assert.equal(r.qty, 8);
});

test("stop price set below entry by atrMultiple x ATR", () => {
  const r = sizePosition({ equity: 10_000_000, price: 50000, atr: 1000 });
  assert.equal(r.stopPrice, 48000); // 50000 - 2*1000
});

test("FX conversion for overseas symbols", () => {
  // $200 stock, ATR $5, FX 1400. Use high cap to isolate ATR math.
  const r = sizePosition({ equity: 10_000_000, price: 200, atr: 5, fxRate: 1400 }, { maxOrderValueKrw: 10_000_000 });
  // priceKrw = 280000, riskPerShareKrw = 14000, riskKrw = 100000 -> qty 7
  assert.equal(r.qty, 7);
  // Default cap (now 5M) no longer binds for 7 shares (1.96M); pass explicit 300k cap to verify capping
  const capped = sizePosition({ equity: 10_000_000, price: 200, atr: 5, fxRate: 1400 }, { maxOrderValueKrw: 300000 });
  assert.equal(capped.qty, 1);
  assert.ok(capped.valueKrw <= 300000);
});

test("invalid input returns qty 0", () => {
  assert.equal(sizePosition({ equity: 0, price: 50000, atr: 1000 }).qty, 0);
  assert.equal(sizePosition({ equity: 10_000_000, price: 0, atr: 1000 }).qty, 0);
});

test("single expensive share still within cap gets qty 1", () => {
  const r = sizePosition({ equity: 1_000_000, price: 250000, atr: 50000 }, { maxOrderValueKrw: 300000 });
  assert.equal(r.qty, 1);
  assert.equal(r.valueKrw, 250000);
});
