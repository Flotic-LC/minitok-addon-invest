"use strict";

/**
 * Meta-Cognition Engine (Phase I / L4.5) — scores the quality of each
 * trading decision at the moment it is made, then correlates predicted
 * quality against actual P&L outcomes to self-calibrate.
 *
 * Six scoring dimensions:
 *   1. evidenceDepth     — intelligence pipeline coverage (0..1)
 *   2. councilAgreement  — council consensus strength (0..1)
 *   3. regimeAlignment   — HMM regime matches strategy direction (0..1)
 *   4. memorySupport     — success rate of similar past decisions (0..1)
 *   5. walkForwardPass   — walk-forward validation deploy/reject (0|1)
 *   6. noveltyPenalty    — inverse similarity to past failure patterns (0..1)
 *
 * Usage:
 *   const { createMetaCognition } = require("./src/intelligence/meta-cognition");
 *   const meta = createMetaCognition({ threshold: 0.55 });
 *   meta.recordDecision("dec-001", { evidenceDepth: 0.8, ... });
 *   meta.attachOutcome("dec-001", { pnl: 12500, holdBars: 12 });
 *   meta.calibrate();
 *   meta.stats();
 */

const DEFAULTS = Object.freeze({
  threshold: Number(process.env.META_COG_THRESHOLD || 0.55),
  recalibrateEvery: Number(process.env.META_COG_RECALIBRATE_EVERY || 100),
  maxHistory: Number(process.env.META_COG_MAX_HISTORY || 5000),
  weights: {
    evidenceDepth: 1.0,
    councilAgreement: 1.0,
    regimeAlignment: 1.0,
    memorySupport: 1.0,
    walkForwardPass: 1.0,
    noveltyPenalty: 1.0,
  },
  minDecisionsForCalibration: 20,
  targetRho: 0.35,
  now: () => Date.now(),
});

const DIMENSIONS = Object.freeze([
  "evidenceDepth",
  "councilAgreement",
  "regimeAlignment",
  "memorySupport",
  "walkForwardPass",
  "noveltyPenalty",
]);

// --- Spearman rank correlation ---
function rankArray(arr) {
  const indexed = arr.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array(arr.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j < indexed.length && indexed[j].v === indexed[i].v) j++;
    const avgRank = (i + j - 1) / 2 + 1;
    for (let k = i; k < j; k++) ranks[indexed[k].i] = avgRank;
    i = j;
  }
  return ranks;
}

function spearmanRho(x, y, ryPrecomputed) {
  if (x.length !== y.length || x.length < 3) return null;
  const rx = rankArray(x);
  const ry = ryPrecomputed || rankArray(y);
  const n = x.length;
  let sumD2 = 0;
  for (let i = 0; i < n; i++) {
    const d = rx[i] - ry[i];
    sumD2 += d * d;
  }
  return 1 - (6 * sumD2) / (n * (n * n - 1));
}

