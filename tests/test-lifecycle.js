"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createLifecycleManager,
  DEFAULTS,
  PHASES,
} = require("../src/strategy/lifecycle");

// ============================================================================
// DEFAULTS
// ============================================================================
test("DEFAULTS: correct default values", () => {
  assert.equal(DEFAULTS.minSharpe30d, 0.0);
  assert.equal(DEFAULTS.minSharpe60d, 0.2);
  assert.equal(DEFAULTS.maxDrawdownMultiplier, 1.5);
  assert.equal(DEFAULTS.minWinRate, 0.35);
  assert.equal(DEFAULTS.minTradesForWinRate, 50);
  assert.deepEqual(DEFAULTS.promotionLevels, [0.10, 0.50, 1.00]);
  assert.equal(DEFAULTS.rollingWindow30d, 30);
  assert.equal(DEFAULTS.rollingWindow60d, 60);
  assert.equal(DEFAULTS.maxHistorySize, 1000);
  assert.equal(DEFAULTS.maxDrawdownLimit, 1000);
});

// ============================================================================
// PHASES
// ============================================================================
test("PHASES: all four phases defined", () => {
  assert.equal(PHASES.DISCOVERY, "DISCOVERY");
  assert.equal(PHASES.INCUBATION, "INCUBATION");
  assert.equal(PHASES.PRODUCTION, "PRODUCTION");
  assert.equal(PHASES.RETIREMENT, "RETIREMENT");
});

// ============================================================================
// proposeStrategy
// ============================================================================
test("proposeStrategy: creates strategy in DISCOVERY phase", () => {
  const lm = createLifecycleManager();
  const result = lm.proposeStrategy({ name: "momentum_v2", logic: "SMA cross", hypothesis: "trend following" });
  assert.ok(result.id);
  assert.equal(result.name, "momentum_v2");
  assert.equal(result.phase, "DISCOVERY");
  const strat = lm.getStrategy(result.id);
  assert.equal(strat.phase, "DISCOVERY");
  assert.equal(strat.allocationPct, 0);
  assert.equal(strat.promotionLevel, -1);
  assert.equal(strat.logic, "SMA cross");
  assert.equal(strat.hypothesis, "trend following");
});

test("proposeStrategy: throws on missing name", () => {
  const lm = createLifecycleManager();
  assert.throws(() => lm.proposeStrategy({}), /requires llmContext/);
  assert.throws(() => lm.proposeStrategy(null), /requires llmContext/);
});

test("proposeStrategy: throws on empty name string", () => {
  const lm = createLifecycleManager();
  // Empty string is falsy, caught by the 'requires llmContext' check
  assert.throws(() => lm.proposeStrategy({ name: "" }), /requires llmContext/);
  // Whitespace-only is truthy, caught by the 'non-empty string' check
  assert.throws(() => lm.proposeStrategy({ name: "   " }), /non-empty string/);
});

test("proposeStrategy: trims whitespace from name", () => {
  const lm = createLifecycleManager();
  const result = lm.proposeStrategy({ name: "  my_strategy  " });
  const strat = lm.getStrategy(result.id);
  assert.equal(strat.name, "my_strategy");
});

test("proposeStrategy: records PROPOSE event in history", () => {
  const lm = createLifecycleManager();
  lm.proposeStrategy({ name: "test_strat" });
  const h = lm.getHistory();
  assert.equal(h.length, 1);
  assert.equal(h[0].event, "PROPOSE");
  assert.ok(h[0].strategyId);
  assert.equal(h[0].name, "test_strat");
});

// ============================================================================
// validate
// ============================================================================
test("validate: returns shadow when no validators configured", async () => {
  const lm = createLifecycleManager();
  const s = lm.proposeStrategy({ name: "s1" });
  const result = await lm.validate(s.id);
  assert.equal(result.verdict, "shadow");
  assert.ok(result.reason.includes("No validators"));
});

test("validate: throws on unknown strategy", async () => {
  const lm = createLifecycleManager();
  await assert.rejects(() => lm.validate("nonexistent"), /not found/);
});

test("validate: rejects if not in DISCOVERY phase", async () => {
  const lm = createLifecycleManager();
  const s = lm.proposeStrategy({ name: "s1" });
  lm.promote(s.id, "INCUBATION");
  const result = await lm.validate(s.id);
  assert.equal(result.verdict, "reject");
  assert.ok(result.reason.includes("not in DISCOVERY"));
});

