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

      // Check degradation during observation
      if (s.baselineWinRate != null && metrics && metrics.winRate != null && metrics.winRate > 0) {
        const drop = ((s.baselineWinRate - metrics.winRate) / s.baselineWinRate) * 100;
        if (drop >= constitution.degradationThresholdPct) {
          s.status = "rolled_back";
          s.rolledBackAt = new Date(now()).toISOString();
          s.rollbackReason = "win rate degraded " + drop.toFixed(1) + "% (threshold: " + constitution.degradationThresholdPct + "%)";
          history.push({ ts: s.rolledBackAt, event: "rolled_back", param: s.param, reason: s.rollbackReason });
          onRollback(s);
          results.push({ action: "rolled_back", entry: s });
          continue;
        }
      }

      // Check if shadow period has elapsed
      if (elapsed >= s.shadowDays) {
        s.status = "applied";
        s.appliedAt = new Date(now()).toISOString();
        activeParams.set(s.param, s.proposedValue);
        history.push({ ts: s.appliedAt, event: "applied", param: s.param, value: s.proposedValue });
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

  return { propose, tick, getActiveParams, getShadows, getHistory, stats, clear };
}

module.exports = { createShadowMode, DEFAULT_CONSTITUTION };
