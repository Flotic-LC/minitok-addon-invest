"use strict";

const assert = require("node:assert");
const { createEventBus } = require("../src/intelligence/event-bus");
const { createCorrelationEngine, _pearson } = require("../src/intelligence/correlation");
const { createHypothesisEngine } = require("../src/intelligence/hypothesis");
const { createReflectionEngine } = require("../src/intelligence/reflection");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  PASS: " + name); }
  catch (e) { failed++; console.error("  FAIL: " + name + " — " + e.message); }
}

console.log("=== Phase R-2: Correlation + Hypothesis ===\n");

// ===== PEARSON =====
console.log("[pearson]");
test("perfect positive correlation", function() {
  var r = _pearson([1,2,3,4,5], [2,4,6,8,10]);
  assert.strictEqual(r.r, 1);
});
test("perfect negative correlation", function() {
  var r = _pearson([1,2,3,4,5], [10,8,6,4,2]);
  assert.strictEqual(r.r, -1);
});
test("no correlation (constant y)", function() {
  var r = _pearson([1,2,3], [5,5,5]);
  assert.strictEqual(r.r, 0);
  assert.strictEqual(r.reason, "constant");
});
test("insufficient samples", function() {
  var r = _pearson([1], [2]);
  assert.strictEqual(r.reason, "insufficient");
});

// ===== CORRELATION ENGINE =====
console.log("\n[correlation]");
test("createCorrelationEngine requires eventBus", function() {
  assert.throws(function() { createCorrelationEngine(); }, /eventBus is required/);
});
test("correlateIncidentsWithPnL insufficient with high minSamples", function() {
  var bus = createEventBus();
  var c = createCorrelationEngine({ eventBus: bus, minSamples: 100 });
  var r = c.correlateIncidentsWithPnL({});
  assert.strictEqual(r.type, "incident_pnl");
  assert.strictEqual(r.reason, "insufficient_buckets");
});
test("correlateIncidentsWithPnL reports insufficient buckets with no observed data (default config)", function() {
  var bus = createEventBus();
  var c = createCorrelationEngine({ eventBus: bus });
  var r = c.correlateIncidentsWithPnL({});
  assert.strictEqual(r.type, "incident_pnl");
  // [2026-10-21] The engine used to zero-fill 24 hourly buckets that the
  // event bus could not actually cover (10,000 events is barely half an
  // hour at this system's event rate) and report a correlation of 0 over
  // them. It now reports that there is not enough observed data.
  assert.strictEqual(r.reason, "insufficient_buckets");
  assert.strictEqual(r.r, null);
});
test("correlateIncidentsWithPnL returns structure", function() {
  var bus = createEventBus({ maxHistory: 10000 });
  var c = createCorrelationEngine({ eventBus: bus, bucketMs: 60000, windowMs: 600000, minSamples: 3 });
  var now = Date.now();
  for (var i = 0; i < 5; i++) bus.emit("selfHealing.incident", { rule: "x" }, now - 500000 + i * 1000);
  for (var j = 0; j < 5; j++) bus.emit("trading.fill", { symbol: "005930", pnl: -1000 }, now - 100000 + j * 1000);
  var r = c.correlateIncidentsWithPnL({});
  assert.strictEqual(r.type, "incident_pnl");
  assert.ok(typeof r.r === "number" || r.r === null);
});
test("correlateAlertsWithPerformance returns structure", function() {
  var bus = createEventBus();
  var c = createCorrelationEngine({ eventBus: bus });
  var r = c.correlateAlertsWithPerformance({});
  assert.strictEqual(r.type, "alert_performance");
  assert.ok(Array.isArray(r.correlations));
});
test("correlationMatrix returns streams and matrix", function() {
  var bus = createEventBus();
  var c = createCorrelationEngine({ eventBus: bus });
  var m = c.correlationMatrix();
  assert.ok(Array.isArray(m.streams));
  assert.ok(m.streams.indexOf("alerts") >= 0);
  assert.ok(m.streams.indexOf("incidents") >= 0);
});
test("detectAnomalies returns array", function() {
  var bus = createEventBus();
  var c = createCorrelationEngine({ eventBus: bus });
  var a = c.detectAnomalies();
  assert.ok(Array.isArray(a));
});
test("stats and clear work", function() {
  var bus = createEventBus();
  var c = createCorrelationEngine({ eventBus: bus });
  c.correlateIncidentsWithPnL({});
  var s = c.stats();
  assert.ok(s.analysesRun >= 1);
  c.clear();
  assert.strictEqual(c.stats().analysesRun, 0);
});
test("getHistory returns findings", function() {
  var bus = createEventBus();
  var c = createCorrelationEngine({ eventBus: bus });
  c.correlateIncidentsWithPnL({});
  var h = c.getHistory(10);
  assert.ok(Array.isArray(h));
});

