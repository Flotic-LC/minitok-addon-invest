"use strict";

/**
 * Multi-Strategy Orchestrator — runs multiple strategies in parallel,
 * tracks performance per strategy, and dynamically allocates capital
 * to the best-performing strategies.
 *
 * Pipeline:
 *   1. Register multiple strategy plugins (momentum, mean-reversion, breakout, etc.)
 *   2. Each strategy generates signals independently
 *   3. Orchestrator tracks fills per strategy (P&L, win rate, drawdown)
 *   4. Periodically rebalance capital allocation based on performance
 *   5. Underperforming strategies get reduced allocation; top performers get more
 *
 * Constitution constraints:
 *   - Total allocation always sums to 1.0
 *   - Min allocation per strategy: 5% (prevents starvation)
 *   - Max allocation per strategy: 40% (prevents concentration)
 *   - Weight changes > 5% relative flow through shadow mode (7-day observation)
 *
 * Usage:
 *   const { createStrategyOrchestrator } = require("./src/strategy/orchestrator");
 *   const orch = createStrategyOrchestrator({ registry, shadowMode });
 *   orch.registerStrategy("momentum");
 *   orch.recordFill("momentum", { symbol: "AAPL", side: "SELL", pnl: 500 });
 *   const allocation = orch.getAllocation(); // { momentum: 0.45, ... }
 *   orch.rebalance();
 */

const DEFAULT_CONFIG = Object.freeze({
  minAllocationPct: 5.0,
  maxAllocationPct: 40.0,
  rebalanceIntervalDays: 7,
  minTradesForEval: 10,
  performanceWindow: 30,
  sharpeWeight: 0.5,
  winRateWeight: 0.3,
  drawdownPenaltyWeight: 0.2,
  maxDrawdownPenalty: 30.0,
  rebalanceChangeThresholdPct: 5.0,
  explorationReservePct: 10.0,
});

