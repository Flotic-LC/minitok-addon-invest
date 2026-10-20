"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createEscalationManager,
  DEFAULTS,
  SEVERITIES,
} = require("../src/orchestrator/escalation");

// ============================================================================
// DEFAULTS & SEVERITIES
// ============================================================================
test("DEFAULTS: correct default values", () => {
  assert.equal(DEFAULTS.enabled, true);
  assert.equal(DEFAULTS.dailyLimit, 3);
  assert.equal(DEFAULTS.defaultTimeoutMs, 14400000);
  assert.equal(DEFAULTS.timeoutFallback, "default");
  assert.equal(DEFAULTS.cooldownMs, 300000);
  assert.equal(DEFAULTS.maxHistorySize, 500);
});

test("SEVERITIES: info, warn, critical", () => {
  assert.deepEqual(SEVERITIES, ["info", "warn", "critical"]);
});

// ============================================================================
// renderTemplate (via _internals)
// ============================================================================
test("renderTemplate: formats severity, summary, bullets, options, timeout", () => {
  const { renderTemplate } = createEscalationManager()._internals;
  const msg = renderTemplate({
    severity: "critical",
    summary: "killswitch triggered",
    bullets: ["DATA_DRIFT 3 days", "Sharpe -1.2"],
    options: [
      { id: "wait", label: "1h wait", recommended: true },
      { id: "shadow", label: "shadow mode" },
    ],
    timeoutMs: 60000,
  });
  assert.ok(msg.includes("[CRITICAL] killswitch triggered"));
  assert.ok(msg.includes("• DATA_DRIFT 3 days"));
  assert.ok(msg.includes("• Sharpe -1.2"));
  assert.ok(msg.includes("[wait] 1h wait (recommended)"));
  assert.ok(msg.includes("[shadow] shadow mode"));
  assert.ok(msg.includes("Timeout: 60s"));
});

test("renderTemplate: handles minimal context", () => {
  const { renderTemplate } = createEscalationManager()._internals;
  const msg = renderTemplate({ severity: "info", summary: "test" });
  assert.ok(msg.includes("[INFO] test"));
  assert.ok(!msg.includes("Options:"));
});

// ============================================================================
// escalate — validation
// ============================================================================
test("escalate: rejects missing context", async () => {
  const em = createEscalationManager();
  await assert.rejects(() => em.escalate(null), /context object required/);
  await assert.rejects(() => em.escalate({}), /summary string required/);
});

test("escalate: rejects invalid severity", async () => {
  const em = createEscalationManager({
    channels: { telegram: async () => {} },
  });
  await assert.rejects(
    () => em.escalate({ summary: "test", severity: "unknown" }),
    /invalid severity/
  );
});

test("escalate: rejects invalid options shape", async () => {
  const em = createEscalationManager({
    channels: { telegram: async () => {} },
  });
  await assert.rejects(
    () => em.escalate({ summary: "test", options: "bad" }),
    /options must be array/
  );
  await assert.rejects(
    () => em.escalate({ summary: "test", options: [{ id: "x" }] }),
    /each option requires id and label/
  );
});

test("escalate: rejects when no channels configured", async () => {
  const em = createEscalationManager({ channels: {} });
  await assert.rejects(
    () => em.escalate({ summary: "test" }),
    /no channels configured/
  );
});

// ============================================================================
// escalate — basic dispatch
// ============================================================================
test("escalate: dispatches to channels and returns id", async () => {
  const sent = [];
  const em = createEscalationManager({
    channels: {
      telegram: async (msg) => sent.push({ ch: "telegram", ...msg }),
      email: async (msg) => sent.push({ ch: "email", ...msg }),
    },
    config: { defaultTimeoutMs: 0 }, // disable timer for this test
  });
  const id = await em.escalate({
    severity: "warn",
    summary: "test alert",
    bullets: ["detail 1"],
  });
  assert.ok(id.startsWith("esc_"));
  assert.equal(sent.length, 2);
  assert.equal(sent[0].ch, "telegram");
  assert.equal(sent[1].ch, "email");
  assert.equal(sent[0].severity, "warn");
  assert.ok(sent[0].message.includes("[WARN] test alert"));
  assert.equal(em.stats().total, 1);
});

// ============================================================================
// escalate — channel error isolation
// ============================================================================
test("escalate: isolates channel dispatch errors", async () => {
  const em = createEscalationManager({
    channels: {
      good: async () => {},
      bad: async () => { throw new Error("network down"); },
    },
    config: { defaultTimeoutMs: 0 },
  });
  const id = await em.escalate({ summary: "test" });
  assert.ok(id);
  const pending = em.getPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].dispatchResults[0].ok, true);
  assert.equal(pending[0].dispatchResults[1].ok, false);
  assert.match(pending[0].dispatchResults[1].error, /network down/);
});

