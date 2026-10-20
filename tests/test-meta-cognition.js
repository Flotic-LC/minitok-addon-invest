"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createMetaCognition, scoreDecisionContext, spearmanRho, DIMENSIONS, DEFAULTS } = require("../src/intelligence/meta-cognition");

// ============================================================================
// spearmanRho utility
// ============================================================================
test("spearmanRho: perfect positive correlation = 1.0", () => {
  const x = [1, 2, 3, 4, 5];
  const y = [10, 20, 30, 40, 50];
  assert.equal(spearmanRho(x, y), 1);
});

test("spearmanRho: perfect negative correlation = -1.0", () => {
  const x = [1, 2, 3, 4, 5];
  const y = [50, 40, 30, 20, 10];
  assert.equal(spearmanRho(x, y), -1);
});

test("spearmanRho: returns null for < 3 elements", () => {
  assert.equal(spearmanRho([1, 2], [3, 4]), null);
  assert.equal(spearmanRho([], []), null);
});

test("spearmanRho: handles ties correctly", () => {
  const x = [1, 2, 2, 4, 5];
  const y = [10, 20, 20, 40, 50];
  const rho = spearmanRho(x, y);
  assert.ok(rho > 0.95, "rho should be close to 1 for tied monotonic data, got " + rho);
});

// ============================================================================
// DIMENSIONS & DEFAULTS
// ============================================================================
test("DIMENSIONS: has exactly 6 dimensions", () => {
  assert.equal(DIMENSIONS.length, 6);
  for (const d of ["evidenceDepth", "councilAgreement", "regimeAlignment", "memorySupport", "walkForwardPass", "noveltyPenalty"]) {
    assert.ok(DIMENSIONS.includes(d));
  }
});

test("DEFAULTS: threshold is 0.55", () => {
  assert.equal(DEFAULTS.threshold, 0.55);
});

// ============================================================================
// scoreDecisionContext
// ============================================================================
test("scoreDecisionContext: null context returns all zeros", () => {
  const scores = scoreDecisionContext(null);
  for (const dim of DIMENSIONS) {
    assert.equal(scores[dim], 0);
  }
});

test("scoreDecisionContext: full intelligence gives evidenceDepth=1.0", () => {
  const ctx = {
    intelligence: { news: { count: 5 }, macro: { regime: "bull" }, sentiment: { label: "bullish" } },
  };
  assert.equal(scoreDecisionContext(ctx).evidenceDepth, 1);
});

test("scoreDecisionContext: partial intelligence gives fractional evidenceDepth", () => {
  const ctx = { intelligence: { news: { count: 5 } } };
  const s = scoreDecisionContext(ctx);
  assert.ok(Math.abs(s.evidenceDepth - 1 / 3) < 0.01);
});

test("scoreDecisionContext: BUY in bull regime = 1.0 alignment", () => {
  assert.equal(scoreDecisionContext({ action: "BUY", regime: "bull" }).regimeAlignment, 1.0);
});

test("scoreDecisionContext: BUY in crisis regime = 0.05 alignment", () => {
  assert.equal(scoreDecisionContext({ action: "BUY", regime: "crisis" }).regimeAlignment, 0.05);
});

test("scoreDecisionContext: SELL in bear regime = 1.0 alignment", () => {
  assert.equal(scoreDecisionContext({ action: "SELL", regime: "bear" }).regimeAlignment, 1.0);
});

test("scoreDecisionContext: council consensus as number", () => {
  assert.equal(scoreDecisionContext({ councilResult: 0.85 }).councilAgreement, 0.85);
});

test("scoreDecisionContext: council result object with consensus", () => {
  assert.equal(scoreDecisionContext({ councilResult: { consensus: 0.72, approved: true } }).councilAgreement, 0.72);
});

test("scoreDecisionContext: memory support from similar experiences", () => {
  const ctx = { similarExperiences: [{ pnl: 100 }, { pnl: 200 }, { pnl: -50 }, { pnl: 150 }] };
  assert.equal(scoreDecisionContext(ctx).memorySupport, 0.75);
});

