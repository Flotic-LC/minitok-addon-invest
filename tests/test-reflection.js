"use strict";

const assert = require("node:assert");
const { createEventBus } = require("../src/intelligence/event-bus");
const { createSignalCollector } = require("../src/intelligence/signal-collector");
const { createReflectionEngine } = require("../src/intelligence/reflection");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  PASS: " + name); }
  catch (e) { failed++; console.error("  FAIL: " + name + " — " + e.message); }
}

console.log("=== Phase R-1: Event Bus + Signal Collector + Reflection ===\n");

// ===== EVENT BUS =====
console.log("[event-bus]");
test("emit + query returns event", function() {
  const bus = createEventBus();
  const id = bus.emit("test.event", { foo: 1 });
  assert.ok(id.startsWith("evt-"));
  const events = bus.query({ type: "test.event" });
  assert.strictEqual(events.length, 1);
  assert.deepStrictEqual(events[0].data, { foo: 1 });
});

test("query with prefix matches subtypes", function() {
  const bus = createEventBus();
  bus.emit("metrics.snapshot", { v: 1 });
  bus.emit("metrics.snapshot.deep", { v: 2 });
  bus.emit("other.event", { v: 3 });
  const r = bus.query({ type: "metrics" });
  assert.strictEqual(r.length, 2);
});

test("query with since filter", function() {
  const bus = createEventBus();
  const t0 = Date.now();
  bus.emit("a", { t: "old" });
  const events = bus.query({ since: t0 - 100 });
  assert.strictEqual(events.length, 1);
});

test("listener receives events", function() {
  const bus = createEventBus();
  const received = [];
  bus.on("x.y", function(e) { received.push(e); });
  bus.emit("x.y", { n: 1 });
  bus.emit("x.y", { n: 2 });
  bus.emit("other", { n: 3 });
  assert.strictEqual(received.length, 2);
});

test("wildcard listener receives all events", function() {
  const bus = createEventBus();
  const received = [];
  bus.on("*", function(e) { received.push(e.type); });
  bus.emit("a", {});
  bus.emit("b", {});
  assert.deepStrictEqual(received, ["a", "b"]);
});

test("maxHistory enforcement drops old", function() {
  const bus = createEventBus({ maxHistory: 3 });
  for (var i = 0; i < 10; i++) bus.emit("e", { i: i });
  const s = bus.stats();
  assert.strictEqual(s.currentSize, 3);
  assert.strictEqual(s.totalDropped, 7);
  assert.strictEqual(s.totalEmitted, 10);
});

test("aggregate groups events by window", function() {
  const bus = createEventBus();
  for (var i = 0; i < 5; i++) bus.emit("tick", { i: i });
  const agg = bus.aggregate("tick", 60000);
  assert.strictEqual(agg.count, 5);
  assert.ok(agg.windows.length >= 1);
});

test("state/restore preserves history", function() {
  const bus = createEventBus();
  bus.emit("persist", { x: 1 });
  bus.emit("persist", { x: 2 });
  const snap = bus.state();
  const bus2 = createEventBus();
  bus2.restore(snap);
  assert.strictEqual(bus2.query({}).length, 2);
});

// ===== SIGNAL COLLECTOR =====
console.log("\n[signal-collector]");
test("attachSelfAudit captures alerts", function() {
  const bus = createEventBus();
  const coll = createSignalCollector({ eventBus: bus });
  const alerts = [];
  const sa = {
    alertFn: function(msg, sev) { alerts.push(msg); },
    getMetrics: function() { return { uptime: 100 }; },
  };
  coll.attachSelfAudit(sa);
  sa.alertFn("test alert", "warning");
  const events = bus.query({ type: "selfAudit.alert" });
  assert.strictEqual(events.length, 1);
  assert.strictEqual(alerts.length, 1);
});

