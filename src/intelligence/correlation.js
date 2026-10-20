"use strict";

/**
 * Cross-Layer Correlation Engine — Phase R-2.
 * Finds statistical relationships between operational signals and trading outcomes.
 */

const DEFAULTS = Object.freeze({
  windowMs: Number(process.env.CORR_WINDOW_MS || 86400000),
  bucketMs: Number(process.env.CORR_BUCKET_MS || 3600000),
  maxLagBuckets: Number(process.env.CORR_MAX_LAG || 4),
  minSamples: Number(process.env.CORR_MIN_SAMPLES || 3),
  maxHistory: Number(process.env.CORR_MAX_HISTORY || 500),
  // [2026-10-21] How long the rolling counters keep a bucket.
  retentionMs: Number(process.env.CORR_RETENTION_MS || 86400000 * 7),
  now: () => Date.now(),
});

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return { r: 0, n: n, reason: "insufficient" };
  const meanX = xs.reduce(function(s, v) { return s + v; }, 0) / n;
  const meanY = ys.reduce(function(s, v) { return s + v; }, 0) / n;
  var num = 0, dx2 = 0, dy2 = 0;
  for (var i = 0; i < n; i++) {
    var dx = xs[i] - meanX;
    var dy = ys[i] - meanY;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  var denom = Math.sqrt(dx2 * dy2);
  if (denom === 0) return { r: 0, n: n, reason: "constant" };
  return { r: Number((num / denom).toFixed(4)), n: n, reason: "ok" };
}

