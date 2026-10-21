"use strict";

/**
 * Shadow Mode — self-modification with safety observation period.
 *
 * Proposed parameter changes run in "shadow" for a configurable observation
 * period (default 7 days per constitution). After the period ends, if
 * performance has not degraded, the change is auto-applied. If win rate
 * drops by more than the degradation threshold, auto-rollback.
 *
 * Constitution constraints enforced:
 *   - max_daily_param_change_pct: 5%
 *   - max_weekly_param_change_pct: 15%
 *   - shadow_mode_min_days: 7
 *   - protected_params: never modifiable
 *   - degradation_threshold_pct: 20%
 *
 * Usage:
 *   const { createShadowMode } = require("./src/orchestrator/shadow-mode");
 *   const shadow = createShadowMode({ constitution, onChange, onRollback });
 *   shadow.propose("STOP_LOSS_PCT", -2.0, -2.5, { reason: "backtest" });
 *   shadow.tick({ winRate: 0.55, totalTrades: 100 });
 */

const { admitProposal, evaluateDegradation } = require("../agent/auto-guard");

/**
 * The sources whose proposals are made by the automation itself.
 *
 * [2026-10-21 6단계] The guard applies to the changes the automation
 * proposes. A parameter an operator changes on purpose is a human decision
 * and is not second-guessed by a statistical gate; a parameter the evolution
 * engine, the walk-forward validator or the backtest feedback proposes is
 * exactly the thing that must not be allowed to raise the risk on a bad
 * sample.
 */
const AUTOMATED_SOURCES = Object.freeze(["evolution", "walk-forward", "backtest", "auto-loop", "tuner", "meta-cognition"]);

const DEFAULT_CONSTITUTION = Object.freeze({
  maxDailyParamChangePct: 5.0,
  maxWeeklyParamChangePct: 15.0,
  shadowModeMinDays: 7,
  degradationThresholdPct: 20.0,
  modifiableParams: [
    "STOP_LOSS_PCT", "TAKE_PROFIT_PCT", "TRAILING_STOP_PCT",
    "RSI_BUY_THRESHOLD", "RSI_SELL_THRESHOLD", "POSITION_SIZE_PCT",
    "ADAPTIVE_TARGET_OFFSET",
  ],
  protectedParams: [
    "DAILY_MAX_LOSS_PCT", "MAX_SINGLE_POSITION_PCT",
    "MAX_TOTAL_EXPOSURE_PCT", "MAX_OPEN_POSITIONS", "MIN_CASH_RESERVE_PCT",
  ],
});

