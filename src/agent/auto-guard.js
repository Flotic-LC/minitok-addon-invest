"use strict";

/**
 * Auto-guard — the admission gate for every automatic parameter change.
 *
 * [2026-10-21 6단계] The shadow mode decided whether a change could be
 * proposed on the SIZE of the change and whether performance had degraded.
 * It never asked whether the evidence behind the change was worth anything.
 * A backtest with zero trades, a negative return, a data set that failed
 * validation, or an in-sample result that did not survive out-of-sample
 * could all reach "applied" as long as the change was small and the win rate
 * had not fallen. The measured strategy was already a net loser, so the
 * automation was the last thing that needed to be able to make it worse.
 *
 * This module is the single place that says no. Nothing that changes a live
 * parameter may skip it.
 *
 * The rules, in the order they are checked:
 *
 *   1. the evidence data must be valid, and must not have come from a
 *      failed API call;
 *   2. the evidence must contain enough trades, enough training data and
 *      enough out-of-sample data;
 *   3. the evidence must have the transaction costs included - a gross
 *      result says nothing about a strategy that pays a 74 bps round trip;
 *   4. the improvement must be statistically significant;
 *   5. the drawdown of the proposal must stay inside the limit;
 *   6. the proposal must beat the configuration that is running now;
 *   7. a change whose in-sample performance improved while its
 *      out-of-sample performance did not is OVERFIT and is refused;
 *   8. the change may not be larger than the configured magnitude.
 *
 * Every admitted change is written to a ledger that records the previous
 * and the new value, the evidence, the sample size, the expected effect,
 * the result that was actually observed and whether it was rolled back.
 */

const DEFAULTS = Object.freeze({
  // The evidence has to contain a number of closed trades that can carry a
  // conclusion. 30 is the smallest sample whose win rate means anything.
  minTrades: Number(process.env.AUTO_GUARD_MIN_TRADES || 30),
  // Bars of in-sample history.
  minTrainingBars: Number(process.env.AUTO_GUARD_MIN_TRAINING_BARS || 120),
  // Bars of out-of-sample history. The walk-forward folds are 30 bars each,
  // so this requires at least two complete folds.
  minOosBars: Number(process.env.AUTO_GUARD_MIN_OOS_BARS || 60),
  // The improvement must be this many standard errors above zero.
  minZScore: Number(process.env.AUTO_GUARD_MIN_Z || 1.5),
  // The proposal's maximum drawdown may not exceed this.
  maxDrawdownPct: Number(process.env.AUTO_GUARD_MAX_DD || 15),
  // A single change may not move a parameter by more than this.
  maxChangePct: Number(process.env.AUTO_GUARD_MAX_CHANGE_PCT || 5),
});

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function isPositive(v) { return Number.isFinite(Number(v)) && Number(v) > 0; }

/**
 * The admission decision for one proposed parameter change.
 *
 * @param {object} proposal
 *   param, currentValue, proposedValue
 *   evidence: {
 *     dataValid, apiError, trades, trainingBars, oosBars, costsReflected,
 *     inSample:  { netExpectancy, sharpe, maxDrawdownPct, trades },
 *     outOfSample: { netExpectancy, sharpe, maxDrawdownPct, trades },
 *     baseline: { netExpectancy, sharpe, maxDrawdownPct },
 *     standardError
 *   }
 *   expectedEffect (string)
 * @returns {{allowed: boolean, reason: string|null, checks: object}}
 */
