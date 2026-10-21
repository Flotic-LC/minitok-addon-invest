"use strict";

/**
 * Paper trading and live promotion tests.
 *
 * [2026-10-21 9단계] The properties that matter are pinned here:
 *
 *  - a deployment that is CAPABLE of live trading still trades paper until
 *    a promotion is on file;
 *  - a promotion needs every criterion, and a measurement that is missing
 *    is a failure, not a pass;
 *  - the ramp starts small;
 *  - a regression demotes the deployment, and the demotion has a reason.
 */

const test = require("node:test");
const assert = require("node:assert");
const promo = require("../src/ops/promotion");

test("a deployment without a promotion trades paper even when it is capable of live", function () {
  const m = promo.resolveTradingMode({ env: { DRY_RUN: "false" } });
  assert.strictEqual(m.capable, "live");
  assert.strictEqual(m.mode, "paper");
  assert.ok(/no promotion/.test(m.reason));
});

test("an explicit paper mode is paper whatever the environment says", function () {
  const m = promo.resolveTradingMode({ env: { TRADING_MODE: "paper", DRY_RUN: "false" } });
  assert.strictEqual(m.mode, "paper");
});

test("a signed promotion at stage 1 trades live with a small fraction of the capital", function () {
  const m = promo.resolveTradingMode({ env: { DRY_RUN: "false" }, promotion: { promoted: true, stage: 1 } });
  assert.strictEqual(m.mode, "ramped");
  assert.strictEqual(promo.capitalFraction(1), 0.05);
  assert.strictEqual(promo.capitalFraction(4), 1);
});

test("a promotion that has not been served yet stays in paper", function () {
  const m = promo.resolveTradingMode({ env: { DRY_RUN: "false" }, promotion: { promoted: true, stage: 0 } });
  assert.strictEqual(m.mode, "paper");
});

test("the paper fill records the expected price, the market price, the slippage and the net result", function () {
  const l = promo.createPaperLedger({ now: function () { return Date.parse("2026-10-21T15:00:00Z"); } });
  const t = l.record({
    symbol: "AAPL", side: "SELL", quantity: 10, expectedFillPrice: 100, marketPrice: 100,
    expectedSlippagePct: 0.1, costPct: 0.5, entryPrice: 95,
    signalTimestamp: Date.parse("2026-10-21T14:59:00Z"), executionTimestamp: Date.parse("2026-10-21T15:00:00Z"),
  });
  assert.strictEqual(t.mode, "paper");
  assert.strictEqual(t.expectedFillPrice, 100);
  assert.strictEqual(t.marketPrice, 100);
  assert.ok(Math.abs(t.realisedSlippagePct - 0.1) < 0.001, "a sell fills below the market price");
  assert.ok(t.netPnl < t.grossPnl, "the costs come out of the result");
  assert.ok(t.signalTimestamp < t.executionTimestamp);
  assert.ok(t.costRatio > 0);
});

test("the paper summary separates the expectancy after the costs", function () {
  const l = promo.createPaperLedger({ now: function () { return Date.parse("2026-10-25T00:00:00Z"); } });
  const day = 86400000;
  for (let i = 0; i < 20; i++) {
    l.record({ symbol: "AAPL", side: "BUY", quantity: 10, expectedFillPrice: 100, marketPrice: 100, expectedSlippagePct: 0.05, costPct: 0.5, signalTimestamp: Date.parse("2026-10-21T00:00:00Z") + i * day });
    l.record({ symbol: "AAPL", side: "SELL", quantity: 10, expectedFillPrice: 101, marketPrice: 101, expectedSlippagePct: 0.05, costPct: 0.5, entryPrice: 100, signalTimestamp: Date.parse("2026-10-21T01:00:00Z") + i * day });
  }
  const s = l.summary({ now: Date.parse("2026-10-25T00:00:00Z") });
  assert.strictEqual(s.closedTrades, 20);
  assert.strictEqual(s.trades, 40);
  assert.ok(s.days >= 4);
  assert.ok(s.expectancy < 0, "a flat market with costs has a negative expectancy");
  assert.ok(s.totalCost > 0);
});

test("a promotion needs every criterion, and a missing measurement is a failure", function () {
  const good = {
    days: 20, closedTrades: 40, expectancy: 0.5, maxDrawdownPct: 5,
    outOfSample: { expectancy: 0.3 }, brokerErrorRate: 0.01, duplicateOrders: 0,
    reconciliationOk: true, killSwitchTestPassed: true,
  };
  const p = promo.evaluatePromotion(good, {});
  assert.strictEqual(p.promoted, true);

  const noOos = Object.assign({}, good, { outOfSample: null });
  assert.strictEqual(promo.evaluatePromotion(noOos, {}).promoted, false, "a missing out-of-sample measurement cannot promote");

  const negative = Object.assign({}, good, { expectancy: -0.1 });
  assert.strictEqual(promo.evaluatePromotion(negative, {}).promoted, false, "a negative expectancy after the costs cannot promote");

  const dupes = Object.assign({}, good, { duplicateOrders: 1 });
  assert.strictEqual(promo.evaluatePromotion(dupes, {}).promoted, false);

  const fewTrades = Object.assign({}, good, { closedTrades: 3 });
  assert.strictEqual(promo.evaluatePromotion(fewTrades, {}).promoted, false);

  const short = Object.assign({}, good, { days: 2 });
  assert.strictEqual(promo.evaluatePromotion(short, {}).promoted, false);
});

test("a regression demotes the deployment and says why", function () {
  const d = promo.evaluateDemotion({ maxDrawdownPct: 30, expectancy: -1, brokerErrorRate: 0.4, duplicateOrders: 2, reconciliationOk: false, dataErrorRate: 0.2 }, {});
  assert.strictEqual(d.demote, true);
  assert.ok(d.reasons.length >= 4);
  assert.ok(d.reasons.some(function (r) { return /drawdown/.test(r); }));
  assert.ok(d.reasons.some(function (r) { return /duplicate/.test(r); }));
  assert.ok(d.reasons.some(function (r) { return /reconcile/.test(r); }));
});

test("a healthy paper run is not demoted", function () {
  const d = promo.evaluateDemotion({ maxDrawdownPct: 3, expectancy: 0.4, brokerErrorRate: 0, duplicateOrders: 0, reconciliationOk: true, dataErrorRate: 0 }, {});
  assert.strictEqual(d.demote, false);
  assert.strictEqual(d.reasons.length, 0);
});

test("a promotion record is signed and a tampered one is refused", function () {
  const rec = promo.createPromotionRecord({ promoted: true, stage: 1, approver: "operator@example", reason: "the paper period passed" });
  const signed = promo.signPromotion(rec, "secret-key");
  assert.strictEqual(promo.verifyPromotion(signed, "secret-key"), true);
  assert.strictEqual(promo.verifyPromotion(signed, "another-key"), false);
  const tampered = Object.assign({}, signed, { stage: 4 });
  assert.strictEqual(promo.verifyPromotion(tampered, "secret-key"), false, "a tampered record must not verify");
});

test("the capital ramp never starts at the full capital", function () {
  assert.strictEqual(promo.capitalFraction(0), 0);
  assert.ok(promo.capitalFraction(1) < 0.2);
  assert.ok(promo.capitalFraction(2) < 0.5);
  assert.strictEqual(promo.capitalFraction(99), 1);
});
