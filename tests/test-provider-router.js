"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createProviderRouter, extractJson } = require("../src/ai/provider-router");

test("extractJson handles plain JSON", () => {
  const r = extractJson('{"action":"BUY","symbol":"X"}');
  assert.deepEqual(r, { action: "BUY", symbol: "X" });
});

test("extractJson strips markdown fences", () => {
  const r = extractJson('```json\n{"action":"SELL"}\n```');
  assert.deepEqual(r, { action: "SELL" });
});

test("extractJson handles surrounding text", () => {
  const r = extractJson('Sure! Here: {"action":"HOLD","reason":"ok"} Done.');
  assert.deepEqual(r, { action: "HOLD", reason: "ok" });
});

test("extractJson returns null on bad input", () => {
  assert.equal(extractJson("no json here"), null);
  assert.equal(extractJson("{broken"), null);
  assert.equal(extractJson(""), null);
  assert.equal(extractJson(null), null);
});

function makeFetch(responses) {
  let i = 0;
  return async () => {
    const r = responses[i++];
    if (!r) throw new Error("no more responses");
    if (r instanceof Error) throw r;
    return {
      ok: r.ok !== false,
      status: r.status || 200,
      async text() { return r.text || ""; },
      async json() { return r.body; },
    };
  };
}

const goodBody = { choices: [{ message: { content: '{"action":"BUY","symbol":"X"}' } }] };

test("router returns parsed JSON on success", async () => {
  const router = createProviderRouter({
    providers: [{ name: "a", key: "k", baseUrl: "http://a", model: "m" }],
    fetchImpl: makeFetch([{ body: goodBody }]),
  });
  const r = await router.call([{ role: "user", content: "hi" }]);
  assert.deepEqual(r, { action: "BUY", symbol: "X" });
  const s = router.stats();
  assert.equal(s.providers[0].successes, 1);
  assert.equal(s.providers[0].failures, 0);
});

test("router fails over to second provider when first throws", async () => {
  const fetchImpl = makeFetch([
    new Error("network down"),
    { body: goodBody },
  ]);
  const router = createProviderRouter({
    providers: [
      { name: "a", key: "k", baseUrl: "http://a", model: "m" },
      { name: "b", key: "k", baseUrl: "http://b", model: "m" },
    ],
    fetchImpl,
    maxRetries: 0,
  });
  const r = await router.call([{ role: "user", content: "x" }]);
  assert.deepEqual(r, { action: "BUY", symbol: "X" });
  const s = router.stats();
  assert.equal(s.providers[0].failures, 1);
  assert.equal(s.providers[1].successes, 1);
});

test("router returns null when all providers fail", async () => {
  const fetchImpl = makeFetch([new Error("x"), new Error("y")]);
  const router = createProviderRouter({
    providers: [
      { name: "a", key: "k", baseUrl: "http://a", model: "m" },
      { name: "b", key: "k", baseUrl: "http://b", model: "m" },
    ],
    fetchImpl,
    maxRetries: 0,
  });
  const r = await router.call([{ role: "user", content: "x" }]);
  assert.equal(r, null);
});

test("circuit breaker opens after threshold failures", async () => {
  const fetchImpl = makeFetch([
    new Error("e1"), new Error("e2"), new Error("e3"),
  ]);
  const router = createProviderRouter({
    providers: [
      { name: "a", key: "k", baseUrl: "http://a", model: "m" },
      { name: "b", key: "k", baseUrl: "http://b", model: "m" },
    ],
    fetchImpl,
    circuitBreakerThreshold: 2,
    maxRetries: 0,
  });
  await router.call([]);
  await router.call([]);
  const s = router.stats();
  assert.equal(s.providers[0].circuitOpen, true);
});

test("resetCircuit() re-enables all providers", async () => {
  // Call 1: a fails (consec=1), b fails (consec=1) -> both still healthy
  // Call 2: a fails (consec=2, opens), b fails (consec=2, opens) -> both open
  // resetCircuit() closes both
  // Call 3: a succeeds with goodBody
  const fetchImpl = makeFetch([
    new Error("x"), new Error("x"),
    new Error("x"), new Error("x"),
    { body: goodBody },
  ]);
  const router = createProviderRouter({
    providers: [
      { name: "a", key: "k", baseUrl: "http://a", model: "m" },
      { name: "b", key: "k", baseUrl: "http://b", model: "m" },
    ],
    fetchImpl,
    circuitBreakerThreshold: 2,
    circuitBreakerCooldownMs: 999999,
    maxRetries: 0,
  });
  const r1 = await router.call([]);
  assert.equal(r1, null);
  const r2 = await router.call([]);
  assert.equal(r2, null);
  const s = router.stats();
  assert.equal(s.providers[0].circuitOpen, true);
  assert.equal(s.providers[1].circuitOpen, true);
  router.resetCircuit();
  const r3 = await router.call([]);
  assert.deepEqual(r3, { action: "BUY", symbol: "X" });
});

test("stats() shows healthy vs total counts", () => {
  const router = createProviderRouter({
    providers: [
      { name: "a", key: "k", baseUrl: "http://a", model: "m" },
      { name: "b", key: "k", baseUrl: "http://b", model: "m" },
    ],
    fetchImpl: async () => ({}),
  });
  const s = router.stats();
  assert.equal(s.totalCount, 2);
  assert.equal(s.healthyCount, 2);
});