function createShadowMode(options = {}) {
  const constitution = { ...DEFAULT_CONSTITUTION, ...(options.constitution || {}) };
  const onChange = options.onChange || function() {};
  const onRollback = options.onRollback || function() {};
  const now = options.now || function() { return Date.now(); };

  const activeParams = new Map();
  const shadows = [];
  const history = [];
  let dailyChanges = { date: null, totalPct: 0 };
  let weeklyChanges = { weekStart: null, totalPct: 0 };

  function getToday() { return new Date(now()).toISOString().slice(0, 10); }
  function getWeekStart() {
    const d = new Date(now());
    const day = d.getUTCDay();
    const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), diff)).toISOString().slice(0, 10);
  }

  function isProtected(param) { return constitution.protectedParams.includes(param); }
  function isModifiable(param) { return constitution.modifiableParams.includes(param); }

  function checkDailyLimit(changePct) {
    const today = getToday();
    if (dailyChanges.date !== today) dailyChanges = { date: today, totalPct: 0 };
    if (dailyChanges.totalPct + Math.abs(changePct) > constitution.maxDailyParamChangePct) {
      return { ok: false, reason: "daily limit (" + (dailyChanges.totalPct + Math.abs(changePct)).toFixed(1) + "% > " + constitution.maxDailyParamChangePct + "%)" };
    }
    return { ok: true };
  }

  function checkWeeklyLimit(changePct) {
    const ws = getWeekStart();
    if (weeklyChanges.weekStart !== ws) weeklyChanges = { weekStart: ws, totalPct: 0 };
    if (weeklyChanges.totalPct + Math.abs(changePct) > constitution.maxWeeklyParamChangePct) {
      return { ok: false, reason: "weekly limit exceeded" };
    }
    return { ok: true };
  }

  // Propose a parameter change (enters shadow observation)
  function propose(param, currentValue, proposedValue, meta) {
    if (isProtected(param)) {
      return { ok: false, reason: param + " is protected and cannot be modified" };
    }
    if (!isModifiable(param)) {
      return { ok: false, reason: param + " is not in the modifiable params list" };
    }
    if (currentValue === 0) {
      return { ok: false, reason: "cannot compute change % from zero current value" };
    }
    // [2026-10-21 6단계] The admission gate for an automated proposal.
    //
    // Before this, the only question was how large the change was. The
    // evidence behind it was never examined, so a backtest with zero trades,
    // a negative return or an overfitted in-sample result could reach
    // "applied" as long as the change was small. The guard refuses it.
    const _source = (meta && meta.source) || null;
    let _guard = null;
    if (_source && AUTOMATED_SOURCES.indexOf(_source) >= 0) {
      _guard = admitProposal({
        param: param,
        currentValue: currentValue,
        proposedValue: proposedValue,
        evidence: (meta && meta.evidence) || null,
        expectedEffect: (meta && meta.expectedEffect) || null,
      }, options.guardConfig);
      if (!_guard.allowed) {
        return { ok: false, reason: "the auto-guard refused this proposal: " + _guard.reason, checks: _guard.checks, source: _source };
      }
    }
    const changePct = Math.abs(((proposedValue - currentValue) / Math.abs(currentValue)) * 100);
    const daily = checkDailyLimit(changePct);
    if (!daily.ok) return daily;
    const weekly = checkWeeklyLimit(changePct);
    if (!weekly.ok) return weekly;

    const entry = {
      id: "shadow_" + now() + "_" + param,
      param,
      currentValue,
      proposedValue,
      changePct: Number(changePct.toFixed(2)),
      reason: (meta && meta.reason) || "auto",
      proposedAt: new Date(now()).toISOString(),
      shadowDays: constitution.shadowModeMinDays,
      baselineWinRate: (meta && meta.baselineWinRate) || null,
      baselineTrades: (meta && meta.baselineTrades) || 0,
      // [2026-10-21 6단계] The degradation check needs more than the win
      // rate: the net expectancy and the drawdown of the configuration that
      // is running now are the reference the shadow is compared against.
      baselineNetExpectancy: (meta && meta.baselineNetExpectancy != null) ? meta.baselineNetExpectancy : null,
      baselineMaxDrawdownPct: (meta && meta.baselineMaxDrawdownPct != null) ? meta.baselineMaxDrawdownPct : null,
      // [2026-10-21 6단계] The traceability of the change: who proposed it,
      // on what evidence, how many observations it was based on, what was
      // expected of it, and what it actually did. A change that cannot be
      // explained from this record did not come from here.
      source: _source || "manual",
      evidence: (meta && meta.evidence) || null,
      sampleCount: (meta && meta.sampleCount) || (meta && meta.baselineTrades) || 0,
      expectedEffect: (meta && meta.expectedEffect) || null,
      actualResult: null,
      guardChecks: _guard ? _guard.checks : null,
      rollback: { available: true, reason: null, at: null },
      status: "observing",
      appliedAt: null,
      rolledBackAt: null,
    };
    shadows.push(entry);
    dailyChanges.totalPct += changePct;
    weeklyChanges.totalPct += changePct;
    history.push({ ts: entry.proposedAt, event: "proposed", param, changePct: entry.changePct });
    return { ok: true, entry };
  }

  // Called daily with current performance metrics
  function tick(metrics) {
    const results = [];
    for (let i = shadows.length - 1; i >= 0; i--) {
      const s = shadows[i];
      if (s.status !== "observing") continue;
      const proposed = new Date(s.proposedAt);
      const elapsed = Math.floor((now() - proposed.getTime()) / 86400000);

      // Check degradation during observation.
      // [2026-10-21 6단계] The win rate alone is a poor detector: a strategy
      // can hold its win rate and still lose money, because the losses grew.
      // The net expectancy and the drawdown are checked as well.
      const _deg = evaluateDegradation({
        winRate: s.baselineWinRate,
        netExpectancy: (s.baselineNetExpectancy != null) ? s.baselineNetExpectancy : null,
        maxDrawdownPct: (s.baselineMaxDrawdownPct != null) ? s.baselineMaxDrawdownPct : null,
      }, metrics, { degradationThresholdPct: constitution.degradationThresholdPct });
      if (_deg.degraded) {
        s.status = "rolled_back";
        s.rolledBackAt = new Date(now()).toISOString();
        s.rollbackReason = _deg.reason;
        s.rollback = { available: false, reason: _deg.reason, at: s.rolledBackAt };
        s.actualResult = { metrics: metrics || null, verdict: "degraded" };
        history.push({ ts: s.rolledBackAt, event: "rolled_back", param: s.param, reason: s.rollbackReason });
        onRollback(s);
        results.push({ action: "rolled_back", entry: s });
        continue;
      }

      // Check if shadow period has elapsed
      if (elapsed >= s.shadowDays) {
        s.status = "applied";
        s.appliedAt = new Date(now()).toISOString();
        // [2026-10-21 6단계] What the change actually did, recorded next to
        // what it was expected to do.
        s.actualResult = { metrics: metrics || null, verdict: "applied" };
        activeParams.set(s.param, s.proposedValue);
        history.push({ ts: s.appliedAt, event: "applied", param: s.param, value: s.proposedValue, expectedEffect: s.expectedEffect, actualResult: s.actualResult });
        onChange(s);
        results.push({ action: "applied", entry: s });
      }
    }
    return results;
  }

  function getActiveParams() {
    const obj = {};
    for (const [k, v] of activeParams) obj[k] = v;
    return obj;
  }

  function getShadows() { return shadows.filter(s => s.status === "observing"); }
  function getHistory() { return history.slice(); }

  // [2026-10-21 6단계] The change ledger and its persistence. Every automatic
  // change has to survive a restart with its evidence, its sample size, its
  // expected effect and its actual result intact, otherwise it cannot be
  // explained later - and a change that cannot be explained cannot be
  // rolled back.
  function getLedger() { return shadows.map(function (s) {
    return {
      id: s.id, param: s.param, source: s.source,
      before: s.currentValue, after: s.proposedValue, changePct: s.changePct,
      evidence: s.evidence, sampleCount: s.sampleCount,
      expectedEffect: s.expectedEffect, actualResult: s.actualResult,
      status: s.status, rollback: s.rollback,
      proposedAt: s.proposedAt, appliedAt: s.appliedAt, rolledBackAt: s.rolledBackAt,
      rollbackReason: s.rollbackReason || null,
    };
  }); }

  function state() {
    return {
      shadows: shadows.slice(),
      history: history.slice(),
      activeParams: Array.from(activeParams.entries()),
      dailyChanges: dailyChanges,
      weeklyChanges: weeklyChanges,
    };
  }

  function restore(s) {
    if (!s || typeof s !== "object") return;
    if (Array.isArray(s.shadows)) {
      shadows.length = 0;
      for (const e of s.shadows) if (e && e.id) shadows.push(e);
    }
    if (Array.isArray(s.history)) {
      history.length = 0;
      for (const e of s.history) if (e) history.push(e);
    }
    if (Array.isArray(s.activeParams)) {
      activeParams.clear();
      for (const e of s.activeParams) if (Array.isArray(e)) activeParams.set(e[0], e[1]);
    }
    if (s.dailyChanges) dailyChanges = s.dailyChanges;
    if (s.weeklyChanges) weeklyChanges = s.weeklyChanges;
  }

  function stats() {
    return {
      activeOverrides: activeParams.size,
      observing: shadows.filter(s => s.status === "observing").length,
      applied: shadows.filter(s => s.status === "applied").length,
      rolledBack: shadows.filter(s => s.status === "rolled_back").length,
      dailyChangeUsed: dailyChanges.totalPct,
      weeklyChangeUsed: weeklyChanges.totalPct,
    };
  }

  function clear() {
    activeParams.clear();
    shadows.length = 0;
    history.length = 0;
  }

  return { propose, tick, getActiveParams, getShadows, getHistory, getLedger, state, restore, stats, clear };
}

module.exports = { createShadowMode, DEFAULT_CONSTITUTION };
