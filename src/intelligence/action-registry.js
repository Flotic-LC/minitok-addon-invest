"use strict";

/**
 * Action Registry — Phase R-5.
 * Maps hypothesis types to concrete executable actions using
 * param-tuner and traffic-splitter. Wires into auto-loop via
 * registerAction().
 *
 * Supported hypothesis types:
 *   - blind_spot_fix           → log action (no param change)
 *   - reduce_alert_noise       → increase selfHealer cooldown for incident type
 *   - improve_fill_rate        → launch A/B via traffic-splitter
 *   - incident_loss_mitigation → lower selfHealer escalation threshold OR raise cooldown
 *   - data_quality_check       → custom override tag
 */

var DEFAULTS = Object.freeze({
  dryRun: process.env.ACTION_REGISTRY_DRY_RUN === "true",
  cooldownMultiplier: Number(process.env.ACTION_COOLDOWN_MULT || 2.0),
  escalationStep: Number(process.env.ACTION_ESCALATION_STEP || 1),
});

function createActionRegistry(options) {
  var cfg = Object.assign({}, DEFAULTS, options || {});
  var paramTuner = cfg.paramTuner || null;
  var trafficSplitter = cfg.trafficSplitter || null;
  var autoLoop = cfg.autoLoop || null;
  var hypothesisEngine = cfg.hypothesisEngine || null;
  var experimentEngine = cfg.experimentEngine || null;

  var audit = [];
  var counters = { installed: 0, invoked: 0, succeeded: 0, failed: 0 };

  function record(entry) {
    audit.push(entry);
    if (audit.length > 500) audit.shift();
  }

  function blindSpotFix(hyp) {
    record({ ts: new Date().toISOString(), type: "blind_spot_fix", hypId: hyp.id, action: "logged_only", statement: hyp.statement });
    counters.succeeded++;
    return { ok: true, action: "logged_only" };
  }

  function reduceAlertNoise(hyp) {
    if (!paramTuner) return { ok: false, reason: "no paramTuner" };
    var r = paramTuner.apply({
      kind: "selfhealer_cooldown",
      incidentType: "DATA_DRIFT",
      multiplier: cfg.cooldownMultiplier,
    });
    record({ ts: new Date().toISOString(), type: "reduce_alert_noise", hypId: hyp.id, result: r });
    if (r.ok) counters.succeeded++; else counters.failed++;
    return r;
  }

  function improveFillRate(hyp) {
    if (!trafficSplitter || !experimentEngine) return { ok: false, reason: "missing deps" };
    // Look for an existing running experiment linked to this hypothesis
    var exps = experimentEngine.list ? experimentEngine.list("running") : [];
    var linked = null;
    for (var i = 0; i < exps.length; i++) {
      if (exps[i].hypothesisId === hyp.id) { linked = exps[i]; break; }
    }
    // If none exists, create one (action-registry pre-empts auto-loop's fallback launcher)
    if (!linked) {
      var expId = experimentEngine.createExperiment({
        hypothesisId: hyp.id,
        name: "action-reg-fill-rate-" + hyp.id.slice(4, 10),
        description: hyp.statement || "improve_fill_rate",
      });
      linked = { id: expId };
    }
    var r = trafficSplitter.registerExperiment(linked.id, {
      ratio: 0.5,
      keyFn: function(ctx) { return String(ctx.symbol || ctx.id || ""); },
    });
    record({ ts: new Date().toISOString(), type: "improve_fill_rate", hypId: hyp.id, expId: linked.id, result: r });
    if (r.ok) counters.succeeded++; else counters.failed++;
    return Object.assign({}, r, { experimentId: linked.id });
  }

  function incidentLossMitigation(hyp) {
    if (!paramTuner) return { ok: false, reason: "no paramTuner" };
    var r = paramTuner.apply({ kind: "selfhealer_escalation", value: 5 });
    record({ ts: new Date().toISOString(), type: "incident_loss_mitigation", hypId: hyp.id, result: r });
    if (r.ok) counters.succeeded++; else counters.failed++;
    return r;
  }

  function dataQualityCheck(hyp) {
    if (!paramTuner) return { ok: false, reason: "no paramTuner" };
    var r = paramTuner.apply({ kind: "custom", key: "dq_" + hyp.id, value: { check: true, at: Date.now() } });
    record({ ts: new Date().toISOString(), type: "data_quality_check", hypId: hyp.id, result: r });
    if (r.ok) counters.succeeded++; else counters.failed++;
    return r;
  }

  function install() {
    if (!autoLoop || typeof autoLoop.registerAction !== "function") {
      return { ok: false, reason: "autoLoop.registerAction not available" };
    }
    var handlers = {
      blind_spot_fix: blindSpotFix,
      reduce_alert_noise: reduceAlertNoise,
      improve_fill_rate: improveFillRate,
      incident_loss_mitigation: incidentLossMitigation,
      data_quality_check: dataQualityCheck,
    };
    var keys = Object.keys(handlers);
    for (var i = 0; i < keys.length; i++) {
      (function(type) {
        autoLoop.registerAction(type, function(hyp) {
          counters.invoked++;
          var r;
          try { r = handlers[type](hyp); }
          catch (e) { r = { ok: false, reason: "exception: " + e.message }; counters.failed++; }
          return r;
        }, { source: "action-registry", dryRun: cfg.dryRun });
      })(keys[i]);
    }
    counters.installed = keys.length;
    return { ok: true, installed: keys.length, types: keys };
  }

  function getAudit(limit) { return audit.slice(-(limit || 30)); }
  function stats() {
    return {
      installed: counters.installed, invoked: counters.invoked,
      succeeded: counters.succeeded, failed: counters.failed,
      auditSize: audit.length, dryRun: cfg.dryRun,
    };
  }
  function clear() {
    audit.length = 0;
    counters.invoked = 0; counters.succeeded = 0; counters.failed = 0;
  }

  // [Phase R-6] Persistence restore
  function restoreAudit(saved) {
    if (!Array.isArray(saved)) return { ok: false, reason: "invalid audit" };
    audit.length = 0;
    for (var i = 0; i < saved.length && i < 500; i++) audit.push(saved[i]);
    return { ok: true, restored: audit.length };
  }

  return {
    install: install, getAudit: getAudit, stats: stats, clear: clear,
    restoreAudit: restoreAudit,
    _handlers: {
      blind_spot_fix: blindSpotFix, reduce_alert_noise: reduceAlertNoise,
      improve_fill_rate: improveFillRate, incident_loss_mitigation: incidentLossMitigation,
      data_quality_check: dataQualityCheck,
    },
  };
}

module.exports = { createActionRegistry, DEFAULTS };