test("validate: promotes with walk-forward deploy + VaR + council", async () => {
  const wfValidator = { validate: () => ({ verdict: "deploy", reason: "ok" }) };
  const varEng = { fullReport: () => ({ summary: { parametricVaR: 0.02 } }) };
  const councilMock = { evaluate: async () => ({ approved: true, consensus: 0.8 }) };
  const lm = createLifecycleManager({
    walkForwardValidator: wfValidator,
    varEngine: varEng,
    council: councilMock,
  });
  const s = lm.proposeStrategy({ name: "s1", parameters: { returns: [0.01, -0.005, 0.02] } });
  const result = await lm.validate(s.id);
  assert.equal(result.verdict, "promote");
  assert.ok(result.score >= 0.7);
  assert.ok(result.details.walkForward);
  assert.ok(result.details.varCheck);
  assert.ok(result.details.council);
});

test("validate: rejects on walk-forward reject", async () => {
  const wfValidator = { validate: () => ({ verdict: "reject", reason: "OOS sharpe too low" }) };
  const lm = createLifecycleManager({ walkForwardValidator: wfValidator });
  const s = lm.proposeStrategy({ name: "s1" });
  const result = await lm.validate(s.id);
  assert.equal(result.verdict, "reject");
  assert.ok(result.reason.includes("Walk-forward rejected"));
});

test("validate: shadow on partial validation score", async () => {
  const wfValidator = { validate: () => ({ verdict: "deploy", reason: "ok" }) };
  const lm = createLifecycleManager({ walkForwardValidator: wfValidator });
  const s = lm.proposeStrategy({ name: "s1" });
  const result = await lm.validate(s.id);
  assert.equal(result.verdict, "shadow");
  assert.ok(result.reason.includes("Partial validation"));
});

test("validate: handles validator exceptions gracefully", async () => {
  const wfValidator = { validate: () => { throw new Error("WF crash"); } };
  const varEng = { fullReport: () => { throw new Error("VaR crash"); } };
  const lm = createLifecycleManager({ walkForwardValidator: wfValidator, varEngine: varEng });
  const s = lm.proposeStrategy({ name: "s1", parameters: { returns: [0.01] } });
  const result = await lm.validate(s.id);
  assert.equal(result.verdict, "reject");
  assert.ok(result.details.walkForward.error);
  assert.ok(result.details.varCheck.error);
});

test("validate: increments validationAttempts counter", async () => {
  const lm = createLifecycleManager();
  const s = lm.proposeStrategy({ name: "s1" });
  await lm.validate(s.id);
  await lm.validate(s.id);
  const strat = lm.getStrategy(s.id);
  assert.equal(strat.validationAttempts, 2);
});

// ============================================================================
// promote
// ============================================================================
test("promote: DISCOVERY → INCUBATION sets paper trading", () => {
  const lm = createLifecycleManager();
  const s = lm.proposeStrategy({ name: "s1" });
  const result = lm.promote(s.id, "INCUBATION");
  assert.equal(result.phase, "INCUBATION");
  assert.equal(result.allocationPct, 0);
  const strat = lm.getStrategy(s.id);
  assert.equal(strat.phase, "INCUBATION");
  assert.ok(strat.promotedAt > 0);
});

test("promote: INCUBATION → PRODUCTION first level (10%)", () => {
  const lm = createLifecycleManager();
  const s = lm.proposeStrategy({ name: "s1" });
  lm.promote(s.id, "INCUBATION");
  const result = lm.promote(s.id, "PRODUCTION");
  assert.equal(result.phase, "PRODUCTION");
  assert.equal(result.allocationPct, 0.10);
  assert.equal(result.promotionLevel, 0);
});

test("promote: graduated allocation 10% → 50% → 100%", () => {
  const lm = createLifecycleManager();
  const s = lm.proposeStrategy({ name: "s1" });
  lm.promote(s.id, "INCUBATION");
  lm.promote(s.id, "PRODUCTION"); // 10%
  let r = lm.promote(s.id, "PRODUCTION"); // 50%
  assert.equal(r.allocationPct, 0.50);
  assert.equal(r.promotionLevel, 1);
  r = lm.promote(s.id, "PRODUCTION"); // 100%
  assert.equal(r.allocationPct, 1.00);
  assert.equal(r.promotionLevel, 2);
  // Already at max
  r = lm.promote(s.id, "PRODUCTION");
  assert.equal(r.allocationPct, 1.00);
});