function clamp01(v) {
  if (v == null || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

// --- Score a decision context into 6 dimensions ---
function scoreDecisionContext(ctx, opts) {
  if (!ctx) {
    return DIMENSIONS.reduce((acc, d) => { acc[d] = 0; return acc; }, {});
  }

  const scores = {};

  // 1. evidenceDepth: how many intelligence sources contributed
  const intel = ctx.intelligence || {};
  const sources = [intel.news, intel.macro, intel.sentiment].filter(Boolean).length;
  scores.evidenceDepth = clamp01(sources / 3);

  // 2. councilAgreement: consensus score from council evaluation
  if (ctx.councilResult != null) {
    if (typeof ctx.councilResult === "number") {
      scores.councilAgreement = clamp01(ctx.councilResult);
    } else if (ctx.councilResult.consensus != null) {
      scores.councilAgreement = clamp01(ctx.councilResult.consensus);
    } else {
      scores.councilAgreement = ctx.councilResult.approved ? 0.8 : 0.3;
    }
  } else {
    scores.councilAgreement = 0.5;
  }

  // 3. regimeAlignment: does regime support the action direction?
  if (ctx.regime && ctx.action) {
    const action = String(ctx.action).toUpperCase();
    const regime = String(ctx.regime).toLowerCase();
    if (action === "BUY") {
      if (regime === "bull") scores.regimeAlignment = 1.0;
      else if (regime === "sideways") scores.regimeAlignment = 0.6;
      else if (regime === "bear") scores.regimeAlignment = 0.2;
      else if (regime === "crisis") scores.regimeAlignment = 0.05;
      else scores.regimeAlignment = 0.5;
    } else if (action === "SELL") {
      if (regime === "bear" || regime === "crisis") scores.regimeAlignment = 1.0;
      else if (regime === "sideways") scores.regimeAlignment = 0.6;
      else if (regime === "bull") scores.regimeAlignment = 0.3;
      else scores.regimeAlignment = 0.5;
    } else {
      scores.regimeAlignment = 0.7; // HOLD is always reasonable
    }
  } else {
    scores.regimeAlignment = 0.5;
  }

  // 4. memorySupport: success rate of similar past decisions
  if (ctx.similarExperiences && ctx.similarExperiences.length > 0) {
    const withPnl = ctx.similarExperiences.filter(e => e.pnl != null);
    if (withPnl.length > 0) {
      const wins = withPnl.filter(e => e.pnl > 0).length;
      scores.memorySupport = clamp01(wins / withPnl.length);
    } else {
      scores.memorySupport = 0.5;
    }
  } else {
    scores.memorySupport = 0.5;
  }

  // 5. walkForwardPass: binary from walk-forward verdict
  if (ctx.walkForwardResult != null) {
    if (typeof ctx.walkForwardResult === "string") {
      scores.walkForwardPass = ctx.walkForwardResult === "deploy" ? 1 : 0;
    } else if (ctx.walkForwardResult.verdict) {
      scores.walkForwardPass = ctx.walkForwardResult.verdict === "deploy" ? 1 : 0;
    } else {
      scores.walkForwardPass = 0.5;
    }
  } else {
    scores.walkForwardPass = 0.5;
  }

  // 6. noveltyPenalty: inverse of similarity to past failures
  if (ctx.pastFailures && ctx.pastFailures.length > 0) {
    const maxSimilarity = Math.max(...ctx.pastFailures.map(f => f.similarityScore || 0));
    scores.noveltyPenalty = clamp01(1 - maxSimilarity / 10);
  } else {
    scores.noveltyPenalty = 0.8;
  }

  // Apply overrides from opts if provided
  if (opts) {
    for (const dim of DIMENSIONS) {
      if (opts[dim] != null) scores[dim] = clamp01(opts[dim]);
    }
  }

  return scores;
}

// --- Factory ---
function createMetaCognition(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  if (options.weights) {
    cfg.weights = { ...DEFAULTS.weights, ...options.weights };
  }

  const history = [];
  const historyById = new Map();
  const counters = {
    totalDecisions: 0,
    weakDecisions: 0,
    strongDecisions: 0,
    calibrations: 0,
    outcomesAttached: 0,
  };
  let currentWeights = { ...cfg.weights };
  let lastRho = null;

  function aggregateScore(scores) {
    let totalWeight = 0;
    let weightedSum = 0;
    for (const dim of DIMENSIONS) {
      const w = currentWeights[dim] || 0;
      const v = clamp01(scores[dim]);
      weightedSum += v * w;
      totalWeight += w;
    }
    return totalWeight > 0 ? weightedSum / totalWeight : 0;
  }

  function recordDecision(id, scoresOrCtx, opts) {
    if (!id) return null;

    let scores;
    if (scoresOrCtx && scoresOrCtx.evidenceDepth != null) {
      scores = {};
      for (const dim of DIMENSIONS) {
        scores[dim] = clamp01(scoresOrCtx[dim]);
      }
    } else {
      scores = scoreDecisionContext(scoresOrCtx, opts);
    }

    const aggregate = aggregateScore(scores);
    const isWeak = aggregate < cfg.threshold;

    const entry = {
      id: String(id),
      scores,
      aggregate: Number(aggregate.toFixed(4)),
      isWeak,
      outcome: null,
      ts: new Date(cfg.now()).toISOString(),
    };

    history.push(entry);
    historyById.set(entry.id, entry);
    counters.totalDecisions++;
    if (isWeak) counters.weakDecisions++;
    else counters.strongDecisions++;

    if (history.length > cfg.maxHistory) {
      const overflow = history.length - cfg.maxHistory;
      for (let i = 0; i < overflow; i++) historyById.delete(history[i].id);
      history.splice(0, overflow);
    }

    if (counters.totalDecisions > 0 && counters.totalDecisions % cfg.recalibrateEvery === 0) {
      calibrate();
    }

    return {
      id: entry.id,
      aggregate: entry.aggregate,
      isWeak: entry.isWeak,
      scores: entry.scores,
    };
  }

  function attachOutcome(id, outcome) {
    if (!id || !outcome) return false;
    const entry = historyById.get(String(id));
    if (!entry) return false;
    entry.outcome = {
      pnl: outcome.pnl != null ? Number(outcome.pnl) : null,
      holdBars: outcome.holdBars != null ? Number(outcome.holdBars) : null,
      winRate: outcome.winRate != null ? Number(outcome.winRate) : null,
      attachedAt: new Date(cfg.now()).toISOString(),
    };
    counters.outcomesAttached++;
    return true;
  }

  function calibrate() {
    const withOutcome = history.filter(e => e.outcome && e.outcome.pnl != null);
    if (withOutcome.length < cfg.minDecisionsForCalibration) {
      return { calibrated: false, reason: "insufficient data (" + withOutcome.length + "/" + cfg.minDecisionsForCalibration + ")" };
    }
    const scores = withOutcome.map(e => e.aggregate);
    const pnls = withOutcome.map(e => e.outcome.pnl);
    const pnlsRank = rankArray(pnls);
    const rho = spearmanRho(scores, pnls, pnlsRank);
    lastRho = rho;
    counters.calibrations++;
    if (rho != null && rho < cfg.targetRho && withOutcome.length >= cfg.minDecisionsForCalibration * 2) {
      const dimCorrelations = {};
      for (const dim of DIMENSIONS) {
        const dimScores = withOutcome.map(e => e.scores[dim]);
        const dimRho = spearmanRho(dimScores, pnls, pnlsRank);
        dimCorrelations[dim] = dimRho != null ? Math.max(0, dimRho) : 0;
      }
      const totalCorr = Object.values(dimCorrelations).reduce((a, b) => a + b, 0);
      if (totalCorr > 0) {
        for (const dim of DIMENSIONS) {
          const corrWeight = 0.1 + 0.9 * (dimCorrelations[dim] / totalCorr) * DIMENSIONS.length;
          currentWeights[dim] = Number((0.5 * currentWeights[dim] + 0.5 * corrWeight).toFixed(3));
        }
      }
    }
    return {
      calibrated: true,
      rho: rho != null ? Number(rho.toFixed(4)) : null,
      sampleSize: withOutcome.length,
      weights: { ...currentWeights },
      meetsTarget: rho != null && rho >= cfg.targetRho,
    };
  }


  function stats() {
    const withOutcome = history.filter(e => e.outcome && e.outcome.pnl != null);
    const avgScore = history.length > 0
      ? history.reduce((s, e) => s + e.aggregate, 0) / history.length
      : 0;
    const avgPnl = withOutcome.length > 0
      ? withOutcome.reduce((s, e) => s + e.outcome.pnl, 0) / withOutcome.length
      : 0;

    return {
      totalDecisions: counters.totalDecisions,
      weakDecisions: counters.weakDecisions,
      strongDecisions: counters.strongDecisions,
      outcomesAttached: counters.outcomesAttached,
      calibrations: counters.calibrations,
      avgScore: Number(avgScore.toFixed(4)),
      avgPnl: Number(avgPnl.toFixed(2)),
      spearmanRho: lastRho != null ? Number(lastRho.toFixed(4)) : null,
      targetRho: cfg.targetRho,
      meetsTarget: lastRho != null && lastRho >= cfg.targetRho,
      threshold: cfg.threshold,
      weights: { ...currentWeights },
      historySize: history.length,
      maxHistory: cfg.maxHistory,
    };
  }

  function getWeakDecisions(n = 10) {
    return history
      .filter(e => e.isWeak)
      .sort((a, b) => a.aggregate - b.aggregate)
      .slice(0, n)
      .map(e => ({ ...e }));
  }

  function getStrongDecisions(n = 10) {
    return history
      .filter(e => !e.isWeak)
      .sort((a, b) => b.aggregate - a.aggregate)
      .slice(0, n)
      .map(e => ({ ...e }));
  }

  function getHistory(limit = 100) {
    return history.slice(-limit).map(e => ({ ...e }));
  }

  function getById(id) {
    const entry = historyById.get(String(id));
    return entry ? { ...entry } : null;
  }

  function clear() {
    history.length = 0;
    counters.totalDecisions = 0;
    counters.weakDecisions = 0;
    counters.strongDecisions = 0;
    counters.calibrations = 0;
    counters.outcomesAttached = 0;
    currentWeights = { ...cfg.weights };
    lastRho = null;
  }

  return {
    recordDecision,
    attachOutcome,
    calibrate,
    stats,
    getWeakDecisions,
    getStrongDecisions,
    getHistory,
    getById,
    clear,
    scoreDecisionContext: (ctx, opts) => scoreDecisionContext(ctx, opts),
    DIMENSIONS,
  };
}

module.exports = { createMetaCognition, scoreDecisionContext, spearmanRho, DIMENSIONS, DEFAULTS };
