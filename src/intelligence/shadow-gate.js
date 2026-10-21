"use strict";

/**
 * Shadow Gate — Phase R-6.
 * Intercepts param-tuner apply() calls and routes them through
 * shadow-mode for constitutional compliance. Prevents R-5 from
 * bypassing shadow_mode_min_days, max_daily_param_change_pct,
 * and protected_params constraints.
 *
 * Modes:
 *   - "enforce"  : block immediate apply, require shadow observation (default)
 *   - "advisory" : allow immediate apply but log warning + record in shadow
 *   - "bypass"   : pass through unchanged (testing only)
 *
 * Usage:
 *   const { createShadowGate } = require("./src/intelligence/shadow-gate");
 *   const gate = createShadowGate({ shadowMode, paramTuner, mode: "enforce" });
 *   gate.install();
 */

var DEFAULTS = Object.freeze({
  mode: process.env.SHADOW_GATE_MODE || "enforce",
  logPrefix: "[shadow-gate]",
  protectedParams: [
    "DAILY_MAX_LOSS_PCT", "MAX_SINGLE_POSITION_PCT",
    "MAX_TOTAL_EXPOSURE_PCT", "MAX_OPEN_POSITIONS", "MIN_CASH_RESERVE_PCT",
  ],
  kindToParamMap: {
    selfhealer_cooldown: null,
    selfhealer_escalation: null,
    strategy_weight: "STRATEGY_WEIGHT",
    custom: null,
  },
});

