"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createSelfHealer, INCIDENT_TYPES, DEFAULT_COOLDOWNS } = require("../src/orchestrator/self-healing");

test("createSelfHealer returns expected API", () => {
  const h = createSelfHealer();
  assert.equal(typeof h.reportIncident, "function");
  assert.equal(typeof h.tick, "function");
  assert.equal(typeof h.isMitigated, "function");
  assert.equal(typeof h.getActiveMitigations, "function");
  assert.equal(typeof h.getHistory, "function");
  assert.equal(typeof h.stats, "function");
  assert.equal(typeof h.state, "function");
  assert.equal(typeof h.restore, "function");
  assert.equal(typeof h.reset, "function");
});

test("INCIDENT_TYPES exports 6 types", () => {
  assert.equal(INCIDENT_TYPES.length, 6);
  assert.ok(INCIDENT_TYPES.includes("API_TRANSIENT"));
  assert.ok(INCIDENT_TYPES.includes("LLM_DEGRADATION"));
});

test("reportIncident with valid type applies mitigation", () => {
  const h = createSelfHealer();
  const r = h.reportIncident("API_TRANSIENT", { source: "ws", code: 429 });
  assert.equal(r.applied, true);
  assert.equal(r.action.action, "backoff_reconnect");
  assert.ok(r.action.backoffMs > 0);
});

test("reportIncident with invalid type throws", () => {
  const h = createSelfHealer();
  assert.throws(() => h.reportIncident("INVALID_TYPE", {}), /Unknown incident type/);
});

test("reportIncident cooldown prevents re-triggering", () => {
  let t = 1000000;
  const h = createSelfHealer({ now: () => t });
  const r1 = h.reportIncident("API_TRANSIENT", {});
  assert.equal(r1.applied, true);
  const r2 = h.reportIncident("API_TRANSIENT", {});
  assert.equal(r2.applied, false);
  assert.equal(r2.reason, "cooldown active");
});

test("reportIncident cooldown expiry allows re-trigger", () => {
  let t = 1000000;
  const h = createSelfHealer({ now: () => t });
  h.reportIncident("API_TRANSIENT", {});
  t += 70_000; // exceed 60s cooldown
  const r = h.reportIncident("API_TRANSIENT", {});
  assert.equal(r.applied, true);
});

test("escalation fires after escalationThreshold incidents", () => {
  let t = 0;
  const escalations = [];
  const h = createSelfHealer({
    now: () => t,
    onEscalation: (type, info) => escalations.push({ type, info }),
  });
  // Trigger 3 incidents (threshold=3), each after cooldown expires
  for (let i = 0; i < 3; i++) {
    t += 70_000;
    h.reportIncident("API_TRANSIENT", { attempt: i });
  }
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0].type, "API_TRANSIENT");
  assert.equal(escalations[0].info.count, 3);
});

test("tick expires mitigations", () => {
  let t = 0;
  const h = createSelfHealer({ now: () => t });
  h.reportIncident("LLM_DEGRADATION", { latencyMs: 15000 });
  assert.equal(h.isMitigated("LLM_DEGRADATION"), true);
  t += 310_000; // exceed 300s cooldown
  h.tick({});
  assert.equal(h.isMitigated("LLM_DEGRADATION"), false);
});

test("tick auto-detects REGIME_MISMATCH after 3 consecutive flips", () => {
  let t = 0;
  const h = createSelfHealer({ now: () => t });
  h.tick({ currentRegime: "bull" });
  t += 70_000;
  h.tick({ currentRegime: "bear" });   // flip 1
  t += 70_000;
  h.tick({ currentRegime: "bull" });   // flip 2
  t += 70_000;
  h.tick({ currentRegime: "bear" });   // flip 3 -> triggers
  assert.equal(h.isMitigated("REGIME_MISMATCH"), true);
  const mitigations = h.getActiveMitigations();
  assert.ok(mitigations.REGIME_MISMATCH);
  assert.equal(mitigations.REGIME_MISMATCH.action.action, "pause_strategy");
});

