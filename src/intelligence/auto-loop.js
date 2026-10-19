"use strict";

/**
 * Auto-Loop — Phase R-3.
 * Closes the improvement cycle by converting top-ranked hypotheses
 * into concrete actions (experiments or self-healer rules) and
 * recording outcomes back for hypothesis tracking.
 *
 * Usage:
 *   const { createAutoLoop } = require("./src/intelligence/auto-loop");
 *   const loop = createAutoLoop({ selfHealer, experimentEngine, hypothesisEngine, attributionEngine });
 *   loop.registerAction("increase_cooldown", function(hyp) { selfHealer.addCooldown(...); });
 *   const result = loop.evaluate();
 */

var DEFAULTS = Object.freeze({
  minScore: Number(process.env.AUTO_LOOP_MIN_SCORE || 1.5),
  maxActionsPerCycle: Number(process.env.AUTO_LOOP_MAX_ACTIONS || 2),
  cooldownMs: Number(process.env.AUTO_LOOP_COOLDOWN_MS || 3600000),
  dryRun: process.env.AUTO_LOOP_DRY_RUN === "true",
  maxHistory: Number(process.env.AUTO_LOOP_MAX_HISTORY || 1000),
});

function createAutoLoop(options) {
  var cfg = Object.assign({}, DEFAULTS, options || {});
  var selfHealer = cfg.selfHealer || null;
  var experimentEngine = cfg.experimentEngine || null;
  var hypothesisEngine = cfg.hypothesisEngine || null;
  var attributionEngine = cfg.attributionEngine || null;

  var actionRegistry = new Map();
  var history = [];
  var lastActAt = new Map(); // per-hypothesis cooldown
  var counters = { cycles: 0, actionsTaken: 0, actionsSkipped: 0, experimentsLaunched: 0 };

  function registerAction(type, fn, meta) {
    if (!type || typeof fn !== "function") throw new Error("registerAction requires type + fn");
    actionRegistry.set(type, { fn: fn, meta: meta || {} });
  }

  function evaluate() {
    counters.cycles++;
    var result = { ts: new Date().toISOString(), actions: [], skipped: [] };
    if (!hypothesisEngine) { result.error = "no hypothesisEngine"; return result; }
    var ranked = hypothesisEngine.rankProposals();
    var taken = 0;
    // Evict cooldown entries for hypotheses no longer ranked
    var _rankedIds = new Set(ranked.map(function(h) { return h.id; }));
    for (var _k of lastActAt.keys()) {
      if (!_rankedIds.has(_k)) lastActAt.delete(_k);
    }

    for (var i = 0; i < ranked.length && taken < cfg.maxActionsPerCycle; i++) {
      var hyp = ranked[i];
      if (hyp.score < cfg.minScore) break;
      // Cooldown check
      var lastAt = lastActAt.get(hyp.id) || 0;
      if (Date.now() - lastAt < cfg.cooldownMs) {
        result.skipped.push({ id: hyp.id, type: hyp.type, reason: "cooldown" });
        counters.actionsSkipped++;
        continue;
      }
      var acted = false;
      // 1) Registered action?
      var reg = actionRegistry.get(hyp.type);
      if (reg) {
        if (!cfg.dryRun) {
          try { reg.fn(hyp); acted = true; } catch (e) { result.skipped.push({ id: hyp.id, reason: "action_failed: " + e.message }); }
        } else { acted = true; }
      }
      // 2) Otherwise, launch an experiment for types we can A/B test
      if (!acted && experimentEngine && (hyp.type === "improve_fill_rate" || hyp.type === "incident_loss_mitigation")) {
        if (!cfg.dryRun) {
          var expId = experimentEngine.createExperiment({
            hypothesisId: hyp.id, name: "auto-" + hyp.type + "-" + hyp.id.slice(4, 10),
            description: hyp.statement,
          });
          result.actions.push({ id: hyp.id, type: hyp.type, action: "launched_experiment", experimentId: expId, score: hyp.score });
          counters.experimentsLaunched++;
        }
        acted = true;
      }
      // 3) Self-healer generic tick injection as last resort
      if (!acted && selfHealer && typeof selfHealer.tick === "function") {
        if (!cfg.dryRun) {
          try { selfHealer.tick({ reflectionHypothesis: hyp.id, reflectionHypothesisType: hyp.type }); acted = true; } catch {}
        } else { acted = true; }
      }
      if (acted) {
        if (reg || !experimentEngine) {
          result.actions.push({ id: hyp.id, type: hyp.type, action: reg ? "registered" : "selfHealer_tick", score: hyp.score });
        }
        lastActAt.set(hyp.id, Date.now());
        if (hypothesisEngine && typeof hypothesisEngine.trackOutcome === "function") {
          hypothesisEngine.trackOutcome(hyp.id, { confirmed: null, autoLooped: true, at: new Date().toISOString() });
        }
        counters.actionsTaken++;
        taken++;
        history.push({ ts: new Date().toISOString(), hypId: hyp.id, hypType: hyp.type, score: hyp.score });
        if (history.length > cfg.maxHistory) history.splice(0, history.length - cfg.maxHistory);
      }
    }
    return result;
  }

  function getHistory(limit) { return history.slice(-(limit || 20)); }

  function stats() {
    return {
      cycles: counters.cycles, actionsTaken: counters.actionsTaken,
      actionsSkipped: counters.actionsSkipped, experimentsLaunched: counters.experimentsLaunched,
      registeredActions: actionRegistry.size, historySize: history.length,
      config: { minScore: cfg.minScore, maxActionsPerCycle: cfg.maxActionsPerCycle, cooldownMs: cfg.cooldownMs, dryRun: cfg.dryRun },
    };
  }

  function clear() {
    history.length = 0; lastActAt.clear();
    counters.cycles = 0; counters.actionsTaken = 0; counters.actionsSkipped = 0; counters.experimentsLaunched = 0;
  }

  // [Phase R-6] Persistence restore
  function restoreHistory(saved) {
    if (!Array.isArray(saved)) return { ok: false, reason: "invalid history" };
    history.length = 0;
    var start = Math.max(0, saved.length - cfg.maxHistory);
    for (var i = start; i < saved.length; i++) history.push(saved[i]);
    return { ok: true, restored: history.length };
  }

  return {
    registerAction: registerAction, evaluate: evaluate,
    getHistory: getHistory, stats: stats, clear: clear,
    restoreHistory: restoreHistory,
  };
}

module.exports = { createAutoLoop, DEFAULTS };
