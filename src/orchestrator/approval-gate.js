"use strict";

/**
 * Approval Gate — human-in-the-loop confirmation for high-risk actions.
 *
 * Gates from constitution.yaml:
 *   - new_symbol: adding unseen symbols to universe
 *   - large_position: orders > 15% of equity
 *   - significant_param_change: parameter changes > 10%
 *   - regime_strategy_change: switching strategy per regime
 *
 * Each gate has a timeout; if not approved within timeout, the action is rejected.
 *
 * Usage:
 *   const { createApprovalGate } = require("./src/orchestrator/approval-gate");
 *   const gate = createApprovalGate({ notify: (msg) => sendTelegram(msg) });
 *   const id = gate.request("new_symbol", { symbol: "GOOGL" });
 *   gate.approve(id); // or gate.reject(id);
 *   const status = gate.status(id);
 */

const DEFAULT_CONFIG = Object.freeze({
  newSymbol: { requireApproval: true, timeoutSec: 3600 },
  largePosition: { requireApproval: true, thresholdPct: 15.0, timeoutSec: 1800 },
  significantParamChange: { requireApproval: true, maxChangePct: 10.0, timeoutSec: 7200 },
  regimeStrategyChange: { requireApproval: true, timeoutSec: 3600 },
});

let _idCounter = 0;

function createApprovalGate(options = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(options.config || {}) };
  const notify = options.notify || function() {};
  const now = options.now || function() { return Date.now(); };

  const pending = new Map(); // id -> request
  const resolved = []; // completed requests

  function request(type, details) {
    const id = "approval_" + (++_idCounter) + "_" + now();
    const timeoutCfg = cfg[type] ? cfg[type].timeoutSec : 3600;
    const entry = {
      id,
      type,
      details: details || {},
      requestedAt: new Date(now()).toISOString(),
      expiresAt: new Date(now() + timeoutCfg * 1000).toISOString(),
      status: "pending", // pending | approved | rejected | expired
      resolvedAt: null,
      resolvedBy: null,
    };
    pending.set(id, entry);
    notify("[APPROVAL REQUIRED] " + type + ": " + JSON.stringify(details || {}).slice(0, 200));
    return id;
  }

  function approve(id, approver) {
    const entry = pending.get(id);
    if (!entry) return { ok: false, reason: "request not found" };
    if (entry.status !== "pending") return { ok: false, reason: "already resolved: " + entry.status };
    if (new Date(now()) > new Date(entry.expiresAt)) {
      entry.status = "expired";
      entry.resolvedAt = new Date(now()).toISOString();
      pending.delete(id);
      resolved.push(entry);
      return { ok: false, reason: "request expired" };
    }
    entry.status = "approved";
    entry.resolvedAt = new Date(now()).toISOString();
    entry.resolvedBy = approver || "human";
    pending.delete(id);
    resolved.push(entry);
    return { ok: true, entry };
  }

  function reject(id, approver, reason) {
    const entry = pending.get(id);
    if (!entry) return { ok: false, reason: "request not found" };
    if (entry.status !== "pending") return { ok: false, reason: "already resolved: " + entry.status };
    entry.status = "rejected";
    entry.resolvedAt = new Date(now()).toISOString();
    entry.resolvedBy = approver || "human";
    entry.rejectReason = reason || null;
    pending.delete(id);
    resolved.push(entry);
    return { ok: true, entry };
  }

  function status(id) {
    const entry = pending.get(id) || resolved.find(r => r.id === id);
    return entry || null;
  }

  function getPending() { return Array.from(pending.values()); }
  function getResolved() { return resolved.slice(); }

  // Expire any timed-out requests
  function expireStale() {
    const nowTime = now();
    for (const [id, entry] of pending.entries()) {
      if (nowTime > new Date(entry.expiresAt).getTime()) {
        entry.status = "expired";
        entry.resolvedAt = new Date(now()).toISOString();
        pending.delete(id);
        resolved.push(entry);
      }
    }
  }

  function stats() {
    return {
      pending: pending.size,
      approved: resolved.filter(r => r.status === "approved").length,
      rejected: resolved.filter(r => r.status === "rejected").length,
      expired: resolved.filter(r => r.status === "expired").length,
    };
  }

  function clear() {
    pending.clear();
    resolved.length = 0;
  }

  return { request, approve, reject, status, getPending, getResolved, expireStale, stats, clear };
}

module.exports = { createApprovalGate, DEFAULT_CONFIG };