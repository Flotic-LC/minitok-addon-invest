"use strict";

/**
 * Confidence Calibration (Phase K / L4.5) — quantifies LLM uncertainty by
 * sampling the model N times for the same prompt and measuring response
 * consistency. When confidence drops below threshold, position sizes are
 * automatically scaled down (or trades skipped entirely).
 *
 * Confidence is computed from three signals:
 *   1. actionAgreement   — fraction of samples that share the modal action
 *   2. numericStability  — 1 - coefficient_of_variation across numeric fields
 *   3. logprobScore      — mean token logprob if provider exposes it
 *
 * Recommendation tiers:
 *   confidence >= minThreshold   → proceed (scale = 1.0)
 *   confidence >= skipThreshold  → reduce  (scale = positionScaleFloor)
 *   confidence <  skipThreshold  → skip    (scale = 0)
 *
 * Usage:
 *   const { createConfidenceCalibrator } = require("./src/ai/confidence");
 *   const conf = createConfidenceCalibrator({ sampleCount: 3, minThreshold: 0.40 });
 *   const result = await conf.evaluate(callLLM, messages);
 *   const qty = conf.adjustPosition(100, result);
 *   conf.stats();
 */

const DEFAULTS = Object.freeze({
  sampleCount: Number(process.env.CONFIDENCE_SAMPLES || process.env.CONFIDENCE_SAMPLE_COUNT || 3),
  minThreshold: Number(process.env.CONFIDENCE_MIN_THRESHOLD || 0.40),
  skipThreshold: Number(process.env.CONFIDENCE_SKIP_THRESHOLD || 0.20),
  positionScaleFloor: Number(process.env.CONFIDENCE_POSITION_FLOOR || 0.25),
  maxHistorySize: Number(process.env.CONFIDENCE_MAX_HISTORY || 1000),
  actionField: "action",
  numericFields: ["targetPrice", "quantity", "confidence", "score", "price", "amount", "pct"],
  weights: { actionAgreement: 0.5, numericStability: 0.3, logprobScore: 0.2 },
  concurrencyLimit: 3,
});

