"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createCouncil } = require("../src/council/council");

// ---------------------------------------------------------------------------
// Council hard limits — direction and currency.
//
// Before 2026-10-20 the total-exposure check treated a SELL as exposure
// neutral: it only ever ADDED the order value for a BUY, then compared the
// result with the cap. With the portfolio already above the cap the check
// therefore rejected the very SELL orders that bring it back under the limit,
// so the bot could not sell its way out of an over-exposed book.
//
// The checks also compared `decision.price * decision.quantity` — the
// LISTING currency (USD for US symbols) — against KRW-denominated limits.
// The runner now supplies ctx.orderValueKrw.
// ---------------------------------------------------------------------------

const EQUITY = 73_800_000;
const FX = 1330;

test("council: a SELL is not blocked by maxTotalExposurePct when the portfolio is over the cap", async () => {
  const council = createCouncil({ constitutionHardLimits: { maxTotalExposurePct: 85 } });
  const decision = {
    action: "SELL", symbol: "META", price: 694.8, quantity: 10,
    reason: "META is 36% of equity, well above the single-position limit; reduce concentration",
  };
  const ctx = {
    totalEquity: EQUITY, currentExposurePct: 87.2,
    orderValueKrw: Math.round(694.8 * 10 * FX),
    technicals: { rsi14: 30, macd: { histogram: -0.1 }, lastClose: 694.8 },
    regime: "neutral", intelligence: { vix: 18 },
  };
  const r = await council.evaluate(decision, ctx);
  assert.ok(!r.issues.some((i) => i.includes("Projected exposure")),
    "a SELL must not be rejected on projected exposure, got: " + JSON.stringify(r.issues));
});

test("council: a BUY is still blocked when the projected exposure exceeds the cap", async () => {
  const council = createCouncil({ constitutionHardLimits: { maxTotalExposurePct: 85 } });
  const decision = {
    action: "BUY", symbol: "MSFT", price: 531.43, quantity: 10,
    reason: "Momentum setup with positive MACD histogram and price above the moving average",
  };
  const ctx = {
    totalEquity: EQUITY, currentExposurePct: 84,
    orderValueKrw: Math.round(531.43 * 10 * FX),
    technicals: { rsi14: 50, macd: { histogram: 0.2 }, lastClose: 531.43 },
    regime: "neutral", intelligence: { vix: 18 },
  };
  const r = await council.evaluate(decision, ctx);
  assert.equal(r.constitutionViolation, true);
  assert.ok(r.issues.some((i) => i.includes("Projected exposure")));
});

test("council: the order value is measured in KRW, not in the listing currency", async () => {
  const council = createCouncil({ constitutionHardLimits: { maxSinglePositionPct: 15 } });
  // 100 shares at $531.43 = $53,143 — which in KRW is 70.7M, i.e. 96% of a
  // 73.8M equity portfolio and far above the 15% single-position limit.
  // Compared in dollars the same order looks like 0.07% and passes.
  const decision = {
    action: "BUY", symbol: "MSFT", price: 531.43, quantity: 100,
    reason: "Momentum setup with positive MACD histogram and price above the moving average",
  };
  const ctx = {
    totalEquity: EQUITY,
    orderValueKrw: Math.round(531.43 * 100 * FX),
    technicals: { rsi14: 50, macd: { histogram: 0.2 }, lastClose: 531.43 },
    regime: "neutral", intelligence: { vix: 18 },
  };
  const r = await council.evaluate(decision, ctx);
  assert.equal(r.constitutionViolation, true);
  assert.ok(r.issues.some((i) => i.includes("Position") && i.includes("exceeds hard limit")),
    "expected a position-size violation, got: " + JSON.stringify(r.issues));
});

test("council: a small order in KRW terms is not flagged", async () => {
  const council = createCouncil({ constitutionHardLimits: { maxSinglePositionPct: 15, maxSingleOrderKrw: 5_000_000 } });
  const decision = {
    action: "BUY", symbol: "MSFT", price: 531.43, quantity: 1,
    reason: "Momentum setup with positive MACD histogram and price above the moving average",
  };
  const ctx = {
    totalEquity: EQUITY,
    orderValueKrw: Math.round(531.43 * FX),
    technicals: { rsi14: 50, macd: { histogram: 0.2 }, lastClose: 531.43 },
    regime: "neutral", intelligence: { vix: 18 },
  };
  const r = await council.evaluate(decision, ctx);
  assert.ok(!r.issues.some((i) => i.includes("CONSTITUTION")),
    "a compliant order must not raise a constitution violation, got: " + JSON.stringify(r.issues));
});