function admitProposal(proposal, config) {
  const cfg = Object.assign({}, DEFAULTS, config || {});
  const p = proposal || {};
  const ev = p.evidence || {};
  const inS = ev.inSample || {};
  const outS = ev.outOfSample || {};
  const base = ev.baseline || {};
  const checks = {};

  const fail = function(reason, key) {
    checks[key] = false;
    return { allowed: false, reason: reason, checks: checks };
  };
  const pass = function(key) { checks[key] = true; };

  // 1. The data and the API.
  if (ev.apiError) return fail("the evidence came from a failed API call", "apiOk");
  pass("apiOk");
  if (ev.dataValid === false) return fail("the evidence data failed validation", "dataValid");
  pass("dataValid");

  // 2. The sample sizes.
  const trades = num(ev.trades, 0);
  if (trades < cfg.minTrades) {
    return fail("only " + trades + " closed trade(s) in the evidence (minimum " + cfg.minTrades + ")", "sampleTrades");
  }
  pass("sampleTrades");
  const trainBars = num(ev.trainingBars, 0);
  if (trainBars < cfg.minTrainingBars) {
    return fail("only " + trainBars + " training bar(s) (minimum " + cfg.minTrainingBars + ")", "trainingBars");
  }
  pass("trainingBars");
  const oosBars = num(ev.oosBars, 0);
  if (oosBars < cfg.minOosBars) {
    return fail("only " + oosBars + " out-of-sample bar(s) (minimum " + cfg.minOosBars + ")", "oosBars");
  }
  pass("oosBars");

  // 3. The costs.
  if (ev.costsReflected !== true) {
    return fail("the evidence does not include the transaction costs", "costsReflected");
  }
  pass("costsReflected");

  // 4. The significance. The out-of-sample improvement has to be more than
  //    minZ standard errors away from zero.
  const oosExp = num(outS.netExpectancy, NaN);
  const se = num(ev.standardError, NaN);
  if (!Number.isFinite(oosExp)) return fail("the out-of-sample expectancy is missing", "significance");
  if (!Number.isFinite(se) || se <= 0) {
    return fail("the standard error of the out-of-sample estimate is missing", "significance");
  }
  const z = oosExp / se;
  if (z < cfg.minZScore) {
    return fail("the out-of-sample improvement is " + z.toFixed(2) + " standard errors (minimum " + cfg.minZScore + ")", "significance");
  }
  pass("significance");

  // 5. The drawdown of the proposal.
  const oosDd = num(outS.maxDrawdownPct, NaN);
  if (!Number.isFinite(oosDd)) return fail("the out-of-sample drawdown is missing", "drawdown");
  if (oosDd > cfg.maxDrawdownPct) {
    return fail("the out-of-sample drawdown is " + oosDd.toFixed(1) + "% (limit " + cfg.maxDrawdownPct + "%)", "drawdown");
  }
  pass("drawdown");

  // 6. The overfit judgement. A change that looks better in sample and
  //    worse out of sample has learned the sample, not the market. This is
  //    checked BEFORE the plain "did it improve" test, because an overfit
  //    proposal fails both and the overfit verdict is the one that says
  //    why the automation must not learn from it.
  const baseExp = num(base.netExpectancy, 0);
  const inExp = num(inS.netExpectancy, NaN);
  if (Number.isFinite(inExp) && inExp > baseExp && oosExp <= baseExp) {
    return fail("OVERFIT: the in-sample expectancy improved (" + inExp.toFixed(3) + ") but the out-of-sample did not (" + oosExp.toFixed(3) + ")", "overfit");
  }
  pass("overfit");

  // 7. The improvement over the configuration that is running now.
  if (oosExp <= 0) return fail("the out-of-sample expectancy is not positive (" + oosExp.toFixed(3) + ")", "improvement");
  if (oosExp <= baseExp) {
    return fail("the out-of-sample expectancy " + oosExp.toFixed(3) + " does not beat the running configuration (" + baseExp.toFixed(3) + ")", "improvement");
  }
  pass("improvement");

  // 8. The magnitude of the change.
  const current = num(p.currentValue, NaN);
  const proposed = num(p.proposedValue, NaN);
  if (!Number.isFinite(current) || !Number.isFinite(proposed)) {
    return fail("the current or the proposed value is not a number", "magnitude");
  }
  if (current === 0) return fail("the current value is zero - the change size cannot be computed", "magnitude");
  const changePct = Math.abs(((proposed - current) / Math.abs(current)) * 100);
  if (changePct > cfg.maxChangePct) {
    return fail("the change is " + changePct.toFixed(2) + "% (limit " + cfg.maxChangePct + "%)", "magnitude");
  }
  pass("magnitude");

  return { allowed: true, reason: null, checks: checks, changePct: Number(changePct.toFixed(2)) };
}

