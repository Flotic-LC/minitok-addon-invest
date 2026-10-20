"use strict";

/**
 * Correlation-aware position sizing.
 *
 * Computes pairwise correlation between held positions and a proposed new
 * symbol. When correlation is high, position size is reduced or the trade
 * is blocked to prevent sector/factor concentration.
 *
 * Correlation data sources (in priority order):
 *   1. Injected correlation matrix (from runner or external feed)
 *   2. Sector-based heuristic (same sector = 0.8, same market = 0.4)
 *   3. No data = assume uncorrelated (0.0)
 *
 * Usage:
 *   const { checkCorrelation, adjustForCorrelation } = require("./correlation");
 *   const result = checkCorrelation({ symbol: "000660", positions, correlationMatrix });
 *   // result: { ok, maxCorrelation, correlatedPositions, sizeMultiplier }
 */

const DEFAULTS = Object.freeze({
  maxCorrelation: Number(process.env.CORR_MAX || 0.7),       // block above this
  reduceThreshold: Number(process.env.CORR_REDUCE || 0.5),   // reduce size above this
  reduceMultiplier: Number(process.env.CORR_REDUCE_MULT || 0.5), // halve size when correlated
  sectorCorrelation: 0.8,   // assumed corr for same-sector symbols
  marketCorrelation: 0.4,   // assumed corr for same-market symbols
  unknownCorrelation: 0.0,  // assume uncorrelated when no data
});

// Sector map (extend via env or injection)
const SECTORS = Object.freeze({
  // US
  "AAPL": "tech", "MSFT": "tech", "GOOGL": "tech", "AMZN": "tech",
  "NVDA": "semiconductor", "AMD": "semiconductor", "INTC": "semiconductor",
  "META": "internet", "NFLX": "internet",
  "TSLA": "auto", "RIVN": "auto",
  "JPM": "finance", "GS": "finance", "BAC": "finance",
  // Japan
  "7203": "auto", "6758": "tech", "9984": "tech",
  "6861": "semiconductor", "8306": "finance",
});

function marketOf(symbol) {
  const s = String(symbol).replace(/^[A-Z]+:/i, "").toUpperCase();
  // A 6-digit symbol is Korean. The Korean market is not traded any more,
  // but the classification is kept so the symbol can be recognised and
  // refused rather than silently treated as a US holding.
  if (/^\d{6}$/.test(s)) return "KR";
  if (/^\d{4}$/.test(s)) return "JP";
  if (/^[A-Z]{1,5}$/.test(s)) return "US";
  return "OTHER";
}

function sectorOf(symbol) {
  const s = String(symbol).replace(/^[A-Z]+:/i, "").toUpperCase();
  return SECTORS[s] || null;
}

/**
 * Get correlation between two symbols.
 * Uses injected matrix first, then sector/market heuristic.
 */
function getCorrelation(symA, symB, matrix = null) {
  const a = String(symA).replace(/^[A-Z]+:/i, "").toUpperCase();
  const b = String(symB).replace(/^[A-Z]+:/i, "").toUpperCase();
  if (a === b) return 1.0;

  // Check injected matrix
  if (matrix) {
    const key1 = a + ":" + b;
    const key2 = b + ":" + a;
    if (matrix[key1] != null) return matrix[key1];
    if (matrix[key2] != null) return matrix[key2];
  }

  // Sector heuristic
  const secA = sectorOf(a);
  const secB = sectorOf(b);
  if (secA && secB && secA === secB) return DEFAULTS.sectorCorrelation;

  // Market heuristic
  if (marketOf(a) === marketOf(b)) return DEFAULTS.marketCorrelation;

  return DEFAULTS.unknownCorrelation;
}

/**
 * Check if a proposed BUY would create excessive correlation.
 * @param {object} input
 *   @param {string} input.symbol - proposed symbol
 *   @param {Array} input.positions - [{symbol, qty, avgPrice, currentPrice}]
 *   @param {object|null} input.correlationMatrix - optional "A:B" -> corr map
 *   @param {object} [opts] - DEFAULTS overrides
 * @returns {{ ok, maxCorrelation, correlatedPositions, sizeMultiplier, reason }}
 */
function checkCorrelation(input, opts = {}) {
  const p = { ...DEFAULTS, ...opts };
  const sym = String(input.symbol).replace(/^[A-Z]+:/i, "").toUpperCase();
  const positions = (input.positions || []).filter(pos => Number(pos.qty || pos.quantity || 0) > 0);
  const matrix = input.correlationMatrix || null;

  if (positions.length === 0) {
    return { ok: true, maxCorrelation: 0, correlatedPositions: [], sizeMultiplier: 1.0, reason: "no existing positions" };
  }

  let maxCorr = 0;
  const correlated = [];

  for (const pos of positions) {
    const posSym = String(pos.symbol).replace(/^[A-Z]+:/i, "").toUpperCase();
    if (posSym === sym) continue; // [FIX] Skip self
    const corr = getCorrelation(sym, posSym, matrix);
    if (corr > maxCorr) maxCorr = corr;
    if (corr >= p.reduceThreshold) {
      correlated.push({ symbol: posSym, correlation: corr });
    }
  }

  if (maxCorr >= p.maxCorrelation) {
    return {
      ok: false,
      maxCorrelation: maxCorr,
      correlatedPositions: correlated,
      sizeMultiplier: 0,
      reason: `correlation ${maxCorr.toFixed(2)} with ${correlated.map(c => c.symbol).join(",")} exceeds max ${p.maxCorrelation}`,
    };
  }

  const sizeMultiplier = maxCorr >= p.reduceThreshold ? p.reduceMultiplier : 1.0;
  return {
    ok: true,
    maxCorrelation: maxCorr,
    correlatedPositions: correlated,
    sizeMultiplier,
    reason: sizeMultiplier < 1.0
      ? `reduced to ${sizeMultiplier}x due to correlation ${maxCorr.toFixed(2)}`
      : "no significant correlation",
  };
}

/**
 * Adjust a position size based on correlation check.
 * @param {number} baseQty - quantity from positionSizer
 * @param {object} corrResult - from checkCorrelation()
 * @returns {{ qty, adjusted, reason }}
 */
function adjustForCorrelation(baseQty, corrResult) {
  if (!corrResult || corrResult.sizeMultiplier >= 1.0) {
    return { qty: baseQty, adjusted: false, reason: "no adjustment needed" };
  }
  const adjustedQty = Math.max(1, Math.floor(baseQty * corrResult.sizeMultiplier));
  return {
    qty: adjustedQty,
    adjusted: adjustedQty !== baseQty,
    reason: corrResult.reason,
  };
}

module.exports = { DEFAULTS, SECTORS, getCorrelation, checkCorrelation, adjustForCorrelation, marketOf, sectorOf };
