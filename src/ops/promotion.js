"use strict";

/**
 * Paper trading and live promotion.
 *
 * [2026-10-21 9단계] The add-on had a DRY_RUN switch, but it was not a
 * mode: it only advanced the target engine's phase, and the phase decided
 * whether a "fake operation" was injected. There was no explicit paper
 * mode that could not reach the broker, nothing in the records said which
 * mode produced them, nothing had to pass before live trading, there was
 * no way to trade live with a fraction of the capital, and a regression
 * demoted nothing.
 *
 * This module makes the three modes explicit and the promotion a gate:
 *
 *   paper  - the default. No order can reach the broker. Every decision is
 *            recorded as a virtual fill with the expected price, the market
 *            price it would have met, the slippage it would have paid and
 *            the net result after the costs.
 *   ramped - live, but only a fraction of the capital, and only after a
 *            promotion that passed the criteria.
 *   live   - live, with the full capital, and only after the ramp passed.
 *
 * The rule that matters: **a deployment that is capable of trading live
 * still trades paper until a promotion is on file.** The capability and
 * the permission are separate.
 */

const crypto = require("crypto");

const MODES = Object.freeze({ PAPER: "paper", RAMPED: "ramped", LIVE: "live" });

/**
 * The promotion criteria. Every one of them has to pass.
 *
 * [2026-10-21 9단계] The expectancy is the AFTER-COST number: a strategy
 * that is a gross winner and a net loser must not be promoted. The
 * out-of-sample requirement is separate from the in-sample one, so a
 * strategy that only works on the data it was tuned on cannot be promoted
 * on the strength of that.
 */
const DEFAULT_CRITERIA = Object.freeze({
  minDays: 14,
  minTrades: 30,
  minNetExpectancy: 0,          // after the costs, in the account currency
  maxDrawdownPct: 15,
  maxBrokerErrorRate: 0.05,     // share of the broker calls that failed
  maxDuplicateOrders: 0,
  requireReconciliation: true,
  requireKillSwitchTest: true,
  minOutOfSampleExpectancy: 0,
});

/**
 * Resolve the mode.
 *
 * The environment says what the deployment is CAPABLE of; the promotion
 * file says what it is ALLOWED to do. The allowed mode is the lower of the
 * two, and it is paper unless a promotion is on file.
 */
function resolveTradingMode(options) {
  const opts = options || {};
  const env = opts.env || {};
  const promotion = opts.promotion || null;

  let capable = MODES.PAPER;
  const explicit = String(env.TRADING_MODE || "").trim().toLowerCase();
  if (explicit === MODES.LIVE || explicit === MODES.RAMPED || explicit === MODES.PAPER) {
    capable = explicit;
  } else if (env.DRY_RUN === "false" || env.DRY_RUN === "0" || env.DRY_RUN === "no") {
    capable = MODES.LIVE;
  }

  // The capability alone does not authorise trading.
  if (capable === MODES.PAPER) {
    return { mode: MODES.PAPER, capable: capable, reason: "the deployment is configured for paper", promotion: null };
  }
  if (!promotion || !promotion.promoted) {
    return {
      mode: MODES.PAPER,
      capable: capable,
      reason: "the deployment is capable of live trading but no promotion is on file",
      promotion: null,
    };
  }
  const stage = Number(promotion.stage) || 0;
  if (stage < 1) {
    return { mode: MODES.PAPER, capable: capable, reason: "the promotion is at stage 0 - the paper period has not been served", promotion: promotion };
  }
  if (stage === 1) {
    return { mode: MODES.RAMPED, capable: capable, reason: "ramp stage 1", promotion: promotion };
  }
  return { mode: MODES.LIVE, capable: capable, reason: "ramp stage " + stage, promotion: promotion };
}

/**
 * The capital ramp. Live trading starts with a fraction of the capital and
 * grows only when the stage is advanced.
 */
const DEFAULT_RAMP = Object.freeze([0, 0.05, 0.15, 0.35, 1.0]);

