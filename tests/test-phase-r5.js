"use strict";
/**
 * Phase R-5 Tests — Execution Layer.
 * Covers: param-tuner, traffic-splitter, action-registry,
 * and the end-to-end closed loop (hypothesis → experiment → verdict → apply).
 */
var assert = require("node:assert");
var { createParamTuner } = require("../src/intelligence/param-tuner");
var { createTrafficSplitter } = require("../src/intelligence/traffic-splitter");
var { createActionRegistry } = require("../src/intelligence/action-registry");
var { createSelfHealer } = require("../src/orchestrator/self-healing");
var { createStrategyOrchestrator } = require("../src/strategy/orchestrator");
var { createExperimentEngine } = require("../src/intelligence/experiment");
var { createAutoLoop } = require("../src/intelligence/auto-loop");

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ok " + name); }
  catch (e) { failed++; console.log("  X " + name + " :: " + e.message); }
}
function makeSelfHealer() { return createSelfHealer({}); }
function makeOrchestrator() {
  var o = createStrategyOrchestrator({});
  o.registerStrategy("base_signals");
  o.registerStrategy("momentum");
  return o;
}

// ===== PARAM-TUNER =====
console.log("\n[param-tuner]");
test("apply selfhealer_cooldown via setter API", function() {
  var sh = makeSelfHealer();
  var prev = sh.getCooldowns().DATA_DRIFT;
  var pt = createParamTuner({ selfHealer: sh });
  var r = pt.apply({ kind: "selfhealer_cooldown", incidentType: "DATA_DRIFT", multiplier: 2.0 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.prev, prev);
  assert.strictEqual(r.next, prev * 2);
  assert.strictEqual(sh.getCooldowns().DATA_DRIFT, prev * 2);
});
test("apply selfhealer_cooldown without selfHealer fails", function() {
  var pt = createParamTuner({});
  var r = pt.apply({ kind: "selfhealer_cooldown", incidentType: "DATA_DRIFT", multiplier: 2 });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /not wired/);
});
test("apply selfhealer_cooldown rejects unknown type", function() {
  var sh = makeSelfHealer();
  var pt = createParamTuner({ selfHealer: sh });
  var r = pt.apply({ kind: "selfhealer_cooldown", incidentType: "NOT_A_TYPE", multiplier: 2 });
  assert.strictEqual(r.ok, false);
});
test("apply selfhealer_cooldown clamps multiplier", function() {
  var sh = makeSelfHealer();
  var pt = createParamTuner({ selfHealer: sh });
  var prev = sh.getCooldowns().API_TRANSIENT;
  var r = pt.apply({ kind: "selfhealer_cooldown", incidentType: "API_TRANSIENT", multiplier: 99999 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.next, Math.max(1000, Math.round(prev * 10.0)));
});
test("apply selfhealer_escalation via setter", function() {
  var sh = makeSelfHealer();
  var pt = createParamTuner({ selfHealer: sh });
  var r = pt.apply({ kind: "selfhealer_escalation", value: 7 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.next, 7);
  assert.strictEqual(sh.getConfig().escalationThreshold, 7);
});
test("apply selfhealer_escalation clamps to [1,20]", function() {
  var sh = makeSelfHealer();
  var pt = createParamTuner({ selfHealer: sh });
  var r = pt.apply({ kind: "selfhealer_escalation", value: 999 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.next, 20);
});
test("apply strategy_weight via setWeight", function() {
  var orch = makeOrchestrator();
  var pt = createParamTuner({ strategyOrchestrator: orch });
  var r = pt.apply({ kind: "strategy_weight", strategy: "base_signals", weight: 0.7 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(orch.getWeight("base_signals"), 0.7);
});
test("apply strategy_weight rejects unregistered", function() {
  var orch = makeOrchestrator();
  var pt = createParamTuner({ strategyOrchestrator: orch });
  var r = pt.apply({ kind: "strategy_weight", strategy: "nope", weight: 0.5 });
  assert.strictEqual(r.ok, false);
});
test("apply custom override stores value", function() {
  var pt = createParamTuner({});
  var r = pt.apply({ kind: "custom", key: "foo", value: { bar: 1 } });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(pt.getOverride("foo").value, { bar: 1 });
});
test("stats counters reflect applied/rejected", function() {
  var sh = makeSelfHealer();
  var pt = createParamTuner({ selfHealer: sh });
  pt.apply({ kind: "selfhealer_escalation", value: 5 });
  pt.apply({ kind: "bad_kind" });
  pt.apply(null);
  var s = pt.stats();
  assert.strictEqual(s.applied, 1);
  assert.strictEqual(s.rejected, 2);
});
test("dryRun mode does not mutate selfHealer", function() {
  var sh = makeSelfHealer();
  var prev = sh.getConfig().escalationThreshold;
  var pt = createParamTuner({ selfHealer: sh, dryRun: true });
  var r = pt.apply({ kind: "selfhealer_escalation", value: 15 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.dryRun, true);
  assert.strictEqual(sh.getConfig().escalationThreshold, prev);
});

// ===== TRAFFIC-SPLITTER =====
console.log("\n[traffic-splitter]");
test("route returns deterministic arm for same key", function() {
  var ts = createTrafficSplitter({});
  ts.registerExperiment("e1", { ratio: 0.5 });
  var a1 = ts.route("e1", { symbol: "005930" });
  var a2 = ts.route("e1", { symbol: "005930" });
  var a3 = ts.route("e1", { symbol: "005930" });
  assert.strictEqual(a1, a2);
  assert.strictEqual(a2, a3);
  assert.ok(a1 === "control" || a1 === "treatment");
});
test("route returns null for unregistered experiment", function() {
  var ts = createTrafficSplitter({});
  var r = ts.route("missing", { symbol: "X" });
  assert.strictEqual(r, null);
  assert.strictEqual(ts.stats().unregistered, 1);
});
test("distribution roughly matches ratio over many keys", function() {
  var ts = createTrafficSplitter({});
  ts.registerExperiment("e2", { ratio: 0.5 });
  var counts = { control: 0, treatment: 0 };
  for (var i = 0; i < 1000; i++) {
    var arm = ts.route("e2", { symbol: "SYM" + i });
    counts[arm]++;
  }
  var ratio = counts.treatment / (counts.control + counts.treatment);
  assert.ok(ratio > 0.35 && ratio < 0.65, "ratio was " + ratio);
});
test("recordOutcome forwards to experimentEngine.recordSample", function() {
  var exp = createExperimentEngine();
  var id = exp.createExperiment({ name: "test-exp" });
  var ts = createTrafficSplitter({ experimentEngine: exp });
  var r = ts.recordOutcome(id, "treatment", 42);
  assert.strictEqual(r.arm, "treatment");
  assert.strictEqual(r.samples, 1);
  assert.strictEqual(exp.getExperiment(id).treatment.length, 1);
});
test("recordOutcome rejects invalid arm", function() {
  var exp = createExperimentEngine();
  var id = exp.createExperiment({ name: "x" });
  var ts = createTrafficSplitter({ experimentEngine: exp });
  var r = ts.recordOutcome(id, "bogus", 1);
  assert.strictEqual(r.ok, false);
});
test("unregisterExperiment removes entry", function() {
  var ts = createTrafficSplitter({});
  ts.registerExperiment("e3", { ratio: 0.5 });
  assert.strictEqual(ts.list().length, 1);
  ts.unregisterExperiment("e3");
  assert.strictEqual(ts.list().length, 0);
});

// ===== ACTION-REGISTRY =====
console.log("\n[action-registry]");
test("install registers 5 handlers into autoLoop", function() {
  var sh = makeSelfHealer();
  var exp = createExperimentEngine();
  var pt = createParamTuner({ selfHealer: sh });
  var ts = createTrafficSplitter({ experimentEngine: exp });
  var al = createAutoLoop({ selfHealer: sh, experimentEngine: exp, hypothesisEngine: { rankProposals: function() { return []; } } });
  var ar = createActionRegistry({ paramTuner: pt, trafficSplitter: ts, autoLoop: al, experimentEngine: exp });
  var r = ar.install();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.installed, 5);
  assert.ok(r.types.includes("blind_spot_fix"));
  assert.ok(r.types.includes("improve_fill_rate"));
  assert.strictEqual(al.stats().registeredActions, 5);
});
test("install fails when autoLoop.registerAction missing", function() {
  var ar = createActionRegistry({ autoLoop: {} });
  var r = ar.install();
  assert.strictEqual(r.ok, false);
});
test("blindSpotFix handler returns logged_only", function() {
  var ar = createActionRegistry({});
  var r = ar._handlers.blind_spot_fix({ id: "h1", statement: "blind spot" });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.action, "logged_only");
});
test("reduceAlertNoise handler bumps DATA_DRIFT cooldown", function() {
  var sh = makeSelfHealer();
  var pt = createParamTuner({ selfHealer: sh });
  var ar = createActionRegistry({ paramTuner: pt });
  var prev = sh.getCooldowns().DATA_DRIFT;
  var r = ar._handlers.reduce_alert_noise({ id: "h2", statement: "noisy alerts" });
  assert.strictEqual(r.ok, true);
  assert.ok(sh.getCooldowns().DATA_DRIFT > prev);
});
test("improveFillRate handler creates experiment + traffic routing", function() {
  var exp = createExperimentEngine();
  var ts = createTrafficSplitter({ experimentEngine: exp });
  var ar = createActionRegistry({ trafficSplitter: ts, experimentEngine: exp });
  var r = ar._handlers.improve_fill_rate({ id: "h_fill_1", statement: "improve fills" });
  assert.strictEqual(r.ok, true);
  assert.ok(r.experimentId);
  assert.strictEqual(ts.list().length, 1);
  assert.strictEqual(ts.list()[0].id, r.experimentId);
  var e = exp.getExperiment(r.experimentId);
  assert.ok(e);
  assert.strictEqual(e.hypothesisId, "h_fill_1");
});
test("incidentLossMitigation handler raises escalation threshold", function() {
  var sh = makeSelfHealer();
  var pt = createParamTuner({ selfHealer: sh });
  var ar = createActionRegistry({ paramTuner: pt });
  var r = ar._handlers.incident_loss_mitigation({ id: "h3", statement: "losses" });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(sh.getConfig().escalationThreshold, 5);
});
test("dataQualityCheck handler stores custom override", function() {
  var pt = createParamTuner({});
  var ar = createActionRegistry({ paramTuner: pt });
  var r = ar._handlers.data_quality_check({ id: "h_dq_9", statement: "check data" });
  assert.strictEqual(r.ok, true);
  assert.ok(pt.getOverride("dq_h_dq_9"));
});
test("stats tracks installed/invoked/succeeded/failed", function() {
  var sh = makeSelfHealer();
  var pt = createParamTuner({ selfHealer: sh });
  var ar = createActionRegistry({ paramTuner: pt });
  ar._handlers.blind_spot_fix({ id: "x", statement: "s" });
  ar._handlers.reduce_alert_noise({ id: "y", statement: "s" });
  var s = ar.stats();
  assert.strictEqual(s.succeeded, 2);
  assert.strictEqual(s.auditSize, 2);
});

// ===== SELF-HEALING R-5 SETTERS =====
console.log("\n[self-healing R-5 setters]");
test("setCooldown updates and returns prev/next", function() {
  var sh = makeSelfHealer();
  var prev = sh.getCooldowns().API_TRANSIENT;
  var r = sh.setCooldown("API_TRANSIENT", 120000);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.prev, prev);
  assert.strictEqual(r.next, 120000);
  assert.strictEqual(sh.getCooldowns().API_TRANSIENT, 120000);
});
test("setCooldown rejects unknown type", function() {
  var sh = makeSelfHealer();
  var r = sh.setCooldown("NOT_REAL", 1000);
  assert.strictEqual(r.ok, false);
});
test("setConfig updates escalationThreshold", function() {
  var sh = makeSelfHealer();
  var r = sh.setConfig("escalationThreshold", 10);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(sh.getConfig().escalationThreshold, 10);
});
test("setConfig rejects unknown key", function() {
  var sh = makeSelfHealer();
  var r = sh.setConfig("nonexistentKey", 1);
  assert.strictEqual(r.ok, false);
});

// ===== ORCHESTRATOR R-5 SETTERS =====
console.log("\n[orchestrator R-5 setters]");
test("setWeight updates allocation for registered strategy", function() {
  var o = makeOrchestrator();
  var r = o.setWeight("base_signals", 0.8);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(o.getWeight("base_signals"), 0.8);
});
test("setWeight rejects unregistered strategy", function() {
  var o = makeOrchestrator();
  var r = o.setWeight("nope", 0.5);
  assert.strictEqual(r.ok, false);
});
test("setWeight rejects out-of-range weight", function() {
  var o = makeOrchestrator();
  var r = o.setWeight("base_signals", 1.5);
  assert.strictEqual(r.ok, false);
});
test("normalizeAllocation rescales to sum=1.0", function() {
  var o = makeOrchestrator();
  o.setWeight("base_signals", 0.9);
  o.setWeight("momentum", 0.3);
  var r = o.normalizeAllocation();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.changed, true);
  var alloc = o.getAllocation();
  var sum = alloc.base_signals + alloc.momentum;
  assert.ok(Math.abs(sum - 1.0) < 1e-6, "sum=" + sum);
});

// ===== END-TO-END CLOSED LOOP =====
console.log("\n[e2e closed loop]");
test("hypothesis -> autoLoop -> experiment -> verdict -> apply", function() {
  var hypotheses = [{
    id: "hyp_e2e_1",
    type: "improve_fill_rate",
    statement: "Increase fill rate by adjusting limit offsets",
    score: 3.0,
    expectedImpact: "high",
    action: "experiment",
  }];
  var outcomes = {};
  var hypEngine = {
    rankProposals: function() { return hypotheses; },
    trackOutcome: function(id, o) { outcomes[id] = o; },
    getHypotheses: function() { return hypotheses; },
  };
  var sh = makeSelfHealer();
  var exp = createExperimentEngine();
  var pt = createParamTuner({ selfHealer: sh });
  var ts = createTrafficSplitter({ experimentEngine: exp });
  var al = createAutoLoop({ selfHealer: sh, experimentEngine: exp, hypothesisEngine: hypEngine, cooldownMs: 0 });
  var ar = createActionRegistry({
    paramTuner: pt, trafficSplitter: ts, autoLoop: al,
    hypothesisEngine: hypEngine, experimentEngine: exp,
  });
  ar.install();
  var loopRes = al.evaluate();
  assert.strictEqual(loopRes.actions.length, 1);
  assert.strictEqual(loopRes.actions[0].action, "registered");
  var running = exp.list("running");
  assert.strictEqual(running.length, 1);
  assert.strictEqual(running[0].hypothesisId, "hyp_e2e_1");
  assert.strictEqual(ts.list().length, 1);
  var expId = running[0].id;
  for (var i = 0; i < 15; i++) {
    exp.recordSample(expId, "treatment", 100 + i * 2);
    exp.recordSample(expId, "control", 50 + i);
  }
  var ev = exp.evaluate(expId);
  assert.strictEqual(ev.evaluation.verdict, "treatment_better");
  assert.strictEqual(ev.evaluation.significant, true);
  var applied = ar._handlers.improve_fill_rate(hypotheses[0]);
  assert.strictEqual(applied.ok, true);
  assert.ok(applied.experimentId);
  var arStats = ar.stats();
  assert.ok(arStats.invoked >= 1);
  assert.ok(arStats.succeeded >= 1);
});
test("route distribution stable across splitter instances", function() {
  var ts1 = createTrafficSplitter({});
  var ts2 = createTrafficSplitter({});
  ts1.registerExperiment("stable_exp", { ratio: 0.5 });
  ts2.registerExperiment("stable_exp", { ratio: 0.5 });
  for (var i = 0; i < 50; i++) {
    var ctx = { symbol: "STOCK" + i };
    assert.strictEqual(ts1.route("stable_exp", ctx), ts2.route("stable_exp", ctx));
  }
});

console.log("\n========================================");
console.log("Phase R-5 Results: " + passed + " passed, " + failed + " failed");
console.log("========================================\n");
process.exit(failed > 0 ? 1 : 0);
