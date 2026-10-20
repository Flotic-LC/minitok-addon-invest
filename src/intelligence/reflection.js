"use strict";

/**
 * Reflection Engine — post-mortem analysis and pattern discovery.
 * Phase R-1: Collects signals and provides basic analysis.
 * Phase R-2: Cross-layer correlation and hypothesis generation.
 */

const DEFAULTS = Object.freeze({
  analysisWindowMs: Number(process.env.REFLECTION_WINDOW_MS || 3600000),
  minEventsForPattern: Number(process.env.REFLECTION_MIN_EVENTS || 5),
  blindSpotThreshold: Number(process.env.REFLECTION_BLIND_SPOT || 0.1),
  maxHistory: Number(process.env.REFLECTION_MAX_HISTORY || 1000),
});

function createReflectionEngine(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const eventBus = cfg.eventBus;
  if (!eventBus) throw new Error("eventBus is required");

  const findings = [];
  const patterns = [];
  const blindSpots = new Map();
  const expectedTypes = new Set([
    "selfAudit.alert", "selfHealing.incident", "metaCognition.decision",
    "metaCognition.outcome", "decision.made", "trading.fill", "metrics.snapshot",
  ]);
  const typeCounts = new Map();

  eventBus.on("*", (event) => {
    typeCounts.set(event.type, (typeCounts.get(event.type) || 0) + 1);
  });

  function analyzeRecent(windowMs) {
    const since = Date.now() - (windowMs || cfg.analysisWindowMs);
    const events = eventBus.query({ since });
    const analysis = {
      windowMs: windowMs || cfg.analysisWindowMs,
      since: new Date(since).toISOString(),
      totalEvents: events.length,
      byType: {},
      alerts: [], incidents: [], decisions: [], fills: [],
    };
    for (const e of events) {
      analysis.byType[e.type] = (analysis.byType[e.type] || 0) + 1;
      if (e.type === "selfAudit.alert") analysis.alerts.push(e.data);
      else if (e.type === "selfHealing.incident") analysis.incidents.push(e.data);
      else if (e.type === "decision.made" || e.type === "metaCognition.decision") analysis.decisions.push(e.data);
      else if (e.type === "trading.fill") analysis.fills.push(e.data);
    }
    analysis.alertRate = events.length > 0 ? analysis.alerts.length / (events.length / 100) : 0;
    analysis.fillRate = analysis.decisions.length > 0 ? analysis.fills.length / analysis.decisions.length : 0;
    analysis.incidentRate = events.length > 0 ? analysis.incidents.length / (events.length / 100) : 0;
    return analysis;
  }

  function findPatterns() {
    const events = eventBus.query({ since: Date.now() - cfg.analysisWindowMs * 24 });
    const discovered = [];
    const alertEvents = events.filter(e => e.type === "selfAudit.alert");
    if (alertEvents.length >= cfg.minEventsForPattern) {
      const byRule = {};
      for (const a of alertEvents) {
        const rule = a.data.rule || "unknown";
        byRule[rule] = (byRule[rule] || 0) + 1;
      }
      const topRules = Object.entries(byRule).sort((a, b) => b[1] - a[1]).slice(0, 3);
      if (topRules.length > 0 && topRules[0][1] >= cfg.minEventsForPattern) {
        discovered.push({
          type: "alert_clustering",
          description: "Alert clustering: " + topRules[0][0] + " fired " + topRules[0][1] + " times in 24h",
          confidence: Math.min(1.0, topRules[0][1] / 20),
          severity: "warning",
          data: { topRules, totalAlerts: alertEvents.length },
        });
      }
    }
    const decisions = events.filter(e => e.type === "decision.made");
    const fills = events.filter(e => e.type === "trading.fill");
    if (decisions.length >= 10) {
      const fillRate = fills.length / decisions.length;
      if (fillRate < 0.05) {
        discovered.push({
          type: "low_fill_rate",
          description: "Low fill rate: " + fills.length + "/" + decisions.length + " (" + (fillRate * 100).toFixed(1) + "%)",
          confidence: 0.8,
          severity: "info",
          data: { fillRate, decisions: decisions.length, fills: fills.length },
        });
      }
    }
    for (const p of discovered) {
      patterns.push(Object.assign({}, p, { discoveredAt: new Date().toISOString() }));
      if (patterns.length > cfg.maxHistory) patterns.shift();
    }
    return discovered;
  }

  function detectBlindSpots() {
    const detected = [];
    const totalEvents = Array.from(typeCounts.values()).reduce((a, b) => a + b, 0);
    for (const type of expectedTypes) {
      const count = typeCounts.get(type) || 0;
      const ratio = totalEvents > 0 ? count / totalEvents : 0;
      if (count === 0 || ratio < cfg.blindSpotThreshold) {
        detected.push({
          type: "missing_signal",
          eventType: type,
          count: count,
          ratio: ratio,
          description: "Expected \"" + type + "\" is missing or low (" + count + " events, " + (ratio * 100).toFixed(1) + "%)",
          severity: count === 0 ? "warning" : "info",
        });
        blindSpots.set(type, { count, ratio, detectedAt: Date.now() });
      }
    }
    return detected;
  }

  function generateReport() {
    const analysis = analyzeRecent(3600000);
    const recentPatterns = findPatterns();
    const bs = detectBlindSpots();
    const report = {
      generatedAt: new Date().toISOString(),
      summary: {
        totalEvents1h: analysis.totalEvents,
        alerts1h: analysis.alerts.length,
        incidents1h: analysis.incidents.length,
        decisions1h: analysis.decisions.length,
        fills1h: analysis.fills.length,
      },
      patterns: recentPatterns,
      blindSpots: bs,
      recommendations: [],
    };
    if (bs.length > 0) {
      report.recommendations.push({ type: "investigate_blind_spots", priority: "high", description: bs.length + " blind spot(s) detected" });
    }
    if (recentPatterns.some(function(p) { return p.type === "alert_clustering"; })) {
      report.recommendations.push({ type: "review_alert_rules", priority: "medium", description: "Alert clustering detected" });
    }
    findings.push(report);
    if (findings.length > cfg.maxHistory) findings.shift();
    return report;
  }

  function getHistory(limit) { return findings.slice(-(limit || 10)); }

  function stats() {
    return {
      totalFindings: findings.length,
      totalPatterns: patterns.length,
      blindSpotsTracked: blindSpots.size,
      eventTypesObserved: typeCounts.size,
      expectedTypes: expectedTypes.size,
    };
  }

  function clear() {
    findings.length = 0;
    patterns.length = 0;
    blindSpots.clear();
    typeCounts.clear();
  }

  return {
    analyzeRecent, findPatterns, detectBlindSpots,
    generateReport, getHistory, stats, clear,
  };
}

module.exports = { createReflectionEngine, DEFAULTS };
