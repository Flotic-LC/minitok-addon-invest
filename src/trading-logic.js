"use strict";

// --- Pure Trading Logic Functions ---
// Mirrors the algorithms in runner.js (P8 trailing stop, P9 recent win rate,
// P10 fixes) as side-effect-free functions so they can be unit tested without
// env vars, network, or the minitok runtime.

/**
 * Record a fill into a ring buffer, computing SELL P&L from entry prices.
 * [P10-1] If knownPnl is provided, it is used directly (avoids the stale
 * entryPrices lookup that occurred when entryPrices.delete() ran first).
 * Returns the record that was pushed.
 */
function recordRecentFill(recentFills, maxFills, entryPrices, symbol, side, price, quantity, knownPnl) {
  var pnl = null;
  if (knownPnl != null) {
    pnl = knownPnl;
  } else if (side === "SELL" && price > 0) {
    var entry = entryPrices.get(String(symbol).toUpperCase());
    if (entry && entry > 0) {
      pnl = (price - entry) * quantity;
    }
  }
  var record = { symbol: symbol, side: side, price: price, quantity: quantity, pnl: pnl, at: new Date().toISOString() };
  recentFills.push(record);
  if (recentFills.length > maxFills) recentFills.shift();
  return record;
}

/**
 * Compute recent win rate, two-tier:
 * 1. Recent SELL fills with non-null P&L, windowed to the last adaptiveTargetWindow entries.
 * 2. Fallback to cumulative symbolPerformance when fewer than 3 recent SELLs exist.
 * Returns a number in [0..1], or null when data is insufficient.
 */
function computeRecentWinRate(recentFills, symbolPerformance, adaptiveTargetWindow) {
  var recentSells = recentFills.filter(function (f) { return f.side === "SELL" && f.pnl !== null; });
  // [P10-3] Apply window limit: use only the last N sells
  if (recentSells.length > adaptiveTargetWindow) {
    recentSells = recentSells.slice(recentSells.length - adaptiveTargetWindow);
  }
  if (recentSells.length >= 3) {
    var recentWins = recentSells.filter(function (f) { return f.pnl > 0; }).length;
    return recentWins / recentSells.length;
  }
  var totalWins = 0, totalTrades = 0;
  for (var perf of symbolPerformance.values()) {
    totalWins += perf.wins;
    totalTrades += perf.trades;
  }
  if (totalTrades === 0 || totalTrades < 5) return null;
  return totalWins / totalTrades;
}

/**
 * Record a trade outcome for a symbol (mutates symbolPerformance in place).
 */
function recordSymbolOutcome(symbolPerformance, symbol, pnl) {
  if (!symbol) return;
  var s = String(symbol).toUpperCase();
  if (!symbolPerformance.has(s)) {
    symbolPerformance.set(s, { trades: 0, wins: 0, losses: 0, totalPnl: 0 });
  }
  var perf = symbolPerformance.get(s);
  perf.trades++;
  if (pnl > 0) perf.wins++;
  else if (pnl < 0) perf.losses++;
  perf.totalPnl += pnl;
}

/**
 * Evaluate trailing stop for a single position (pure decision function).
 * Mirrors checkTrailingStops() per-symbol logic from runner.js.
 *
 * @param sym           symbol string
 * @param currentPrice  latest price
 * @param qty           held quantity
 * @param entry         entry price (entryPrices lookup or avgPrice fallback)
 * @param peak          current peak price tracked for the symbol (or undefined)
 * @param trailingStopPct  negative number, e.g. -3 for -3% drop-from-peak trigger
 * @param minProfitPct  minimum profit % required before trailing activates
 *
 * Returns one of:
 *   { triggered: true, action: "SELL", dropPct, profitPct, peak, peakUpdated }
 *   { triggered: false, peak, peakUpdated, dropPct }
 *   { skip: true, reason, clearPeak? }
 */
function evaluateTrailingStop(sym, currentPrice, qty, entry, peak, trailingStopPct, minProfitPct) {
  if (!sym || !currentPrice || !qty || qty <= 0) return { skip: true, reason: "invalid_position" };
  if (!entry || entry <= 0) return { skip: true, reason: "no_entry" };

  var profitPct = ((currentPrice - entry) / entry) * 100;

  if (profitPct < minProfitPct) {
    return { skip: true, reason: "below_min_profit", profitPct: profitPct, clearPeak: true };
  }

  var newPeak = (peak != null && peak !== undefined) ? peak : entry;
  var peakUpdated = false;
  if (currentPrice > newPeak) {
    newPeak = currentPrice;
    peakUpdated = true;
  }

  var dropFromPeakPct = ((currentPrice - newPeak) / newPeak) * 100;

  if (dropFromPeakPct <= trailingStopPct) {
    return {
      triggered: true,
      action: "SELL",
      dropPct: Number(dropFromPeakPct.toFixed(2)),
      profitPct: Number(profitPct.toFixed(2)),
      peak: newPeak,
      peakUpdated: peakUpdated,
    };
  }

  return {
    triggered: false,
    peak: newPeak,
    peakUpdated: peakUpdated,
    dropPct: Number(dropFromPeakPct.toFixed(2)),
  };
}

/**
 * Compute adaptive target offset from win rate.
 * Mirrors updateAdaptiveTarget() thresholds in runner.js.
 */
function computeAdaptiveTargetOffset(winRate, bonusPct, penaltyPct) {
  if (winRate === null || winRate === undefined) return 0;
  if (winRate >= 0.6) return bonusPct;
  if (winRate <= 0.4) return penaltyPct;
  return 0;
}

/**
 * Worst performers by totalPnl ascending (used by universe eviction).
 */
function getWorstSymbols(symbolPerformance, minTrades, count) {
  var results = [];
  for (var entry of symbolPerformance.entries()) {
    var sym = entry[0], perf = entry[1];
    if (perf.trades >= minTrades) {
      results.push({ symbol: sym, trades: perf.trades, wins: perf.wins, losses: perf.losses, totalPnl: perf.totalPnl });
    }
  }
  results.sort(function (a, b) { return a.totalPnl - b.totalPnl; });
  return results.slice(0, count);
}

/**
 * Best performers by totalPnl descending.
 */
function getBestSymbols(symbolPerformance, minTrades, count) {
  var results = [];
  for (var entry of symbolPerformance.entries()) {
    var sym = entry[0], perf = entry[1];
    if (perf.trades >= minTrades) {
      results.push({ symbol: sym, trades: perf.trades, wins: perf.wins, losses: perf.losses, totalPnl: perf.totalPnl });
    }
  }
  results.sort(function (a, b) { return b.totalPnl - a.totalPnl; });
  return results.slice(0, count);
}

module.exports = {
  recordRecentFill,
  computeRecentWinRate,
  recordSymbolOutcome,
  evaluateTrailingStop,
  computeAdaptiveTargetOffset,
  getWorstSymbols,
  getBestSymbols,
};