test("promote: throws on invalid phase transitions", () => {
  const lm = createLifecycleManager();
  const s = lm.proposeStrategy({ name: "s1" });
  assert.throws(() => lm.promote(s.id, "INVALID"), /Invalid target phase/);
  assert.throws(() => lm.promote(s.id, "PRODUCTION"), /from INCUBATION/);
});

test("promote: throws on unknown strategy", () => {
  const lm = createLifecycleManager();
  assert.throws(() => lm.promote("nonexistent", "INCUBATION"), /not found/);
});

test("promote: RETIREMENT target delegates to retire()", () => {
  const lm = createLifecycleManager();
  const s = lm.proposeStrategy({ name: "s1" });
  const result = lm.promote(s.id, "RETIREMENT");
  assert.equal(result.phase, "RETIREMENT");
  assert.equal(result.reason, "manual_retirement");
});

test("promote: fires onPromote callback", () => {
  let called = null;
  const lm = createLifecycleManager({ onPromote: (id, phase, alloc) => { called = { id, phase, alloc }; } });
  const s = lm.proposeStrategy({ name: "s1" });
  lm.promote(s.id, "INCUBATION");
  assert.ok(called);
  assert.equal(called.id, s.id);
  assert.equal(called.phase, "INCUBATION");
  assert.equal(called.alloc, 0);
});

test("promote: onPromote exception does not break flow", () => {
  const lm = createLifecycleManager({ onPromote: () => { throw new Error("callback crash"); } });
  const s = lm.proposeStrategy({ name: "s1" });
  const result = lm.promote(s.id, "INCUBATION");
  assert.equal(result.phase, "INCUBATION");
});

// ============================================================================
// retire
// ============================================================================
test("retire: sets phase to RETIREMENT and clears allocation", () => {
  const lm = createLifecycleManager();
  const s = lm.proposeStrategy({ name: "s1" });
  lm.promote(s.id, "INCUBATION");
  lm.promote(s.id, "PRODUCTION");
  const result = lm.retire(s.id, "performance_degradation");
  assert.equal(result.phase, "RETIREMENT");
  assert.equal(result.reason, "performance_degradation");
  const strat = lm.getStrategy(s.id);
  assert.equal(strat.allocationPct, 0);
  assert.ok(strat.retiredAt > 0);
});

test("retire: idempotent on already retired", () => {
  const lm = createLifecycleManager();
  const s = lm.proposeStrategy({ name: "s1" });
  lm.retire(s.id, "reason1");
  const result = lm.retire(s.id, "reason2");
  assert.equal(result.reason, "reason1");
});

test("retire: fires onRetire callback with fromPhase", () => {
  let called = null;
  const lm = createLifecycleManager({ onRetire: (id, reason, from) => { called = { id, reason, from }; } });
  const s = lm.proposeStrategy({ name: "s1" });
  lm.promote(s.id, "INCUBATION");
  lm.retire(s.id, "test_reason");
  assert.ok(called);
  assert.equal(called.from, "INCUBATION");
  assert.equal(called.reason, "test_reason");
});

test("retire: throws on unknown strategy", () => {
  const lm = createLifecycleManager();
  assert.throws(() => lm.retire("nonexistent", "reason"), /not found/);
});

// ============================================================================
// recordFill
// ============================================================================
test("recordFill: tracks wins, losses, totalPnl, drawdown", () => {
  const lm = createLifecycleManager();
  const s = lm.proposeStrategy({ name: "s1" });
  lm.recordFill(s.id, { symbol: "AAPL", pnl: 100 });
  lm.recordFill(s.id, { symbol: "AAPL", pnl: -40 });
  lm.recordFill(s.id, { symbol: "AAPL", pnl: 200 });
  const strat = lm.getStrategy(s.id);
  assert.equal(strat.performance.totalPnl, 260);
  assert.equal(strat.performance.wins, 2);
  assert.equal(strat.performance.losses, 1);
  assert.equal(strat.performance.totalTrades, 3);
  assert.equal(strat.performance.maxDrawdown, 40);
});

