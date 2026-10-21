"use strict";

/**
 * Trade analytics — the measurement layer that says which signals are worth
 * taking.
 *
 * [2026-10-21 3단계] Until now the only performance number the add-on had was
 * a single aggregate return. That number cannot answer the question that
 * matters: "which of my entry signals make money once the round-trip cost is
 * paid, and which are just churn?". The 2단계 measurement showed the strategy
 * is a GROSS winner (+553) and a NET loser (-1,089) over 336 trades, and the
 * per-strategy classification already showed that only mean_reversion
 * survived. What was missing was the instrumentation to make that repeatable
 * and to drive it back into the code.
 *
 * Every closed round trip carries:
 *   - the entry signal (strategy, score, reasons), the regime and a
 *     confidence proxy at entry,
 *   - the exit signal and the classified exit reason,
 *   - the gross P&L, the cost breakdown and the net P&L.
 *
 * This module turns those trades into the breakdowns, and derives the
 * blocklist of signals that are proven to lose money after costs.
 *
 * The sample guards matter as much as the arithmetic. A signal is only
 * blocked when it has enough trades to be a measurement rather than noise,
 * and the derivation refuses to produce anything at all from an empty or
 * invalid trade set — an automatic parameter change on zero trades is exactly
 * the failure that made the old feedback loop loosen the live stop.
 */

const CONFIDENCE_BUCKETS = [
  { key: "0-1", min: 0, max: 1 },
  { key: "2-3", min: 2, max: 3 },
  { key: "4-5", min: 4, max: 5 },
  { key: "6-7", min: 6, max: 7 },
  { key: "8+", min: 8, max: Infinity },
];

const HOLDING_BUCKETS = [
  { key: "0-1 bars", min: 0, max: 1 },
  { key: "2-3 bars", min: 2, max: 3 },
  { key: "4-7 bars", min: 4, max: 7 },
  { key: "8-14 bars", min: 8, max: 14 },
  { key: "15+ bars", min: 15, max: Infinity },
];

function bucketFor(buckets, value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return "unknown";
  for (const b of buckets) {
    if (v >= b.min && v <= b.max) return b.key;
  }
  return "unknown";
}

function newAgg() {
  return {
    trades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    grossPnl: 0,
    netPnl: 0,
    costs: 0,
    grossProfit: 0,
    grossLoss: 0,
    profitFactor: null,
    costRatio: null,
    avgNet: 0,
    expectancy: 0,
    avgHoldingBars: 0,
  };
}

function addTrade(agg, t) {
  const net = Number(t.netPnl) || 0;
  const gross = Number(t.grossPnl) || 0;
  agg.trades++;
  agg.netPnl += net;
  agg.grossPnl += gross;
  agg.costs += Number(t.totalCosts) || 0;
  if (net > 0) { agg.wins++; agg.grossProfit += net; }
  else if (net < 0) { agg.losses++; agg.grossLoss += Math.abs(net); }
  agg._holdingSum = (agg._holdingSum || 0) + (Number(t.holdingBars) || 0);
  return agg;
}

function finishAgg(agg) {
  agg.winRate = agg.trades ? agg.wins / agg.trades : 0;
  agg.avgNet = agg.trades ? agg.netPnl / agg.trades : 0;
  agg.expectancy = agg.avgNet;
  agg.avgHoldingBars = agg.trades ? (agg._holdingSum || 0) / agg.trades : 0;
  agg.profitFactor = agg.grossLoss > 0 ? agg.grossProfit / agg.grossLoss : (agg.grossProfit > 0 ? Infinity : null);
  agg.costRatio = Math.abs(agg.grossPnl) > 0 ? agg.costs / Math.abs(agg.grossPnl) : null;
  delete agg._holdingSum;
  return agg;
}

/**
 * The closed round trips of a backtest run, with the entry signal carried on
 * the exit record so every trade can be attributed to the signal that opened
 * it.
 */
function closedRoundTrips(trades) {
  return (trades || []).filter(function (t) {
    return t && t.side === "SELL" && t.netPnl != null;
  });
}

