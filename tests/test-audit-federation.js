"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createAuditFederation, BUILTIN_ROUTES, DEFAULTS } = require("../src/core/audit-federation");

test("module exports createAuditFederation and constants", () => {
  assert.equal(typeof createAuditFederation, "function");
  assert.ok(Array.isArray(BUILTIN_ROUTES.trading));
  assert.ok(Array.isArray(BUILTIN_ROUTES.constitution));
  assert.ok(DEFAULTS);
});

test("creates federation with no sinks", () => {
  const fed = createAuditFederation({});
  const s = fed.stats();
  assert.equal(s.sinks.local, false);
  assert.equal(s.sinks.minitok, false);
  assert.equal(s.sinks.remote, false);
  assert.equal(s.counters.total, 0);
});

test("classifyCategory maps known event types", () => {
  const fed = createAuditFederation({});
  assert.equal(fed.classifyCategory("order"), "trading");
  assert.equal(fed.classifyCategory("constitution_violation"), "constitution");
  assert.equal(fed.classifyCategory("escalation_created"), "escalation");
  assert.equal(fed.classifyCategory("lifecycle_promote"), "lifecycle");
  assert.equal(fed.classifyCategory("goal_started"), "goal");
  assert.equal(fed.classifyCategory("killswitch_triggered"), "killswitch");
  assert.equal(fed.classifyCategory("unknown_event"), "other");
});

test("write routes to local sink", () => {
  const calls = [];
  const mockLocal = { custom: function(t, d) { calls.push({ t: t, d: d }); } };
  const fed = createAuditFederation({ localAudit: mockLocal });
  const r = fed.write("order", { symbol: "005930" });
  assert.equal(r.local, true);
  assert.equal(r.minitok, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].d.federationCategory, "trading");
});

test("write routes constitution events to minitok", () => {
  const calls = [];
  const mockMinitok = { auditLog: function(e) { calls.push(e); return { persisted: true }; } };
  const fed = createAuditFederation({ minitokAudit: mockMinitok });
  const r = fed.write("constitution_violation", { rule: "x" });
  assert.equal(r.minitok, true);
  assert.equal(calls[0].type, "addon-constitution_violation");
  assert.equal(calls[0].source, "tossinvest");
});

test("write does NOT route trading events to minitok", () => {
  const calls = [];
  const mockMinitok = { auditLog: function(e) { calls.push(e); return { persisted: true }; } };
  const fed = createAuditFederation({ minitokAudit: mockMinitok });
  fed.write("order", {});
  assert.equal(calls.length, 0);
});

test("write handles local sink errors gracefully", () => {
  const mockLocal = { custom: function() { throw new Error("disk full"); } };
  const fed = createAuditFederation({ localAudit: mockLocal });
  const r = fed.write("order", {});
  assert.equal(r.local, false);
  assert.equal(fed.stats().counters.localErrors, 1);
  assert.equal(fed.getHistory(10).length, 1);
});

test("write handles minitok sink errors gracefully", () => {
  const mockMinitok = { auditLog: function() { throw new Error("timeout"); } };
  const fed = createAuditFederation({ minitokAudit: mockMinitok });
  const r = fed.write("constitution_violation", {});
  assert.equal(r.minitok, false);
  assert.equal(fed.stats().counters.minitokErrors, 1);
});

test("write routes to remote sink", async () => {
  let captured = null;
  const mockFetch = function(url, opts) {
    captured = { url: url, opts: opts };
    return Promise.resolve({ ok: true, status: 200 });
  };
  const fed = createAuditFederation({
    remoteEndpoint: "https://siem.example.com/audit",
    fetch: mockFetch,
    config: { remoteEnabled: true },
  });
  const r = fed.write("order", { symbol: "TSLA" });
  assert.equal(await r.remote, true);
  assert.equal(captured.opts.method, "POST");
  const body = JSON.parse(captured.opts.body);
  assert.equal(body.source, "tossinvest");
  assert.equal(body.data.symbol, "TSLA");
});

test("write handles remote HTTP errors", async () => {
  const mockFetch = function() { return Promise.resolve({ ok: false, status: 503 }); };
  const fed = createAuditFederation({
    remoteEndpoint: "https://siem.example.com/audit",
    fetch: mockFetch,
    config: { remoteEnabled: true },
  });
  const r = fed.write("order", {});
  assert.equal(await r.remote, false);
  assert.equal(fed.stats().counters.remoteErrors, 1);
});

test("write handles remote fetch exceptions", async () => {
  const mockFetch = function() { return Promise.reject(new Error("ECONNREFUSED")); };
  const fed = createAuditFederation({
    remoteEndpoint: "https://siem.example.com/audit",
    fetch: mockFetch,
    config: { remoteEnabled: true },
  });
  const r = fed.write("order", {});
  assert.equal(await r.remote, false);
  assert.equal(fed.stats().counters.remoteErrors, 1);
  assert.ok(fed.getHistory(5).some(function(h) { return h.sink === "remote"; }));
});

test("write is no-op when disabled", () => {
  const mockLocal = { custom: function() { throw new Error("should not run"); } };
  const fed = createAuditFederation({ localAudit: mockLocal, config: { enabled: false } });
  const r = fed.write("order", {});
  assert.equal(r.category, "disabled");
  assert.equal(fed.stats().counters.total, 0);
});

test("write increments byCategory counters", () => {
  const fed = createAuditFederation({});
  fed.write("order", {});
  fed.write("decision", {});
  fed.write("constitution_violation", {});
  fed.write("unknown", {});
  const s = fed.stats();
  assert.equal(s.counters.total, 4);
  assert.equal(s.counters.byCategory.trading, 2);
  assert.equal(s.counters.byCategory.constitution, 1);
  assert.equal(s.counters.byCategory.other, 1);
});

test("getRoutes returns defensive copy", () => {
  const fed = createAuditFederation({});
  const r1 = fed.getRoutes();
  r1.trading.push("MUTATED");
  const r2 = fed.getRoutes();
  assert.ok(!r2.trading.includes("MUTATED"));
});

test("history respects maxHistorySize", () => {
  const mockLocal = { custom: function() { throw new Error("x"); } };
  const fed = createAuditFederation({ localAudit: mockLocal, config: { maxHistorySize: 3 } });
  for (let i = 0; i < 10; i++) fed.write("order", { i: i });
  assert.equal(fed.getHistory().length, 3);
  assert.equal(fed.getHistory(2).length, 2);
});

test("custom routes override builtin", () => {
  const fed = createAuditFederation({
    config: { routes: { custom: ["my_event"] } },
  });
  assert.equal(fed.classifyCategory("my_event"), "custom");
  assert.equal(fed.classifyCategory("order"), "other");
});