test("recordFill: ignores fills with null pnl", () => {
  const lm = createLifecycleManager();
  const s = lm.proposeStrategy({ name: "s1" });
  lm.recordFill(s.id, { symbol: "AAPL", pnl: null });
  lm.recordFill(s.id, null);
  const strat = lm.getStrategy(s.id);
  assert.equal(strat.performance.totalTrades, 0);
});

test("recordFill: throws on unknown strategy", () => {
  const lm = createLifecycleManager();
  assert.throws(() => lm.recordFill("nonexistent", { pnl: 10 }), /not found/);
});

test("recordFill: aggregates same-day fills into single daily entry", () => {
  const lm = createLifecycleManager({ config: { now: () => new Date("2026-10-01T12:00:00Z").getTime() } });
  const s = lm.proposeStrategy({ name: "s1" });
  lm.recordFill(s.id, { pnl: 50 });
  lm.recordFill(s.id, { pnl: 30 });
  const strat = lm.getStrategy(s.id);
  assert.equal(strat.performance.totalTrades, 2);
  assert.equal(strat.performance.totalPnl, 80);
});

// ============================================================================
// checkRetirement
// ============================================================================
test("checkRetirement: returns already_retired for retired strategy", () => {
  const lm = createLifecycleManager();
  const s = lm.proposeStrategy({ name: "s1" });
  lm.retire(s.id, "test");
  const result = lm.checkRetirement(s.id);
  assert.equal(result.shouldRetire, false);
  assert.equal(result.reason, "already_retired");
});

test("checkRetirement: max_drawdown_exceeded triggers retirement", () => {
  const lm = createLifecycleManager({ config: { maxDrawdownLimit: 100, maxDrawdownMultiplier: 1.5 } });
  const s = lm.proposeStrategy({ name: "s1", parameters: { maxDrawdownLimit: 100 } });
  // Create a large drawdown: +200 then -400 = peak 200, current -200, DD = 400 > 100*1.5
  lm.recordFill(s.id, { pnl: 200 });
  lm.recordFill(s.id, { pnl: -400 });
  const result = lm.checkRetirement(s.id);
  assert.equal(result.shouldRetire, true);
  assert.equal(result.reason, "max_drawdown_exceeded");
  assert.ok(result.metrics.maxDrawdown > 150);
});

test("checkRetirement: win_rate_below_threshold after enough trades", () => {
  const lm = createLifecycleManager({ config: { minTradesForWinRate: 10, minWinRate: 0.35 } });
  const s = lm.proposeStrategy({ name: "s1" });
  // 2 wins, 9 losses = 2/11 = 18% win rate < 35%
  for (let i = 0; i < 2; i++) lm.recordFill(s.id, { pnl: 10 });
  for (let i = 0; i < 9; i++) lm.recordFill(s.id, { pnl: -5 });
  const result = lm.checkRetirement(s.id);
  assert.equal(result.shouldRetire, true);
  assert.equal(result.reason, "win_rate_below_threshold");
});

test("checkRetirement: healthy strategy does not trigger retirement", () => {
  const lm = createLifecycleManager();
  const s = lm.proposeStrategy({ name: "s1" });
  for (let i = 0; i < 5; i++) lm.recordFill(s.id, { pnl: 100 });
  for (let i = 0; i < 2; i++) lm.recordFill(s.id, { pnl: -30 });
  const result = lm.checkRetirement(s.id);
  assert.equal(result.shouldRetire, false);
  assert.equal(result.reason, null);
});

test("checkRetirement: fires onReview for low 60d sharpe with partial data", () => {
  let reviewCalled = false;
  const lm = createLifecycleManager({
    config: { rollingWindow60d: 10, minSharpe60d: 0.2 },
    onReview: () => { reviewCalled = true; },
  });
  const s = lm.proposeStrategy({ name: "s1" });
  // 5 daily entries with negative pnl (>= 50% of window 10)
  for (let i = 0; i < 5; i++) {
    lm.recordFill(s.id, { pnl: -10, timestamp: new Date("2026-10-0" + (i + 1) + "T12:00:00Z").getTime() });
  }
  lm.checkRetirement(s.id);
  assert.ok(reviewCalled);
});

test("checkRetirement: throws on unknown strategy", () => {
  const lm = createLifecycleManager();
  assert.throws(() => lm.checkRetirement("nonexistent"), /not found/);
});

