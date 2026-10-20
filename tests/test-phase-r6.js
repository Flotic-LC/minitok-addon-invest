"use strict";

/**
 * Phase R-6 Tests — Continuous Improvement Integration Layer.
 * Covers: shadow-gate, persistence, regime-advisor, evolution-bridge,
 * knowledge-ranker, and end-to-end R-6 loop.
 */

var assert = require("node:assert");
var fs = require("node:fs");
var path = require("node:path");
var os = require("node:os");

var { createShadowGate } = require("../src/intelligence/shadow-gate");
var { createPersistence } = require("../src/intelligence/persistence");
var { createRegimeAdvisor } = require("../src/intelligence/regime-advisor");
var { createEvolutionBridge } = require("../src/intelligence/evolution-bridge");
var { createKnowledgeRanker } = require("../src/intelligence/knowledge-ranker");
var { createPerformanceMonitor } = require("../src/intelligence/performance-monitor");
var { createBlindSpotBridge } = require("../src/intelligence/blindspot-bridge");
var { createParamTuner } = require("../src/intelligence/param-tuner");
var { createHypothesisEngine } = require("../src/intelligence/hypothesis");
var { createExperimentEngine } = require("../src/intelligence/experiment");
var { createAutoLoop } = require("../src/intelligence/auto-loop");
var { createActionRegistry } = require("../src/intelligence/action-registry");
var { createOutcomeFeedback } = require("../src/intelligence/outcome-feedback");
var { createEventBus } = require("../src/intelligence/event-bus");

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  PASS: " + name); }
  catch (e) { failed++; console.error("  FAIL: " + name + " — " + e.message); }
}

// ===== SHADOW GATE =====
console.log("\n[shadow-gate]");

test("install patches paramTuner.apply", function() {
  var pt = createParamTuner({});
  var gate = createShadowGate({ paramTuner: pt, shadowMode: null });
  var r = gate.install();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(pt.apply._shadowGate, true);
});

test("blocks protected parameters", function() {
  var pt = createParamTuner({});
  var gate = createShadowGate({ paramTuner: pt, shadowMode: null });
  gate.install();
  var r = pt.apply({ kind: "custom", key: "DAILY_MAX_LOSS_PCT", value: 0.05 });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /shadow_gate_blocked/);
});

test("enforces shadow-mode when available", function() {
  var pt = createParamTuner({});
  var mockShadow = {
    propose: function() { return { ok: true, entry: { id: "sh_123", shadowDays: 7 } }; },
    getActiveParams: function() { return {}; },
  };
  var gate = createShadowGate({ paramTuner: pt, shadowMode: mockShadow, mode: "enforce" });
  gate.install();
  var r = pt.apply({ kind: "strategy_weight", strategy: "momentum", weight: 0.5 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.shadowed, true);
});

// ===== PERSISTENCE =====
console.log("\n[persistence]");

test("save and restore cycle", function() {
  var tmpPath = path.join(os.tmpdir(), "test-r6-persist-" + Date.now() + ".json");
  var bus = createEventBus();
  var hyp = createHypothesisEngine({ eventBus: bus });
  var exp = createExperimentEngine();
  var pt = createParamTuner({});
  var ar = createActionRegistry({ paramTuner: pt });
  var al = createAutoLoop({});
  var fb = createOutcomeFeedback({ experimentEngine: exp, hypothesisEngine: hyp });

  hyp.addHypothesis({ id: "h1", type: "test", status: "pending", createdAt: new Date().toISOString() });
  exp.createExperiment({ id: "e1", hypothesisId: "h1" });

  var persist = createPersistence({
    path: tmpPath,
    hypothesisEngine: hyp, experimentEngine: exp,
    paramTuner: pt, actionRegistry: ar,
    autoLoop: al, outcomeFeedback: fb,
  });

  var saveResult = persist.save();
  assert.strictEqual(saveResult.ok, true);
  assert.ok(fs.existsSync(tmpPath));

  hyp.clear(); exp.clear();
  var restoreResult = persist.restore();
  assert.strictEqual(restoreResult.ok, true);
  assert.ok(restoreResult.restored.length > 0);

  var hyps = hyp.getHypotheses(100);
  assert.ok(hyps.length > 0);
  assert.strictEqual(hyps[0].id, "h1");
  fs.unlinkSync(tmpPath);
});

test("restore returns no_state_file when file missing", function() {
  var persist = createPersistence({ path: path.join(os.tmpdir(), "nonexistent-" + Date.now() + ".json") });
  var r = persist.restore();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "no_state_file");
});

// ===== REGIME ADVISOR =====
console.log("\n[regime-advisor]");

