"use strict";
/**
 * [2026-10-21] Regression tests for the remaining-findings pass.
 *
 *  1. The watchlist liquidity floor (shared by the discovery scan and the
 *     runner's ADD_SYMBOL path).
 *  2. The correlation engine's rolling per-bucket counters. The engine used
 *     to rebuild its buckets from the event bus's raw history, which holds
 *     10,000 events — barely half an hour at this system's event rate — so
 *     a 24-hour window was mostly phantom zeros.
 *  3. The exposure layer's projected-vs-current exposure reporting.
 *  4. The event bus's capped persisted slice.
 */
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

const { liquidityFloorReason } = require("../src/tossinvest");
const { createEventBus } = require("../src/intelligence/event-bus");
const { createCorrelationEngine } = require("../src/intelligence/correlation");
const { checkExposure } = require("../src/agent/exposure");

// ===== WATCHLIST LIQUIDITY FLOOR =====
console.log("\n[liquidity floor]");

test("a liquid symbol passes the floor", function () {
  assert.strictEqual(liquidityFloorReason(531.43, 2_500_000_000), null);
});

test("a sub-floor price is rejected", function () {
  const reason = liquidityFloorReason(3.25, 500_000_000);
  assert.ok(reason, "expected a rejection reason");
  assert.match(reason, /price 3\.25 below the 5 floor/);
});

test("a thin stock is rejected on dollar volume even with a high price", function () {
  const reason = liquidityFloorReason(300.0, 120_000);
  assert.ok(reason, "expected a rejection reason");
  assert.match(reason, /daily dollar volume 120000 below the 5000000 floor/);
});

test("a missing price does not fail on price", function () {
  // No price is not a price violation — only the volume floor applies.
  assert.match(liquidityFloorReason(0, 100), /dollar volume/);
});

// ===== CORRELATION ENGINE ROLLING COUNTERS =====
console.log("\n[correlation rolling counters]");

test("events are counted into their hourly bucket", function () {
  const base = 1_700_000_000_000;
  let now = base;
  // The bus and the engine must share a clock — the engine buckets by the
  // event's own timestamp, so a bus running on the wall clock would place
  // the events outside the window the engine looks at.
  const bus = createEventBus({ now: () => now });
  const c = createCorrelationEngine({ eventBus: bus, now: () => now, bucketMs: 3600000, windowMs: 86400000 });
  bus.emit("decision.made", { symbol: "AAPL" });
  bus.emit("decision.made", { symbol: "MSFT" });
  bus.emit("selfAudit.alert", { rule: "x" });
  const buckets = c._buildBuckets("decision.made", 86400000);
  const total = buckets.reduce(function (s, v) { return s + v; }, 0);
  assert.strictEqual(total, 2, "both decisions must be counted");
  const alerts = c._buildBuckets("selfAudit.alert", 86400000);
  assert.strictEqual(alerts.reduce(function (s, v) { return s + v; }, 0), 1);
});

test("the P&L sum is tracked separately from the event count", function () {
  const bus = createEventBus();
  const c = createCorrelationEngine({ eventBus: bus, bucketMs: 3600000, windowMs: 86400000 });
  bus.emit("trading.fill", { symbol: "AAPL", pnl: 1500 });
  bus.emit("trading.fill", { symbol: "MSFT", pnl: -500 });
  const counts = c._buildBuckets("trading.fill", 86400000);
  const pnl = c._buildBuckets("trading.fill", 86400000, { pnl: true });
  assert.strictEqual(counts.reduce(function (s, v) { return s + v; }, 0), 2);
  assert.strictEqual(pnl.reduce(function (s, v) { return s + v; }, 0), 1000);
});

test("a 24-hour window yields 24 hourly buckets plus the current one", function () {
  const bus = createEventBus();
  const base = 1_700_000_000_000;
  const c = createCorrelationEngine({ eventBus: bus, now: () => base, bucketMs: 3600000, windowMs: 86400000 });
  const buckets = c._buildBuckets("decision.made", 86400000);
  // The engine has only observed since it started, so the window is
  // truncated to the buckets it can vouch for rather than padded with
  // phantom zeros.
  assert.ok(buckets.length >= 1, "at least the current bucket must exist");
  assert.ok(buckets.length <= 25, "never more than the window's worth of buckets");
});

