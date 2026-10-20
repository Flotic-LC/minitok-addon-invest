"use strict";

/**
 * Evolution Bridge — Phase R-6.
 * Bidirectional bridge between GA evolution (Phase H) and hypothesis engine (Phase R-2).
 *
 * Directions:
 *   1. GA → Hypothesis: superior genome → hypothesis for shadow-mode review
 *   2. Hypothesis → GA: confirmed outcomes → seed next GA population
 */

var DEFAULTS = Object.freeze({
  minFitnessDelta: Number(process.env.EVO_BRIDGE_MIN_FITNESS || 0.05),
  maxHypothesesFromGA: Number(process.env.EVO_BRIDGE_MAX_HYP || 3),
  cooldownMs: Number(process.env.EVO_BRIDGE_COOLDOWN_MS || 86400000),
  seedStrength: Number(process.env.EVO_BRIDGE_SEED_STRENGTH || 0.3),
});

function createEvolutionBridge(options) {
  var cfg = Object.assign({}, DEFAULTS, options || {});
  var evolution = cfg.evolution || null;
  var hypothesisEngine = cfg.hypothesisEngine || null;
  var shadowMode = cfg.shadowMode || null;
  var notify = cfg.notify || function() {};

  var history = [], gaSeeds = [];
  var lastSyncAt = { fromGA: 0, toGA: 0 };
  var counters = { syncsFromGA: 0, syncsToGA: 0, hypothesesCreated: 0, seedsInjected: 0 };
  var lastBestGenome = null;

  function record(e) { history.push(e); if (history.length > 200) history.shift(); }
  function canSyncFromGA() { return Date.now() - lastSyncAt.fromGA >= cfg.cooldownMs; }

  function pushHypothesis(hyp) {
    if (typeof hypothesisEngine.addHypothesis === "function") { hypothesisEngine.addHypothesis(hyp); return true; }
    if (hypothesisEngine._hypotheses && Array.isArray(hypothesisEngine._hypotheses)) { hypothesisEngine._hypotheses.push(hyp); return true; }
    return false;
  }

function syncFromEvolution() {
    counters.syncsFromGA++;
    if (!evolution || !hypothesisEngine) return { ok: false, reason: "missing_deps" };
    if (!canSyncFromGA()) return { ok: true, skipped: true, reason: "cooldown" };
    var result = null;
    if (typeof evolution.getLastResult === "function") result = evolution.getLastResult();
    if (!result && evolution.lastRunResult) result = evolution.lastRunResult;
    if (!result || !result.bestGenome) return { ok: true, skipped: true, reason: "no_ga_result" };
    var best = result.bestGenome, fitness = result.bestFitness || 0;
    if (lastBestGenome && fitness <= (lastBestGenome.fitness || 0) + cfg.minFitnessDelta) return { ok: true, skipped: true, reason: "no_improvement" };
    lastBestGenome = { genome: best, fitness: fitness, at: new Date().toISOString() };
    var created = [], keys = Object.keys(best).slice(0, cfg.maxHypothesesFromGA);
    for (var i = 0; i < keys.length; i++) {
      var param = keys[i], value = best[param];
      if (typeof value !== "number") continue;
      var id = "hyp_r6evo_" + Date.now().toString(36) + "_" + param;
      var hyp = { id: id, type: "ga_optimization", source: "evolution_bridge",
        statement: "GA optimized " + param + "=" + value.toFixed(4), action: "Apply " + param + "=" + value.toFixed(4),
        confidence: Math.min(0.9, 0.5 + fitness * 0.5), expectedImpact: "high",
        createdAt: new Date().toISOString(), status: "pending",
        gaParam: param, gaValue: value, gaFitness: fitness,
      };
      if (!pushHypothesis(hyp)) continue;
      if (shadowMode && typeof shadowMode.propose === "function") {
        var prop = shadowMode.propose(param, 0, value, { reason: "ga:fitness=" + fitness.toFixed(4) });
        hyp.shadowId = prop.ok ? prop.entry.id : null;
      }
      created.push(hyp); counters.hypothesesCreated++;
      record({ ts: hyp.createdAt, hypId: id, param: param, value: value, fitness: fitness });
    }
    lastSyncAt.fromGA = Date.now();
    if (created.length > 0) notify("[evolution-bridge] " + created.length + " hyps from GA (fit=" + fitness.toFixed(4) + ")");
    return { ok: true, hypotheses: created, fitness: fitness };
  }

  function syncToEvolution() {
    counters.syncsToGA++;
    if (!hypothesisEngine || !evolution) return { ok: false, reason: "missing_deps" };
    var outcomes = (typeof hypothesisEngine.getOutcomes === "function") ? hypothesisEngine.getOutcomes(50) : [];
    var hyps = (typeof hypothesisEngine.getHypotheses === "function") ? hypothesisEngine.getHypotheses(200) : [];
    var seeds = [];
    for (var i = 0; i < outcomes.length; i++) {
      var o = outcomes[i]; if (!o || !o.confirmed) continue;
      var hyp = null;
      for (var j = 0; j < hyps.length; j++) if (hyps[j].id === o.hypothesisId) { hyp = hyps[j]; break; }
      if (!hyp || hyp.source !== "evolution_bridge" || !hyp.gaParam) continue;
      seeds.push({ param: hyp.gaParam, value: hyp.gaValue, fitness: hyp.gaFitness });
      counters.seedsInjected++;
    }
    gaSeeds = seeds; lastSyncAt.toGA = Date.now();
    if (evolution && typeof evolution.injectSeeds === "function") evolution.injectSeeds(seeds, cfg.seedStrength);
    return { ok: true, seeds: seeds.length };
  }

  function getSeeds() { return gaSeeds.slice(); }
  function getHistory(limit) { return history.slice(-(limit || 20)); }
  function stats() {
    return { syncsFromGA: counters.syncsFromGA, syncsToGA: counters.syncsToGA,
      hypothesesCreated: counters.hypothesesCreated, seedsInjected: counters.seedsInjected,
      lastBestFitness: lastBestGenome ? lastBestGenome.fitness : null, gaSeeds: gaSeeds.length, historySize: history.length };
  }
  function clear() {
    history.length = 0; gaSeeds.length = 0; lastBestGenome = null;
    counters.syncsFromGA = 0; counters.syncsToGA = 0;
    counters.hypothesesCreated = 0; counters.seedsInjected = 0;
  }
  return { syncFromEvolution: syncFromEvolution, syncToEvolution: syncToEvolution,
    getSeeds: getSeeds, getHistory: getHistory, stats: stats, clear: clear, _cfg: cfg };
}
module.exports = { createEvolutionBridge, DEFAULTS };