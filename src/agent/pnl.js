"use strict";

/**
 * Realized / unrealized P&L calculator with commission, tax, and FX support.
 *
 * Toss Securities fee defaults (overridable via options or env):
 * - US stock: commission 0.25% each side, SEC fee 0.00278% on sells
 * - JP stock: commission 0.05% each side, no local tax (withholding at source)
 *
 * The Korean market was removed on 2026-10-21: there is no KR fee schedule
 * because KRX is no longer traded. `detectMarket` still classifies a
 * 6-digit symbol as "KR" on purpose — that classification is what lets the
 * execution path recognise and refuse a Korean symbol. Dropping it would
 * make such a symbol fall through to "US" and become tradable.
 *
 * Currency conversion uses a caller-supplied FX rate (foreign -> KRW).
 */

const DEFAULT_FEES = Object.freeze({
  US: { buyCommissionPct: 0.25, sellCommissionPct: 0.25, sellTaxPct: 0.00278 },
  JP: { buyCommissionPct: 0.05, sellCommissionPct: 0.05, sellTaxPct: 0 },
});

function detectMarket(symbol) {
  const s = String(symbol || "").toUpperCase();
  if (/^\d{6}$/.test(s)) return "KR";
  if (/^\d{4}$/.test(s)) return "JP";
  return "US";
}

function resolveFees(market, overrides = {}) {
  const base = DEFAULT_FEES[market] || DEFAULT_FEES.US;
  const env = process.env;
  return {
    buyCommissionPct: Number(overrides.buyCommissionPct ?? env.PNL_BUY_COMMISSION_PCT ?? base.buyCommissionPct),
    sellCommissionPct: Number(overrides.sellCommissionPct ?? env.PNL_SELL_COMMISSION_PCT ?? base.sellCommissionPct),
    sellTaxPct: Number(overrides.sellTaxPct ?? env.PNL_SELL_TAX_PCT ?? base.sellTaxPct),
  };
}

/**
 * Compute round-trip cost breakdown for a closed trade.
 * @param {object} t - { symbol, side:"SELL", entryPrice, exitPrice, quantity, fxRate?, fees?, strategy? }
 * @returns {{grossPnl, buyCommission, sellCommission, sellTax, totalCosts, netPnl, pnlPct, costsPct, strategy?}} (KRW)
 */
function computeRoundTripPnl(t) {
  const qty = Number(t.quantity) || 0;
  const entry = Number(t.entryPrice) || 0;
  const exit = Number(t.exitPrice) || 0;
  if (qty <= 0 || entry <= 0 || exit <= 0) {
    return { grossPnl: 0, buyCommission: 0, sellCommission: 0, sellTax: 0, totalCosts: 0, netPnl: 0, pnlPct: 0, costsPct: 0 };
  }
  const fx = Number(t.fxRate) > 0 ? Number(t.fxRate) : 1;
  // [FIX] entry/exit 환율 분리 지원 (미제공 시 기존 fxRate fallback)
  const fxEntry = Number(t.fxRateEntry) > 0 ? Number(t.fxRateEntry) : fx;
  const fxExit = Number(t.fxRateExit) > 0 ? Number(t.fxRateExit) : fx;
  const market = t.market || detectMarket(t.symbol);
  const fees = resolveFees(market, t.fees);

  const buyValue = entry * qty * fxEntry;
  const sellValue = exit * qty * fxExit;
  const buyCommission = buyValue * (fees.buyCommissionPct / 100);
  const sellCommission = sellValue * (fees.sellCommissionPct / 100);
  const sellTax = sellValue * (fees.sellTaxPct / 100);
  const totalCosts = buyCommission + sellCommission + sellTax;
  const grossPnl = sellValue - buyValue;
  const netPnl = grossPnl - totalCosts;
  const pnlPct = buyValue > 0 ? (netPnl / buyValue) * 100 : 0;
  const costsPct = buyValue > 0 ? (totalCosts / buyValue) * 100 : 0;

  return {
    grossPnl: round2(grossPnl),
    buyCommission: round2(buyCommission),
    sellCommission: round2(sellCommission),
    sellTax: round2(sellTax),
    totalCosts: round2(totalCosts),
    netPnl: round2(netPnl),
    pnlPct: round4(pnlPct),
    costsPct: round4(costsPct),
    strategy: typeof t.strategy === "string" ? t.strategy : null,
  };
}

/**
 * Compute unrealized P&L for an open position against a current price.
 * Includes estimated exit costs (sell commission + tax) so the number is
 * "if I sold right now" realistic.
 */
function computeUnrealizedPnl(t) {
  return computeRoundTripPnl({ ...t, side: "SELL", exitPrice: t.currentPrice ?? t.exitPrice });
}

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }

module.exports = { DEFAULT_FEES, detectMarket, resolveFees, computeRoundTripPnl, computeUnrealizedPnl };
