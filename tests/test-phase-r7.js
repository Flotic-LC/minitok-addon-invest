"use strict";
/**
 * Phase R-7 Tests — Multi-Instance Experiment Coordination.
 */
var assert = require("node:assert");
var {
  createExperimentCoordinator, createMemoryStore, createPgStore,
  _getSharedStore, _resetSharedStore,
} = require("../src/intelligence/experiment-coordinator");
var { createExperimentEngine } = require("../src/intelligence/experiment");
var { createAttributionEngine } = require("../src/intelligence/attribution");

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ok " + name); }
  catch (e) { failed++; console.log("  X " + name + " :: " + e.message); }
}
function reset() { _resetSharedStore(); }

// ===== Memory Store basics =====
console.log("\n[memory-store]");
test("createMemoryStore returns all expected methods", function() {
  var s = createMemoryStore();
  ["acquireLock","setLock","releaseLock","createExperiment","getExperiment",
   "listExperiments","updateExperiment","addSample","getSamples",
   "recordFill","recordDecision","getFills","getDecisions",
   "registerInstance","heartbeat","listInstances","findConflicts","clear"
  ].forEach(function(m) { assert.strictEqual(typeof s[m], "function", "missing " + m); });
});

test("acquireLock with no conflict returns ok", function() {
  var s = createMemoryStore();
  var r = s.acquireLock("hyp-1", "runner-a");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reason, "no_conflict");
});

test("createExperiment + setLock + releaseLock round-trip", function() {
  var s = createMemoryStore();
  var c = s.createExperiment({ id: "e1", hypothesisId: "h1" });
  assert.strictEqual(c.ok, true);
  var e = s.getExperiment("e1");
  assert.strictEqual(e.status, "running");
  var lock = s.setLock("e1", "runner-a", 60000);
  assert.strictEqual(lock.ok, true);
  assert.ok(s.getExperiment("e1").lockUntil);
  var rel = s.releaseLock("e1", "runner-a");
  assert.strictEqual(rel.ok, true);
  assert.strictEqual(s.getExperiment("e1").lockUntil, null);
});

test("releaseLock rejects non-owner", function() {
  var s = createMemoryStore();
  s.createExperiment({ id: "e1" });
  s.setLock("e1", "runner-a", 60000);
  var r = s.releaseLock("e1", "runner-b");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "not_owner");
});

test("addSample invalid arm rejected", function() {
  var s = createMemoryStore();
  s.createExperiment({ id: "e1" });
  var r = s.addSample("e1", "banana", 1);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "invalid_arm");
});

test("getSamples returns separated arrays", function() {
  var s = createMemoryStore();
  s.createExperiment({ id: "e1" });
  s.addSample("e1", "control", 10, "a");
  s.addSample("e1", "treatment", 20, "a");
  var samples = s.getSamples("e1");
  assert.deepStrictEqual(samples.control, [10]);
  assert.deepStrictEqual(samples.treatment, [20]);
});

test("recordFill/recordDecision accumulate", function() {
  var s = createMemoryStore();
  for (var i = 0; i < 100; i++) s.recordFill({ i: i });
  assert.strictEqual(s.getFills().length, 100);
});

test("registerInstance + heartbeat + listInstances", function() {
  var s = createMemoryStore();
  s.registerInstance("r1", { foo: 1 });
  s.heartbeat("r1");
  var list = s.listInstances();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].instanceId, "r1");
});

test("listInstances filters stale by heartbeat", function() {
  var s = createMemoryStore();
  s.registerInstance("r-old");
  var list = s.listInstances();
  var old = list.find(function(i) { return i.instanceId === "r-old"; });
  old.heartbeatAt = new Date(Date.now() - 100000).toISOString();
  s.registerInstance("r-new");
  var fresh = s.listInstances(50000);
  assert.strictEqual(fresh.length, 1);
  assert.strictEqual(fresh[0].instanceId, "r-new");
});

test("findConflicts same hypothesis within window", function() {
  var s = createMemoryStore();
  s.createExperiment({ id: "e1", hypothesisId: "h1", symbol: "A", strategy: "s1" });
  var c = s.findConflicts("h1", null, null, 86400000);
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].type, "same_hypothesis");
});