function createShadowGate(options) {
  var cfg = Object.assign({}, DEFAULTS, options || {});
  var shadowMode = cfg.shadowMode || null;
  var paramTuner = cfg.paramTuner || null;
  var onIntercept = cfg.onIntercept || function() {};
  var notify = cfg.notify || function() {};

  var audit = [];
  var counters = { intercepted: 0, enforced: 0, passed: 0, rejected: 0, errors: 0 };
  var originalApply = null;
  var installed = false;

  function record(entry) {
    audit.push(entry);
    if (audit.length > 500) audit.shift();
  }

  function isProtectedParam(param) {
    if (!param) return false;
    return cfg.protectedParams.indexOf(param) >= 0;
  }

  function resolveParamName(params) {
    if (!params || !params.kind) return null;
    if (params.kind === "custom") return params.key || null;
    return cfg.kindToParamMap[params.kind] || null;
  }

  function getCurrentValue(paramName) {
    if (shadowMode) {
      var active = shadowMode.getActiveParams();
      if (active && Object.prototype.hasOwnProperty.call(active, paramName)) {
        return active[paramName];
      }
    }
    if (paramTuner && typeof paramTuner.getOverride === "function") {
      var ov = paramTuner.getOverride(paramName);
      if (ov) return ov.value;
    }
    return null;
  }

  function intercept(params) {
    counters.intercepted++;
    var paramName = resolveParamName(params);

    if (!paramName) {
      counters.passed++;
      record({ ts: new Date().toISOString(), action: "pass_through", kind: params.kind, reason: "non_trading_param" });
      return { intercepted: false, reason: "non_trading_param" };
    }

    if (isProtectedParam(paramName)) {
      counters.rejected++;
      notify(cfg.logPrefix + " BLOCKED: " + paramName + " is protected");
      record({ ts: new Date().toISOString(), action: "rejected", param: paramName, reason: "protected" });
      return { intercepted: true, blocked: true, reason: "protected_param: " + paramName };
    }

    if (cfg.mode === "bypass") {
      counters.passed++;
      record({ ts: new Date().toISOString(), action: "bypass", param: paramName });
      return { intercepted: false, reason: "bypass_mode" };
    }

    if (!shadowMode) {
      counters.errors++;
      record({ ts: new Date().toISOString(), action: "error", reason: "no_shadowMode" });
      return { intercepted: false, reason: "shadowMode_not_available" };
    }

    var currentValue = getCurrentValue(paramName);
    var proposedValue = params.value != null ? params.value : (params.weight != null ? params.weight : null);
    if (proposedValue === null || typeof proposedValue !== "number") {
      counters.passed++;
      record({ ts: new Date().toISOString(), action: "pass_through", param: paramName, reason: "non_numeric_value" });
      return { intercepted: false, reason: "non_numeric_value" };
    }
    if (currentValue === null) currentValue = 0;

    var proposal = shadowMode.propose(paramName, currentValue, proposedValue, {
      reason: "r5_auto_tune:" + (params.kind || "unknown"),
      baselineWinRate: null, baselineTrades: 0,
      // [2026-10-21 6단계] This is an automated change, so the auto-guard
      // applies to it. The tuner used to be able to propose a weight or a
      // threshold with nothing behind it at all; now the measurement has to
      // be present and has to pass before the change can even start
      // observing, and it is checked again at the promotion.
      source: "tuner",
      evidence: params.evidence || null,
      expectedEffect: params.expectedEffect || null,
      sampleCount: params.sampleCount != null ? params.sampleCount : (params.trades || 0),
    });

    if (!proposal.ok) {
      counters.rejected++;
      notify(cfg.logPrefix + " BLOCKED: " + paramName + " — " + proposal.reason);
      record({ ts: new Date().toISOString(), action: "rejected", param: paramName, reason: proposal.reason });
      return { intercepted: true, blocked: true, reason: proposal.reason };
    }

    if (cfg.mode === "enforce") {
      counters.enforced++;
      notify(cfg.logPrefix + " ENFORCED: " + paramName + " " + currentValue + " → " + proposedValue + " (shadow " + proposal.entry.shadowDays + "d)");
      record({
        ts: new Date().toISOString(), action: "enforced", param: paramName,
        currentValue: currentValue, proposedValue: proposedValue,
        shadowId: proposal.entry.id, shadowDays: proposal.entry.shadowDays,
      });
      onIntercept({ type: "enforced", param: paramName, entry: proposal.entry });
      return {
        intercepted: true, blocked: false, shadowed: true,
        shadowId: proposal.entry.id, shadowDays: proposal.entry.shadowDays,
        reason: "shadow_observation_started",
      };
    }

    counters.passed++;
    notify(cfg.logPrefix + " ADVISORY: " + paramName + " change recorded in shadow");
    record({
      ts: new Date().toISOString(), action: "advisory", param: paramName,
      currentValue: currentValue, proposedValue: proposedValue,
      shadowId: proposal.entry.id,
    });
    return { intercepted: false, shadowLogged: true, shadowId: proposal.entry.id };
  }

  function install() {
    if (installed) return { ok: false, reason: "already_installed" };
    if (!paramTuner) return { ok: false, reason: "no paramTuner" };
    if (typeof paramTuner.apply !== "function") return { ok: false, reason: "paramTuner.apply not found" };

    originalApply = paramTuner.apply;
    paramTuner.apply = function patchedApply(params) {
      var gateResult = intercept(params);
      if (gateResult.intercepted && gateResult.blocked) {
        return { ok: false, reason: "shadow_gate_blocked: " + gateResult.reason };
      }
      if (gateResult.intercepted && gateResult.shadowed) {
        return {
          ok: true, shadowed: true,
          shadowId: gateResult.shadowId, shadowDays: gateResult.shadowDays,
          reason: "shadow_observation_started",
        };
      }
      return originalApply.call(paramTuner, params);
    };
    paramTuner.apply._shadowGate = true;
    paramTuner.apply._original = originalApply;
    installed = true;
    return { ok: true, mode: cfg.mode };
  }

  function uninstall() {
    if (!installed || !paramTuner || !originalApply) return { ok: false, reason: "not_installed" };
    paramTuner.apply = originalApply;
    installed = false;
    originalApply = null;
    return { ok: true };
  }

  function getAudit(limit) { return audit.slice(-(limit || 30)); }

  function stats() {
    return {
      installed: installed, mode: cfg.mode,
      intercepted: counters.intercepted, enforced: counters.enforced,
      passed: counters.passed, rejected: counters.rejected, errors: counters.errors,
      auditSize: audit.length,
      shadowStats: shadowMode ? shadowMode.stats() : null,
    };
  }

  function clear() {
    audit.length = 0;
    counters.intercepted = 0; counters.enforced = 0;
    counters.passed = 0; counters.rejected = 0; counters.errors = 0;
  }

  return {
    intercept: intercept, install: install, uninstall: uninstall,
    getAudit: getAudit, stats: stats, clear: clear,
    _cfg: cfg,
  };
}

module.exports = { createShadowGate, DEFAULTS };