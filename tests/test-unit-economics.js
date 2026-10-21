"use strict";

/**
 * Unit economics tests.
 *
 * [2026-10-21 8단계] The costs here are FAKE costs with a known answer, so
 * that the arithmetic of the margin, the segmentation and the policy is
 * pinned. Two properties matter more than the arithmetic: a cost that is
 * not measured must never be presented as measured, and an expensive
 * customer must never simply be switched off.
 */

const test = require("node:test");
const assert = require("node:assert");
const ue = require("../src/ops/unit-economics");

/** A cost model with known unit prices, in cents. */
const COSTS = {
  llm: { perCall: 1, per1kTokens: 10, source: "measured", label: "model API" },
  broker: { perCall: 2, source: "measured", label: "broker API" },
  marketData: { perCall: 1, source: "measured", label: "market data" },
  notification: { perMessage: 3, source: "measured", label: "notifications" },
  storage: { perMbMonth: 1, source: "measured", label: "storage" },
  server: { perCpuSecond: 0, perMemoryMbHour: 0, source: "estimated", label: "server compute" },
  browser: { perRun: 0, source: "estimated", label: "headless browser" },
};

test("the ledger counts the model calls and the provider's own tokens", function () {
  const l = ue.createUsageLedger({ account: "acct-1", now: function () { return Date.parse("2026-10-21T10:00:00Z"); } });
  l.llm({ prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 });
  l.llm({ prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 });
  const s = l.snapshot();
  assert.strictEqual(s.account, "acct-1");
  assert.strictEqual(s.month, "2026-10");
  assert.strictEqual(s.usage.llmCalls, 2);
  assert.strictEqual(s.usage.llmTotalTokens, 2700);
  assert.strictEqual(s.usage.llmPromptTokens, 2200);
});

test("the ledger counts the broker calls per operation", function () {
  const l = ue.createUsageLedger({ account: "acct-1" });
  l.broker("/v1/holdings");
  l.broker("/v1/holdings");
  l.broker("/v1/orderbook");
  const s = l.snapshot();
  assert.strictEqual(s.usage.brokerCalls, 3);
  assert.strictEqual(s.usage.brokerOps["/v1/holdings"], 2);
  assert.strictEqual(s.usage.brokerOps["/v1/orderbook"], 1);
});

test("a new month starts a new ledger", function () {
  const t = Date.parse("2026-10-31T23:59:00Z");
  const l = ue.createUsageLedger({ account: "a", now: function () { return t; } });
  l.llm({ total_tokens: 100 });
  l.llm({ total_tokens: 100 }, { at: t + 60000 });
  const s = l.snapshot();
  assert.strictEqual(s.month, "2026-11");
  assert.strictEqual(s.usage.llmCalls, 1, "the new month starts from zero");
});

test("the cost of an account is the sum of the priced lines", function () {
  const usage = {
    llmCalls: 10, llmTotalTokens: 5000, brokerCalls: 20, marketDataCalls: 5,
    notifications: 2, logBytes: 1024 * 1024, browserRuns: 0, trades: 3, realizedPnl: 0,
  };
  const c = ue.computeCost(usage, COSTS);
  // 10 calls + 5k tokens = 10 + 50 = 60; 20 broker = 40; 5 market data = 5; 2 notifications = 6; 1MB = 1.
  assert.strictEqual(c.total, 60 + 40 + 5 + 6 + 1);
  assert.strictEqual(c.estimatedOnly, false, "the measured items make the total a measurement");
});

test("a cost that is not measured is labelled as an estimate and says so", function () {
  const zero = ue.DEFAULT_COSTS;
  const c = ue.computeCost({ llmCalls: 100, llmTotalTokens: 100000 }, zero);
  assert.strictEqual(c.estimatedOnly, true);
  for (const item of c.items) assert.strictEqual(item.source, "estimated");
});

test("the margin separates the revenue from the cost", function () {
  const econ = ue.computeAccountEconomics({
    account: "acct-1", planId: "level1", costs: COSTS,
    usage: { llmCalls: 10, llmTotalTokens: 5000, brokerCalls: 20, marketDataCalls: 5, notifications: 2, logBytes: 1048576 },
  });
  // the price is 899 cents (8.99 USD) and the cost is 112 cents.
  assert.strictEqual(econ.revenue, 899);
  assert.strictEqual(econ.cost.total, 112);
  assert.strictEqual(econ.margin, 787);
  assert.ok(econ.marginPct > 87);
  assert.strictEqual(econ.marginIsEstimated, false);
});

