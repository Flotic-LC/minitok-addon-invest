"use strict";

/**
 * Killswitch — immediate trading halt on critical conditions.
 *
 * Conditions from constitution.yaml:
 *   1. daily_loss >= daily_max_loss_pct (3%)
 *   2. consecutive_losses >= 10
 *   3. api_failures >= 5 AND ai_failures >= 5
 *   4. total_exposure > max_total_exposure_pct * 1.1
 *   5. vix > 40
 *
 * Recovery requires human approval and 24-hour cooldown.
 *
 * Usage:
 *   const { createKillswitch } = require("./src/orchestrator/killswitch");
 *   const ks = createKillswitch({ onHalt: (reason) => {...} });
 *   ks.check({ dailyLossPct: 3.5 }); // triggers halt
 *   const state = ks.state(); // { halted: true, reason: "..." }
 */

const DEFAULT_CONFIG = Object.freeze({
  dailyMaxLossPct: 3.0,
  consecutiveLossLimit: 10,
  apiFailureLimit: 5,
  aiFailureLimit: 5,
  maxTotalExposurePct: 85.0,
  vixCrisisThreshold: 40,
  minCooldownHours: 24,
  recoveryRequiresApproval: true,
});

function createKillswitch(options = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(options.config || {}) };
  const onHalt = options.onHalt || function() {};
  const onRecovery = options.onRecovery || function() {};
  const now = options.now || function() { return Date.now(); };

  let halted = false;
  let haltReason = null;
  let haltedAt = null;
  const history = [];

  // Evaluate all killswitch conditions
  function check(metrics) {
    if (halted) return { halted: true, blocked: true, reason: haltReason };

    const m = metrics || {};
    // The side of the order being checked. Conditions that describe the risk
    // a NEW position would add must not be applied to a SELL.
    const side = String(m.side || "").toUpperCase();
    const isSell = side === "SELL";
    let trigger = null;    // latches the kill-switch: trading stops entirely
    let softBlock = null;  // blocks this order only, no latch

    // Condition 1: Daily loss limit
    if (m.dailyLossPct != null && m.dailyLossPct >= cfg.dailyMaxLossPct) {
      trigger = "Daily loss limit reached (" + m.dailyLossPct.toFixed(2) + "% >= " + cfg.dailyMaxLossPct + "%)";
    }
    // Condition 2: Consecutive losses
    else if (m.consecutiveLosses != null && m.consecutiveLosses >= cfg.consecutiveLossLimit) {
      trigger = cfg.consecutiveLossLimit + " consecutive losing trades";
    }
    // Condition 3: Both API and AI failing
    else if (m.apiFailures != null && m.aiFailures != null &&
             m.apiFailures >= cfg.apiFailureLimit && m.aiFailures >= cfg.aiFailureLimit) {
      trigger = "Both API and AI providers failing (" + m.apiFailures + " API + " + m.aiFailures + " AI failures)";
    }
    // Condition 5: VIX crisis
    else if (m.vix != null && m.vix > cfg.vixCrisisThreshold) {
      trigger = "Extreme market volatility (VIX " + m.vix + " > " + cfg.vixCrisisThreshold + ")";
    }

    // Condition 4: Exposure breach by >10% — an ENTRY-side limit.
    //
    // [2026-10-21] This used to latch the kill-switch like the conditions
    // above. An over-exposed book is exactly the state in which the bot must
    // be able to SELL, and a latched kill-switch froze it out of exactly
    // those trades: every BUY and every SELL was refused and the book could
    // never come back under the cap. It now blocks new BUYs only, and it
    // never latches. The per-order exposure layer (src/agent/exposure.js)
    // remains the hard, direction-aware enforcement of the cap.
    if (!isSell && m.totalExposurePct != null && m.totalExposurePct > cfg.maxTotalExposurePct * 1.1) {
      softBlock = "Exposure limit exceeded: current exposure " + m.totalExposurePct.toFixed(1) + "% is over the " + (cfg.maxTotalExposurePct * 1.1).toFixed(1) + "% tolerance (limit " + cfg.maxTotalExposurePct + "% plus 10%)";
    }

    if (trigger) {
      halted = true;
      haltReason = trigger;
      haltedAt = new Date(now()).toISOString();
      history.push({ ts: haltedAt, event: "halted", reason: trigger });
      onHalt(trigger);
    }

    return { halted, blocked: halted || !!softBlock, reason: trigger || softBlock, softBlock: !!softBlock };
  }

  // Attempt recovery (requires cooldown + optional approval)
  function attemptRecovery(approved) {
    if (!halted) return { ok: true, reason: "not halted" };

    const cooldownMs = cfg.minCooldownHours * 3600000;
    const elapsed = now() - new Date(haltedAt).getTime();

    if (elapsed < cooldownMs) {
      return { ok: false, reason: "cooldown not elapsed (" + Math.round(elapsed / 60000) + "min / " + cfg.minCooldownHours + "h)" };
    }
    if (cfg.recoveryRequiresApproval && !approved) {
      return { ok: false, reason: "recovery requires human approval" };
    }

    halted = false;
    haltReason = null;
    history.push({ ts: new Date(now()).toISOString(), event: "recovered" });
    onRecovery();
    return { ok: true, reason: "recovered" };
  }

  function state() {
    return { halted, reason: haltReason, haltedAt, history: history.slice() };
  }

  function stats() {
    return {
      halted,
      reason: haltReason,
      totalHalts: history.filter(h => h.event === "halted").length,
      totalRecoveries: history.filter(h => h.event === "recovered").length,
    };
  }

  function reset() {
    halted = false;
    haltReason = null;
    haltedAt = null;
    history.length = 0;
  }

  return { check, attemptRecovery, state, stats, reset };
}

module.exports = { createKillswitch, DEFAULT_CONFIG };