test("tick resets regime flip counter on stable regime", () => {
  let t = 0;
  const h = createSelfHealer({ now: () => t });
  h.tick({ currentRegime: "bull" });
  t += 70_000;
  h.tick({ currentRegime: "bear" });   // flip 1
  t += 70_000;
  h.tick({ currentRegime: "bear" });   // stable -> resets
  t += 70_000;
  h.tick({ currentRegime: "bull" });   // flip 1 again
  t += 70_000;
  h.tick({ currentRegime: "bear" });   // flip 2
  assert.equal(h.isMitigated("REGIME_MISMATCH"), false);
});

test("tick auto-detects PARAM_STALE after 3 consecutive walk-forward rejects", () => {
  let t = 0;
  // [P6-FIX] Without evolution enabled, mitigation reverts params to defaults
  const h = createSelfHealer({ now: () => t });
  h.tick({ walkForwardVerdict: "reject" });
  t += 70_000;
  h.tick({ walkForwardVerdict: "reject" });
  t += 70_000;
  h.tick({ walkForwardVerdict: "reject" });  // 3rd reject -> triggers
  assert.equal(h.isMitigated("PARAM_STALE"), true);
  const mitigations = h.getActiveMitigations();
  assert.equal(mitigations.PARAM_STALE.action.action, "revert_params_to_defaults");
});

test("tick PARAM_STALE triggers re-evolution when evolution is enabled", () => {
  let t = 0;
  const h = createSelfHealer({ now: () => t, isEvolutionEnabled: () => true });
  h.tick({ walkForwardVerdict: "reject" });
  t += 70_000;
  h.tick({ walkForwardVerdict: "reject" });
  t += 70_000;
  h.tick({ walkForwardVerdict: "reject" });
  assert.equal(h.isMitigated("PARAM_STALE"), true);
  const mitigations = h.getActiveMitigations();
  assert.equal(mitigations.PARAM_STALE.action.action, "trigger_re_evolution");
});

test("tick resets walk-forward counter on accept", () => {
  let t = 0;
  const h = createSelfHealer({ now: () => t });
  h.tick({ walkForwardVerdict: "reject" });
  t += 70_000;
  h.tick({ walkForwardVerdict: "accept" });  // resets
  t += 70_000;
  h.tick({ walkForwardVerdict: "reject" });  // 1 again
  assert.equal(h.isMitigated("PARAM_STALE"), false);
});

test("tick auto-detects DATA_DRIFT after 2 consecutive low-rho calibrations", () => {
  let t = 0;
  const h = createSelfHealer({ now: () => t });
  h.tick({ calibrationRho: 0.1 });
  t += 70_000;
  h.tick({ calibrationRho: 0.05 });
  assert.equal(h.isMitigated("DATA_DRIFT"), true);
  const m = h.getActiveMitigations();
  assert.equal(m.DATA_DRIFT.action.action, "pause_strategy");
});

test("tick resets DATA_DRIFT counter on good rho", () => {
  let t = 0;
  const h = createSelfHealer({ now: () => t });
  h.tick({ calibrationRho: 0.1 });
  t += 70_000;
  h.tick({ calibrationRho: 0.5 });
  t += 70_000;
  h.tick({ calibrationRho: 0.1 });
  assert.equal(h.isMitigated("DATA_DRIFT"), false);
});

test("tick auto-detects LIQUIDITY_SHOCK when spread > threshold", () => {
  let t = 0;
  // [P6-FIX] Threshold raised to 150 bps (from 50) to avoid false positives
  const h = createSelfHealer({ now: () => t });
  h.tick({ spreadBps: 200 });
  assert.equal(h.isMitigated("LIQUIDITY_SHOCK"), true);
  const m = h.getActiveMitigations();
  assert.equal(m.LIQUIDITY_SHOCK.action.action, "block_buy");
  assert.equal(m.LIQUIDITY_SHOCK.action.spreadBps, 200);
});

test("tick does not trigger LIQUIDITY_SHOCK when spread <= threshold", () => {
  let t = 0;
  const h = createSelfHealer({ now: () => t });
  h.tick({ spreadBps: 100 });
  assert.equal(h.isMitigated("LIQUIDITY_SHOCK"), false);
});

