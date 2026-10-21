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
  // [2026-10-21] No Korean schedule: the Korean market is not traded, and
  // keeping a schedule for it would suggest that it might be. A 6-digit
  // symbol falls through to the US rates here, but it can never get this far:
  // the tradability gate refuses a non-listed market before any order or cost
  // calculation is reached.
  US: { buyCommissionPct: 0.25, sellCommissionPct: 0.25, sellTaxPct: 0.00278 },
  JP: { buyCommissionPct: 0.05, sellCommissionPct: 0.05, sellTaxPct: 0 },
});

function detectMarket(symbol) {
  const s = String(symbol || "").toUpperCase();
  if (/^\d{6}$/.test(s)) return "KR";
  if (/^\d{4}$/.test(s)) return "JP";
  return "US";
}

function resolveFees(market, overrides) {
  // [2026-10-21] A null override used to throw here: the default parameter
  // only applies to undefined, and the cost model passes null when the
  // market's own schedule is used.
  const ov = overrides || {};
  const base = DEFAULT_FEES[market] || DEFAULT_FEES.US;
  const env = process.env;
  return {
    buyCommissionPct: Number(ov.buyCommissionPct ?? env.PNL_BUY_COMMISSION_PCT ?? base.buyCommissionPct),
    sellCommissionPct: Number(ov.sellCommissionPct ?? env.PNL_SELL_COMMISSION_PCT ?? base.sellCommissionPct),
    sellTaxPct: Number(ov.sellTaxPct ?? env.PNL_SELL_TAX_PCT ?? base.sellTaxPct),
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
  // [2026-10-21] The spread, the slippage and the market impact are costs
  // that are real but were never booked: the live path measured the realised
  // slippage (order price vs fill price) and threw the number away, and the
  // spread was not represented at all. They are now first-class inputs.
  //
  // When the caller supplies the SIGNAL prices (what the strategy decided to
  // trade at) the gross is measured between them and the difference to the
  // fill prices is booked as the execution cost. The fill prices are what
  // the commission and the tax are charged on, so those stay exact.
  const sigEntry = Number(t.signalEntryPrice) || entry;
  const sigExit = Number(t.signalExitPrice) || exit;
  const entrySlippage = Math.max(0, (entry - sigEntry) * qty * fxEntry);
  const exitSlippage = Math.max(0, (sigExit - exit) * qty * fxExit);
  const spread = Number(t.spread) || 0;
  const slippage = Number(t.slippage) || (entrySlippage + exitSlippage);
  const impact = Number(t.impact) || 0;
  const apiCost = Number(t.apiCost) || 0;
  const totalCosts = buyCommission + sellCommission + sellTax + spread + slippage + impact + apiCost;
  const grossPnl = (sigExit * qty * fxExit) - (sigEntry * qty * fxEntry);
  const netPnl = grossPnl - totalCosts;
  const pnlPct = buyValue > 0 ? (netPnl / buyValue) * 100 : 0;
  const costsPct = buyValue > 0 ? (totalCosts / buyValue) * 100 : 0;
  // How much of the gross move the costs consumed. Above 1 the trade was a
  // gross winner and a net loser.
  const costRatio = Math.abs(grossPnl) > 0 ? totalCosts / Math.abs(grossPnl) : null;

  return {
    grossPnl: round2(grossPnl),
    buyCommission: round2(buyCommission),
    sellCommission: round2(sellCommission),
    sellTax: round2(sellTax),
    spread: round2(spread),
    slippage: round2(slippage),
    impact: round2(impact),
    apiCost: round2(apiCost),
    totalCosts: round2(totalCosts),
    netPnl: round2(netPnl),
    pnlPct: round4(pnlPct),
    costsPct: round4(costsPct),
    costRatio: costRatio == null ? null : round4(costRatio),
    grossPnlPct: buyValue > 0 ? round4((grossPnl / buyValue) * 100) : 0,
    // The execution-cost detail: what the fill cost against the decision
    // price, and the estimated spread inside that deviation. The spread is a
    // SUBSET of the booked slippage, not an extra charge.
    entrySlippage: round2(entrySlippage),
    exitSlippage: round2(exitSlippage),
    spreadEstimate: round2(Number(t.spreadEstimate) || 0),
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
