"use strict";

/**
 * Param Tuner — Phase R-5.
 * Applies confirmed-hypothesis-driven runtime parameter overrides to
 * selfHealer, strategyOrchestrator, reflection intervals, and confidence
 * calibrator. All changes are bounded by safe ranges and auditable.
 *
 * Usage:
 *   const { createParamTuner } = require("./src/intelligence/param-tuner");
 *   const tuner = createParamTuner({ selfHealer, strategyOrchestrator });
 *   tuner.apply({ kind: "selfhealer_cooldown", incidentType: "DATA_DRIFT", multiplier: 2.0 });
 *   tuner.apply({ kind: "selfhealer_escalation", value: 5 });
 *   tuner.apply({ kind: "strategy_weight", strategy: "base_signals", weight: 0.6 });
 */

var DEFAULTS = Object.freeze({
  maxHistory: Number(process.env.PARAM_TUNER_MAX_HISTORY || 500),
  dryRun: process.env.PARAM_TUNER_DRY_RUN === "true",
  cooldownMultiplierMax: 10.0,
  cooldownMultiplierMin: 0.1,
  escalationMin: 1,
  escalationMax: 20,
  weightMin: 0.05,
  weightMax: 0.95,
});

function createParamTuner(options) {
  var cfg = Object.assign({}, DEFAULTS, options || {});
  var selfHealer = cfg.selfHealer || null;
  var strategyOrchestrator = cfg.strategyOrchestrator || null;

  var history = [];
  var activeOverrides = new Map();
  var counters = { applied: 0, rejected: 0, rolled: 0 };

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function record(entry) {
    history.push(entry);
    if (history.length > cfg.maxHistory) history.shift();
  }

  function applySelfHealerCooldown(params) {
    if (!selfHealer) return { ok: false, reason: "selfHealer not wired" };
    if (typeof selfHealer.getCooldowns !== "function" || typeof selfHealer.setCooldown !== "function") {
      return { ok: false, reason: "selfHealer missing getCooldowns/setCooldown (R-5 API)" };
    }
    var it = params.incidentType;
    if (!it) return { ok: false, reason: "incidentType required" };
    var mult = typeof params.multiplier === "number" ? params.multiplier : 1.0;
    mult = clamp(mult, cfg.cooldownMultiplierMin, cfg.cooldownMultiplierMax);
    var cds = selfHealer.getCooldowns();
    if (!Object.prototype.hasOwnProperty.call(cds, it)) {
      return { ok: false, reason: "unknown incident type: " + it };
    }
    var prev = cds[it];
    var next = Math.max(1000, Math.round(prev * mult));
    if (!cfg.dryRun) selfHealer.setCooldown(it, next);
    record({ ts: new Date().toISOString(), kind: "selfhealer_cooldown", incidentType: it, prev: prev, next: next, multiplier: mult, dryRun: cfg.dryRun });
    return { ok: true, prev: prev, next: next, dryRun: cfg.dryRun };
  }

  function applySelfHealerEscalation(params) {
    if (!selfHealer) return { ok: false, reason: "selfHealer not wired" };
    if (typeof selfHealer.getConfig !== "function" || typeof selfHealer.setConfig !== "function") {
      return { ok: false, reason: "selfHealer missing getConfig/setConfig (R-5 API)" };
    }
    var v = typeof params.value === "number" ? params.value : null;
    if (v === null) return { ok: false, reason: "value required" };
    v = clamp(Math.round(v), cfg.escalationMin, cfg.escalationMax);
    var shCfg = selfHealer.getConfig();
    var prev = shCfg.escalationThreshold;
    if (!cfg.dryRun) selfHealer.setConfig("escalationThreshold", v);
    record({ ts: new Date().toISOString(), kind: "selfhealer_escalation", prev: prev, next: v, dryRun: cfg.dryRun });
    return { ok: true, prev: prev, next: v, dryRun: cfg.dryRun };
  }

  function applyStrategyWeight(params) {
    if (!strategyOrchestrator) return { ok: false, reason: "strategyOrchestrator not wired" };
    var strat = params.strategy;
    var w = params.weight;
    if (!strat) return { ok: false, reason: "strategy required" };
    if (typeof w !== "number") return { ok: false, reason: "weight required" };
    w = clamp(w, cfg.weightMin, cfg.weightMax);
    var prev = strategyOrchestrator.getWeight(strat) || 0;
    if (!cfg.dryRun) {
      var alloc = strategyOrchestrator.getAllocation();
      if (alloc && Object.prototype.hasOwnProperty.call(alloc, strat)) {
        if (typeof strategyOrchestrator.setWeight === "function") {
          strategyOrchestrator.setWeight(strat, w);
        } else {
          return { ok: false, reason: "no setWeight method; only rebalance() available" };
        }
      } else {
        return { ok: false, reason: "strategy not registered: " + strat };
      }
    }
    record({ ts: new Date().toISOString(), kind: "strategy_weight", strategy: strat, prev: prev, next: w, dryRun: cfg.dryRun });
    return { ok: true, prev: prev, next: w, dryRun: cfg.dryRun };
  }

  function applyCustom(params) {
    var key = params.key;
    var value = params.value;
    if (!key) return { ok: false, reason: "key required" };
    activeOverrides.set(key, { value: value, at: Date.now() });
    record({ ts: new Date().toISOString(), kind: "custom", key: key, value: value, dryRun: cfg.dryRun });
    return { ok: true, key: key, value: value, dryRun: cfg.dryRun };
  }

  function apply(params) {
    if (!params || !params.kind) {
      counters.rejected++;
      return { ok: false, reason: "kind required" };
    }
    var r;
    if (params.kind === "selfhealer_cooldown") r = applySelfHealerCooldown(params);
    else if (params.kind === "selfhealer_escalation") r = applySelfHealerEscalation(params);
    else if (params.kind === "strategy_weight") r = applyStrategyWeight(params);
    else if (params.kind === "custom") r = applyCustom(params);
    else r = { ok: false, reason: "unknown kind: " + params.kind };
    if (r.ok) counters.applied++;
    else counters.rejected++;
    return r;
  }

  function getOverride(key) { return activeOverrides.get(key) || null; }
  function getHistory(limit) { return history.slice(-(limit || 30)); }
  function stats() {
    return {
      applied: counters.applied, rejected: counters.rejected, rolled: counters.rolled,
      activeOverrides: activeOverrides.size, historySize: history.length, dryRun: cfg.dryRun,
    };
  }
  function clear() {
    history.length = 0; activeOverrides.clear();
    counters.applied = 0; counters.rejected = 0; counters.rolled = 0;
  }

  // [Phase R-6] Persistence restore
  function restoreHistory(saved) {
    if (!Array.isArray(saved)) return { ok: false, reason: "invalid history" };
    history.length = 0;
    for (var i = 0; i < saved.length && i < cfg.maxHistory; i++) history.push(saved[i]);
    return { ok: true, restored: history.length };
  }

  return {
    apply: apply, getOverride: getOverride, getHistory: getHistory, stats: stats, clear: clear,
    restoreHistory: restoreHistory,
    _cfg: cfg,
  };
}

module.exports = { createParamTuner, DEFAULTS };
