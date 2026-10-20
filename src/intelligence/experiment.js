"use strict";

/**
 * Experiment Engine — Phase R-3.
 * Turns a hypothesis into a structured A/B experiment with
 * control vs. treatment groups and Welch's t-test for significance.
 *
 * Usage:
 *   const { createExperimentEngine } = require("./src/intelligence/experiment");
 *   const exp = createExperimentEngine();
 *   const id = exp.createExperiment({ hypothesisId, name, description });
 *   exp.recordSample(id, "treatment", 120);
 *   exp.recordSample(id, "control", 100);
 *   const verdict = exp.evaluate(id);
 */

var DEFAULTS = Object.freeze({
  maxSamplesPerArm: Number(process.env.EXPERIMENT_MAX_SAMPLES || 500),
  significanceLevel: Number(process.env.EXPERIMENT_ALPHA || 0.05),
  minSamples: Number(process.env.EXPERIMENT_MIN_SAMPLES || 10),
  maxExperiments: Number(process.env.EXPERIMENT_MAX || 50),
});

function welchT(xs, ys) {
  var nx = xs.length, ny = ys.length;
  if (nx < 2 || ny < 2) return { t: 0, df: 0, pApprox: 1, reason: "insufficient" };
  var mx = 0, my = 0;
  for (var i = 0; i < nx; i++) mx += xs[i]; mx /= nx;
  for (var j = 0; j < ny; j++) my += ys[j]; my /= ny;
  var vx = 0, vy = 0;
  for (var a = 0; a < nx; a++) vx += (xs[a] - mx) * (xs[a] - mx);
  for (var b = 0; b < ny; b++) vy += (ys[b] - my) * (ys[b] - my);
  vx = nx > 1 ? vx / (nx - 1) : 0;
  vy = ny > 1 ? vy / (ny - 1) : 0;
  var seX = vx / nx, seY = vy / ny;
  var denom = Math.sqrt(seX + seY);
  if (denom === 0) return { t: 0, df: nx + ny - 2, pApprox: 1, reason: "no_variance" };
  var t = (mx - my) / denom;
  var num = (seX + seY) * (seX + seY);
  var den = (seX * seX) / (nx - 1) + (seY * seY) / (ny - 1);
  var df = den > 0 ? num / den : nx + ny - 2;
  // Rough two-sided p-value approximation using normal for large df
  var z = Math.abs(t);
  var pApprox = 2 * Math.exp(-0.717 * z - 0.416 * z * z);
  if (pApprox > 1) pApprox = 1;
  return { t: Number(t.toFixed(4)), df: Number(df.toFixed(2)), pApprox: Number(pApprox.toFixed(4)), reason: "ok" };
}

function createExperimentEngine(options) {
  var cfg = Object.assign({}, DEFAULTS, options || {});
  var experiments = new Map();
  var counters = { created: 0, evaluated: 0, significant: 0 };

  function makeId() {
    return "exp_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
  }

  function createExperiment(opts) {
    var o = opts || {};
    var id = o.id || makeId();
    experiments.set(id, {
      id: id,
      hypothesisId: o.hypothesisId || null,
      name: o.name || "experiment-" + id,
      description: o.description || "",
      createdAt: new Date().toISOString(),
      status: "running",
      control: [],
      treatment: [],
    });
    counters.created++;
    if (experiments.size > cfg.maxExperiments) {
      // Drop oldest finished; otherwise drop oldest running
      var oldest = null;
      experiments.forEach(function(v, k) { if (!oldest || v.createdAt < oldest.createdAt) oldest = { k: k, v: v }; });
      if (oldest) experiments.delete(oldest.k);
    }
    return id;
  }

  function recordSample(id, arm, value) {
    var e = experiments.get(id);
    if (!e) return { error: "experiment not found: " + id };
    if (e.status !== "running") return { error: "experiment not running: " + id };
    if (arm !== "control" && arm !== "treatment") return { error: "arm must be control or treatment" };
    var arr = arm === "control" ? e.control : e.treatment;
    if (arr.length >= cfg.maxSamplesPerArm) return { error: "arm full" };
    arr.push(typeof value === "number" ? value : 0);
    return { id: id, arm: arm, samples: arr.length };
  }

  function evaluate(id) {
    var e = experiments.get(id);
    if (!e) return { error: "experiment not found: " + id };
    counters.evaluated++;
    var nx = e.treatment.length, ny = e.control.length;
    if (nx < cfg.minSamples || ny < cfg.minSamples) {
      return { id: id, verdict: "insufficient_samples", treatment: nx, control: ny, minRequired: cfg.minSamples };
    }
    var wt = welchT(e.treatment, e.control);
    var meanT = e.treatment.reduce(function(s, v) { return s + v; }, 0) / nx;
    var meanC = e.control.reduce(function(s, v) { return s + v; }, 0) / ny;
    var lift = meanC !== 0 ? (meanT - meanC) / Math.abs(meanC) : 0;
    var significant = wt.pApprox < cfg.significanceLevel;
    if (significant) counters.significant++;
    e.status = "evaluated";
    e.evaluation = {
      treatment: { n: nx, mean: Number(meanT.toFixed(4)) },
      control: { n: ny, mean: Number(meanC.toFixed(4)) },
      lift: Number(lift.toFixed(4)),
      t: wt.t, df: wt.df, pApprox: wt.pApprox,
      significant: significant,
      verdict: significant ? (lift > 0 ? "treatment_better" : "control_better") : "no_significant_difference",
      evaluatedAt: new Date().toISOString(),
    };
    return { id: id, evaluation: e.evaluation };
  }

  function getExperiment(id) { return experiments.get(id) || null; }

  function list(status) {
    var out = [];
    experiments.forEach(function(v) {
      if (!status || v.status === status) out.push({ id: v.id, name: v.name, status: v.status, createdAt: v.createdAt, hypothesisId: v.hypothesisId });
    });
    return out;
  }

  function stats() {
    return { total: experiments.size, created: counters.created, evaluated: counters.evaluated, significant: counters.significant };
  }

  function clear() { experiments.clear(); counters.created = 0; counters.evaluated = 0; counters.significant = 0; }

  // [Phase R-6] Persistence restore — rebuild an experiment from saved state
  function restoreExperiment(exp) {
    if (!exp || !exp.id) return { ok: false, reason: "invalid experiment" };
    if (experiments.has(exp.id)) return { ok: false, reason: "duplicate" };
    experiments.set(exp.id, {
      id: exp.id,
      hypothesisId: exp.hypothesisId || null,
      name: exp.name || exp.id,
      description: exp.description || "",
      createdAt: exp.createdAt || new Date().toISOString(),
      status: exp.status || "running",
      control: Array.isArray(exp.control) ? exp.control.slice() : [],
      treatment: Array.isArray(exp.treatment) ? exp.treatment.slice() : [],
      evaluation: exp.evaluation || null,
    });
    if (exp.status === "evaluated") counters.evaluated++;
    return { ok: true, id: exp.id };
  }

  return {
    createExperiment: createExperiment, recordSample: recordSample, evaluate: evaluate,
    getExperiment: getExperiment, list: list, stats: stats, clear: clear,
    restoreExperiment: restoreExperiment,
    _welchT: welchT,
  };
}

module.exports = { createExperimentEngine, DEFAULTS, _welchT: welchT };
