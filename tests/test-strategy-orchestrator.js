"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createStrategyOrchestrator,
  DEFAULT_CONFIG,
} = require("../src/strategy/orchestrator");
const { createStrategyRegistry } = require("../src/strategy/registry");
const { createShadowMode } = require("../src/orchestrator/shadow-mode");

function makeCtx(overrides = {}) {
  return {
    lastClose: 105000, sma5: 104000, sma20: 100000,
    ema9: 103500, ema21: 101000, vwap: 104500,
    rsi14: 55, changePct5d: 3.2,
    macd: { macdLine: 120, signal: 100, histogram: 20 },
    bollinger: { upper: 110000, middle: 104000, lower: 98000 },
    atr14: 1500,
    ...overrides,
  };
}

function makeRegistry() {
  const reg = createStrategyRegistry();
  reg.register({
    name: "momentum",
    generateSignal(ctx) {
      if (ctx.sma5 > ctx.sma20) return { action: "BUY", score: 4, reasons: ["sma5>sma20"], strategy: "momentum" };
      return { action: "HOLD", score: 0, reasons: [], strategy: null };
    },
  });
  reg.register({
    name: "mean_rev",
    generateSignal(ctx) {
      if (ctx.rsi14 < 35) return { action: "BUY", score: 3, reasons: ["rsi oversold"], strategy: "mean_rev" };
      return { action: "HOLD", score: 0, reasons: [], strategy: null };
    },
  });
  reg.register({
    name: "risk_exit",
    generateSignal(ctx, position) {
      if (position && ((ctx.lastClose - position.avgPrice) / position.avgPrice) * 100 <= -2) {
        return { action: "SELL", score: 10, reasons: ["stop-loss"], strategy: "risk_exit" };
      }
      return { action: "HOLD", score: 0, reasons: [], strategy: null };
    },
  });
  return reg;
}

function seedFills(orch, name, wins, losses, avgWin = 100, avgLoss = -60) {
  for (let i = 0; i < wins; i++) orch.recordFill(name, { symbol: "X", side: "SELL", pnl: avgWin });
  for (let i = 0; i < losses; i++) orch.recordFill(name, { symbol: "X", side: "SELL", pnl: avgLoss });
}

// ===================== API basics =====================

test("registerStrategy initializes with equal allocation", () => {
  const orch = createStrategyOrchestrator();
  orch.registerStrategy("A");
  orch.registerStrategy("B");
  const alloc = orch.getAllocation();
  assert.equal(Object.keys(alloc).length, 2);
  assert.ok(Math.abs(alloc.A - 0.5) < 1e-9);
  assert.ok(Math.abs(alloc.B - 0.5) < 1e-9);
});

test("registerStrategy third strategy rebalances all to 1/3", () => {
  const orch = createStrategyOrchestrator();
  orch.registerStrategy("A");
  orch.registerStrategy("B");
  orch.registerStrategy("C");
  const alloc = orch.getAllocation();
  for (const k of ["A", "B", "C"]) {
    assert.ok(Math.abs(alloc[k] - 1 / 3) < 5e-4, `${k} should be ~1/3, got ${alloc[k]}`);
  }
});

test("unregisterStrategy removes and re-normalizes", () => {
  const orch = createStrategyOrchestrator();
  orch.registerStrategy("A");
  orch.registerStrategy("B");
  orch.registerStrategy("C");
  orch.unregisterStrategy("B");
  const alloc = orch.getAllocation();
  assert.equal(Object.keys(alloc).length, 2);
  assert.ok(Math.abs(alloc.A - 0.5) < 1e-9);
  assert.ok(Math.abs(alloc.C - 0.5) < 1e-9);
  assert.equal(orch.getWeight("B"), 0);
});

test("clear resets all state", () => {
  const orch = createStrategyOrchestrator();
  orch.registerStrategy("A");
  orch.recordFill("A", { symbol: "X", side: "SELL", pnl: 100 });
  orch.clear();
  assert.deepEqual(orch.getAllocation(), {});
  assert.equal(orch.getAllStats().length, 0);
  assert.equal(orch.getHistory().length, 0);
});

// ===================== recordFill & stats =====================

