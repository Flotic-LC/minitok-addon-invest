"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const MINITOK_ROOT = process.env.MINITOK_CLIENT_ROOT
  || path.join(__dirname, "..", "..", "minitok-client-release");
process.env.MINITOK_CLIENT_ROOT = MINITOK_ROOT;

const { createTargetEngine, TARGET_PHASES } = require("../src/agent/target");
const { createAgentTools } = require("../src/agent/tools");

function tmpStatePath() {
  return path.join(os.tmpdir(), `toss-target-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
}

function engine(overrides = {}) {
  return createTargetEngine({
    statePath: tmpStatePath(),
    now: () => Date.now(),
    ...overrides,
  });
}

function recordOps(eng, n, ok = true) {
  for (let i = 0; i < n; i += 1) {
    eng.recordOperationOutcome({ operation: "create_order", symbol: "005930", side: "BUY", quantity: 1, price: 1000, ok, code: ok ? undefined : "X", verified: ok });
  }
}

function recordReturns(eng, n, retPct, equityStart = 1000000, startDate = "2026-02-01") {
  let eq = equityStart;
  const start = new Date(startDate);
  for (let i = 0; i < n; i += 1) {
    eq = eq * (1 + retPct / 100);
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    eng.recordEquitySnapshot({ equity: eq, date: d.toISOString().slice(0, 10) });
  }
}

// ---------------------------------------------------------------------------

test("phase 0 starts with dryRun true and 1% target", () => {
  const eng = engine();
  const lim = eng.getEffectiveLimits();
  assert.equal(lim.phase, 0);
  assert.equal(lim.dryRun, true);
  assert.equal(lim.baseTargetPct, 1.0);
  assert.equal(lim.halted, false);
});

test("30 successful operation outcomes escalate phase 0 -> 1", () => {
  const eng = engine();
  recordOps(eng, 29);
  assert.equal(eng.getPhase(), 0, "still phase 0 at 29 cycles");
  recordOps(eng, 1);
  assert.equal(eng.getPhase(), 1, "escalated at 30 cycles");
  const lim = eng.getEffectiveLimits();
  assert.equal(lim.dryRun, false, "phase 1 is live");
  assert.equal(lim.baseTargetPct, 1.0);
});

test("failed operation outcomes do not count toward escalation", () => {
  const eng = engine();
  recordOps(eng, 30, false);
  assert.equal(eng.getPhase(), 0);
});

test("escalation statistical gates: good returns escalate 1 -> 2", () => {
  const eng = engine();
  recordOps(eng, 30);
  assert.equal(eng.getPhase(), 1);
  // 50 returns averaging ~1.1% — every day clears the 1% target (hitRate=1.0),
  // mean >= 0.8*target, zero drawdown -> gates open.
  recordReturns(eng, 50, 1.1);
  assert.equal(eng.getPhase(), 2, JSON.stringify(eng.getState().returnCycles.slice(-3)));
  const lim = eng.getEffectiveLimits();
  assert.equal(lim.baseTargetPct, 1.25);
  assert.equal(lim.maxOrderValueKrw, 10000000);
});
 
test("escalation statistical gates: weak returns do not escalate", () => {
  const eng = engine();
  recordOps(eng, 30);
  // 0.1% daily: all positive (so no de-escalation) but mean 0.1 < 0.8*target and
  // hitRate (vs 1% target) = 0 < 0.3 -> escalation gate closed.
  recordReturns(eng, 50, 0.1);
  assert.equal(eng.getPhase(), 1, "weak performance stays phase 1");
});
 
test("daily loss <= -1% de-escalates phase", () => {
  const eng = engine();
  recordOps(eng, 30);
  recordReturns(eng, 50, 1.1);
  assert.equal(eng.getPhase(), 2);
  // cool-down blocks any immediate re-escalation from the same snapshot window
  const hwm = eng.getState().highWaterEquity;
  eng.recordEquitySnapshot({ equity: hwm * 0.985, date: "2026-03-01" }); // -1.5%
  assert.equal(eng.getPhase(), 1, "de-escalated on daily loss");
});
 
test("hard stop <= -2% halts the engine", () => {
  const eng = engine();
  recordOps(eng, 30);
  // seed a high-water mark so the next snapshot has a real returnPct
  eng.recordEquitySnapshot({ equity: 1000000, date: "2026-02-28" });
  const hwm = eng.getState().highWaterEquity;
  eng.recordEquitySnapshot({ equity: hwm * 0.97, date: "2026-03-01" }); // -3%
  const st = eng.getState();
  assert.equal(st.haltState.halted, true);
  assert.equal(st.haltState.triggeredBy, "dailyHardStop");
  const proj = eng.project();
  assert.equal(proj.halted, true);
});
 
test("halted engine resume() clears halt", () => {
  const eng = engine();
  recordOps(eng, 30);
  eng.recordEquitySnapshot({ equity: 1000000, date: "2026-02-28" });
  const hwm = eng.getState().highWaterEquity;
  eng.recordEquitySnapshot({ equity: hwm * 0.97, date: "2026-03-01" }); // -3%
  assert.equal(eng.project().halted, true);
  eng.resume();
  assert.equal(eng.project().halted, false);
});

test("tools projection: phase 0 forces dryRun, blocks oversized orders", async () => {
  const statePath = tmpStatePath();
  const eng = createTargetEngine({ statePath });
  const tools = createAgentTools({
    credentials: { clientId: "id", clientSecret: "secret" },
    targetEngine: eng,
    dryRunDefault: false,
  });
  // oversized order for phase 0 cap (100000)
  const over = await tools.order({ target: { accountSeq: "1" }, symbol: "kr:005930", side: "BUY", orderType: "LIMIT", quantity: 10, price: 70000 });
  assert.equal(over.ok, false);
  assert.equal(over.code, "TARGET_SIZE_EXCEEDED");
});

test("tools projection: phase 0 dryRun forces simulation (no live order recorded as ok=true only if simulated)", async () => {
  const statePath = tmpStatePath();
  const eng = createTargetEngine({ statePath });
  const tools = createAgentTools({
    credentials: { clientId: "id", clientSecret: "secret" },
    targetEngine: eng,
    dryRunDefault: false,
  });
  const r = await tools.order({ target: { accountSeq: "1" }, symbol: "kr:005930", side: "BUY", orderType: "LIMIT", quantity: 1, price: 1000, dryRun: false });
  // dryRunDefault false but phase 0 forces dryRun -> simulated result
  assert.equal(r.simulated, true, JSON.stringify(r).slice(0, 300));
});

test("tools projection: halted engine blocks order with TARGET_ENGINE_HALTED", async () => {
  const statePath = tmpStatePath();
  const eng = createTargetEngine({ statePath });
  recordOps(eng, 30);
  // seed a high-water mark so the loss snapshot has a real returnPct -> halts
  eng.recordEquitySnapshot({ equity: 1000000, date: "2026-02-28" });
  const last = eng.getState().highWaterEquity;
  eng.recordEquitySnapshot({ equity: last * 0.97, date: "2026-03-01" }); // -3% -> halt
  const tools = createAgentTools({
    credentials: { clientId: "id", clientSecret: "secret" },
    targetEngine: eng,
    dryRunDefault: false,
  });
  const r = await tools.order({ target: { accountSeq: "1" }, symbol: "kr:005930", side: "BUY", orderType: "LIMIT", quantity: 1, price: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "TARGET_ENGINE_HALTED");
});

test("persistence: state survives engine recreation", () => {
  const statePath = tmpStatePath();
  const eng1 = createTargetEngine({ statePath });
  recordOps(eng1, 30);
  assert.equal(eng1.getPhase(), 1);
  // recreate
  const eng2 = createTargetEngine({ statePath });
  assert.equal(eng2.getPhase(), 1, "phase restored from file");
  assert.equal(eng2.getEffectiveLimits().dryRun, false);
});

test("tools without targetEngine behave as before (back-compat)", async () => {
  const tools = createAgentTools({
    credentials: { clientId: "id", clientSecret: "secret" },
    dryRunDefault: true,
  });
  const r = await tools.order({ target: { accountSeq: "1" }, symbol: "kr:005930", side: "BUY", orderType: "LIMIT", quantity: 1, price: 1000 });
  // no engine -> dryRunDefault true -> simulated, no TARGET_* codes
  assert.equal(r.simulated, true);
  assert.notEqual(r.code, "TARGET_ENGINE_HALTED");
});

test("TARGET_PHASES ladder is well-formed", () => {
  assert.ok(Array.isArray(TARGET_PHASES));
  assert.equal(TARGET_PHASES[0].dryRun, true);
  assert.equal(TARGET_PHASES[1].dryRun, false);
  assert.ok(TARGET_PHASES[3].targetPct > TARGET_PHASES[0].targetPct);
});

// ---------------------------------------------------------------------------
// Daily-baseline fix: edge-case tests for the hard-stop guard
// ---------------------------------------------------------------------------

test("daily baseline: first snapshot seeds baseline, returnPct = 0", () => {
  const eng = engine();
  eng.recordEquitySnapshot({ equity: 50000000, date: "2026-10-01" });
  const st = eng.getState();
  assert.equal(st.dailyBaselineEquity, 50000000);
  assert.equal(st.dailyBaselineDate, "2026-10-01");
  // First snapshot of the day: returnPct should be 0 (baseline == equity)
  const last = st.returnCycles[st.returnCycles.length - 1];
  assert.equal(last.returnPct, 0);
  assert.equal(st.haltState.halted, false, "must not halt on first snapshot");
});

test("daily baseline: date change reseeds baseline to previous close", () => {
  const eng = engine();
  // Day 1: open at 50M, close at 51M
  eng.recordEquitySnapshot({ equity: 50000000, date: "2026-10-01" });
  eng.recordEquitySnapshot({ equity: 51000000, date: "2026-10-01" });
  // Day 2: open at 51.5M — baseline should be 51M (yesterday's close)
  eng.recordEquitySnapshot({ equity: 51500000, date: "2026-10-02" });
  const st = eng.getState();
  assert.equal(st.dailyBaselineEquity, 51000000, "baseline = previous day's close");
  const last = st.returnCycles[st.returnCycles.length - 1];
  const expectedReturn = ((51500000 - 51000000) / 51000000) * 100;
  assert.ok(Math.abs(last.returnPct - expectedReturn) < 0.001,
    `returnPct should be ~${expectedReturn}%, got ${last.returnPct}`);
});

test("daily baseline: same-day snapshots keep the same baseline", () => {
  const eng = engine();
  eng.recordEquitySnapshot({ equity: 50000000, date: "2026-10-01" });
  eng.recordEquitySnapshot({ equity: 50500000, date: "2026-10-01" });
  eng.recordEquitySnapshot({ equity: 49000000, date: "2026-10-01" });
  const st = eng.getState();
  // All same-day: baseline stays at 50M (first snapshot)
  assert.equal(st.dailyBaselineEquity, 50000000);
  const last = st.returnCycles[st.returnCycles.length - 1];
  const expectedReturn = ((49000000 - 50000000) / 50000000) * 100;
  assert.ok(Math.abs(last.returnPct - expectedReturn) < 0.001);
});

test("hard stop does NOT fire in phase 0 (dry-run) even with large negative return", () => {
  const eng = engine();
  // Stay in phase 0 (no operation cycles recorded)
  assert.equal(eng.getPhase(), 0);
  // Seed baseline then record a catastrophic "return" — should NOT halt
   eng.recordEquitySnapshot({ equity: 1000000, date: "2026-10-01" });
  eng.recordEquitySnapshot({ equity: 880000, date: "2026-10-01" }); // -12% (within sanity bounds)
  const st = eng.getState();
  assert.equal(st.haltState.halted, false, "phase 0 must never halt");
  const last = st.returnCycles[st.returnCycles.length - 1];
  assert.ok(last.returnPct < -10, "returnPct should reflect the large loss");
});

test("hard stop DOES fire in phase 1+ with genuine -2% daily loss", () => {
  const eng = engine();
  recordOps(eng, 30); // escalate to phase 1
  assert.equal(eng.getPhase(), 1);
  // Seed baseline
  eng.recordEquitySnapshot({ equity: 1000000, date: "2026-10-01" });
  // Record -3% same-day loss
  eng.recordEquitySnapshot({ equity: 970000, date: "2026-10-01" });
  const st = eng.getState();
  assert.equal(st.haltState.halted, true, "phase 1 must halt on -3% daily loss");
  assert.equal(st.haltState.triggeredBy, "dailyHardStop");
});

test("resetDailyBaseline() reseeds baseline explicitly", () => {
  const eng = engine();
  eng.recordEquitySnapshot({ equity: 50000000, date: "2026-10-01" });
  // Explicitly reseed at a different value
  const ok = eng.resetDailyBaseline(55000000, "2026-10-01");
  assert.equal(ok, true);
  const st = eng.getState();
  assert.equal(st.dailyBaselineEquity, 55000000);
  assert.equal(st.dailyBaselineDate, "2026-10-01");
  // Next snapshot same-day should use the reseeded baseline
  eng.recordEquitySnapshot({ equity: 54000000, date: "2026-10-01" });
  const last = eng.getState().returnCycles[eng.getState().returnCycles.length - 1];
  const expectedReturn = ((54000000 - 55000000) / 55000000) * 100;
  assert.ok(Math.abs(last.returnPct - expectedReturn) < 0.001,
    `after reseed, returnPct should be ~${expectedReturn}%, got ${last.returnPct}`);
});

test("resetDailyBaseline() rejects invalid equity", () => {
  const eng = engine();
  eng.recordEquitySnapshot({ equity: 50000000, date: "2026-10-01" });
  assert.equal(eng.resetDailyBaseline(0), false, "reject zero");
  assert.equal(eng.resetDailyBaseline(-100), false, "reject negative");
  assert.equal(eng.resetDailyBaseline(NaN), false, "reject NaN");
  assert.equal(eng.resetDailyBaseline("abc"), false, "reject non-numeric");
  // Baseline should be unchanged
  assert.equal(eng.getState().dailyBaselineEquity, 50000000);
});

test("getEffectiveLimits exposes dailyBaselineEquity and dailyBaselineDate", () => {
  const eng = engine();
  eng.recordEquitySnapshot({ equity: 42000000, date: "2026-10-01" });
  const lim = eng.getEffectiveLimits();
  assert.equal(lim.dailyBaselineEquity, 42000000);
  assert.equal(lim.dailyBaselineDate, "2026-10-01");
  assert.equal(lim.highWaterEquity, 42000000);
});

test("cumulative drawdown from HWM does NOT trigger hard stop (only daily return does)", () => {
  const eng = engine();
  recordOps(eng, 30); // escalate to phase 1
  // Build up equity over several days
  eng.recordEquitySnapshot({ equity: 75000000, date: "2026-09-25" });
  eng.recordEquitySnapshot({ equity: 74000000, date: "2026-09-26" });
  eng.recordEquitySnapshot({ equity: 73000000, date: "2026-09-27" });
  eng.recordEquitySnapshot({ equity: 72000000, date: "2026-09-28" });
  eng.recordEquitySnapshot({ equity: 71000000, date: "2026-09-29" });
  eng.recordEquitySnapshot({ equity: 70000000, date: "2026-09-30" });
  // Now on a new day, equity is 69.5M — cumulative DD from HWM is ~7.3%
  // but daily return from yesterday's close (70M) is only -0.71%
  eng.recordEquitySnapshot({ equity: 69500000, date: "2026-10-01" });
  const st = eng.getState();
  assert.equal(st.haltState.halted, false,
    "cumulative drawdown must not trigger daily hard stop");
  const last = st.returnCycles[st.returnCycles.length - 1];
  assert.ok(last.returnPct > -1, `daily return should be ~-0.71%, got ${last.returnPct}`);
  assert.ok(last.drawdownFromHWM > 5, `drawdown from HWM should be >5%, got ${last.drawdownFromHWM}`);
});

// ---------------------------------------------------------------------------
// [DEEP-DEBUG] advancePhaseDirect + purgeOperationCycles
// ---------------------------------------------------------------------------

test("advancePhaseDirect skips phase without injecting fake operations", () => {
  const eng = engine();
  assert.equal(eng.getPhase(), 0);
  const before = eng.getState().operationCycles.length;
  const ok = eng.advancePhaseDirect(1, "test override");
  assert.equal(ok, true);
  assert.equal(eng.getPhase(), 1);
  const after = eng.getState().operationCycles.length;
  assert.equal(after, before, "no operation cycles should be injected");
  assert.equal(eng.getEffectiveLimits().baseTargetPct, 1.0); // Phase 1 target
});

test("advancePhaseDirect rejects invalid phase id", () => {
  const eng = engine();
  const ok = eng.advancePhaseDirect(99, "bogus");
  assert.equal(ok, false);
  assert.equal(eng.getPhase(), 0);
});

test("advancePhaseDirect is idempotent for same phase", () => {
  const eng = engine();
  eng.advancePhaseDirect(2, "first");
  const ok2 = eng.advancePhaseDirect(2, "duplicate");
  assert.equal(ok2, false, "should return false when already at target phase");
});

test("purgeOperationCycles removes entries matching predicate", () => {
  const eng = engine();
  // Record some genuine ops and some "fake" ones
  eng.recordOperationOutcome({ operation: "create_order", symbol: "A", side: "BUY", quantity: 1, price: 100, ok: true, code: "OK", verified: true });
  eng.recordOperationOutcome({ operation: "create_order", symbol: "INIT", side: "BUY", quantity: 1, price: 1, ok: true, code: "LIVE_OVERRIDE", verified: true });
  eng.recordOperationOutcome({ operation: "create_order", symbol: "B", side: "BUY", quantity: 1, price: 200, ok: true, code: "OK", verified: true });
  eng.recordOperationOutcome({ operation: "create_order", symbol: "INIT", side: "BUY", quantity: 1, price: 1, ok: true, code: "LIVE_OVERRIDE", verified: true });
  const before = eng.getState().operationCycles.length;
  assert.equal(before, 4);
  const removed = eng.purgeOperationCycles(c => c.code !== "LIVE_OVERRIDE");
  assert.equal(removed, 2);
  const st = eng.getState();
  assert.equal(st.operationCycles.length, 2);
  assert.ok(st.operationCycles.every(c => c.code !== "LIVE_OVERRIDE"));
});

test("purgeOperationCycles returns 0 when nothing to remove", () => {
  const eng = engine();
  eng.recordOperationOutcome({ operation: "create_order", symbol: "X", side: "BUY", quantity: 1, price: 100, ok: true, code: "OK", verified: true });
  const removed = eng.purgeOperationCycles(c => c.code !== "LIVE_OVERRIDE");
  assert.equal(removed, 0);
});

// ---------------------------------------------------------------------------
// [P5 Fix] Dual-portfolio bucket-specific return cycle tracking
// ---------------------------------------------------------------------------

test("recordEquitySnapshot with bucket stores cycles in returnCyclesByBucket", () => {
  const eng = engine();
  eng.recordEquitySnapshot({ equity: 1000000, date: "2026-10-01", bucket: "max_profit" });
  eng.recordEquitySnapshot({ equity: 1005000, date: "2026-10-01", bucket: "max_profit" });
  eng.recordEquitySnapshot({ equity: 1000000, date: "2026-10-01", bucket: "standard" });
  eng.recordEquitySnapshot({ equity: 1002000, date: "2026-10-01", bucket: "standard" });
  const st = eng.getState();
  assert.ok(st.returnCyclesByBucket, "returnCyclesByBucket should exist in state");
  assert.equal(st.returnCyclesByBucket.max_profit.length, 2);
  assert.equal(st.returnCyclesByBucket.standard.length, 2);
  assert.equal(st.returnCycles.length, 4, "aggregate returnCycles should have all 4 records");
});
