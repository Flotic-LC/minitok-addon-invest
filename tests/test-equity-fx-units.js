"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { checkExposure } = require("../src/agent/exposure");
const { createRegimeHMM } = require("../src/strategy/regime-hmm");
const { createPortfolioRisk } = require("../src/risk/portfolio-risk");

// ---------------------------------------------------------------------------
// 1. Exposure layer must value positions in KRW.
//
// Before 2026-10-20 the layer computed `qty * price * (pos.fxRate || 1)`. The
// runner's portfolio positions carried no fxRate, so a USD position's dollar
// value was added as if it were KRW while orderKrw was real KRW. The result was
// an "invested" figure above 100% of equity, which blocked nearly every order.
// ---------------------------------------------------------------------------

const USD_KRW = 1330;

function usdBook() {
  return [
    { symbol: "MSFT", quantity: 15, currentPrice: 531.43, marketValue: 7971.45, currency: "USD" },
    { symbol: "META", quantity: 29, currentPrice: 694.8, marketValue: 20149.2, currency: "USD" },
    { symbol: "SPY", quantity: 11.04, currentPrice: 771.62, marketValue: 8521.16, currency: "USD" },
  ];
}

function withKrwValue(positions, fx) {
  return positions.map((p) => ({ ...p, fxRate: fx, valueKrw: p.marketValue * fx }));
}

test("exposure: a USD book without a KRW valuation never reports invested above 100% of equity", () => {
  const equity = 73_918_536;
  const positions = withKrwValue(usdBook(), USD_KRW);
  const res = checkExposure({ symbol: "AAPL", orderValueKrw: 1_000_000, equity, positions });
  assert.ok(res.exposures.investedPct < 100, "invested must stay below equity, got " + res.exposures.investedPct);
  // 36,641.81 USD * 1330 = 48,733,607 KRW of 73,918,536 KRW equity = 65.9%
  assert.equal(res.exposures.investedPct, 65.9);
});

test("exposure: the KRW valuation is used, not the raw marketValue", () => {
  const equity = 73_918_536;
  const positions = withKrwValue(usdBook(), USD_KRW);
  const res = checkExposure({ symbol: "AAPL", orderValueKrw: 0, equity, positions });
  // 48,733,607 / 73,918,536 = 65.9%. The old formula produced 0.05%
  // (dollars counted as KRW) and, once an order was added, 99.4%+ — the
  // mathematically impossible "invested 134.7% of equity" in the logs.
  assert.ok(res.exposures.investedPct > 60 && res.exposures.investedPct < 75,
    "invested should be the KRW valuation, got " + res.exposures.investedPct);
});

test("exposure: per-symbol and per-market exposure use the KRW valuation", () => {
  const equity = 73_918_536;
  const positions = withKrwValue(usdBook(), USD_KRW);
  const res = checkExposure({ symbol: "MSFT", orderValueKrw: 0, equity, positions });
  // MSFT alone is 7,971.45 USD * 1330 = 10,602,028 KRW = 14.3% of equity.
  assert.ok(res.exposures.symbolPct > 10 && res.exposures.symbolPct < 20,
    "symbol pct should be the KRW valuation, got " + res.exposures.symbolPct);
  assert.ok(res.exposures.marketPct > 60, "market pct should be the KRW valuation, got " + res.exposures.marketPct);
});

test("exposure: fxRate is used when the caller supplies no KRW valuation", () => {
  const equity = 73_918_536;
  const positions = usdBook().map((p) => ({ ...p, fxRate: USD_KRW }));
  const res = checkExposure({ symbol: "AAPL", orderValueKrw: 0, equity, positions });
  assert.ok(res.exposures.investedPct > 60 && res.exposures.investedPct < 75,
    "fxRate fallback should reproduce the KRW valuation, got " + res.exposures.investedPct);
});

