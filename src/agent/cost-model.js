"use strict";

/**
 * Transaction cost model — the single place that knows what a trade costs.
 *
 * [2026-10-21] The costs were spread across the P&L engine, the backtest and
 * the live runner, and they did not agree with each other:
 *   - the bid/ask spread was not modelled at all. The backtest traded at the
 *     close, and the live path booked no spread even though the orderbook is
 *     fetched on every tick;
 *   - market impact was implemented and switched off in every caller
 *     (impactCoefficient was 0 in the CLI, the cron, the evolution engine and
 *     the walk-forward validator);
 *   - partial fills were implemented and never exercised (partialFillRate
 *     was 1.0 everywhere, so partialFillTrades was always 0);
 *   - the backtest had no tax term, so the US regulatory fee was missing;
 *   - the engines that tune LIVE risk (evolution, walk-forward) used a 0.015%
 *     commission — the retired Korean rate — against the live 0.25%, so they
 *     tuned against a cost model that was 16.7x too cheap;
 *   - the per-trade cost breakdown recorded slippage and impact as
 *     diagnostics but never booked them.
 *
 * Everything now comes from here, so a backtest and a live fill are costed
 * by the same rules and a measurement cannot flatter itself.
 */

const { resolveFees, detectMarket } = require("./pnl");

/**
 * The cost configuration. Every value is overridable by environment variable
 * so an operator can re-cost the bot without a redeploy.
 */
const DEFAULT_COST_CONFIG = Object.freeze({
  // The bid/ask spread charged on each side, in percent. 2 bps per side is
  // realistic for a US large cap; it is the price of crossing the book.
  spreadPct: Number(process.env.COST_SPREAD_PCT || 0.02),
  // Flat slippage on each side, in percent, on top of the spread.
  slippagePct: Number(process.env.COST_SLIPPAGE_PCT || 0.05),
  // sqrt-participation market impact coefficient (0 disables it).
  impactCoefficient: Number(process.env.COST_IMPACT_COEFFICIENT || 2),
  // The share of an order that is expected to fill.
  partialFillRate: Number(process.env.COST_PARTIAL_FILL_RATE || 0.98),
  // The monetary cost of one AI decision, in the account currency. The runner
  // calls a paid external model for every decision, so a bot that decides
  // more often pays more. Zero disables the line.
  apiCostPerDecision: Number(process.env.COST_API_PER_DECISION || 0),
  // How many times the round-trip cost the expected move must cover before a
  // signal is allowed to open a position. A move smaller than the cost can
  // never be profitable: the cost is certain, the move is not.
  //
  // Calibrated against the real universe (600 daily candles, 2026-05-01..
  // 2026-10-21, US round-trip cost 0.6428%):
  //     AAPL ATR 1.112%  MSFT 1.287%  NVDA 1.827%  QQQ 1.033%  SPY 0.573%
  // A multiple of 1 blocks exactly SPY — the one name whose expected daily
  // move is smaller than the round trip, so every trade in it is a
  // guaranteed net loss. A multiple of 2 would block AAPL and QQQ as well
  // and a multiple of 3 four of the five: those are tuning choices, not
  // facts, so the default stays at the provable threshold and the operator
  // can raise it.
  minAtrCostMultiple: Number(process.env.SIG_MIN_ATR_COST_MULTIPLE || 1),
});

/**
 * The three cost scenarios a strategy has to survive.
 *   optimistic   — the good case: half the spread and slippage, no impact,
 *                  every order fills.
 *   base         — the expected case.
 *   pessimistic  — the bad case: double the spread and slippage, double the
 *                  impact, 10% of orders only partly fill.
 */
const COST_PROFILES = Object.freeze({
  optimistic: Object.freeze({ slippageMult: 0.5, spreadMult: 0.5, impactMult: 0, partialFillRate: 1.0 }),
  base: Object.freeze({ slippageMult: 1.0, spreadMult: 1.0, impactMult: 1.0, partialFillRate: null }),
  pessimistic: Object.freeze({ slippageMult: 2.0, spreadMult: 2.0, impactMult: 2.0, partialFillRate: 0.9 }),
});

