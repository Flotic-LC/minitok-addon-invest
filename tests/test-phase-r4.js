"use strict";

const assert = require("node:assert");
const { createEventBus } = require("../src/intelligence/event-bus");
const { createReflectionEngine } = require("../src/intelligence/reflection");
const { createHypothesisEngine } = require("../src/intelligence/hypothesis");
const { createExperimentEngine } = require("../src/intelligence/experiment");
const { createOutcomeFeedback } = require("../src/intelligence/outcome-feedback");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  PASS: " + name); }
  catch (e) { failed++; console.error("  FAIL: " + name + " — " + e.message); }
}

function makeWired() {
  var bus = createEventBus();
  var refl = createReflectionEngine({ eventBus: bus });
  var hyp = createHypothesisEngine({ eventBus: bus, reflectionEngine: refl });
  var exp = createExperimentEngine({ minSamples: 5 });
  var fb = createOutcomeFeedback({ experimentEngine: exp, hypothesisEngine: hyp });
  bus.emit("selfAudit.alert", {});
  hyp.generateHypotheses();
  var hs = hyp.getHypotheses(10);
  var hypId = hs.length > 0 ? hs[0].id : null;
  return { bus: bus, refl: refl, hyp: hyp, exp: exp, fb: fb, hypId: hypId };
}

function makeSigExp(exp, hypId, tMean, cMean) {
  var id = exp.createExperiment({ hypothesisId: hypId, name: "e" });
  for (var i = 0; i < 10; i++) exp.recordSample(id, "treatment", tMean + i);
  for (var j = 0; j < 10; j++) exp.recordSample(id, "control", cMean + j);
  exp.evaluate(id);
  return id;
}

console.log("=== Phase R-4: Outcome Feedback ===\n");

test("tick returns result object", function() {
  var w = makeWired();
  var r = w.fb.tick();
  assert.ok(r.ts);
  assert.ok(Array.isArray(r.processed));
});

test("tick errors without experimentEngine", function() {
  var fb = createOutcomeFeedback({ hypothesisEngine: {} });
  var r = fb.tick();
  assert.ok(r.error);
});

test("tick errors without hypothesisEngine", function() {
  var fb = createOutcomeFeedback({ experimentEngine: {} });
  var r = fb.tick();
  assert.ok(r.error);
});

test("treatment_better confirms hypothesis", function() {
  var w = makeWired();
  if (!w.hypId) return;
  makeSigExp(w.exp, w.hypId, 100, 50);
  var r = w.fb.tick();
  assert.strictEqual(r.processed.length, 1);
  assert.strictEqual(r.processed[0].confirmed, true);
  assert.strictEqual(r.processed[0].verdict, "treatment_better");
  var hs = w.hyp.getHypotheses(50);
  var h = null;
  for (var i = 0; i < hs.length; i++) if (hs[i].id === w.hypId) h = hs[i];
  assert.ok(h);
  assert.strictEqual(h.status, "confirmed");
});

test("control_better rejects hypothesis", function() {
  var w = makeWired();
  if (!w.hypId) return;
  makeSigExp(w.exp, w.hypId, 50, 100);
  var r = w.fb.tick();
  assert.strictEqual(r.processed.length, 1);
  assert.strictEqual(r.processed[0].confirmed, false);
});

test("skips running experiments", function() {
  var w = makeWired();
  w.exp.createExperiment({ hypothesisId: w.hypId });
  var r = w.fb.tick();
  assert.strictEqual(r.processed.length, 0);
});

test("skips experiments without hypothesisId", function() {
  var w = makeWired();
  var id = w.exp.createExperiment({});
  for (var i = 0; i < 10; i++) w.exp.recordSample(id, "treatment", 100 + i);
  for (var j = 0; j < 10; j++) w.exp.recordSample(id, "control", 50 + j);
  w.exp.evaluate(id);
  var r = w.fb.tick();
  assert.strictEqual(r.processed.length, 0);
  assert.ok(r.skipped.length >= 1);
});

test("idempotency - second tick does not reprocess", function() {
  var w = makeWired();
  if (!w.hypId) return;
  makeSigExp(w.exp, w.hypId, 100, 50);
  w.fb.tick();
  var r2 = w.fb.tick();
  assert.strictEqual(r2.processed.length, 0);
  assert.ok(r2.skipped.length >= 1);
  assert.strictEqual(w.fb.stats().processed, 1);
});

test("getProcessed returns set contents", function() {
  var w = makeWired();
  if (!w.hypId) return;
  var id = makeSigExp(w.exp, w.hypId, 100, 50);
  w.fb.tick();
  var p = w.fb.getProcessed();
  assert.ok(Array.isArray(p));
  assert.ok(p.indexOf(id) >= 0);
});

test("stats accumulates correctly", function() {
  var w = makeWired();
  if (!w.hypId) return;
  makeSigExp(w.exp, w.hypId, 100, 50);
  w.fb.tick();
  var s = w.fb.stats();
  assert.strictEqual(s.ticks, 1);
  assert.strictEqual(s.processed, 1);
  assert.strictEqual(s.confirmed + s.rejected, 1);
});

test("getHistory returns audit trail", function() {
  var w = makeWired();
  if (!w.hypId) return;
  makeSigExp(w.exp, w.hypId, 100, 50);
  w.fb.tick();
  var h = w.fb.getHistory();
  assert.ok(Array.isArray(h));
  assert.strictEqual(h.length, 1);
  assert.ok(h[0].verdict);
  assert.strictEqual(h[0].confirmed, true);
});

test("clear resets all state", function() {
  var w = makeWired();
  if (!w.hypId) return;
  makeSigExp(w.exp, w.hypId, 100, 50);
  w.fb.tick();
  w.fb.clear();
  var s = w.fb.stats();
  assert.strictEqual(s.ticks, 0);
  assert.strictEqual(s.processed, 0);
  assert.strictEqual(w.fb.getProcessed().length, 0);
});

test("verdictToConfirmed helper", function() {
  var fb = createOutcomeFeedback({});
  assert.strictEqual(fb._verdictToConfirmed("treatment_better"), true);
  assert.strictEqual(fb._verdictToConfirmed("control_better"), false);
  assert.strictEqual(fb._verdictToConfirmed("no_significant_difference"), false);
  assert.strictEqual(fb._verdictToConfirmed("insufficient_samples"), false);
});

test("e2e: hypothesis→experiment→feedback closes loop", function() {
  var w = makeWired();
  if (!w.hypId) return;
  var before = w.hyp.rankProposals().filter(function(p) { return p.id === w.hypId; });
  assert.strictEqual(before.length, 1);
  makeSigExp(w.exp, w.hypId, 200, 100);
  var r = w.fb.tick();
  assert.strictEqual(r.processed.length, 1);
  var after = w.hyp.rankProposals().filter(function(p) { return p.id === w.hypId; });
  assert.strictEqual(after.length, 0);
  var outcomes = w.hyp.getOutcomes(10);
  assert.ok(outcomes.length >= 1);
  var last = outcomes[outcomes.length - 1];
  assert.strictEqual(last.confirmed, true);
  assert.ok(last.actual && last.actual.autoFeedback === true);
});

console.log("\n===========================================");
console.log("  Results: " + passed + " passed, " + failed + " failed");
console.log("===========================================");
process.exit(failed > 0 ? 1 : 0);