test("recordFill tracks wins, losses, totalPnl", () => {
  const orch = createStrategyOrchestrator();
  orch.registerStrategy("S");
  orch.recordFill("S", { symbol: "A", side: "SELL", pnl: 100 });
  orch.recordFill("S", { symbol: "B", side: "SELL", pnl: -40 });
  orch.recordFill("S", { symbol: "C", side: "SELL", pnl: 50 });
  const s = orch.getStrategyStats("S");
  assert.equal(s.wins, 2);
  assert.equal(s.losses, 1);
  assert.equal(s.totalTrades, 3);
  assert.equal(s.totalPnl, 110);
  assert.ok(Math.abs(s.winRate - 2 / 3) < 1e-9);
});

test("recordFill tracks max drawdown across peak", () => {
  const orch = createStrategyOrchestrator();
  orch.registerStrategy("S");
  orch.recordFill("S", { pnl: 200 });
  orch.recordFill("S", { pnl: -150 });
  orch.recordFill("S", { pnl: 50 });
  const s = orch.getStrategyStats("S");
  assert.equal(s.maxDrawdown, 150);
  assert.equal(s.totalPnl, 100);
});

test("recordFill auto-initializes unknown strategy", () => {
  const orch = createStrategyOrchestrator();
  orch.recordFill("ghost", { pnl: 10 });
  const s = orch.getStrategyStats("ghost");
  assert.ok(s);
  assert.equal(s.wins, 1);
  assert.ok(orch.getWeight("ghost") > 0);
});

test("recordFill ignores fills without pnl", () => {
  const orch = createStrategyOrchestrator();
  orch.registerStrategy("S");
  orch.recordFill("S", { symbol: "A", side: "BUY" });
  const s = orch.getStrategyStats("S");
  assert.equal(s.totalTrades, 0);
  assert.equal(s.totalPnl, 0);
});

test("getStrategyStats returns null for unknown", () => {
  const orch = createStrategyOrchestrator();
  assert.equal(orch.getStrategyStats("nope"), null);
});

test("getAllStats returns every registered strategy", () => {
  const orch = createStrategyOrchestrator();
  orch.registerStrategy("A");
  orch.registerStrategy("B");
  const all = orch.getAllStats();
  assert.equal(all.length, 2);
  const names = all.map(s => s.name).sort();
  assert.deepEqual(names, ["A", "B"]);
});

// ===================== computePerformanceScore =====================

test("computePerformanceScore returns -Infinity below minTradesForEval", () => {
  const orch = createStrategyOrchestrator();
  orch.registerStrategy("S");
  seedFills(orch, "S", 3, 2);
  const stats = orch.getStrategyStats("S");
  assert.equal(orch.computePerformanceScore(stats), -Infinity);
});

test("computePerformanceScore ranks high-winrate higher", () => {
  const orch = createStrategyOrchestrator();
  orch.registerStrategy("good");
  orch.registerStrategy("bad");
  seedFills(orch, "good", 15, 3, 100, -50);
  seedFills(orch, "bad", 3, 15, 100, -80);
  const sg = orch.getStrategyStats("good");
  const sb = orch.getStrategyStats("bad");
  assert.ok(orch.computePerformanceScore(sg) > orch.computePerformanceScore(sb));
});

// ===================== rebalance =====================

test("rebalance fails with no strategies", () => {
  const orch = createStrategyOrchestrator();
  const r = orch.rebalance();
  assert.equal(r.ok, false);
  assert.match(r.reason, /no strategies/);
});

test("rebalance fails when no strategy has enough data", () => {
  const orch = createStrategyOrchestrator();
  orch.registerStrategy("A");
  orch.registerStrategy("B");
  seedFills(orch, "A", 2, 1);
  seedFills(orch, "B", 1, 2);
  const r = orch.rebalance();
  // All insufficient — should still produce equal allocation via exploration
  assert.equal(r.ok, true);
  const alloc = r.allocation;
  assert.ok(Math.abs(alloc.A - 0.5) < 1e-9);
  assert.ok(Math.abs(alloc.B - 0.5) < 1e-9);
});