/**
 * Every breakdown the 3단계 brief asks for, from one trade set.
 */
function analyzeTrades(trades, options) {
  const opts = options || {};
  const closed = closedRoundTrips(trades);
  const out = {
    totalTrades: closed.length,
    valid: closed.length > 0,
    overall: newAgg(),
    byEntryStrategy: {},
    byExitStrategy: {},
    byExitReason: {},
    byConfidenceBucket: {},
    byHoldingBucket: {},
    bySymbol: {},
    byRegime: {},
    byEntryReason: {},
    entryReasonsSeen: {},
  };

  function slot(map, key) {
    const k = key == null || key === "" ? "(none)" : String(key);
    if (!map[k]) map[k] = newAgg();
    return map[k];
  }

  for (const t of closed) {
    addTrade(out.overall, t);
    addTrade(slot(out.byEntryStrategy, t.entryStrategy), t);
    addTrade(slot(out.byExitStrategy, t.exitStrategy), t);
    addTrade(slot(out.byExitReason, t.exitReason), t);
    addTrade(slot(out.byConfidenceBucket, bucketFor(CONFIDENCE_BUCKETS, t.entryScore)), t);
    addTrade(slot(out.byHoldingBucket, bucketFor(HOLDING_BUCKETS, t.holdingBars)), t);
    addTrade(slot(out.bySymbol, t.symbol), t);
    addTrade(slot(out.byRegime, t.regime), t);
    // Every entry reason the signal carried gets the trade's P&L attributed
    // to it, so a single evidence line can be judged on its own.
    const reasons = Array.isArray(t.entryReasons) ? t.entryReasons : [];
    for (const r of reasons) {
      addTrade(slot(out.byEntryReason, r), t);
      out.entryReasonsSeen[r] = true;
    }
  }

  out.overall = finishAgg(out.overall);
  for (const map of [out.byEntryStrategy, out.byExitStrategy, out.byExitReason, out.byConfidenceBucket, out.byHoldingBucket, out.bySymbol, out.byRegime, out.byEntryReason]) {
    for (const k of Object.keys(map)) map[k] = finishAgg(map[k]);
  }
  out.byEntryStrategyList = Object.keys(out.byEntryStrategy).sort();
  out.tradesPerEntryStrategy = out.totalTrades;
  return out;
}

/**
 * Derive the signals to block.
 *
 * [2026-10-21] A signal is blocked only when BOTH hold:
 *   - it has enough closed round trips to be a measurement (minTrades), and
 *   - its NET P&L after costs is negative.
 *
 * A signal that is gross-profitable but net-negative is still blocked: the
 * cost is not an excuse, it is the reason the trade does not exist.
 *
 * A signal with too few trades is NOT blocked and NOT adjusted — it is
 * reported as "insufficient sample" so the operator knows it is unmeasured
 * rather than good.
 */
function deriveSignalBlocklist(analysis, options) {
  const opts = Object.assign({ minTrades: 15, blockGrossPositiveNetNegative: true }, options || {});
  const blocked = [];
  const kept = [];
  const unmeasured = [];

  if (!analysis || !analysis.valid || analysis.totalTrades === 0) {
    return {
      blocked: [], kept: [], unmeasured: [],
      minTrades: opts.minTrades,
      reason: "no closed round trips — no automatic signal change is permitted",
    };
  }

  for (const name of (analysis.byEntryStrategyList || [])) {
    const agg = analysis.byEntryStrategy[name];
    if (!agg || agg.trades < opts.minTrades) {
      unmeasured.push({
        strategy: name,
        trades: agg ? agg.trades : 0,
        netPnl: agg ? agg.netPnl : 0,
        reason: "insufficient sample (" + (agg ? agg.trades : 0) + " < " + opts.minTrades + ") — left enabled, not adjusted",
      });
      continue;
    }
    const netNegative = agg.netPnl < 0;
    const grossPositiveNetNegative = agg.grossPnl > 0 && agg.netPnl < 0;
    if (netNegative) {
      blocked.push({
        strategy: name,
        trades: agg.trades,
        grossPnl: agg.grossPnl,
        netPnl: agg.netPnl,
        costs: agg.costs,
        costRatio: agg.costRatio,
        winRate: agg.winRate,
        grossPositiveNetNegative: grossPositiveNetNegative,
        reason: grossPositiveNetNegative
          ? "gross +" + agg.grossPnl.toFixed(2) + " but net " + agg.netPnl.toFixed(2) + " over " + agg.trades + " trades — killed by costs"
          : "net " + agg.netPnl.toFixed(2) + " over " + agg.trades + " trades",
      });
    } else {
      kept.push({
        strategy: name,
        trades: agg.trades,
        grossPnl: agg.grossPnl,
        netPnl: agg.netPnl,
        costRatio: agg.costRatio,
        winRate: agg.winRate,
        reason: "net " + agg.netPnl.toFixed(2) + " over " + agg.trades + " trades",
      });
    }
  }

  return { blocked, kept, unmeasured, minTrades: opts.minTrades };
}