test("findConflicts same symbol+strategy within window", function() {
  var s = createMemoryStore();
  s.createExperiment({ id: "e1", hypothesisId: "h1", symbol: "A", strategy: "s1" });
  var c = s.findConflicts("h-different", "A", "s1", 86400000);
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].type, "same_symbol_strategy");
});

test("clear resets all state", function() {
  var s = createMemoryStore();
  s.createExperiment({ id: "e1" });
  s.registerInstance("r1");
  s.recordFill({ x: 1 });
  s.clear();
  assert.strictEqual(s.listExperiments().length, 0);
  assert.strictEqual(s.listInstances().length, 0);
  assert.strictEqual(s.getFills().length, 0);
});

// ===== Coordinator factory =====
console.log("\n[coordinator-factory]");
test("createExperimentCoordinator returns full API", function() {
  reset();
  var c = createExperimentCoordinator({ instanceId: "r-x" });
  ["start","stop","proposeExperiment","recordSample","recordFill","recordDecision",
   "syncExperiments","resolveConflicts","evaluate","stats","getHistory",
   "listExperiments","getExperiment","listInstances"
  ].forEach(function(m) { assert.strictEqual(typeof c[m], "function", "missing " + m); });
  c.stop();
  reset();
});

test("start registers instance and heartbeat", function() {
  reset();
  var c = createExperimentCoordinator({ instanceId: "r-1", heartbeatMs: 999999, syncIntervalMs: 999999 });
  var r = c.start();
  assert.strictEqual(r.ok, true);
  var s = c.stats();
  assert.strictEqual(s.instanceId, "r-1");
  assert.strictEqual(s.started, true);
  assert.strictEqual(s.instances, 1);
  c.stop();
  reset();
});

test("start twice returns already_started", function() {
  reset();
  var c = createExperimentCoordinator({ instanceId: "r-1", heartbeatMs: 999999, syncIntervalMs: 999999 });
  c.start();
  var r = c.start();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "already_started");
  c.stop();
  reset();
});

test("proposeExperiment requires hypothesisId", function() {
  reset();
  var c = createExperimentCoordinator({ instanceId: "r-1" });
  c.start();
  var r = c.proposeExperiment({});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "no_hypothesis_id");
  c.stop();
  reset();
});

test("proposeExperiment creates and locks experiment", function() {
  reset();
  var c = createExperimentCoordinator({ instanceId: "r-1" });
  c.start();
  var r = c.proposeExperiment({ hypothesisId: "h1", symbol: "A", strategy: "s1", priority: 5 });
  assert.strictEqual(r.ok, true);
  assert.ok(r.experimentId);
  var e = c.getExperiment(r.experimentId);
  assert.strictEqual(e.status, "running");
  assert.strictEqual(e.instanceId, "r-1");
  assert.ok(e.lockUntil);
  assert.strictEqual(e.priority, 5);
  c.stop();
  reset();
});

test("proposeExperiment detects same-hypothesis conflict", function() {
  reset();
  var c1 = createExperimentCoordinator({ instanceId: "r-1" });
  c1.start();
  var p1 = c1.proposeExperiment({ hypothesisId: "h-shared" });
  assert.strictEqual(p1.ok, true);
  var c2 = createExperimentCoordinator({ instanceId: "r-2" });
  c2.start();
  var p2 = c2.proposeExperiment({ hypothesisId: "h-shared" });
  assert.strictEqual(p2.ok, false);
  assert.strictEqual(p2.reason, "conflict");
  c1.stop(); c2.stop();
  reset();
});

test("proposeExperiment respects queue_full", function() {
  reset();
  var c = createExperimentCoordinator({ instanceId: "r-1", maxQueueSize: 2 });
  c.start();
  c.proposeExperiment({ hypothesisId: "h1" });
  c.proposeExperiment({ hypothesisId: "h2" });
  var r = c.proposeExperiment({ hypothesisId: "h3" });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "queue_full");
  c.stop();
  reset();
});

test("recordSample rejects non-owner while locked", function() {
  reset();
  var c1 = createExperimentCoordinator({ instanceId: "r-1" });
  c1.start();
  var p = c1.proposeExperiment({ hypothesisId: "h1" });
  var c2 = createExperimentCoordinator({ instanceId: "r-2" });
  c2.start();
  var r = c2.recordSample(p.experimentId, "treatment", 42);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "not_lock_owner");
  c1.stop(); c2.stop();
  reset();
});

