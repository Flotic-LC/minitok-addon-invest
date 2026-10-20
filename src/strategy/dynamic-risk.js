"use strict";

/**
 * Dynamic risk parameters — adjusts hard-stop and position sizing based on
 * market regime (ATR, volatility percentile, VIX proxy).
 *
 * Instead of fixed -2% daily hard-stop, this module computes:
 *   - dynamicHardStopPct: based on portfolio ATR or index volatility
 *   - positionMultiplier: shrink positions in high-vol regimes
 *   - trailingStopAdjust: tighten/loosen trailing stops
 *
 * Usage:
 *   const { computeDynamicRisk } = require("./src/strategy/dynamic-risk");
 *   const risk = computeDynamicRisk({ portfolioAtrPct: 1.8, vixProxy: 22 });
 *   // risk.dynamicHardStopPct = -2.7 (1.5x ATR)
 *   // risk.positionMultiplier = 0.75
 */

const DEFAULTS = Object.freeze({
  // Hard-stop = baseStopPct * atrMultiplier (floored at minHardStopPct)
  baseStopPct: Number(process.env.DYN_BASE_STOP_PCT || -1.5),
  atrMultiplier: Number(process.env.DYN_ATR_MULT || 1.5),
  minHardStopPct: Number(process.env.DYN_MIN_HARD_STOP_PCT || -4.0),
  maxHardStopPct: Number(process.env.DYN_MAX_HARD_STOP_PCT || -1.0),

  // Position sizing adjustment by regime
  lowVolThreshold: Number(process.env.DYN_LOW_VOL_PCT || 1.0),   // ATR% < 1% = calm
  highVolThreshold: Number(process.env.DYN_HIGH_VOL_PCT || 3.0), // ATR% > 3% = turbulent
  lowVolMultiplier: Number(process.env.DYN_LOW_VOL_MULT || 1.2),  // +20% size in calm
  highVolMultiplier: Number(process.env.DYN_HIGH_VOL_MULT || 0.5), // -50% size in turbulence

  // VIX proxy thresholds (if available)
  vixCalm: Number(process.env.DYN_VIX_CALM || 15),
  vixElevated: Number(process.env.DYN_VIX_ELEVATED || 25),
  vixPanic: Number(process.env.DYN_VIX_PANIC || 35),
});

/**
 * Compute dynamic risk parameters from market context.
 * @param {object} ctx
 *   @param {number} [ctx.portfolioAtrPct] - weighted avg ATR% of open positions
 *   @param {number} [ctx.indexAtrPct] - index (KOSPI/SPX) ATR%
 *   @param {number} [ctx.vixProxy] - VIX or equivalent volatility index
 *   @param {number} [ctx.recentDrawdownPct] - current drawdown from HWM
 * @param {object} [opts] - DEFAULTS overrides
 * @returns {{ dynamicHardStopPct, positionMultiplier, trailingStopAdjust, regime, reason }}
 */
function computeDynamicRisk(ctx = {}, opts = {}) {
  const p = { ...DEFAULTS, ...opts };
  const atrPct = ctx.portfolioAtrPct || ctx.indexAtrPct || 1.5; // default mid-range
  const vix = ctx.vixProxy || 18;

  // 1. Dynamic hard-stop: base * atrMultiplier, clamped to [min, max]
  let dynamicHardStopPct = p.baseStopPct * Math.max(atrPct / 1.5, 0.5);
  dynamicHardStopPct = Math.max(p.minHardStopPct, Math.min(p.maxHardStopPct, dynamicHardStopPct));

  // 2. Position multiplier by regime
  let positionMultiplier = 1.0;
  let regime = "normal";
  let reason = [];

  if (atrPct < p.lowVolThreshold) {
    positionMultiplier = p.lowVolMultiplier;
    regime = "calm";
    reason.push("low volatility (" + atrPct.toFixed(2) + "%) → +" + ((p.lowVolMultiplier - 1) * 100) + "% size");
  } else if (atrPct > p.highVolThreshold) {
    positionMultiplier = p.highVolMultiplier;
    regime = "turbulent";
    reason.push("high volatility (" + atrPct.toFixed(2) + "%) → -" + ((1 - p.highVolMultiplier) * 100) + "% size");
  } else {
    reason.push("normal volatility (" + atrPct.toFixed(2) + "%)");
  }

  // 3. VIX overlay (if available)
  if (vix >= p.vixPanic) {
    positionMultiplier *= 0.3;
    regime = "panic";
    reason.push("VIX " + vix + " (panic) → 70% reduction");
  } else if (vix >= p.vixElevated) {
    positionMultiplier *= 0.6;
    regime = regime === "turbulent" ? "turbulent+elevated" : "elevated";
    reason.push("VIX " + vix + " (elevated) → 40% reduction");
  } else if (vix < p.vixCalm && regime === "calm") {
    positionMultiplier *= 1.1;
    reason.push("VIX " + vix + " (calm) → +10% bonus");
  }

  // 4. Trailing stop adjustment: tighten in turbulence, loosen in calm
  let trailingStopAdjust = 1.0;
  if (regime === "turbulent" || regime === "panic") {
    trailingStopAdjust = 0.7; // 30% tighter
  } else if (regime === "calm") {
    trailingStopAdjust = 1.2; // 20% looser
  }

  // 5. Drawdown amplifier: if already in drawdown, tighten further
  if (ctx.recentDrawdownPct && ctx.recentDrawdownPct < -3) {
    positionMultiplier *= 0.8;
    reason.push("drawdown " + ctx.recentDrawdownPct.toFixed(1) + "% → 20% reduction");
  }

  // Clamp multiplier to [0.1, 2.0]
  positionMultiplier = Math.max(0.1, Math.min(2.0, positionMultiplier));

  return {
    dynamicHardStopPct: Number(dynamicHardStopPct.toFixed(2)),
    positionMultiplier: Number(positionMultiplier.toFixed(2)),
    trailingStopAdjust: Number(trailingStopAdjust.toFixed(2)),
    regime,
    reason: reason.join("; "),
  };
}

module.exports = { computeDynamicRisk, DEFAULTS };
