"use strict";

/**
 * Regime Advisor — Phase R-6.
 * Observes regime-HMM transitions, auto-generates adaptation hypotheses.
 *
 * Trigger conditions:
 *   - Regime label sustained for N observations
 *   - Position multiplier drops below bear threshold
 *   - Bull regime emerging
 *
 * Generated types:
 *   - regime_shift_position  → adjust POSITION_SIZE_PCT
 *   - regime_shift_weight    → rebalance strategy weights
 */

var DEFAULTS = Object.freeze({
  minObservations: Number(process.env.REGIME_ADVISOR_MIN_OBS || 10),
  bearMultThreshold: Number(process.env.REGIME_BEAR_THRESHOLD || 0.7),
  bullMultThreshold: Number(process.env.REGIME_BULL_THRESHOLD || 1.3),
  cooldownMs: Number(process.env.REGIME_ADVISOR_COOLDOWN_MS || 21600000),
  minProb: Number(process.env.REGIME_MIN_PROB || 0.5),
});

function createRegimeAdvisor(options) {
  var cfg = Object.assign({}, DEFAULTS, options || {});
  var regimeHMM = cfg.regimeHMM || null;
  var hypothesisEngine = cfg.hypothesisEngine || null;
  var notify = cfg.notify || function() {};

  var history = [];
  var lastHypAt = 0, lastLabel = null, lastLabelStreak = 0;
  var counters = { ticks: 0, hypothesesGenerated: 0, skipped: 0 };

  function record(e) { history.push(e); if (history.length > 200) history.shift(); }

  function snapshot() {
    if (!regimeHMM) return null;
    var feats = null;
    if (typeof regimeHMM.lastFeatures === "function") feats = regimeHMM.lastFeatures();
    if (!feats && regimeHMM._lastFeatures) feats = regimeHMM._lastFeatures;
    var label = "unknown", prob = 0, mult = 1;
    if (feats) {
      label = feats.label || "unknown";
      prob = feats.prob || 0;
      if (typeof regimeHMM.getPositionMultiplier === "function") mult = regimeHMM.getPositionMultiplier(feats);
    }
    var obs = (regimeHMM.history && Array.isArray(regimeHMM.history)) ? regimeHMM.history.length : 0;
    return { label: label, prob: prob, mult: mult, obs: obs };
  }

  function pushHypothesis(hyp) {
    if (typeof hypothesisEngine.addHypothesis === "function") { hypothesisEngine.addHypothesis(hyp); return true; }
    if (hypothesisEngine._hypotheses && Array.isArray(hypothesisEngine._hypotheses)) { hypothesisEngine._hypotheses.push(hyp); return true; }
    return false;
  }

  function generate(type, statement, action, confidence, impact) {
    var id = "hyp_r6regime_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
    var hyp = {
      id: id, type: type, source: "regime_advisor",
      statement: statement, action: action,
      confidence: confidence, expectedImpact: impact,
      createdAt: new Date().toISOString(), status: "pending",
    };
    if (!pushHypothesis(hyp)) return null;
    lastHypAt = Date.now();
    counters.hypothesesGenerated++;
    record({ ts: hyp.createdAt, hypId: id, type: type });
    notify("[regime-advisor] " + statement);
    return hyp;
  }

  function tick() {
    counters.ticks++;
    var snap = snapshot();
    if (!snap) return { ok: false, reason: "no_snapshot" };

    if (snap.label === lastLabel) lastLabelStreak++;
    else { lastLabel = snap.label; lastLabelStreak = 1; }

    if (snap.obs < cfg.minObservations) { counters.skipped++; return { ok: true, skipped: true, reason: "insufficient_obs" }; }
    if (snap.prob < cfg.minProb) { counters.skipped++; return { ok: true, skipped: true, reason: "low_prob" }; }
    if (lastLabelStreak < 2) return { ok: true, skipped: true, regime: snap };
    if (Date.now() - lastHypAt < cfg.cooldownMs) return { ok: true, skipped: true, reason: "cooldown", regime: snap };

    var generated = [];
    if (snap.mult <= cfg.bearMultThreshold) {
      var h1 = generate("regime_shift_position",
        "Bear regime (mult=" + snap.mult.toFixed(2) + ", p=" + snap.prob.toFixed(2) + "). Reduce size.",
        "Lower POSITION_SIZE_PCT and tighten STOP_LOSS_PCT", 0.7, "high");
      var h2 = generate("regime_shift_weight",
        "Bear regime: shift to mean-reversion.",
        "Reduce momentum weight, increase mean-reversion", 0.65, "medium");
      if (h1) generated.push(h1);
      if (h2) generated.push(h2);
    } else if (snap.mult >= cfg.bullMultThreshold) {
      var h3 = generate("regime_shift_position",
        "Bull regime (mult=" + snap.mult.toFixed(2) + ", p=" + snap.prob.toFixed(2) + "). Increase exposure.",
        "Raise POSITION_SIZE_PCT for momentum", 0.7, "high");
      var h4 = generate("regime_shift_weight",
        "Bull regime: favor momentum/trend.",
        "Increase momentum strategy weight", 0.7, "high");
      if (h3) generated.push(h3);
      if (h4) generated.push(h4);
    }
    if (generated.length === 0) return { ok: true, skipped: true, regime: snap };
    return { ok: true, hypotheses: generated, regime: snap };
  }

  function getHistory(limit) { return history.slice(-(limit || 20)); }
  function stats() {
    return {
      ticks: counters.ticks, hypothesesGenerated: counters.hypothesesGenerated,
      skipped: counters.skipped, lastLabel: lastLabel, lastLabelStreak: lastLabelStreak,
      historySize: history.length, config: cfg,
    };
  }
  function clear() {
    history.length = 0; lastLabel = null; lastLabelStreak = 0; lastHypAt = 0;
    counters.ticks = 0; counters.hypothesesGenerated = 0; counters.skipped = 0;
  }

  return { tick: tick, snapshot: snapshot, getHistory: getHistory, stats: stats, clear: clear, _cfg: cfg };
}

module.exports = { createRegimeAdvisor, DEFAULTS };
