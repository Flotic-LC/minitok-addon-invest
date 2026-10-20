"use strict";

/**
 * VaR / CVaR Engine — three-method Value-at-Risk computation.
 *
 * Methods:
 *   1. Parametric (variance-covariance): assumes normal distribution, fast.
 *   2. Historical: empirical quantile from observed returns, captures fat tails.
 *   3. Monte Carlo: simulated paths via Box-Muller, configurable scenarios.
 *
 * Also provides CVaR (Conditional VaR / Expected Shortfall): the mean of
 * losses beyond the VaR threshold — a coherent risk measure.
 *
 * Usage:
 *   const { createVaREngine } = require("./src/risk/var-engine");
 *   const engine = createVaREngine({ confidence: 0.95 });
 *   const pVaR = engine.parametricVaR(returns);
 *   const hVaR = engine.historicalVaR(returns);
 *   const mcVaR = engine.monteCarloVaR({ drift: 0.0003, vol: 0.02, days: 10 });
 *   const cv   = engine.cvar(returns);
 */

const DEFAULTS = Object.freeze({
  confidence: Number(process.env.VAR_CONFIDENCE || 0.95),
  holdingDays: Number(process.env.VAR_HOLDING_DAYS || 1),
  mcPaths: Number(process.env.VAR_MC_PATHS || 10000),
  mcDays: Number(process.env.VAR_MC_DAYS || 10),
  mcDrift: Number(process.env.VAR_MC_DRIFT || 0.0003),
  mcVol: Number(process.env.VAR_MC_VOL || 0.02),
  mcSeed: process.env.VAR_MC_SEED ? Number(process.env.VAR_MC_SEED) : null,
});

