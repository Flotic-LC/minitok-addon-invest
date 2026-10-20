"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createDailyPlan, gateIntradaySignal, reviewDay } = require("../src/strategy/planner");

const bullCtx = {
  lastClose: 105000, sma5: 104000, sma20: 100000,
  ema9: 103500, ema21: 101000, rsi14: 55, changePct5d: 3,
  macd: { macdLine: 120, signal: 100, histogram: 20 },
};
const flatCtx = { lastClose: 100000, sma5: 100000, sma20: 100000, rsi14: 50, changePct5d: 0 };

test("daily plan ranks entry candidates and planned exits", () => {
  const universe = [
    { symbol: "005930", ctx: bullCtx },
    { symbol: "000660", ctx: flatCtx },
    { symbol: "AAPL", ctx: { lastClose: 180 } },
  ];
  const positions = [{ symbol: "AAPL", quantity: 5, avgPrice: 200 }]; // -10% -> stop exit
  const plan = createDailyPlan(universe, positions);
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.entries[0].symbol, "005930");
  assert.equal(plan.exits.length, 1);
  assert.equal(plan.exits[0].symbol, "AAPL");
  assert.ok(plan.summary.includes("1 entry"));
});

test("intraday gate allows plan-aligned and risk exits, blocks weak off-plan", () => {
  const plan = { date: "2026-01-05", entries: [{ symbol: "005930", score: 3 }], exits: [] };
  // Plan-aligned entry passes
  const aligned = gateIntradaySignal("005930", { action: "BUY", score: 3, strategy: "momentum" }, plan);
  assert.equal(aligned.pass, true);
  // Risk exit always passes
  const risk = gateIntradaySignal("XXXX", { action: "SELL", score: 10, strategy: "risk_exit" }, plan);
  assert.equal(risk.pass, true);
  // Off-plan low conviction blocked
  const weak = gateIntradaySignal("AAPL", { action: "BUY", score: 2, strategy: "momentum" }, plan);
  assert.equal(weak.pass, false);
  // Off-plan high conviction passes
  const strong = gateIntradaySignal("AAPL", { action: "BUY", score: 4, strategy: "momentum" }, plan);
  assert.equal(strong.pass, true);
});

test("daily review computes adherence and P&L", () => {
  const plan = { date: "2026-01-05", entries: [{ symbol: "005930" }], exits: [{ symbol: "AAPL" }] };
  const fills = [
    { symbol: "005930", side: "BUY" },
    { symbol: "005930", side: "SELL", pnl: 50000 },
    { symbol: "TSLA", side: "SELL", pnl: -10000 }, // off-plan
  ];
  const r = reviewDay(plan, fills);
  assert.equal(r.plannedTrades, 2);
  assert.equal(r.offPlanTrades, 1);
  assert.equal(r.adherencePct, 67);
  assert.equal(r.wins, 1);
  assert.equal(r.losses, 1);
  assert.equal(r.totalPnl, 40000);
});
