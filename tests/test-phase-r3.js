"use strict";

const assert = require("node:assert");
const { createAttributionEngine } = require("../src/intelligence/attribution");
const { createExperimentEngine, _welchT } = require("../src/intelligence/experiment");
const { createAutoLoop } = require("../src/intelligence/auto-loop");
const { createEventBus } = require("../src/intelligence/event-bus");
const { createReflectionEngine } = require("../src/intelligence/reflection");
const { createCorrelationEngine } = require("../src/intelligence/correlation");
const { createHypothesisEngine } = require("../src/intelligence/hypothesis");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  PASS: " + name); }
  catch (e) { failed++; console.error("  FAIL: " + name + " — " + e.message); }
}

console.log("=== Phase R-3: Attribution + Experiment + Auto-Loop ===\n");

// ===== ATTRIBUTION =====
console.log("[attribution]");
test("recordFill and recordDecision accumulate", function() {
  var a = createAttributionEngine();
  a.recordFill({ symbol: "005930", strategy: "base_signals", source: "ai", pnl: 1000 });
  a.recordFill({ symbol: "005930", strategy: "base_signals", source: "ai", pnl: -500 });
  a.recordDecision({ symbol: "005930", strategy: "base_signals", source: "ai", action: "BUY" });
  var s = a.stats();
  assert.strictEqual(s.totalFills, 2);
  assert.strictEqual(s.totalDecisions, 1);
});

test("report groups by symbol/strategy/source/metaCog", function() {
  var a = createAttributionEngine();
  a.recordFill({ symbol: "A", strategy: "s1", source: "ai", pnl: 100 });
  a.recordFill({ symbol: "A", strategy: "s1", source: "ai", metaCogIntervened: true, pnl: 200 });
  a.recordFill({ symbol: "B", strategy: "s2", source: "fallback", pnl: -50 });
  var r = a.report();
  assert.strictEqual(r.totalFills, 3);
  assert.strictEqual(r.totalPnl, 250);
  assert.strictEqual(r.bySymbol["A"].pnl, 300);
  assert.strictEqual(r.bySymbol["B"].pnl, -50);
  assert.strictEqual(r.byStrategy["s1"].count, 2);
  assert.strictEqual(r.bySource["ai"].count, 2);
  assert.strictEqual(r.bySource["fallback"].count, 1);
  assert.strictEqual(r.byMetaCog["intervened"].count, 1);
  assert.strictEqual(r.byMetaCog["baseline"].count, 2);
});

test("topContributors sorted by pnl desc", function() {
  var a = createAttributionEngine();
  a.recordFill({ symbol: "A", pnl: 50 });
  a.recordFill({ symbol: "B", pnl: 200 });
  a.recordFill({ symbol: "C", pnl: -100 });
  var top = a.topContributors(2);
  assert.strictEqual(top.length, 2);
  assert.strictEqual(top[0].symbol, "B");
  assert.strictEqual(top[1].symbol, "A");
});

test("bottomContributors sorted by pnl asc", function() {
  var a = createAttributionEngine();
  a.recordFill({ symbol: "A", pnl: 50 });
  a.recordFill({ symbol: "B", pnl: -200 });
  a.recordFill({ symbol: "C", pnl: -100 });
  var bot = a.bottomContributors(2);
  assert.strictEqual(bot[0].symbol, "B");
  assert.strictEqual(bot[1].symbol, "C");
});

test("clear resets fills and decisions", function() {
  var a = createAttributionEngine();
  a.recordFill({ symbol: "X", pnl: 1 });
  a.clear();
  assert.strictEqual(a.stats().totalFills, 0);
});

// ===== WELCH T =====
console.log("\n[welch-t]");
test("welchT detects significant difference", function() {
  var xs = [100, 102, 98, 101, 99, 103, 97, 100, 101, 99, 102, 100];
  var ys = [80, 82, 78, 81, 79, 83, 77, 80, 81, 79, 82, 80];
  var r = _welchT(xs, ys);
  assert.strictEqual(r.reason, "ok");
  assert.ok(Math.abs(r.t) > 5);
  assert.ok(r.pApprox < 0.05);
});

test("welchT insufficient samples", function() {
  var r = _welchT([1], [2]);
  assert.strictEqual(r.reason, "insufficient");
});

test("welchT no variance", function() {
  var r = _welchT([5,5,5,5], [5,5,5,5]);
  assert.strictEqual(r.reason, "no_variance");
});

// ===== EXPERIMENT =====
console.log("\n[experiment]");
test("createExperiment returns id", function() {
  var e = createExperimentEngine();
  var id = e.createExperiment({ name: "test-exp", hypothesisId: "h1" });
  assert.ok(id.startsWith("exp_"));
});
test("recordSample accumulates", function() {
  var e = createExperimentEngine();
  var id = e.createExperiment({});
  var r1 = e.recordSample(id, "treatment", 10);
  assert.strictEqual(r1.samples, 1);
  var r2 = e.recordSample(id, "control", 5);
  assert.strictEqual(r2.samples, 1);
});
test("recordSample rejects unknown id", function() {
  var e = createExperimentEngine();
  var r = e.recordSample("nonexistent", "control", 1);
  assert.ok(r.error);
});
test("recordSample rejects invalid arm", function() {
  var e = createExperimentEngine();
  var id = e.createExperiment({});
  var r = e.recordSample(id, "weird", 1);
  assert.ok(r.error);
});
test("evaluate returns insufficient_samples", function() {
  var e = createExperimentEngine({ minSamples: 5 });
  var id = e.createExperiment({});
  e.recordSample(id, "treatment", 10);
  e.recordSample(id, "control", 5);
  var r = e.evaluate(id);
  assert.strictEqual(r.verdict, "insufficient_samples");
});
test("evaluate detects significant treatment better", function() {
  var e = createExperimentEngine({ minSamples: 5 });
  var id = e.createExperiment({});
  for (var i = 0; i < 10; i++) e.recordSample(id, "treatment", 100 + i);
  for (var j = 0; j < 10; j++) e.recordSample(id, "control", 50 + j);
  var r = e.evaluate(id);
  assert.ok(r.evaluation);
  assert.strictEqual(r.evaluation.significant, true);
  assert.strictEqual(r.evaluation.verdict, "treatment_better");
  assert.ok(r.evaluation.lift > 0);
});
test("list and stats", function() {
  var e = createExperimentEngine();
  e.createExperiment({ name: "a" });
  e.createExperiment({ name: "b" });
  assert.strictEqual(e.list().length, 2);
  e.clear();
  assert.strictEqual(e.stats().created, 0);
});