// ============================================================================
// respond — basic
// ============================================================================
test("respond: resolves pending escalation with optionId", async () => {
  const responses = [];
  const em = createEscalationManager({
    channels: { telegram: async () => {} },
    config: { defaultTimeoutMs: 0 },
    onResponse: (id, optId, entry) => responses.push({ id, optId }),
  });
  const id = await em.escalate({
    summary: "test",
    options: [
      { id: "wait", label: "wait" },
      { id: "abort", label: "abort" },
    ],
  });
  assert.equal(em.getPending().length, 1);
  const result = em.respond(id, "wait");
  assert.equal(result.ok, true);
  assert.equal(result.optionId, "wait");
  assert.equal(em.getPending().length, 0);
  assert.equal(em.stats().responded, 1);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].optId, "wait");
  // history should contain resolved entry
  const h = em.getHistory();
  const resolved = h.find((e) => e.id === id);
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.optionId, "wait");
  assert.equal(resolved.responseMode, "human");
});

test("respond: rejects unknown optionId", async () => {
  const em = createEscalationManager({
    channels: { telegram: async () => {} },
    config: { defaultTimeoutMs: 0 },
  });
  const id = await em.escalate({
    summary: "test",
    options: [{ id: "wait", label: "wait" }],
  });
  const result = em.respond(id, "nonexistent");
  assert.equal(result.ok, false);
  assert.match(result.error, /unknown optionId/);
  assert.equal(em.getPending().length, 1); // still pending
});

test("respond: rejects double resolve", async () => {
  const em = createEscalationManager({
    channels: { telegram: async () => {} },
    config: { defaultTimeoutMs: 0 },
  });
  const id = await em.escalate({ summary: "test" });
  em.respond(id, "x");
  const result = em.respond(id, "x");
  assert.equal(result.ok, false);
  assert.match(result.error, /not found or already resolved/);
});

test("respond: rejects missing escalationId", () => {
  const em = createEscalationManager();
  const result = em.respond(null, "x");
  assert.equal(result.ok, false);
  assert.match(result.error, /escalationId required/);
});

// ============================================================================
// Daily limit
// ============================================================================
test("escalate: enforces daily limit", async () => {
  const em = createEscalationManager({
    channels: { telegram: async () => {} },
    config: { dailyLimit: 2, defaultTimeoutMs: 0 },
  });
  const id1 = await em.escalate({ summary: "first" });
  const id2 = await em.escalate({ summary: "second" });
  const id3 = await em.escalate({ summary: "third" }); // should be rejected
  assert.ok(id1.startsWith("esc_"));
  assert.ok(id2.startsWith("esc_"));
  assert.ok(id3.startsWith("esc_"));
  const h = em.getHistory();
  const rejected = h.find((e) => e.id === id3);
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.reason, "daily_limit");
  assert.equal(em.stats().rejected, 1);
  assert.equal(em.stats().total, 2); // only 2 actually escalated
});

test("stats: remainingToday decreases correctly", async () => {
  const em = createEscalationManager({
    channels: { telegram: async () => {} },
    config: { dailyLimit: 5, defaultTimeoutMs: 0 },
  });
  assert.equal(em.stats().remainingToday, 5);
  await em.escalate({ summary: "a" });
  assert.equal(em.stats().remainingToday, 4);
  await em.escalate({ summary: "b" });
  assert.equal(em.stats().remainingToday, 3);
});

// ============================================================================
// Cooldown
// ============================================================================
test("escalate: enforces cooldown per key", async () => {
  const em = createEscalationManager({
    channels: { telegram: async () => {} },
    config: { cooldownMs: 60000, defaultTimeoutMs: 0 },
  });
  const id1 = await em.escalate({ summary: "first", cooldownKey: "killswitch" });
  const id2 = await em.escalate({ summary: "second", cooldownKey: "killswitch" });
  const h = em.getHistory();
  const cooled = h.find((e) => e.id === id2);
  assert.equal(cooled.status, "rejected");
  assert.equal(cooled.reason, "cooldown");
  assert.equal(cooled.cooldownKey, "killswitch");
});

