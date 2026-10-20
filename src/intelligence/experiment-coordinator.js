"use strict";

/**
 * Experiment Coordinator — Phase R-7 (Multi-Instance Coordination).
 *
 * Coordinates experiments across multiple runner instances:
 *   - Distributed locking prevents duplicate experiments on same hypothesis
 *   - Conflict detection for overlapping symbol/strategy experiments
 *   - Central attribution aggregation across instances
 *   - Experiment state synchronization and priority-based queuing
 *
 * Backends: 'memory' (shared in-process) | 'pg' (PostgreSQL distributed)
 *
 * Usage:
 *   const { createExperimentCoordinator } = require("./src/intelligence/experiment-coordinator");
 *   const coord = createExperimentCoordinator({ experimentEngine, attributionEngine });
 *   coord.start();
 */

var _welchT = require("./experiment")._welchT;

var DEFAULTS = Object.freeze({
  instanceId: process.env.RUNNER_INSTANCE_ID || "runner-" + process.pid,
  lockTimeoutMs: Number(process.env.COORDINATOR_LOCK_TIMEOUT_MS || 300000),
  heartbeatMs: Number(process.env.COORDINATOR_HEARTBEAT_MS || 30000),
  syncIntervalMs: Number(process.env.COORDINATOR_SYNC_INTERVAL_MS || 60000),
  conflictWindowMs: Number(process.env.COORDINATOR_CONFLICT_WINDOW_MS || 86400000),
  maxQueueSize: Number(process.env.COORDINATOR_MAX_QUEUE || 20),
  maxSamplesPerArm: Number(process.env.EXPERIMENT_MAX_SAMPLES || 500),
  significanceLevel: Number(process.env.EXPERIMENT_ALPHA || 0.05),
  minSamples: Number(process.env.EXPERIMENT_MIN_SAMPLES || 10),
  backend: process.env.COORDINATOR_BACKEND || "auto",
});

// ===== Shared Memory Store (module-level singleton for multi-instance testing) =====
var _sharedStore = null;
function _getSharedStore() { if (!_sharedStore) _sharedStore = createMemoryStore(); return _sharedStore; }
function _resetSharedStore() { if (_sharedStore) _sharedStore.clear(); _sharedStore = null; }