function capitalFraction(stage, ramp) {
  const r = Array.isArray(ramp) && ramp.length ? ramp : DEFAULT_RAMP;
  const i = Math.max(0, Math.min(r.length - 1, Number(stage) || 0));
  return r[i];
}

/**
 * The paper ledger: the virtual fills.
 *
 * Every field the promotion needs to judge the strategy is here, and every
 * field says which mode produced it.
 */
function createPaperLedger(options) {
  const opts = options || {};
  const now = opts.now || Date.now;
  const trades = [];

  /**
   * Record a virtual fill.
   *
   * `expectedFillPrice` is the price the decision assumed; `marketPrice` is
   * the price the market actually had when the decision was executed. The
   * difference is the slippage the paper run would have paid, and it is
   * recorded rather than assumed, because assuming it is exactly how a
   * paper run becomes a fantasy.
   */
  function record(input) {
    const side = String(input.side || "BUY").toUpperCase();
    const signalTs = Number(input.signalTimestamp) || now();
    const executionTs = Number(input.executionTimestamp) || now();
    const quantity = Number(input.quantity) || 0;
    const expected = Number(input.expectedFillPrice) || 0;
    const market = Number(input.marketPrice) || 0;
    const expectedSlippagePct = Number(input.expectedSlippagePct) || 0;
    const costPct = Number(input.costPct) || 0;

    // The fill the paper run assumes: the market price, moved against us by
    // the expected slippage.
    const adverse = side === "BUY" ? (1 + expectedSlippagePct / 100) : (1 - expectedSlippagePct / 100);
    const fillPrice = market > 0 ? market * adverse : expected;
    const slippagePct = expected > 0 && fillPrice > 0 ? (((fillPrice - expected) / expected) * 100) * (side === "BUY" ? 1 : -1) : 0;
    const grossPnl = input.entryPrice != null
      ? (side === "BUY" ? (fillPrice - Number(input.entryPrice)) : (Number(input.entryPrice) - fillPrice)) * quantity
      : 0;
    const costs = Math.abs(fillPrice * quantity * (costPct / 100));
    const netPnl = side === "SELL" ? grossPnl - costs : (input.entryPrice != null ? grossPnl - costs : 0);

    const trade = {
      mode: MODES.PAPER,
      symbol: input.symbol || null,
      side: side,
      quantity: quantity,
      strategy: input.strategy || null,
      reason: input.reason || null,
      signalTimestamp: signalTs,
      executionTimestamp: executionTs,
      expectedFillPrice: expected,
      marketPrice: market,
      expectedSlippagePct: expectedSlippagePct,
      realisedSlippagePct: Number(slippagePct.toFixed(4)),
      fillPrice: Number(fillPrice.toFixed(4)),
      entryPrice: input.entryPrice != null ? Number(input.entryPrice) : null,
      grossPnl: Number(grossPnl.toFixed(4)),
      costs: Number(costs.toFixed(4)),
      netPnl: Number(netPnl.toFixed(4)),
      costRatio: grossPnl !== 0 ? Number((costs / Math.abs(grossPnl)).toFixed(4)) : null,
    };
    trades.push(trade);
    return trade;
  }

  /** The summary the promotion is judged on. */
  function summary(options2) {
    const o = options2 || {};
    const nowTs = o.now || now();
    const closed = trades.filter(function (t) { return t.side === "SELL" && t.netPnl != null; });
    const wins = closed.filter(function (t) { return t.netPnl > 0; });
    const losses = closed.filter(function (t) { return t.netPnl < 0; });
    const grossProfit = wins.reduce(function (s, t) { return s + t.netPnl; }, 0);
    const grossLoss = Math.abs(losses.reduce(function (s, t) { return s + t.netPnl; }, 0));
    const totalCost = trades.reduce(function (s, t) { return s + (t.costs || 0); }, 0);
    const first = trades.length ? trades[0].signalTimestamp : null;
    const last = trades.length ? trades[trades.length - 1].signalTimestamp : null;
    const days = first && last ? Math.max(0, (nowTs - first) / 86400000) : 0;
    return {
      mode: MODES.PAPER,
      trades: trades.length,
      closedTrades: closed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
      netPnl: Number(closed.reduce(function (s, t) { return s + t.netPnl; }, 0).toFixed(4)),
      grossPnl: Number(closed.reduce(function (s, t) { return s + t.grossPnl; }, 0).toFixed(4)),
      totalCost: Number(totalCost.toFixed(4)),
      profitFactor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(4)) : null,
      expectancy: closed.length ? Number((closed.reduce(function (s, t) { return s + t.netPnl; }, 0) / closed.length).toFixed(4)) : 0,
      maxDrawdownPct: maxDrawdownPct(closed.map(function (t) { return t.netPnl; })),
      days: Number(days.toFixed(2)),
      outOfSample: o.outOfSample || null,
      brokerErrorRate: o.brokerErrorRate != null ? o.brokerErrorRate : null,
      duplicateOrders: o.duplicateOrders != null ? o.duplicateOrders : 0,
      reconciliationOk: o.reconciliationOk != null ? o.reconciliationOk : null,
      killSwitchTestPassed: o.killSwitchTestPassed != null ? o.killSwitchTestPassed : null,
    };
  }

  return { record: record, summary: summary, trades: trades, size: function () { return trades.length; } };
}