// ============================================================================
// Accessors
// ============================================================================
test("getStrategy: returns null for unknown id", () => {
  const lm = createLifecycleManager();
  assert.equal(lm.getStrategy("nonexistent"), null);
});

test("getStrategy: returns full strategy snapshot", () => {
  const lm = createLifecycleManager();
  const s = lm.proposeStrategy({ name: "s1", logic: "SMA", hypothesis: "trend" });
  lm.recordFill(s.id, { pnl: 100 });
  const strat = lm.getStrategy(s.id);
  assert.equal(strat.id, s.id);
  assert.equal(strat.name, "s1");
  assert.equal(strat.logic, "SMA");
  assert.equal(strat.hypothesis, "trend");
  assert.equal(strat.phase, "DISCOVERY");
  assert.equal(strat.performance.totalPnl, 100);
  assert.equal(strat.performance.totalTrades, 1);
  assert.equal(strat.validationAttempts, 0);
  assert.equal(strat.lastValidationResult, null);
});

test("listStrategies: returns all strategies", () => {
  const lm = createLifecycleManager();
  lm.proposeStrategy({ name: "a" });
  lm.proposeStrategy({ name: "b" });
  lm.proposeStrategy({ name: "c" });
  const list = lm.listStrategies();
  assert.equal(list.length, 3);
  assert.deepEqual(list.map(s => s.name).sort(), ["a", "b", "c"]);
});

test("getByPhase: filters by phase", () => {
  const lm = createLifecycleManager();
  const s1 = lm.proposeStrategy({ name: "a" });
  lm.proposeStrategy({ name: "b" });
  lm.promote(s1.id, "INCUBATION");
  assert.equal(lm.getByPhase("DISCOVERY").length, 1);
  assert.equal(lm.getByPhase("INCUBATION").length, 1);
  assert.equal(lm.getByPhase("PRODUCTION").length, 0);
  assert.equal(lm.getByPhase("RETIREMENT").length, 0);
});

// ============================================================================
// stats
// ============================================================================
test("stats: returns correct counts by phase", () => {
  const lm = createLifecycleManager();
  const s1 = lm.proposeStrategy({ name: "a" });
  const s2 = lm.proposeStrategy({ name: "b" });
  lm.promote(s1.id, "INCUBATION");
  lm.promote(s1.id, "PRODUCTION");
  lm.retire(s2.id, "test");
  const st = lm.stats();
  assert.equal(st.totalStrategies, 2);
  assert.equal(st.byPhase.discovery, 0);
  assert.equal(st.byPhase.incubation, 0);
  assert.equal(st.byPhase.production, 1);
  assert.equal(st.byPhase.retirement, 1);
  assert.equal(st.totalAllocatedPct, 0.10);
});

test("stats: empty manager", () => {
  const lm = createLifecycleManager();
  const st = lm.stats();
  assert.equal(st.totalStrategies, 0);
  assert.equal(st.totalAllocatedPct, 0);
  assert.equal(st.historySize, 0);
});

// ============================================================================
// getHistory
// ============================================================================
test("getHistory: returns all events", () => {
  const lm = createLifecycleManager();
  const s = lm.proposeStrategy({ name: "s1" });
  lm.promote(s.id, "INCUBATION");
  lm.retire(s.id, "done");
  const h = lm.getHistory();
  assert.equal(h.length, 3);
  assert.equal(h[0].event, "PROPOSE");
  assert.equal(h[1].event, "PROMOTE");
  assert.equal(h[2].event, "RETIRE");
});

test("getHistory: respects limit parameter", () => {
  const lm = createLifecycleManager();
  lm.proposeStrategy({ name: "a" });
  lm.proposeStrategy({ name: "b" });
  lm.proposeStrategy({ name: "c" });
  const h = lm.getHistory(2);
  assert.equal(h.length, 2);
  assert.equal(h[0].name, "b");
  assert.equal(h[1].name, "c");
});

test("maxHistorySize: FIFO eviction", () => {
  const lm = createLifecycleManager({ config: { maxHistorySize: 3 } });
  lm.proposeStrategy({ name: "a" });
  lm.proposeStrategy({ name: "b" });
  lm.proposeStrategy({ name: "c" });
  lm.proposeStrategy({ name: "d" });
  const h = lm.getHistory();
  assert.equal(h.length, 3);
  assert.equal(h[0].name, "b");
  assert.equal(h[2].name, "d");
});

