"use strict";

/**
 * Outcome Feedback — Phase R-4.
 * Closes the R-3 loop: periodically scans evaluated experiments
 * and propagates verdicts back to hypothesis engine via trackOutcome().
 *
 * Flow:
 *   experiment.evaluate() → verdict (treatment_better / control_better / no_significant_difference)
 *       ↓ outcomeFeedback.tick()
 *   hypothesis.trackOutcome({ confirmed, verdict, lift, experimentId })
 *
 * Guarantees:
 *   - Idempotent: processed-set prevents double-tracking same experiment
 *   - Stateless-safe: rebuilds from experimentEngine.list() each tick
 *   - Bounded: processed-set capped at maxProcessed (FIFO eviction)
 *
 * Usage:
 *   const { createOutcomeFeedback } = require("./src/intelligence/outcome-feedback");
 *   const fb = createOutcomeFeedback({ experimentEngine, hypothesisEngine });
 *   fb.tick(); // call periodically (e.g. every 5 min)
 */

var DEFAULTS = Object.freeze({
  maxProcessed: Number(process.env.OUTCOME_FEEDBACK_MAX || 1000),
});

function verdictToConfirmed(verdict) {
  if (verdict === "treatment_better") return true;
  if (verdict === "control_better") return false;
  if (verdict === "no_significant_difference") return false;
  return false;
}

function createOutcomeFeedback(options) {
  var cfg = Object.assign({}, DEFAULTS, options || {});
  var experimentEngine = cfg.experimentEngine || null;
  var hypothesisEngine = cfg.hypothesisEngine || null;

  var processed = new Set();
  var history = [];
  var counters = { ticks: 0, processed: 0, confirmed: 0, rejected: 0, skipped: 0, errors: 0 };

  function tick() {
    counters.ticks++;
    var result = { ts: new Date().toISOString(), processed: [], skipped: [] };
    if (!experimentEngine) { result.error = "no experimentEngine"; return result; }
    if (!hypothesisEngine) { result.error = "no hypothesisEngine"; return result; }

    var evaluated = typeof experimentEngine.list === "function" ? experimentEngine.list("evaluated") : [];
    for (var i = 0; i < evaluated.length; i++) {
      var exp = evaluated[i];
      if (!exp || !exp.id) continue;
      if (processed.has(exp.id)) {
        result.skipped.push({ id: exp.id, reason: "already_processed" });
        counters.skipped++;
        continue;
      }

      var full = typeof experimentEngine.getExperiment === "function" ? experimentEngine.getExperiment(exp.id) : null;
      if (!full || !full.evaluation) {
        result.skipped.push({ id: exp.id, reason: "no_evaluation" });
        counters.skipped++;
        continue;
      }

      var hypId = full.hypothesisId;
      if (!hypId) {
        processed.add(exp.id);
        result.skipped.push({ id: exp.id, reason: "no_hypothesisId" });
        counters.skipped++;
        continue;
      }

      var verdict = full.evaluation.verdict;
      var lift = typeof full.evaluation.lift === "number" ? full.evaluation.lift : 0;
      var confirmed = verdictToConfirmed(verdict);

      try {
        var trackResult = hypothesisEngine.trackOutcome(hypId, {
          confirmed: confirmed,
          verdict: verdict,
          lift: lift,
          experimentId: exp.id,
          autoFeedback: true,
          at: new Date().toISOString(),
        });
        processed.add(exp.id);
        if (processed.size > cfg.maxProcessed) {
          var first = processed.values().next().value;
          processed.delete(first);
        }
        history.push({
          ts: new Date().toISOString(), expId: exp.id, hypId: hypId,
          verdict: verdict, confirmed: confirmed, lift: lift,
        });
        result.processed.push({
          expId: exp.id, hypId: hypId, verdict: verdict,
          confirmed: confirmed, lift: lift, trackResult: trackResult,
        });
        counters.processed++;
        if (confirmed) counters.confirmed++; else counters.rejected++;
      } catch (e) {
        counters.errors++;
        result.skipped.push({ id: exp.id, reason: "trackOutcome_failed: " + e.message });
      }
    }
    return result;
  }

  function getHistory(limit) { return history.slice(-(limit || 20)); }
  function getProcessed() { return Array.from(processed); }

  function stats() {
    return {
      ticks: counters.ticks, processed: counters.processed,
      confirmed: counters.confirmed, rejected: counters.rejected,
      skipped: counters.skipped, errors: counters.errors,
      processedSetSize: processed.size, historySize: history.length,
    };
  }

  function clear() {
    processed.clear(); history.length = 0;
    counters.ticks = 0; counters.processed = 0; counters.confirmed = 0;
    counters.rejected = 0; counters.skipped = 0; counters.errors = 0;
  }

  // [Phase R-6] Persistence restore
  function restoreProcessed(saved) {
    if (!Array.isArray(saved)) return { ok: false, reason: "invalid processed" };
    processed.clear();
    for (var i = 0; i < saved.length && i < cfg.maxProcessed; i++) processed.add(saved[i]);
    return { ok: true, restored: processed.size };
  }

  // [Phase R-6] Event listener support for knowledge-ranker wiring
  var listeners = {};
  function on(event, fn) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(fn);
  }
  function emit(event, payload) {
    var fns = listeners[event] || [];
    for (var i = 0; i < fns.length; i++) { try { fns[i](payload); } catch (e) { /* ignore */ } }
  }

  return {
    tick: tick, getHistory: getHistory, getProcessed: getProcessed,
    stats: stats, clear: clear,
    restoreProcessed: restoreProcessed,
    on: on, emit: emit,
    _verdictToConfirmed: verdictToConfirmed,
  };
}

module.exports = { createOutcomeFeedback, DEFAULTS };