test("exposure: a KRW book is unaffected by the valuation change", () => {
  const equity = 100_000_000;
  const positions = [{ symbol: "005930", quantity: 10, currentPrice: 210_000, marketValue: 2_100_000, currency: "KRW", fxRate: 1, valueKrw: 2_100_000 }];
  const res = checkExposure({ symbol: "000660", orderValueKrw: 1_000_000, equity, positions });
  assert.equal(res.exposures.investedPct, 2.1);
});

// ---------------------------------------------------------------------------
// 2. Regime HMM must survive a missing observation vector.
//
// The retrain path passed `null` into filterOnline, which threw
// "Cannot read properties of null (reading 'length')". Because the caller only
// advanced its timestamp after the call returned, the retrain loop re-ran
// (and re-failed) every 10 seconds and the regime model never came up.
// ---------------------------------------------------------------------------

test("regime-hmm: filterOnline with a null observation vector does not throw", () => {
  const hmm = createRegimeHMM({ seed: 1, nStates: 2 });
  const returns = Array.from({ length: 120 }, (_, i) => Math.sin(i / 7) * 0.01);
  const trained = hmm.train(returns);
  assert.ok(trained.ok, "training should succeed");
  const out = hmm.filterOnline(null);
  assert.equal(out.state, -1);
  assert.equal(out.label, "unknown");
});

test("regime-hmm: filterOnline with an empty observation vector does not throw", () => {
  const hmm = createRegimeHMM({ seed: 1, nStates: 2 });
  hmm.train(Array.from({ length: 120 }, (_, i) => Math.sin(i / 7) * 0.01));
  const out = hmm.filterOnline([]);
  assert.equal(out.state, -1);
});

test("regime-hmm: getPositionMultiplier without observations returns the neutral multiplier", () => {
  const hmm = createRegimeHMM({ seed: 1, nStates: 2 });
  hmm.train(Array.from({ length: 120 }, (_, i) => Math.sin(i / 7) * 0.01));
  assert.equal(hmm.getPositionMultiplier(), 1.0);
});

test("regime-hmm: getPositionMultiplier with observations still applies the regime multiplier", () => {
  const hmm = createRegimeHMM({ seed: 1, nStates: 2 });
  hmm.train(Array.from({ length: 120 }, (_, i) => Math.sin(i / 7) * 0.01));
  const mult = hmm.getPositionMultiplier([0.01, 0.02, 0.03]);
  assert.ok(mult > 0, "multiplier must be positive");
});

// ---------------------------------------------------------------------------
// 3. Portfolio VaR must be denominated in the same unit as the risk budget.
// ---------------------------------------------------------------------------

test("portfolio-risk: VaR values positions in KRW when the caller supplies valueKrw", () => {
  const risk = createPortfolioRisk();
  const positions = [
    { symbol: "MSFT", qty: 15, currentPrice: 531.43, marketValue: 7971.45, currency: "USD", valueKrw: 10_602_028 },
    { symbol: "SPY", qty: 11.04, currentPrice: 771.62, marketValue: 8521.16, currency: "USD", valueKrw: 11_333_143 },
  ];
  const out = risk.portfolioVaR(positions, risk.buildDiagonalCov([0.02, 0.02]));
  assert.ok(out.totalValue > 20_000_000, "total value should be KRW, got " + out.totalValue);
});

test("portfolio-risk: the risk budget is compared against a KRW-sized VaR", () => {
  const risk = createPortfolioRisk();
  const positions = [{ symbol: "MSFT", qty: 15, currentPrice: 531.43, currency: "USD", fxRate: USD_KRW }];
  const proposed = { symbol: "AAPL", qty: 10, currentPrice: 200, fxRate: USD_KRW };
  const out = risk.checkRiskBudget(positions, risk.buildDiagonalCov([0.02]), proposed, 73_918_536);
  assert.ok(out.budget > 0, "budget should be derived from the KRW equity");
  assert.ok(out.proposed.totalValue > 1_000_000, "proposed value should be KRW, got " + out.proposed.totalValue);
});
