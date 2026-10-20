"use strict";

/**
 * Intelligence Persistence — Phase R-6.
 * Atomically saves and restores R-2~R-5 in-memory state so the
 * continuous improvement loop survives process restarts.
 *
 * Persisted state:
 *   - hypotheses (hypothesisEngine)
 *   - outcomes (hypothesisEngine)
 *   - experiments (experimentEngine)
 *   - samples per experiment (experimentEngine)
 *   - paramTuner activeOverrides + history
 *   - actionRegistry audit
 *   - autoLoop history + lastActAt
 *   - outcomeFeedback processed set + history
 *
 * Persistence: atomic JSON file via atomicWriteFileSync.
 *
 * Usage:
 *   const { createIntelligencePersistence } = require("./src/intelligence/persistence");
 *   const persist = createIntelligencePersistence({ hypothesisEngine, experimentEngine, paramTuner, ... });
 *   persist.restore(); // on startup
 *   setInterval(() => persist.save(), 60000); // periodic
 */

var fs = require("node:fs");
var path = require("node:path");
var atomicWrite = require("../core/atomic-write");

var DEFAULTS = Object.freeze({
  path: process.env.INTEL_STATE_PATH || path.join(process.cwd(), ".intelligence-state.json"),
  saveIntervalMs: Number(process.env.INTEL_SAVE_INTERVAL_MS || 60000),
  maxHypotheses: Number(process.env.INTEL_MAX_HYP || 500),
  maxOutcomes: Number(process.env.INTEL_MAX_OUT || 500),
  maxAudit: Number(process.env.INTEL_MAX_AUDIT || 1000),
});