test("escalate: different cooldown keys don't interfere", async () => {
  const em = createEscalationManager({
    channels: { telegram: async () => {} },
    config: { cooldownMs: 60000, defaultTimeoutMs: 0 },
  });
  const id1 = await em.escalate({ summary: "a", cooldownKey: "keyA" });
  const id2 = await em.escalate({ summary: "b", cooldownKey: "keyB" });
  assert.ok(id1.startsWith("esc_"));
  assert.ok(id2.startsWith("esc_"));
  assert.equal(em.getPending().length, 2);
  assert.equal(em.stats().total, 2);
});


// ============================================================================
// Timeout behavior
// ============================================================================
test("escalate: timeout resolves with fallback option", async () => {
  const timeouts = [];
  const em = createEscalationManager({
    channels: { telegram: async () => {} },
    config: { defaultTimeoutMs: 50, timeoutFallback: "default" },
    onTimeout: (id, fallback, entry) => timeouts.push({ id, fallback }),
  });
  const id = await em.escalate({
    summary: "urgent",
    options: [
      { id: "wait", label: "wait", recommended: true },
      { id: "abort", label: "abort" },
    ],
    timeoutMs: 50,
  });
  assert.equal(em.getPending().length, 1);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(em.getPending().length, 0);
  assert.equal(em.stats().timedOut, 1);
  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0].fallback, "wait"); // recommended option
  const h = em.getHistory();
  const resolved = h.find((e) => e.id === id);
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.optionId, "wait");
  assert.equal(resolved.responseMode, "timeout");
});

test("escalate: timeout uses fallbackOptionId when provided", async () => {
  const em = createEscalationManager({
    channels: { telegram: async () => {} },
    config: { defaultTimeoutMs: 50 },
  });
  await em.escalate({
    summary: "test",
    options: [
      { id: "a", label: "a" },
      { id: "b", label: "b" },
    ],
    fallbackOptionId: "b",
    timeoutMs: 50,
  });
  await new Promise((r) => setTimeout(r, 100));
  const h = em.getHistory();
  const last = h[h.length - 1];
  assert.equal(last.optionId, "b");
});

test("escalate: timeout with safest fallback picks last option", async () => {
  const em = createEscalationManager({
    channels: { telegram: async () => {} },
    config: { defaultTimeoutMs: 50, timeoutFallback: "safest" },
  });
  await em.escalate({
    summary: "test",
    options: [
      { id: "aggressive", label: "aggressive" },
      { id: "moderate", label: "moderate" },
      { id: "conservative", label: "conservative" },
    ],
    timeoutMs: 50,
  });
  await new Promise((r) => setTimeout(r, 100));
  const h = em.getHistory();
  const last = h[h.length - 1];
  assert.equal(last.optionId, "conservative");
});

test("escalate: timeout with none fallback returns null optionId", async () => {
  const em = createEscalationManager({
    channels: { telegram: async () => {} },
    config: { defaultTimeoutMs: 50, timeoutFallback: "none" },
  });
  await em.escalate({
    summary: "test",
    options: [{ id: "a", label: "a" }],
    timeoutMs: 50,
  });
  await new Promise((r) => setTimeout(r, 100));
  const h = em.getHistory();
  const last = h[h.length - 1];
  assert.equal(last.optionId, null);
});

test("respond: cancels timeout when human responds first", async () => {
  const timeouts = [];
  const em = createEscalationManager({
    channels: { telegram: async () => {} },
    config: { defaultTimeoutMs: 200 },
    onTimeout: (id) => timeouts.push(id),
  });
  const id = await em.escalate({
    summary: "test",
    options: [{ id: "x", label: "x" }],
    timeoutMs: 200,
  });
  em.respond(id, "x"); // respond immediately
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(timeouts.length, 0); // timeout should NOT have fired
  assert.equal(em.stats().responded, 1);
  assert.equal(em.stats().timedOut, 0);
});


// ============================================================================
// Disabled state
// ============================================================================
test("escalate: returns disabled entry when not enabled", async () => {
  const em = createEscalationManager({
    channels: { telegram: async () => {} },
    config: { enabled: false },
  });
  const id = await em.escalate({ summary: "test" });
  assert.ok(id.startsWith("esc_"));
  const h = em.getHistory();
  const entry = h.find((e) => e.id === id);
  assert.equal(entry.status, "disabled");
  assert.equal(em.stats().rejected, 1);
  assert.equal(em.stats().total, 0); // not counted as sent
});

