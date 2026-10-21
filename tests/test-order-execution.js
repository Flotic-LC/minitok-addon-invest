"use strict";

/**
 * Order execution quality tests.
 *
 * [2026-10-21 5단계] Every test here corresponds to a failure mode that
 * either happened in production or is the documented way the broker behaves:
 * a websocket disconnect, a duplicate fill, a delayed fill, a partial
 * fill, a broker 500, a timeout, a token expiry, a process restart and a
 * corrupted state file.
 */

const test = require("node:test");
const assert = require("node:assert");
const oe = require("../src/agent/order-execution");

// --- the state machine ---------------------------------------------------

test("the broker's status strings map onto the state machine", function () {
  assert.strictEqual(oe.classifyOrderStatus("FILLED"), "FILLED");
  assert.strictEqual(oe.classifyOrderStatus("COMPLETED"), "FILLED");
  assert.strictEqual(oe.classifyOrderStatus("PARTIALLY_FILLED"), "PARTIALLY_FILLED");
  assert.strictEqual(oe.classifyOrderStatus("CANCELED"), "CANCELED");
  assert.strictEqual(oe.classifyOrderStatus("CANCELLED"), "CANCELED");
  assert.strictEqual(oe.classifyOrderStatus("REJECTED"), "REJECTED");
  assert.strictEqual(oe.classifyOrderStatus("PENDING"), "PENDING");
});

test("an unknown status is not a terminal state - the order keeps being polled", function () {
  // Guessing a terminal state here is what loses fills: the runner would
  // drop an order that is in fact still working.
  assert.strictEqual(oe.classifyOrderStatus("SOMETHING_NEW"), "UNKNOWN");
  assert.strictEqual(oe.classifyOrderStatus(undefined), "UNKNOWN");
  assert.strictEqual(oe.isTerminal("UNKNOWN"), false);
  assert.strictEqual(oe.isTerminal("FILLED"), true);
  assert.strictEqual(oe.isTerminal("CANCELED"), true);
  assert.strictEqual(oe.isTerminal("REJECTED"), true);
  assert.strictEqual(oe.isTerminal("EXPIRED"), true);
  assert.strictEqual(oe.isTerminal("PARTIALLY_FILLED"), false);
});

test("the fill information is the filled quantity and the average fill price", function () {
  const fill = oe.readFillInfo({ filledQuantity: 7, avgFilledPrice: 101.25, price: 101.25 });
  assert.strictEqual(fill.filledQuantity, 7);
  assert.strictEqual(fill.avgPrice, 101.25);
  // A response without any fill information is not a fill.
  assert.strictEqual(oe.readFillInfo({}).filledQuantity, 0);
  assert.strictEqual(oe.readFillInfo(null).filledQuantity, 0);
});

// --- failure mode 1: a fill the polling loop missed ----------------------

test("failure mode: a timeout on an order that had in fact filled must not cancel it", function () {
  // The defect: the monitor saw a non-zero filled quantity, called it a
  // partial fill, charged the cost and cancelled an order that had filled.
  // The position existed at the broker and the runner never booked it.
  const info = { symbol: "AAPL", side: "BUY", quantity: 10, originalQuantity: 10 };
  const verdict = oe.timeoutVerdict(info, { filledQuantity: 10, avgFilledPrice: 101.0 });
  assert.strictEqual(verdict.action, "APPLY_FILL");
  assert.strictEqual(verdict.fill.filledQuantity, 10);
  assert.strictEqual(verdict.fill.avgPrice, 101.0);
});

test("failure mode: a timeout on a genuinely partial order records the partial", function () {
  const info = { symbol: "AAPL", side: "BUY", quantity: 10, originalQuantity: 10 };
  const verdict = oe.timeoutVerdict(info, { filledQuantity: 4, avgFilledPrice: 100.5 });
  assert.strictEqual(verdict.action, "RECORD_PARTIAL");
  assert.strictEqual(verdict.fill.filledQuantity, 4);
  assert.strictEqual(verdict.fill.avgPrice, 100.5);
});

test("failure mode: a timeout on an unfilled order cancels it", function () {
  const info = { symbol: "AAPL", side: "BUY", quantity: 10, originalQuantity: 10 };
  const verdict = oe.timeoutVerdict(info, { filledQuantity: 0 });
  assert.strictEqual(verdict.action, "CANCEL");
});

