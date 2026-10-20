"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createShadowMode } = require("../src/orchestrator/shadow-mode");

test("createShadowMode returns expected API", () => {
  const sm = createShadowMode();
  assert.equal(typeof sm.propose, "function");
  assert.equal(typeof sm.tick, "function");
  assert.equal(typeof sm.getActiveParams, "function");
  assert.equal(typeof sm.getShadows, "function");
  assert.equal(typeof sm.getHistory, "function");
  assert.equal(typeof sm.stats, "function");
  assert.equal(typeof sm.clear, "function");
});

test("propose rejects protected params", () => {
  const sm = createShadowMode();
  const r = sm.propose("DAILY_MAX_LOSS_PCT", 3.0, 2.5);
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("protected"));
});

test("propose rejects non-modifiable params", () => {
  const sm = createShadowMode();
  const r = sm.propose("UNKNOWN_PARAM", 1.0, 2.0);
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("not in the modifiable"));
});

test("propose rejects zero current value", () => {
  const sm = createShadowMode();
  const r = sm.propose("STOP_LOSS_PCT", 0, -2.0);
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("zero"));
});

test("propose creates shadow entry", () => {
  const sm = createShadowMode({ constitution: { maxDailyParamChangePct: 50, maxWeeklyParamChangePct: 100 } });
  const r = sm.propose("STOP_LOSS_PCT", -2.0, -2.5, { reason: "backtest" });
  assert.equal(r.ok, true);
  assert.equal(r.entry.param, "STOP_LOSS_PCT");
  assert.equal(r.entry.status, "observing");
  assert.equal(r.entry.changePct, 25.0);
});

test("propose enforces daily limit", () => {
  const sm = createShadowMode({ constitution: { maxDailyParamChangePct: 5.0 } });
  // First: 4% change ok
  const r1 = sm.propose("STOP_LOSS_PCT", -100, -104);
  assert.equal(r1.ok, true);
  // Second: 3% change would exceed 5% daily
  const r2 = sm.propose("TAKE_PROFIT_PCT", 100, 103);
  assert.equal(r2.ok, false);
  assert.ok(r2.reason.includes("daily"));
});

test("tick does nothing before shadow period", () => {
  let t = Date.now();
  const sm = createShadowMode({ now: () => t, constitution: { maxDailyParamChangePct: 50, maxWeeklyParamChangePct: 100 } });
  sm.propose("STOP_LOSS_PCT", -2.0, -2.5);
  t += 3 * 86400000; // 3 days < 7
  const results = sm.tick({ winRate: 0.5 });
  assert.equal(results.length, 0);
  assert.equal(sm.getShadows().length, 1);
});

test("tick applies after shadow period", () => {
  let t = Date.now();
  let applied = null;
  const sm = createShadowMode({ now: () => t, onChange: (s) => { applied = s; }, constitution: { maxDailyParamChangePct: 50, maxWeeklyParamChangePct: 100 } });
  sm.propose("STOP_LOSS_PCT", -2.0, -2.5);
  t += 8 * 86400000; // 8 days > 7
  const results = sm.tick({ winRate: 0.55 });
  assert.equal(results.length, 1);
  assert.equal(results[0].action, "applied");
  assert.ok(applied !== null);
  const active = sm.getActiveParams();
  assert.equal(active["STOP_LOSS_PCT"], -2.5);
});

test("tick rolls back on degradation", () => {
  let t = Date.now();
  let rolledBack = null;
  const sm = createShadowMode({ now: () => t, onRollback: (s) => { rolledBack = s; }, constitution: { maxDailyParamChangePct: 50, maxWeeklyParamChangePct: 100 } });
  sm.propose("STOP_LOSS_PCT", -2.0, -2.5, { baselineWinRate: 0.6 });
  t += 2 * 86400000;
  // Win rate drops 25% (from 0.6 to 0.45)
  const results = sm.tick({ winRate: 0.45 });
  assert.equal(results.length, 1);
  assert.equal(results[0].action, "rolled_back");
  assert.ok(rolledBack !== null);
  assert.ok(rolledBack.rollbackReason.includes("degraded"));
});

test("tick does not roll back if win rate stable", () => {
  let t = Date.now();
  const sm = createShadowMode({ now: () => t, constitution: { maxDailyParamChangePct: 50, maxWeeklyParamChangePct: 100 } });
  sm.propose("STOP_LOSS_PCT", -2.0, -2.5, { baselineWinRate: 0.55 });
  t += 2 * 86400000;
  const results = sm.tick({ winRate: 0.52 }); // small drop, < 20%
  assert.equal(results.length, 0);
  assert.equal(sm.getShadows().length, 1);
});

test("getActiveParams empty initially", () => {
  const sm = createShadowMode();
  assert.deepEqual(sm.getActiveParams(), {});
});

test("stats tracks correctly", () => {
  let t = Date.now();
  const sm = createShadowMode({ now: () => t, constitution: { maxDailyParamChangePct: 50, maxWeeklyParamChangePct: 100 } });
  sm.propose("STOP_LOSS_PCT", -2.0, -2.5);
  const s = sm.stats();
  assert.equal(s.observing, 1);
  assert.equal(s.applied, 0);
  assert.equal(s.rolledBack, 0);
  assert.ok(s.dailyChangeUsed > 0);
});

test("clear resets all state", () => {
  const sm = createShadowMode({ constitution: { maxDailyParamChangePct: 50, maxWeeklyParamChangePct: 100 } });
  sm.propose("STOP_LOSS_PCT", -2.0, -2.5);
  sm.clear();
  assert.equal(sm.getShadows().length, 0);
  assert.deepEqual(sm.getActiveParams(), {});
  assert.equal(sm.getHistory().length, 0);
});

test("getHistory records events", () => {
  const sm = createShadowMode({ constitution: { maxDailyParamChangePct: 50, maxWeeklyParamChangePct: 100 } });
  sm.propose("STOP_LOSS_PCT", -2.0, -2.5, { reason: "test" });
  const h = sm.getHistory();
  assert.equal(h.length, 1);
  assert.equal(h[0].event, "proposed");
  assert.equal(h[0].param, "STOP_LOSS_PCT");
});