// ===== HYPOTHESIS ENGINE =====
console.log("\n[hypothesis]");
test("createHypothesisEngine requires eventBus", function() {
  assert.throws(function() { createHypothesisEngine(); }, /eventBus is required/);
});
test("generateHypotheses from blind spots", function() {
  var bus = createEventBus();
  var refl = createReflectionEngine({ eventBus: bus });
  var hyp = createHypothesisEngine({ eventBus: bus, reflectionEngine: refl });
  bus.emit("selfAudit.alert", { rule: "x" });
  var hs = hyp.generateHypotheses();
  assert.ok(hs.length >= 1);
  assert.ok(hs.some(function(h) { return h.type === "blind_spot_fix"; }));
});
test("generateHypotheses with correlation findings", function() {
  var bus = createEventBus();
  var refl = createReflectionEngine({ eventBus: bus });
  var corr = createCorrelationEngine({ eventBus: bus });
  var hyp = createHypothesisEngine({ eventBus: bus, reflectionEngine: refl, correlationEngine: corr });
  corr.correlateIncidentsWithPnL({});
  var hs = hyp.generateHypotheses();
  assert.ok(Array.isArray(hs));
});
test("evaluateCounterfactual returns estimate", function() {
  var bus = createEventBus();
  var refl = createReflectionEngine({ eventBus: bus });
  var hyp = createHypothesisEngine({ eventBus: bus, reflectionEngine: refl });
  bus.emit("selfAudit.alert", {});
  var hs = hyp.generateHypotheses();
  if (hs.length > 0) {
    var est = hyp.evaluateCounterfactual(hs[0].id);
    assert.ok(typeof est.estimatedPnlDeltaPct === "number");
  }
});
test("evaluateCounterfactual unknown id returns error", function() {
  var bus = createEventBus();
  var hyp = createHypothesisEngine({ eventBus: bus });
  var est = hyp.evaluateCounterfactual("nonexistent");
  assert.ok(est.error);
});
test("rankProposals returns sorted list", function() {
  var bus = createEventBus();
  var refl = createReflectionEngine({ eventBus: bus });
  var hyp = createHypothesisEngine({ eventBus: bus, reflectionEngine: refl });
  bus.emit("selfAudit.alert", {});
  hyp.generateHypotheses();
  var ranked = hyp.rankProposals();
  assert.ok(Array.isArray(ranked));
  if (ranked.length >= 2) assert.ok(ranked[0].score >= ranked[1].score);
});
test("trackOutcome confirms hypothesis", function() {
  var bus = createEventBus();
  var refl = createReflectionEngine({ eventBus: bus });
  var hyp = createHypothesisEngine({ eventBus: bus, reflectionEngine: refl });
  bus.emit("selfAudit.alert", {});
  var hs = hyp.generateHypotheses();
  if (hs.length > 0) {
    var r = hyp.trackOutcome(hs[0].id, { confirmed: true, note: "verified" });
    assert.strictEqual(r.status, "confirmed");
    assert.strictEqual(hyp.stats().confirmed, 1);
  }
});
test("trackOutcome rejects hypothesis", function() {
  var bus = createEventBus();
  var refl = createReflectionEngine({ eventBus: bus });
  var hyp = createHypothesisEngine({ eventBus: bus, reflectionEngine: refl });
  bus.emit("selfAudit.alert", {});
  var hs = hyp.generateHypotheses();
  if (hs.length > 0) {
    var r = hyp.trackOutcome(hs[0].id, { confirmed: false });
    assert.strictEqual(r.status, "rejected");
    assert.strictEqual(hyp.stats().rejected, 1);
  }
});
test("hypothesis stats and clear", function() {
  var bus = createEventBus();
  var hyp = createHypothesisEngine({ eventBus: bus });
  assert.strictEqual(hyp.stats().totalHypotheses, 0);
  hyp.clear();
  assert.strictEqual(hyp.stats().generated, 0);
});
test("getHypotheses and getOutcomes return arrays", function() {
  var bus = createEventBus();
  var hyp = createHypothesisEngine({ eventBus: bus });
  assert.ok(Array.isArray(hyp.getHypotheses()));
  assert.ok(Array.isArray(hyp.getOutcomes()));
});

// ===== E2E =====
console.log("\n[e2e]");
test("full pipeline: bus -> reflection -> correlation -> hypothesis", function() {
  var bus = createEventBus();
  var refl = createReflectionEngine({ eventBus: bus });
  var corr = createCorrelationEngine({ eventBus: bus });
  var hyp = createHypothesisEngine({ eventBus: bus, reflectionEngine: refl, correlationEngine: corr });
  bus.emit("selfAudit.alert", { rule: "data_collection_stall" });
  bus.emit("decision.made", { symbol: "005930", action: "BUY" });
  bus.emit("trading.fill", { symbol: "005930", pnl: 500 });
  var report = refl.generateReport();
  assert.ok(report.generatedAt);
  var corrResult = corr.correlateIncidentsWithPnL({});
  assert.strictEqual(corrResult.type, "incident_pnl");
  var hs = hyp.generateHypotheses();
  assert.ok(Array.isArray(hs));
  var ranked = hyp.rankProposals();
  assert.ok(Array.isArray(ranked));
});

console.log("\n===========================================");
console.log("  Results: " + passed + " passed, " + failed + " failed");
console.log("===========================================");
process.exit(failed > 0 ? 1 : 0);
