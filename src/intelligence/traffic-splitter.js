"use strict";

/**
 * Traffic Splitter — Phase R-5.
 * Routes live decisions/experiments to control vs. treatment arms
 * based on a deterministic hash so the same symbol always hits the
 * same arm within an experiment.
 *
 * Usage:
 *   const { createTrafficSplitter } = require("./src/intelligence/traffic-splitter");
 *   const ts = createTrafficSplitter({ experimentEngine });
 *   ts.registerExperiment(expId, { ratio: 0.5, keyFn: (ctx) => ctx.symbol });
 *   const arm = ts.route(expId, { symbol: "005930" }); // "control" | "treatment" | null
 *   ts.recordOutcome(expId, arm, pnl);
 */

var DEFAULTS = Object.freeze({
  maxExperiments: Number(process.env.TRAFFIC_SPLITTER_MAX || 50),
  defaultRatio: Number(process.env.TRAFFIC_SPLITTER_RATIO || 0.5),
});

function hashString(s) {
  var h = 0;
  for (var i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function createTrafficSplitter(options) {
  var cfg = Object.assign({}, DEFAULTS, options || {});
  var experimentEngine = cfg.experimentEngine || null;

  var experiments = new Map();
  var history = [];
  var counters = { routed: 0, control: 0, treatment: 0, unregistered: 0, recorded: 0 };

  function registerExperiment(expId, opts) {
    if (!expId) return { ok: false, reason: "expId required" };
    var o = opts || {};
    experiments.set(expId, {
      id: expId,
      ratio: typeof o.ratio === "number" ? o.ratio : cfg.defaultRatio,
      keyFn: typeof o.keyFn === "function" ? o.keyFn : function(ctx) { return String(ctx.symbol || ctx.id || ""); },
      startedAt: Date.now(),
    });
    if (experiments.size > cfg.maxExperiments) {
      var oldest = experiments.keys().next().value;
      experiments.delete(oldest);
    }
    return { ok: true, expId: expId };
  }

  function unregisterExperiment(expId) {
    return { ok: experiments.delete(expId) };
  }

  function route(expId, ctx) {
    var e = experiments.get(expId);
    if (!e) {
      counters.unregistered++;
      return null;
    }
    counters.routed++;
    var key = String(e.keyFn(ctx || {}));
    var bucket = hashString(expId + ":" + key) % 10000;
    var threshold = Math.round(e.ratio * 10000);
    var arm = bucket < threshold ? "treatment" : "control";
    if (arm === "treatment") counters.treatment++;
    else counters.control++;
    history.push({ ts: Date.now(), expId: expId, arm: arm, key: key });
    if (history.length > 2000) history.shift();
    return arm;
  }

  function recordOutcome(expId, arm, value) {
    if (!experimentEngine) return { ok: false, reason: "no experimentEngine" };
    if (!arm) return { ok: false, reason: "arm required" };
    if (arm !== "control" && arm !== "treatment") return { ok: false, reason: "invalid arm" };
    counters.recorded++;
    return experimentEngine.recordSample(expId, arm, value);
  }

  function getExperiment(expId) { return experiments.get(expId) || null; }
  function list() { return Array.from(experiments.values()).map(function(e) { return { id: e.id, ratio: e.ratio, startedAt: e.startedAt }; }); }
  function getHistory(limit) { return history.slice(-(limit || 50)); }
  function stats() {
    return {
      active: experiments.size, routed: counters.routed,
      control: counters.control, treatment: counters.treatment,
      unregistered: counters.unregistered, recorded: counters.recorded,
    };
  }
  function clear() {
    experiments.clear(); history.length = 0;
    counters.routed = 0; counters.control = 0; counters.treatment = 0;
    counters.unregistered = 0; counters.recorded = 0;
  }

  return {
    registerExperiment: registerExperiment, unregisterExperiment: unregisterExperiment,
    route: route, recordOutcome: recordOutcome,
    getExperiment: getExperiment, list: list,
    getHistory: getHistory, stats: stats, clear: clear,
    _hashString: hashString,
  };
}

module.exports = { createTrafficSplitter, DEFAULTS };
