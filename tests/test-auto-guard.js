"use strict";

/**
 * Auto-guard and shadow-mode safety tests.
 *
 * [2026-10-21 6단계] The automation must not be able to raise the risk on a
 * bad sample, and every change it makes has to be explainable and
 * reversible. These tests fix that behaviour.
 */

const test = require("node:test");
const assert = require("node:assert");
const { admitProposal, createChangeLedger, evaluateDegradation, DEFAULTS } = require("../src/agent/auto-guard");
const { createShadowMode } = require("../src/orchestrator/shadow-mode");

function evidence(over) {
  return Object.assign({
    dataValid: true,
    apiError: false,
    trades: 120,
    trainingBars: 500,
    oosBars: 120,
    costsReflected: true,
    standardError: 0.05,
    inSample: { netExpectancy: 1.2, sharpe: 1.1, maxDrawdownPct: 6, trades: 120 },
    outOfSample: { netExpectancy: 0.6, sharpe: 0.8, maxDrawdownPct: 8, trades: 60 },
    baseline: { netExpectancy: 0.2, sharpe: 0.4, maxDrawdownPct: 10 },
  }, over || {});
}

function proposal(over) {
  return Object.assign({
    param: "STOP_LOSS_PCT",
    currentValue: -8,
    proposedValue: -7.7,
    evidence: evidence(),
    expectedEffect: "a slightly tighter stop reduces the loss per trade",
  }, over || {});
}

// ---------------------------------------------------------------------------
// The admission gate
// ---------------------------------------------------------------------------

test("a well evidenced proposal is admitted", function () {
  const r = admitProposal(proposal());
  assert.strictEqual(r.allowed, true, r.reason || "");
  assert.strictEqual(r.checks.significance, true);
  assert.strictEqual(r.checks.costsReflected, true);
});

test("a proposal with no trades is refused", function () {
  const r = admitProposal(proposal({ evidence: evidence({ trades: 0 }) }));
  assert.strictEqual(r.allowed, false);
  assert.ok(/trade/.test(r.reason), r.reason);
});

test("a proposal built on invalid data is refused", function () {
  const r = admitProposal(proposal({ evidence: evidence({ dataValid: false }) }));
  assert.strictEqual(r.allowed, false);
  assert.ok(/validation/.test(r.reason), r.reason);
});

test("a proposal built on a failed API call is refused", function () {
  const r = admitProposal(proposal({ evidence: evidence({ apiError: true }) }));
  assert.strictEqual(r.allowed, false);
  assert.ok(/API/.test(r.reason), r.reason);
});

test("a proposal without the transaction costs is refused", function () {
  const r = admitProposal(proposal({ evidence: evidence({ costsReflected: false }) }));
  assert.strictEqual(r.allowed, false);
  assert.ok(/cost/.test(r.reason), r.reason);
});

test("a proposal with too little out-of-sample data is refused", function () {
  const r = admitProposal(proposal({ evidence: evidence({ oosBars: 10 }) }));
  assert.strictEqual(r.allowed, false);
  assert.ok(/out-of-sample/.test(r.reason), r.reason);
});

test("a proposal with too little training data is refused", function () {
  const r = admitProposal(proposal({ evidence: evidence({ trainingBars: 20 }) }));
  assert.strictEqual(r.allowed, false);
  assert.ok(/training/.test(r.reason), r.reason);
});

test("an insignificant improvement is refused", function () {
  const r = admitProposal(proposal({ evidence: evidence({ standardError: 0.5 }) }));
  assert.strictEqual(r.allowed, false);
  assert.ok(/standard error/.test(r.reason), r.reason);
});

test("a proposal that breaks the drawdown limit is refused", function () {
  const r = admitProposal(proposal({
    evidence: evidence({ outOfSample: { netExpectancy: 0.6, sharpe: 0.8, maxDrawdownPct: 40, trades: 60 } }),
  }));
  assert.strictEqual(r.allowed, false);
  assert.ok(/drawdown/.test(r.reason), r.reason);
});

test("a proposal that does not beat the running configuration is refused", function () {
  const r = admitProposal(proposal({
    evidence: evidence({
      inSample: { netExpectancy: 0.1, sharpe: 0.1, maxDrawdownPct: 12, trades: 120 },
      outOfSample: { netExpectancy: 0.1, sharpe: 0.1, maxDrawdownPct: 8, trades: 60 },
      baseline: { netExpectancy: 0.2, sharpe: 0.4, maxDrawdownPct: 10 },
    }),
  }));
  assert.strictEqual(r.allowed, false);
  assert.ok(/does not beat/.test(r.reason), r.reason);
});