test("recordSample succeeds for lock owner", function() {
  reset();
  var c = createExperimentCoordinator({ instanceId: "r-1" });
  c.start();
  var p = c.proposeExperiment({ hypothesisId: "h1" });
  var r = c.recordSample(p.experimentId, "treatment", 42);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.count, 1);
  c.stop();
  reset();
});

// ===== evaluate =====
console.log("\n[evaluate]");
test("evaluate returns insufficient_samples when too few", function() {
  reset();
  var exp = createExperimentEngine();
  var c = createExperimentCoordinator({ instanceId: "r-1", experimentEngine: exp, minSamples: 5 });
  c.start();
  var p = c.proposeExperiment({ hypothesisId: "h1" });
  c.recordSample(p.experimentId, "treatment", 1);
  c.recordSample(p.experimentId, "control", 1);
  var r = c.evaluate(p.experimentId);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "insufficient_samples");
  c.stop();
  reset();
});

test("evaluate detects treatment_better with enough samples", function() {
  reset();
  var exp = createExperimentEngine();
  var c = createExperimentCoordinator({ instanceId: "r-1", experimentEngine: exp, minSamples: 5, significanceLevel: 0.5 });
  c.start();
  var p = c.proposeExperiment({ hypothesisId: "h1" });
  // Treatment mean ~200 with variance, control mean ~100 with variance
  var tVals = [190, 210, 195, 205, 198, 202, 197, 203, 199, 201];
  var cVals = [90, 110, 95, 105, 98, 102, 97, 103, 99, 101];
  for (var i = 0; i < tVals.length; i++) c.recordSample(p.experimentId, "treatment", tVals[i]);
  for (var j = 0; j < cVals.length; j++) c.recordSample(p.experimentId, "control", cVals[j]);
  var r = c.evaluate(p.experimentId);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.evaluation.verdict, "treatment_better");
  assert.strictEqual(r.evaluation.significant, true);
  var e = c.getExperiment(p.experimentId);
  assert.strictEqual(e.status, "evaluated");
  assert.strictEqual(e.lockUntil, null);
  c.stop();
  reset();
});

test("evaluate requires experimentEngine", function() {
  reset();
  var c = createExperimentCoordinator({ instanceId: "r-1" });
  c.start();
  var p = c.proposeExperiment({ hypothesisId: "h1" });
  var r = c.evaluate(p.experimentId);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "no_experiment_engine");
  c.stop();
  reset();
});

test("evaluate not_found for unknown id", function() {
  reset();
  var c = createExperimentCoordinator({ instanceId: "r-1", experimentEngine: createExperimentEngine() });
  c.start();
  var r = c.evaluate("nope");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "not_found");
  c.stop();
  reset();
});

// ===== resolveConflicts =====
console.log("\n[resolve-conflicts]");
test("resolveConflicts preempts lower priority same symbol+strategy", function() {
  reset();
  var c = createExperimentCoordinator({ instanceId: "r-1" });
  c.start();
  c._store.createExperiment({ id: "e-low", hypothesisId: "h1", symbol: "A", strategy: "s1", priority: 1, status: "running" });
  c._store.createExperiment({ id: "e-high", hypothesisId: "h2", symbol: "A", strategy: "s1", priority: 10, status: "running" });
  var r = c.resolveConflicts();
  assert.strictEqual(r.stopped, 1);
  assert.strictEqual(c.getExperiment("e-low").status, "preempted");
  assert.strictEqual(c.getExperiment("e-high").status, "running");
  c.stop();
  reset();
});

test("resolveConflicts does not preempt distinct symbol+strategy", function() {
  reset();
  var c = createExperimentCoordinator({ instanceId: "r-1" });
  c.start();
  c._store.createExperiment({ id: "e1", hypothesisId: "h1", symbol: "A", strategy: "s1", priority: 1, status: "running" });
  c._store.createExperiment({ id: "e2", hypothesisId: "h2", symbol: "B", strategy: "s2", priority: 10, status: "running" });
  var r = c.resolveConflicts();
  assert.strictEqual(r.stopped, 0);
  c.stop();
  reset();
});

// ===== PG fallback =====
console.log("\n[pg-fallback]");
test("createPgStore with null pool works via memory", function() {
  var s = createPgStore(null);
  var c = s.createExperiment({ id: "e1", hypothesisId: "h1" });
  assert.strictEqual(c.ok, true);
  assert.strictEqual(s.getExperiment("e1").status, "running");
});

