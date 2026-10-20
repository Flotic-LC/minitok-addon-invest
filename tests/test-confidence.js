"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createConfidenceCalibrator,
  extractAction,
  extractNumerics,
  coefficientOfVariation,
  computeActionAgreement,
  computeNumericStability,
  computeLogprobScore,
  DEFAULTS,
} = require("../src/ai/confidence");

// ============================================================================
// DEFAULTS
// ============================================================================
test("DEFAULTS: sampleCount is 3, minThreshold is 0.40", () => {
  assert.equal(DEFAULTS.sampleCount, 3);
  assert.equal(DEFAULTS.minThreshold, 0.40);
  assert.equal(DEFAULTS.skipThreshold, 0.20);
  assert.equal(DEFAULTS.positionScaleFloor, 0.25);
  assert.equal(DEFAULTS.maxHistorySize, 1000);
  assert.equal(DEFAULTS.actionField, "action");
  assert.deepEqual(DEFAULTS.weights, { actionAgreement: 0.5, numericStability: 0.3, logprobScore: 0.2 });
});

// ============================================================================
// extractAction
// ============================================================================
test("extractAction: returns uppercase trimmed action string", () => {
  assert.equal(extractAction({ action: "buy" }, "action"), "BUY");
  assert.equal(extractAction({ action: "  SELL  " }, "action"), "SELL");
  assert.equal(extractAction({ action: "Hold" }, "action"), "HOLD");
});

test("extractAction: returns null for missing or non-object input", () => {
  assert.equal(extractAction(null, "action"), null);
  assert.equal(extractAction({}, "action"), null);
  assert.equal(extractAction({ action: null }, "action"), null);
});

test("extractAction: stringifies non-string values", () => {
  assert.equal(extractAction({ action: 42 }, "action"), "42");
  assert.equal(extractAction({ action: true }, "action"), "TRUE");
});

// ============================================================================
// extractNumerics
// ============================================================================
test("extractNumerics: extracts number fields", () => {
  const r = extractNumerics({ targetPrice: 100, quantity: 50, other: "x" }, ["targetPrice", "quantity"]);
  assert.deepEqual(r, { targetPrice: 100, quantity: 50 });
});

test("extractNumerics: converts string-numbers", () => {
  const r = extractNumerics({ targetPrice: "99.5" }, ["targetPrice"]);
  assert.deepEqual(r, { targetPrice: 99.5 });
});

test("extractNumerics: skips non-numeric strings and null", () => {
  const r = extractNumerics({ targetPrice: "abc", quantity: null }, ["targetPrice", "quantity"]);
  assert.deepEqual(r, {});
});

test("extractNumerics: returns empty for null input", () => {
  assert.deepEqual(extractNumerics(null, ["x"]), {});
});

// ============================================================================
// coefficientOfVariation
// ============================================================================
test("coefficientOfVariation: returns 0 for < 2 elements", () => {
  assert.equal(coefficientOfVariation([]), 0);
  assert.equal(coefficientOfVariation([5]), 0);
  assert.equal(coefficientOfVariation(null), 0);
});

test("coefficientOfVariation: returns 0 for identical values", () => {
  assert.equal(coefficientOfVariation([10, 10, 10]), 0);
});

test("coefficientOfVariation: computes correct CV for known data", () => {
  // mean=10, sd=2 -> CV=0.2
  const cv = coefficientOfVariation([8, 10, 12]);
  const mean = 10;
  const sd = Math.sqrt(((8 - mean) ** 2 + (10 - mean) ** 2 + (12 - mean) ** 2) / 3);
  const expected = sd / mean;
  assert.ok(Math.abs(cv - expected) < 0.0001, "CV should be " + expected + " got " + cv);
});

// ============================================================================
// computeActionAgreement
// ============================================================================
test("computeActionAgreement: all same action = 1.0", () => {
  const r = computeActionAgreement(["BUY", "BUY", "BUY"]);
  assert.equal(r.agreement, 1.0);
  assert.equal(r.modal, "BUY");
  assert.equal(r.total, 3);
});