test("a proposal that only improved in sample is judged overfit and refused", function () {
  const r = admitProposal(proposal({
    evidence: evidence({
      inSample: { netExpectancy: 5.0, sharpe: 3.0, maxDrawdownPct: 3, trades: 200 },
      outOfSample: { netExpectancy: 0.1, sharpe: 0.1, maxDrawdownPct: 8, trades: 60 },
      baseline: { netExpectancy: 0.2, sharpe: 0.4, maxDrawdownPct: 10 },
    }),
  }));
  assert.strictEqual(r.allowed, false);
  assert.ok(/OVERFIT/.test(r.reason), r.reason);
});

test("a proposal that changes the parameter too much is refused", function () {
  const r = admitProposal(proposal({ proposedValue: -2 }));
  assert.strictEqual(r.allowed, false);
  assert.ok(/limit/.test(r.reason), r.reason);
});

test("the guard refuses everything when there is no evidence at all", function () {
  const r = admitProposal({ param: "STOP_LOSS_PCT", currentValue: -8, proposedValue: -7.7, evidence: null });
  assert.strictEqual(r.allowed, false);
});

// ---------------------------------------------------------------------------
// The change ledger
// ---------------------------------------------------------------------------

test("the ledger records the change, the evidence, the sample and the result", function () {
  const ledger = createChangeLedger({ now: function () { return 1700000000000; } });
  const e = ledger.record({
    param: "STOP_LOSS_PCT", before: -8, after: -7.7, changePct: 6.25,
    evidence: evidence(), sampleCount: 120,
    expectedEffect: "a tighter stop", actualResult: null, status: "proposed",
  });
  assert.ok(e.id);
  assert.strictEqual(e.before, -8);
  assert.strictEqual(e.after, -7.7);
  assert.strictEqual(e.sampleCount, 120);
  assert.strictEqual(e.expectedEffect, "a tighter stop");
  assert.strictEqual(e.rollback.available, true);
  ledger.recordResult(e.id, { verdict: "applied", metrics: { winRate: 0.5 } });
  assert.strictEqual(ledger.ledger()[0].actualResult.verdict, "applied");
  ledger.markRolledBack(e.id, "the drawdown grew");
  assert.strictEqual(ledger.ledger()[0].status, "rolled_back");
  assert.strictEqual(ledger.ledger()[0].rollback.available, false);
});

test("the ledger survives a restart", function () {
  const l1 = createChangeLedger({ now: function () { return 1700000000000; } });
  l1.record({ param: "TAKE_PROFIT_PCT", before: 8, after: 9, sampleCount: 90 });
  const l2 = createChangeLedger();
  l2.restore(l1.state());
  assert.strictEqual(l2.size(), 1);
  assert.strictEqual(l2.ledger()[0].param, "TAKE_PROFIT_PCT");
});

// ---------------------------------------------------------------------------
// The degradation detection
// ---------------------------------------------------------------------------

test("a fall in the win rate is a degradation", function () {
  const d = evaluateDegradation({ winRate: 0.5, trades: 100 }, { winRate: 0.3, trades: 100 });
  assert.strictEqual(d.degraded, true);
});

test("a stable win rate with a collapsing expectancy is a degradation", function () {
  const d = evaluateDegradation(
    { winRate: 0.5, netExpectancy: 1.0, maxDrawdownPct: 8 },
    { winRate: 0.5, netExpectancy: 0.2, maxDrawdownPct: 9, trades: 100 }
  );
  assert.strictEqual(d.degraded, true);
  assert.ok(/expectancy/.test(d.reason), d.reason);
});

test("a growing drawdown is a degradation", function () {
  const d = evaluateDegradation(
    { winRate: 0.5, netExpectancy: 1.0, maxDrawdownPct: 5 },
    { winRate: 0.5, netExpectancy: 1.0, maxDrawdownPct: 12, trades: 100 }
  );
  assert.strictEqual(d.degraded, true);
});

test("a healthy shadow is not a degradation", function () {
  const d = evaluateDegradation(
    { winRate: 0.5, netExpectancy: 1.0, maxDrawdownPct: 8 },
    { winRate: 0.52, netExpectancy: 1.1, maxDrawdownPct: 8, trades: 100 }
  );
  assert.strictEqual(d.degraded, false);
});

test("too few trades is not a degradation", function () {
  const d = evaluateDegradation({ winRate: 0.5 }, { winRate: 0.5, trades: 3 });
  assert.strictEqual(d.degraded, false);
});

// ---------------------------------------------------------------------------
// The shadow mode
// ---------------------------------------------------------------------------

test("an automated proposal without valid evidence is refused", function () {
  const shadow = createShadowMode({ now: function () { return 1700000000000; } });
  const r = shadow.propose("STOP_LOSS_PCT", -8, -7.7, { source: "evolution", reason: "the backtest said so" });
  assert.strictEqual(r.ok, false);
  assert.ok(/auto-guard/.test(r.reason), r.reason);
});

