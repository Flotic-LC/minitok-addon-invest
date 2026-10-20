"use strict";

/**
 * Multi-account manager — rotates trades across multiple Toss accounts
 * with per-account state tracking and allocation strategies.
 *
 * Strategies: round_robin | least_utilized | weighted | fixed
 *
 * Usage:
 *   const mgr = createMultiAccountManager({
 *     accounts: [{ id: "A", clientSeq: "1", weight: 0.6, dailyMaxKrw: 5000000 }],
 *     strategy: "round_robin",
 *   });
 *   const acct = mgr.selectAccount(1000000);
 *   mgr.recordTrade(acct.id, 1000000);
 */

const STRATEGIES = Object.freeze({
  ROUND_ROBIN: "round_robin",
  LEAST_UTILIZED: "least_utilized",
  WEIGHTED: "weighted",
  FIXED: "fixed",
});

const DEFAULTS = Object.freeze({
  strategy: STRATEGIES.ROUND_ROBIN,
  defaultDailyMaxKrw: Number(process.env.MA_DEFAULT_DAILY_MAX_KRW || 5000000),
  fixedAccountId: process.env.MA_FIXED_ACCOUNT_ID || null,
});

function createMultiAccountManager(options = {}) {
  const p = { ...DEFAULTS, ...options };
  const accounts = (options.accounts || []).map(a => ({
    id: a.id,
    clientSeq: a.clientSeq,
    weight: Number(a.weight) || 1,
    dailyMaxKrw: Number(a.dailyMaxKrw) || p.defaultDailyMaxKrw,
    dailyTradedKrw: 0,
    totalTradedKrw: 0,
    tradeCount: 0,
    lastTradedAt: null,
    enabled: a.enabled !== false,
    meta: a.meta || {},
  }));

  if (accounts.length === 0) {
    throw new Error("multi-account: at least one account is required");
  }

  let rrIndex = 0;
  let resetDate = new Date().toISOString().slice(0, 10);

  function resetDailyIfNeeded() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== resetDate) {
      for (const a of accounts) a.dailyTradedKrw = 0;
      resetDate = today;
    }
  }

  function enabledAccounts() {
    return accounts.filter(a => a.enabled);
  }

  function utilization(a) {
    return a.dailyMaxKrw > 0 ? a.dailyTradedKrw / a.dailyMaxKrw : 1;
  }

  function selectAccount(orderValueKrw = 0) {
    resetDailyIfNeeded();
    const enabled = enabledAccounts();
    if (enabled.length === 0) return null;
    const candidates = enabled.filter(a => a.dailyTradedKrw + orderValueKrw <= a.dailyMaxKrw);
    if (candidates.length === 0) return null;

    switch (p.strategy) {
      case STRATEGIES.FIXED: {
        return candidates.find(a => a.id === p.fixedAccountId) || candidates[0];
      }
      case STRATEGIES.LEAST_UTILIZED: {
        candidates.sort((a, b) => utilization(a) - utilization(b));
        return candidates[0];
      }
      case STRATEGIES.WEIGHTED: {
        const total = candidates.reduce((s, a) => s + a.weight, 0);
        let r = Math.random() * total;
        for (const a of candidates) { r -= a.weight; if (r <= 0) return a; }
        return candidates[candidates.length - 1];
      }
      case STRATEGIES.ROUND_ROBIN:
      default: {
        const start = rrIndex % enabled.length;
        for (let i = 0; i < enabled.length; i++) {
          const a = enabled[(start + i) % enabled.length];
          if (candidates.includes(a)) {
            rrIndex = (start + i + 1) % enabled.length;
            return a;
          }
        }
        return candidates[0];
      }
    }
  }

  function recordTrade(accountId, orderValueKrw) {
    resetDailyIfNeeded();
    const a = accounts.find(acc => acc.id === accountId);
    if (!a) return false;
    a.dailyTradedKrw += Number(orderValueKrw) || 0;
    a.totalTradedKrw += Number(orderValueKrw) || 0;
    a.tradeCount += 1;
    a.lastTradedAt = new Date().toISOString();
    return true;
  }

  function enable(id) { const a = accounts.find(x => x.id === id); if (a) { a.enabled = true; return true; } return false; }
  function disable(id) { const a = accounts.find(x => x.id === id); if (a) { a.enabled = false; return true; } return false; }

  function list() {
    return accounts.map(a => ({
      id: a.id, clientSeq: a.clientSeq, enabled: a.enabled, weight: a.weight,
      dailyMaxKrw: a.dailyMaxKrw, dailyTradedKrw: a.dailyTradedKrw,
      totalTradedKrw: a.totalTradedKrw, tradeCount: a.tradeCount,
      lastTradedAt: a.lastTradedAt,
      utilizationPct: Number((utilization(a) * 100).toFixed(1)),
    }));
  }

  function report() {
    resetDailyIfNeeded();
    return {
      accountCount: accounts.length,
      enabledCount: enabledAccounts().length,
      totalTradedKrw: accounts.reduce((s, a) => s + a.totalTradedKrw, 0),
      todayTradedKrw: accounts.reduce((s, a) => s + a.dailyTradedKrw, 0),
      strategy: p.strategy,
      accounts: list(),
    };
  }

  function reset() {
    for (const a of accounts) {
      a.dailyTradedKrw = 0; a.totalTradedKrw = 0;
      a.tradeCount = 0; a.lastTradedAt = null; a.enabled = true;
    }
    rrIndex = 0;
  }

  return { selectAccount, recordTrade, enable, disable, list, report, reset, STRATEGIES };
}

module.exports = { createMultiAccountManager, STRATEGIES, DEFAULTS };
