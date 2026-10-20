"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createRegimeHMM, extractFeatures, DEFAULTS } = require("../src/strategy/regime-hmm");

// --- Helper: generate synthetic returns for known regime ---
function generateReturns(n, mean, vol, seed) {
  let s = seed | 0;
  function rng() {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function norm() {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }
  const out = [];
  for (let i = 0; i < n; i++) out.push(mean + vol * norm());
  return out;
}

// --- extractFeatures ---
test("extractFeatures returns correct number of feature vectors", () => {
  const returns = generateReturns(100, 0.001, 0.02, 42);
  const feats = extractFeatures(returns, { trendWindow: 20, volWindow: 5 });
  assert.equal(feats.length, 100 - 20);
  assert.equal(feats[0].length, 3);
});

test("extractFeatures returns empty for insufficient data", () => {
  const returns = [0.01, 0.02, -0.01];
  const feats = extractFeatures(returns, { trendWindow: 20, volWindow: 5 });
  assert.equal(feats.length, 0);
});

// --- HMM creation ---
test("createRegimeHMM returns engine with correct config", () => {
  const hmm = createRegimeHMM({ nStates: 3, seed: 42 });
  assert.equal(hmm.config.nStates, 3);
  assert.equal(hmm.trained, false);
  assert.deepEqual(hmm.config.labels, ["bear", "sideways", "bull"]);
});

// --- Training ---
test("train fails with insufficient data", () => {
  const hmm = createRegimeHMM({ nStates: 3 });
  const result = hmm.train([0.01, 0.02, 0.03]);
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes("insufficient"));
});

test("train succeeds with enough synthetic data", () => {
  const hmm = createRegimeHMM({ nStates: 3, seed: 42, maxIter: 30 });
  const bear = generateReturns(70, -0.005, 0.03, 1);
  const sideways = generateReturns(60, 0.0, 0.01, 2);
  const bull = generateReturns(70, 0.005, 0.02, 3);
  const returns = [...bear, ...sideways, ...bull];
  const result = hmm.train(returns);
  assert.equal(result.ok, true);
  assert.equal(hmm.trained, true);
  assert.ok(result.iterations > 0);
  assert.ok(result.observations > 0);
});

test("trained HMM has valid transition matrix", () => {
  const hmm = createRegimeHMM({ nStates: 3, seed: 42, maxIter: 20 });
  const returns = generateReturns(150, 0.001, 0.02, 99);
  hmm.train(returns);
  const { A, pi } = hmm.params;
  for (let i = 0; i < A.length; i++) {
    const rowSum = A[i].reduce((s, v) => s + v, 0);
    assert.ok(Math.abs(rowSum - 1.0) < 0.01, "A row " + i + " sum=" + rowSum);
  }
  const piSum = pi.reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(piSum - 1.0) < 0.01, "pi sum=" + piSum);
});

// --- Filter ---
test("filter returns unknown when not trained", () => {
  const hmm = createRegimeHMM({ nStates: 3 });
  const result = hmm.filter([0.01, 0.02, 0.03]);
  assert.equal(result.state, -1);
  assert.equal(result.label, "unknown");
  assert.equal(result.reason, "not trained");
});

test("filter returns state probabilities after training", () => {
  const hmm = createRegimeHMM({ nStates: 3, seed: 42, maxIter: 20 });
  const returns = generateReturns(200, 0.002, 0.015, 55);
  hmm.train(returns);
  const result = hmm.filter([0.005, 0.01, 0.03]);
  assert.ok(result.state >= 0 && result.state < 3);
  assert.ok(result.prob > 0 && result.prob <= 1);
  assert.equal(result.probs.length, 3);
  const probSum = result.probs.reduce((s, p) => s + p, 0);
  assert.ok(Math.abs(probSum - 1.0) < 0.01, "probs should sum to ~1");
});

test("filterOnline produces consistent results with transition memory", () => {
  const hmm = createRegimeHMM({ nStates: 3, seed: 42, maxIter: 20 });
  const returns = generateReturns(200, 0.001, 0.02, 77);
  hmm.train(returns);
  hmm.resetOnline();
  const r1 = hmm.filterOnline([0.01, 0.015, 0.05]);
  const r2 = hmm.filterOnline([0.01, 0.015, 0.05]);
  assert.ok(r1.state >= 0);
  assert.ok(r2.state >= 0);
  assert.equal(r1.probs.length, 3);
  assert.equal(r2.probs.length, 3);
});

// --- Viterbi ---
test("viterbi returns empty when not trained", () => {
  const hmm = createRegimeHMM({ nStates: 3 });
  const result = hmm.viterbi([[0.01, 0.02, 0.03]]);
  assert.deepEqual(result, []);
});

test("viterbi returns state sequence of correct length", () => {
  const hmm = createRegimeHMM({ nStates: 3, seed: 42, maxIter: 20 });
  const returns = generateReturns(150, 0.001, 0.02, 88);
  hmm.train(returns);
  const feats = extractFeatures(returns, { trendWindow: 20, volWindow: 5 });
  const path = hmm.viterbi(feats);
  assert.equal(path.length, feats.length);
  for (const step of path) {
    assert.ok(step.state >= 0 && step.state < 3);
    assert.ok(typeof step.label === "string");
  }
});

// --- Position multiplier ---
test("getPositionMultiplier returns 1.0 when not trained", () => {
  const hmm = createRegimeHMM({ nStates: 3 });
  assert.equal(hmm.getPositionMultiplier([0.01, 0.02, 0.03]), 1.0);
});

test("getPositionMultiplier returns valid multiplier after training", () => {
  const hmm = createRegimeHMM({ nStates: 3, seed: 42, maxIter: 20 });
  const returns = generateReturns(200, 0.002, 0.015, 66);
  hmm.train(returns);
  hmm.resetOnline();
  const mult = hmm.getPositionMultiplier([0.005, 0.01, 0.03]);
  assert.ok(mult >= 0.25 && mult <= 1.5, "multiplier should be in valid range, got " + mult);
});

// --- History ---
test("training history records each train call", () => {
  const hmm = createRegimeHMM({ nStates: 3, seed: 42, maxIter: 10 });
  const returns = generateReturns(100, 0.001, 0.02, 33);
  hmm.train(returns);
  hmm.train(returns);
  assert.equal(hmm.history.length, 2);
  assert.ok(hmm.history[0].ts);
  assert.ok(hmm.history[0].iter > 0);
});

// --- Reset ---
test("resetOnline clears posterior memory", () => {
  const hmm = createRegimeHMM({ nStates: 3, seed: 42, maxIter: 20 });
  const returns = generateReturns(150, 0.001, 0.02, 44);
  hmm.train(returns);
  hmm.filterOnline([0.01, 0.02, 0.05]);
  hmm.resetOnline();
  const result = hmm.filterOnline([0.01, 0.02, 0.05]);
  assert.ok(result.state >= 0);
});

test("trained HMM emission means are sorted by return", () => {
  const hmm = createRegimeHMM({ nStates: 3, seed: 42, maxIter: 30 });
  const bear = generateReturns(70, -0.01, 0.03, 10);
  const sideways = generateReturns(60, 0.0, 0.01, 20);
  const bull = generateReturns(70, 0.01, 0.02, 30);
  hmm.train([...bear, ...sideways, ...bull]);
  const { mu } = hmm.params;
  assert.ok(mu[0][0] < mu[1][0], "bear mean should be < sideways mean");
  assert.ok(mu[1][0] < mu[2][0], "sideways mean should be < bull mean");
});