function maxDrawdownPct(pnls) {
  if (!pnls || !pnls.length) return 0;
  let peak = 0;
  let equity = 0;
  let maxDd = 0;
  for (const p of pnls) {
    equity += p;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }
  return peak > 0 ? Number(((maxDd / peak) * 100).toFixed(4)) : 0;
}

/**
 * The promotion decision.
 *
 * Every criterion has to pass. A missing measurement is a failure, not a
 * pass: "we do not know" must never promote a strategy to real money.
 */
function evaluatePromotion(paper, options) {
  const cfg = Object.assign({}, DEFAULT_CRITERIA, (options && options.criteria) || {});
  const p = paper || {};
  const checks = [];
  const check = function (name, ok, detail) {
    checks.push({ name: name, ok: !!ok, detail: detail });
    return !!ok;
  };

  check("the paper period is long enough", Number(p.days) >= cfg.minDays, p.days + " of " + cfg.minDays + " days");
  check("there are enough closed trades", Number(p.closedTrades) >= cfg.minTrades, p.closedTrades + " of " + cfg.minTrades);
  check("the expectancy after the costs is positive", Number(p.expectancy) > cfg.minNetExpectancy, p.expectancy + " vs " + cfg.minNetExpectancy);
  check("the drawdown is inside the limit", Number(p.maxDrawdownPct) <= cfg.maxDrawdownPct, p.maxDrawdownPct + "% vs " + cfg.maxDrawdownPct + "%");
  check("the out-of-sample expectancy is positive", p.outOfSample != null && Number(p.outOfSample.expectancy) > cfg.minOutOfSampleExpectancy, p.outOfSample ? p.outOfSample.expectancy : "not measured");
  check("the broker error rate is inside the limit", p.brokerErrorRate != null && Number(p.brokerErrorRate) <= cfg.maxBrokerErrorRate, p.brokerErrorRate != null ? p.brokerErrorRate : "not measured");
  check("there are no duplicate orders", Number(p.duplicateOrders) <= cfg.maxDuplicateOrders, String(p.duplicateOrders));
  if (cfg.requireReconciliation) {
    check("the state reconciles with the broker", p.reconciliationOk === true, String(p.reconciliationOk));
  }
  if (cfg.requireKillSwitchTest) {
    check("the kill switch test passed", p.killSwitchTestPassed === true, String(p.killSwitchTestPassed));
  }

  const failed = checks.filter(function (c) { return !c.ok; });
  return {
    promoted: failed.length === 0,
    checks: checks,
    failed: failed,
    reason: failed.length === 0 ? "every criterion passed" : failed.length + " criterion(s) did not pass",
  };
}