test("tick auto-detects LLM_DEGRADATION on high latency (single provider)", () => {
  let t = 0;
  // [P6-FIX] With single provider, mitigation falls back to rules instead of switching
  const h = createSelfHealer({ now: () => t });
  h.tick({ llmLatencyMs: 15000 });
  assert.equal(h.isMitigated("LLM_DEGRADATION"), true);
  const m = h.getActiveMitigations();
  assert.equal(m.LLM_DEGRADATION.action.action, "fallback_to_rules");
});

test("tick LLM_DEGRADATION switches provider when multiple healthy", () => {
  let t = 0;
  const h = createSelfHealer({ now: () => t, getHealthyProviderCount: () => 3 });
  h.tick({ llmLatencyMs: 15000 });
  assert.equal(h.isMitigated("LLM_DEGRADATION"), true);
  const m = h.getActiveMitigations();
  assert.equal(m.LLM_DEGRADATION.action.action, "switch_provider");
});

test("tick auto-detects LLM_DEGRADATION on high parse error rate", () => {
  let t = 0;
  const h = createSelfHealer({ now: () => t });
  h.tick({ llmParseErrorPct: 0.35 });
  assert.equal(h.isMitigated("LLM_DEGRADATION"), true);
});

test("tick does not trigger LLM_DEGRADATION on normal metrics", () => {
  let t = 0;
  const h = createSelfHealer({ now: () => t });
  h.tick({ llmLatencyMs: 3000, llmParseErrorPct: 0.05 });
  assert.equal(h.isMitigated("LLM_DEGRADATION"), false);
});

test("stats() returns correct shape and counts", () => {
  let t = 0;
  const h = createSelfHealer({ now: () => t });
  h.reportIncident("API_TRANSIENT", {});
  t += 70_000;
  h.reportIncident("API_TRANSIENT", {});
  t += 70_000;
  h.reportIncident("LLM_DEGRADATION", { latencyMs: 12000 });
  const s = h.stats();
  assert.ok(s.countsPerType);
  assert.equal(s.countsPerType.API_TRANSIENT.total, 2);
  assert.equal(s.countsPerType.LLM_DEGRADATION.total, 1);
  assert.equal(s.countsPerType.DATA_DRIFT.total, 0);
  assert.equal(typeof s.activeMitigations, "number");
  assert.equal(s.activeMitigations, 2);
  assert.equal(s.historySize, 3);
  assert.equal(s.escalationThreshold, 3);
});

test("state() and restore() round-trip preserves history and mitigations", () => {
  let t = 1000;
  const h1 = createSelfHealer({ now: () => t });
  h1.reportIncident("API_TRANSIENT", { code: 429 });
  h1.reportIncident("LLM_DEGRADATION", { latencyMs: 15000 });
  const saved = h1.state();
  const h2 = createSelfHealer({ now: () => t });
  h2.restore(saved);
  assert.equal(h2.isMitigated("API_TRANSIENT"), true);
  assert.equal(h2.isMitigated("LLM_DEGRADATION"), true);
  assert.equal(h2.getHistory().length, 2);
});

test("reset() clears all state", () => {
  let t = 0;
  const h = createSelfHealer({ now: () => t });
  h.reportIncident("API_TRANSIENT", {});
  h.reportIncident("LLM_DEGRADATION", { latencyMs: 15000 });
  h.reset();
  assert.equal(h.isMitigated(), false);
  assert.equal(h.getHistory().length, 0);
  assert.equal(h.stats().historySize, 0);
});

test("getHistory with limit returns last N entries", () => {
  let t = 0;
  const h = createSelfHealer({ now: () => t });
  for (let i = 0; i < 5; i++) {
    t += 70_000;
    h.reportIncident("API_TRANSIENT", { attempt: i });
  }
  assert.equal(h.getHistory().length, 5);
  assert.equal(h.getHistory(2).length, 2);
  assert.equal(h.getHistory(2)[0].ctx.attempt, 3);
});