test("generates hypotheses on bear regime", function() {
  var mockHMM = {
    lastFeatures: function() { return { label: "bear", prob: 0.8 }; },
    getPositionMultiplier: function() { return 0.6; },
    history: new Array(20),
  };
  var mockHyp = {
    addHypothesis: function(h) { this._h.push(h); return { ok: true }; },
    _h: [],
  };
  var advisor = createRegimeAdvisor({
    regimeHMM: mockHMM, hypothesisEngine: mockHyp,
    minObservations: 10, bearMultThreshold: 0.7, cooldownMs: 0,
  });
  advisor.tick(); advisor.tick(); advisor.tick();
  assert.ok(mockHyp._h.length > 0);
  assert.strictEqual(mockHyp._h[0].type, "regime_shift_position");
});

test("generates hypotheses on bull regime", function() {
  var mockHMM = {
    lastFeatures: function() { return { label: "bull", prob: 0.9 }; },
    getPositionMultiplier: function() { return 1.5; },
    history: new Array(30),
  };
  var mockHyp = { addHypothesis: function(h) { this._h.push(h); return { ok: true }; }, _h: [] };
  var advisor = createRegimeAdvisor({
    regimeHMM: mockHMM, hypothesisEngine: mockHyp,
    minObservations: 10, bullMultThreshold: 1.3, cooldownMs: 0,
  });
  advisor.tick(); advisor.tick(); advisor.tick();
  assert.ok(mockHyp._h.length > 0);
  assert.strictEqual(mockHyp._h[0].source, "regime_advisor");
});

test("skips when insufficient observations", function() {
  var mockHMM = {
    lastFeatures: function() { return { label: "bear", prob: 0.9 }; },
    getPositionMultiplier: function() { return 0.5; },
    history: new Array(3),
  };
  var mockHyp = { addHypothesis: function(h) { this._h.push(h); }, _h: [] };
  var advisor = createRegimeAdvisor({ regimeHMM: mockHMM, hypothesisEngine: mockHyp, minObservations: 10 });
  var r = advisor.tick();
  assert.strictEqual(r.skipped, true);
  assert.strictEqual(mockHyp._h.length, 0);
});

// ===== EVOLUTION BRIDGE =====
console.log("\n[evolution-bridge]");

test("syncs from GA to hypothesis engine", function() {
  var mockEvo = {
    getLastResult: function() {
      return { bestGenome: { POSITION_SIZE_PCT: 0.08, STOP_LOSS_PCT: 0.03 }, bestFitness: 0.85 };
    },
  };
  var mockHyp = {
    addHypothesis: function(h) { this._h.push(h); return { ok: true }; },
    getHypotheses: function(n) { return this._h.slice(-n); },
    getOutcomes: function() { return []; },
    _h: [],
  };
  var bridge = createEvolutionBridge({ evolution: mockEvo, hypothesisEngine: mockHyp, shadowMode: null, cooldownMs: 0, minFitnessDelta: 0.05 });
  var r = bridge.syncFromEvolution();
  assert.strictEqual(r.ok, true);
  assert.ok(r.hypotheses.length > 0);
  assert.strictEqual(r.fitness, 0.85);
});

test("syncs confirmed hypotheses to GA seeds", function() {
  var mockHyp = {
    getHypotheses: function() { return [{ id: "h1", source: "evolution_bridge", gaParam: "POS", gaValue: 0.1, gaFitness: 0.9 }]; },
    getOutcomes: function() { return [{ hypothesisId: "h1", confirmed: true }]; },
  };
  var mockEvo = { injectSeeds: function(seeds) { this._seeds = seeds; }, _seeds: null };
  var bridge = createEvolutionBridge({ evolution: mockEvo, hypothesisEngine: mockHyp, cooldownMs: 0 });
  var r = bridge.syncToEvolution();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.seeds, 1);
  assert.ok(mockEvo._seeds.length === 1);
});

test("skips when no GA result", function() {
  var mockEvo = { getLastResult: function() { return null; } };
  var mockHyp = { addHypothesis: function() { return { ok: true }; } };
  var bridge = createEvolutionBridge({ evolution: mockEvo, hypothesisEngine: mockHyp, cooldownMs: 0 });
  var r = bridge.syncFromEvolution();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.skipped, true);
});

// ===== KNOWLEDGE RANKER =====
console.log("\n[knowledge-ranker]");

