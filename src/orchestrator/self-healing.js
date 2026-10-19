"use strict";

/**
 * Self-Healing Framework — classifies incidents and applies automatic mitigations.
 *
 * Incident types (from L45_IMPLEMENTATION_PLAN.md §5.1):
 *   - API_TRANSIENT:     Toss WS drops, 429, 5xx — backoff + reconnection
 *   - DATA_DRIFT:        Meta-cognition score-PnL correlation < 0.2 for 2+ consecutive calibrations
 *   - REGIME_MISMATCH:   HMM regime flipped 3+ times consecutively — pause strategy
 *   - PARAM_STALE:       Walk-forward rejected 2+ consecutive runs — trigger re-evolution
 *   - LIQUIDITY_SHOCK:   Spread > 3 bps — block BUY for cooldown + killswitch check
 *   - LLM_DEGRADATION:   LLM latency > 10s or parse errors > 20% — switch provider
 *
 * Each incident has a per-type cooldown to prevent thrashing, and an escalation
 * counter: after `escalationThreshold` incidents of the same type, the system
 * escalates to Phase N (human escalation).
 *
 * Usage:
 *   const { createSelfHealer } = require("./src/orchestrator/self-healing");
 *   const healer = createSelfHealer({
 *     onIncident: (type, ctx) => { sendTelegramAlert(...); },
 *     onMitigation: (type, action) => { ... },
 *   });
 *   healer.reportIncident("API_TRANSIENT", { source: "ws", code: 429 });
 *   healer.tick({ currentRegime: "bear", spreadBps: 5 });
 *   const state = healer.state(); // persist across restarts
 */

const INCIDENT_TYPES = Object.freeze([
  "API_TRANSIENT",
  "DATA_DRIFT",
  "REGIME_MISMATCH",
  "PARAM_STALE",
  "LIQUIDITY_SHOCK",
  "LLM_DEGRADATION",
]);

const DEFAULT_COOLDOWNS = Object.freeze({
  API_TRANSIENT: 60_000,        // 1 min
  DATA_DRIFT: 3_600_000,        // 1 hour
  REGIME_MISMATCH: 1_800_000,   // 30 min
  PARAM_STALE: 7_200_000,       // 2 hours
  LIQUIDITY_SHOCK: 300_000,   // 30 min
  LLM_DEGRADATION: 300_000,     // 5 min
});

const DEFAULT_CONFIG = Object.freeze({
  escalationThreshold: 3,
  maxHistorySize: 500,
  regimeFlipThreshold: 3,
  walkForwardRejectThreshold: 3,
  dataDriftRhoThreshold: 0.2,
  dataDriftCalibrationsNeeded: 2,
  liquidityShockSpreadBps: 150,  // [Patch 2026-10-15 Phase-C] raised from 50
  llmLatencyMs: 10_000,
  llmParseErrorPct: 0.20,
});