/**
 * The change ledger.
 *
 * Every automatic change is recorded with the previous and the new value,
 * the evidence it was based on, the sample size, the effect that was
 * expected, the result that was actually observed and whether it was rolled
 * back. A change that cannot be explained from the ledger did not come
 * from here.
 */
function createChangeLedger(options) {
  const now = options && options.now ? options.now : function () { return Date.now(); };
  const entries = [];

  function record(entry) {
    const e = Object.assign({
      id: "chg_" + now() + "_" + ((entry && entry.param) || "unknown"),
      param: entry && entry.param,
      before: entry && entry.before,
      after: entry && entry.after,
      changePct: entry && entry.changePct,
      evidence: (entry && entry.evidence) || null,
      sampleCount: (entry && entry.sampleCount) || 0,
      expectedEffect: (entry && entry.expectedEffect) || null,
      actualResult: null,
      status: "proposed",
      rollback: { available: true, reason: null, at: null },
      createdAt: new Date(now()).toISOString(),
    }, entry || {});
    entries.push(e);
    return e;
  }

  function recordResult(id, result) {
    const e = entries.find(function (x) { return x.id === id; });
    if (!e) return null;
    e.actualResult = result || null;
    e.status = (result && result.status) || e.status;
    return e;
  }

  function markRolledBack(id, reason) {
    const e = entries.find(function (x) { return x.id === id; });
    if (!e) return null;
    e.status = "rolled_back";
    e.rollback = { available: false, reason: reason || null, at: new Date(now()).toISOString() };
    return e;
  }

  function ledger() { return entries.slice(); }
  function state() { return entries.slice(); }
  function restore(list) {
    if (!Array.isArray(list)) return;
    entries.length = 0;
    for (const e of list) if (e && e.id) entries.push(e);
  }
  function clear() { entries.length = 0; }

  return { record, recordResult, markRolledBack, ledger, state, restore, clear, size: function () { return entries.length; } };
}

/**
 * Did the performance degrade enough to roll the change back?
 *
 * The shadow mode watched the win rate. The win rate is a poor detector on
 * its own: a strategy can hold its win rate and still lose money, because
 * the losses grew. The net expectancy and the drawdown are checked too.
 */
function evaluateDegradation(baseline, current, config) {
  const cfg = Object.assign({ degradationThresholdPct: 20, minTrades: 10 }, config || {});
  const b = baseline || {};
  const c = current || {};
  const trades = num(c.trades != null ? c.trades : c.totalTrades, 0);
  // The win rate rule keeps the behaviour the shadow mode has always had: a
  // win rate that collapses by the threshold rolls the change back. It is
  // deliberately not gated on a sample size - the shadow is a safety
  // mechanism, and an early rollback is the safe direction.
  const bWin = num(b.winRate, null);
  const cWin = num(c.winRate, null);
  if (bWin != null && cWin != null && bWin > 0) {
    const drop = ((bWin - cWin) / bWin) * 100;
    if (drop >= cfg.degradationThresholdPct) {
      return { degraded: true, reason: "the win rate degraded by " + drop.toFixed(1) + "% (threshold " + cfg.degradationThresholdPct + "%)" };
    }
  }
  // The expectancy and the drawdown rules need a sample to mean anything.
  if (trades < cfg.minTrades) {
    return { degraded: false, reason: "not enough trades yet (" + trades + ")" };
  }
  const bExp = num(b.netExpectancy, null);
  const cExp = num(c.netExpectancy, null);
  if (bExp != null && cExp != null && bExp > 0 && cExp < bExp * 0.5) {
    return { degraded: true, reason: "the net expectancy degraded from " + bExp.toFixed(3) + " to " + cExp.toFixed(3) };
  }
  const bDd = num(b.maxDrawdownPct, null);
  const cDd = num(c.maxDrawdownPct, null);
  if (bDd != null && cDd != null && cDd > bDd * 1.5 && cDd > 5) {
    return { degraded: true, reason: "the drawdown degraded from " + bDd.toFixed(1) + "% to " + cDd.toFixed(1) + "%" };
  }
  return { degraded: false, reason: null };
}

module.exports = {
  admitProposal,
  createChangeLedger,
  evaluateDegradation,
  DEFAULTS,
};