test("computeActionAgreement: 2 out of 3 same = 0.667", () => {
  const r = computeActionAgreement(["BUY", "BUY", "SELL"]);
  assert.ok(Math.abs(r.agreement - 2 / 3) < 0.0001);
  assert.equal(r.modal, "BUY");
});

test("computeActionAgreement: all different = 0.333", () => {
  const r = computeActionAgreement(["BUY", "SELL", "HOLD"]);
  assert.ok(Math.abs(r.agreement - 1 / 3) < 0.0001);
});

test("computeActionAgreement: skips null and empty", () => {
  const r = computeActionAgreement(["BUY", null, "", "BUY"]);
  assert.equal(r.agreement, 1.0);
  assert.equal(r.total, 2);
});

test("computeActionAgreement: all empty returns 0", () => {
  const r = computeActionAgreement([null, null, ""]);
  assert.equal(r.agreement, 0);
  assert.equal(r.modal, null);
});

// ============================================================================
// computeNumericStability
// ============================================================================
test("computeNumericStability: identical values across samples = 1.0", () => {
  const samples = [
    { parsed: { targetPrice: 100, quantity: 50 } },
    { parsed: { targetPrice: 100, quantity: 50 } },
    { parsed: { targetPrice: 100, quantity: 50 } },
  ];
  const r = computeNumericStability(samples, ["targetPrice", "quantity"]);
  assert.equal(r, 1.0);
});

test("computeNumericStability: returns 0.5 when no numeric fields", () => {
  const samples = [{ parsed: { action: "BUY" } }, { parsed: { action: "BUY" } }];
  const r = computeNumericStability(samples, ["targetPrice"]);
  assert.equal(r, 0.5);
});

test("computeNumericStability: high variance = low stability", () => {
  const samples = [
    { parsed: { targetPrice: 10 } },
    { parsed: { targetPrice: 100 } },
    { parsed: { targetPrice: 1000 } },
  ];
  const r = computeNumericStability(samples, ["targetPrice"]);
  assert.ok(r < 0.5, "high variance should give low stability, got " + r);
});

// ============================================================================
// computeLogprobScore
// ============================================================================
test("computeLogprobScore: returns null when no logprobs", () => {
  const samples = [{ parsed: { action: "BUY" } }, { parsed: { action: "BUY" } }];
  assert.equal(computeLogprobScore(samples), null);
});

test("computeLogprobScore: logprob 0 -> exp(0) = 1.0", () => {
  const samples = [{ logprob: 0 }, { logprob: 0 }];
  const r = computeLogprobScore(samples);
  assert.equal(r, 1.0);
});

test("computeLogprobScore: negative logprobs normalized to (0,1)", () => {
  const samples = [{ logprob: -0.5 }, { logprob: -0.5 }];
  const r = computeLogprobScore(samples);
  const expected = Math.exp(-0.5);
  assert.ok(Math.abs(r - expected) < 0.0001);
});

test("computeLogprobScore: reads from raw.logprob", () => {
  const samples = [{ raw: { logprob: -0.1 } }];
  const r = computeLogprobScore(samples);
  const expected = Math.exp(-0.1);
  assert.ok(Math.abs(r - expected) < 0.0001);
});

test("coefficientOfVariation: returns 0 when mean is 0", () => {
  assert.equal(coefficientOfVariation([0, 0, 0]), 0);
});

// ============================================================================
// evaluateFromResponses — core confidence computation
// ============================================================================
test("evaluateFromResponses: empty array returns skip with confidence=0", () => {
  const c = createConfidenceCalibrator();
  const r = c.evaluateFromResponses([]);
  assert.equal(r.confidence, 0);
  assert.equal(r.recommendation, "skip");
  assert.equal(r.positionScale, 0);
  assert.equal(r.sampleCount, 0);
});

