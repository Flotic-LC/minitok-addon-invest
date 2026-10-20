"use strict";

/**
 * Regime Detection via Hidden Markov Model (Gaussian emissions).
 *
 * Classifies market into N latent states (e.g., bull / bear / sideways)
 * from observable features: daily return, realized volatility, trend.
 *
 * Algorithms:
 *   - Baum-Welch (EM): train transition matrix A, emission means/mus, initial pi
 *   - Forward filter: online posterior P(state_t | obs_1..t)
 *   - Viterbi: most likely state sequence over a window
 *
 * Usage:
 *   const { createRegimeHMM } = require("./src/strategy/regime-hmm");
 *   const hmm = createRegimeHMM({ nStates: 3 });
 *   hmm.train(returnsHistory, { maxIter: 50 });
 *   const current = hmm.filter(latestFeatures);
 *   // current = { state: 0, label: "bull", prob: 0.72, probs: [0.72, 0.18, 0.10] }
 */

const DEFAULTS = Object.freeze({
  nStates: Number(process.env.HMM_N_STATES || 3),
  nFeatures: 3, // return, realized_vol, trend
  maxIter: Number(process.env.HMM_MAX_ITER || 50),
  tol: Number(process.env.HMM_TOL || 1e-4),
  volWindow: Number(process.env.HMM_VOL_WINDOW || 5),
  trendWindow: Number(process.env.HMM_TREND_WINDOW || 20),
  floorProb: Number(process.env.HMM_FLOOR_PROB || 1e-6),
  seed: process.env.HMM_SEED ? Number(process.env.HMM_SEED) : 42,
  // Regime labels mapped to state indices after training (sorted by mean return)
  labels: ["bear", "sideways", "bull"],
  // Position multipliers per label
  multipliers: { bull: 1.2, sideways: 1.0, bear: 0.5, crisis: 0.25 },
});