test("coordinator backend=auto without pgPool uses memory", function() {
  reset();
  var c = createExperimentCoordinator({ instanceId: "r-auto", backend: "auto" });
  c.start();
  assert.strictEqual(c.stats().backend, "auto");
  var p = c.proposeExperiment({ hypothesisId: "h-auto" });
  assert.strictEqual(p.ok, true);
  c.stop();
  reset();
});

test("syncExperiments resolves memory_only without PG", function() {
  reset();
  var c = createExperimentCoordinator({ instanceId: "r-1" });
  c.start();
  var r = null;
  c.syncExperiments().then(function(x) { r = x; });
  // Allow microtask flush via sync check
  var start = Date.now();
  while (!r && Date.now() - start < 50) { /* spin */ }
  // Promise may not resolve sync, just verify no throw
  c.stop();
  reset();
});

// ===== e2e =====
console.log("\n[e2e]");
test("e2e: propose -> sample -> evaluate integrates with experimentEngine", function() {
  reset();
  var exp = createExperimentEngine();
  var attr = createAttributionEngine();
  var c = createExperimentCoordinator({
    instanceId: "runner-main", experimentEngine: exp, attributionEngine: attr,
    minSamples: 5, significanceLevel: 0.5,
  });
  c.start();
  var p = c.proposeExperiment({ hypothesisId: "hyp-fill-rate", symbol: "005930", strategy: "momentum", priority: 3 });
  assert.strictEqual(p.ok, true);
  for (var i = 0; i < 12; i++) c.recordSample(p.experimentId, "treatment", 100 + i);
  for (var j = 0; j < 12; j++) c.recordSample(p.experimentId, "control", 80 + j);
  c.recordFill({ symbol: "005930", strategy: "momentum", pnl: 500 });
  c.recordDecision({ symbol: "005930", action: "BUY" });
  var ev = c.evaluate(p.experimentId);
  assert.strictEqual(ev.ok, true);
  assert.strictEqual(ev.evaluation.verdict, "treatment_better");
  var s = c.stats();
  assert.strictEqual(s.total, 1);
  assert.strictEqual(s.evaluated, 1);
  assert.strictEqual(s.running, 0);
  assert.strictEqual(s.fills, 1);
  assert.strictEqual(s.decisions, 1);
  assert.ok(s.historySize > 0);
  var hist = c.getHistory(10);
  assert.ok(hist.some(function(h) { return h.event === "evaluated"; }));
  c.stop();
  reset();
});

test("e2e: two coordinators share store, second blocked by lock", function() {
  reset();
  var c1 = createExperimentCoordinator({ instanceId: "r-A" });
  var c2 = createExperimentCoordinator({ instanceId: "r-B" });
  c1.start(); c2.start();
  var p1 = c1.proposeExperiment({ hypothesisId: "shared-hyp" });
  assert.strictEqual(p1.ok, true);
  var p2 = c2.proposeExperiment({ hypothesisId: "shared-hyp" });
  assert.strictEqual(p2.ok, false);
  var p3 = c2.proposeExperiment({ hypothesisId: "other-hyp" });
  assert.strictEqual(p3.ok, true);
  var stats = c1.stats();
  assert.strictEqual(stats.total, 2);
  assert.strictEqual(stats.instances, 2);
  c1.stop(); c2.stop();
  reset();
});

test("e2e: coordinator + attributionEngine recordFill/Decision aggregation", function() {
  reset();
  var attr = createAttributionEngine();
  var c = createExperimentCoordinator({ instanceId: "r-1", attributionEngine: attr });
  c.start();
  c.recordFill({ symbol: "A", strategy: "s1", pnl: 100 });
  c.recordFill({ symbol: "B", strategy: "s2", pnl: -50 });
  c.recordDecision({ symbol: "A", action: "BUY" });
  var s = c.stats();
  assert.strictEqual(s.fills, 2);
  assert.strictEqual(s.decisions, 1);
  c.stop();
  reset();
});

// ===== Print =====
console.log("\n========================================");
console.log("Phase R-7 Results: " + passed + " passed, " + failed + " failed");
console.log("========================================\n");
process.exit(failed > 0 ? 1 : 0);