test("rebalance allocation sums to 1.0", () => {
  const orch = createStrategyOrchestrator();
  orch.registerStrategy("A");
  orch.registerStrategy("B");
  orch.registerStrategy("C");
  seedFills(orch, "A", 15, 3, 100, -50);
  seedFills(orch, "B", 10, 8, 80, -60);
  seedFills(orch, "C", 5, 13, 60, -80);
  const r = orch.rebalance();
  assert.equal(r.ok, true);
  const sum = Object.values(r.allocation).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1.0) < 1e-6, `sum should be 1.0, got ${sum}`);
});

test("rebalance respects min and max allocation", () => {
  const orch = createStrategyOrchestrator({
    config: { minAllocationPct: 10, maxAllocationPct: 70 },
  });
  orch.registerStrategy("A");
  orch.registerStrategy("B");
  orch.registerStrategy("C");
  seedFills(orch, "A", 20, 1, 200, -30);   // very good
  seedFills(orch, "B", 11, 10, 50, -50);   // mediocre
  seedFills(orch, "C", 2, 19, 20, -100);   // terrible
  const r = orch.rebalance();
  assert.equal(r.ok, true);
  for (const [k, v] of Object.entries(r.allocation)) {
    assert.ok(v >= 0.10 - 1e-3, `${k}=${v} below min 10%`);
    assert.ok(v <= 0.70 + 1e-3, `${k}=${v} above max 70%`);
  }
});

test("rebalance top performer gets highest weight", () => {
  const orch = createStrategyOrchestrator({
    config: { minAllocationPct: 5, maxAllocationPct: 80 },
  });
  orch.registerStrategy("top");
  orch.registerStrategy("mid");
  orch.registerStrategy("low");
  seedFills(orch, "top", 18, 2, 150, -40);
  seedFills(orch, "mid", 12, 8, 80, -60);
  seedFills(orch, "low", 4, 16, 40, -90);
  const r = orch.rebalance();
  assert.equal(r.ok, true);
  assert.ok(r.allocation.top > r.allocation.mid, `top=${r.allocation.top} should > mid=${r.allocation.mid}`);
  assert.ok(r.allocation.mid >= r.allocation.low, `mid=${r.allocation.mid} should >= low=${r.allocation.low}`);
});

test("rebalance proposes to shadow mode on big changes", () => {
  const proposed = [];
  const shadow = {
    propose(param, oldVal, newVal, meta) {
      proposed.push({ param, oldVal, newVal, meta });
    },
  };
  const orch = createStrategyOrchestrator({
    shadowMode: shadow,
    config: { minAllocationPct: 5, maxAllocationPct: 80 },
  });
  orch.registerStrategy("A");
  orch.registerStrategy("B");
  seedFills(orch, "A", 18, 2, 150, -40);
  seedFills(orch, "B", 4, 16, 40, -90);
  const r = orch.rebalance();
  assert.equal(r.ok, true);
  assert.ok(proposed.length > 0, "expected at least one shadow proposal");
  assert.ok(proposed[0].param.startsWith("STRATEGY_WEIGHT_"));
  assert.equal(proposed[0].meta.reason, "orchestrator_rebalance");
});

test("rebalance records history entry", () => {
  const orch = createStrategyOrchestrator();
  orch.registerStrategy("A");
  seedFills(orch, "A", 15, 3);
  orch.rebalance();
  const h = orch.getHistory();
  assert.equal(h.length, 1);
  assert.ok(h[0].ts);
  assert.equal(h[0].totalStrategies, 1);
});

test("rebalance onRebalance callback fires", () => {
  let fired = null;
  const orch = createStrategyOrchestrator({
    onRebalance: (info) => { fired = info; },
  });
  orch.registerStrategy("A");
  seedFills(orch, "A", 15, 3);
  orch.rebalance();
  assert.ok(fired);
  assert.ok(fired.allocation);
});

// ===================== generateWeightedSignal =====================

test("generateWeightedSignal returns HOLD with no registry", () => {
  const orch = createStrategyOrchestrator();
  const r = orch.generateWeightedSignal(makeCtx(), null);
  assert.equal(r.action, "HOLD");
  assert.match(r.reasons[0], /no registry/);
});

test("generateWeightedSignal returns HOLD with empty registry", () => {
  const reg = createStrategyRegistry();
  const orch = createStrategyOrchestrator({ registry: reg });
  const r = orch.generateWeightedSignal(makeCtx(), null);
  assert.equal(r.action, "HOLD");
});

