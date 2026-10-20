"use strict";

/**
 * Hypothesis Engine — Phase R-2.
 * Generates testable improvement hypotheses from reflection + correlation findings.
 *
 * Capabilities:
 *   - generateHypotheses() — derive hypotheses from patterns, blind spots, correlations
 *   - evaluateCounterfactual(h) — "what if X had not happened?" PnL delta estimate
 *   - rankProposals() — rank by expected impact * confidence
 *   - trackOutcome(hypothesisId, actual) — record whether hypothesis was confirmed
 *
 * Usage:
 *   const { createHypothesisEngine } = require("./src/intelligence/hypothesis");
 *   const hyp = createHypothesisEngine({ eventBus, reflectionEngine, correlationEngine });
 *   const proposals = hyp.generateHypotheses();
 */

const DEFAULTS = Object.freeze({
  maxHypotheses: Number(process.env.HYPOTHESIS_MAX || 200),
  minConfidence: Number(process.env.HYPOTHESIS_MIN_CONF || 0.2),
  lookbackReports: Number(process.env.HYPOTHESIS_LOOKBACK || 5),
});

function createHypothesisEngine(options) {
  var cfg = Object.assign({}, DEFAULTS, options || {});
  var eventBus = cfg.eventBus;
  var reflection = cfg.reflectionEngine;
  var correlation = cfg.correlationEngine;
  if (!eventBus) throw new Error("eventBus is required");

  var hypotheses = [];
  var outcomes = [];
  var counters = { generated: 0, confirmed: 0, rejected: 0, pending: 0 };

  function makeId() {
    return "hyp_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
  }

  function generateHypotheses() {
    var generated = [];
    var now = new Date().toISOString();
    // 1. From reflection blind spots
    if (reflection && typeof reflection.detectBlindSpots === "function") {
      var bs = reflection.detectBlindSpots();
      for (var i = 0; i < bs.length; i++) {
        if (bs[i].count === 0) {
          generated.push({ id: makeId(), type: "blind_spot_fix", source: "reflection", statement: "Event type \"" + bs[i].eventType + "\" is never emitted. Wiring its source would improve observability.", action: "Add emitter for " + bs[i].eventType, confidence: 0.9, expectedImpact: "medium", createdAt: now, status: "pending" });
        }
      }
    }
    // 2. From reflection patterns
    if (reflection && typeof reflection.findPatterns === "function") {
      var pats = reflection.findPatterns();
      for (var j = 0; j < pats.length; j++) {
        var pat = pats[j];
        if (pat.type === "alert_clustering") {
          generated.push({ id: makeId(), type: "reduce_alert_noise", source: "reflection", statement: "Alert rule \"" + (pat.data && pat.data.topRules && pat.data.topRules[0] ? pat.data.topRules[0][0] : "unknown") + "\" fires excessively. Adjusting threshold or cooldown would reduce noise.", action: "Increase cooldown or threshold for top alert rule", confidence: pat.confidence || 0.5, expectedImpact: "low", createdAt: now, status: "pending" });
        }
        if (pat.type === "low_fill_rate") {
          generated.push({ id: makeId(), type: "improve_fill_rate", source: "reflection", statement: "Fill rate is " + (pat.data ? (pat.data.fillRate * 100).toFixed(1) : "?") + "%. Orders may be placed at non-competitive prices or during low liquidity.", action: "Review order pricing strategy and timing", confidence: pat.confidence || 0.6, expectedImpact: "high", createdAt: now, status: "pending" });
        }
      }
    }
    // 3. From correlation findings
    if (correlation && typeof correlation.getHistory === "function") {
      var corrHistory = correlation.getHistory(5);
      for (var k = 0; k < corrHistory.length; k++) {
        var c = corrHistory[k];
        if (c.type === "incident_pnl" && c.significant && c.r < -0.3) {
          generated.push({ id: makeId(), type: "incident_loss_mitigation", source: "correlation", statement: "Incidents correlate negatively with PnL (r=" + c.r + ", lag=" + (c.lagHours || 0) + "h). Reducing incident frequency would improve PnL.", action: "Investigate top incident causes and add preventive measures", confidence: Math.min(0.95, Math.abs(c.r)), expectedImpact: "high", createdAt: now, status: "pending" });
        }
        if (c.type === "incident_pnl" && c.significant && c.r > 0.3) {
          generated.push({ id: makeId(), type: "data_quality_check", source: "correlation", statement: "Incidents correlate POSITIVELY with PnL (r=" + c.r + "). Unexpected — possible mislabelling or PnL attribution error.", action: "Audit incident classifier and PnL attribution pipeline", confidence: 0.7, expectedImpact: "medium", createdAt: now, status: "pending" });
        }
      }
    }
    // Store
    for (var m = 0; m < generated.length; m++) {
      hypotheses.push(generated[m]);
      counters.generated++;
      counters.pending++;
    }
    if (hypotheses.length > cfg.maxHypotheses) {
      hypotheses.splice(0, hypotheses.length - cfg.maxHypotheses);
    }
    return generated;
  }

  function evaluateCounterfactual(hypothesisId) {
    var h = null;
    for (var i = 0; i < hypotheses.length; i++) {
      if (hypotheses[i].id === hypothesisId) { h = hypotheses[i]; break; }
    }
    if (!h) return { error: "hypothesis not found: " + hypothesisId };
    var estimate = { hypothesisId: hypothesisId, type: h.type, estimatedPnlDelta: 0, method: "heuristic" };
    if (h.type === "incident_loss_mitigation") {
      var corrResult = null;
      if (correlation && typeof correlation.correlateIncidentsWithPnL === "function") {
        corrResult = correlation.correlateIncidentsWithPnL({});
      }
      if (corrResult && corrResult.r !== null) {
        estimate.estimatedPnlDelta = Math.abs(corrResult.r) * 100;
        estimate.method = "correlation_based";
      }
    } else if (h.type === "improve_fill_rate") {
      estimate.estimatedPnlDelta = 25; estimate.method = "fill_rate_heuristic";
    } else if (h.type === "reduce_alert_noise") {
      estimate.estimatedPnlDelta = 5; estimate.method = "noise_reduction_heuristic";
    } else if (h.type === "data_quality_check") {
      estimate.estimatedPnlDelta = 10; estimate.method = "data_quality_heuristic";
    }
    estimate.estimatedPnlDeltaPct = Number(estimate.estimatedPnlDelta.toFixed(1));
    return estimate;
  }

  function rankProposals() {
    var scored = [];
    for (var i = 0; i < hypotheses.length; i++) {
      var h = hypotheses[i];
      if (h.status !== "pending") continue;
      var cf = evaluateCounterfactual(h.id);
      var impactNum = h.expectedImpact === "high" ? 3 : h.expectedImpact === "medium" ? 2 : 1;
      var score = (h.confidence || 0.5) * impactNum * (1 + (cf.estimatedPnlDelta || 0) / 100);
      scored.push({ id: h.id, type: h.type, statement: h.statement, action: h.action, confidence: h.confidence, expectedImpact: h.expectedImpact, estimatedPnlDeltaPct: cf.estimatedPnlDeltaPct || 0, score: Number(score.toFixed(3)) });
    }
    scored.sort(function(a, b) { return b.score - a.score; });
    return scored;
  }

  function trackOutcome(hypothesisId, actual) {
    var h = null;
    for (var i = 0; i < hypotheses.length; i++) {
      if (hypotheses[i].id === hypothesisId) { h = hypotheses[i]; break; }
    }
    if (!h) return { error: "hypothesis not found" };
    var confirmed = actual.confirmed === true;
    h.status = confirmed ? "confirmed" : "rejected";
    h.resolvedAt = new Date().toISOString();
    h.actual = actual;
    if (confirmed) { counters.confirmed++; } else { counters.rejected++; }
    counters.pending = Math.max(0, counters.pending - 1);
    outcomes.push({ hypothesisId: hypothesisId, confirmed: confirmed, actual: actual, resolvedAt: h.resolvedAt });
    return { hypothesisId: hypothesisId, status: h.status, confirmed: confirmed };
  }

  function getHypotheses(limit) { return hypotheses.slice(-(limit || 20)); }
  function getOutcomes(limit) { return outcomes.slice(-(limit || 10)); }

  function stats() {
    return { totalHypotheses: hypotheses.length, generated: counters.generated, confirmed: counters.confirmed, rejected: counters.rejected, pending: counters.pending, totalOutcomes: outcomes.length };
  }

  function clear() {
    hypotheses.length = 0; outcomes.length = 0;
    counters.generated = 0; counters.confirmed = 0; counters.rejected = 0; counters.pending = 0;
  }

  // [Phase R-6] External injection of hypotheses (e.g. from regime-advisor, evolution-bridge)
  function addHypothesis(hyp) {
    if (!hyp || !hyp.id) return { ok: false, reason: "invalid hypothesis" };
    for (var i = 0; i < hypotheses.length; i++) {
      if (hypotheses[i].id === hyp.id) return { ok: false, reason: "duplicate" };
    }
    hypotheses.push(hyp);
    if (hyp.status === "pending") counters.pending++;
    else if (hyp.status === "confirmed") counters.confirmed++;
    else if (hyp.status === "rejected") counters.rejected++;
    counters.generated++;
    if (hypotheses.length > cfg.maxHypotheses) hypotheses.shift();
    return { ok: true, id: hyp.id };
  }

  // [Phase R-6] Persistence restore
  function restoreState(savedHypotheses, savedOutcomes) {
    var restored = { hypotheses: 0, outcomes: 0 };
    if (Array.isArray(savedHypotheses)) {
      for (var i = 0; i < savedHypotheses.length; i++) {
        var r = addHypothesis(savedHypotheses[i]);
        if (r.ok) restored.hypotheses++;
      }
    }
    if (Array.isArray(savedOutcomes)) {
      for (var j = 0; j < savedOutcomes.length; j++) {
        outcomes.push(savedOutcomes[j]);
        restored.outcomes++;
      }
      if (outcomes.length > 500) outcomes.splice(0, outcomes.length - 500);
    }
    return restored;
  }

  return {
    generateHypotheses: generateHypotheses,
    evaluateCounterfactual: evaluateCounterfactual,
    rankProposals: rankProposals,
    trackOutcome: trackOutcome,
    getHypotheses: getHypotheses,
    getOutcomes: getOutcomes,
    addHypothesis: addHypothesis,
    restoreState: restoreState,
    stats: stats,
    clear: clear,
    _hypotheses: hypotheses,
  };
}

module.exports = { createHypothesisEngine, DEFAULTS };