test("boosts score for high win rate", function() {
  var mockKS = { lookup: function() { return { trades: 10, wins: 8, winRate: 0.8, expectedValue: 1.5 }; } };
  var ranker = createKnowledgeRanker({ knowledgeStore: mockKS, highWinRate: 0.6 });
  var adj = ranker.adjustScore(0.5, { symbol: "AAPL", strategy: "momentum" });
  assert.ok(adj.score > 0.5);
  assert.ok(adj.adjustment > 0);
});

test("penalizes negative EV", function() {
  var mockKS = { lookup: function() { return { trades: 10, wins: 3, winRate: 0.3, expectedValue: -0.5 }; } };
  var ranker = createKnowledgeRanker({ knowledgeStore: mockKS });
  var adj = ranker.adjustScore(0.5, { symbol: "TSLA" });
  assert.ok(adj.score < 0.5);
  assert.ok(adj.adjustment < 0);
});

test("skips when insufficient trades", function() {
  var mockKS = { lookup: function() { return { trades: 1, wins: 1, winRate: 1.0, expectedValue: 5.0 }; } };
  var ranker = createKnowledgeRanker({ knowledgeStore: mockKS, minTrades: 5 });
  var adj = ranker.adjustScore(0.5, { symbol: "NEW" });
  assert.strictEqual(adj.adjustment, 0);
});

test("install patches rankProposals", function() {
  var mockHyp = { rankProposals: function() { return [{ id: "h1", score: 0.5 }]; } };
  var mockKS = { lookup: function() { return { trades: 5, winRate: 0.8, expectedValue: 1.0 }; } };
  var ranker = createKnowledgeRanker({ knowledgeStore: mockKS, hypothesisEngine: mockHyp, highWinRate: 0.6 });
  var r = ranker.install();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(mockHyp.rankProposals._knowledgeRanker, true);
  var ranked = mockHyp.rankProposals();
  assert.ok(ranked[0].knowledgeAdjustment !== undefined);
});

test("uninstall restores original", function() {
  var origFn = function() { return []; };
  var mockHyp = { rankProposals: origFn };
  var ranker = createKnowledgeRanker({ knowledgeStore: null, hypothesisEngine: mockHyp });
  ranker.install();
  ranker.uninstall();
  assert.strictEqual(mockHyp.rankProposals, origFn);
});

// ===== RESTORE METHODS ON EXISTING MODULES =====
console.log("\n[restore-methods]");

test("hypothesis.addHypothesis + restoreState", function() {
  var bus = createEventBus();
  var hyp = createHypothesisEngine({ eventBus: bus });
  var r = hyp.addHypothesis({ id: "ext1", type: "custom", status: "pending", createdAt: new Date().toISOString() });
  assert.strictEqual(r.ok, true);
  hyp.clear();
  assert.strictEqual(hyp.getHypotheses(10).length, 0);
  var restored = hyp.restoreState([{ id: "ext1", type: "custom", status: "pending" }], []);
  assert.strictEqual(restored.hypotheses, 1);
});

test("hypothesis.addHypothesis rejects duplicates", function() {
  var bus = createEventBus();
  var hyp = createHypothesisEngine({ eventBus: bus });
  hyp.addHypothesis({ id: "dup1", type: "x", status: "pending" });
  var r2 = hyp.addHypothesis({ id: "dup1", type: "x", status: "pending" });
  assert.strictEqual(r2.ok, false);
  assert.match(r2.reason, /duplicate/);
});

test("experiment.restoreExperiment rebuilds state", function() {
  var exp = createExperimentEngine();
  var r = exp.restoreExperiment({
    id: "re1", hypothesisId: "h1", status: "running",
    control: [1, 2, 3], treatment: [4, 5, 6],
  });
  assert.strictEqual(r.ok, true);
  var got = exp.getExperiment("re1");
  assert.ok(got);
  assert.strictEqual(got.control.length, 3);
  assert.strictEqual(got.treatment.length, 3);
});

test("paramTuner.restoreHistory", function() {
  var pt = createParamTuner({});
  var r = pt.restoreHistory([{ ts: "t1" }, { ts: "t2" }]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.restored, 2);
  assert.strictEqual(pt.getHistory(10).length, 2);
});

test("autoLoop.restoreHistory", function() {
  var al = createAutoLoop({});
  var r = al.restoreHistory([{ action: "a1" }, { action: "a2" }]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.restored, 2);
});

test("actionRegistry.restoreAudit", function() {
  var ar = createActionRegistry({});
  var r = ar.restoreAudit([{ ts: "x" }, { ts: "y" }]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.restored, 2);
});

test("outcomeFeedback.restoreProcessed", function() {
  var bus = createEventBus();
  var hyp = createHypothesisEngine({ eventBus: bus });
  var exp = createExperimentEngine();
  var fb = createOutcomeFeedback({ experimentEngine: exp, hypothesisEngine: hyp });
  var r = fb.restoreProcessed(["id1", "id2"]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.restored, 2);
});