function createCorrelationEngine(options) {
  var cfg = Object.assign({}, DEFAULTS, options || {});
  var eventBus = cfg.eventBus;
  if (!eventBus) throw new Error("eventBus is required");

  var findings = [];
  var counters = { analysesRun: 0, significantFound: 0, anomaliesFound: 0 };

  // [2026-10-21] Rolling per-bucket counters.
  //
  // The engine used to rebuild its buckets by scanning the event bus's raw
  // history. The bus keeps 10,000 events, and at this system's event rate
  // that is barely half an hour — so a 24-hour window was 23 phantom zero
  // buckets and every correlation was computed over almost nothing.
  // Expanding the raw buffer to cover 24 hours would need ~400k events
  // (tens of megabytes in memory and in the persisted state file).
  //
  // What the analysis actually needs is the per-bucket COUNT and P&L SUM,
  // not the events themselves. So the engine keeps those itself and folds
  // every event in the moment it is emitted. Buckets older than the engine
  // started observing are unknown rather than zero, and are left out of the
  // series instead of silently biasing the correlation.
  var buckets = {};         // type -> { bucketTs -> { count, pnlSum } }
  var observedFromTs = cfg.now();

  function bucketTsFor(tsMs) {
    return Math.floor(tsMs / cfg.bucketMs) * cfg.bucketMs;
  }

  function fold(e) {
    if (!e || !e.type || !e.tsMs) return;
    var b = bucketTsFor(e.tsMs);
    var byType = buckets[e.type];
    if (!byType) { byType = buckets[e.type] = {}; }
    var cell = byType[b];
    if (!cell) { cell = byType[b] = { count: 0, pnlSum: 0 }; }
    cell.count++;
    var pnl = e.data && typeof e.data.pnl === "number" ? e.data.pnl : 0;
    if (pnl) cell.pnlSum += pnl;
    var cutoff = b - cfg.retentionMs;
    for (var t in buckets) {
      var m = buckets[t];
      for (var k in m) { if (Number(k) < cutoff) delete m[k]; }
    }
  }

  if (eventBus && typeof eventBus.on === "function") {
    eventBus.on("*", function(e) { try { fold(e); } catch (_) {} });
  }

  /**
   * Per-bucket series for one event type over the analysis window.
   *
   * @param {string} type      event type
   * @param {number} windowMs  width of the window
   * @param {object} [opts]    { pnl: true } returns the P&L sum instead of the count
   */
  function buildBuckets(type, windowMs, opts) {
    var w = windowMs || cfg.windowMs;
    var now = cfg.now();
    var since = now - w;
    var startBucket = bucketTsFor(since);
    var endBucket = bucketTsFor(now);
    var observedBucket = bucketTsFor(observedFromTs);
    var byType = buckets[type];
    var out = [];
    for (var b = startBucket; b <= endBucket; b += cfg.bucketMs) {
      // A bucket before the engine started observing is unknown, not zero.
      if (b < observedBucket) continue;
      var cell = (byType && byType[b]) || null;
      if (opts && opts.pnl) out.push(cell ? cell.pnlSum : 0);
      else out.push(cell ? cell.count : 0);
    }
    return out;
  }

  function correlateIncidentsWithPnL(opts) {
    var windowMs = (opts && opts.windowMs) || cfg.windowMs;
    var incidentBuckets = buildBuckets("selfHealing.incident", windowMs);
    var pnlBuckets = buildBuckets("trading.fill", windowMs, { pnl: true });
    var n = Math.min(incidentBuckets.length, pnlBuckets.length);
    if (n < cfg.minSamples) {
      // [2026-10-21] An analysis ran; it simply had too few observed
      // buckets to say anything. Counting it keeps "analysesRun" honest.
      counters.analysesRun++;
      return { type: "incident_pnl", r: null, n: n, reason: "insufficient_buckets", lag: 0 };
    }
    var lagResults = [];
    for (var lag = -cfg.maxLagBuckets; lag <= cfg.maxLagBuckets; lag++) {
      var xs = [], ys = [];
      for (var i = 0; i < n; i++) {
        var j = i + lag;
        if (j >= 0 && j < n) { xs.push(incidentBuckets[i]); ys.push(pnlBuckets[j]); }
      }
      if (xs.length >= cfg.minSamples) {
        var p = pearson(xs, ys);
        lagResults.push({ lag: lag, r: p.r, n: p.n });
      }
    }
    var best = lagResults.reduce(function(a, b) {
      return Math.abs(b.r) > Math.abs(a.r) ? b : a;
    }, { lag: 0, r: 0, n: 0 });
    counters.analysesRun++;
    var significant = Math.abs(best.r) >= 0.3 && best.n >= cfg.minSamples;
    if (significant) counters.significantFound++;
    var result = {
      type: "incident_pnl", r: best.r, lag: best.lag,
      lagHours: Number((best.lag * cfg.bucketMs / 3600000).toFixed(2)),
      n: best.n, significant: significant,
      interpretation: best.r < -0.3 ? "negative: incidents predict losses" :
                      best.r > 0.3 ? "positive: UNUSUAL — incidents correlate with gains" :
                      "weak: no meaningful relationship",
      allLags: lagResults,
    };
    findings.push(Object.assign({}, result, { ts: new Date().toISOString() }));
    if (findings.length > cfg.maxHistory) findings.shift();
    return result;
  }

  function correlateAlertsWithPerformance(opts) {
    var windowMs = (opts && opts.windowMs) || cfg.windowMs;
    var alertBuckets = buildBuckets("selfAudit.alert", windowMs);
    var decisionBuckets = buildBuckets("decision.made", windowMs);
    var fillBuckets = buildBuckets("trading.fill", windowMs);
    var n = Math.min(alertBuckets.length, decisionBuckets.length, fillBuckets.length);
    if (n < cfg.minSamples) {
      counters.analysesRun++;
      return { type: "alert_performance", correlations: [], reason: "insufficient" };
    }
    var aD = pearson(alertBuckets.slice(0, n), decisionBuckets.slice(0, n));
    var aF = pearson(alertBuckets.slice(0, n), fillBuckets.slice(0, n));
    var dF = pearson(decisionBuckets.slice(0, n), fillBuckets.slice(0, n));
    counters.analysesRun++;
    var results = [
      { pair: "alerts_vs_decisions", r: aD.r, n: aD.n },
      { pair: "alerts_vs_fills", r: aF.r, n: aF.n },
      { pair: "decisions_vs_fills", r: dF.r, n: dF.n },
    ];
    for (var k = 0; k < results.length; k++) if (Math.abs(results[k].r) >= 0.3) counters.significantFound++;
    return { type: "alert_performance", correlations: results };
  }

  function correlationMatrix() {
    var streams = [
      { name: "alerts", type: "selfAudit.alert" },
      { name: "incidents", type: "selfHealing.incident" },
      { name: "decisions", type: "decision.made" },
      { name: "fills", type: "trading.fill" },
      { name: "mc_decisions", type: "metaCognition.decision" },
    ];
    var buckets = streams.map(function(s) {
      return buildBuckets(s.type, cfg.windowMs);
    });
    var n = buckets.reduce(function(m, b) { return Math.min(m, b.length); }, Infinity);
    if (n < cfg.minSamples) {
      return { matrix: [], streams: streams.map(function(s) { return s.name; }), n: n, reason: "insufficient" };
    }
    var matrix = [];
    for (var i = 0; i < streams.length; i++) {
      var row = [];
      for (var j = 0; j < streams.length; j++) {
        if (i === j) {
          row.push({ r: 1.0, n: n });
        } else {
          var p = pearson(buckets[i].slice(0, n), buckets[j].slice(0, n));
          row.push({ r: p.r, n: p.n });
        }
      }
      matrix.push(row);
    }
    counters.analysesRun++;
    return { streams: streams.map(function(s) { return s.name; }), matrix: matrix, n: n };
  }

  function detectAnomalies() {
    var anomalies = [];
    var ip = correlateIncidentsWithPnL({});
    if (ip.r !== null && ip.r > 0.4 && ip.significant) {
      anomalies.push({
        type: "unexpected_positive_correlation",
        pair: "incidents_pnl",
        r: ip.r,
        description: "Incidents correlate POSITIVELY with PnL — incident classifier may be mislabelling, or PnL attribution is broken.",
        severity: "warning",
      });
      counters.anomaliesFound++;
    }
    var matrix = correlationMatrix();
    if (matrix.matrix && matrix.matrix.length > 0) {
      var si = matrix.streams.indexOf("incidents");
      var sf = matrix.streams.indexOf("fills");
      if (si >= 0 && sf >= 0) {
        var r = matrix.matrix[si][sf].r;
        if (r < -0.5) {
          anomalies.push({
            type: "high_negative_correlation",
            pair: "incidents_fills",
            r: r,
            description: "High negative correlation between incidents and fills — system may be halting trading too aggressively.",
            severity: "info",
          });
        }
      }
    }
    return anomalies;
  }

  function getHistory(limit) { return findings.slice(-(limit || 20)); }

  // [2026-10-21] The rolling counters are the engine's real memory, so they
  // have to be persisted — otherwise a restart resets the 24-hour window to
  // zero and the analysis has to rebuild from scratch.
  function state() {
    return {
      buckets: buckets,
      observedFromTs: observedFromTs,
      counters: { ...counters },
    };
  }

  function restore(saved) {
    if (!saved) return;
    if (saved.buckets && typeof saved.buckets === "object") {
      buckets = saved.buckets;
    }
    if (saved.observedFromTs) observedFromTs = saved.observedFromTs;
    if (saved.counters) Object.assign(counters, saved.counters);
  }

  function stats() {
    return {
      totalFindings: findings.length,
      analysesRun: counters.analysesRun,
      significantFound: counters.significantFound,
      anomaliesFound: counters.anomaliesFound,
      // How far back the rolling counters reach — the real coverage of the
      // analysis window, as opposed to the window it asks for.
      observedFromTs: observedFromTs,
      observedHours: Math.round((cfg.now() - observedFromTs) / 3600000),
      trackedTypes: Object.keys(buckets),
      config: {
        windowMs: cfg.windowMs,
        bucketMs: cfg.bucketMs,
        maxLag: cfg.maxLagBuckets,
        minSamples: cfg.minSamples,
      },
    };
  }

  function clear() {
    findings.length = 0;
    buckets = {};
    observedFromTs = cfg.now();
    counters.analysesRun = 0;
    counters.significantFound = 0;
    counters.anomaliesFound = 0;
  }

  return {
    correlateIncidentsWithPnL: correlateIncidentsWithPnL,
    correlateAlertsWithPerformance: correlateAlertsWithPerformance,
    correlationMatrix: correlationMatrix,
    detectAnomalies: detectAnomalies,
    getHistory: getHistory,
    stats: stats,
    state: state,
    restore: restore,
    clear: clear,
    _pearson: pearson,
    _buildBuckets: buildBuckets,
  };
}

module.exports = { createCorrelationEngine, DEFAULTS, _pearson: pearson };
