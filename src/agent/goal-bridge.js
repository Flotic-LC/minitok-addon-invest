"use strict";

/**
 * Goal-Agent ↔ Phase L Bridge (P1-4) — bridges minitok's goal lifecycle
 * system with the addon's strategy lifecycle manager.
 *
 * Architecture:
 *   - Each strategy proposal is compiled into a minitok-compatible goal spec
 *   - Promotions and retirements are reflected as goal state transitions
 *   - The bridge is opt-in: if MINITOK_CLIENT_ROOT is unavailable or the
 *     goal compiler rejects a spec, Phase L continues working standalone
 *
 * Usage:
 *   const { createGoalBridge } = require("./src/agent/goal-bridge");
 *   const bridge = createGoalBridge({
 *     lifecycleManager,
 *     goalClient,            // optional: minitok goal-tools module
 *     workspaceRoot,         // optional: goal repo root
 *   });
 *   bridge.attach();         // hooks onPromote/onRetire/onReview
 *   const spec = bridge.specFor(strategy);
 *   bridge.onPromote(id, phase, alloc);
 */

const DEFAULTS = Object.freeze({
  enabled: process.env.GOAL_BRIDGE_ENABLED !== "false",
  autoStartGoals: process.env.GOAL_BRIDGE_AUTO_START === "true",
  maxHistorySize: Number(process.env.GOAL_BRIDGE_MAX_HISTORY || 500),
  goalIdPrefix: "tossinvest-strategy-",
  now: null,
});

const PHASE_TO_GOAL_STATE = Object.freeze({
  DISCOVERY: "prepared",
  INCUBATION: "running",
  PRODUCTION: "running",
  RETIREMENT: "failed",
});

function resolveGoalClient() {
  const root = process.env.MINITOK_CLIENT_ROOT || null;
  if (!root) return null;
  try {
    const path = require("node:path");
    return require(path.join(root, "src", "mcp", "goal-tools"));
  } catch (e) {
    return null;
  }
}