test("outcomeFeedback.on/emit for verdict listeners", function() {
  var bus = createEventBus();
  var hyp = createHypothesisEngine({ eventBus: bus });
  var exp = createExperimentEngine();
  var fb = createOutcomeFeedback({ experimentEngine: exp, hypothesisEngine: hyp });
  var received = null;
  fb.on("verdict", function(v) { received = v; });
  fb.emit("verdict", { hypothesisId: "h1", confirmed: true });
  assert.ok(received);
  assert.strictEqual(received.hypothesisId, "h1");
});

// ===== END-TO-END INTEGRATION =====
console.log("\n[end-to-end integration]");

test("full R-6 loop: regime → hypothesis → persistence round-trip", function() {
  var tmpPath = path.join(os.tmpdir(), "test-r6-e2e-" + Date.now() + ".json");
  var bus = createEventBus();
  var hyp = createHypothesisEngine({ eventBus: bus });
  var exp = createExperimentEngine();
  var pt = createParamTuner({});
  var ar = createActionRegistry({ paramTuner: pt });
  var al = createAutoLoop({});
  var fb = createOutcomeFeedback({ experimentEngine: exp, hypothesisEngine: hyp });

  var mockHMM = {
    lastFeatures: function() { return { label: "bull", prob: 0.9 }; },
    getPositionMultiplier: function() { return 1.4; },
    history: new Array(25),
  };
  var advisor = createRegimeAdvisor({
    regimeHMM: mockHMM, hypothesisEngine: hyp,
    minObservations: 10, bullMultThreshold: 1.3, cooldownMs: 0,
  });

  var persist = createPersistence({
    path: tmpPath,
    hypothesisEngine: hyp, experimentEngine: exp,
    paramTuner: pt, actionRegistry: ar,
    autoLoop: al, outcomeFeedback: fb,
  });

  advisor.tick(); advisor.tick(); advisor.tick();
  var hyps = hyp.getHypotheses(100);
  assert.ok(hyps.length > 0);

  var saveR = persist.save();
  assert.strictEqual(saveR.ok, true);

  hyp.clear();
  assert.strictEqual(hyp.getHypotheses(100).length, 0);

  var restoreR = persist.restore();
  assert.strictEqual(restoreR.ok, true);

  var restored = hyp.getHypotheses(100);
  assert.ok(restored.length > 0);
  fs.unlinkSync(tmpPath);
});

test("shadow-gate blocks protected params in full pipeline", function() {
  var pt = createParamTuner({});
  var gate = createShadowGate({ paramTuner: pt, shadowMode: null, mode: "enforce" });
  gate.install();
  var r = pt.apply({ kind: "custom", key: "MAX_SINGLE_POSITION_PCT", value: 0.5 });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /shadow_gate_blocked/);
  assert.strictEqual(gate.stats().rejected, 1);
});

test("evolution-bridge + hypothesis + shadow-mode full cycle", function() {
  var bus = createEventBus();
  var hyp = createHypothesisEngine({ eventBus: bus });
  var mockShadow = {
    propose: function() { return { ok: true, entry: { id: "sh_evo", shadowDays: 3 } }; },
    getActiveParams: function() { return {}; },
    stats: function() { return {}; },
  };
  var mockEvo = {
    getLastResult: function() {
      return { bestGenome: { RSI_PERIOD: 18 }, bestFitness: 0.92 };
    },
    injectSeeds: function() {},
  };
  var bridge = createEvolutionBridge({
    evolution: mockEvo, hypothesisEngine: hyp, shadowMode: mockShadow,
    cooldownMs: 0, minFitnessDelta: 0.01,
  });
  var r = bridge.syncFromEvolution();
  assert.strictEqual(r.ok, true);
  assert.ok(r.hypotheses.length > 0);
  assert.ok(r.hypotheses[0].shadowId);
});

// ===== PERFORMANCE MONITOR =====
console.log("\n[performance-monitor]");

test("performance-monitor records trades", function() {
  var bus = createEventBus();
  var hyp = createHypothesisEngine({ eventBus: bus });
  var pm = createPerformanceMonitor({ hypothesisEngine: hyp, cooldownMs: 0 });
  var r = pm.recordTrade({ pnl: 100, symbol: "AAPL" });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(pm.stats().totalTrades, 1);
});