/**
 * A size multiplier per strategy, derived from the measured profit factor.
 *
 * [2026-10-21] The position size is the last lever that is still free once
 * the losing signals are blocked. A signal that survives with a profit
 * factor above 1 has a better expectation than one at 1.0, so it is allowed
 * a slightly larger position; a signal below 1 is smaller. The multiplier is
 * clamped so it can never turn a survivor into a large bet, and it defaults
 * to 1.0 (no change) whenever there is no measurement.
 */
function deriveEdgeMultipliers(analysis, options) {
  const opts = Object.assign({ minTrades: 15, min: 0.5, max: 1.5, neutralPf: 1.0 }, options || {});
  const out = {};
  if (!analysis || !analysis.valid || analysis.totalTrades === 0) return out;
  for (const name of (analysis.byEntryStrategyList || [])) {
    const agg = analysis.byEntryStrategy[name];
    if (!agg || agg.trades < opts.minTrades) continue;
    const pf = agg.profitFactor;
    if (pf == null) continue;
    // A strategy with no losing trade has an infinite profit factor. That is
    // the best possible expectation, not an unusable measurement, so it gets
    // the maximum multiplier instead of being skipped.
    const mult = pf === Infinity
      ? opts.max
      : Math.min(opts.max, Math.max(opts.min, pf / opts.neutralPf));
    out[name] = Number(mult.toFixed(4));
  }
  return out;
}

/**
 * The expected value per trade of a strategy set, and the comparison the
 * 3단계 brief asks for: expectancy, profit factor, max drawdown, Sharpe,
 * turnover, cost ratio and trade quality.
 */
function summarizeRun(result, options) {
  const opts = options || {};
  const analysis = result && result.tradeAnalytics ? result.tradeAnalytics : analyzeTrades(result && result.trades);
  const netExpectancy = analysis.valid ? analysis.overall.avgNet : null;
  return {
    netExpectancy: netExpectancy,
    profitFactor: analysis.overall.profitFactor,
    totalReturnPct: result ? result.totalReturnPct : null,
    maxDrawdownPct: result ? result.maxDrawdownPct : null,
    sharpe: result ? result.sharpe : null,
    turnover: analysis.valid ? analysis.totalTrades : 0,
    costRatio: analysis.overall.costRatio,
    grossPnl: analysis.overall.grossPnl,
    netPnl: analysis.overall.netPnl,
    costs: analysis.overall.costs,
    winRate: analysis.overall.winRate,
    tradeQuality: analysis.valid ? analysis.overall.winRate : null,
    blockedStrategies: opts.blockedStrategies || [],
    keptStrategies: opts.keptStrategies || [],
  };
}

module.exports = {
  CONFIDENCE_BUCKETS,
  HOLDING_BUCKETS,
  analyzeTrades,
  deriveSignalBlocklist,
  deriveEdgeMultipliers,
  summarizeRun,
  closedRoundTrips,
  bucketFor,
};
