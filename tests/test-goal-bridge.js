"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createGoalBridge, PHASE_TO_GOAL_STATE, DEFAULTS } = require("../src/agent/goal-bridge");

test("module exports createGoalBridge and constants", () => {
  assert.equal(typeof createGoalBridge, "function");
  assert.ok(PHASE_TO_GOAL_STATE);
  assert.equal(PHASE_TO_GOAL_STATE.INCUBATION, "running");
  assert.ok(DEFAULTS);
});

test("creates bridge with no goal client (graceful)", () => {
  const bridge = createGoalBridge({ lifecycleManager: {} });
  const s = bridge.stats();
  assert.equal(s.goalClientAvailable, false);
  assert.equal(s.activeGoalMappings, 0);
});

test("attach() returns false when no lifecycleManager", () => {
  const bridge = createGoalBridge({});
  const r = bridge.attach();
  assert.equal(r.attached, false);
  assert.equal(r.reason, "no_lifecycle_manager");
});

test("attach() returns true when lifecycleManager present", () => {
  const bridge = createGoalBridge({ lifecycleManager: { stats: function() { return {}; } } });
  const r = bridge.attach();
  assert.equal(r.attached, true);
});

test("specFor() returns null for invalid strategy", () => {
  const bridge = createGoalBridge({});
  assert.equal(bridge.specFor(null), null);
  assert.equal(bridge.specFor({}), null);
  assert.equal(bridge.specFor({ id: "x" }), null);
});

test("specFor() builds minitok-compatible goal spec", () => {
  const bridge = createGoalBridge({});
  const r = bridge.specFor({ id: "s1", name: "Momentum Alpha", hypothesis: "buy winners" });
  assert.ok(r);
  assert.equal(r.source, "goal-bridge");
  assert.equal(r.strategyId, "s1");
  assert.ok(r.goalId.startsWith("tossinvest-strategy-"));
  assert.equal(r.spec.schema_version, 1);
  assert.ok(r.spec.objective.includes("Momentum Alpha"));
  assert.ok(Array.isArray(r.spec.success_criteria));
  assert.ok(r.spec.success_criteria.length >= 1);
  assert.equal(r.spec.success_criteria[0].id, "hypothesis-validated");
  assert.equal(r.spec.execution_policy.mode, "safe");
});

test("specFor() uses strategy-accepted criterion when no hypothesis", () => {
  const bridge = createGoalBridge({});
  const r = bridge.specFor({ id: "s2", name: "No Hypothesis" });
  assert.equal(r.spec.success_criteria[0].id, "strategy-accepted");
});

test("onPromote/onRetire/onReview track counters without goal client", () => {
  const bridge = createGoalBridge({});
  bridge.onPromote("s1", "PRODUCTION", 1.0);
  bridge.onRetire("s2", "drawdown", "INCUBATION");
  bridge.onReview("s3", "sharpe low", { sharpe60d: 0.1 });
  const s = bridge.stats();
  assert.equal(s.counters.promotions, 1);
  assert.equal(s.counters.retirements, 1);
  assert.equal(s.counters.reviews, 1);
  assert.equal(bridge.getHistory().length, 3);
});

test("onPromote bridges to goalClient when mapping exists", () => {
  const calls = [];
  const mockGoal = {
    startGoal: function() { calls.push("start"); return { ok: true }; },
    continueGoal: function(args) { calls.push("continue:" + args.goal_id); return { ok: true }; },
    cancelGoal: function(args) { calls.push("cancel:" + args.goal_id); return { ok: true }; },
  };
  const bridge = createGoalBridge({
    goalClient: mockGoal, workspaceRoot: "/fake",
    config: { autoStartGoals: true },
  });
  bridge.startGoalFor({ id: "sX", name: "X", hypothesis: "h" });
  assert.ok(calls.includes("start"));
  assert.equal(bridge.stats().activeGoalMappings, 1);
  bridge.onPromote("sX", "PRODUCTION", 1.0);
  assert.ok(calls.some(function(c) { return c.startsWith("continue:"); }));
  bridge.onRetire("sX", "done", "PRODUCTION");
  assert.ok(calls.some(function(c) { return c.startsWith("cancel:"); }));
  assert.equal(bridge.stats().activeGoalMappings, 0);
});

test("startGoalFor handles goalClient errors gracefully", () => {
  const mockGoal = { startGoal: function() { throw new Error("boom"); } };
  const bridge = createGoalBridge({
    goalClient: mockGoal, workspaceRoot: "/fake",
    config: { autoStartGoals: true },
  });
  const r = bridge.startGoalFor({ id: "sY", name: "Y" });
  assert.equal(r, null);
  assert.equal(bridge.stats().counters.goalErrors, 1);
});

test("state() and restore() round-trip", () => {
  const bridge = createGoalBridge({});
  bridge.onPromote("a", "PRODUCTION", 1.0);
  bridge.onReview("b", "low", { sharpe60d: 0 });
  const snap = bridge.state();
  const bridge2 = createGoalBridge({});
  bridge2.restore(snap);
  assert.equal(bridge2.stats().counters.promotions, 1);
  assert.equal(bridge2.stats().counters.reviews, 1);
  assert.equal(bridge2.getHistory().length, 2);
});

test("getHistory respects limit and maxHistorySize", () => {
  const bridge = createGoalBridge({ config: { maxHistorySize: 5 } });
  for (let i = 0; i < 10; i++) bridge.onReview("s" + i, "reason", {});
  assert.equal(bridge.getHistory().length, 5);
  assert.equal(bridge.getHistory(2).length, 2);
});