function createMemoryStore() {
  var experiments = new Map(), samples = new Map(), fills = [], decisions = [], instances = new Map();
  var MAX = 50000;

  function acquireLock(hypId, instId) {
    if (!hypId) return { ok: true, reason: "no_hypothesis" };
    var conflict = null;
    experiments.forEach(function(e) { if (e.hypothesisId === hypId && e.status === "running") conflict = e; });
    if (!conflict) return { ok: true, reason: "no_conflict" };
    var lockMs = conflict.lockUntil ? new Date(conflict.lockUntil).getTime() : 0;
    if (lockMs > Date.now() && conflict.instanceId !== instId)
      return { ok: false, reason: "locked_by_other", lockedBy: conflict.instanceId, experimentId: conflict.id };
    return { ok: true, reason: lockMs > 0 && lockMs <= Date.now() ? "lock_expired" : "reentrant" };
  }
  function setLock(expId, instId, timeoutMs) {
    var e = experiments.get(expId);
    if (!e) return { ok: false, reason: "not_found" };
    e.lockUntil = new Date(Date.now() + timeoutMs).toISOString(); e.instanceId = instId;
    return { ok: true };
  }
  function releaseLock(expId, instId) {
    var e = experiments.get(expId);
    if (!e) return { ok: false, reason: "not_found" };
    if (e.instanceId !== instId) return { ok: false, reason: "not_owner" };
    e.lockUntil = null; return { ok: true };
  }
  function createExperiment(exp) {
    experiments.set(exp.id, Object.assign({
      createdAt: new Date().toISOString(), status: "running", lockUntil: null,
      instanceId: exp.instanceId || null, symbol: exp.symbol || null,
      strategy: exp.strategy || null, priority: exp.priority || 0, evaluation: null,
    }, exp));
    samples.set(exp.id, { control: [], treatment: [] });
    return { ok: true, id: exp.id };
  }
  function getExperiment(id) { return experiments.get(id) || null; }
  function listExperiments(status) {
    var out = [];
    experiments.forEach(function(e) { if (!status || e.status === status) out.push(e); });
    return out;
  }
  function updateExperiment(id, u) {
    var e = experiments.get(id); if (!e) return { ok: false, reason: "not_found" };
    Object.assign(e, u); return { ok: true };
  }
  function addSample(expId, arm, value, instId) {
    var s = samples.get(expId);
    if (!s) return { ok: false, reason: "not_found" };
    if (arm !== "control" && arm !== "treatment") return { ok: false, reason: "invalid_arm" };
    s[arm].push({ value: typeof value === "number" ? value : 0, instanceId: instId, ts: Date.now() });
    return { ok: true, count: s[arm].length };
  }
  function getSamples(expId) {
    var s = samples.get(expId); if (!s) return null;
    return {
      control: s.control.map(function(x) { return x.value; }),
      treatment: s.treatment.map(function(x) { return x.value; }),
      detail: { control: s.control.slice(), treatment: s.treatment.slice() },
    };
  }
  function recordFill(f) { fills.push(Object.assign({ ts: Date.now() }, f)); if (fills.length > MAX) fills.shift(); return { ok: true }; }
  function recordDecision(d) { decisions.push(Object.assign({ ts: Date.now() }, d)); if (decisions.length > MAX) decisions.shift(); return { ok: true }; }
  function getFills() { return fills.slice(); }
  function getDecisions() { return decisions.slice(); }
  function registerInstance(instId, meta) {
    instances.set(instId, { instanceId: instId, startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), metadata: meta || {} });
    return { ok: true };
  }
  function heartbeat(instId) {
    var inst = instances.get(instId); if (!inst) return registerInstance(instId);
    inst.heartbeatAt = new Date().toISOString(); return { ok: true };
  }
  function listInstances(staleMs) {
    var out = [], cutoff = staleMs ? Date.now() - staleMs : 0;
    instances.forEach(function(i) { if (!staleMs || new Date(i.heartbeatAt).getTime() > cutoff) out.push(i); });
    return out;
  }
  function findConflicts(hypId, symbol, strategy, windowMs) {
    var conflicts = [], cutoff = Date.now() - (windowMs || 86400000);
    experiments.forEach(function(e) {
      if (e.status !== "running") return;
      if (hypId && e.hypothesisId === hypId) conflicts.push({ type: "same_hypothesis", experiment: e });
      else if (symbol && strategy && e.symbol === symbol && e.strategy === strategy && new Date(e.createdAt).getTime() > cutoff)
        conflicts.push({ type: "same_symbol_strategy", experiment: e });
    });
    return conflicts;
  }
  function clear() { experiments.clear(); samples.clear(); fills.length = 0; decisions.length = 0; instances.clear(); }

  return {
    acquireLock: acquireLock, setLock: setLock, releaseLock: releaseLock,
    createExperiment: createExperiment, getExperiment: getExperiment, listExperiments: listExperiments,
    updateExperiment: updateExperiment, addSample: addSample, getSamples: getSamples,
    recordFill: recordFill, recordDecision: recordDecision, getFills: getFills, getDecisions: getDecisions,
    registerInstance: registerInstance, heartbeat: heartbeat, listInstances: listInstances,
    findConflicts: findConflicts, clear: clear,
  };
}