// --- Seeded PRNG ---
function mulberry32(seed) {
  let s = seed | 0;
  return function() {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Math helpers ---
function logSumExp(arr) {
  if (!arr || arr.length === 0) return -Infinity;
  let max = -Infinity;
  for (let i = 0; i < arr.length; i++) if (arr[i] > max) max = arr[i];
  if (max === -Infinity) return -Infinity;
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += Math.exp(arr[i] - max);
  return max + Math.log(s);
}

function normalize(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  if (!Number.isFinite(s) || s <= 0) {
    const u = 1 / arr.length;
    for (let i = 0; i < arr.length; i++) arr[i] = u;
    return arr;
  }
  for (let i = 0; i < arr.length; i++) {
    arr[i] = Number.isFinite(arr[i]) ? arr[i] / s : 1 / arr.length;
  }
  return arr;
}

function floorMatrix(M, floor) {
  for (let i = 0; i < M.length; i++) {
    for (let j = 0; j < M[i].length; j++) {
      if (M[i][j] < floor) M[i][j] = floor;
    }
  }
  return M;
}

// --- Feature extraction from price/returns series ---
function extractFeatures(returns, opts) {
  if (!returns || returns.length < opts.trendWindow + 1) return [];
  const feats = [];
  for (let t = opts.trendWindow; t < returns.length; t++) {
    // 1. Daily return
    const ret = returns[t];
    // 2. Realized volatility (rolling window)
    let volSum = 0;
    const wStart = Math.max(0, t - opts.volWindow + 1);
    const wN = t - wStart + 1;
    for (let k = wStart; k <= t; k++) volSum += returns[k] * returns[k];
    const vol = Math.sqrt(volSum / Math.max(1, wN));
    // 3. Trend (rolling cumulative return)
    let trend = 0;
    const tStart = Math.max(0, t - opts.trendWindow + 1);
    for (let k = tStart; k <= t; k++) trend += returns[k];
    feats.push([ret, vol, trend]);
  }
  return feats;
}

// --- Gaussian log-likelihood (diagonal covariance) ---
function gaussianLogLik(x, mu, sigma2) {
  // log N(x; mu, diag(sigma2))
  let ll = -0.5 * x.length * Math.log(2 * Math.PI);
  for (let d = 0; d < x.length; d++) {
    const s = Math.max(sigma2[d], 1e-8);
    ll -= 0.5 * Math.log(s);
    ll -= 0.5 * (x[d] - mu[d]) * (x[d] - mu[d]) / s;
  }
  return ll;
}

function createRegimeHMM(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const N = cfg.nStates;
  const D = cfg.nFeatures;

  const rng = mulberry32(cfg.seed);
  let A = [];
  let pi = [];
  let mu = [];
  let sigma2 = [];
  let trained = false;
  let stateLabels = [...cfg.labels];
  let trainHistory = [];
  let lastPosterior = null;

  function initRandom() {
    pi = new Array(N);
    for (let i = 0; i < N; i++) pi[i] = 1 / N;
    A = Array.from({ length: N }, () => {
      const row = new Array(N);
      let s = 0;
      for (let j = 0; j < N; j++) { row[j] = 0.1 + rng() * 0.9; s += row[j]; }
      for (let j = 0; j < N; j++) row[j] /= s;
      return row;
    });
    mu = Array.from({ length: N }, (_, k) => {
      const m = new Array(D);
      for (let d = 0; d < D; d++) m[d] = (k - N / 2) * 0.01 + (rng() - 0.5) * 0.005;
      return m;
    });
    sigma2 = Array.from({ length: N }, () => {
      const s = new Array(D);
      for (let d = 0; d < D; d++) s[d] = 0.001 + rng() * 0.005;
      return s;
    });
  }

  function emissionLogLik(obs) {
    const ll = new Array(N);
    for (let i = 0; i < N; i++) ll[i] = gaussianLogLik(obs, mu[i], sigma2[i]);
    return ll;
  }

  function forward(observations) {
    const T = observations.length;
    const alpha = Array.from({ length: T }, () => new Array(N));
    const scales = new Array(T);
    const b0 = emissionLogLik(observations[0]);
    for (let i = 0; i < N; i++) alpha[0][i] = Math.log(Math.max(pi[i], cfg.floorProb)) + b0[i];
    const scale0 = logSumExp(alpha[0]);
    scales[0] = scale0;
    for (let i = 0; i < N; i++) alpha[0][i] -= scale0;
    for (let t = 1; t < T; t++) {
      const bt = emissionLogLik(observations[t]);
      for (let j = 0; j < N; j++) {
        const terms = new Array(N);
        for (let i = 0; i < N; i++) {
          terms[i] = alpha[t - 1][i] + Math.log(Math.max(A[i][j], cfg.floorProb));
        }
        alpha[t][j] = logSumExp(terms) + bt[j];
      }
      const scaleT = logSumExp(alpha[t]);
      scales[t] = scaleT;
      for (let j = 0; j < N; j++) alpha[t][j] -= scaleT;
    }
    return { alpha, scales };
  }

  function backward(observations) {
    const T = observations.length;
    const beta = Array.from({ length: T }, () => new Array(N));
    for (let i = 0; i < N; i++) beta[T - 1][i] = 0;
    for (let t = T - 2; t >= 0; t--) {
      const bt1 = emissionLogLik(observations[t + 1]);
      for (let i = 0; i < N; i++) {
        const terms = new Array(N);
        for (let j = 0; j < N; j++) {
          terms[j] = Math.log(Math.max(A[i][j], cfg.floorProb)) + bt1[j] + beta[t + 1][j];
        }
        beta[t][i] = logSumExp(terms);
      }
    }
    return beta;
  }

  function train(returnsOrFeatures, opts = {}) {
    const maxIter = opts.maxIter || cfg.maxIter;
    const tol = opts.tol || cfg.tol;
    let observations;
    if (returnsOrFeatures.length > 0 && typeof returnsOrFeatures[0] === "number") {
      observations = extractFeatures(returnsOrFeatures, cfg);
    } else {
      observations = returnsOrFeatures;
    }
    if (!observations || observations.length < N * 2) {
      return { ok: false, reason: "insufficient data: need " + (N * 2) + " observations, got " + (observations ? observations.length : 0) };
    }
    initRandom();
    let prevLL = -Infinity;
    const T = observations.length;
    let iter = 0;
    for (iter = 0; iter < maxIter; iter++) {
      const { alpha, scales } = forward(observations);
      const beta = backward(observations);
      const logLik = scales.reduce((s, v) => s + v, 0);
      const gamma = Array.from({ length: T }, () => new Array(N));
      for (let t = 0; t < T; t++) {
        for (let i = 0; i < N; i++) gamma[t][i] = alpha[t][i] + beta[t][i];
        const norm = logSumExp(gamma[t]);
        for (let i = 0; i < N; i++) {
          const v = Math.exp(gamma[t][i] - norm);
          gamma[t][i] = Number.isFinite(v) ? Math.max(v, cfg.floorProb) : cfg.floorProb;
        }
      }
      const xi = Array.from({ length: T - 1 }, () => Array.from({ length: N }, () => new Array(N)));
      for (let t = 0; t < T - 1; t++) {
        const bt1 = emissionLogLik(observations[t + 1]);
        let xiSum = 0;
        for (let i = 0; i < N; i++) {
          for (let j = 0; j < N; j++) {
            xi[t][i][j] = Math.exp(
              alpha[t][i] + Math.log(Math.max(A[i][j], cfg.floorProb)) + bt1[j] + beta[t + 1][j]
            );
            xiSum += xi[t][i][j];
          }
        }
        if (xiSum > 0) {
          for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) xi[t][i][j] /= xiSum;
        }
      }
      // M-step: pi
      for (let i = 0; i < N; i++) pi[i] = Math.max(gamma[0][i], cfg.floorProb);
      normalize(pi);
      // M-step: A
      for (let i = 0; i < N; i++) {
        let sumGammaI = 0;
        for (let t = 0; t < T - 1; t++) sumGammaI += gamma[t][i];
        for (let j = 0; j < N; j++) {
          let sumXiIJ = 0;
          for (let t = 0; t < T - 1; t++) sumXiIJ += xi[t][i][j];
          A[i][j] = Math.max(sumXiIJ / Math.max(sumGammaI, cfg.floorProb), cfg.floorProb);
        }
        normalize(A[i]);
      }
      // M-step: emission means and variances
      for (let i = 0; i < N; i++) {
        let sumGamma = 0;
        for (let t = 0; t < T; t++) sumGamma += gamma[t][i];
        if (sumGamma < cfg.floorProb) continue;
        for (let d = 0; d < D; d++) {
          let m = 0;
          for (let t = 0; t < T; t++) m += gamma[t][i] * observations[t][d];
          mu[i][d] = m / sumGamma;
        }
        for (let d = 0; d < D; d++) {
          let v = 0;
          for (let t = 0; t < T; t++) {
            const diff = observations[t][d] - mu[i][d];
            v += gamma[t][i] * diff * diff;
          }
          sigma2[i][d] = Math.max(v / sumGamma, 1e-8);
        }
      }
      if (iter > 0 && Math.abs(logLik - prevLL) < tol) break;
      prevLL = logLik;
    }
    // Sort states by mean return (ascending: bear -> sideways -> bull)
    const order = mu.map((m, idx) => ({ idx, meanRet: Number.isFinite(m[0]) ? m[0] : 0 }))
      .sort((a, b) => a.meanRet - b.meanRet);
    const sortedMu = order.map(o => mu[o.idx]);
    const sortedSig2 = order.map(o => sigma2[o.idx]);
    const sortedPi = order.map(o => pi[o.idx]);
    const sortedA = order.map(o => order.map(p => {
      const v = A[o.idx][p.idx];
      return Number.isFinite(v) ? v : cfg.floorProb;
    }));
    mu = sortedMu; sigma2 = sortedSig2; pi = sortedPi; A = sortedA;
    stateLabels = order.map(o => cfg.labels[o.idx] || "state_" + o.idx);
    trained = true;
    trainHistory.push({ iter: iter + 1, observations: T, finalLL: prevLL, ts: new Date().toISOString() });
    return { ok: true, iterations: iter + 1, observations: T, logLik: prevLL };
  }


  function filter(featuresOrReturn) {
    if (!trained) return { state: -1, label: "unknown", prob: 0, probs: [], reason: "not trained" };
    let obs;
    if (typeof featuresOrReturn === "number") {
      obs = [featuresOrReturn, Math.abs(featuresOrReturn), featuresOrReturn];
    } else if (Array.isArray(featuresOrReturn) && typeof featuresOrReturn[0] === "number") {
      obs = featuresOrReturn;
    } else {
      obs = featuresOrReturn;
    }
    const b = emissionLogLik(obs);
    const logPost = new Array(N);
    for (let i = 0; i < N; i++) logPost[i] = Math.log(Math.max(pi[i], cfg.floorProb)) + b[i];
    const norm = logSumExp(logPost);
    const probs = new Array(N);
    let maxP = -1, maxIdx = 0;
    for (let i = 0; i < N; i++) {
      probs[i] = Math.exp(logPost[i] - norm);
      if (probs[i] > maxP) { maxP = probs[i]; maxIdx = i; }
    }
    return {
      state: maxIdx,
      label: stateLabels[maxIdx] || "state_" + maxIdx,
      prob: Number(maxP.toFixed(4)),
      probs: probs.map(p => Number(p.toFixed(4))),
    };
  }

  function filterOnline(features) {
    if (!trained) return { state: -1, label: "unknown", prob: 0, probs: [], reason: "not trained" };
    // [2026-10-20] A null/empty observation vector used to reach
    // gaussianLogLik(x=null) and throw "Cannot read properties of null
    // (reading 'length')" — which killed every retrain because the caller
    // only advanced its timestamp after this call returned.
    if (!features || !Array.isArray(features) || features.length === 0) {
      return { state: -1, label: "unknown", prob: 0, probs: [], reason: "no observations" };
    }
    const prior = lastPosterior || pi;
    const b = emissionLogLik(features);
    const transPrior = new Array(N).fill(0);
    if (lastPosterior) {
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) transPrior[j] += lastPosterior[i] * A[i][j];
      }
    } else {
      for (let j = 0; j < N; j++) transPrior[j] = prior[j];
    }
    const logPost = new Array(N);
    for (let j = 0; j < N; j++) logPost[j] = Math.log(Math.max(transPrior[j], cfg.floorProb)) + b[j];
    const norm = logSumExp(logPost);
    const probs = new Array(N);
    let maxP = -1, maxIdx = 0;
    for (let i = 0; i < N; i++) {
      probs[i] = Math.exp(logPost[i] - norm);
      if (probs[i] > maxP) { maxP = probs[i]; maxIdx = i; }
    }
    lastPosterior = probs.slice();
    return {
      state: maxIdx,
      label: stateLabels[maxIdx] || "state_" + maxIdx,
      prob: Number(maxP.toFixed(4)),
      probs: probs.map(p => Number(p.toFixed(4))),
    };
  }

  function viterbi(observations) {
    if (!trained || !observations || observations.length === 0) return [];
    const T = observations.length;
    const delta = Array.from({ length: T }, () => new Array(N));
    const psi = Array.from({ length: T }, () => new Array(N));
    const b0 = emissionLogLik(observations[0]);
    for (let i = 0; i < N; i++) delta[0][i] = Math.log(Math.max(pi[i], cfg.floorProb)) + b0[i];
    for (let t = 1; t < T; t++) {
      const bt = emissionLogLik(observations[t]);
      for (let j = 0; j < N; j++) {
        let best = -Infinity, bestI = 0;
        for (let i = 0; i < N; i++) {
          const v = delta[t - 1][i] + Math.log(Math.max(A[i][j], cfg.floorProb));
          if (v > best) { best = v; bestI = i; }
        }
        delta[t][j] = best + bt[j];
        psi[t][j] = bestI;
      }
    }
    const path = new Array(T);
    let best = -Infinity, bestJ = 0;
    for (let j = 0; j < N; j++) {
      if (delta[T - 1][j] > best) { best = delta[T - 1][j]; bestJ = j; }
    }
    path[T - 1] = bestJ;
    for (let t = T - 2; t >= 0; t--) path[t] = psi[t + 1][path[t + 1]];
    return path.map(s => ({ state: s, label: stateLabels[s] || "state_" + s }));
  }

  function getPositionMultiplier(currentFeatures) {
    if (!trained) return 1.0;
    // [2026-10-20] filter(null) was the crash source; with no usable
    // observation vector there is no regime to apply, so keep the neutral
    // multiplier instead of throwing.
    const result = currentFeatures && currentFeatures.length ? filterOnline(currentFeatures) : null;
    if (!result || result.state < 0) return 1.0;
    return cfg.multipliers[result.label] != null ? cfg.multipliers[result.label] : 1.0;
  }

  function resetOnline() { lastPosterior = null; }

  return {
    train, filter, filterOnline, viterbi, getPositionMultiplier, resetOnline,
    get trained() { return trained; },
    get params() { return { A, pi, mu, sigma2, labels: stateLabels }; },
    get config() { return { ...cfg }; },
    get history() { return trainHistory.slice(); },
  };
}

module.exports = { createRegimeHMM, extractFeatures, DEFAULTS };