test("performance-monitor detects degradation and generates hypotheses", function() {
  var bus = createEventBus();
  var hyp = createHypothesisEngine({ eventBus: bus });
  var pm = createPerformanceMonitor({
    hypothesisEngine: hyp, cooldownMs: 0,
    windowSize: 15, winRateThreshold: 0.5, sharpeThreshold: 0, profitFactorThreshold: 1.2,
  });
  // Feed 15 losing trades
  for (var i = 0; i < 15; i++) pm.recordTrade({ pnl: -50 });
  var r = pm.check();
  assert.strictEqual(r.degraded, true);
  assert.ok(r.reasons.length > 0);
  assert.ok(r.hypotheses.length > 0);
  var hyps = hyp.getHypotheses(10);
  assert.ok(hyps.length > 0);
});

test("performance-monitor skips when insufficient trades", function() {
  var pm = createPerformanceMonitor({ hypothesisEngine: null, windowSize: 50 });
  pm.recordTrade({ pnl: 10 });
  var r = pm.check();
  assert.strictEqual(r.skipped, true);
  assert.match(r.reason, /insufficient/);
});

test("performance-monitor respects cooldown", function() {
  var bus = createEventBus();
  var hyp = createHypothesisEngine({ eventBus: bus });
  var pm = createPerformanceMonitor({ hypothesisEngine: hyp, cooldownMs: 999999 });
  for (var i = 0; i < 15; i++) pm.recordTrade({ pnl: -100 });
  var r1 = pm.check();
  assert.strictEqual(r1.degraded, true);
  var r2 = pm.check();
  assert.strictEqual(r2.skipped, true);
  assert.match(r2.reason, /cooldown/);
});

// ===== BLIND-SPOT BRIDGE =====
console.log("\n[blindspot-bridge]");

test("blindspot-bridge generates hypotheses from blind spots", function() {
  var bus = createEventBus();
  var hyp = createHypothesisEngine({ eventBus: bus });
  var mockReflection = {
    generateReport: function() {
      return {
        blindSpots: [
          { type: "data_gap", severity: "high", description: "Missing overnight data" },
          { type: "strategy_blind", severity: "medium", description: "No hedging" },
        ],
      };
    },
  };
  var bs = createBlindSpotBridge({
    reflectionEngine: mockReflection, hypothesisEngine: hyp,
    cooldownMs: 0, maxPerCycle: 3,
  });
  var r = bs.tick();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.hypotheses.length, 2);
  assert.strictEqual(r.blindSpotsTotal, 2);
  var hyps = hyp.getHypotheses(10);
  assert.strictEqual(hyps.length, 2);
});

test("blindspot-bridge skips when no blind spots", function() {
  var bus = createEventBus();
  var hyp = createHypothesisEngine({ eventBus: bus });
  var mockReflection = { generateReport: function() { return { blindSpots: [] }; } };
  var bs = createBlindSpotBridge({ reflectionEngine: mockReflection, hypothesisEngine: hyp, cooldownMs: 0 });
  var r = bs.tick();
  assert.strictEqual(r.skipped, true);
  assert.match(r.reason, /no_blind_spots/);
});

test("blindspot-bridge respects maxPerCycle", function() {
  var bus = createEventBus();
  var hyp = createHypothesisEngine({ eventBus: bus });
  var mockReflection = {
    generateReport: function() {
      return { blindSpots: [
        { type: "a", severity: "low" }, { type: "b", severity: "low" },
        { type: "c", severity: "low" }, { type: "d", severity: "low" },
      ]};
    },
  };
  var bs = createBlindSpotBridge({ reflectionEngine: mockReflection, hypothesisEngine: hyp, cooldownMs: 0, maxPerCycle: 2 });
  var r = bs.tick();
  assert.strictEqual(r.hypotheses.length, 2);
  assert.strictEqual(r.blindSpotsTotal, 4);
});

test("blindspot-bridge respects cooldown", function() {
  var bus = createEventBus();
  var hyp = createHypothesisEngine({ eventBus: bus });
  var mockReflection = {
    generateReport: function() { return { blindSpots: [{ type: "x", severity: "high" }] }; },
  };
  var bs = createBlindSpotBridge({ reflectionEngine: mockReflection, hypothesisEngine: hyp, cooldownMs: 999999 });
  var r1 = bs.tick();
  assert.strictEqual(r1.hypotheses.length, 1);
  var r2 = bs.tick();
  assert.strictEqual(r2.skipped, true);
  assert.match(r2.reason, /cooldown/);
});

// ===== SUMMARY =====
console.log("\n" + "=".repeat(50));
console.log("Phase R-6 Tests: " + passed + " passed, " + failed + " failed");
console.log("=".repeat(50));

if (failed > 0) process.exit(1);
