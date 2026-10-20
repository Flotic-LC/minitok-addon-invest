"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { detectMarket, resolveFees, computeRoundTripPnl, computeUnrealizedPnl, DEFAULT_FEES } = require("../src/agent/pnl");

test("detectMarket classifies symbols", () => {
  // A 6-digit symbol is still classified as "KR" so the execution path can
  // recognise and refuse it, even though the Korean market is not traded.
  assert.equal(detectMarket("005930"), "KR");
  assert.equal(detectMarket("7203"), "JP");
  assert.equal(detectMarket("AAPL"), "US");
  assert.equal(detectMarket("BRK.B"), "US");
});

test("resolveFees returns market defaults and honors overrides", () => {
  const jp = resolveFees("JP");
  assert.equal(jp.buyCommissionPct, DEFAULT_FEES.JP.buyCommissionPct);
  assert.equal(jp.sellTaxPct, DEFAULT_FEES.JP.sellTaxPct);
  const custom = resolveFees("JP", { sellTaxPct: 0.2 });
  assert.equal(custom.sellTaxPct, 0.2);
});

test("there is no Korean fee schedule any more", () => {
  assert.equal(DEFAULT_FEES.KR, undefined);
  // An unknown market falls back to the US schedule rather than a Korean one.
  assert.equal(resolveFees("KR").buyCommissionPct, DEFAULT_FEES.US.buyCommissionPct);
});

test("JP round-trip P&L includes commission and no local tax", () => {
  // Buy 10 @ 100,000, sell @ 110,000 (JPY, no FX given so the values are used as-is)
  const r = computeRoundTripPnl({ symbol: "7203", entryPrice: 100000, exitPrice: 110000, quantity: 10 });
  // gross = 100,000; buy value 1,000,000 (comm 0.05% = 500), sell value 1,100,000 (comm 550, no tax)
  assert.equal(r.grossPnl, 100000);
  assert.equal(r.buyCommission, 500);
  assert.equal(r.sellCommission, 550);
  assert.equal(r.sellTax, 0);
  assert.equal(r.totalCosts, 1050);
  assert.equal(r.netPnl, 98950);
  assert.ok(r.pnlPct > 0);
});

test("losing trade produces negative net P&L", () => {
  const r = computeRoundTripPnl({ symbol: "AAPL", entryPrice: 100000, exitPrice: 90000, quantity: 10 });
  assert.equal(r.grossPnl, -100000);
  assert.ok(r.netPnl < r.grossPnl); // costs make it worse
});

test("US trade applies FX rate and no meaningful tax", () => {
  const r = computeRoundTripPnl({ symbol: "AAPL", entryPrice: 100, exitPrice: 110, quantity: 10, fxRate: 1350 });
  // gross = (110-100)*10*1350 = 135,000 KRW
  assert.equal(r.grossPnl, 135000);
  assert.ok(r.buyCommission > 0);
  assert.ok(r.sellTax < r.sellCommission); // SEC fee tiny vs commission
});

test("invalid inputs return zeros safely", () => {
  const r = computeRoundTripPnl({ symbol: "AAPL", entryPrice: 0, exitPrice: 100, quantity: 10 });
  assert.equal(r.netPnl, 0);
  assert.equal(r.totalCosts, 0);
});

test("strategy field propagates through computeRoundTripPnl", () => {
  const r = computeRoundTripPnl({ symbol: "AAPL", entryPrice: 100000, exitPrice: 110000, quantity: 10, strategy: "momentum_v2" });
  assert.equal(r.strategy, "momentum_v2");
  // Without strategy, defaults to null
  const r2 = computeRoundTripPnl({ symbol: "AAPL", entryPrice: 100000, exitPrice: 110000, quantity: 10 });
  assert.equal(r2.strategy, null);
});

test("unrealized P&L uses currentPrice and includes exit costs", () => {
  const u = computeUnrealizedPnl({ symbol: "AAPL", entryPrice: 100000, currentPrice: 105000, quantity: 5 });
  assert.equal(u.grossPnl, 25000);
  assert.ok(u.netPnl < u.grossPnl);
});
