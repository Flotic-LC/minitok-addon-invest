"use strict";
/**
 * Event-bus retention accounting (2026-10-21).
 *
 * The bus is a bounded ring buffer, so the oldest event is evicted when the
 * buffer is full. That used to be reported as one "totalDropped" counter,
 * which read as a 43% data-loss rate when it was ordinary retention. The two
 * causes are now counted separately and the queryable span is exposed.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { createEventBus } = require("../src/intelligence/event-bus");

test("capacity eviction is counted separately from age expiry", () => {
  let clock = 1000;
  const bus = createEventBus({ maxHistory: 3, maxAge: 100000, now: () => clock });
  for (let i = 0; i < 5; i++) { bus.emit("t.a", { i }); clock += 10; }
  const s = bus.stats();
  assert.equal(s.totalEmitted, 5);
  assert.equal(s.currentSize, 3);
  assert.equal(s.evictedByCapacity, 2);
  assert.equal(s.evictedByAge, 0);
  assert.equal(s.totalDropped, 2);
});

test("age expiry is counted separately from capacity eviction", () => {
  let clock = 1000;
  const bus = createEventBus({ maxHistory: 100, maxAge: 50, now: () => clock });
  bus.emit("t.a", {});           // ts 1000
  clock += 100;                  // now 1100 — the first event is older than maxAge
  bus.emit("t.b", {});           // prunes the first
  const s = bus.stats();
  assert.equal(s.evictedByAge, 1);
  assert.equal(s.evictedByCapacity, 0);
  assert.equal(s.totalDropped, 1);
});

test("stats expose the span the buffer can actually be queried over", () => {
  let clock = 1000;
  const bus = createEventBus({ maxHistory: 10, maxAge: 100000, now: () => clock });
  bus.emit("t.a", {});
  clock += 60000;
  bus.emit("t.b", {});
  const s = bus.stats();
  assert.equal(s.historySpanMs, 60000);
  assert.equal(s.historySpanMinutes, 1);
  assert.equal(s.capacityUsedPct, 20);
});

test("clear resets the retention counters", () => {
  let clock = 1000;
  const bus = createEventBus({ maxHistory: 2, maxAge: 100000, now: () => clock });
  bus.emit("t.a", {}); bus.emit("t.b", {}); bus.emit("t.c", {});
  assert.ok(bus.stats().evictedByCapacity > 0);
  bus.clear();
  const s = bus.stats();
  assert.equal(s.totalEmitted, 0);
  assert.equal(s.evictedByCapacity, 0);
  assert.equal(s.evictedByAge, 0);
  assert.equal(s.currentSize, 0);
});