test("an automated proposal with valid evidence is accepted", function () {
  const shadow = createShadowMode({ now: function () { return 1700000000000; } });
  const r = shadow.propose("STOP_LOSS_PCT", -8, -7.7, {
    source: "evolution", reason: "the out-of-sample window improved",
    evidence: evidence(), sampleCount: 120, expectedEffect: "a tighter stop",
    baselineWinRate: 0.5, baselineTrades: 120,
  });
  assert.strictEqual(r.ok, true, r.reason || "");
  assert.strictEqual(r.entry.source, "evolution");
  assert.strictEqual(r.entry.sampleCount, 120);
});

test("an operator's own change is not second-guessed by the gate", function () {
  const shadow = createShadowMode({ now: function () { return 1700000000000; } });
  const r = shadow.propose("STOP_LOSS_PCT", -8, -7.7, { source: "manual", reason: "the operator set it" });
  assert.strictEqual(r.ok, true, r.reason || "");
});

test("the ledger explains every change that was proposed", function () {
  const shadow = createShadowMode({ now: function () { return 1700000000000; } });
  shadow.propose("STOP_LOSS_PCT", -8, -7.7, {
    source: "evolution", evidence: evidence(), sampleCount: 120,
    expectedEffect: "a tighter stop", baselineWinRate: 0.5, baselineTrades: 120,
  });
  const l = shadow.getLedger();
  assert.strictEqual(l.length, 1);
  assert.strictEqual(l[0].before, -8);
  assert.strictEqual(l[0].after, -7.7);
  assert.strictEqual(l[0].source, "evolution");
  assert.ok(l[0].evidence);
  assert.strictEqual(l[0].expectedEffect, "a tighter stop");
});

test("a shadow that degrades on the expectancy is rolled back", function () {
  let t = 1700000000000;
  const shadow = createShadowMode({ now: function () { return t; } });
  const rolled = [];
  shadow.propose("STOP_LOSS_PCT", -8, -7.7, {
    source: "evolution", evidence: evidence(), sampleCount: 120,
    baselineWinRate: 0.5, baselineNetExpectancy: 1.0, baselineMaxDrawdownPct: 8, baselineTrades: 120,
  });
  t += 8 * 86400000;
  const res = shadow.tick({ winRate: 0.5, netExpectancy: 0.1, maxDrawdownPct: 9, trades: 120 });
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].action, "rolled_back");
  assert.ok(/expectancy/.test(res[0].entry.rollbackReason), res[0].entry.rollbackReason);
});

test("a healthy shadow is applied and records what it actually did", function () {
  let t = 1700000000000;
  const shadow = createShadowMode({ now: function () { return t; } });
  shadow.propose("STOP_LOSS_PCT", -8, -7.7, {
    source: "evolution", evidence: evidence(), sampleCount: 120,
    expectedEffect: "a tighter stop",
    baselineWinRate: 0.5, baselineNetExpectancy: 1.0, baselineMaxDrawdownPct: 8, baselineTrades: 120,
  });
  t += 8 * 86400000;
  const res = shadow.tick({ winRate: 0.52, netExpectancy: 1.1, maxDrawdownPct: 8, trades: 120 });
  assert.strictEqual(res[0].action, "applied");
  assert.strictEqual(res[0].entry.actualResult.verdict, "applied");
  assert.strictEqual(res[0].entry.actualResult.metrics.winRate, 0.52);
});

test("the shadow state survives a restart", function () {
  let t = 1700000000000;
  const s1 = createShadowMode({ now: function () { return t; } });
  s1.propose("STOP_LOSS_PCT", -8, -7.7, {
    source: "evolution", evidence: evidence(), sampleCount: 120, baselineWinRate: 0.5, baselineTrades: 120,
  });
  const s2 = createShadowMode({ now: function () { return t; } });
  s2.restore(s1.state());
  assert.strictEqual(s2.getShadows().length, 1);
  assert.strictEqual(s2.getShadows()[0].evidence.trades, 120);
});

test("the daily change limit still holds for automated proposals", function () {
  const shadow = createShadowMode({ now: function () { return 1700000000000; } });
  const first = shadow.propose("STOP_LOSS_PCT", -8, -7.7, {
    source: "evolution", evidence: evidence(), sampleCount: 120, baselineWinRate: 0.5, baselineTrades: 120,
  });
  assert.strictEqual(first.ok, true, first.reason || "");
  const second = shadow.propose("TAKE_PROFIT_PCT", 8, 8.3, {
    source: "evolution", evidence: evidence(), sampleCount: 120, baselineWinRate: 0.5, baselineTrades: 120,
  });
  assert.strictEqual(second.ok, false);
  assert.ok(/daily limit/.test(second.reason), second.reason);
});

test("the guard's defaults are the documented ones", function () {
  assert.strictEqual(DEFAULTS.minTrades, 30);
  assert.strictEqual(DEFAULTS.minOosBars, 60);
  assert.ok(DEFAULTS.minZScore >= 1);
  assert.ok(DEFAULTS.maxDrawdownPct > 0);
});