test("maxHistorySize caps history with FIFO eviction", () => {
  let t = 0;
  const h = createSelfHealer({ now: () => t, config: { maxHistorySize: 3 } });
  for (let i = 0; i < 6; i++) {
    t += 70_000;
    h.reportIncident("API_TRANSIENT", { attempt: i });
  }
  assert.equal(h.getHistory().length, 3);
  assert.equal(h.getHistory()[0].ctx.attempt, 3);
  assert.equal(h.getHistory()[2].ctx.attempt, 5);
});

test("onIncident callback fires on reportIncident", () => {
  const events = [];
  const h = createSelfHealer({ onIncident: (type, ctx) => events.push({ type, ctx }) });
  h.reportIncident("API_TRANSIENT", { code: 429 });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "API_TRANSIENT");
  assert.equal(events[0].ctx.code, 429);
});

test("onMitigation callback fires with action", () => {
  const mitigations = [];
  const h = createSelfHealer({ onMitigation: (type, action) => mitigations.push({ type, action }) });
  h.reportIncident("LIQUIDITY_SHOCK", { spreadBps: 5 });
  assert.equal(mitigations.length, 1);
  assert.equal(mitigations[0].type, "LIQUIDITY_SHOCK");
  assert.equal(mitigations[0].action.action, "block_buy");
});

test("onEscalation callback fires and is exception-safe", () => {
  let t = 0;
  const escalations = [];
  const h = createSelfHealer({
    now: () => t,
    onEscalation: (type, info) => {
      escalations.push({ type, info });
      throw new Error("callback error");
    },
  });
  for (let i = 0; i < 3; i++) {
    t += 70_000;
    h.reportIncident("API_TRANSIENT", { attempt: i });
  }
  assert.equal(escalations.length, 1);
  assert.equal(h.isMitigated("API_TRANSIENT"), true);
});

test("tick passes apiTransient to reportIncident", () => {
  let t = 0;
  const h = createSelfHealer({ now: () => t });
  h.tick({ apiTransient: { source: "rest", code: 503 } });
  assert.equal(h.isMitigated("API_TRANSIENT"), true);
  const m = h.getActiveMitigations();
  assert.equal(m.API_TRANSIENT.action.action, "backoff_reconnect");
});

test("multiple incident types can be active simultaneously", () => {
  let t = 0;
  const h = createSelfHealer({ now: () => t });
  h.reportIncident("API_TRANSIENT", {});
  h.reportIncident("LLM_DEGRADATION", { latencyMs: 12000 });
  h.reportIncident("LIQUIDITY_SHOCK", { spreadBps: 6 });
  assert.equal(h.isMitigated("API_TRANSIENT"), true);
  assert.equal(h.isMitigated("LLM_DEGRADATION"), true);
  assert.equal(h.isMitigated("LIQUIDITY_SHOCK"), true);
  assert.equal(Object.keys(h.getActiveMitigations()).length, 3);
});

test("cooldownSkipped entries recorded in history but not counted", () => {
  let t = 0;
  const h = createSelfHealer({ now: () => t });
  h.reportIncident("API_TRANSIENT", { first: true });
  h.reportIncident("API_TRANSIENT", { second: true });
  const s = h.stats();
  assert.equal(s.countsPerType.API_TRANSIENT.total, 1);
  assert.equal(h.getHistory().length, 2);
  assert.equal(h.getHistory()[1].cooldownSkipped, true);
});

test("restore with null does not throw", () => {
  const h = createSelfHealer();
  h.restore(null);
  h.restore(undefined);
  assert.equal(h.getHistory().length, 0);
});

test("isMitigated with no type checks any active mitigation", () => {
  let t = 0;
  const h = createSelfHealer({ now: () => t });
  assert.equal(h.isMitigated(), false);
  h.reportIncident("API_TRANSIENT", {});
  assert.equal(h.isMitigated(), true);
  assert.equal(h.isMitigated("API_TRANSIENT"), true);
  assert.equal(h.isMitigated("DATA_DRIFT"), false);
});

