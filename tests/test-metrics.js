"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createMetrics } = require("../src/agent/metrics");

test("counter increments and gauge sets", () => {
  const m = createMetrics();
  m.counter("orders");
  m.counter("orders");
  m.counter("orders", 3);
  m.gauge("equity", 5000000);
  const s = m.snapshot();
  assert.equal(s.counters.orders, 5);
  assert.equal(s.gauges.equity, 5000000);
});

test("observe computes rolling stats with percentiles", () => {
  const m = createMetrics();
  for (let i = 1; i <= 100; i++) m.observe("latency", i);
  const s = m.snapshot().stats.latency;
  assert.equal(s.n, 100);
  assert.equal(s.avg, 50.5);
  assert.equal(s.min, 1);
  assert.equal(s.max, 100);
  assert.equal(s.p50, 50);
  assert.ok(s.p95 >= 95);
});

test("dump writes valid JSON to path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "metrics-test-"));
  const dumpPath = path.join(dir, "metrics.json");
  const m = createMetrics({ dumpPath });
  m.counter("test_counter", 42);
  const written = m.dump();
  assert.equal(written, dumpPath);
  const parsed = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
  assert.equal(parsed.counters.test_counter, 42);
  assert.ok(parsed.ts);
  assert.ok(typeof parsed.uptimeSec === "number");
});

test("start/stop manages timer without leaking", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "metrics-test-"));
  const m = createMetrics({ dumpPath: path.join(dir, "m.json"), dumpIntervalMs: 10000 });
  m.start();
  m.stop(); // final dump
  assert.ok(fs.existsSync(path.join(dir, "m.json")));
});

test("dump without path is a no-op", () => {
  const m = createMetrics();
  assert.equal(m.dump(), null);
});