/**
 * The promotion record. It says who promoted it and why, and it is what the
 * audit log receives.
 */
function createPromotionRecord(options) {
  const opts = options || {};
  return {
    promoted: !!opts.promoted,
    stage: Number(opts.stage) || 0,
    at: opts.at || new Date().toISOString(),
    approver: opts.approver || null,
    reason: opts.reason || null,
    criteria: opts.criteria || null,
    capitalFraction: capitalFraction(opts.stage, opts.ramp),
    previous: opts.previous || null,
  };
}

/**
 * The demotion. A regression, a loss, a data error or a broker failure
 * sends the deployment back to the mode it came from, and the reason is
 * recorded.
 */
function evaluateDemotion(paper, options) {
  const opts = options || {};
  const cfg = Object.assign({
    maxDrawdownPct: 20, minExpectancy: 0, maxBrokerErrorRate: 0.1,
    maxDuplicateOrders: 0, requireReconciliation: true, maxDataErrorRate: 0.05,
  }, opts.criteria || {});
  const p = paper || {};
  const reasons = [];
  if (p.maxDrawdownPct != null && Number(p.maxDrawdownPct) > cfg.maxDrawdownPct) {
    reasons.push("the drawdown is " + p.maxDrawdownPct + "% (limit " + cfg.maxDrawdownPct + "%)");
  }
  if (p.expectancy != null && Number(p.expectancy) < cfg.minExpectancy) {
    reasons.push("the expectancy is " + p.expectancy + " (limit " + cfg.minExpectancy + ")");
  }
  if (p.brokerErrorRate != null && Number(p.brokerErrorRate) > cfg.maxBrokerErrorRate) {
    reasons.push("the broker error rate is " + p.brokerErrorRate + " (limit " + cfg.maxBrokerErrorRate + ")");
  }
  if (p.duplicateOrders != null && Number(p.duplicateOrders) > cfg.maxDuplicateOrders) {
    reasons.push(p.duplicateOrders + " duplicate orders");
  }
  if (p.dataErrorRate != null && Number(p.dataErrorRate) > cfg.maxDataErrorRate) {
    reasons.push("the data error rate is " + p.dataErrorRate + " (limit " + cfg.maxDataErrorRate + ")");
  }
  if (cfg.requireReconciliation && p.reconciliationOk === false) {
    reasons.push("the state no longer reconciles with the broker");
  }
  return { demote: reasons.length > 0, reasons: reasons };
}

/**
 * Sign the promotion record so it cannot be edited into existence. The
 * key is the deployment's own; the record is written by the operator and
 * read by the runner.
 */
function signPromotion(record, secret) {
  const payload = JSON.stringify({
    promoted: !!record.promoted, stage: Number(record.stage) || 0, at: record.at,
    approver: record.approver || null, reason: record.reason || null,
  });
  const sig = crypto.createHmac("sha256", String(secret || "")).update(payload).digest("hex");
  return Object.assign({}, record, { payload: payload, signature: sig });
}

function verifyPromotion(record, secret) {
  if (!record || !record.signature) return false;
  const payload = JSON.stringify({
    promoted: !!record.promoted, stage: Number(record.stage) || 0, at: record.at,
    approver: record.approver || null, reason: record.reason || null,
  });
  const expect = crypto.createHmac("sha256", String(secret || "")).update(payload).digest("hex");
  // A timing-safe compare, and a length check first.
  if (expect.length !== record.signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(record.signature));
}

module.exports = {
  MODES: MODES,
  DEFAULT_CRITERIA: DEFAULT_CRITERIA,
  DEFAULT_RAMP: DEFAULT_RAMP,
  resolveTradingMode: resolveTradingMode,
  capitalFraction: capitalFraction,
  createPaperLedger: createPaperLedger,
  evaluatePromotion: evaluatePromotion,
  evaluateDemotion: evaluateDemotion,
  createPromotionRecord: createPromotionRecord,
  signPromotion: signPromotion,
  verifyPromotion: verifyPromotion,
};
