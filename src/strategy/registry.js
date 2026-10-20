"use strict";

/**
 * Strategy Plugin Registry — allows registering multiple strategy modules
 * that produce signals independently. The planner/runner can query all
 * registered strategies and combine their outputs.
 *
 * Each strategy plugin must export:
 *   - name: string (unique identifier)
 *   - generateSignal(ctx, position, params): { action, score, reasons, strategy }
 *   - [optional] metadata: { description, version, markets }
 *
 * Usage:
 *   const { createStrategyRegistry } = require("./registry");
 *   const registry = createStrategyRegistry();
 *   registry.register(require("./signals"));
 *   registry.register({ name: "breakout", generateSignal: breakoutFn });
 *   const signals = registry.generateAll(ctx, position);
 */

function createStrategyRegistry(options = {}) {
  const strategies = new Map();
  const { minScoreOverride = null, weights = {} } = options;

  /**
   * Register a strategy plugin.
   * @param {object} plugin - { name, generateSignal, metadata? }
   */
  function register(plugin) {
    if (!plugin || !plugin.name || typeof plugin.generateSignal !== "function") {
      throw new Error("Strategy plugin must have 'name' and 'generateSignal(ctx, position)'");
    }
    if (strategies.has(plugin.name)) {
      throw new Error(`Strategy '${plugin.name}' already registered`);
    }
    strategies.set(plugin.name, {
      name: plugin.name,
      generateSignal: plugin.generateSignal,
      metadata: plugin.metadata || {},
      enabled: plugin.enabled !== false,
    });
    return true;
  }

  function unregister(name) {
    return strategies.delete(name);
  }

  function enable(name) {
    const s = strategies.get(name);
    if (s) { s.enabled = true; return true; }
    return false;
  }

  function disable(name) {
    const s = strategies.get(name);
    if (s) { s.enabled = false; return true; }
    return false;
  }

  function list() {
    return [...strategies.values()].map(s => ({
      name: s.name,
      enabled: s.enabled,
      metadata: s.metadata,
    }));
  }

  /**
   * Generate signals from all enabled strategies.
   * @param {object} ctx - technical context
   * @param {object|null} position - current position
   * @param {object} [params] - parameter overrides passed to each strategy
   * @returns {Array<{ name, action, score, reasons, strategy, weightedScore }>}
   */
  function generateAll(ctx, position, params = {}) {
    const results = [];
    for (const [, s] of strategies) {
      if (!s.enabled) continue;
      try {
        const signal = s.generateSignal(ctx, position, params);
        if (signal && signal.action) {
          const weight = weights[s.name] || 1.0;
          results.push({
            name: s.name,
            action: signal.action,
            score: signal.score || 0,
            reasons: signal.reasons || [],
            strategy: signal.strategy || s.name,
            weightedScore: (signal.score || 0) * weight,
          });
        }
      } catch (e) {
        results.push({
          name: s.name,
          action: "ERROR",
          score: 0,
          reasons: ["strategy error: " + e.message],
          strategy: s.name,
          weightedScore: 0,
        });
      }
    }
    return results;
  }

  /**
   * Combine signals from all strategies into a consensus decision.
   * Uses weighted voting: BUY/SELL need weighted score sum > threshold.
   * @param {object} ctx
   * @param {object|null} position
   * @param {object} [params] - { consensusThreshold = 2 }
   * @returns {{ action, score, reasons, strategy, sources }}
   */
  function consensus(ctx, position, params = {}) {
    const threshold = params.consensusThreshold || 2;
    const signals = generateAll(ctx, position, params);
    if (signals.length === 0) {
      return { action: "HOLD", score: 0, reasons: ["no strategies registered"], strategy: null, sources: [] };
    }

    let buyScore = 0, sellScore = 0;
    const buyReasons = [], sellReasons = [], sources = [];

    for (const s of signals) {
      sources.push(s.name);
      if (s.action === "BUY") {
        buyScore += s.weightedScore;
        buyReasons.push(...s.reasons.map(r => `[${s.name}] ${r}`));
      } else if (s.action === "SELL") {
        sellScore += s.weightedScore;
        sellReasons.push(...s.reasons.map(r => `[${s.name}] ${r}`));
      }
    }

    // Risk exits always take priority
    const riskExit = signals.find(s => s.strategy === "risk_exit" && s.action === "SELL");
    if (riskExit) {
      return {
        action: "SELL", score: riskExit.score,
        reasons: riskExit.reasons, strategy: "risk_exit", sources,
      };
    }

    if (sellScore >= threshold && sellScore > buyScore) {
      return { action: "SELL", score: sellScore, reasons: sellReasons, strategy: "consensus", sources };
    }
    if (buyScore >= threshold && buyScore > sellScore) {
      return { action: "BUY", score: buyScore, reasons: buyReasons, strategy: "consensus", sources };
    }
    return { action: "HOLD", score: Math.max(buyScore, sellScore), reasons: [...buyReasons, ...sellReasons], strategy: null, sources };
  }

  return { register, unregister, enable, disable, list, generateAll, consensus };
}

module.exports = { createStrategyRegistry };
