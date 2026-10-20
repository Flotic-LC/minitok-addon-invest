"use strict";

/**
 * Signal Collector — wires all observable subsystems to the event bus.
 * Phase R-1: Automatically captures signals from selfAudit, selfHealing,
 * metaCognition, performanceMonitor, and trading decisions.
 *
 * Usage:
 *   const { createSignalCollector } = require("./src/intelligence/signal-collector");
 *   const collector = createSignalCollector({ eventBus });
 *   collector.attachSelfAudit(selfAudit);
 *   collector.attachSelfHealing(selfHealer);
 *   collector.attachMetaCognition(metaCognition);
 *   collector.tick(); // call periodically to snapshot metrics
 */

const DEFAULTS = Object.freeze({
  tickIntervalMs: Number(process.env.SIGNAL_COLLECTOR_TICK_MS || 60000), // 1 min
  snapshotEvery: Number(process.env.SIGNAL_COLLECTOR_SNAPSHOT_EVERY || 5), // every 5 ticks
});

function createSignalCollector(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const eventBus = cfg.eventBus;
  if (!eventBus) throw new Error("eventBus is required");

  const refs = {
    selfAudit: null,
    selfHealing: null,
    metaCognition: null,
    perfMonitor: null,
    lifecycle: null,
  };

  const counters = {
    ticks: 0,
    snapshots: 0,
    auditAlerts: 0,
    healingIncidents: 0,
    decisions: 0,
    fills: 0,
  };

  let lastMetrics = null;
  let lastSnapshotTs = 0;

  function attachSelfAudit(sa) {
    if (!sa) return;
    refs.selfAudit = sa;
    // Hook into alertFn to capture audit alerts as events
    const origAlertFn = sa.alertFn;
    sa.alertFn = function(msg, severity) {
      counters.auditAlerts++;
      eventBus.emit("selfAudit.alert", {
        message: msg,
        severity: severity || "warning",
        source: "selfAudit",
      });
      if (origAlertFn) origAlertFn(msg, severity);
    };
  }

  function attachSelfHealing(sh) {
    if (!sh) return;
    refs.selfHealing = sh;
    // Wrap onIncident to emit events
    const origOnIncident = sh._onIncident || null;
    if (sh.reportIncident) {
      const origReport = sh.reportIncident;
      sh.reportIncident = function(type, ctx) {
        counters.healingIncidents++;
        eventBus.emit("selfHealing.incident", {
          incidentType: type,
          ctx: ctx || {},
          source: "selfHealing",
        });
        return origReport.call(sh, type, ctx);
      };
    }
  }

  function attachMetaCognition(mc) {
    if (!mc) return;
    refs.metaCognition = mc;
    // Wrap recordDecision to emit events
    const origRecord = mc.recordDecision;
    mc.recordDecision = function(id, ctx) {
      counters.decisions++;
      eventBus.emit("metaCognition.decision", {
        decisionId: id,
        ctx: ctx || {},
        source: "metaCognition",
      });
      return origRecord.call(mc, id, ctx);
    };
    // Wrap attachOutcome
    const origOutcome = mc.attachOutcome;
    mc.attachOutcome = function(id, outcome) {
      eventBus.emit("metaCognition.outcome", {
        decisionId: id,
        outcome: outcome || {},
        source: "metaCognition",
      });
      return origOutcome.call(mc, id, outcome);
    };
  }

  function recordFill(fill) {
    if (!fill) return;
    counters.fills++;
    eventBus.emit("trading.fill", {
      symbol: fill.symbol,
      side: fill.side,
      price: fill.price,
      quantity: fill.quantity,
      pnl: fill.pnl,
      slippage: fill.slippage,
      source: "trading",
    });
  }

  function recordDecision(decision) {
    if (!decision) return;
    counters.decisions++;
    eventBus.emit("decision.made", {
      symbol: decision.symbol,
      action: decision.action,
      reason: decision.reason,
      confidence: decision.confidence,
      strategy: decision.strategy,
      source: "decision",
    });
  }

  function tick() {
    counters.ticks++;
    const now = Date.now();

    // Snapshot selfAudit metrics
    if (refs.selfAudit && refs.selfAudit.getMetrics) {
      const metrics = refs.selfAudit.getMetrics();
      eventBus.emit("metrics.snapshot", {
        source: "selfAudit",
        metrics: metrics,
      });
      lastMetrics = metrics;
    }

    // Snapshot selfHealing stats
    if (refs.selfHealing && refs.selfHealing.stats) {
      const stats = refs.selfHealing.stats();
      eventBus.emit("metrics.snapshot", {
        source: "selfHealing",
        stats: stats,
      });
    }

    // Snapshot metaCognition stats
    if (refs.metaCognition && refs.metaCognition.stats) {
      const stats = refs.metaCognition.stats();
      eventBus.emit("metrics.snapshot", {
        source: "metaCognition",
        stats: stats,
      });
    }

    // Snapshot perfMonitor report
    if (refs.perfMonitor && refs.perfMonitor.report) {
      const report = refs.perfMonitor.report();
      eventBus.emit("metrics.snapshot", {
        source: "perfMonitor",
        report: report,
      });
    }

    // Periodic full snapshot
    if (now - lastSnapshotTs > cfg.tickIntervalMs * cfg.snapshotEvery) {
      counters.snapshots++;
      lastSnapshotTs = now;
      eventBus.emit("collector.snapshot", {
        counters: { ...counters },
        ts: new Date(now).toISOString(),
      });
    }

    return { ticks: counters.ticks, snapshots: counters.snapshots };
  }

  function attachPerfMonitor(pm) {
    if (!pm) return;
    refs.perfMonitor = pm;
  }

  function attachLifecycle(lc) {
    if (!lc) return;
    refs.lifecycle = lc;
  }

  function stats() {
    return {
      ...counters,
      attached: {
        selfAudit: !!refs.selfAudit,
        selfHealing: !!refs.selfHealing,
        metaCognition: !!refs.metaCognition,
        perfMonitor: !!refs.perfMonitor,
        lifecycle: !!refs.lifecycle,
      },
    };
  }

  return {
    attachSelfAudit, attachSelfHealing, attachMetaCognition,
    attachPerfMonitor, attachLifecycle,
    recordFill, recordDecision, tick, stats,
  };
}

module.exports = { createSignalCollector, DEFAULTS };
