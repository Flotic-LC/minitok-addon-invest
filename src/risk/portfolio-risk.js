"use strict";

/**
 * Portfolio Risk Aggregator — position-level VaR decomposition.
 *
 * Provides:
 *   - portfolioVaR(positions, covMatrix): aggregate VaR from weights + covariance
 *   - marginalVaR(positions, covMatrix): per-position marginal contribution
 *   - componentVaR(positions, covMatrix): Euler decomposition (sums to total VaR)
 *   - checkRiskBudget(positions, covMatrix, limit): block trades exceeding VaR budget
 *
 * Usage:
 *   const { createPortfolioRisk } = require("./src/risk/portfolio-risk");
 *   const pr = createPortfolioRisk({ confidence: 0.95, holdingDays: 1 });
 *   const result = pr.portfolioVaR(positions, covMatrix);
 *   // result = { totalVaR, totalValue, varPct, marginal: [...], component: [...] }
 */

const DEFAULTS = Object.freeze({
  confidence: Number(process.env.PORTFOLIO_VAR_CONFIDENCE || 0.95),
  holdingDays: Number(process.env.PORTFOLIO_VAR_HOLDING_DAYS || 1),
  riskBudgetPct: Number(process.env.PORTFOLIO_RISK_BUDGET_PCT || 2.0), // 2% of equity max daily VaR
  minPositionsForMatrix: 2,
});

// --- Z-score (same approximation as var-engine) ---
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

// --- Matrix helpers (dense, small N) ---
function matVecMul(M, v) {
  const out = new Array(v.length);
  for (let i = 0; i < v.length; i++) {
    let s = 0;
    for (let j = 0; j < v.length; j++) s += M[i][j] * v[j];
    out[i] = s;
  }
  return out;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function createPortfolioRisk(options = {}) {
  const cfg = { ...DEFAULTS, ...options };

  /**
   * Compute portfolio VaR from positions and covariance matrix.
   * VaR_p = z * sqrt(w' * Σ * w) * sqrt(holdingDays) * totalValue
   * @param {Array} positions - [{symbol, qty, currentPrice, fxRate?}]
   * @param {number[][]} covMatrix - NxN covariance matrix (daily returns)
   * @returns {{ totalVaR, varPct, totalValue, weights, marginal, component }}
   */
  function portfolioVaR(positions, covMatrix) {
    if (!positions || positions.length === 0) {
      return { totalVaR: 0, varPct: 0, totalValue: 0, weights: [], marginal: [], component: [], method: "portfolio_parametric" };
    }
    // [2026-10-20 P0] Prefer the caller's KRW valuation. The previous formula
    // `qty * price * (fxRate || 1)` priced a USD position in dollars while the
    // risk budget is denominated in KRW, so the VaR was ~1330x too small.
    const values = positions.map(p => {
      const valueKrw = Number(p.valueKrw || 0);
      if (valueKrw > 0) return valueKrw;
      return (Number(p.qty || p.quantity || 0)) * (Number(p.currentPrice || p.avgPrice || 0)) * (Number(p.fxRate || 1));
    });
    const totalValue = values.reduce((s, v) => s + v, 0);
    if (totalValue <= 0) {
      return { totalVaR: 0, varPct: 0, totalValue: 0, weights: [], marginal: [], component: [], method: "portfolio_parametric" };
    }
    const weights = values.map(v => v / totalValue);
    const n = weights.length;

    // Use identity covariance if none provided
    const sigma = covMatrix && covMatrix.length === n ? covMatrix : Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => i === j ? 0.0004 : 0));

    const Sw = matVecMul(sigma, weights);
    const portVar = dot(weights, Sw);
    const portStd = Math.sqrt(Math.max(0, portVar));
    const z = zScore(cfg.confidence);
    const varPct = z * portStd * Math.sqrt(cfg.holdingDays);
    const totalVaR = varPct * totalValue;

    // Marginal VaR: dVaR/dw_i = z * (Σw)_i / sqrt(w'Σw) * sqrt(h)
    const marginal = weights.map((_, i) => {
      const mVaR = portStd > 0 ? z * Sw[i] / portStd * Math.sqrt(cfg.holdingDays) : 0;
      return { symbol: positions[i].symbol, marginalVaR: Number(mVaR.toFixed(6)), weight: Number(weights[i].toFixed(4)) };
    });

    // Component VaR: CVaR_i = w_i * mVaR_i (Euler decomposition, sums to total VaR%)
    const component = marginal.map((m, i) => {
      const cVar = weights[i] * m.marginalVaR;
      return { symbol: positions[i].symbol, componentVaR: Number(cVar.toFixed(6)), contributionPct: portVar > 0 ? Number((cVar / varPct * 100).toFixed(2)) : 0, weight: Number(weights[i].toFixed(4)) };
    });

    return {
      totalVaR: Number(totalVaR.toFixed(2)),
      varPct: Number(varPct.toFixed(6)),
      totalValue: Number(totalValue.toFixed(2)),
      weights: weights.map(w => Number(w.toFixed(4))),
      marginal,
      component,
      confidence: cfg.confidence,
      holdingDays: cfg.holdingDays,
      method: "portfolio_parametric",
    };
  }

  /**
   * Check if adding a new position would breach the risk budget.
   * @param {Array} currentPositions
   * @param {number[][]} currentCov
   * @param {object} proposed - {symbol, qty, currentPrice, fxRate?}
   * @param {number} equity - total equity for budget % calc
   * @returns {{ ok, currentVaR, proposedVaR, budget, breach }}
   */
  function checkRiskBudget(currentPositions, currentCov, proposed, equity) {
    const current = portfolioVaR(currentPositions, currentCov);
    const augmented = [...(currentPositions || []), proposed];

    // Build augmented covariance (assume 0.5 correlation with existing, same vol)
    const n = augmented.length;
    const augCov = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => {
      if (i === j) return currentCov && currentCov[i] ? (currentCov[i][i] || 0.0004) : 0.0004;
      if (i < n - 1 && j < n - 1 && currentCov && currentCov[i]) return currentCov[i][j] || 0;
      return 0.0002; // default cross-covariance for new position
    }));

    const proposedResult = portfolioVaR(augmented, augCov);
    const budget = (Number(equity) || 0) * (cfg.riskBudgetPct / 100);
    const breach = proposedResult.totalVaR > budget;

    return {
      ok: !breach,
      currentVaR: current.totalVaR,
      proposedVaR: proposedResult.totalVaR,
      budget: Number(budget.toFixed(2)),
      riskBudgetPct: cfg.riskBudgetPct,
      breach: breach ? "proposed VaR " + proposedResult.totalVaR.toFixed(2) + " exceeds budget " + budget.toFixed(2) : null,
      current,
      proposed: proposedResult,
    };
  }

  /** Build a simple diagonal covariance from per-symbol volatilities. */
  function buildDiagonalCov(vols) {
    return vols.map((v, i) => vols.map((_, j) => i === j ? v * v : 0));
  }

  /** Build covariance from correlation matrix + individual vols. */
  function buildCovFromCorrelation(vols, corrMatrix) {
    const n = vols.length;
    return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => {
      const rho = corrMatrix && corrMatrix[i] && corrMatrix[i][j] != null ? corrMatrix[i][j] : (i === j ? 1 : 0);
      return vols[i] * vols[j] * rho;
    }));
  }

  return { portfolioVaR, checkRiskBudget, buildDiagonalCov, buildCovFromCorrelation, config: { ...cfg } };
}

module.exports = { createPortfolioRisk, DEFAULTS };

