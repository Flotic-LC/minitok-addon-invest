"use strict";

/**
 * Position sizing ??replaces fixed KRW order amounts with risk-aware sizing.
 *
 * Modes:
 *   1. ATR-based (primary): risk a fixed % of equity per trade, sized so a
 *      2?ATR adverse move loses exactly that risk budget. Volatile stock ??
 *      smaller position automatically.
 *   2. Equity-percent fallback: when ATR unavailable, cap at equity%.
 *   3. Absolute cap: never exceed maxOrderValueKrw (hard safety limit).
 */

function getDefaults() {
  return {
    riskPctPerTrade: Number(process.env.SIZE_RISK_PCT || 1.0),
    atrMultiplier: Number(process.env.SIZE_ATR_MULT || 2),
    equityFallbackPct: Number(process.env.SIZE_EQUITY_PCT || 4),
    maxOrderValueKrw: Number(process.env.MAX_ORDER_VALUE_KRW || 5000000),
    minQty: 1,
  };
}

/**
 * Compute position quantity.
 * @param {object} input
 * @param {number} input.equity - total portfolio equity (KRW)
 * @param {number} input.price - current/entry price
 * @param {number|null} input.atr - ATR(14) for the symbol (same currency as price)
 * @param {number} [input.fxRate] - for overseas symbols: KRW per 1 unit of local currency
 * @param {number} [input.capEquity] - equity the position-value cap is measured
 *   against (defaults to input.equity)
 * @param {number} [input.maxPositionPct] - cap the position value at this % of
 *   capEquity. The ATR risk budget alone can size a low-volatility large cap at
 *   ~1x equity (MSFT: 103 shares = 72.8M KRW on a 73.8M book).
 * @param {object} [opts] - DEFAULTS overrides
 * @returns {{ qty, valueKrw, method, stopPrice, riskKrw, reason }}
 */
function sizePosition(input, opts = {}) {
  const p = { ...getDefaults(), ...opts };
  const equity = Number(input.equity) || 0;
  const price = Number(input.price) || 0;
  const fx = Number(input.fxRate) || 1;
  if (equity <= 0 || price <= 0) {
    return { qty: 0, valueKrw: 0, method: "min", stopPrice: null, riskKrw: 0, reason: "invalid equity/price" };
  }
  const priceKrw = price * fx;

  const atr = input.atr != null ? Number(input.atr) * fx : null;
  let qty, method, stopPrice = null, riskKrw = 0;

  if (atr && atr > 0) {
    riskKrw = equity * (p.riskPctPerTrade / 100);
    const riskPerShare = p.atrMultiplier * atr;
    qty = Math.floor(riskKrw / riskPerShare);
    stopPrice = Math.round((priceKrw - riskPerShare) / fx * 100) / 100;
    method = "atr";
  } else {
    const budgetKrw = equity * (p.equityFallbackPct / 100);
    qty = Math.floor(budgetKrw / priceKrw);
    method = "equity_pct";
  }

  // [2026-10-21] Cap the position VALUE against equity. The risk budget sizes
  // a position by how far it can fall, not by how much capital it consumes, so
  // for a low-volatility large cap it proposed a position worth ~1x equity.
  const capEquity = Number(input.capEquity) > 0 ? Number(input.capEquity) : equity;
  const maxPositionPct = Number(input.maxPositionPct) || 0;
  let positionCapped = false;
  if (maxPositionPct > 0 && capEquity > 0) {
    const capValue = capEquity * (maxPositionPct / 100);
    if (qty * priceKrw > capValue) {
      qty = Math.floor(capValue / priceKrw);
      positionCapped = true;
    }
  }

  const valueKrw = qty * priceKrw;
  if (valueKrw > p.maxOrderValueKrw) {
    qty = Math.floor(p.maxOrderValueKrw / priceKrw);
    method = method === "atr" ? "atr" : "capped";
  }
  if (qty < p.minQty) {
    qty = priceKrw <= p.maxOrderValueKrw ? p.minQty : 0;
    if (qty === 0) {
      return { qty: 0, valueKrw: 0, method: "min", stopPrice, riskKrw: 0, reason: "single share exceeds max order value" };
    }
  }

  const finalValue = Math.round(qty * priceKrw);
  const finalRisk = atr && atr > 0 ? Math.round(qty * p.atrMultiplier * atr) : 0;
  const baseReason = method === "atr"
    ? "risk " + finalRisk.toLocaleString() + " KRW (" + p.riskPctPerTrade + "% of equity) via " + p.atrMultiplier + "x ATR"
    : p.equityFallbackPct + "% equity fallback";
  return {
    qty,
    valueKrw: finalValue,
    method,
    stopPrice,
    riskKrw: finalRisk,
    positionCapped,
    reason: positionCapped
      ? baseReason + ", capped at " + maxPositionPct + "% of equity (" + finalValue.toLocaleString() + " KRW)"
      : baseReason,
  };
}

const DEFAULTS = Object.freeze(getDefaults());
module.exports = { DEFAULTS, getDefaults, sizePosition };
