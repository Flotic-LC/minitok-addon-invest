"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createCrossMarketScanner,
  DEFAULTS,
} = require("../src/intelligence/cross-market");

// ============================================================================
// DEFAULTS
// ============================================================================
test("DEFAULTS: correct default values", () => {
  assert.equal(DEFAULTS.thresholdBps, 20);
  assert.equal(DEFAULTS.costBps, 10);
  assert.equal(DEFAULTS.scanIntervalMs, 60000);
  assert.equal(DEFAULTS.fetchTimeoutMs, 5000);
  assert.equal(DEFAULTS.maxHistorySize, 1000);
  assert.equal(DEFAULTS.baseCurrency, "USD");
});

// ============================================================================
// bps helper
// ============================================================================
test("bps: computes basis points correctly", () => {
  const { bps } = createCrossMarketScanner()._internals;
  // midpoint of 100 and 110 = 105; diff = 10; 10/105 = 9.5238% = 952.38 bps
  const result = bps(100, 110);
  assert.ok(Math.abs(result - 952.38) < 0.01);
});

test("bps: returns 0 for invalid inputs", () => {
  const { bps } = createCrossMarketScanner()._internals;
  assert.equal(bps(0, 100), 0);
  assert.equal(bps(100, 0), 0);
  assert.equal(bps(-1, 100), 0);
  assert.equal(bps(null, 100), 0);
});

test("bps: negative when b < a", () => {
  const { bps } = createCrossMarketScanner()._internals;
  const result = bps(110, 100);
  assert.ok(result < 0);
  assert.ok(Math.abs(result - (-952.38)) < 0.01);
});

// ============================================================================
// Pair management
// ============================================================================
test("registerPair: registers and lists pairs", () => {
  const scanner = createCrossMarketScanner();
  const res = scanner.registerPair({
    id: "p1",
    name: "Test Pair",
    assetA: { exchange: "KRX", symbol: "005930", currency: "KRW" },
    assetB: { exchange: "LSE", symbol: "SMSN", currency: "USD", adrRatio: 50 },
  });
  assert.equal(res.id, "p1");
  assert.equal(res.registered, true);
  const list = scanner.listPairs();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "p1");
  assert.equal(list[0].name, "Test Pair");
  assert.equal(list[0].active, true);
});

test("registerPair: throws on missing id", () => {
  const scanner = createCrossMarketScanner();
  assert.throws(
    () => scanner.registerPair({ assetA: { exchange: "X", symbol: "s", currency: "USD" }, assetB: { exchange: "Y", symbol: "s", currency: "USD" } }),
    /pair\.id required/
  );
});

test("registerPair: throws on missing assetA fields", () => {
  const scanner = createCrossMarketScanner();
  assert.throws(
    () => scanner.registerPair({ id: "x", assetA: { exchange: "X" }, assetB: { exchange: "Y", symbol: "s", currency: "USD" } }),
    /assetA requires/
  );
});

test("registerPair: throws on missing assetB fields", () => {
  const scanner = createCrossMarketScanner();
  assert.throws(
    () => scanner.registerPair({ id: "x", assetA: { exchange: "X", symbol: "s", currency: "USD" }, assetB: { exchange: "Y" } }),
    /assetB requires/
  );
});

test("removePair: removes registered pair", () => {
  const scanner = createCrossMarketScanner();
  scanner.registerPair({
    id: "p1",
    assetA: { exchange: "X", symbol: "s", currency: "USD" },
    assetB: { exchange: "Y", symbol: "s", currency: "USD" },
  });
  assert.equal(scanner.listPairs().length, 1);
  assert.equal(scanner.removePair("p1"), true);
  assert.equal(scanner.listPairs().length, 0);
  assert.equal(scanner.removePair("nonexistent"), false);
});

// ============================================================================
// scan — no pairs
// ============================================================================
test("scan: returns empty result when no pairs registered", async () => {
  const scanner = createCrossMarketScanner();
  const result = await scanner.scan();
  assert.equal(result.pairsScanned, 0);
  assert.deepEqual(result.opportunities, []);
  assert.deepEqual(result.results, []);
  assert.ok(result.scannedAt);
  assert.equal(scanner.stats().scans, 1);
});