function createIntelligencePersistence(options) {
  var cfg = Object.assign({}, DEFAULTS, options || {});
  var hypothesisEngine = cfg.hypothesisEngine || null;
  var experimentEngine = cfg.experimentEngine || null;
  var paramTuner = cfg.paramTuner || null;
  var actionRegistry = cfg.actionRegistry || null;
  var autoLoop = cfg.autoLoop || null;
  var outcomeFeedback = cfg.outcomeFeedback || null;

  var counters = { saves: 0, restores: 0, errors: 0 };
  var lastSavedAt = null;

  function safeGet(fn, ctx, fallback) {
    try { var r = fn.call(ctx); return r; } catch (e) { return fallback; }
  }

  function snapshot() {
    var state = { version: 1, savedAt: new Date().toISOString(), modules: {} };

    if (hypothesisEngine) {
      state.modules.hypothesis = {
        hypotheses: safeGet(hypothesisEngine.getHypotheses, hypothesisEngine, []).slice(-cfg.maxHypotheses),
        outcomes: safeGet(hypothesisEngine.getOutcomes, hypothesisEngine, []).slice(-cfg.maxOutcomes),
        stats: safeGet(hypothesisEngine.stats, hypothesisEngine, null),
      };
    }

    if (experimentEngine && typeof experimentEngine.list === "function") {
      var all = [];
      try {
        var running = experimentEngine.list("running") || [];
        var evaluated = experimentEngine.list("evaluated") || [];
        var completed = experimentEngine.list("completed") || [];
        all = running.concat(evaluated).concat(completed);
      } catch (e) { all = []; }
      var experiments = [];
      for (var i = 0; i < all.length && i < 200; i++) {
        var full = null;
        try { full = experimentEngine.getExperiment(all[i].id); } catch (e) { full = all[i]; }
        if (full) experiments.push(full);
      }
      state.modules.experiment = { experiments: experiments };
    }

    if (paramTuner) {
      state.modules.paramTuner = {
        history: safeGet(paramTuner.getHistory, paramTuner, []).slice(-cfg.maxAudit),
        stats: safeGet(paramTuner.stats, paramTuner, null),
      };
    }

    if (actionRegistry && typeof actionRegistry.getAudit === "function") {
      state.modules.actionRegistry = {
        audit: safeGet(actionRegistry.getAudit, actionRegistry, []).slice(-cfg.maxAudit),
        stats: safeGet(actionRegistry.stats, actionRegistry, null),
      };
    }

    if (autoLoop) {
      state.modules.autoLoop = {
        history: safeGet(autoLoop.getHistory, autoLoop, []).slice(-cfg.maxAudit),
        stats: safeGet(autoLoop.stats, autoLoop, null),
      };
    }

    if (outcomeFeedback) {
      state.modules.outcomeFeedback = {
        processed: safeGet(outcomeFeedback.getProcessed, outcomeFeedback, []).slice(-1000),
        history: safeGet(outcomeFeedback.getHistory, outcomeFeedback, []).slice(-cfg.maxAudit),
        stats: safeGet(outcomeFeedback.stats, outcomeFeedback, null),
      };
    }

    return state;
  }

  function save() {
    try {
      var state = snapshot();
      var content = JSON.stringify(state, null, 2);
      var result = atomicWrite.atomicWriteFileSync(cfg.path, content);
      if (!result.ok) {
        counters.errors++;
        console.error("[persistence] save failed (" + result.method + "): " + result.error);
        return { ok: false, error: result.error };
      }
      counters.saves++;
      lastSavedAt = state.savedAt;
      return { ok: true, method: result.method, bytes: result.bytes, savedAt: state.savedAt };
    } catch (e) {
      counters.errors++;
      console.error("[persistence] save error: " + e.message);
      return { ok: false, error: e.message };
    }
  }

  function load() {
    try {
      if (!fs.existsSync(cfg.path)) return null;
      var raw = JSON.parse(fs.readFileSync(cfg.path, "utf8"));
      if (!raw || typeof raw !== "object" || !raw.modules) return null;
      return raw;
    } catch (e) {
      counters.errors++;
      console.error("[persistence] load failed: " + e.message);
      return null;
    }
  }

  function restore() {
    var state = load();
    if (!state) return { ok: false, reason: "no_state_file" };
    var restored = [];
    var m = state.modules;

    if (hypothesisEngine && m.hypothesis && typeof hypothesisEngine.restoreState === "function") {
      try {
        hypothesisEngine.restoreState(m.hypothesis.hypotheses || [], m.hypothesis.outcomes || []);
        restored.push("hypothesis");
      } catch (e) { console.error("[persistence] hypothesis restore error: " + e.message); }
    }
    if (experimentEngine && m.experiment && typeof experimentEngine.restoreExperiment === "function") {
      try {
        var n = 0;
        for (var i = 0; i < (m.experiment.experiments || []).length; i++) {
          experimentEngine.restoreExperiment(m.experiment.experiments[i]);
          n++;
        }
        if (n > 0) restored.push("experiment(" + n + ")");
      } catch (e) { console.error("[persistence] experiment restore error: " + e.message); }
    }
    if (paramTuner && m.paramTuner && typeof paramTuner.restoreHistory === "function") {
      try {
        paramTuner.restoreHistory(m.paramTuner.history || []);
        restored.push("paramTuner");
      } catch (e) { console.error("[persistence] paramTuner restore error: " + e.message); }
    }
    if (actionRegistry && m.actionRegistry && typeof actionRegistry.restoreAudit === "function") {
      try {
        actionRegistry.restoreAudit(m.actionRegistry.audit || []);
        restored.push("actionRegistry");
      } catch (e) { console.error("[persistence] actionRegistry restore error: " + e.message); }
    }
    if (autoLoop && m.autoLoop && typeof autoLoop.restoreHistory === "function") {
      try {
        autoLoop.restoreHistory(m.autoLoop.history || []);
        restored.push("autoLoop");
      } catch (e) { console.error("[persistence] autoLoop restore error: " + e.message); }
    }
    if (outcomeFeedback && m.outcomeFeedback && typeof outcomeFeedback.restoreProcessed === "function") {
      try {
        outcomeFeedback.restoreProcessed(m.outcomeFeedback.processed || []);
        restored.push("outcomeFeedback");
      } catch (e) { console.error("[persistence] outcomeFeedback restore error: " + e.message); }
    }

    counters.restores++;
    console.log("[persistence] Restored modules: " + (restored.length > 0 ? restored.join(", ") : "none") +
      " (state saved at " + (state.savedAt || "unknown") + ")");
    return { ok: true, restored: restored, savedAt: state.savedAt };
  }

  var timer = null;
  function start() {
    if (timer) return { ok: false, reason: "already_started" };
    timer = setInterval(function() {
      var r = save();
      if (r.ok) console.log("[persistence] saved (" + r.bytes + " bytes, " + r.method + ")");
    }, cfg.saveIntervalMs);
    if (timer.unref) timer.unref();
    return { ok: true, intervalMs: cfg.saveIntervalMs };
  }

  function stop() {
    if (!timer) return { ok: false, reason: "not_started" };
    clearInterval(timer);
    timer = null;
    return { ok: true };
  }

  function stats() {
    return {
      saves: counters.saves, restores: counters.restores, errors: counters.errors,
      lastSavedAt: lastSavedAt, path: cfg.path, running: !!timer,
    };
  }

  return {
    snapshot: snapshot, save: save, restore: restore,
    start: start, stop: stop, stats: stats,
    _cfg: cfg,
  };
}

module.exports = {
  createPersistence: createIntelligencePersistence,
  createIntelligencePersistence: createIntelligencePersistence,
  DEFAULTS: DEFAULTS,
};