test("evaluateFromResponses: unanimous BUY with stable numerics = high confidence", () => {
  const c = createConfidenceCalibrator();
  const samples = [
    { parsed: { action: "BUY", targetPrice: 100, quantity: 50 } },
    { parsed: { action: "BUY", targetPrice: 100, quantity: 50 } },
    { parsed: { action: "BUY", targetPrice: 100, quantity: 50 } },
  ];
  const r = c.evaluateFromResponses(samples);
  assert.equal(r.actionAgreement, 1.0);
  assert.equal(r.numericStability, 1.0);
  assert.equal(r.modal, "BUY");
  assert.equal(r.recommendation, "proceed");
  assert.equal(r.positionScale, 1.0);
  assert.ok(r.confidence >= 0.9, "confidence should be >=0.9, got " + r.confidence);
});

test("evaluateFromResponses: mixed actions = lower agreement", () => {
  const c = createConfidenceCalibrator();
  const samples = [
    { parsed: { action: "BUY" } },
    { parsed: { action: "SELL" } },
    { parsed: { action: "HOLD" } },
  ];
  const r = c.evaluateFromResponses(samples);
  assert.ok(r.actionAgreement < 0.5, "3-way split should give low agreement, got " + r.actionAgreement);
});

test("evaluateFromResponses: confidence below minThreshold gives reduce", () => {
  const c = createConfidenceCalibrator({ config: { minThreshold: 0.60, skipThreshold: 0.30 } });
  const samples = [
    { parsed: { action: "BUY" } },
    { parsed: { action: "SELL" } },
    { parsed: { action: "HOLD" } },
  ];
  const r = c.evaluateFromResponses(samples);
  // agreement=0.333, numericStability=0.5 (neutral, no numerics)
  // no logprob -> weights redistribute: action=0.625, numeric=0.375
  // confidence ≈ 0.625*0.333 + 0.375*0.5 = 0.208 + 0.1875 = 0.396
  assert.ok(r.confidence < 0.60, "confidence should be < 0.60, got " + r.confidence);
  assert.ok(r.confidence >= 0.30, "confidence should be >= 0.30, got " + r.confidence);
  assert.equal(r.recommendation, "reduce");
  assert.equal(r.positionScale, 0.25);
});

test("evaluateFromResponses: very low confidence gives skip", () => {
  const c = createConfidenceCalibrator({ config: { minThreshold: 0.99, skipThreshold: 0.90 } });
  const samples = [
    { parsed: { action: "BUY" } },
    { parsed: { action: "SELL" } },
    { parsed: { action: "HOLD" } },
  ];
  const r = c.evaluateFromResponses(samples);
  assert.ok(r.confidence < 0.90, "should be below skipThreshold, got " + r.confidence);
  assert.equal(r.recommendation, "skip");
  assert.equal(r.positionScale, 0);
});

test("evaluateFromResponses: logprobScore included when available", () => {
  const c = createConfidenceCalibrator();
  const samples = [
    { parsed: { action: "BUY", targetPrice: 100 }, logprob: -0.01 },
    { parsed: { action: "BUY", targetPrice: 100 }, logprob: -0.01 },
    { parsed: { action: "BUY", targetPrice: 100 }, logprob: -0.01 },
  ];
  const r = c.evaluateFromResponses(samples);
  assert.ok(r.logprobScore != null, "logprobScore should be present");
  assert.ok(r.logprobScore > 0.9, "logprob near 0 should give high score, got " + r.logprobScore);
});

test("evaluateFromResponses: logprob weight redistributed when unavailable", () => {
  const c = createConfidenceCalibrator();
  const samplesNoLogprob = [
    { parsed: { action: "BUY", targetPrice: 100, quantity: 50 } },
    { parsed: { action: "BUY", targetPrice: 100, quantity: 50 } },
    { parsed: { action: "BUY", targetPrice: 100, quantity: 50 } },
  ];
  const r = c.evaluateFromResponses(samplesNoLogprob);
  assert.equal(r.logprobScore, null);
  // Without logprob, action(0.5) and numeric(0.3) redistribute to 0.625 and 0.375
  // agreement=1.0, numericStability=1.0 -> confidence=1.0
  assert.equal(r.confidence, 1.0);
});


