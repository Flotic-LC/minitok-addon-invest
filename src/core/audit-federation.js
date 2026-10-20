"use strict";

/**
 * Audit Federation (P1-7) — routes audit events to multiple sinks based
 * on event type and severity. Connects the addon's audit-logger (local
 * JSONL files) with the minitok core audit system (homedir audit.jsonl)
 * and optional remote federation endpoint.
 *
 * Architecture:
 *   - Local sink: addon's audit-logger (trading ops)
 *   - Minitok sink: core audit log (forensic + cross-addon correlation)
 *   - Remote sink: optional HTTP POST (SIEM / compliance dashboard)
 *   - Each event is classified into categories: trading, constitution,
 *     escalation, lifecycle, goal, error — routed to matching sinks
 *
 * Usage:
 *   const { createAuditFederation } = require("./src/core/audit-federation");
 *   const fed = createAuditFederation({
 *     localAudit: audit,
 *     minitokAudit: require("minitok-client-release/src/core/audit"),
 *     remoteEndpoint: process.env.AUDIT_REMOTE_URL,
 *   });
 *   fed.write("constitution_violation", { ... });
 */

const DEFAULTS = Object.freeze({
  enabled: process.env.AUDIT_FEDERATION_ENABLED !== "false",
  remoteEnabled: !!process.env.AUDIT_REMOTE_URL,
  remoteUrl: process.env.AUDIT_REMOTE_URL || null,
  remoteTimeoutMs: Number(process.env.AUDIT_REMOTE_TIMEOUT_MS || 3000),
  maxHistorySize: Number(process.env.AUDIT_FEDERATION_MAX_HISTORY || 1000),
  routes: null,
});

const BUILTIN_ROUTES = Object.freeze({
  trading: ["order", "decision", "signal", "fallback", "halt", "resume", "phase"],
  constitution: ["constitution_violation", "hard_limit", "risk_limit_breach"],
  escalation: ["escalation_created", "escalation_response", "escalation_timeout"],
  lifecycle: ["lifecycle_propose", "lifecycle_promote", "lifecycle_retire", "lifecycle_review"],
  goal: ["goal_started", "goal_completed", "goal_failed", "goal_cancelled"],
  error: ["error", "api_failure", "llm_failure", "data_drift"],
  self_heal: ["self_heal_triggered", "self_heal_resolved", "self_heal_escalation"],
  killswitch: ["killswitch_triggered", "killswitch_recovered"],
});

function createAuditFederation(options) {
  const opts = options || {};
  const cfg = Object.assign({}, DEFAULTS, opts.config || {});
  const localAudit = opts.localAudit || null;
  const minitokAudit = opts.minitokAudit || null;
  const remoteEndpoint = opts.remoteEndpoint || cfg.remoteUrl || null;
  const fetchImpl = opts.fetch || (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null);
  const now = typeof opts.now === "function" ? opts.now : function() { return Date.now(); };

  const routes = cfg.routes || BUILTIN_ROUTES;
  const history = [];
  const counters = {
    total: 0, local: 0, minitok: 0, remote: 0,
    localErrors: 0, minitokErrors: 0, remoteErrors: 0,
    byCategory: {},
  };

  function addHistory(entry) {
    history.push(entry);
    if (history.length > cfg.maxHistorySize) history.splice(0, history.length - cfg.maxHistorySize);
  }

  function classifyCategory(type) {
    for (const cat of Object.keys(routes)) {
      if (routes[cat].includes(type)) return cat;
    }
    return "other";
  }

  function shouldRouteToMinitok(category, type) {
    if (!minitokAudit) return false;
    if (category === "constitution" || category === "killswitch" || category === "escalation") return true;
    if (category === "goal" || category === "lifecycle") return true;
    return false;
  }

  function writeLocal(type, record) {
    if (!localAudit || typeof localAudit.custom !== "function") return false;
    try {
      localAudit.custom(type, record);
      counters.local++;
      return true;
    } catch (e) {
      counters.localErrors++;
      addHistory({ ts: new Date(now()).toISOString(), sink: "local", type: type, error: e && e.message ? e.message : String(e) });
      return false;
    }
  }

  function writeMinitok(type, record) {
    if (!minitokAudit || typeof minitokAudit.auditLog !== "function") return false;
    try {
      const result = minitokAudit.auditLog({ type: "addon-" + type, source: "tossinvest", data: record });
      if (result && result.persisted) { counters.minitok++; return true; }
      counters.minitokErrors++;
      addHistory({ ts: new Date(now()).toISOString(), sink: "minitok", type: type, error: "persistence_failed" });
      return false;
    } catch (e) {
      counters.minitokErrors++;
      addHistory({ ts: new Date(now()).toISOString(), sink: "minitok", type: type, error: e && e.message ? e.message : String(e) });
      return false;
    }
  }
  async function writeRemote(type, record) {
    if (!remoteEndpoint || !fetchImpl) return false;
    const body = { type: type, source: "tossinvest", timestamp: new Date(now()).toISOString(), data: record };
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    let timer = null;
    if (ctrl) timer = setTimeout(function() { try { ctrl.abort(); } catch {} }, cfg.remoteTimeoutMs);
    try {
      const resp = await fetchImpl(remoteEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (timer) clearTimeout(timer);
      if (resp && resp.ok) { counters.remote++; return true; }
      counters.remoteErrors++;
      addHistory({ ts: new Date(now()).toISOString(), sink: "remote", type: type, error: "http_" + (resp ? resp.status : "unknown") });
      return false;
    } catch (e) {
      if (timer) clearTimeout(timer);
      counters.remoteErrors++;
      addHistory({ ts: new Date(now()).toISOString(), sink: "remote", type: type, error: e && e.message ? e.message : String(e) });
      return false;
    }
  }

  function write(type, payload) {
    if (!cfg.enabled) return { local: false, minitok: false, remote: false, category: "disabled" };
    counters.total++;
    const category = classifyCategory(type);
    counters.byCategory[category] = (counters.byCategory[category] || 0) + 1;
    const record = Object.assign({}, payload || {}, { federationCategory: category });
    const localOk = writeLocal(type, record);
    const minitokOk = shouldRouteToMinitok(category, type) ? writeMinitok(type, record) : false;
    const remoteResult = cfg.remoteEnabled ? writeRemote(type, record) : Promise.resolve(false);
    return { local: localOk, minitok: minitokOk, remote: remoteResult, category: category };
  }

  function stats() {
    return {
      enabled: cfg.enabled,
      remoteEnabled: cfg.remoteEnabled,
      remoteUrl: remoteEndpoint,
      sinks: {
        local: !!localAudit,
        minitok: !!minitokAudit,
        remote: cfg.remoteEnabled && !!remoteEndpoint,
      },
      counters: Object.assign({}, counters, { byCategory: Object.assign({}, counters.byCategory) }),
    };
  }

  function getHistory(limit) {
    if (!limit || limit <= 0) return history.slice();
    return history.slice(-limit);
  }

  function getRoutes() {
    const out = {};
    for (const k of Object.keys(routes)) out[k] = routes[k].slice();
    return out;
  }

  return {
    write: write,
    stats: stats,
    getHistory: getHistory,
    getRoutes: getRoutes,
    classifyCategory: classifyCategory,
    BUILTIN_ROUTES: BUILTIN_ROUTES,
  };
}

module.exports = { createAuditFederation, BUILTIN_ROUTES, DEFAULTS };


