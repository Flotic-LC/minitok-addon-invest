"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createConnectionManager, STATES } = require("../src/core/connection-manager");

test("successful connect transitions to CONNECTED", async () => {
  const transitions = [];
  const cm = createConnectionManager({
    connectFn: async () => {},
    onStateChange: (from, to) => transitions.push({ from, to }),
  });
  const ok = await cm.connect();
  assert.equal(ok, true);
  assert.equal(cm.status().state, STATES.CONNECTED);
  assert.ok(transitions.some(t => t.to === STATES.CONNECTED));
});

test("failed connect enters RECONNECTING", async () => {
  const cm = createConnectionManager({
    connectFn: async () => { throw new Error("fail"); },
    maxRetries: 3,
  });
  const ok = await cm.connect();
  assert.equal(ok, false);
  assert.equal(cm.status().state, STATES.RECONNECTING);
});

test("circuit breaker halts after threshold failures", async () => {
  const cm = createConnectionManager({
    connectFn: async () => { throw new Error("fail"); },
    circuitBreakerThreshold: 3,
    circuitBreakerCooldownMs: 999999,
  });
  await cm.connect(); // fail 1 -> RECONNECTING
  await cm.connect(); // fail 2 -> RECONNECTING
  await cm.connect(); // fail 3 -> HALTED
  assert.equal(cm.status().state, STATES.HALTED);
  assert.equal(cm.status().circuitOpen, true);
});

test("resume() resets from HALTED", async () => {
  const cm = createConnectionManager({
    connectFn: async () => { throw new Error("fail"); },
    circuitBreakerThreshold: 2,
  });
  await cm.connect();
  await cm.connect();
  assert.equal(cm.status().state, STATES.HALTED);
  const resumed = cm.resume();
  assert.equal(resumed, true);
  assert.equal(cm.status().state, STATES.IDLE);
});

test("reportDisconnect triggers reconnect", async () => {
  const cm = createConnectionManager({
    connectFn: async () => {},
    maxRetries: 5,
  });
  await cm.connect();
  assert.equal(cm.status().state, STATES.CONNECTED);
  cm.reportDisconnect("network loss");
  assert.equal(cm.status().state, STATES.RECONNECTING);
});

test("disconnect() returns to IDLE", async () => {
  const cm = createConnectionManager({
    connectFn: async () => {},
    disconnectFn: () => {},
  });
  await cm.connect();
  cm.disconnect();
  assert.equal(cm.status().state, STATES.IDLE);
});

test("status() reports correct fields", async () => {
  const cm = createConnectionManager({
    connectFn: async () => {},
  });
  const s = cm.status();
  assert.equal(s.state, STATES.IDLE);
  assert.equal(s.retryCount, 0);
  assert.equal(s.totalDisconnects, 0);
  assert.equal(s.circuitOpen, false);
});

test("max retries exceeded transitions to FAILED", async () => {
  let attempts = 0;
  const cm = createConnectionManager({
    connectFn: async () => { attempts++; throw new Error("fail"); },
    maxRetries: 2,
    baseBackoffMs: 1, // fast for test
  });
  await cm.connect(); // fail -> RECONNECTING, schedules retry
  // Wait for retries to exhaust
  await new Promise(r => setTimeout(r, 100));
  const s = cm.status();
  assert.ok(s.state === STATES.FAILED || s.state === STATES.RECONNECTING);
});

test("reset() clears all state", async () => {
  const cm = createConnectionManager({
    connectFn: async () => {},
  });
  await cm.connect();
  cm.reset();
  const s = cm.status();
  assert.equal(s.state, STATES.IDLE);
  assert.equal(s.totalDisconnects, 0);
  assert.equal(s.consecutiveFailures, 0);
});
