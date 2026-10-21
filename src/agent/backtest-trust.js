"use strict";

/**
 * Backtest trust gate — decides whether a backtest result is allowed to
 * influence live risk parameters.
 *
 * [2026-10-21] The profitability measurement system was broken in a way that
 * was invisible from the outside: a candles file whose open/close were 0
 * produced zero trades, sharpe 0, a flat equity curve and a 0% return. Every
 * one of those is a number, so the result file looked exactly like a normal
 * result. The runner then read it back and concluded "the strategy is safe
 * but underperforming" — and LOOSENED live risk on the strength of no
 * evidence (stop-loss -2% -> -3%, take-profit 5% -> 8%).
 *
 * The gate is extracted here so it can be unit tested directly. It is
 * fail-closed by construction: a result that does not positively prove it
 * came from a validated, adequately sized run is rejected.
 */

const DEFAULTS = Object.freeze({
  minTrades: Number(process.env.BT_MIN_TRADES || 20),
  minDataDays: Number(process.env.BT_MIN_DATA_DAYS || 20),
});

// The live P&L engine is the single source of truth for the fee model.
const { resolveFees } = require("./pnl");

/**
 * The round-trip transaction cost of a market, in PERCENT.
 *
 * [2026-10-21] The fee fields of resolveFees are already percentages — the
 * P&L engine divides them by 100 when it applies them. Multiplying by 100
 * here a second time turned a 0.50% cost into 50.3% and produced a
 * -150% stop-loss, which is no stop at all.
 *
 * US: 0.25% commission each way + 0.00278% regulatory fee = 0.5028%.
 */
function roundTripCostPct(market, overrides) {
  const f = resolveFees(market || "US", overrides || {});
  return (Number(f.buyCommissionPct) || 0)
    + (Number(f.sellCommissionPct) || 0)
    + (Number(f.sellTaxPct) || 0);
}

/**
 * @param {object} bt the parsed backtest result
 * @param {object} options { minTrades, minDataDays }
 * @returns {{ trusted: boolean, reason: string, provenance: object|null }}
 */
function assessBacktestTrust(bt, options = {}) {
  const cfg = { ...DEFAULTS, ...(options || {}) };
  const reject = (reason) => ({ trusted: false, reason, provenance: null });

  if (!bt || typeof bt !== "object") {
    return reject("result is not an object");
  }
  if (typeof bt.sharpe !== "number" || !Number.isFinite(bt.sharpe)) {
    return reject("sharpe is not a finite number");
  }

  // Provenance. Absence of metadata is not evidence of a good strategy.
  const meta = bt.meta;
  if (!meta || typeof meta !== "object") {
    return reject("result carries no validation metadata (written by a build without input validation, or edited by hand)");
  }
  if (meta.validation !== "ok") {
    return reject("input data validation failed (" + (meta.invalidReason || "unknown reason") + ")");
  }
  if (meta.confidence === "none") {
    return reject("result confidence is 'none'");
  }
  if (meta.confidence !== "high") {
    return reject("result confidence is '" + meta.confidence + "' (some input candles were unusable)");
  }

  const trades = Number(bt.trades || 0);
  if (meta.trades != null && Number(meta.trades) !== trades) {
    return reject("trade count mismatch (meta.trades=" + meta.trades + " vs trades=" + trades + ")");
  }
  if (trades < cfg.minTrades) {
    return reject(
      "trades=" + trades + " < min " + cfg.minTrades
      + (trades === 0
        ? " — 0 trades usually means the candle input had no usable prices (open/close = 0), so every signal was skipped"
        : "")
    );
  }
  if (bt.sharpe === 0 && bt.totalReturnPct === 0 && bt.maxDrawdownPct === 0) {
    return reject("all metrics are zero despite " + trades + " trades — input data is suspect");
  }

  if (meta.dataStart && meta.dataEnd) {
    const spanMs = Date.parse(meta.dataEnd) - Date.parse(meta.dataStart);
    if (Number.isFinite(spanMs)) {
      const spanDays = Math.round(spanMs / 86400000);
      if (spanDays < cfg.minDataDays) {
        return reject("data span " + spanDays + " days is below the minimum " + cfg.minDataDays + " days");
      }
    }
  }

  return {
    trusted: true,
    // [2026-10-21] A measurement that lost money says nothing trustworthy
    // about how to tune the live risk, and the loosening adjustments widen
    // the stop. A losing result may therefore only ever tighten. The
    // previous behaviour was the opposite: a zero-valued run was accepted,
    // and a result with a small drawdown was treated as licence to widen the
    // stop from -2% to -3% and the take-profit from 5% to 8%.
    mayLoosen: Number(bt.totalReturnPct) > 0,
    reason: "validated result with " + trades + " trades over " + (meta.symbolCount || 0) + " symbol(s)",
    provenance: {
      dataStart: meta.dataStart || null,
      dataEnd: meta.dataEnd || null,
      symbolCount: meta.symbolCount || 0,
      candleCount: meta.candleCount || 0,
      validCandleRatio: meta.validCandleRatio != null ? meta.validCandleRatio : null,
      validation: meta.validation,
      confidence: meta.confidence,
      costModel: meta.costModel || null,
      // [2026-10-21] Which stop/take the measurement actually exercised. The
      // ATR override in the exit signal replaces the supplied stop/take, so
      // a run can measure something else from what it claims. A parameter
      // that was not in force cannot be tuned from the result.
      effectiveStops: meta.effectiveStops || null,
      trades: trades,
    },
  };
}

module.exports = { assessBacktestTrust, roundTripCostPct, DEFAULTS };
