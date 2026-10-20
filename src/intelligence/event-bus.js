"use strict";

/**
 * Event Bus — central pub/sub for cross-module signal collection.
 * Phase R-1: Collects all observable signals from selfAudit, selfHealing,
 * metaCognition, performanceMonitor, and trading decisions.
 *
 * Usage:
 *   const { createEventBus } = require("./src/intelligence/event-bus");
 *   const bus = createEventBus({ maxHistory: 10000 });
 *   bus.emit("selfAudit.alert", { rule: "data_collection_stall", severity: "critical" });
 *   bus.emit("decision.made", { symbol: "005930", action: "BUY", confidence: 0.82 });
 *   const events = bus.query({ type: "selfAudit.alert", since: Date.now() - 3600000 });
 */

const DEFAULTS = Object.freeze({
  maxHistory: Number(process.env.EVENT_BUS_MAX_HISTORY || 10000),
  maxAge: Number(process.env.EVENT_BUS_MAX_AGE_MS || 86400000 * 7), // 7 days
  now: () => Date.now(),
});

function createEventBus(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const history = [];
  const listeners = new Map(); // type -> [fn]
  const counters = {
    totalEmitted: 0,
    // [2026-10-21] Retention, not data loss. The bus is a bounded ring
    // buffer: the oldest event is evicted when the buffer is full, and
    // expired events are pruned by age. The durable record lives in the
    // event store, so neither eviction means a lost event. They used to be
    // summed into one "totalDropped" counter, which read as a 43% loss rate
    // when it was simply normal retention. The two causes are now counted
    // separately.
    evictedByCapacity: 0,
    evictedByAge: 0,
    byType: {},
  };

  function emit(type, data) {
    if (!type || typeof type !== "string") return false;
    
    const event = {
      id: "evt-" + cfg.now() + "-" + Math.random().toString(36).slice(2, 8),
      type,
      data: data || {},
      ts: new Date(cfg.now()).toISOString(),
      tsMs: cfg.now(),
    };

    // Prune old events (batch splice instead of O(n) per-element shift)
    const cutoff = cfg.now() - cfg.maxAge;
    let pruneIdx = 0;
    while (pruneIdx < history.length && history[pruneIdx].tsMs < cutoff) pruneIdx++;
    if (pruneIdx > 0) {
      history.splice(0, pruneIdx);
      counters.evictedByAge += pruneIdx;
    }

    // Enforce max history. Once the buffer is full the oldest event is
    // evicted on every emit, and splicing a single element off the front of
    // a full buffer turns each emit into an O(n) memmove. Evict in batches
    // instead — the buffer stays within maxHistory either way.
    if (history.length >= cfg.maxHistory) {
      const overflow = history.length - cfg.maxHistory + 1;
      const batch = Math.max(overflow, Math.ceil(cfg.maxHistory * 0.05));
      history.splice(0, batch);
      counters.evictedByCapacity += batch;
    }

    history.push(event);
    counters.totalEmitted++;
    counters.byType[type] = (counters.byType[type] || 0) + 1;

    // Notify listeners
    const typeListeners = listeners.get(type) || [];
    for (const fn of typeListeners) {
      try {
        fn(event);
      } catch (e) {
        console.error("[event-bus] Listener error for " + type + ": " + e.message);
      }
    }

    // Wildcard listeners
    const wildcardListeners = listeners.get("*") || [];
    for (const fn of wildcardListeners) {
      try {
        fn(event);
      } catch (e) {
        console.error("[event-bus] Wildcard listener error: " + e.message);
      }
    }

    return event.id;
  }

  function on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
    return () => off(type, fn);
  }

  function off(type, fn) {
    const arr = listeners.get(type);
    if (!arr) return;
    const idx = arr.indexOf(fn);
    if (idx >= 0) arr.splice(idx, 1);
  }

  function query(filter) {
    if (!filter) return history.slice();
    
    let result = history;
    
    if (filter.type) {
      result = result.filter(e => e.type === filter.type || e.type.startsWith(filter.type + "."));
    }
    
    if (filter.since) {
      result = result.filter(e => e.tsMs >= filter.since);
    }
    
    if (filter.until) {
      result = result.filter(e => e.tsMs <= filter.until);
    }
    
    if (filter.limit && filter.limit > 0) {
      result = result.slice(-filter.limit);
    }
    
    return result;
  }

  function aggregate(type, windowMs) {
    const events = query({ type });
    if (events.length === 0) return { count: 0, windows: [] };

    const windows = new Map();
    for (const e of events) {
      const bucket = Math.floor(e.tsMs / windowMs) * windowMs;
      if (!windows.has(bucket)) windows.set(bucket, []);
      windows.get(bucket).push(e);
    }

    return {
      count: events.length,
      windowMs,
      windows: Array.from(windows.entries()).map(([ts, evts]) => ({
        ts: new Date(ts).toISOString(),
        tsMs: ts,
        count: evts.length,
        events: evts,
      })),
    };
  }

  function stats() {
    // How far back the buffer can actually be queried. A consumer that asks
    // for a window wider than this simply gets nothing for the older part —
    // the span makes that visible instead of surprising.
    const spanMs = history.length > 1
      ? history[history.length - 1].tsMs - history[0].tsMs
      : 0;
    return {
      totalEmitted: counters.totalEmitted,
      // Kept for backward compatibility: the sum of both retention causes.
      totalDropped: counters.evictedByCapacity + counters.evictedByAge,
      evictedByCapacity: counters.evictedByCapacity,
      evictedByAge: counters.evictedByAge,
      currentSize: history.length,
      maxHistory: cfg.maxHistory,
      capacityUsedPct: cfg.maxHistory > 0 ? Math.round((history.length / cfg.maxHistory) * 1000) / 10 : 0,
      historySpanMs: spanMs,
      historySpanMinutes: Math.round(spanMs / 60000),
      uniqueTypes: Object.keys(counters.byType).length,
      byType: { ...counters.byType },
    };
  }

  function clear() {
    history.length = 0;
    counters.totalEmitted = 0;
    counters.evictedByCapacity = 0;
    counters.evictedByAge = 0;
    counters.byType = {};
  }

  function state(maxEvents) {
    // [2026-10-21] The persisted slice can be capped. The raw history was
    // the bulk of the runner's state file and nothing read it — long
    // analysis windows are served by the correlation engine's own rolling
    // counters.
    const limit = Number(maxEvents) > 0 ? Number(maxEvents) : 0;
    return {
      history: limit > 0 ? history.slice(-limit) : history.slice(),
      counters: { ...counters, byType: { ...counters.byType } },
    };
  }

  function restore(saved) {
    if (!saved) return;
    if (Array.isArray(saved.history)) {
      history.length = 0;
      for (const e of saved.history) history.push(e);
    }
    if (saved.counters) {
      Object.assign(counters, saved.counters);
      if (saved.counters.byType) {
        counters.byType = { ...saved.counters.byType };
      }
    }
  }

  return {
    emit, on, off, query, aggregate, stats, clear, state, restore,
  };
}

module.exports = { createEventBus, DEFAULTS };