// ============================================================================
// state / restore
// ============================================================================
test("state/restore: round-trip preserves strategies", () => {
  const lm1 = createLifecycleManager();
  const s = lm1.proposeStrategy({ name: "s1", logic: "SMA" });
  lm1.promote(s.id, "INCUBATION");
  lm1.recordFill(s.id, { pnl: 42 });
  const saved = lm1.state();
  const lm2 = createLifecycleManager();
  lm2.restore(saved);
  const strat = lm2.getStrategy(s.id);
  assert.ok(strat);
  assert.equal(strat.name, "s1");
  assert.equal(strat.phase, "INCUBATION");
  assert.equal(strat.performance.totalPnl, 42);
  assert.equal(lm2.getHistory().length, lm1.getHistory().length);
});

test("state/restore: restore null is safe", () => {
  const lm = createLifecycleManager();
  lm.proposeStrategy({ name: "s1" });
  lm.restore(null);
  assert.equal(lm.listStrategies().length, 1);
});

test("state/restore: idCounter preserved for unique IDs", () => {
  const lm1 = createLifecycleManager();
  lm1.proposeStrategy({ name: "a" });
  lm1.proposeStrategy({ name: "b" });
  const saved = lm1.state();
  const lm2 = createLifecycleManager();
  lm2.restore(saved);
  const s3 = lm2.proposeStrategy({ name: "c" });
  assert.ok(s3.id.includes("strat_3"));
});

// ============================================================================
// reset
// ============================================================================
test("reset: clears all state", () => {
  const lm = createLifecycleManager();
  lm.proposeStrategy({ name: "a" });
  lm.proposeStrategy({ name: "b" });
  lm.reset();
  assert.equal(lm.listStrategies().length, 0);
  assert.equal(lm.getHistory().length, 0);
  assert.equal(lm.stats().totalStrategies, 0);
});

// ============================================================================
// computeRollingSharpe (_internals)
// ============================================================================
test("computeRollingSharpe: returns 0 for insufficient data", () => {
  const lm = createLifecycleManager();
  assert.equal(lm._internals.computeRollingSharpe([], 30), 0);
  assert.equal(lm._internals.computeRollingSharpe([1], 30), 0);
  assert.equal(lm._internals.computeRollingSharpe(null, 30), 0);
});

test("computeRollingSharpe: returns 0 for zero stddev", () => {
  const lm = createLifecycleManager();
  assert.equal(lm._internals.computeRollingSharpe([5, 5, 5, 5], 4), 0);
});

test("computeRollingSharpe: positive returns yield positive sharpe", () => {
  const lm = createLifecycleManager();
  const sharpe = lm._internals.computeRollingSharpe([10, 12, 11, 13, 14], 5);
  assert.ok(sharpe > 0);
});

test("computeRollingSharpe: negative returns yield negative sharpe", () => {
  const lm = createLifecycleManager();
  const sharpe = lm._internals.computeRollingSharpe([-10, -12, -11, -13, -14], 5);
  assert.ok(sharpe < 0);
});

test("computeRollingSharpe: window limits data used", () => {
  const lm = createLifecycleManager();
  const data = [];
  for (let i = 0; i < 10; i++) data.push(-100);
  // Last 5 entries: positive mean with nonzero variance so sharpe > 0
  data.push(40, 50, 60, 45, 55);
  const sharpe = lm._internals.computeRollingSharpe(data, 5);
  assert.ok(sharpe > 0);
});

// ============================================================================
// onReview exception safety
// ============================================================================
test("onReview: exception does not break checkRetirement", () => {
  const lm = createLifecycleManager({
    config: { rollingWindow60d: 4, minSharpe60d: 0.2 },
    onReview: () => { throw new Error("review crash"); },
  });
  const s = lm.proposeStrategy({ name: "s1" });
  for (let i = 0; i < 2; i++) {
    lm.recordFill(s.id, { pnl: -10, timestamp: new Date("2026-10-0" + (i + 1) + "T12:00:00Z").getTime() });
  }
  const result = lm.checkRetirement(s.id);
  assert.equal(result.shouldRetire, false);
});