// ============================================================================
// scan — opportunity detection (A_TO_B)
// ============================================================================
test("scan: detects A_TO_B opportunity when spread exceeds threshold", async () => {
  const scanner = createCrossMarketScanner({
    priceFeeds: {
      EX_A: async () => 100,
      EX_B: async () => 110,
    },
    fxProvider: async () => 1,
    config: { thresholdBps: 50, costBps: 5, fetchTimeoutMs: 1000 },
  });
  scanner.registerPair({
    id: "arb1",
    name: "Arb One",
    assetA: { exchange: "EX_A", symbol: "S", currency: "USD" },
    assetB: { exchange: "EX_B", symbol: "S", currency: "USD" },
  });
  const result = await scanner.scan();
  assert.equal(result.pairsScanned, 1);
  assert.equal(result.opportunities.length, 1);
  const opp = result.opportunities[0];
  assert.equal(opp.pairId, "arb1");
  assert.equal(opp.direction, "A_TO_B");
  assert.ok(opp.grossBps > 50);
  assert.ok(opp.netBps > 0);
  assert.equal(opp.opportunity, true);
  assert.equal(opp.prices.A.currency, "USD");
  assert.equal(opp.prices.B.currency, "USD");
});

// ============================================================================
// scan — opportunity detection (B_TO_A)
// ============================================================================
test("scan: detects B_TO_A opportunity when B is cheaper", async () => {
  const scanner = createCrossMarketScanner({
    priceFeeds: {
      EX_A: async () => 110,
      EX_B: async () => 100,
    },
    fxProvider: async () => 1,
    config: { thresholdBps: 50, costBps: 5, fetchTimeoutMs: 1000 },
  });
  scanner.registerPair({
    id: "arb2",
    assetA: { exchange: "EX_A", symbol: "S", currency: "USD" },
    assetB: { exchange: "EX_B", symbol: "S", currency: "USD" },
  });
  const result = await scanner.scan();
  assert.equal(result.opportunities.length, 1);
  assert.equal(result.opportunities[0].direction, "B_TO_A");
  assert.ok(result.opportunities[0].grossBps < -50);
});

// ============================================================================
// scan — no opportunity below threshold
// ============================================================================
test("scan: no opportunity when spread below threshold", async () => {
  const scanner = createCrossMarketScanner({
    priceFeeds: {
      EX_A: async () => 100,
      EX_B: async () => 100.2,
    },
    fxProvider: async () => 1,
    config: { thresholdBps: 50, costBps: 5, fetchTimeoutMs: 1000 },
  });
  scanner.registerPair({
    id: "tiny",
    assetA: { exchange: "EX_A", symbol: "S", currency: "USD" },
    assetB: { exchange: "EX_B", symbol: "S", currency: "USD" },
  });
  const result = await scanner.scan();
  assert.equal(result.opportunities.length, 0);
  assert.equal(result.results[0].direction, null);
  assert.equal(result.results[0].opportunity, false);
});

// ============================================================================
// FX normalization + ADR ratio
// ============================================================================
test("scan: normalizes prices via FX and ADR ratio", async () => {
  const scanner = createCrossMarketScanner({
    priceFeeds: {
      KRX: async () => 71000,
      LSE: async () => 1050,
    },
    fxProvider: async (pair) => {
      if (pair === "KRWUSD") return 0.00075;
      if (pair === "USDUSD") return 1;
      throw new Error("unknown fx pair: " + pair);
    },
    config: { thresholdBps: 50, costBps: 10, fetchTimeoutMs: 1000 },
  });
  scanner.registerPair({
    id: "samsung_gdr",
    name: "Samsung GDR",
    assetA: { exchange: "KRX", symbol: "005930", currency: "KRW", adrRatio: 50 },
    assetB: { exchange: "LSE", symbol: "SMSN", currency: "USD" },
  });
  const result = await scanner.scan();
  assert.equal(result.pairsScanned, 1);
  const r = result.results[0];
  assert.equal(r.prices.A.fx, 0.00075);
  assert.equal(r.prices.A.raw, 71000);
  assert.ok(Math.abs(r.prices.A.normalized - 2662.5) < 0.01);
  assert.equal(r.prices.B.fx, 1);
  assert.equal(r.prices.B.raw, 1050);
  assert.equal(r.opportunity, true);
});


// ============================================================================
// Error isolation
// ============================================================================
test("scan: isolates errors per pair", async () => {
  const errors = [];
  const scanner = createCrossMarketScanner({
    priceFeeds: {
      GOOD_A: async () => 100,
      GOOD_B: async () => 120,
      BAD: async () => { throw new Error("feed down"); },
    },
    fxProvider: async () => 1,
    config: { thresholdBps: 50, costBps: 5, fetchTimeoutMs: 1000 },
    onError: (pairId, err) => errors.push({ pairId, msg: err.message }),
  });
  scanner.registerPair({
    id: "good",
    assetA: { exchange: "GOOD_A", symbol: "S", currency: "USD" },
    assetB: { exchange: "GOOD_B", symbol: "S", currency: "USD" },
  });
  scanner.registerPair({
    id: "bad",
    assetA: { exchange: "BAD", symbol: "S", currency: "USD" },
    assetB: { exchange: "GOOD_B", symbol: "S", currency: "USD" },
  });
  const result = await scanner.scan();
  assert.equal(result.pairsScanned, 2);
  assert.equal(result.opportunities.length, 1);
  assert.equal(result.opportunities[0].pairId, "good");
  const badResult = result.results.find((r) => r.pairId === "bad");
  assert.ok(badResult.error);
  assert.equal(badResult.opportunity, false);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].pairId, "bad");
  assert.match(errors[0].msg, /feed down/);
  assert.equal(scanner.stats().errors, 1);
});