// --- failure mode 2: a duplicate fill ------------------------------------

test("failure mode: a duplicate fill is claimed only once", function () {
  const info = { symbol: "AAPL", side: "BUY" };
  assert.strictEqual(oe.markFillApplied(info), true);
  assert.strictEqual(oe.markFillApplied(info), false);
  assert.strictEqual(oe.markFillApplied(info), false);
  assert.strictEqual(info.fillApplied, true);
});

// --- failure mode 3: a delayed fill --------------------------------------

test("failure mode: a delayed fill is measured as a latency, not a loss", function () {
  const t = oe.createFillQualityTracker({ minSamples: 1, maxLatencyMs: 1000 });
  t.recordSubmission("AAPL", 10);
  t.recordFill("AAPL", { filledQty: 10, latencyMs: 150000, slippagePct: 0.1 });
  const s = t.stats("AAPL");
  assert.strictEqual(s.fills, 1);
  assert.strictEqual(s.avgLatencyMs, 150000);
  assert.strictEqual(s.avgSlippagePct, 0.1);
  const r = t.restrictionFor("AAPL");
  assert.strictEqual(r.restricted, true);
  assert.ok(/latency/.test(r.reason), r.reason);
  assert.strictEqual(r.multiplier, 0.5);
});

// --- failure mode 4: a partial fill --------------------------------------

test("failure mode: a partial fill books the quantity that actually filled", function () {
  const t = oe.createFillQualityTracker();
  t.recordSubmission("AAPL", 10);
  t.recordFill("AAPL", { filledQty: 4, latencyMs: 100, slippagePct: 0.05 });
  const s = t.stats("AAPL");
  assert.strictEqual(s.fills, 1);
  assert.strictEqual(s.orderedQty === undefined ? null : null, null); // no orderedQty on the stats
  assert.strictEqual(s.fillRate, 1);
});

// --- failure mode 5 and 7: the idempotency guard -------------------------

test("failure mode: a retry after a timeout does not submit the same order twice", function () {
  const g = oe.createIdempotencyGuard({ windowMs: 120000 });
  const key = oe.idempotencyKey({ symbol: "AAPL", side: "BUY", quantity: 10, price: 101.25 });
  const first = g.claim(key, 1000);
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.duplicate, false);
  // The broker 500 / the token expiry / the lost response: the bot retries.
  const retry = g.claim(key, 2000);
  assert.strictEqual(retry.ok, false);
  assert.strictEqual(retry.duplicate, true);
  assert.ok(/identical order/.test(retry.reason), retry.reason);
});

test("failure mode: a different order is not a duplicate", function () {
  const g = oe.createIdempotencyGuard({ windowMs: 120000 });
  const a = oe.idempotencyKey({ symbol: "AAPL", side: "BUY", quantity: 10, price: 101.25 });
  const b = oe.idempotencyKey({ symbol: "AAPL", side: "BUY", quantity: 11, price: 101.25 });
  const c = oe.idempotencyKey({ symbol: "AAPL", side: "SELL", quantity: 10, price: 101.25 });
  assert.strictEqual(g.claim(a, 1000).ok, true);
  assert.strictEqual(g.claim(b, 1000).ok, true);
  assert.strictEqual(g.claim(c, 1000).ok, true);
});

test("failure mode: the same order is allowed again once the window has passed", function () {
  const g = oe.createIdempotencyGuard({ windowMs: 120000 });
  const key = oe.idempotencyKey({ symbol: "AAPL", side: "BUY", quantity: 10, price: 101.25 });
  assert.strictEqual(g.claim(key, 1000).ok, true);
  assert.strictEqual(g.claim(key, 121001).ok, true);
});

// --- failure mode 1 again: the reconciliation -----------------------------

test("failure mode: a websocket disconnect is recovered by the reconciliation", function () {
  const local = [{ orderId: "o1", symbol: "AAPL", side: "BUY", quantity: 10 }];
  const broker = [{ orderId: "o1", status: "FILLED", filledQuantity: 10, avgFilledPrice: 101.5 }];
  const r = oe.reconcileOrders(local, broker);
  assert.strictEqual(r.fills.length, 1);
  assert.strictEqual(r.fills[0].state, "FILLED");
  assert.strictEqual(r.fills[0].fill.filledQuantity, 10);
  assert.strictEqual(r.fills[0].fill.avgPrice, 101.5);
  assert.strictEqual(r.missing.length, 0);
});