const PROFILE_NAMES = Object.freeze(["optimistic", "base", "pessimistic"]);

/**
 * Resolve a named cost profile into a full configuration.
 * @param {string} name "optimistic" | "base" | "pessimistic"
 * @param {object} overrides explicit values that win over the profile
 */
function costProfile(name, overrides) {
  const key = String(name || "base").toLowerCase();
  const profile = COST_PROFILES[key] || COST_PROFILES.base;
  const ov = overrides || {};
  const cfg = Object.assign({}, DEFAULT_COST_CONFIG);
  // The profile SCALES the base cost. An explicit override replaces the
  // scaled value outright: the test harness sets the spread directly to
  // compare two cost levels, and a multiplier on top of that would make the
  // numbers unreadable.
  const mult = function(v) { return v != null ? Number(v) : 1; };
  cfg.spreadPct = ov.spreadPct != null ? Number(ov.spreadPct) : DEFAULT_COST_CONFIG.spreadPct * mult(profile.spreadMult);
  cfg.slippagePct = ov.slippagePct != null ? Number(ov.slippagePct) : DEFAULT_COST_CONFIG.slippagePct * mult(profile.slippageMult);
  cfg.impactCoefficient = ov.impactCoefficient != null ? Number(ov.impactCoefficient) : DEFAULT_COST_CONFIG.impactCoefficient * mult(profile.impactMult);
  cfg.partialFillRate = ov.partialFillRate != null ? Number(ov.partialFillRate)
    : (profile.partialFillRate != null ? profile.partialFillRate : DEFAULT_COST_CONFIG.partialFillRate);
  if (ov.minAtrCostMultiple != null) cfg.minAtrCostMultiple = Number(ov.minAtrCostMultiple);
  if (ov.apiCostPerDecision != null) cfg.apiCostPerDecision = Number(ov.apiCostPerDecision);
  cfg.profileName = COST_PROFILES[key] ? key : "base";
  return cfg;
}

/**
 * The cost of one round trip, in percent of the traded notional.
 * This is the number a signal has to beat before it is worth trading.
 *
 * @param {string} market "US" | "JP" | "KR"
 * @param {object} cfg a cost configuration
 */
function roundTripCostPct(market, cfg) {
  const c = cfg || DEFAULT_COST_CONFIG;
  const fees = resolveFees(market);
  const commission = (Number(fees.buyCommissionPct) || 0) + (Number(fees.sellCommissionPct) || 0);
  const tax = Number(fees.sellTaxPct) || 0;
  const spread = (Number(c.spreadPct) || 0) * 2;
  const slippage = (Number(c.slippagePct) || 0) * 2;
  return commission + tax + spread + slippage;
}

/**
 * The cost of one round trip in the account currency, per unit of notional.
 */
function roundTripCostRate(market, cfg) {
  return roundTripCostPct(market, cfg) / 100;
}

/**
 * Apply every execution cost to one fill and return the full breakdown.
 *
 * @param {object} input
 *   side, symbol, price (the signal/decision price), quantity, notional,
 *   avgVolume, market, fees, config
 * @returns {object} executedPrice, fillRate, costs{commission,spread,slippage,impact,tax},
 *                   totalCost, totalCostPct
 */