// ============================================================================
// Timeout handling
// ============================================================================
test("scan: handles price fetch timeout", async () => {
  const scanner = createCrossMarketScanner({
    priceFeeds: {
      SLOW: async () => new Promise((resolve) => setTimeout(() => resolve(100), 5000)),
      FAST: async () => 100,
    },
    fxProvider: async () => 1,
    config: { thresholdBps: 50, costBps: 5, fetchTimeoutMs: 50 },
  });
  scanner.registerPair({
    id: "slow_pair",
    assetA: { exchange: "SLOW", symbol: "S", currency: "USD" },
    assetB: { exchange: "FAST", symbol: "S", currency: "USD" },
  });
  const result = await scanner.scan();
  const r = result.results[0];
  assert.ok(r.error);
  assert.match(r.error, /timeout/);
  assert.equal(r.opportunity, false);
});

// ============================================================================
// onOpportunity callback
// ============================================================================
test("scan: onOpportunity callback fires", async () => {
  const opps = [];
  const scanner = createCrossMarketScanner({
    priceFeeds: { EX_A: async () => 100, EX_B: async () => 115 },
    fxProvider: async () => 1,
    config: { thresholdBps: 50, costBps: 5, fetchTimeoutMs: 1000 },
    onOpportunity: (opp) => opps.push(opp),
  });
  scanner.registerPair({
    id: "cb_test",
    assetA: { exchange: "EX_A", symbol: "S", currency: "USD" },
    assetB: { exchange: "EX_B", symbol: "S", currency: "USD" },
  });
  await scanner.scan();
  assert.equal(opps.length, 1);
  assert.equal(opps[0].pairId, "cb_test");
  assert.equal(opps[0].opportunity, true);
});

// ============================================================================
// Stats
// ============================================================================
test("stats: returns correct counters", async () => {
  const scanner = createCrossMarketScanner({
    priceFeeds: { EX_A: async () => 100, EX_B: async () => 120 },
    fxProvider: async () => 1,
    config: { thresholdBps: 50, costBps: 5, fetchTimeoutMs: 1000 },
  });
  scanner.registerPair({
    id: "s1",
    assetA: { exchange: "EX_A", symbol: "S", currency: "USD" },
    assetB: { exchange: "EX_B", symbol: "S", currency: "USD" },
  });
  const s0 = scanner.stats();
  assert.equal(s0.enabled, true);
  assert.equal(s0.totalPairs, 1);
  assert.equal(s0.activePairs, 1);
  assert.equal(s0.scans, 0);
  assert.equal(s0.opportunities, 0);
  await scanner.scan();
  await scanner.scan();
  const s1 = scanner.stats();
  assert.equal(s1.scans, 2);
  assert.equal(s1.opportunities, 2);
  assert.ok(s1.lastScanAt);
});


// ============================================================================
// History
// ============================================================================
test("getHistory: records all scan results and caps at maxHistorySize", async () => {
  const scanner = createCrossMarketScanner({
    priceFeeds: { EX_A: async () => 100, EX_B: async () => 120 },
    fxProvider: async () => 1,
    config: { thresholdBps: 50, costBps: 5, fetchTimeoutMs: 1000, maxHistorySize: 5 },
  });
  scanner.registerPair({
    id: "h1",
    assetA: { exchange: "EX_A", symbol: "S", currency: "USD" },
    assetB: { exchange: "EX_B", symbol: "S", currency: "USD" },
  });
  for (let i = 0; i < 10; i++) await scanner.scan();
  const h = scanner.getHistory();
  assert.equal(h.length, 5);
  const all = scanner.getHistory(100);
  assert.equal(all.length, 5);
});

// ============================================================================
// State / restore / reset
// ============================================================================
test("state/restore: persists and recovers pairs + history + counters", async () => {
  const s1 = createCrossMarketScanner({
    priceFeeds: { X: async () => 100, Y: async () => 120 },
    fxProvider: async () => 1,
    config: { thresholdBps: 50, costBps: 5, fetchTimeoutMs: 1000 },
  });
  s1.registerPair({
    id: "persist",
    assetA: { exchange: "X", symbol: "S", currency: "USD" },
    assetB: { exchange: "Y", symbol: "S", currency: "USD" },
  });
  await s1.scan();
  await s1.scan();
  const snap = s1.state();
  assert.equal(snap.pairs.length, 1);
  assert.equal(snap.counters.scans, 2);
  assert.equal(snap.history.length, 2);

  const s2 = createCrossMarketScanner();
  s2.restore(snap);
  assert.equal(s2.listPairs().length, 1);
  assert.equal(s2.listPairs()[0].id, "persist");
  assert.equal(s2.stats().scans, 2);
  assert.equal(s2.stats().opportunities, 2);
  assert.equal(s2.getHistory().length, 2);
});