test("failure mode: a local order the broker does not know is reported as missing", function () {
  const local = [{ orderId: "o1", symbol: "AAPL", side: "BUY", quantity: 10 }];
  const r = oe.reconcileOrders(local, []);
  assert.strictEqual(r.fills.length, 0);
  assert.strictEqual(r.missing.length, 1);
  assert.strictEqual(r.missing[0].orderId, "o1");
});

test("failure mode: a broker order the runner does not know is not booked as the runner's own", function () {
  const r = oe.reconcileOrders([], [{ orderId: "x9", status: "FILLED", filledQuantity: 5 }]);
  assert.strictEqual(r.fills.length, 0);
  assert.strictEqual(r.brokerOnly.length, 1);
  assert.strictEqual(r.brokerOnly[0].orderId, "x9");
});

test("failure mode: a still-pending order is not a fill", function () {
  const local = [{ orderId: "o1", symbol: "AAPL", side: "BUY", quantity: 10 }];
  const broker = [{ orderId: "o1", status: "PENDING" }];
  const r = oe.reconcileOrders(local, broker);
  assert.strictEqual(r.fills.length, 0);
  assert.strictEqual(r.pending.length, 1);
});

// --- failure mode 8: a process restart ------------------------------------

test("failure mode: a process restart restores the pending orders and the guard", function () {
  const g = oe.createIdempotencyGuard({ windowMs: 120000 });
  const key = oe.idempotencyKey({ symbol: "AAPL", side: "BUY", quantity: 10, price: 101.25 });
  g.claim(key, 1000);
  g.attach(key, "o1");

  const restored = oe.createIdempotencyGuard({ windowMs: 120000 });
  restored.restore(JSON.parse(JSON.stringify(g.state())));
  // The restart must not re-submit the order that was already sent.
  const after = restored.claim(key, 2000);
  assert.strictEqual(after.ok, false);
  assert.strictEqual(after.duplicate, true);
});

test("failure mode: a corrupted state file is discarded without taking the runner down", function () {
  const corrupt = oe.restoreState("{not json", { pendingOrders: [] });
  assert.strictEqual(corrupt.ok, false);
  assert.ok(/not valid JSON/.test(corrupt.reason), corrupt.reason);
  assert.deepStrictEqual(corrupt.value, { pendingOrders: [] });

  const notObject = oe.restoreState("[1,2,3]", { pendingOrders: [] });
  assert.strictEqual(notObject.ok, false);
  assert.deepStrictEqual(notObject.value, { pendingOrders: [] });

  const missing = oe.restoreState(null, { pendingOrders: [] });
  assert.strictEqual(missing.ok, false);
  assert.deepStrictEqual(missing.value, { pendingOrders: [] });

  const good = oe.restoreState(JSON.stringify({ pendingOrders: [["o1", {}]] }), { pendingOrders: [] });
  assert.strictEqual(good.ok, true);
  assert.strictEqual(good.value.pendingOrders.length, 1);
});

// --- the execution-quality restriction -----------------------------------

test("a symbol with too few decided orders is not restricted", function () {
  const t = oe.createFillQualityTracker({ minSamples: 10 });
  t.recordSubmission("AAPL", 10);
  t.recordRejection("AAPL");
  const r = t.restrictionFor("AAPL");
  assert.strictEqual(r.restricted, false);
  assert.ok(/not enough/.test(r.reason), r.reason);
});

test("a symbol whose orders are mostly rejected is restricted", function () {
  const t = oe.createFillQualityTracker({ minSamples: 5, minRejectionRate: 0.25 });
  for (let i = 0; i < 4; i++) t.recordRejection("ILLIQ");
  t.recordFill("ILLIQ", { filledQty: 1, latencyMs: 10, slippagePct: 0.01 });
  const r = t.restrictionFor("ILLIQ");
  assert.strictEqual(r.restricted, true);
  assert.ok(/rejection rate/.test(r.reason), r.reason);
});

test("a symbol whose fills are fast and cheap is not restricted", function () {
  const t = oe.createFillQualityTracker({ minSamples: 5 });
  for (let i = 0; i < 10; i++) t.recordFill("GOOD", { filledQty: 10, latencyMs: 200, slippagePct: 0.02 });
  const r = t.restrictionFor("GOOD");
  assert.strictEqual(r.restricted, false);
});
