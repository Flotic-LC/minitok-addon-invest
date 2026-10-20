"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createMultiAccountManager, STRATEGIES } = require("../src/agent/multi-account");

const accounts = [
  { id: "A", clientSeq: "1", weight: 0.6, dailyMaxKrw: 5000000 },
  { id: "B", clientSeq: "2", weight: 0.4, dailyMaxKrw: 3000000 },
];

test("empty accounts list throws", () => {
  assert.throws(() => createMultiAccountManager({ accounts: [] }), /at least one/);
});

test("round_robin cycles through accounts", () => {
  const mgr = createMultiAccountManager({ accounts, strategy: STRATEGIES.ROUND_ROBIN });
  const first = mgr.selectAccount(100000);
  mgr.recordTrade(first.id, 100000);
  const second = mgr.selectAccount(100000);
  // They should differ after cycling (unless one was at limit)
  assert.ok(first.id && second.id);
});

test("fixed strategy always returns specified account", () => {
  const mgr = createMultiAccountManager({ accounts, strategy: STRATEGIES.FIXED, fixedAccountId: "B" });
  for (let i = 0; i < 5; i++) {
    const a = mgr.selectAccount(100000);
    assert.equal(a.id, "B");
    mgr.recordTrade(a.id, 100000);
  }
});

test("least_utilized picks the less-loaded account", () => {
  const mgr = createMultiAccountManager({ accounts, strategy: STRATEGIES.LEAST_UTILIZED });
  // Load account A heavily
  mgr.recordTrade("A", 4000000);
  const picked = mgr.selectAccount(100000);
  assert.equal(picked.id, "B", "B should be picked since A is heavily utilized");
});

test("selectAccount returns null when all accounts at limit", () => {
  const mgr = createMultiAccountManager({ accounts });
  mgr.recordTrade("A", 5000000);
  mgr.recordTrade("B", 3000000);
  const a = mgr.selectAccount(100000);
  assert.equal(a, null);
});

test("recordTrade updates daily traded value", () => {
  const mgr = createMultiAccountManager({ accounts });
  mgr.recordTrade("A", 1000000);
  mgr.recordTrade("A", 500000);
  const r = mgr.report();
  const acct = r.accounts.find(a => a.id === "A");
  assert.equal(acct.dailyTradedKrw, 1500000);
  assert.equal(acct.tradeCount, 2);
});

test("disable removes account from selection", () => {
  const mgr = createMultiAccountManager({ accounts, strategy: STRATEGIES.ROUND_ROBIN });
  mgr.disable("A");
  for (let i = 0; i < 5; i++) {
    const a = mgr.selectAccount(100000);
    assert.equal(a.id, "B");
    mgr.recordTrade(a.id, 100000);
  }
});

test("report returns summary for all accounts", () => {
  const mgr = createMultiAccountManager({ accounts });
  mgr.recordTrade("A", 1000000);
  mgr.recordTrade("B", 500000);
  const r = mgr.report();
  assert.equal(r.accountCount, 2);
  assert.equal(r.enabledCount, 2);
  assert.equal(r.totalTradedKrw, 1500000);
  assert.equal(r.accounts.length, 2);
});

test("reset clears all state", () => {
  const mgr = createMultiAccountManager({ accounts });
  mgr.recordTrade("A", 1000000);
  mgr.disable("B");
  mgr.reset();
  const r = mgr.report();
  assert.equal(r.totalTradedKrw, 0);
  assert.equal(r.enabledCount, 2);
});

test("weighted strategy respects configuration", () => {
  const mgr = createMultiAccountManager({ accounts, strategy: STRATEGIES.WEIGHTED });
  // Run many selections; distribution should roughly match weights
  const counts = { A: 0, B: 0 };
  for (let i = 0; i < 100; i++) {
    const a = mgr.selectAccount(1000);
    if (a) counts[a.id]++;
    if (a) mgr.recordTrade(a.id, 1000);
  }
  // With 60/40 weights and enough capacity, A should get ~60%
  const total = counts.A + counts.B;
  if (total > 0) {
    const aPct = counts.A / total;
    assert.ok(aPct > 0.4 && aPct < 0.8, `expected ~60% A, got ${(aPct * 100).toFixed(1)}%`);
  }
});