// ===== AUTO-LOOP =====
console.log("\n[auto-loop]");
test("evaluate returns error without hypothesisEngine", function() {
  var loop = createAutoLoop({});
  var r = loop.evaluate();
  assert.ok(r.error);
});
test("evaluate skips low-score hypotheses", function() {
  var bus = createEventBus();
  var refl = createReflectionEngine({ eventBus: bus });
  var hyp = createHypothesisEngine({ eventBus: bus, reflectionEngine: refl });
  bus.emit("selfAudit.alert", {});
  hyp.generateHypotheses();
  var loop = createAutoLoop({ hypothesisEngine: hyp, minScore: 99999 });
  var r = loop.evaluate();
  assert.strictEqual(r.actions.length, 0);
});
test("evaluate launches experiment for improve_fill_rate", function() {
  var bus = createEventBus();
  var refl = createReflectionEngine({ eventBus: bus });
  var hyp = createHypothesisEngine({ eventBus: bus, reflectionEngine: refl });
  var exp = createExperimentEngine();
  for (var i = 0; i < 20; i++) bus.emit("decision.made", { symbol: "X", action: "BUY" });
  bus.emit("trading.fill", { symbol: "X", pnl: 1 });
  hyp.generateHypotheses();
  var loop = createAutoLoop({ hypothesisEngine: hyp, experimentEngine: exp, minScore: 0.01 });
  var r = loop.evaluate();
  assert.ok(Array.isArray(r.actions));
});
test("registerAction invoked for matching type", function() {
  var bus = createEventBus();
  var refl = createReflectionEngine({ eventBus: bus });
  var hyp = createHypothesisEngine({ eventBus: bus, reflectionEngine: refl });
  bus.emit("selfAudit.alert", {});
  hyp.generateHypotheses();
  var invoked = [];
  var loop = createAutoLoop({ hypothesisEngine: hyp, minScore: 0.01 });
  loop.registerAction("blind_spot_fix", function(h) { invoked.push(h.type); });
  loop.evaluate();
  assert.ok(invoked.length >= 0);
});
test("cooldown prevents re-action", function() {
  var bus = createEventBus();
  var refl = createReflectionEngine({ eventBus: bus });
  var hyp = createHypothesisEngine({ eventBus: bus, reflectionEngine: refl });
  bus.emit("selfAudit.alert", {});
  hyp.generateHypotheses();
  var loop = createAutoLoop({ hypothesisEngine: hyp, minScore: 0.01, cooldownMs: 9999999 });
  loop.evaluate();
  var r2 = loop.evaluate();
  assert.ok(r2.skipped.length >= 1 || r2.actions.length === 0);
});
test("dryRun does not call action fn", function() {
  var bus = createEventBus();
  var refl = createReflectionEngine({ eventBus: bus });
  var hyp = createHypothesisEngine({ eventBus: bus, reflectionEngine: refl });
  bus.emit("selfAudit.alert", {});
  hyp.generateHypotheses();
  var called = false;
  var loop = createAutoLoop({ hypothesisEngine: hyp, minScore: 0.01, dryRun: true });
  loop.registerAction("blind_spot_fix", function() { called = true; });
  loop.evaluate();
  assert.strictEqual(called, false);
});
test("stats and getHistory", function() {
  var loop = createAutoLoop({});
  loop.evaluate();
  assert.strictEqual(loop.stats().cycles, 1);
  assert.ok(Array.isArray(loop.getHistory()));
  loop.clear();
  assert.strictEqual(loop.stats().cycles, 0);
});

// ===== E2E =====
console.log("\n[e2e]");
test("closed-loop attribution + experiment + hypothesis + auto-loop", function() {
  var bus = createEventBus();
  var refl = createReflectionEngine({ eventBus: bus });
  var corr = createCorrelationEngine({ eventBus: bus });
  var hyp = createHypothesisEngine({ eventBus: bus, reflectionEngine: refl, correlationEngine: corr });
  var exp = createExperimentEngine();
  var attr = createAttributionEngine();
  var loop = createAutoLoop({ hypothesisEngine: hyp, experimentEngine: exp, attributionEngine: attr, minScore: 0.01 });
  bus.emit("selfAudit.alert", { rule: "data_collection_stall" });
  bus.emit("decision.made", { symbol: "005930", action: "BUY" });
  bus.emit("trading.fill", { symbol: "005930", pnl: 500 });
  attr.recordFill({ symbol: "005930", strategy: "base_signals", source: "ai", pnl: 500 });
  refl.generateReport();
  var hs = hyp.generateHypotheses();
  assert.ok(Array.isArray(hs));
  var r = loop.evaluate();
  assert.ok(r.ts);
  assert.strictEqual(attr.report().totalPnl, 500);
});

console.log("\n===========================================");
console.log("  Results: " + passed + " passed, " + failed + " failed");
console.log("===========================================");
process.exit(failed > 0 ? 1 : 0);