function createStrategyOrchestrator(options = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(options.config || {}) };
  const registry = options.registry || null;
  const shadowMode = options.shadowMode || null;
  const onRebalance = options.onRebalance || function() {};
  const now = options.now || function() { return Date.now(); };

  const strategyStats = new Map();
  const allocation = new Map();
  const history = [];
  let lastRebalance = null;

  function initStrategy(name) {
    if (!strategyStats.has(name)) {
      strategyStats.set(name, {
        fills: [], wins: 0, losses: 0, totalPnl: 0,
        maxDrawdown: 0, currentDrawdown: 0, peakPnl: 0,
      });
    }
    if (!allocation.has(name)) {
      const count = allocation.size + 1;
      const weight = 1.0 / count;
      for (const [k] of allocation) allocation.set(k, weight);
      allocation.set(name, weight);
    }
  }

  function registerStrategy(name) {
    initStrategy(name);
    return true;
  }

  function unregisterStrategy(name) {
    strategyStats.delete(name);
    allocation.delete(name);
    // Re-normalize remaining
    const remaining = Array.from(allocation.keys());
    if (remaining.length > 0) {
      const w = 1.0 / remaining.length;
      for (const k of remaining) allocation.set(k, w);
    }
    return true;
  }

  function recordFill(strategyName, fill) {
    initStrategy(strategyName);
    const stats = strategyStats.get(strategyName);
    stats.fills.push(fill);
    if (fill && fill.pnl != null) {
      stats.totalPnl += fill.pnl;
      if (fill.pnl > 0) stats.wins++;
      else if (fill.pnl < 0) stats.losses++;
      if (stats.totalPnl > stats.peakPnl) stats.peakPnl = stats.totalPnl;
      stats.currentDrawdown = stats.peakPnl - stats.totalPnl;
      if (stats.currentDrawdown > stats.maxDrawdown) {
        stats.maxDrawdown = stats.currentDrawdown;
      }
    }
  }

  function getStrategyStats(name) {
    const s = strategyStats.get(name);
    if (!s) return null;
    const total = s.wins + s.losses;
    return {
      name,
      totalTrades: total,
      wins: s.wins,
      losses: s.losses,
      winRate: total > 0 ? s.wins / total : 0,
      totalPnl: s.totalPnl,
      maxDrawdown: s.maxDrawdown,
      avgPnl: total > 0 ? s.totalPnl / total : 0,
      fills: s.fills.length,
    };
  }

  function getAllStats() {
    const result = [];
    for (const [name] of strategyStats) result.push(getStrategyStats(name));
    return result;
  }

  // Performance score for ranking strategies
  function computePerformanceScore(stats) {
    if (!stats || stats.totalTrades < cfg.minTradesForEval) return -Infinity;
    const winRate = stats.winRate;
    const avgPnl = stats.avgPnl;
    const maxDD = stats.maxDrawdown;
    // Sharpe proxy: avg return / drawdown risk
    const sharpeProxy = avgPnl > 0 ? avgPnl / (maxDD || 1) : (avgPnl < 0 ? avgPnl : 0);
    let score = sharpeProxy * cfg.sharpeWeight;
    score += (winRate - 0.5) * cfg.winRateWeight;
    if (maxDD > cfg.maxDrawdownPenalty) {
      score -= (maxDD - cfg.maxDrawdownPenalty) * 0.01;
    }
    return score;
  }

  // Rebalance capital allocation based on performance
  function rebalance() {
    const stats = getAllStats();
    if (stats.length === 0) return { ok: false, reason: "no strategies registered" };

    const scores = stats.map(s => ({ name: s.name, score: computePerformanceScore(s), stats: s }));
    const finiteScores = scores.filter(s => Number.isFinite(s.score));
    const insufficient = scores.filter(s => !Number.isFinite(s.score));

    if (finiteScores.length === 0 && insufficient.length === 0) {
      return { ok: false, reason: "no strategies" };
    }

    const newAllocation = new Map();

    const minW = cfg.minAllocationPct / 100;
    const maxW = cfg.maxAllocationPct / 100;

    // If ALL strategies have insufficient data, give equal allocation
    if (finiteScores.length === 0) {
      const perStrategy = 1.0 / insufficient.length;
      for (const s of insufficient) {
        newAllocation.set(s.name, Math.max(minW, Math.min(maxW, perStrategy)));
      }
      // Normalize to exactly 1.0
      const total = Array.from(newAllocation.values()).reduce((a, b) => a + b, 0);
      if (total > 0) {
        for (const [k, v] of newAllocation) newAllocation.set(k, v / total);
      }
    } else {
      // Reserve exploration budget for strategies with insufficient data
      const explorationBudget = insufficient.length > 0
        ? (cfg.explorationReservePct / 100)
        : 0;
      const performanceBudget = 1.0 - explorationBudget;

      // Distribute performance budget proportionally to scores
      finiteScores.sort((a, b) => b.score - a.score);
      const minScore = Math.min(...finiteScores.map(s => s.score));
      const shifted = finiteScores.map(s => ({
        name: s.name,
        raw: Math.max(0.01, s.score - minScore + 0.1),
      }));

      // Iterative bounded allocation: lock one item per iteration
      const locked = new Set();
      const lockedWeights = new Map();
      for (let iter = 0; iter <= shifted.length * 2; iter++) {
        const lockedSum = Array.from(locked).reduce((s, n) => s + (lockedWeights.get(n) || 0), 0);
        const freeItems = shifted.filter(s => !locked.has(s.name));
        if (freeItems.length === 0) break;

        const freeBudget = performanceBudget - lockedSum;
        const freeRaw = freeItems.reduce((s, i) => s + i.raw, 0);

        // Find the most violated item
        let worstItem = null;
        let worstViolation = 0;
        for (const item of freeItems) {
          const w = (item.raw / freeRaw) * freeBudget;
          const violation = w < minW ? (minW - w) : (w > maxW ? (w - maxW) : 0);
          if (violation > worstViolation) {
            worstViolation = violation;
            worstItem = item;
          }
        }

        if (!worstItem) {
          // All free items within bounds — assign and done
          for (const item of freeItems) {
            const w = (item.raw / freeRaw) * freeBudget;
            lockedWeights.set(item.name, w);
          }
          break;
        }

        // Lock the worst violated item at its bound
        const w = (worstItem.raw / freeRaw) * freeBudget;
        const bound = w < minW ? minW : maxW;
        lockedWeights.set(worstItem.name, bound);
        locked.add(worstItem.name);
      }

      for (const [name, w] of lockedWeights) newAllocation.set(name, w);

      // Exploration: equal share for strategies with insufficient data
      if (insufficient.length > 0) {
        const perStrategy = explorationBudget / insufficient.length;
        for (const s of insufficient) newAllocation.set(s.name, perStrategy);
      }

      // Final normalization to ensure sum = 1.0 exactly
      // If bounds are infeasible (e.g., all at maxW but sum < 1.0),
      // distribute remainder proportionally while respecting bounds where possible
      let totalWeight = Array.from(newAllocation.values()).reduce((a, b) => a + b, 0);
      if (totalWeight > 0 && Math.abs(totalWeight - 1.0) > 1e-9) {
        const deficit = 1.0 - totalWeight;
        // Try to distribute deficit proportionally
        const entries = Array.from(newAllocation.entries());
        const weights = entries.map(([k, v]) => ({ name: k, weight: v }));
        
        // Iteratively adjust while respecting bounds
        for (let iter = 0; iter < 10; iter++) {
          const currentSum = weights.reduce((s, w) => s + w.weight, 0);
          if (Math.abs(currentSum - 1.0) < 1e-9) break;
          
          const gap = 1.0 - currentSum;
          const adjustable = weights.filter(w => 
            (gap > 0 && w.weight < maxW) || (gap < 0 && w.weight > minW)
          );
          
          if (adjustable.length === 0) {
            // All at bounds — distribute equally ignoring bounds
            const perItem = gap / weights.length;
            for (const w of weights) w.weight += perItem;
            break;
          }
          
          const perItem = gap / adjustable.length;
          for (const w of adjustable) {
            const newW = w.weight + perItem;
            w.weight = Math.max(minW, Math.min(maxW, newW));
          }
        }
        
        for (const w of weights) newAllocation.set(w.name, w.weight);
      }
    }

    // Build change list + propose to shadow mode
    const changes = [];
    for (const [name, newWeight] of newAllocation) {
      const oldWeight = allocation.get(name) || 0;
      const changePct = oldWeight > 0
        ? ((newWeight - oldWeight) / oldWeight) * 100
        : (newWeight > 0 ? 100 : 0);
      if (Math.abs(changePct) >= cfg.rebalanceChangeThresholdPct) {
        changes.push({
          name, oldWeight, newWeight,
          changePct: Number(changePct.toFixed(2)),
        });
        if (shadowMode) {
          shadowMode.propose(
            "STRATEGY_WEIGHT_" + name.toUpperCase(),
            oldWeight, newWeight,
            { reason: "orchestrator_rebalance", baselineWinRate: null }
          );
        }
      }
      allocation.set(name, newWeight);
    }

    // Remove any strategies no longer present
    for (const k of Array.from(allocation.keys())) {
      if (!newAllocation.has(k)) allocation.delete(k);
    }

    lastRebalance = new Date(now()).toISOString();
    history.push({
      ts: lastRebalance, changes,
      totalStrategies: stats.length,
      finiteCount: finiteScores.length,
      insufficientCount: insufficient.length,
    });
    onRebalance({ changes, allocation: getAllocation() });
    return { ok: true, changes, allocation: getAllocation() };
  }

  function getAllocation() {
    const obj = {};
    for (const [name, weight] of allocation) {
      obj[name] = Number(weight.toFixed(4));
    }
    return obj;
  }

  function getWeight(strategyName) {
    return allocation.get(strategyName) || 0;
  }

  /**
   * [Phase R-5] Force-set a strategy's allocation weight.
   * Caller is responsible for re-normalizing if sum drifts from 1.0.
   * Returns { ok, strategy, prev, next } or { ok: false, reason }.
   */
  function setWeight(strategyName, weight) {
    if (!allocation.has(strategyName)) {
      return { ok: false, reason: "strategy not registered: " + strategyName };
    }
    if (typeof weight !== "number" || weight < 0 || weight > 1) {
      return { ok: false, reason: "weight must be number in [0,1]" };
    }
    var prev = allocation.get(strategyName);
    allocation.set(strategyName, weight);
    history.push({
      ts: new Date(now()).toISOString(),
      type: "manual_setWeight",
      changes: [{ name: strategyName, oldWeight: prev, newWeight: weight }],
      allocation: getAllocation(),
    });
    return { ok: true, strategy: strategyName, prev: prev, next: weight };
  }

  /**
   * [Phase R-5] Renormalize current allocation so it sums to 1.0
   * without changing relative proportions.
   */
  function normalizeAllocation() {
    var entries = Array.from(allocation.entries());
    var sum = entries.reduce(function(s, e) { return s + e[1]; }, 0);
    if (sum <= 0 || entries.length === 0) return { ok: false, reason: "no allocation" };
    if (Math.abs(sum - 1.0) < 1e-6) return { ok: true, sum: sum, changed: false };
    for (var i = 0; i < entries.length; i++) {
      allocation.set(entries[i][0], entries[i][1] / sum);
    }
    return { ok: true, prevSum: sum, newSum: 1.0, changed: true, allocation: getAllocation() };
  }

  /**
   * Generate a consensus signal weighted by current allocation.
   * Each strategy's score is multiplied by its allocation weight.
   * Risk exits always take priority regardless of weight.
   */
  function generateWeightedSignal(ctx, position, params = {}) {
    if (!registry) {
      return { action: "HOLD", score: 0, reasons: ["no registry"], strategy: null, sources: [] };
    }
    const signals = registry.generateAll(ctx, position, params);
    if (signals.length === 0) {
      return { action: "HOLD", score: 0, reasons: ["no signals"], strategy: null, sources: [] };
    }

    // Risk exits bypass weighting — safety first
    const riskExit = signals.find(s => s.strategy === "risk_exit" && s.action === "SELL");
    if (riskExit) {
      return {
        action: "SELL", score: riskExit.score,
        reasons: riskExit.reasons, strategy: "risk_exit",
        sources: signals.map(s => s.name),
      };
    }

    let buyScore = 0, sellScore = 0;
    const buyReasons = [], sellReasons = [];
    const sources = [];

    for (const s of signals) {
      sources.push(s.name);
      const weight = getWeight(s.name) || 0;
      const weighted = s.score * weight;
      if (s.action === "BUY") {
        buyScore += weighted;
        buyReasons.push(`[${s.name} w=${(weight * 100).toFixed(1)}% score=${weighted.toFixed(2)}] ${s.reasons.join(", ")}`);
      } else if (s.action === "SELL") {
        sellScore += weighted;
        sellReasons.push(`[${s.name} w=${(weight * 100).toFixed(1)}% score=${weighted.toFixed(2)}] ${s.reasons.join(", ")}`);
      }
    }

    const minWeightedScore = params.minWeightedScore || 0.5;
    if (sellScore > buyScore && sellScore >= minWeightedScore) {
      return {
        action: "SELL", score: Number(sellScore.toFixed(3)),
        reasons: sellReasons, strategy: "orchestrator", sources,
      };
    }
    if (buyScore > sellScore && buyScore >= minWeightedScore) {
      return {
        action: "BUY", score: Number(buyScore.toFixed(3)),
        reasons: buyReasons, strategy: "orchestrator", sources,
      };
    }
    return {
      action: "HOLD", score: Number(Math.max(buyScore, sellScore).toFixed(3)),
      reasons: [...buyReasons, ...sellReasons], strategy: "orchestrator", sources,
    };
  }

  function stats() {
    const alloc = getAllocation();
    const sum = Object.values(alloc).reduce((a, b) => a + b, 0);
    return {
      totalStrategies: strategyStats.size,
      allocation: alloc,
      allocationSum: Number(sum.toFixed(4)),
      lastRebalance,
      totalRebalances: history.length,
    };
  }

  function getHistory() { return history.slice(); }

  function clear() {
    strategyStats.clear();
    allocation.clear();
    history.length = 0;
    lastRebalance = null;
  }

  return {
    registerStrategy, unregisterStrategy, recordFill,
    getStrategyStats, getAllStats, computePerformanceScore,
    rebalance, getAllocation, getWeight, setWeight, normalizeAllocation,
    generateWeightedSignal, stats, getHistory, clear,
  };
}

module.exports = { createStrategyOrchestrator, DEFAULT_CONFIG };