test("an account whose cost is only estimated is flagged, not presented as profitable", function () {
  const econ = ue.computeAccountEconomics({
    account: "acct-1", planId: "level1", costs: ue.DEFAULT_COSTS,
    usage: { llmCalls: 10, llmTotalTokens: 5000 },
  });
  assert.strictEqual(econ.marginIsEstimated, true);
  assert.ok(econ.flags.some(function (f) { return /estimated/.test(f); }));
});

test("a trial account that costs money is flagged", function () {
  const econ = ue.computeAccountEconomics({
    account: "acct-1", planId: "trial", costs: COSTS,
    usage: { llmCalls: 100, llmTotalTokens: 100000, brokerCalls: 500 },
  });
  assert.strictEqual(econ.revenue, 0);
  assert.ok(econ.margin < 0);
  assert.ok(econ.flags.some(function (f) { return /pays nothing/.test(f); }));
});

test("the usage patterns are separated", function () {
  const seg = ue.segmentAccount({ llmCalls: 5, llmTotalTokens: 100, trades: 0, realizedPnl: 0 }, {});
  assert.ok(seg.segments.indexOf(ue.SEGMENTS.LOW_USAGE) >= 0);

  const busy = ue.segmentAccount({ llmCalls: 900, llmTotalTokens: 900000, trades: 120, realizedPnl: -900 }, {});
  assert.ok(busy.segments.indexOf(ue.SEGMENTS.HIGH_USAGE) >= 0);
  assert.ok(busy.segments.indexOf(ue.SEGMENTS.HIGH_TRADE_FREQUENCY) >= 0);
  assert.ok(busy.segments.indexOf(ue.SEGMENTS.HIGH_LLM_COST) >= 0);
  assert.ok(busy.segments.indexOf(ue.SEGMENTS.BIG_LOSS) >= 0);
});

test("an expensive account is throttled or downgraded, not switched off", function () {
  const econ = { marginPct: -20 };
  const p = ue.decideCostPolicy({
    economics: econ, usage: { days: { today: { llmCalls: 10, brokerCalls: 10, notifications: 0 } } },
    controls: { minMarginPct: 0 },
  });
  assert.strictEqual(p.action, "throttle");
  assert.ok(/do not switch the customer off/.test(p.reason));
});

test("only the abuse quota can deny", function () {
  const p = ue.decideCostPolicy({
    economics: { marginPct: 50 },
    usage: { days: { today: { llmCalls: 100, brokerCalls: 10, notifications: 0 } } },
    controls: { dailyLlmCalls: 50 },
  });
  assert.strictEqual(p.action, "deny");
  assert.ok(/quota/.test(p.reason));
});

test("a cheap-model fallback is offered when the token usage crosses the threshold", function () {
  const p = ue.decideCostPolicy({
    economics: { marginPct: 50 },
    usage: { llmTotalTokens: 900000, days: { today: {} } },
    controls: { cheapModelAfterTokens: 500000 },
  });
  assert.strictEqual(p.action, "downgrade");
  assert.ok(/cheaper model/.test(p.reason));
});

test("a price change does not touch the plan ids or the entitlements", function () {
  const now = Date.parse("2026-10-21T00:00:00Z");
  const plan = ue.planPriceMigration({
    accounts: [
      { account: "old", plan: "level1", startedAt: now - 5 * 86400000, price: 899 },
      { account: "new", plan: "level1", startedAt: now - 60 * 86400000, price: 899 },
    ],
    noticeDays: 30,
    newPrice: { amount: 1299 },
    now: now,
  });
  assert.strictEqual(plan.grandfathered.length, 1);
  assert.strictEqual(plan.grandfathered[0].account, "old");
  assert.strictEqual(plan.grandfathered[0].price, 899, "the customer keeps the price they paid");
  assert.strictEqual(plan.migrated.length, 1);
  assert.strictEqual(plan.migrated[0].to, 1299);
  assert.ok(plan.notices.some(function (n) { return /entitlement/.test(n); }));
  assert.ok(plan.notices.some(function (n) { return /plan ids/.test(n); }));
});

test("the control options are offered with their trade-offs", function () {
  assert.ok(ue.CONTROL_OPTIONS.length >= 4);
  for (const o of ue.CONTROL_OPTIONS) {
    assert.ok(o.key && o.what && o.effect && o.cost, "the option " + o.key + " is not described");
  }
});