// ============================================================================
// evaluate (async) — LLM sampling
// ============================================================================
test("evaluate: calls callLLM N times and returns confidence", async () => {
  let callCount = 0;
  const callLLM = async () => {
    callCount++;
    return { action: "BUY", targetPrice: 100 };
  };
  const c = createConfidenceCalibrator({ config: { sampleCount: 3 } });
  const r = await c.evaluate(callLLM, [{ role: "user", content: "hi" }]);
  assert.equal(callCount, 3);
  assert.equal(r.sampleCount, 3);
  assert.equal(r.recommendation, "proceed");
  assert.equal(r.confidence, 1.0);
});

test("evaluate: handles null responses as errors", async () => {
  let callCount = 0;
  const callLLM = async () => {
    callCount++;
    return null;
  };
  const c = createConfidenceCalibrator({ config: { sampleCount: 3 } });
  const r = await c.evaluate(callLLM, []);
  assert.equal(callCount, 3);
  assert.equal(r.sampleCount, 0);
  assert.equal(r.errorCount, 3);
  assert.equal(r.recommendation, "skip");
});

test("evaluate: handles thrown errors gracefully", async () => {
  const callLLM = async () => { throw new Error("network down"); };
  const c = createConfidenceCalibrator({ config: { sampleCount: 2 } });
  const r = await c.evaluate(callLLM, []);
  assert.equal(r.errorCount, 2);
  assert.equal(r.sampleCount, 0);
  assert.ok(r.errors);
  assert.equal(r.errors.length, 2);
});

test("evaluate: supports { parsed, logprob } envelope", async () => {
  const callLLM = async () => ({ parsed: { action: "BUY" }, logprob: -0.1 });
  const c = createConfidenceCalibrator({ config: { sampleCount: 2 } });
  const r = await c.evaluate(callLLM, []);
  assert.equal(r.sampleCount, 2);
  assert.ok(r.logprobScore != null);
});

test("evaluate: throws if callLLM is not a function", async () => {
  const c = createConfidenceCalibrator();
  await assert.rejects(() => c.evaluate("not a function", []), /callLLM must be a function/);
});

test("evaluate: throws if messages is not an array", async () => {
  const c = createConfidenceCalibrator();
  await assert.rejects(() => c.evaluate(async () => ({}), "not array"), /messages must be an array/);
});

// ============================================================================
// adjustPosition
// ============================================================================
test("adjustPosition: scales quantity by positionScale", () => {
  const c = createConfidenceCalibrator();
  assert.equal(c.adjustPosition(100, { positionScale: 1.0 }), 100);
  assert.equal(c.adjustPosition(100, { positionScale: 0.25 }), 25);
  assert.equal(c.adjustPosition(100, { positionScale: 0 }), 0);
});

test("adjustPosition: floors the result", () => {
  const c = createConfidenceCalibrator();
  assert.equal(c.adjustPosition(10, { positionScale: 0.25 }), 2);
  assert.equal(c.adjustPosition(7, { positionScale: 0.5 }), 3);
});

test("adjustPosition: returns quantity unchanged if result is null", () => {
  const c = createConfidenceCalibrator();
  assert.equal(c.adjustPosition(100, null), 100);
  assert.equal(c.adjustPosition(100, undefined), 100);
});

test("adjustPosition: returns 0 for invalid quantity", () => {
  const c = createConfidenceCalibrator();
  assert.equal(c.adjustPosition(null, { positionScale: 1.0 }), 0);
  assert.equal(c.adjustPosition(NaN, { positionScale: 1.0 }), 0);
});

test("adjustPosition: clamps positionScale to [0,1]", () => {
  const c = createConfidenceCalibrator();
  assert.equal(c.adjustPosition(100, { positionScale: 1.5 }), 100);
  assert.equal(c.adjustPosition(100, { positionScale: -0.5 }), 0);
});