function createSelfHealer(options) {
  const opts = options || {};
  const cfg = Object.assign({}, DEFAULT_CONFIG, opts.config || {});
  const cooldowns = Object.assign({}, DEFAULT_COOLDOWNS, opts.cooldowns || {});
  const onIncident = opts.onIncident || function() {};
  const onMitigation = opts.onMitigation || function() {};
  const onEscalation = opts.onEscalation || function() {};
  const now = opts.now || function() { return Date.now(); };

  const history = [];
  const activeMitigations = {};
  const countsPerType = {};
  const consecutiveCounters = {
    regimeFlips: 0,
    walkForwardRejects: 0,
    lowRhoCalibrations: 0,
    lastRegime: null,
  };

  for (const t of INCIDENT_TYPES) countsPerType[t] = { total: 0, escalated: 0 };
  // [FIX] Windowed escalation counter: track last incident time per type so the
  // escalation counter resets after a quiet window (no repeat alerts for a
  // chronic-but-benign condition like occasional LLM JSON noise).

  // ----- core: reportIncident -----
  function reportIncident(type, ctx) {
    if (!INCIDENT_TYPES.includes(type)) {
      throw new Error("Unknown incident type: " + type);
    }
    const t = now();
    const existing = activeMitigations[type];

    if (existing && existing.expiresAt > t) {
      const entry = {
        ts: new Date(t).toISOString(), type: type, ctx: ctx || null,
        mitigation: existing.action, escalated: false, cooldownSkipped: true,
      };
      appendHistory(entry);
      return { incident: entry, applied: false, reason: "cooldown active" };
    }

    const action = computeMitigation(type, ctx);
    const expiresAt = t + (cooldowns[type] || 60_000);
    activeMitigations[type] = { appliedAt: t, action: action, expiresAt: expiresAt };

    // [P6-FIX] Sliding-window escalation with per-window escalation cap.
    // Two bugs fixed:
    //   (a) escalated++ fired on EVERY incident past threshold, causing
    //       escalated > total (e.g. 23 escalated for 12 total).
    //   (b) total could accumulate across window resets while escalated never
    //       reset, producing confusing counters.
    // Fix: track escalatedThisWindow boolean; reset both total and the flag
    // when the window expires; escalate at most once per window.
    const ESCALATION_WINDOW_MS = Number(process.env.SELF_HEAL_ESCALATION_WINDOW_MS || 3600000); // 1h
    if (countsPerType[type].lastAt && (t - countsPerType[type].lastAt) > ESCALATION_WINDOW_MS) {
      countsPerType[type].total = 0;
      countsPerType[type].escalatedThisWindow = false;
    }
    countsPerType[type].lastAt = t;
    countsPerType[type].total++;
    let escalated = false;
    if (countsPerType[type].total >= cfg.escalationThreshold && !countsPerType[type].escalatedThisWindow) {
      escalated = true;
      countsPerType[type].escalatedThisWindow = true;
      countsPerType[type].escalated++;
      try { onEscalation(type, { count: countsPerType[type].total, ctx: ctx || null }); } catch {}
    }

    const entry = {
      ts: new Date(t).toISOString(), type: type, ctx: ctx || null,
      mitigation: action, escalated: escalated, cooldownSkipped: false,
    };
    appendHistory(entry);

    try { onIncident(type, ctx || null); } catch {}
    try { onMitigation(type, action); } catch {}

    return { incident: entry, applied: true, action: action };
  }

  function computeMitigation(type, ctx) {
    // [P6-FIX] Meaningful mitigations that actually do something in the current
    // deployment topology (single LLM provider = luna-6; evolution disabled).
    // Previous no-ops:
    //   - switch_provider → useless with 1 provider
    //   - trigger_re_evolution → useless with evolution disabled
    // New behavior falls back to actionable defenses.
    switch (type) {
      case "API_TRANSIENT":
        return { action: "backoff_reconnect", backoffMs: cooldowns.API_TRANSIENT };
      case "DATA_DRIFT":
        return { action: "pause_strategy", reason: "score-PnL correlation degraded", rho: ctx && ctx.rho };
      case "REGIME_MISMATCH":
        return { action: "pause_strategy", reason: "regime instability", flips: ctx && ctx.flips };
      case "PARAM_STALE": {
        // If evolution engine is wired & enabled, re-evolve. Otherwise revert
        // tunable params to safe defaults (the actionable fallback).
        const evolutionActive = !!(opts.isEvolutionEnabled && opts.isEvolutionEnabled());
        if (evolutionActive) {
          return { action: "trigger_re_evolution", reason: "walk-forward rejections", rejects: ctx && ctx.rejects };
        }
        return {
          action: "revert_params_to_defaults",
          reason: "walk-forward rejections (evolution disabled — reverting tunable params)",
          rejects: ctx && ctx.rejects,
        };
      }
      case "LIQUIDITY_SHOCK":
        return { action: "block_buy", durationMs: cooldowns.LIQUIDITY_SHOCK, spreadBps: ctx && ctx.spreadBps };
      case "LLM_DEGRADATION": {
        // If multiple healthy providers exist, rotate. Otherwise fall back to
        // rule-based (non-LLM) decisions so trading can continue safely.
        const healthyCount = typeof opts.getHealthyProviderCount === "function"
          ? opts.getHealthyProviderCount() : 1;
        if (healthyCount > 1) {
          return {
            action: "switch_provider",
            reason: "LLM degraded (rotating)",
            latencyMs: ctx && ctx.latencyMs,
            parseErrorPct: ctx && ctx.parseErrorPct,
          };
        }
        return {
          action: "fallback_to_rules",
          reason: "LLM degraded (single provider — bypassing LLM, using signal engine only)",
          latencyMs: ctx && ctx.latencyMs,
          parseErrorPct: ctx && ctx.parseErrorPct,
          durationMs: cooldowns.LLM_DEGRADATION,
        };
      }
      default:
        return { action: "unknown" };
    }
  }

  function appendHistory(entry) {
    history.push(entry);
    if (history.length > cfg.maxHistorySize) history.shift();
  }

  // ----- tick: expire + auto-detect drifts -----
  function tick(metrics) {
    const t = now();
    const m = metrics || {};

    // Expire old mitigations
    for (const type of Object.keys(activeMitigations)) {
      if (activeMitigations[type].expiresAt <= t) {
        delete activeMitigations[type];
      }
    }

    // Auto-detect REGIME_MISMATCH via consecutive flips
    if (m.currentRegime != null) {
      if (consecutiveCounters.lastRegime != null && m.currentRegime !== consecutiveCounters.lastRegime) {
        consecutiveCounters.regimeFlips++;
        if (consecutiveCounters.regimeFlips >= cfg.regimeFlipThreshold) {
          reportIncident("REGIME_MISMATCH", { flips: consecutiveCounters.regimeFlips, regime: m.currentRegime });
        }
      } else if (consecutiveCounters.lastRegime === m.currentRegime) {
        consecutiveCounters.regimeFlips = 0;
      }
      consecutiveCounters.lastRegime = m.currentRegime;
    }

    // Auto-detect PARAM_STALE via walk-forward verdicts
    if (m.walkForwardVerdict != null) {
      if (m.walkForwardVerdict === "reject") {
        consecutiveCounters.walkForwardRejects++;
        if (consecutiveCounters.walkForwardRejects >= cfg.walkForwardRejectThreshold) {
          reportIncident("PARAM_STALE", { rejects: consecutiveCounters.walkForwardRejects });
        }
      } else {
        consecutiveCounters.walkForwardRejects = 0;
      }
    }

    // Auto-detect DATA_DRIFT via meta-cognition calibration rho
    if (m.calibrationRho != null) {
      if (m.calibrationRho < cfg.dataDriftRhoThreshold) {
        consecutiveCounters.lowRhoCalibrations++;
        if (consecutiveCounters.lowRhoCalibrations >= cfg.dataDriftCalibrationsNeeded) {
          reportIncident("DATA_DRIFT", { rho: m.calibrationRho, consecutive: consecutiveCounters.lowRhoCalibrations });
        }
      } else {
        consecutiveCounters.lowRhoCalibrations = 0;
      }
    }

    // Auto-detect LIQUIDITY_SHOCK via spread
    if (m.spreadBps != null && m.spreadBps > cfg.liquidityShockSpreadBps) {
      reportIncident("LIQUIDITY_SHOCK", { spreadBps: m.spreadBps });
    }

    // Auto-detect LLM_DEGRADATION via latency / parse errors
    if ((m.llmLatencyMs != null && m.llmLatencyMs > cfg.llmLatencyMs) ||
        (m.llmParseErrorPct != null && m.llmParseErrorPct > cfg.llmParseErrorPct)) {
      reportIncident("LLM_DEGRADATION", { latencyMs: m.llmLatencyMs, parseErrorPct: m.llmParseErrorPct });
    }

    // Explicit API transient passed via tick
    if (m.apiTransient != null) {
      reportIncident("API_TRANSIENT", m.apiTransient);
    }

    return {
      activeMitigations: Object.keys(activeMitigations).length,
      incidentsRecorded: history.length,
    };
  }

  function isMitigated(type) {
    const t = now();
    if (type != null) {
      const a = activeMitigations[type];
      return !!(a && a.expiresAt > t);
    }
    for (const k of Object.keys(activeMitigations)) {
      if (activeMitigations[k].expiresAt > t) return true;
    }
    return false;
  }

  function getActiveMitigations() {
    const t = now();
    const out = {};
    for (const k of Object.keys(activeMitigations)) {
      if (activeMitigations[k].expiresAt > t) {
        out[k] = Object.assign({}, activeMitigations[k], { remainingMs: activeMitigations[k].expiresAt - t });
      }
    }
    return out;
  }

  function getHistory(limit) {
    if (limit && limit > 0) return history.slice(-limit);
    return history.slice();
  }

  function stats() {
    return {
      incidentTypes: INCIDENT_TYPES.slice(),
      countsPerType: JSON.parse(JSON.stringify(countsPerType)),
      activeMitigations: Object.keys(activeMitigations).length,
      historySize: history.length,
      escalationThreshold: cfg.escalationThreshold,
    };
  }

  function state() {
    return {
      history: history.slice(),
      activeMitigations: JSON.parse(JSON.stringify(activeMitigations)),
      countsPerType: JSON.parse(JSON.stringify(countsPerType)),
      consecutiveCounters: JSON.parse(JSON.stringify(consecutiveCounters)),
    };
  }

  function restore(saved) {
    if (!saved) return;
    if (Array.isArray(saved.history)) {
      history.length = 0;
      for (const e of saved.history) history.push(e);
    }
    if (saved.activeMitigations) {
      for (const k of Object.keys(saved.activeMitigations)) {
        activeMitigations[k] = saved.activeMitigations[k];
      }
    }
    if (saved.countsPerType) {
      for (const k of Object.keys(saved.countsPerType)) {
        if (countsPerType[k]) {
          // [P6-FIX] Sanitize restored counters: ensure escalatedThisWindow
          // and lastAt exist (old persisted state lacked these fields).
          const s = saved.countsPerType[k];
          countsPerType[k] = {
            total: Number(s.total) || 0,
            escalated: Number(s.escalated) || 0,
            escalatedThisWindow: !!s.escalatedThisWindow,
            lastAt: Number(s.lastAt) || null,
          };
        }
      }
    }
    if (saved.consecutiveCounters) {
      Object.assign(consecutiveCounters, saved.consecutiveCounters);
    }
  }

  function reset() {
    history.length = 0;
    for (const k of Object.keys(activeMitigations)) delete activeMitigations[k];
    for (const t of INCIDENT_TYPES) countsPerType[t] = { total: 0, escalated: 0 };
  // [FIX] Windowed escalation counter: track last incident time per type so the
  // escalation counter resets after a quiet window (no repeat alerts for a
  // chronic-but-benign condition like occasional LLM JSON noise).
    consecutiveCounters.regimeFlips = 0;
    consecutiveCounters.walkForwardRejects = 0;
    consecutiveCounters.lowRhoCalibrations = 0;
    consecutiveCounters.lastRegime = null;
  }

  // --- [Phase R-5] Runtime tuners for param-tuner.js ---
  function setCooldown(type, ms) {
    if (!INCIDENT_TYPES.includes(type)) return { ok: false, reason: "unknown type: " + type };
    var v = typeof ms === "number" && ms > 0 ? Math.round(ms) : null;
    if (v === null) return { ok: false, reason: "ms must be positive number" };
    var prev = cooldowns[type];
    cooldowns[type] = v;
    return { ok: true, type: type, prev: prev, next: v };
  }

  function setConfig(key, value) {
    if (!Object.prototype.hasOwnProperty.call(cfg, key)) {
      return { ok: false, reason: "unknown config key: " + key };
    }
    var prev = cfg[key];
    cfg[key] = value;
    return { ok: true, key: key, prev: prev, next: value };
  }

  function getConfig() { return Object.assign({}, cfg); }
  function getCooldowns() { return Object.assign({}, cooldowns); }

  return {
    INCIDENT_TYPES: INCIDENT_TYPES,
    reportIncident: reportIncident,
    tick: tick,
    isMitigated: isMitigated,
    getActiveMitigations: getActiveMitigations,
    getHistory: getHistory,
    stats: stats,
    state: state,
    restore: restore,
    reset: reset,
    setCooldown: setCooldown,
    setConfig: setConfig,
    getConfig: getConfig,
    getCooldowns: getCooldowns,
  };
}

module.exports = { createSelfHealer, INCIDENT_TYPES, DEFAULT_COOLDOWNS, DEFAULT_CONFIG };