function createGoalBridge(options) {
  const opts = options || {};
  const cfg = Object.assign({}, DEFAULTS, opts.config || {});
  const lifecycleManager = opts.lifecycleManager || null;
  const goalClient = opts.goalClient || resolveGoalClient();
  const workspaceRoot = opts.workspaceRoot || process.env.MINITOK_CLIENT_ROOT || null;
  const now = typeof cfg.now === "function" ? cfg.now : function() { return Date.now(); };

  const goalIds = new Map();
  const history = [];
  const counters = { proposals: 0, promotions: 0, retirements: 0, reviews: 0, goalStarts: 0, goalErrors: 0 };

  function addHistory(event, payload) {
    const entry = Object.assign({ ts: new Date(now()).toISOString(), event: event }, payload || {});
    history.push(entry);
    if (history.length > cfg.maxHistorySize) history.splice(0, history.length - cfg.maxHistorySize);
    return entry;
  }

  function goalIdFor(strategyId) {
    return cfg.goalIdPrefix + String(strategyId).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  }

  function specFor(strategy) {
    if (!strategy || !strategy.id || !strategy.name) return null;
    const id = goalIdFor(strategy.id);
    const criteria = [];
    if (strategy.hypothesis) {
      criteria.push({
        id: "hypothesis-validated",
        description: "Strategy hypothesis validated via walk-forward OOS test",
        required: true,
        verifier: { type: "custom", id: "walk-forward-oos", config: { strategyId: strategy.id } },
      });
    }
    if (criteria.length === 0) {
      criteria.push({
        id: "strategy-accepted",
        description: "Strategy proposal accepted by council for incubation",
        required: true,
        verifier: { type: "custom", id: "council-approval", config: { strategyId: strategy.id } },
      });
    }
    return {
      source: "goal-bridge",
      strategyId: strategy.id,
      goalId: id,
      spec: {
        schema_version: 1,
        goal_id: id,
        objective: "Deploy and validate strategy " + strategy.name,
        success_criteria: criteria,
        constraints: {
          allowed_paths: [],
          blocked_paths: [".git", ".env"],
          max_cycles: 30,
          timeout_ms: 0,
          requires_approval_for: ["live-trade"],
        },
        execution_policy: { mode: "safe" },
      },
    };
  }

  function startGoalFor(strategy) {
    if (!goalClient || !workspaceRoot || !cfg.autoStartGoals) return null;
    const compiled = specFor(strategy);
    if (!compiled) return null;
    try {
      const result = goalClient.startGoal(
        { goal_spec: compiled.spec, repo: workspaceRoot, mode: "safe" },
        { workspaceRoot: workspaceRoot, actor: { id: "addon-tossinvest", type: "agent" } },
      );
      goalIds.set(strategy.id, compiled.goalId);
      counters.goalStarts++;
      addHistory("goal_started", { strategyId: strategy.id, goalId: compiled.goalId });
      return result;
    } catch (e) {
      counters.goalErrors++;
      addHistory("goal_start_error", { strategyId: strategy.id, error: e && e.message ? e.message : String(e) });
      return null;
    }
  }

  function onPromote(strategyId, phase, allocationPct) {
    counters.promotions++;
    const goalId = goalIds.get(strategyId);
    addHistory("promote", { strategyId: strategyId, phase: phase, allocationPct: allocationPct, goalId: goalId || null });
    if (!goalId || !goalClient) return { bridged: false };
    try {
      const result = goalClient.continueGoal(
        { goal_id: goalId, repo: workspaceRoot, notes: "promoted to " + phase + " at " + (allocationPct * 100).toFixed(0) + "%" },
        { workspaceRoot: workspaceRoot },
      );
      return { bridged: true, result: result };
    } catch (e) {
      counters.goalErrors++;
      addHistory("continue_error", { strategyId: strategyId, goalId: goalId, error: e && e.message ? e.message : String(e) });
      return { bridged: false, error: e && e.message ? e.message : String(e) };
    }
  }

  function onRetire(strategyId, reason, fromPhase) {
    counters.retirements++;
    const goalId = goalIds.get(strategyId);
    addHistory("retire", { strategyId: strategyId, reason: reason, fromPhase: fromPhase, goalId: goalId || null });
    if (!goalId || !goalClient) return { bridged: false };
    try {
      const result = goalClient.cancelGoal(
        { goal_id: goalId, repo: workspaceRoot, reason: "retired: " + reason },
        { workspaceRoot: workspaceRoot },
      );
      goalIds.delete(strategyId);
      return { bridged: true, result: result };
    } catch (e) {
      counters.goalErrors++;
      addHistory("cancel_error", { strategyId: strategyId, goalId: goalId, error: e && e.message ? e.message : String(e) });
      return { bridged: false, error: e && e.message ? e.message : String(e) };
    }
  }

  function onReview(strategyId, reason, metricsSnapshot) {
    counters.reviews++;
    addHistory("review", {
      strategyId: strategyId, reason: reason,
      sharpe60d: metricsSnapshot && metricsSnapshot.sharpe60d,
      goalId: goalIds.get(strategyId) || null,
    });
    return { bridged: false };
  }

  function attach() {
    if (!lifecycleManager) return { attached: false, reason: "no_lifecycle_manager" };
    return { attached: true, goalClientAvailable: !!goalClient, workspaceRoot: workspaceRoot };
  }

  function stats() {
    return {
      enabled: cfg.enabled,
      goalClientAvailable: !!goalClient,
      workspaceRoot: workspaceRoot,
      activeGoalMappings: goalIds.size,
      counters: Object.assign({}, counters),
    };
  }

  function getHistory(limit) {
    if (!limit || limit <= 0) return history.slice();
    return history.slice(-limit);
  }

  function state() {
    return {
      goalIds: Array.from(goalIds.entries()),
      history: history.slice(),
      counters: Object.assign({}, counters),
    };
  }

  function restore(snap) {
    if (!snap) return;
    if (Array.isArray(snap.goalIds)) {
      goalIds.clear();
      for (const entry of snap.goalIds) {
        if (Array.isArray(entry) && entry.length === 2) goalIds.set(entry[0], entry[1]);
      }
    }
    if (Array.isArray(snap.history)) {
      history.length = 0;
      for (const e of snap.history) history.push(e);
    }
    if (snap.counters) Object.assign(counters, snap.counters);
  }

  return {
    specFor: specFor,
    startGoalFor: startGoalFor,
    onPromote: onPromote,
    onRetire: onRetire,
    onReview: onReview,
    attach: attach,
    stats: stats,
    getHistory: getHistory,
    state: state,
    restore: restore,
  };
}

module.exports = { createGoalBridge, PHASE_TO_GOAL_STATE, DEFAULTS };