test("recordDecision emits decision.made", function() {
  const bus = createEventBus();
  const coll = createSignalCollector({ eventBus: bus });
  coll.recordDecision({ symbol: "005930", action: "BUY", confidence: 0.8 });
  const events = bus.query({ type: "decision.made" });
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].data.symbol, "005930");
});

test("recordFill emits trading.fill", function() {
  const bus = createEventBus();
  const coll = createSignalCollector({ eventBus: bus });
  coll.recordFill({ symbol: "005930", side: "BUY", price: 70000, pnl: 1000 });
  const events = bus.query({ type: "trading.fill" });
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].data.pnl, 1000);
});

test("tick emits metrics.snapshot", function() {
  const bus = createEventBus();
  const coll = createSignalCollector({ eventBus: bus });
  coll.attachSelfAudit({ getMetrics: function() { return { uptime: 60 }; } });
  coll.tick();
  const events = bus.query({ type: "metrics.snapshot" });
  assert.ok(events.length >= 1);
});

test("stats reflects attached subsystems", function() {
  const bus = createEventBus();
  const coll = createSignalCollector({ eventBus: bus });
  coll.attachSelfAudit({ getMetrics: function() { return {}; } });
  const s = coll.stats();
  assert.strictEqual(s.attached.selfAudit, true);
  assert.strictEqual(s.attached.metaCognition, false);
});

// ===== REFLECTION ENGINE =====
console.log("\n[reflection]");
test("createReflectionEngine requires eventBus", function() {
  assert.throws(function() { createReflectionEngine(); }, /eventBus is required/);
});

test("analyzeRecent categorizes events", function() {
  const bus = createEventBus();
  const r = createReflectionEngine({ eventBus: bus });
  bus.emit("selfAudit.alert", { rule: "x" });
  bus.emit("decision.made", { symbol: "005930" });
  bus.emit("trading.fill", { symbol: "005930", pnl: 100 });
  const a = r.analyzeRecent(3600000);
  assert.strictEqual(a.totalEvents, 3);
  assert.strictEqual(a.alerts.length, 1);
  assert.strictEqual(a.fills.length, 1);
});

test("detectBlindSpots reports missing types", function() {
  const bus = createEventBus();
  const r = createReflectionEngine({ eventBus: bus });
  bus.emit("selfAudit.alert", {});
  const bs = r.detectBlindSpots();
  assert.ok(bs.length >= 5);
});

test("generateReport produces structured output", function() {
  const bus = createEventBus();
  const r = createReflectionEngine({ eventBus: bus });
  const report = r.generateReport();
  assert.ok(report.generatedAt);
  assert.ok(Array.isArray(report.recommendations));
  assert.ok(report.recommendations.some(function(rec) { return rec.type === "investigate_blind_spots"; }));
});

test("getHistory + stats", function() {
  const bus = createEventBus();
  const r = createReflectionEngine({ eventBus: bus });
  r.generateReport();
  r.generateReport();
  assert.strictEqual(r.getHistory(10).length, 2);
  assert.strictEqual(r.stats().totalFindings, 2);
});

test("clear resets state", function() {
  const bus = createEventBus();
  const r = createReflectionEngine({ eventBus: bus });
  r.generateReport();
  r.clear();
  assert.strictEqual(r.stats().totalFindings, 0);
});

// ===== E2E =====
console.log("\n[e2e]");
test("collector -> bus -> reflection pipeline", function() {
  const bus = createEventBus();
  const coll = createSignalCollector({ eventBus: bus });
  const r = createReflectionEngine({ eventBus: bus });
  coll.recordDecision({ symbol: "005930", action: "BUY" });
  coll.recordFill({ symbol: "005930", side: "BUY", price: 70000 });
  coll.tick();
  const a = r.analyzeRecent(3600000);
  assert.strictEqual(a.decisions.length, 1);
  assert.strictEqual(a.fills.length, 1);
});

console.log("\n===========================================");
console.log("  Results: " + passed + " passed, " + failed + " failed");
console.log("===========================================");
process.exit(failed > 0 ? 1 : 0);