test("generateWeightedSignal aggregates weighted BUY scores", () => {
  const reg = makeRegistry();
  const orch = createStrategyOrchestrator({ registry: reg });
  orch.registerStrategy("momentum");
  orch.registerStrategy("mean_rev");
  orch.registerStrategy("risk_exit");
  // Override allocation to known weights
  // We need to clear and re-register to control weights; simpler: seed fills
  // that produce known allocation, or just call rebalance after seeding.
  // For a unit test, use direct registration order (equal weights = 1/3 each).
  const ctx = makeCtx({ rsi14: 30 }); // triggers mean_rev BUY + momentum BUY
  const r = orch.generateWeightedSignal(ctx, null);
  assert.equal(r.action, "BUY");
  assert.equal(r.strategy, "orchestrator");
  assert.ok(r.sources.includes("momentum"));
  assert.ok(r.sources.includes("mean_rev"));
});

test("generateWeightedSignal risk_exit overrides all buys", () => {
  const reg = makeRegistry();
  const orch = createStrategyOrchestrator({ registry: reg });
  orch.registerStrategy("momentum");
  orch.registerStrategy("mean_rev");
  orch.registerStrategy("risk_exit");
  const ctx = makeCtx();
  const pos = { avgPrice: 110000, qty: 10 }; // -4.5% triggers stop
  const r = orch.generateWeightedSignal(ctx, pos);
  assert.equal(r.action, "SELL");
  assert.equal(r.strategy, "risk_exit");
});

test("generateWeightedSignal returns HOLD when no score exceeds threshold", () => {
  const reg = createStrategyRegistry();
  reg.register({
    name: "weak",
    generateSignal() { return { action: "BUY", score: 1, reasons: ["weak"], strategy: "weak" }; },
  });
  const orch = createStrategyOrchestrator({ registry: reg });
  orch.registerStrategy("weak");
  // With allocation=1.0 and score=1, weighted=1.0 — passes default threshold 0.5
  // But force high threshold:
  const r = orch.generateWeightedSignal(makeCtx(), null, { minWeightedScore: 5 });
  assert.equal(r.action, "HOLD");
});

// ===================== stats() & history =====================

test("stats() reports allocation sum and strategy count", () => {
  const orch = createStrategyOrchestrator();
  orch.registerStrategy("A");
  orch.registerStrategy("B");
  const s = orch.stats();
  assert.equal(s.totalStrategies, 2);
  assert.ok(Math.abs(s.allocationSum - 1.0) < 1e-6);
  assert.equal(s.lastRebalance, null);
  assert.equal(s.totalRebalances, 0);
});

test("stats() reflects rebalance", () => {
  const orch = createStrategyOrchestrator();
  orch.registerStrategy("A");
  seedFills(orch, "A", 15, 3);
  orch.rebalance();
  const s = orch.stats();
  assert.ok(s.lastRebalance);
  assert.equal(s.totalRebalances, 1);
});

test("getHistory returns chronological records", () => {
  const orch = createStrategyOrchestrator();
  orch.registerStrategy("A");
  seedFills(orch, "A", 15, 3);
  orch.rebalance();
  seedFills(orch, "A", 5, 1);
  orch.rebalance();
  const h = orch.getHistory();
  assert.equal(h.length, 2);
  assert.ok(h[0].ts <= h[1].ts);
});

test("DEFAULT_CONFIG has expected fields", () => {
  assert.equal(DEFAULT_CONFIG.minAllocationPct, 5.0);
  assert.equal(DEFAULT_CONFIG.maxAllocationPct, 40.0);
  assert.equal(DEFAULT_CONFIG.rebalanceIntervalDays, 7);
  assert.equal(DEFAULT_CONFIG.minTradesForEval, 10);
});


test("computePerformanceScore penalizes large drawdown", () => {
  const orch = createStrategyOrchestrator({ config: { maxDrawdownPenalty: 20 } });
  orch.registerStrategy("S");
  for (let i = 0; i < 11; i++) orch.recordFill("S", { pnl: 10 });
  orch.recordFill("S", { pnl: -500 });
  const stats = orch.getStrategyStats("S");
  const score = orch.computePerformanceScore(stats);
  assert.ok(Number.isFinite(score));
  assert.ok(score < 0, `expected negative score, got ${score}`);
});