test("scoreDecisionContext: walk-forward deploy=1, reject=0", () => {
  assert.equal(scoreDecisionContext({ walkForwardResult: "deploy" }).walkForwardPass, 1);
  assert.equal(scoreDecisionContext({ walkForwardResult: "reject" }).walkForwardPass, 0);
  assert.equal(scoreDecisionContext({ walkForwardResult: { verdict: "deploy" } }).walkForwardPass, 1);
});

test("scoreDecisionContext: novelty penalty from past failures", () => {
  const ctx = { pastFailures: [{ similarityScore: 7 }, { similarityScore: 3 }] };
  const np = scoreDecisionContext(ctx).noveltyPenalty;
  assert.ok(Math.abs(np - 0.3) < 0.001, "novelty penalty should be ~0.3, got " + np);
});

test("scoreDecisionContext: opts override specific dimensions", () => {
  const ctx = { action: "BUY", regime: "bull" };
  const s = scoreDecisionContext(ctx, { evidenceDepth: 0.99 });
  assert.equal(s.evidenceDepth, 0.99);
  assert.equal(s.regimeAlignment, 1.0);
});

// ============================================================================
// createMetaCognition factory
// ============================================================================
test("factory: recordDecision returns aggregate and isWeak", () => {
  const meta = createMetaCognition({ threshold: 0.55 });
  const r = meta.recordDecision("d-001", {
    evidenceDepth: 0.9, councilAgreement: 0.8, regimeAlignment: 1.0,
    memorySupport: 0.7, walkForwardPass: 1, noveltyPenalty: 0.9,
  });
  assert.equal(r.id, "d-001");
  assert.ok(r.aggregate > 0.55);
  assert.equal(r.isWeak, false);
});

test("factory: low scores flagged as weak", () => {
  const meta = createMetaCognition({ threshold: 0.55 });
  const r = meta.recordDecision("d-002", {
    evidenceDepth: 0.1, councilAgreement: 0.2, regimeAlignment: 0.05,
    memorySupport: 0.3, walkForwardPass: 0, noveltyPenalty: 0.2,
  });
  assert.equal(r.isWeak, true);
  assert.ok(r.aggregate < 0.55);
});

test("factory: recordDecision with context object computes scores", () => {
  const meta = createMetaCognition({ threshold: 0.5 });
  const r = meta.recordDecision("d-ctx", {
    action: "BUY", regime: "bull",
    intelligence: { news: {}, macro: {}, sentiment: {} },
    councilResult: { consensus: 0.9, approved: true },
    walkForwardResult: "deploy",
  });
  assert.ok(r.aggregate > 0.7, "strong context should produce high score, got " + r.aggregate);
  assert.equal(r.isWeak, false);
});

test("factory: recordDecision returns null for empty id", () => {
  const meta = createMetaCognition();
  assert.equal(meta.recordDecision(null, {}), null);
  assert.equal(meta.recordDecision("", {}), null);
});

test("factory: attachOutcome links PnL to decision", () => {
  const meta = createMetaCognition();
  meta.recordDecision("d-out", {
    evidenceDepth: 0.8, councilAgreement: 0.7, regimeAlignment: 0.9,
    memorySupport: 0.6, walkForwardPass: 1, noveltyPenalty: 0.8,
  });
  const ok = meta.attachOutcome("d-out", { pnl: 15000, holdBars: 8 });
  assert.equal(ok, true);
  const entry = meta.getById("d-out");
  assert.equal(entry.outcome.pnl, 15000);
  assert.equal(entry.outcome.holdBars, 8);
});

test("factory: attachOutcome returns false for unknown id", () => {
  const meta = createMetaCognition();
  assert.equal(meta.attachOutcome("nonexistent", { pnl: 100 }), false);
});