// ============================================================================
// stats, getHistory, state/restore, reset
// ============================================================================
test("stats: returns correct shape and counts", async () => {
  const callLLM = async () => ({ action: "BUY", targetPrice: 100 });
  const c = createConfidenceCalibrator({ config: { sampleCount: 2 } });
  await c.evaluate(callLLM, []);
  await c.evaluate(callLLM, []);
  const s = c.stats();
  assert.equal(s.totalEvaluations, 2);
  assert.equal(s.proceededCount, 2);
  assert.equal(s.historySize, 2);
  assert.equal(s.sampleCount, 2);
  assert.equal(s.minThreshold, 0.40);
  assert.equal(s.skipThreshold, 0.20);
  assert.equal(s.positionScaleFloor, 0.25);
});

test("getHistory: returns all entries by default", async () => {
  const callLLM = async () => ({ action: "BUY" });
  const c = createConfidenceCalibrator({ config: { sampleCount: 1 } });
  await c.evaluate(callLLM, []);
  await c.evaluate(callLLM, []);
  await c.evaluate(callLLM, []);
  assert.equal(c.getHistory().length, 3);
});

test("getHistory: limit returns last N entries", async () => {
  const callLLM = async () => ({ action: "BUY" });
  const c = createConfidenceCalibrator({ config: { sampleCount: 1 } });
  for (let i = 0; i < 5; i++) await c.evaluate(callLLM, []);
  const h = c.getHistory(2);
  assert.equal(h.length, 2);
});

test("state() and restore() round-trip preserves counters and history", async () => {
  const callLLM = async () => ({ action: "BUY" });
  const c1 = createConfidenceCalibrator({ config: { sampleCount: 1 } });
  await c1.evaluate(callLLM, []);
  await c1.evaluate(callLLM, []);
  const saved = c1.state();
  const c2 = createConfidenceCalibrator();
  c2.restore(saved);
  const s = c2.stats();
  assert.equal(s.totalEvaluations, 2);
  assert.equal(s.historySize, 2);
});

test("restore with null does not throw", () => {
  const c = createConfidenceCalibrator();
  c.restore(null);
  c.restore(undefined);
  assert.equal(c.stats().historySize, 0);
});

test("reset() clears all state", async () => {
  const callLLM = async () => ({ action: "BUY" });
  const c = createConfidenceCalibrator({ config: { sampleCount: 1 } });
  await c.evaluate(callLLM, []);
  c.reset();
  const s = c.stats();
  assert.equal(s.totalEvaluations, 0);
  assert.equal(s.historySize, 0);
  assert.equal(s.lastConfidence, null);
});

// ============================================================================
// onLowConfidence callback
// ============================================================================
test("onLowConfidence callback fires when confidence < minThreshold", async () => {
  const events = [];
  const callLLM = async () => ({ action: "BUY" });
  const c = createConfidenceCalibrator({
    config: { sampleCount: 1, minThreshold: 0.99 },
    onLowConfidence: (r) => events.push(r),
  });
  await c.evaluate(callLLM, []);
  assert.equal(events.length, 1);
  assert.ok(events[0].confidence < 0.99);
});

test("onLowConfidence callback is exception-safe", async () => {
  const callLLM = async () => ({ action: "BUY" });
  const c = createConfidenceCalibrator({
    config: { sampleCount: 1, minThreshold: 0.99 },
    onLowConfidence: () => { throw new Error("callback error"); },
  });
  const r = await c.evaluate(callLLM, []);
  assert.ok(r.confidence != null);
});

test("maxHistorySize caps history", async () => {
  const callLLM = async () => ({ action: "BUY" });
  const c = createConfidenceCalibrator({ config: { sampleCount: 1, maxHistorySize: 3 } });
  for (let i = 0; i < 6; i++) await c.evaluate(callLLM, []);
  assert.equal(c.getHistory().length, 3);
});

