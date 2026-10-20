"use strict";

/**
 * Blind-Spot Bridge — Phase R-6.
 * Converts reflection engine blind spots into actionable hypotheses.
 * When reflectionEngine.generateReport() returns blind spots, this
 * module auto-generates hypotheses to address them.
 */

var DEFAULTS = Object.freeze({
  cooldownMs: Number(process.env.BS_COOLDOWN_MS || 7200000),
  maxPerCycle: Number(process.env.BS_MAX_PER_CYCLE || 3),
  minConfidence: Number(process.env.BS_MIN_CONFIDENCE || 0.5),
});

function createBlindSpotBridge(options) {
  var cfg = Object.assign({}, DEFAULTS, options || {});
  var reflectionEngine = cfg.reflectionEngine || null;
  var hypothesisEngine = cfg.hypothesisEngine || null;
  var notify = cfg.notify || function() {};

  var history = [];
  var lastGenAt = 0;
  var counters = { cycles: 0, hypothesesGenerated: 0, skipped: 0 };

  function record(e) { history.push(e); if (history.length > 200) history.shift(); }
  function canGenerate() { return Date.now() - lastGenAt >= cfg.cooldownMs; }

  function pushHypothesis(hyp) {
    if (typeof hypothesisEngine.addHypothesis === "function") { hypothesisEngine.addHypothesis(hyp); return true; }
    if (hypothesisEngine._hypotheses && Array.isArray(hypothesisEngine._hypotheses)) { hypothesisEngine._hypotheses.push(hyp); return true; }
    return false;
  }

  function tick() {
    counters.cycles++;
    if (!reflectionEngine || !hypothesisEngine) return { ok: false, reason: "missing_deps" };
    if (!canGenerate()) { counters.skipped++; return { ok: true, skipped: true, reason: "cooldown" }; }

    var report = null;
    try { report = reflectionEngine.generateReport(); } catch (e) { return { ok: false, reason: "report_error: " + e.message }; }
    if (!report || !report.blindSpots || report.blindSpots.length === 0) {
      return { ok: true, skipped: true, reason: "no_blind_spots" };
    }

    var generated = [];
    var spots = report.blindSpots.slice(0, cfg.maxPerCycle);
    for (var i = 0; i < spots.length; i++) {
      var bs = spots[i];
      var id = "hyp_r6bs_" + Date.now().toString(36) + "_" + i;
      var statement = "Blind spot detected: " + (bs.description || bs.type || "unknown") +
        " (severity=" + (bs.severity || "medium") + ")";
      var action = "Investigate and mitigate: " + (bs.recommendation || "review system behavior");
      var confidence = Math.min(0.9, cfg.minConfidence + (bs.severity === "high" ? 0.2 : 0));

      var hyp = {
        id: id, type: "blind_spot_mitigation", source: "blindspot_bridge",
        statement: statement, action: action,
        confidence: confidence, expectedImpact: bs.severity === "high" ? "high" : "medium",
        createdAt: new Date().toISOString(), status: "pending",
        blindSpotType: bs.type || null, blindSpotSeverity: bs.severity || "medium",
      };
      if (pushHypothesis(hyp)) {
        generated.push(hyp);
        counters.hypothesesGenerated++;
        record({ ts: hyp.createdAt, hypId: id, blindSpot: bs.type || bs.description });
      }
    }

    if (generated.length > 0) {
      lastGenAt = Date.now();
      notify("[blindspot-bridge] Generated " + generated.length + " hypotheses from " + report.blindSpots.length + " blind spots");
    }
    return { ok: true, hypotheses: generated, blindSpotsTotal: report.blindSpots.length };
  }

  function getHistory(limit) { return history.slice(-(limit || 20)); }
  function stats() {
    return { cycles: counters.cycles, hypothesesGenerated: counters.hypothesesGenerated,
      skipped: counters.skipped, historySize: history.length, config: cfg };
  }
  function clear() {
    history.length = 0; lastGenAt = 0;
    counters.cycles = 0; counters.hypothesesGenerated = 0; counters.skipped = 0;
  }
  return { tick: tick, getHistory: getHistory, stats: stats, clear: clear, _cfg: cfg };
}

module.exports = { createBlindSpotBridge, DEFAULTS };
