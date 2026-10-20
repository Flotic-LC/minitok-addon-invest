"use strict";

/**
 * Lightweight metrics registry — counters, gauges, and rolling stats with
 * periodic JSON dump for observability. No external deps.
 *
 * Usage:
 *   const m = createMetrics({ dumpPath, dumpIntervalMs });
 *   m.counter("orders_filled"); m.counter("orders_filled");
 *   m.gauge("equity_krw", 5230000);
 *   m.observe("ai_latency_ms", 850);
 *   m.snapshot() -> { counters, gauges, stats }
 */

const fs = require("node:fs");
const path = require("node:path");

function rollingStat(max = 500) {
  const values = [];
  return {
    add(v) {
      values.push(v);
      if (values.length > max) values.shift();
    },
    summary() {
      if (!values.length) return { n: 0 };
      const sorted = [...values].sort((a, b) => a - b);
      const sum = values.reduce((a, b) => a + b, 0);
      return {
        n: values.length,
        avg: Math.round((sum / values.length) * 100) / 100,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        p50: sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * 0.5))],
        p95: sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * 0.95))],
      };
    },
  };
}

function createMetrics(options = {}) {
  const { dumpPath = null, dumpIntervalMs = 60000, now = () => Date.now() } = options;
  const counters = new Map();
  const gauges = new Map();
  const stats = new Map();
  const startedAt = new Date().toISOString();
  let timer = null;

  function counter(name, delta = 1) {
    counters.set(name, (counters.get(name) || 0) + delta);
    return counters.get(name);
  }

  function gauge(name, value) {
    gauges.set(name, Number(value));
  }

  function observe(name, value) {
    if (!stats.has(name)) stats.set(name, rollingStat());
    stats.get(name).add(Number(value));
  }

  function snapshot() {
    const s = {
      ts: new Date().toISOString(),
      startedAt,
      uptimeSec: Math.floor(process.uptime()),
      counters: Object.fromEntries(counters),
      gauges: Object.fromEntries(gauges),
      stats: {},
    };
    for (const [k, st] of stats) s.stats[k] = st.summary();
    return s;
  }

  function dump() {
    if (!dumpPath) return null;
    try {
      const dir = path.dirname(dumpPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = `${dumpPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(snapshot(), null, 2), "utf8");
      fs.renameSync(tmp, dumpPath);
      return dumpPath;
    } catch (e) {
      console.error("[metrics] dump failed: " + e.message);
      return null;
    }
  }

  function start() {
    if (timer || !dumpPath) return;
    timer = setInterval(dump, dumpIntervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    dump(); // final flush
  }

  return { counter, gauge, observe, snapshot, dump, start, stop };
}

module.exports = { createMetrics };