function applyExecutionCosts(input) {
  const side = input.side === "SELL" ? "SELL" : "BUY";
  const price = Number(input.price) || 0;
  const qty = Number(input.quantity) || 0;
  const cfg = input.config || DEFAULT_COST_CONFIG;
  const market = input.market || detectMarket(input.symbol);
  const fees = resolveFees(market, input.fees || undefined);
  const direction = side === "BUY" ? 1 : -1;

  const spreadRate = (Number(cfg.spreadPct) || 0) / 100;
  const slippageRate = (Number(cfg.slippagePct) || 0) / 100;

  let impactRate = 0;
  if ((Number(cfg.impactCoefficient) || 0) > 0 && Number(input.avgVolume) > 0 && Number(input.notional) > 0) {
    // Participation rate = order / daily volume; impact ~ sqrt(participation)
    const participation = Number(input.notional) / Number(input.avgVolume);
    impactRate = (Number(cfg.impactCoefficient) || 0) * Math.sqrt(Math.max(0, participation)) / 100;
  }

  const spreadPrice = price * direction * spreadRate;
  const slippagePrice = price * direction * slippageRate;
  const impactPrice = price * direction * impactRate;
  const executedPrice = price + spreadPrice + slippagePrice + impactPrice;

  const commissionPct = (side === "BUY" ? fees.buyCommissionPct : fees.sellCommissionPct) / 100;
  const taxPct = side === "SELL" ? (Number(fees.sellTaxPct) || 0) / 100 : 0;
  const commission = executedPrice * qty * commissionPct;
  const tax = executedPrice * qty * taxPct;
  const spread = Math.abs(spreadPrice * qty);
  const slippage = Math.abs(slippagePrice * qty);
  const impact = Math.abs(impactPrice * qty);
  const totalCost = commission + tax + spread + slippage + impact;

  return {
    side: side,
    market: market,
    executedPrice: executedPrice,
    fillRate: Math.max(0.01, Math.min(1, Number(cfg.partialFillRate) || 1)),
    costs: { commission: commission, spread: spread, slippage: slippage, impact: impact, tax: tax },
    totalCost: totalCost,
    totalCostPct: price > 0 && qty > 0 ? (totalCost / (price * qty)) * 100 : 0,
  };
}

/**
 * The expected move a position can make, in percent, from its ATR.
 * Used by the signal engine's cost gate.
 */
function atrMovePct(ctx) {
  if (!ctx || !(Number(ctx.atr14) > 0) || !(Number(ctx.lastClose) > 0)) return null;
  return (Number(ctx.atr14) / Number(ctx.lastClose)) * 100;
}

/**
 * The cost gate: is a move of this size worth trading at all?
 *
 * @returns {{ ok: boolean, reason: string, atrPct: number|null, costPct: number, requiredPct: number }}
 */
function costGate(ctx, cfg, market) {
  const c = cfg || DEFAULT_COST_CONFIG;
  const costPct = roundTripCostPct(market || "US", c);
  const multiple = Number(c.minAtrCostMultiple) || 1;
  const requiredPct = costPct * multiple;
  const atrPct = atrMovePct(ctx);
  if (atrPct == null) {
    // Without an ATR the expected move cannot be judged. Refusing would stop
    // every signal, so the gate stays open and says so.
    return { ok: true, reason: "no ATR available — the cost gate cannot be evaluated", atrPct: null, costPct: costPct, requiredPct: requiredPct };
  }
  if (atrPct < requiredPct) {
    return {
      ok: false,
      reason: "expected move " + atrPct.toFixed(3) + "% is below " + requiredPct.toFixed(3)
        + "% (round-trip cost " + costPct.toFixed(3) + "% x " + multiple + ")",
      atrPct: atrPct, costPct: costPct, requiredPct: requiredPct,
    };
  }
  return { ok: true, reason: "expected move " + atrPct.toFixed(3) + "% covers the " + costPct.toFixed(3) + "% round-trip cost", atrPct: atrPct, costPct: costPct, requiredPct: requiredPct };
}

module.exports = {
  DEFAULT_COST_CONFIG,
  COST_PROFILES,
  PROFILE_NAMES,
  costProfile,
  roundTripCostPct,
  roundTripCostRate,
  applyExecutionCosts,
  atrMovePct,
  costGate,
};