// ===== PostgreSQL Store (distributed backend) =====
// Wraps a memory store as local cache; mirrors writes to PG tables.
function createPgStore(pgPool) {
  var mem = createMemoryStore();
  var pool = pgPool, ready = false;
  var DDL = [
    "CREATE TABLE IF NOT EXISTS coordinator_experiments(id TEXT PRIMARY KEY, hypothesis_id TEXT, name TEXT, description TEXT, symbol TEXT, strategy TEXT, status TEXT, priority INTEGER DEFAULT 0, instance_id TEXT, lock_until TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW(), evaluation JSONB)",
    "CREATE TABLE IF NOT EXISTS coordinator_samples(id BIGSERIAL PRIMARY KEY, experiment_id TEXT, arm TEXT, value DOUBLE PRECISION, instance_id TEXT, ts BIGINT)",
    "CREATE INDEX IF NOT EXISTS idx_cs_exp ON coordinator_samples(experiment_id)",
    "CREATE TABLE IF NOT EXISTS coordinator_fills(id BIGSERIAL PRIMARY KEY, payload JSONB, ts BIGINT)",
    "CREATE TABLE IF NOT EXISTS coordinator_decisions(id BIGSERIAL PRIMARY KEY, payload JSONB, ts BIGINT)",
    "CREATE TABLE IF NOT EXISTS coordinator_instances(instance_id TEXT PRIMARY KEY, started_at TIMESTAMPTZ, heartbeat_at TIMESTAMPTZ, metadata JSONB)",
  ];
  function q(sql, params) {
    if (!pool) return Promise.resolve({ rows: [] });
    return pool.query(sql, params || []).catch(function(e) { console.error("[coordinator-pg] " + e.message); return { rows: [] }; });
  }
  function ensureSchema() {
    if (!pool) return Promise.resolve(false);
    var p = Promise.resolve();
    DDL.forEach(function(s) { p = p.then(function() { return q(s); }); });
    return p.then(function() { ready = true; return true; });
  }
  function syncFromPg() {
    if (!pool || !ready) return Promise.resolve(false);
    return Promise.all([
      q("SELECT * FROM coordinator_experiments"),
      q("SELECT experiment_id, arm, value, instance_id, ts FROM coordinator_samples ORDER BY ts"),
      q("SELECT payload FROM coordinator_fills ORDER BY ts"),
      q("SELECT payload FROM coordinator_decisions ORDER BY ts"),
      q("SELECT * FROM coordinator_instances"),
    ]).then(function(rs) {
      mem.clear();
      rs[0].rows.forEach(function(r) { mem.createExperiment({ id:r.id, hypothesisId:r.hypothesis_id, name:r.name, description:r.description||"", symbol:r.symbol, strategy:r.strategy, status:r.status, priority:Number(r.priority)||0, instanceId:r.instance_id, createdAt:r.created_at?new Date(r.created_at).toISOString():null, lockUntil:r.lock_until?new Date(r.lock_until).toISOString():null, evaluation:r.evaluation||null }); });
      rs[1].rows.forEach(function(r) { mem.addSample(r.experiment_id, r.arm, Number(r.value)||0, r.instance_id); });
      rs[2].rows.forEach(function(r) { if (r.payload) mem.recordFill(r.payload); });
      rs[3].rows.forEach(function(r) { if (r.payload) mem.recordDecision(r.payload); });
      rs[4].rows.forEach(function(r) { mem.registerInstance(r.instance_id, r.metadata||{}); });
      return true;
    }).catch(function(e) { console.error("[coordinator-pg] sync: " + e.message); return false; });
  }
  function pw(sql, p) { if (pool && ready) q(sql, p); }
  var b = mem;
  var _oc=b.createExperiment, _os=b.addSample, _of=b.recordFill, _od=b.recordDecision, _or=b.registerInstance, _oh=b.heartbeat, _ol=b.setLock, _ou=b.releaseLock, _oup=b.updateExperiment;
  function wCreate(e) { var r=_oc(e); if(r.ok) pw("INSERT INTO coordinator_experiments(id,hypothesis_id,name,description,symbol,strategy,status,priority,instance_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING",[e.id,e.hypothesisId||null,e.name||e.id,e.description||"",e.symbol||null,e.strategy||null,"running",e.priority||0,e.instanceId||null,new Date().toISOString()]); return r; }
  function wSample(i,a,v,inst) { var r=_os(i,a,v,inst); if(r.ok) pw("INSERT INTO coordinator_samples(experiment_id,arm,value,instance_id,ts) VALUES($1,$2,$3,$4,$5)",[i,a,typeof v==="number"?v:0,inst||null,Date.now()]); return r; }
  function wFill(f) { var r=_of(f); if(r.ok) pw("INSERT INTO coordinator_fills(payload,ts) VALUES($1,$2)",[JSON.stringify(f),Date.now()]); return r; }
  function wDec(d) { var r=_od(d); if(r.ok) pw("INSERT INTO coordinator_decisions(payload,ts) VALUES($1,$2)",[JSON.stringify(d),Date.now()]); return r; }
  function wReg(i,m) { var r=_or(i,m); if(r.ok) pw("INSERT INTO coordinator_instances(instance_id,started_at,heartbeat_at,metadata) VALUES($1,$2,$2,$3) ON CONFLICT(instance_id) DO UPDATE SET heartbeat_at=$2,metadata=$3",[i,new Date().toISOString(),JSON.stringify(m||{})]); return r; }
  function wHb(i) { var r=_oh(i); if(r.ok) pw("UPDATE coordinator_instances SET heartbeat_at=$1 WHERE instance_id=$2",[new Date().toISOString(),i]); return r; }
  function wSL(i,inst,ms) { var r=_ol(i,inst,ms); if(r.ok) pw("UPDATE coordinator_experiments SET lock_until=$1,instance_id=$2 WHERE id=$3",[new Date(Date.now()+ms).toISOString(),inst,i]); return r; }
  function wRL(i,inst) { var r=_ou(i,inst); if(r.ok) pw("UPDATE coordinator_experiments SET lock_until=NULL WHERE id=$1",[i]); return r; }
  function wUpd(id,u) { var r=_oup(id,u); if(r.ok){ if(u.status) pw("UPDATE coordinator_experiments SET status=$1 WHERE id=$2",[u.status,id]); if(u.evaluation) pw("UPDATE coordinator_experiments SET evaluation=$1 WHERE id=$2",[JSON.stringify(u.evaluation),id]); } return r; }
  return {
    acquireLock:b.acquireLock, setLock:wSL, releaseLock:wRL,
    createExperiment:wCreate, getExperiment:b.getExperiment, listExperiments:b.listExperiments,
    updateExperiment:wUpd, addSample:wSample, getSamples:b.getSamples,
    recordFill:wFill, recordDecision:wDec, getFills:b.getFills, getDecisions:b.getDecisions,
    registerInstance:wReg, heartbeat:wHb, listInstances:b.listInstances,
    findConflicts:b.findConflicts, clear:b.clear,
    ensureSchema:ensureSchema, syncFromPg:syncFromPg, _mem:mem,
  };
}
// ===== Experiment Coordinator Factory =====
function createExperimentCoordinator(options) {
  var cfg = Object.assign({}, DEFAULTS, options || {});
  var experimentEngine = cfg.experimentEngine || null;
  var attributionEngine = cfg.attributionEngine || null;
  var pgPool = cfg.pgPool || null;
  var store;
  if ((cfg.backend === "pg" || cfg.backend === "auto") && pgPool) store = createPgStore(pgPool);
  else store = _getSharedStore();
  var heartbeatTimer = null, syncTimer = null;
  var history = [];
  var started = false;
  function log(event, data) {
    history.push({ ts: new Date().toISOString(), event: event, instanceId: cfg.instanceId, data: data || {} });
    if (history.length > 2000) history.shift();
  }
  function start() {
    if (started) return { ok: false, reason: "already_started" };
    store.registerInstance(cfg.instanceId, { pid: process.pid, backend: cfg.backend });
    store.heartbeat(cfg.instanceId);
    heartbeatTimer = setInterval(function() { store.heartbeat(cfg.instanceId); }, cfg.heartbeatMs);
    syncTimer = setInterval(function() { syncExperiments(); }, cfg.syncIntervalMs);
    if (typeof store.ensureSchema === "function") {
      store.ensureSchema().then(function() {
        if (typeof store.syncFromPg === "function") store.syncFromPg();
      }).catch(function() {});
    }
    started = true;
    log("started", { backend: cfg.backend });
    return { ok: true };
  }
  function stop() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (syncTimer) clearInterval(syncTimer);
    heartbeatTimer = null; syncTimer = null;
    started = false;
    log("stopped");
    return { ok: true };
  }
  function proposeExperiment(opts) {
    var o = opts || {};
    if (!o.hypothesisId) return { ok: false, reason: "no_hypothesis_id" };
    var conflicts = store.findConflicts(o.hypothesisId, o.symbol, o.strategy, cfg.conflictWindowMs);
    if (conflicts.length > 0) {
      log("conflict_detected", { hypothesisId: o.hypothesisId, conflicts: conflicts.length });
      return { ok: false, reason: "conflict", conflicts: conflicts };
    }
    var running = store.listExperiments("running");
    if (running.length >= cfg.maxQueueSize) {
      log("queue_full", { running: running.length });
      return { ok: false, reason: "queue_full", running: running.length };
    }
    var id = "cexp_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
    var exp = { id: id, hypothesisId: o.hypothesisId, name: o.name || "coord-" + id,
      description: o.description || "", symbol: o.symbol || null,
      strategy: o.strategy || null, priority: o.priority || 0,
      instanceId: cfg.instanceId, status: "running" };
    var created = store.createExperiment(exp);
    if (!created.ok) return { ok: false, reason: "create_failed", detail: created };
    var locked = store.setLock(id, cfg.instanceId, cfg.lockTimeoutMs);
    if (!locked.ok) { store.updateExperiment(id, { status: "lock_failed" }); return { ok: false, reason: "lock_failed" }; }
    log("proposed", { id: id, hypothesisId: o.hypothesisId, priority: exp.priority });
    return { ok: true, experimentId: id, experiment: store.getExperiment(id) };
  }
  function recordSample(expId, arm, value) {
    var e = store.getExperiment(expId);
    if (!e) return { ok: false, reason: "not_found" };
    if (e.instanceId !== cfg.instanceId && e.lockUntil && new Date(e.lockUntil).getTime() > Date.now())
      return { ok: false, reason: "not_lock_owner", lockedBy: e.instanceId };
    return store.addSample(expId, arm, value, cfg.instanceId);
  }
  function recordFill(f) { return store.recordFill(f); }
  function recordDecision(d) { return store.recordDecision(d); }
  function syncExperiments() {
    if (typeof store.syncFromPg === "function") {
      return store.syncFromPg().then(function(ok) { if (ok) log("synced_from_pg", {}); return { ok: ok }; });
    }
    return Promise.resolve({ ok: true, reason: "memory_only" });
  }
  function resolveConflicts() {
    var running = store.listExperiments("running");
    var groups = {};
    running.forEach(function(e) {
      var key = (e.symbol || "_") + "|" + (e.strategy || "_");
      if (!groups[key]) groups[key] = [];
      groups[key].push(e);
    });
    var stopped = 0;
    Object.keys(groups).forEach(function(k) {
      var g = groups[k];
      if (g.length <= 1) return;
      g.sort(function(a, b) { return (b.priority || 0) - (a.priority || 0); });
      for (var i = 1; i < g.length; i++) {
        store.updateExperiment(g[i].id, { status: "preempted", preemptedBy: g[0].id });
        if (g[i].instanceId) store.releaseLock(g[i].id, g[i].instanceId);
        log("preempted", { id: g[i].id, winner: g[0].id });
        stopped++;
      }
    });
    return { stopped: stopped };
  }
  function evaluate(expId) {
    if (!experimentEngine) return { ok: false, reason: "no_experiment_engine" };
    var e = store.getExperiment(expId);
    if (!e) return { ok: false, reason: "not_found" };
    var samples = store.getSamples(expId);
    if (!samples) return { ok: false, reason: "no_samples" };
    if (samples.treatment.length < cfg.minSamples || samples.control.length < cfg.minSamples)
      return { ok: false, reason: "insufficient_samples", treatment: samples.treatment.length, control: samples.control.length, min: cfg.minSamples };
    var wt = _welchT(samples.treatment, samples.control);
    var meanT = samples.treatment.reduce(function(s, v) { return s + v; }, 0) / samples.treatment.length;
    var meanC = samples.control.reduce(function(s, v) { return s + v; }, 0) / samples.control.length;
    var lift = meanC !== 0 ? (meanT - meanC) / Math.abs(meanC) : 0;
    var significant = wt.pApprox < cfg.significanceLevel;
    var verdict = significant ? (lift > 0 ? "treatment_better" : "control_better") : "no_significant_difference";
    var evaluation = {
      treatment: { n: samples.treatment.length, mean: Number(meanT.toFixed(4)) },
      control: { n: samples.control.length, mean: Number(meanC.toFixed(4)) },
      lift: Number(lift.toFixed(4)), t: wt.t, df: wt.df, pApprox: wt.pApprox,
      significant: significant, verdict: verdict, evaluatedAt: new Date().toISOString(),
    };
    store.updateExperiment(expId, { status: "evaluated", evaluation: evaluation });
    store.releaseLock(expId, cfg.instanceId);
    log("evaluated", { id: expId, verdict: verdict, significant: significant });
    return { ok: true, id: expId, evaluation: evaluation };
  }
  function stats() {
    var all = store.listExperiments();
    var running = all.filter(function(e) { return e.status === "running"; }).length;
    var evaluated = all.filter(function(e) { return e.status === "evaluated"; }).length;
    var preempted = all.filter(function(e) { return e.status === "preempted"; }).length;
    return {
      total: all.length, running: running, evaluated: evaluated, preempted: preempted,
      instances: store.listInstances().length,
      instanceId: cfg.instanceId, started: started, backend: cfg.backend,
      config: { lockTimeoutMs: cfg.lockTimeoutMs, heartbeatMs: cfg.heartbeatMs, syncIntervalMs: cfg.syncIntervalMs, conflictWindowMs: cfg.conflictWindowMs, maxQueueSize: cfg.maxQueueSize, minSamples: cfg.minSamples, significanceLevel: cfg.significanceLevel },
      fills: store.getFills().length, decisions: store.getDecisions().length, historySize: history.length,
    };
  }
  function getHistory(limit) { return history.slice(-(limit || 50)); }
  function listExperiments(status) { return store.listExperiments(status); }
  function getExperiment(id) { return store.getExperiment(id); }
  function listInstances(staleMs) { return store.listInstances(staleMs); }
  return {
    start: start, stop: stop,
    proposeExperiment: proposeExperiment, recordSample: recordSample,
    recordFill: recordFill, recordDecision: recordDecision,
    syncExperiments: syncExperiments, resolveConflicts: resolveConflicts,
    evaluate: evaluate, stats: stats, getHistory: getHistory,
    listExperiments: listExperiments, getExperiment: getExperiment, listInstances: listInstances,
    _store: store,
  };
}

module.exports = {
  createExperimentCoordinator: createExperimentCoordinator,
  createMemoryStore: createMemoryStore,
  createPgStore: createPgStore,
  DEFAULTS: DEFAULTS,
  _getSharedStore: _getSharedStore,
  _resetSharedStore: _resetSharedStore,
};