// --- Z-score lookup (inverse normal CDF approximation, Abramowitz & Stegun) ---
function zScore(p) {
  if (p <= 0 || p >= 1) throw new RangeError("zScore requires 0 < p < 1, got " + p);
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
             1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
             6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
             -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01,
             2.445134137142996e+00, 3.754408661907416e+00];
  const pLow = 0.02425, pHigh = 1 - pLow;
  let q, r;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
           ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  } else if (p <= pHigh) {
    q = p - 0.5; r = q * q;
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q /
           (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
            ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
}

// --- Seeded PRNG (mulberry32) + Box-Muller ---
function mulberry32(seed) {
  let s = seed | 0;
  return function() {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function boxMuller(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// --- Statistics helpers ---
function mean(arr) {
  if (!arr || arr.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

function stddev(arr, mu) {
  if (!arr || arr.length < 2) return 0;
  if (mu == null) mu = mean(arr);
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += (arr[i] - mu) * (arr[i] - mu);
  return Math.sqrt(s / (arr.length - 1)); // sample stddev
}

function quantile(sorted, p) {
  if (!sorted || sorted.length === 0) return 0;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * p)));
  return sorted[idx];
}

function createVaREngine(options = {}) {
  const cfg = { ...DEFAULTS, ...options };

  /**
   * Parametric VaR (variance-covariance).
   * Assumes returns ~ N(mu, sigma). VaR = -(mu - z * sigma * sqrt(holdingDays)).
   * Returns a positive number representing the loss magnitude.
   */
  function parametricVaR(returns, confidence, holdingDays) {
    const conf = confidence || cfg.confidence;
    const hd = holdingDays || cfg.holdingDays;
    if (!returns || returns.length < 2) {
      return { var: 0, mean: 0, std: 0, z: zScore(conf), method: "parametric", error: "insufficient data" };
    }
    const mu = mean(returns);
    const sigma = stddev(returns, mu);
    const z = zScore(conf);
    const v = -(mu - z * sigma * Math.sqrt(hd));
    return {
      var: Number(v.toFixed(6)), mean: Number(mu.toFixed(6)),
      std: Number(sigma.toFixed(6)), z: Number(z.toFixed(4)),
      holdingDays: hd, method: "parametric",
    };
  }

  /**
   * Historical VaR — empirical quantile from sorted returns.
   */
  function historicalVaR(returns, confidence, holdingDays) {
    const conf = confidence || cfg.confidence;
    const hd = holdingDays || cfg.holdingDays;
    if (!returns || returns.length < 2) {
      return { var: 0, sampleSize: 0, method: "historical", error: "insufficient data" };
    }
    const sorted = returns.slice().sort((a, b) => a - b);
    const raw = -quantile(sorted, 1 - conf);
    const scaled = raw * Math.sqrt(hd);
    return { var: Number(scaled.toFixed(6)), sampleSize: sorted.length, holdingDays: hd, method: "historical" };
  }

  /**
   * Monte Carlo VaR — simulate price paths, take quantile of terminal returns.
   */
  function monteCarloVaR(params = {}) {
    const p = {
      drift: params.drift != null ? params.drift : cfg.mcDrift,
      vol: params.vol != null ? params.vol : cfg.mcVol,
      days: params.days || cfg.mcDays,
      paths: params.paths || cfg.mcPaths,
      seed: params.seed != null ? params.seed : cfg.mcSeed,
      initialPrice: params.initialPrice || 100,
    };
    const conf = params.confidence || cfg.confidence;
    const rng = p.seed != null ? mulberry32(p.seed) : Math.random;
    const finalReturns = new Array(p.paths);

    for (let i = 0; i < p.paths; i++) {
      let price = p.initialPrice;
      for (let d = 0; d < p.days; d++) {
        price *= (1 + p.drift + p.vol * boxMuller(rng));
      }
      finalReturns[i] = (price - p.initialPrice) / p.initialPrice;
    }

    finalReturns.sort((a, b) => a - b);
    const varIdx = Math.floor(p.paths * (1 - conf));
    const v = -finalReturns[Math.max(0, varIdx)];

    // CVaR: mean of losses beyond VaR threshold
    let tailSum = 0, tailCount = 0;
    for (let i = 0; i <= varIdx && i < p.paths; i++) { tailSum += finalReturns[i]; tailCount++; }
    const cv = tailCount > 0 ? -(tailSum / tailCount) : v;

    return {
      var: Number(v.toFixed(6)), cvar: Number(cv.toFixed(6)),
      meanReturn: Number(mean(finalReturns).toFixed(6)),
      paths: p.paths, days: p.days, method: "monte_carlo",
    };
  }

  /**
   * CVaR (Conditional VaR / Expected Shortfall) from historical returns.
   */
  function cvar(returns, confidence) {
    const conf = confidence || cfg.confidence;
    if (!returns || returns.length < 2) {
      return { cvar: 0, var: 0, tailSize: 0, method: "historical_cvar", error: "insufficient data" };
    }
    const sorted = returns.slice().sort((a, b) => a - b);
    const tailEnd = Math.max(1, Math.floor(sorted.length * (1 - conf)));
    let tailSum = 0;
    for (let i = 0; i < tailEnd; i++) tailSum += sorted[i];
    const tailMean = tailSum / tailEnd;
    const v = -sorted[Math.max(0, tailEnd - 1)];
    return { cvar: Number((-tailMean).toFixed(6)), var: Number(v.toFixed(6)), tailSize: tailEnd, method: "historical_cvar" };
  }

  /** Convenience: compute all three VaR methods + CVaR from a returns series. */
  function fullReport(returns) {
    const param = parametricVaR(returns);
    const hist = historicalVaR(returns);
    const cv = cvar(returns);
    return {
      parametric: param, historical: hist, cvar: cv,
      summary: { parametricVaR: param.var, historicalVaR: hist.var, cvar: cv.cvar, confidence: cfg.confidence },
    };
  }

  return { parametricVaR, historicalVaR, monteCarloVaR, cvar, fullReport, zScore, config: { ...cfg } };
}

module.exports = { createVaREngine, DEFAULTS, zScore };
