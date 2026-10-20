"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createKillswitch } = require("../src/orchestrator/killswitch");

test("createKillswitch returns expected API", () => {
  const ks = createKillswitch();
  assert.equal(typeof ks.check, "function");
  assert.equal(typeof ks.attemptRecovery, "function");
  assert.equal(typeof ks.state, "function");
  assert.equal(typeof ks.stats, "function");
  assert.equal(typeof ks.reset, "function");
});

test("check returns not halted initially", () => {
  const ks = createKillswitch();
  const r = ks.check({});
  assert.equal(r.halted, false);
  assert.equal(r.reason, null);
});

test("daily loss >= 3% triggers halt", () => {
  const ks = createKillswitch();
  const r = ks.check({ dailyLossPct: 3.1 });
  assert.equal(r.halted, true);
  assert.ok(r.reason.includes("Daily loss"));
});

test("daily loss below threshold does not halt", () => {
  const ks = createKillswitch();
  const r = ks.check({ dailyLossPct: 2.9 });
  assert.equal(r.halted, false);
});

test("10 consecutive losses triggers halt", () => {
  const ks = createKillswitch();
  const r = ks.check({ consecutiveLosses: 10 });
  assert.equal(r.halted, true);
  assert.ok(r.reason.includes("consecutive"));
});

test("9 consecutive losses does not halt", () => {
  const ks = createKillswitch();
  const r = ks.check({ consecutiveLosses: 9 });
  assert.equal(r.halted, false);
});

test("API+AI failures triggers halt", () => {
  const ks = createKillswitch();
  const r = ks.check({ apiFailures: 5, aiFailures: 5 });
  assert.equal(r.halted, true);
  assert.ok(r.reason.includes("API") || r.reason.includes("AI"));
});

test("only API failures does not halt", () => {
  const ks = createKillswitch();
  const r = ks.check({ apiFailures: 5, aiFailures: 2 });
  assert.equal(r.halted, false);
});

test("exposure breach >10% blocks the order without latching", () => {
  // [2026-10-21] The exposure cap is an entry-side limit. It used to latch
  // the kill-switch, which froze the bot out of the SELLs that bring an
  // over-exposed book back under the cap.
  const ks = createKillswitch();
  const r = ks.check({ totalExposurePct: 94.0, side: "BUY" }); // 85*1.1=93.5
  assert.equal(r.halted, false);
  assert.equal(r.blocked, true);
  assert.ok(r.reason.includes("Exposure"));
});

test("exposure breach does not block a SELL", () => {
  const ks = createKillswitch();
  const r = ks.check({ totalExposurePct: 94.0, side: "SELL" });
  assert.equal(r.halted, false);
  assert.equal(r.blocked, false);
  assert.equal(r.reason, null);
});

test("exposure breach does not latch the kill-switch for later SELLs", () => {
  const ks = createKillswitch();
  ks.check({ totalExposurePct: 94.0, side: "BUY" });
  assert.equal(ks.state().halted, false);
  const r = ks.check({ totalExposurePct: 94.0, side: "SELL" });
  assert.equal(r.blocked, false);
});

test("exposure within limit does not halt", () => {
  const ks = createKillswitch();
  const r = ks.check({ totalExposurePct: 90.0 });
  assert.equal(r.halted, false);
  assert.equal(r.blocked, false);
});

test("VIX > 40 triggers halt", () => {
  const ks = createKillswitch();
  const r = ks.check({ vix: 45 });
  assert.equal(r.halted, true);
  assert.ok(r.reason.includes("VIX"));
});

test("VIX <= 40 does not halt", () => {
  const ks = createKillswitch();
  const r = ks.check({ vix: 40 });
  assert.equal(r.halted, false);
});

test("onHalt callback fires on trigger", () => {
  let haltReason = null;
  const ks = createKillswitch({ onHalt: (r) => { haltReason = r; } });
  ks.check({ dailyLossPct: 4.0 });
  assert.ok(haltReason !== null);
});

test("attemptRecovery blocked during cooldown", () => {
  let t = Date.now();
  const ks = createKillswitch({ now: () => t });
  ks.check({ vix: 50 });
  const r = ks.attemptRecovery(true);
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("cooldown"));
});

test("attemptRecovery requires approval", () => {
  let t = Date.now();
  const ks = createKillswitch({ now: () => t, config: { minCooldownHours: 0 } });
  ks.check({ vix: 50 });
  const r = ks.attemptRecovery(false);
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("approval"));
});

test("attemptRecovery succeeds after cooldown + approval", () => {
  let t = Date.now();
  const ks = createKillswitch({ now: () => t, config: { minCooldownHours: 1 } });
  ks.check({ vix: 50 });
  t += 2 * 3600000; // advance 2 hours
  const r = ks.attemptRecovery(true);
  assert.equal(r.ok, true);
  assert.equal(ks.state().halted, false);
});

test("state reflects halt correctly", () => {
  const ks = createKillswitch();
  ks.check({ consecutiveLosses: 10 });
  const s = ks.state();
  assert.equal(s.halted, true);
  assert.ok(s.reason.includes("consecutive"));
  assert.ok(s.haltedAt !== null);
});

test("stats tracks halts and recoveries", () => {
  let t = Date.now();
  const ks = createKillswitch({ now: () => t, config: { minCooldownHours: 0 } });
  ks.check({ vix: 50 });
  ks.attemptRecovery(true);
  const s = ks.stats();
  assert.equal(s.totalHalts, 1);
  assert.equal(s.totalRecoveries, 1);
});

test("reset clears state", () => {
  const ks = createKillswitch();
  ks.check({ dailyLossPct: 5 });
  ks.reset();
  assert.equal(ks.state().halted, false);
  assert.equal(ks.stats().totalHalts, 0);
});
