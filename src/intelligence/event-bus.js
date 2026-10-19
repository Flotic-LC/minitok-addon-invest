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
    totalDropped: 0,
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
    if (pruneIdx > 0) history.splice(0, pruneIdx);

    // Enforce max history
    if (history.length >= cfg.maxHistory) {
      const overflow = history.length - cfg.maxHistory + 1;
      history.splice(0, overflow);
      counters.totalDropped += overflow;
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
    return {
      totalEmitted: counters.totalEmitted,
      totalDropped: counters.totalDropped,
      currentSize: history.length,
      maxHistory: cfg.maxHistory,
      uniqueTypes: Object.keys(counters.byType).length,
      byType: { ...counters.byType },
    };
  }

  function clear() {
    history.length = 0;
    counters.totalEmitted = 0;
    counters.totalDropped = 0;
    counters.byType = {};
  }

  function state() {
    return {
      history: history.slice(),
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