function clamp01(v) {
  if (v == null || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function extractAction(parsed, field) {
  if (!parsed || typeof parsed !== "object") return null;
  const v = parsed[field];
  if (typeof v === "string") return v.toUpperCase().trim();
  if (v == null) return null;
  return String(v).toUpperCase().trim();
}

function extractNumerics(parsed, fields) {
  const out = {};
  if (!parsed || typeof parsed !== "object") return out;
  for (const f of fields) {
    const v = parsed[f];
    if (typeof v === "number" && Number.isFinite(v)) {
      out[f] = v;
    } else if (typeof v === "string") {
      const n = Number(v);
      if (Number.isFinite(n)) out[f] = n;
    }
  }
  return out;
}

function coefficientOfVariation(arr) {
  if (!arr || arr.length < 2) return 0;
  const n = arr.length;
  let sum = 0;
  for (const v of arr) sum += v;
  const mean = sum / n;
  if (mean === 0) return 0;
  let sq = 0;
  for (const v of arr) sq += (v - mean) * (v - mean);
  const sd = Math.sqrt(sq / n);
  return Math.abs(sd / mean);
}

function computeActionAgreement(actions) {
  const valid = actions.filter((a) => a != null && a !== "");
  if (valid.length === 0) return { agreement: 0, modal: null, total: 0 };
  const counts = {};
  for (const a of valid) counts[a] = (counts[a] || 0) + 1;
  let maxCount = 0;
  let modal = null;
  for (const k of Object.keys(counts)) {
    if (counts[k] > maxCount) { maxCount = counts[k]; modal = k; }
  }
  return { agreement: maxCount / valid.length, modal: modal, total: valid.length };
}

function computeNumericStability(samples, numericFields) {
  const perField = {};
  for (const f of numericFields) perField[f] = [];
  for (const s of samples) {
    const nums = extractNumerics(s.parsed, numericFields);
    for (const f of numericFields) {
      if (nums[f] != null) perField[f].push(nums[f]);
    }
  }
  const cvs = [];
  for (const f of numericFields) {
    if (perField[f].length >= 2) {
      cvs.push(coefficientOfVariation(perField[f]));
    }
  }
  if (cvs.length === 0) return 0.5;
  const avgCv = cvs.reduce((a, b) => a + b, 0) / cvs.length;
  return clamp01(1 - avgCv);
}

function computeLogprobScore(samples) {
  const logprobs = [];
  for (const s of samples) {
    if (typeof s.logprob === "number" && Number.isFinite(s.logprob)) {
      logprobs.push(s.logprob);
    } else if (s.raw && typeof s.raw.logprob === "number" && Number.isFinite(s.raw.logprob)) {
      logprobs.push(s.raw.logprob);
    }
  }
  if (logprobs.length === 0) return null;
  const mean = logprobs.reduce((a, b) => a + b, 0) / logprobs.length;
  return clamp01(Math.exp(mean));
}

function createConfidenceCalibrator(options) {
  const opts = options || {};
  const cfg = Object.assign({}, DEFAULTS, opts.config || {});
  const weights = Object.assign({}, DEFAULTS.weights, opts.weights || cfg.weights || {});
  const onLowConfidence = opts.onLowConfidence || function() {};
  const now = opts.now || function() { return Date.now(); };

  const history = [];
  let totalEvaluations = 0;
  let lowConfidenceCount = 0;
  let skippedCount = 0;
  let reducedCount = 0;
  let proceededCount = 0;
  let lastConfidence = null;

  function appendHistory(entry) {
    history.push(entry);
    while (history.length > cfg.maxHistorySize) history.shift();
  }

  function evaluateFromResponses(samples) {
    if (!Array.isArray(samples) || samples.length === 0) {
      return {
        confidence: 0, actionAgreement: 0, numericStability: 0,
        logprobScore: null, modal: null, recommendation: "skip",
        positionScale: 0, sampleCount: 0, samples: [],
      };
    }

    const actions = samples.map((s) => extractAction(s.parsed, cfg.actionField));
    const { agreement, modal } = computeActionAgreement(actions);
    const numericStability = computeNumericStability(samples, cfg.numericFields);
    const logprobScore = computeLogprobScore(samples);

    let wAction = weights.actionAgreement;
    let wNumeric = weights.numericStability;
    let wLogprob = weights.logprobScore;
    if (logprobScore == null) {
      const sum = wAction + wNumeric;
      if (sum > 0) { wAction = wAction / sum; wNumeric = wNumeric / sum; }
      wLogprob = 0;
    }

    const confidence = clamp01(
      wAction * agreement + wNumeric * numericStability + wLogprob * (logprobScore || 0)
    );

    let recommendation, positionScale;
    if (confidence >= cfg.minThreshold) {
      recommendation = "proceed"; positionScale = 1.0;
    } else if (confidence >= cfg.skipThreshold) {
      recommendation = "reduce"; positionScale = cfg.positionScaleFloor;
    } else {
      recommendation = "skip"; positionScale = 0;
    }

    return {
      confidence: Number(confidence.toFixed(4)),
      actionAgreement: Number(agreement.toFixed(4)),
      numericStability: Number(numericStability.toFixed(4)),
      logprobScore: logprobScore != null ? Number(logprobScore.toFixed(4)) : null,
      modal: modal, recommendation: recommendation, positionScale: positionScale,
      sampleCount: samples.length,
      samples: samples.map((s) => ({ parsed: s.parsed, logprob: s.logprob || null })),
    };
  }

  async function evaluate(callLLM, messages) {
    if (typeof callLLM !== "function") {
      throw new Error("confidence: callLLM must be a function");
    }
    if (!Array.isArray(messages)) {
      throw new Error("confidence: messages must be an array");
    }

    const t0 = now();
    const samples = [];
    const errors = [];

    const limit = Math.min(cfg.concurrencyLimit, cfg.sampleCount);
    let cursor = 0;
    async function worker() {
      while (cursor < cfg.sampleCount) {
        const idx = cursor++;
        try {
          const result = await callLLM(messages, { sampleIndex: idx });
          if (result == null) {
            errors.push({ idx: idx, error: "null response" });
            continue;
          }
          if (typeof result === "object" && result !== null && "parsed" in result) {
            samples.push({
              parsed: result.parsed,
              logprob: result.logprob != null ? result.logprob : null,
              raw: result.raw || null,
            });
          } else {
            samples.push({ parsed: result, logprob: null, raw: null });
          }
        } catch (e) {
          errors.push({ idx: idx, error: e && e.message ? e.message : String(e) });
        }
      }
    }
    const workers = [];
    for (let i = 0; i < limit; i++) workers.push(worker());
    await Promise.all(workers);

    const evalResult = evaluateFromResponses(samples);
    const elapsedMs = now() - t0;

    totalEvaluations++;
    lastConfidence = evalResult.confidence;
    if (evalResult.recommendation === "skip") skippedCount++;
    else if (evalResult.recommendation === "reduce") reducedCount++;
    else proceededCount++;
    if (evalResult.confidence < cfg.minThreshold) {
      lowConfidenceCount++;
      safeCallback(onLowConfidence, evalResult);
    }

    const entry = {
      ts: new Date(t0).toISOString(),
      confidence: evalResult.confidence,
      modal: evalResult.modal,
      recommendation: evalResult.recommendation,
      positionScale: evalResult.positionScale,
      sampleCount: samples.length,
      errorCount: errors.length,
      elapsedMs: elapsedMs,
    };
    appendHistory(entry);

    return Object.assign({}, evalResult, {
      elapsedMs: elapsedMs,
      errorCount: errors.length,
      errors: errors.length > 0 ? errors.slice() : undefined,
    });
  }

  function adjustPosition(quantity, result) {
    if (quantity == null || !Number.isFinite(quantity)) return 0;
    if (!result || typeof result !== "object") return quantity;
    const scale = typeof result.positionScale === "number"
      ? Math.max(0, Math.min(1, result.positionScale))
      : 1.0;
    return Math.floor(quantity * scale);
  }

  function safeCallback(fn, arg) {
    try { fn(arg); } catch (e) { /* never let callback errors break flow */ }
  }



  function stats() {
    const avgConf = history.length > 0
      ? history.reduce((s, e) => s + e.confidence, 0) / history.length
      : 0;
    return {
      totalEvaluations: totalEvaluations,
      lowConfidenceCount: lowConfidenceCount,
      skippedCount: skippedCount,
      reducedCount: reducedCount,
      proceededCount: proceededCount,
      lastConfidence: lastConfidence,
      avgConfidence: Number(avgConf.toFixed(4)),
      historySize: history.length,
      maxHistorySize: cfg.maxHistorySize,
      sampleCount: cfg.sampleCount,
      minThreshold: cfg.minThreshold,
      skipThreshold: cfg.skipThreshold,
      positionScaleFloor: cfg.positionScaleFloor,
    };
  }

  function getHistory(limit) {
    if (typeof limit === "number" && limit > 0) {
      return history.slice(-limit).map((e) => Object.assign({}, e));
    }
    return history.map((e) => Object.assign({}, e));
  }

  function state() {
    return {
      history: history.map((e) => Object.assign({}, e)),
      counters: {
        totalEvaluations: totalEvaluations,
        lowConfidenceCount: lowConfidenceCount,
        skippedCount: skippedCount,
        reducedCount: reducedCount,
        proceededCount: proceededCount,
        lastConfidence: lastConfidence,
      },
    };
  }

  function restore(saved) {
    if (!saved || typeof saved !== "object") return;
    if (Array.isArray(saved.history)) {
      history.length = 0;
      for (const e of saved.history) history.push(Object.assign({}, e));
      while (history.length > cfg.maxHistorySize) history.shift();
    }
    if (saved.counters && typeof saved.counters === "object") {
      totalEvaluations = saved.counters.totalEvaluations || 0;
      lowConfidenceCount = saved.counters.lowConfidenceCount || 0;
      skippedCount = saved.counters.skippedCount || 0;
      reducedCount = saved.counters.reducedCount || 0;
      proceededCount = saved.counters.proceededCount || 0;
      lastConfidence = saved.counters.lastConfidence != null ? saved.counters.lastConfidence : null;
    }
  }

  function reset() {
    history.length = 0;
    totalEvaluations = 0;
    lowConfidenceCount = 0;
    skippedCount = 0;
    reducedCount = 0;
    proceededCount = 0;
    lastConfidence = null;
  }

  return {
    evaluate,
    evaluateFromResponses,
    adjustPosition,
    stats,
    getHistory,
    state,
    restore,
    reset,
    DEFAULTS,
  };
}

module.exports = {
  createConfidenceCalibrator,
  extractAction,
  extractNumerics,
  coefficientOfVariation,
  computeActionAgreement,
  computeNumericStability,
  computeLogprobScore,
  DEFAULTS,
};