test("reset: clears all state", async () => {
  const scanner = createCrossMarketScanner({
    priceFeeds: { X: async () => 100, Y: async () => 120 },
    fxProvider: async () => 1,
    config: { thresholdBps: 50, costBps: 5, fetchTimeoutMs: 1000 },
  });
  scanner.registerPair({
    id: "r1",
    assetA: { exchange: "X", symbol: "S", currency: "USD" },
    assetB: { exchange: "Y", symbol: "S", currency: "USD" },
  });
  await scanner.scan();
  assert.ok(scanner.stats().scans > 0);
  scanner.reset();
  assert.equal(scanner.stats().scans, 0);
  assert.equal(scanner.stats().opportunities, 0);
  assert.equal(scanner.stats().errors, 0);
  assert.equal(scanner.listPairs().length, 0);
  assert.equal(scanner.getHistory().length, 0);
  assert.equal(scanner.stats().lastScanAt, null);
});

test("restore: handles null gracefully", () => {
  const scanner = createCrossMarketScanner();
  scanner.restore(null);
  scanner.restore(undefined);
  assert.equal(scanner.listPairs().length, 0);
});


// ============================================================================
// Inactive pairs skipped
// ============================================================================
test("scan: skips inactive pairs", async () => {
  const scanner = createCrossMarketScanner({
    priceFeeds: { EX_A: async () => 100, EX_B: async () => 120 },
    fxProvider: async () => 1,
    config: { thresholdBps: 50, costBps: 5, fetchTimeoutMs: 1000 },
  });
  scanner.registerPair({
    id: "inactive",
    active: false,
    assetA: { exchange: "EX_A", symbol: "S", currency: "USD" },
    assetB: { exchange: "EX_B", symbol: "S", currency: "USD" },
  });
  const result = await scanner.scan();
  assert.equal(result.pairsScanned, 0);
  assert.equal(result.results.length, 0);
  assert.equal(scanner.stats().totalPairs, 1);
  assert.equal(scanner.stats().activePairs, 0);
});

// ============================================================================
// Missing price feed
// ============================================================================
test("scan: reports error for missing price feed", async () => {
  const scanner = createCrossMarketScanner({
    priceFeeds: {},
    fxProvider: async () => 1,
    config: { thresholdBps: 50, costBps: 5, fetchTimeoutMs: 1000 },
  });
  scanner.registerPair({
    id: "no_feed",
    assetA: { exchange: "MISSING_A", symbol: "S", currency: "USD" },
    assetB: { exchange: "MISSING_B", symbol: "S", currency: "USD" },
  });
  const result = await scanner.scan();
  assert.equal(result.results[0].opportunity, false);
  assert.ok(result.results[0].error);
  assert.match(result.results[0].error, /no price feed/);
  assert.equal(scanner.stats().errors, 1);
});



// ============================================================================
// Invalid price values
// ============================================================================
test("scan: rejects non-positive prices", async () => {
  const scanner = createCrossMarketScanner({
    priceFeeds: { ZERO: async () => 0, OK: async () => 100 },
    fxProvider: async () => 1,
    config: { thresholdBps: 50, costBps: 5, fetchTimeoutMs: 1000 },
  });
  scanner.registerPair({
    id: "zero_price",
    assetA: { exchange: "ZERO", symbol: "S", currency: "USD" },
    assetB: { exchange: "OK", symbol: "S", currency: "USD" },
  });
  const result = await scanner.scan();
  assert.equal(result.results[0].opportunity, false);
  assert.ok(result.results[0].error);
  assert.match(result.results[0].error, /invalid price/);
});

// ============================================================================
// Missing FX provider
// ============================================================================
test("scan: error when non-base currency but no fxProvider", async () => {
  const scanner = createCrossMarketScanner({
    priceFeeds: { EX_A: async () => 100, EX_B: async () => 120 },
    config: { thresholdBps: 50, costBps: 5, fetchTimeoutMs: 1000 },
  });
  scanner.registerPair({
    id: "no_fx",
    assetA: { exchange: "EX_A", symbol: "S", currency: "EUR" },
    assetB: { exchange: "EX_B", symbol: "S", currency: "USD" },
  });
  const result = await scanner.scan();
  assert.equal(result.results[0].opportunity, false);
  assert.ok(result.results[0].error);
  assert.match(result.results[0].error, /no fxProvider/);
});