// ============================================================================
// Audit trail
// ============================================================================
test("escalate: writes audit entries", async () => {
  const events = [];
  const em = createEscalationManager({
    channels: { telegram: async () => {} },
    config: { defaultTimeoutMs: 0 },
    audit: (entry) => events.push(entry),
  });
  const id = await em.escalate({ summary: "test" });
  em.respond(id, null); // resolve with null optionId
  const sentEvent = events.find((e) => e.event === "escalation.sent");
  assert.ok(sentEvent);
  assert.equal(sentEvent.data.id, id);
  const respEvent = events.find((e) => e.event === "escalation.response");
  assert.ok(respEvent);
  assert.equal(respEvent.data.optionId, null);
});

// ============================================================================
// Stats
// ============================================================================
test("stats: returns correct counters", async () => {
  const em = createEscalationManager({
    channels: { telegram: async () => {}, email: async () => {} },
    config: { dailyLimit: 5, defaultTimeoutMs: 0 },
  });
  const s0 = em.stats();
  assert.equal(s0.enabled, true);
  assert.equal(s0.dailyLimit, 5);
  assert.equal(s0.todayCount, 0);
  assert.equal(s0.remainingToday, 5);
  assert.equal(s0.total, 0);
  assert.deepEqual(s0.channels, ["telegram", "email"]);
  await em.escalate({ summary: "a" });
  await em.escalate({ summary: "b" });
  const s1 = em.stats();
  assert.equal(s1.total, 2);
  assert.equal(s1.pendingCount, 2);
});

// ============================================================================
// History
// ============================================================================
test("getHistory: returns all entries and supports limit", async () => {
  const em = createEscalationManager({
    channels: { telegram: async () => {} },
    config: { defaultTimeoutMs: 0, maxHistorySize: 3, dailyLimit: 20 },
  });
  // escalate and immediately respond so entries enter history
  for (let i = 0; i < 5; i++) {
    const id = await em.escalate({ summary: "msg" + i });
    em.respond(id, null);
  }
  const all = em.getHistory();
  assert.equal(all.length, 3); // capped
  const recent = em.getHistory(2);
  assert.equal(recent.length, 2);
  assert.equal(recent[1].summary, "msg4");
});

// ============================================================================
// State / restore / reset
// ============================================================================
test("state/restore: persists and recovers counters + history", async () => {
  const em1 = createEscalationManager({
    channels: { telegram: async () => {} },
    config: { defaultTimeoutMs: 0 },
  });
  const id1 = await em1.escalate({ summary: "a" });
  const id2 = await em1.escalate({ summary: "b" });
  // resolve so entries enter history
  em1.respond(id1, null);
  em1.respond(id2, null);
  const snap = em1.state();
  assert.equal(snap.counters.total, 2);
  assert.equal(snap.counters.responded, 2);
  assert.equal(snap.history.length, 2);

  const em2 = createEscalationManager();
  em2.restore(snap);
  assert.equal(em2.stats().total, 2);
  assert.equal(em2.stats().responded, 2);
  assert.equal(em2.getHistory().length, 2);
});

test("reset: clears all state", async () => {
  const em = createEscalationManager({
    channels: { telegram: async () => {} },
    config: { defaultTimeoutMs: 0 },
  });
  await em.escalate({ summary: "a" });
  em.reset();
  assert.equal(em.stats().total, 0);
  assert.equal(em.stats().pendingCount, 0);
  assert.equal(em.getHistory().length, 0);
});

test("restore: handles null gracefully", () => {
  const em = createEscalationManager();
  em.restore(null);
  em.restore(undefined);
  assert.equal(em.stats().total, 0);
});

// ============================================================================
// getPending
// ============================================================================
test("getPending: returns only unresolved escalations", async () => {
  const em = createEscalationManager({
    channels: { telegram: async () => {} },
    config: { defaultTimeoutMs: 0 },
  });
  const id1 = await em.escalate({ summary: "a" });
  await em.escalate({ summary: "b" });
  assert.equal(em.getPending().length, 2);
  em.respond(id1, null);
  assert.equal(em.getPending().length, 1);
  assert.equal(em.getPending()[0].summary, "b");
});

// ============================================================================
// Metadata passthrough
// ============================================================================
test("escalate: passes metadata through to entry", async () => {
  const em = createEscalationManager({
    channels: { telegram: async () => {} },
    config: { defaultTimeoutMs: 0 },
  });
  const id = await em.escalate({
    summary: "test",
    metadata: { strategyId: "momentum_v2", regime: "bear" },
  });
  const pending = em.getPending();
  assert.equal(pending[0].metadata.strategyId, "momentum_v2");
  assert.equal(pending[0].metadata.regime, "bear");
});