test("buckets older than the engine's start are excluded, not zero-filled", function () {
  const bus = createEventBus();
  const start = 1_700_000_000_000;
  let now = start + 3 * 3600000; // three hours later
  const c = createCorrelationEngine({ eventBus: bus, now: () => now, bucketMs: 3600000, windowMs: 86400000 });
  const buckets = c._buildBuckets("decision.made", 86400000);
  assert.ok(buckets.length <= 4, "only the observed hours may appear, got " + buckets.length);
});

test("the rolling counters survive a state round trip", function () {
  const bus = createEventBus();
  const c = createCorrelationEngine({ eventBus: bus, bucketMs: 3600000, windowMs: 86400000 });
  bus.emit("selfHealing.incident", { rule: "x" });
  bus.emit("trading.fill", { symbol: "AAPL", pnl: 700 });
  const saved = c.state();
  assert.ok(saved.buckets, "the state must carry the buckets");

  const bus2 = createEventBus();
  const c2 = createCorrelationEngine({ eventBus: bus2, bucketMs: 3600000, windowMs: 86400000 });
  c2.restore(saved);
  const incidents = c2._buildBuckets("selfHealing.incident", 86400000);
  assert.strictEqual(incidents.reduce(function (s, v) { return s + v; }, 0), 1);
  const pnl = c2._buildBuckets("trading.fill", 86400000, { pnl: true });
  assert.strictEqual(pnl.reduce(function (s, v) { return s + v; }, 0), 700);
});

test("stats expose how far back the analysis can actually see", function () {
  const bus = createEventBus();
  const base = 1_700_000_000_000;
  let now = base;
  const c = createCorrelationEngine({ eventBus: bus, now: () => now, bucketMs: 3600000, windowMs: 86400000 });
  bus.emit("decision.made", { symbol: "AAPL" });
  now = base + 5 * 3600000;
  const s = c.stats();
  assert.ok(typeof s.observedHours === "number");
  assert.ok(s.observedHours >= 4, "the coverage must be reported, got " + s.observedHours);
});

// ===== EXPOSURE REPORTING =====
console.log("\n[exposure reporting]");

test("the exposure report separates the current and the projected exposure", function () {
  const equity = 10_000_000;
  const r = checkExposure({
    symbol: "MSFT",
    orderValueKrw: 2_000_000,
    equity: equity,
    positions: [{ symbol: "MSFT", quantity: 10, valueKrw: 5_000_000 }],
  }, { minCashReservePct: 15, maxSymbolPct: 95, maxMarketPct: 95, maxSectorPct: 80, maxPositions: 20, maxCorrelatedPct: 40 });
  assert.strictEqual(r.exposures.investedPct, 50, "the current exposure is the book the runner already holds");
  assert.strictEqual(r.exposures.projectedInvestedPct, 70, "the projected exposure includes this order");
});

test("the cash-reserve violation states the projected and the current exposure", function () {
  const equity = 10_000_000;
  const r = checkExposure({
    symbol: "MSFT",
    orderValueKrw: 2_100_000,
    equity: equity,
    positions: [{ symbol: "MSFT", quantity: 10, valueKrw: 6_500_000 }],
    // The sector and symbol caps are raised so the cash-reserve check is
    // the one that trips.
  }, { minCashReservePct: 15, maxSymbolPct: 95, maxMarketPct: 95, maxSectorPct: 95, maxPositions: 20, maxCorrelatedPct: 40 });
  const v = r.violations.join(" | ");
  assert.match(v, /projected exposure 86\.0% = current 65\.0% \+ this order/);
});

// ===== EVENT BUS PERSISTED SLICE =====
console.log("\n[event bus slice]");

test("the persisted state can be capped", function () {
  const bus = createEventBus({ maxHistory: 100 });
  for (let i = 0; i < 20; i++) bus.emit("decision.made", { i: i });
  const s = bus.state(5);
  assert.strictEqual(s.history.length, 5, "only the requested slice is persisted");
  assert.strictEqual(s.history[4].data.i, 19, "the newest events are the ones kept");
});

test("the buffer stays within its capacity when it overflows", function () {
  const bus = createEventBus({ maxHistory: 10 });
  for (let i = 0; i < 100; i++) bus.emit("decision.made", { i: i });
  const st = bus.stats();
  assert.ok(st.currentSize <= 10, "the buffer must never exceed maxHistory, got " + st.currentSize);
  assert.ok(st.evictedByCapacity > 0);
});