test("factory: stats tracks counters correctly", () => {
  const meta = createMetaCognition({ threshold: 0.5 });
  meta.recordDecision("s1", {
    evidenceDepth: 0.9, councilAgreement: 0.9, regimeAlignment: 0.9,
    memorySupport: 0.9, walkForwardPass: 1, noveltyPenalty: 0.9,
  });
  meta.recordDecision("s2", {
    evidenceDepth: 0.1, councilAgreement: 0.1, regimeAlignment: 0.1,
    memorySupport: 0.1, walkForwardPass: 0, noveltyPenalty: 0.1,
  });
  meta.attachOutcome("s1", { pnl: 5000 });
  const s = meta.stats();
  assert.equal(s.totalDecisions, 2);
  assert.equal(s.strongDecisions, 1);
  assert.equal(s.weakDecisions, 1);
  assert.equal(s.outcomesAttached, 1);
  assert.equal(s.avgPnl, 5000);
});

test("factory: getWeakDecisions sorted ascending", () => {
  const meta = createMetaCognition({ threshold: 0.5 });
  meta.recordDecision("w1", {
    evidenceDepth: 0.3, councilAgreement: 0.3, regimeAlignment: 0.3,
    memorySupport: 0.3, walkForwardPass: 0, noveltyPenalty: 0.3,
  });
  meta.recordDecision("w2", {
    evidenceDepth: 0.1, councilAgreement: 0.1, regimeAlignment: 0.1,
    memorySupport: 0.1, walkForwardPass: 0, noveltyPenalty: 0.1,
  });
  meta.recordDecision("strong", {
    evidenceDepth: 0.9, councilAgreement: 0.9, regimeAlignment: 0.9,
    memorySupport: 0.9, walkForwardPass: 1, noveltyPenalty: 0.9,
  });
  const weak = meta.getWeakDecisions();
  assert.equal(weak.length, 2);
  assert.ok(weak[0].aggregate <= weak[1].aggregate);
  assert.equal(weak[0].id, "w2");
});

test("factory: getStrongDecisions sorted descending", () => {
  const meta = createMetaCognition({ threshold: 0.5 });
  meta.recordDecision("a", {
    evidenceDepth: 0.9, councilAgreement: 0.9, regimeAlignment: 0.9,
    memorySupport: 0.9, walkForwardPass: 1, noveltyPenalty: 0.9,
  });
  meta.recordDecision("b", {
    evidenceDepth: 0.7, councilAgreement: 0.7, regimeAlignment: 0.7,
    memorySupport: 0.7, walkForwardPass: 1, noveltyPenalty: 0.7,
  });
  meta.recordDecision("weak", {
    evidenceDepth: 0.1, councilAgreement: 0.1, regimeAlignment: 0.1,
    memorySupport: 0.1, walkForwardPass: 0, noveltyPenalty: 0.1,
  });
  const strong = meta.getStrongDecisions();
  assert.equal(strong.length, 2);
  assert.ok(strong[0].aggregate >= strong[1].aggregate);
  assert.equal(strong[0].id, "a");
});

test("factory: getHistory respects limit and returns tail", () => {
  const meta = createMetaCognition();
  for (let i = 0; i < 50; i++) {
    meta.recordDecision("h-" + i, {
      evidenceDepth: 0.5, councilAgreement: 0.5, regimeAlignment: 0.5,
      memorySupport: 0.5, walkForwardPass: 0.5, noveltyPenalty: 0.5,
    });
  }
  const recent = meta.getHistory(10);
  assert.equal(recent.length, 10);
  assert.equal(recent[0].id, "h-40");
  assert.equal(recent[9].id, "h-49");
});

test("factory: getById returns null for unknown id", () => {
  const meta = createMetaCognition();
  assert.equal(meta.getById("nope"), null);
});

test("factory: clear resets all counters and history", () => {
  const meta = createMetaCognition();
  meta.recordDecision("x", {
    evidenceDepth: 0.5, councilAgreement: 0.5, regimeAlignment: 0.5,
    memorySupport: 0.5, walkForwardPass: 0.5, noveltyPenalty: 0.5,
  });
  meta.attachOutcome("x", { pnl: 100 });
  meta.clear();
  const s = meta.stats();
  assert.equal(s.totalDecisions, 0);
  assert.equal(s.outcomesAttached, 0);
  assert.equal(s.historySize, 0);
});

test("factory: DIMENSIONS exposed on instance", () => {
  const meta = createMetaCognition();
  assert.equal(meta.DIMENSIONS.length, 6);
  assert.deepEqual(meta.DIMENSIONS, DIMENSIONS);
});

test("factory: calibrate returns insufficient data when too few outcomes", () => {
  const meta = createMetaCognition({ minDecisionsForCalibration: 5 });
  for (let i = 0; i < 3; i++) {
    meta.recordDecision("c-" + i, {
      evidenceDepth: 0.5, councilAgreement: 0.5, regimeAlignment: 0.5,
      memorySupport: 0.5, walkForwardPass: 0.5, noveltyPenalty: 0.5,
    });
    meta.attachOutcome("c-" + i, { pnl: i * 100 });
  }
  const r = meta.calibrate();
  assert.equal(r.calibrated, false);
  assert.match(r.reason, /insufficient data/);
});

test("factory: calibrate computes Spearman rho with sufficient data", () => {
  const meta = createMetaCognition({ minDecisionsForCalibration: 5, recalibrateEvery: 999999 });
  const baseScores = {
    councilAgreement: 0.5, regimeAlignment: 0.5,
    memorySupport: 0.5, walkForwardPass: 0.5, noveltyPenalty: 0.5,
  };
  for (let i = 0; i < 10; i++) {
    const ev = 0.1 + i * 0.08;
    meta.recordDecision("cal-" + i, { ...baseScores, evidenceDepth: ev });
    meta.attachOutcome("cal-" + i, { pnl: i * 1000 });
  }
  const r = meta.calibrate();
  assert.equal(r.calibrated, true);
  assert.ok(r.rho > 0.8, "rho should be high for monotonic data, got " + r.rho);
  assert.equal(r.sampleSize, 10);
});

test("factory: auto-calibration triggers at recalibrateEvery interval", () => {
  const meta = createMetaCognition({
    minDecisionsForCalibration: 3,
    recalibrateEvery: 5,
  });
  for (let i = 0; i < 5; i++) {
    meta.recordDecision("auto-" + i, {
      evidenceDepth: 0.5, councilAgreement: 0.5, regimeAlignment: 0.5,
      memorySupport: 0.5, walkForwardPass: 0.5, noveltyPenalty: 0.5,
    });
    meta.attachOutcome("auto-" + i, { pnl: i * 100 });
  }
  const s = meta.stats();
  assert.equal(s.calibrations, 1, "auto-calibrate should have fired once at decision #5");
});

test("factory: maxHistory trims oldest entries", () => {
  const meta = createMetaCognition({ maxHistory: 5 });
  for (let i = 0; i < 10; i++) {
    meta.recordDecision("trim-" + i, {
      evidenceDepth: 0.5, councilAgreement: 0.5, regimeAlignment: 0.5,
      memorySupport: 0.5, walkForwardPass: 0.5, noveltyPenalty: 0.5,
    });
  }
  const s = meta.stats();
  assert.equal(s.historySize, 5);
  const hist = meta.getHistory(100);
  assert.equal(hist[0].id, "trim-5");
  assert.equal(hist[4].id, "trim-9");
});

test("factory: custom weights affect aggregate score", () => {
  const meta = createMetaCognition({
    weights: { evidenceDepth: 5.0, councilAgreement: 0.0, regimeAlignment: 0.0, memorySupport: 0.0, walkForwardPass: 0.0, noveltyPenalty: 0.0 },
  });
  const r = meta.recordDecision("w-custom", {
    evidenceDepth: 0.8, councilAgreement: 0.1, regimeAlignment: 0.1,
    memorySupport: 0.1, walkForwardPass: 0, noveltyPenalty: 0.1,
  });
  assert.ok(Math.abs(r.aggregate - 0.8) < 0.01, "custom weight should give ~0.8, got " + r.aggregate);
});
