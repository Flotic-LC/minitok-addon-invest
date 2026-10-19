"use strict";

/**
 * Layer 1: Runtime Anomaly Detector
 * Continuously monitors trading bot health and alerts on anomalies.
 * Prevents silent failures like the ones we just discovered manually.
 */

const RULES = [
  // === Infrastructure health (1-5) ===
  {
    name: "data_collection_stall",
    check: (m) => m.pricesCollectedLast10Min === 0 && m.uptime > 600,
    severity: "critical",
    message: "No price data collected in 10 minutes — pollMarkets() may be stalled",
    cooldown: 300000,
  },
  {
    name: "ai_throttle_excessive",
    check: (m) => m.aiCallIntervalAvg > 120000 && m.uptime > 300,
    severity: "warning",
    message: (m) => `AI call interval averaging ${(m.aiCallIntervalAvg / 1000).toFixed(0)}s — throttle may be too aggressive`,
    cooldown: 600000,
  },
  {
    name: "equity_metric_zero",
    check: (m) => m.equityKrw === 0 && m.uptime > 120,
    severity: "critical",
    message: "equity_krw=0 after 2min uptime — perfMonitor not receiving equity data",
    cooldown: 300000,
  },
  {
    name: "token_instability",
    check: (m) => m.authFailuresLastHour > 3,
    severity: "warning",
    message: (m) => `${m.authFailuresLastHour} auth failures in last hour — possible token revocation loop`,
    cooldown: 1800000,
  },
  {
    name: "ws_connection_flapping",
    check: (m) => m.wsReconnectsLastHour > 5,
    severity: "warning",
    message: (m) => `WS reconnected ${m.wsReconnectsLastHour} times in last hour — connection unstable`,
    cooldown: 1800000,
  },
  // === Trading quality (6-10) ===
  {
    name: "ai_fallback_frequent",
    check: (m) => m.fallbackDecisionsLastHour > 10 && m.uptime > 300,
    severity: "warning",
    message: (m) => `${m.fallbackDecisionsLastHour} AI fallback decisions in last hour — primary LLM may be degraded`,
    cooldown: 1800000,
  },
  {
    name: "slippage_excessive",
    check: (m) => m.slippageSampleCount >= 5 && m.avgSlippagePct > 1.0,
    severity: "warning",
    message: (m) => `Avg slippage ${m.avgSlippagePct.toFixed(2)}% over ${m.slippageSampleCount} fills (max ${m.maxSlippagePct.toFixed(2)}%) — execution quality degraded`,
    cooldown: 3600000,
  },
  {
    name: "ai_consecutive_failures",
    check: (m) => m.aiConsecutiveFailures >= 5,
    severity: "warning",
    message: (m) => `${m.aiConsecutiveFailures} consecutive AI failures — provider instability or prompt regression`,
    cooldown: 900000,
  },
  {
    name: "execution_errors_high",
    check: (m) => m.executionErrorsLastHour > 5 && m.uptime > 300,
    severity: "warning",
    message: (m) => `${m.executionErrorsLastHour} order execution errors in last hour — broker API or logic issue`,
    cooldown: 1800000,
  },
  {
    name: "hold_decision_dominant",
    check: (m) => m.totalDecisionsRecent >= 50 && m.holdDecisionRatio > 0.98 && m.uptime > 900,
    severity: "info",
    message: (m) => `HOLD ratio ${(m.holdDecisionRatio * 100).toFixed(1)}% over ${m.totalDecisionsRecent} decisions — AI may be overly conservative`,
    cooldown: 3600000,
  },
];

class SelfAudit {
  constructor(alertFn) {
    this.alertFn = alertFn || console.warn;
    this.metrics = {
      uptime: 0,
      pricesCollectedLast10Min: 0,
      aiCallIntervalAvg: 0,
      equityKrw: 0,
      equityUsd: 0,
      authFailuresLastHour: 0,
      wsReconnectsLastHour: 0,
      fallbackDecisionsLastHour: 0,
      avgSlippagePct: 0,
      maxSlippagePct: 0,
      slippageSampleCount: 0,
      aiConsecutiveFailures: 0,
      executionErrorsLastHour: 0,
      holdDecisionRatio: 0,
      totalDecisionsRecent: 0,
    };
    this._priceTimestamps = [];
    this._aiCallTimestamps = [];
    this._authFailureTimestamps = [];
    this._wsReconnectTimestamps = [];
    this._fallbackTimestamps = [];
    this._executionErrorTimestamps = [];
    this._slippageSamples = [];      // last 50 effective slippage %
    this._recentDecisions = [];      // last 200 action labels
    this._lastAlertAt = {};
    this._startTime = Date.now();
    this._checkInterval = null;
  }

  start(checkIntervalMs = 60000) {
    if (this._checkInterval) return;
    this._checkInterval = setInterval(() => this._runChecks(), checkIntervalMs);
    if (this._checkInterval.unref) this._checkInterval.unref();
    console.log("[self-audit] Started (check interval=" + checkIntervalMs + "ms, rules=" + RULES.length + ")");
  }

  stop() {
    if (this._checkInterval) {
      clearInterval(this._checkInterval);
      this._checkInterval = null;
    }
  }

  recordPrice() {
    const now = Date.now();
    this._priceTimestamps.push(now);
    this._pruneOld(this._priceTimestamps, 10 * 60 * 1000);
  }

  recordAiCall() {
    const now = Date.now();
    this._aiCallTimestamps.push(now);
    this._pruneOld(this._aiCallTimestamps, 60 * 60 * 1000);
  }

  recordAuthFailure() {
    const now = Date.now();
    this._authFailureTimestamps.push(now);
    this._pruneOld(this._authFailureTimestamps, 60 * 60 * 1000);
  }

  recordWsReconnect() {
    const now = Date.now();
    this._wsReconnectTimestamps.push(now);
    this._pruneOld(this._wsReconnectTimestamps, 60 * 60 * 1000);
  }

  updateEquity(equityKrw, fxRate) {
    this.metrics.equityKrw = equityKrw;
    var rate = Number(fxRate) || 1350;
    this.metrics.equityUsd = rate > 0 ? (equityKrw / rate) : 0;
  }

  // --- Trading quality recorders ---
  recordFallback() {
    this._fallbackTimestamps.push(Date.now());
    this._pruneOld(this._fallbackTimestamps, 60 * 60 * 1000);
  }
  recordExecutionError() {
    this._executionErrorTimestamps.push(Date.now());
    this._pruneOld(this._executionErrorTimestamps, 60 * 60 * 1000);
  }
  recordSlippage(effectivePct) {
    if (typeof effectivePct !== "number" || !isFinite(effectivePct)) return;
    this._slippageSamples.push(effectivePct);
    if (this._slippageSamples.length > 50) this._slippageSamples.splice(0, this._slippageSamples.length - 50);
  }
  recordDecision(action) {
    if (!action) return;
    this._recentDecisions.push(String(action).toUpperCase());
    if (this._recentDecisions.length > 200) this._recentDecisions.splice(0, this._recentDecisions.length - 200);
  }
  updateAiConsecutiveFailures(n) {
    this.metrics.aiConsecutiveFailures = Number(n) || 0;
  }

  _pruneOld(arr, maxAgeMs) {
    const cutoff = Date.now() - maxAgeMs;
    let i = 0;
    while (i < arr.length && arr[i] < cutoff) i++;
    if (i > 0) arr.splice(0, i);
  }

  _computeMetrics() {
    this.metrics.uptime = (Date.now() - this._startTime) / 1000;
    this.metrics.pricesCollectedLast10Min = this._priceTimestamps.length;

    if (this._aiCallTimestamps.length >= 2) {
      const intervals = [];
      for (let i = 1; i < this._aiCallTimestamps.length; i++) {
        intervals.push(this._aiCallTimestamps[i] - this._aiCallTimestamps[i - 1]);
      }
      this.metrics.aiCallIntervalAvg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    } else {
      this.metrics.aiCallIntervalAvg = 0;
    }

    this.metrics.authFailuresLastHour = this._authFailureTimestamps.length;
    this.metrics.wsReconnectsLastHour = this._wsReconnectTimestamps.length;
    this.metrics.fallbackDecisionsLastHour = this._fallbackTimestamps.length;
    this.metrics.executionErrorsLastHour = this._executionErrorTimestamps.length;

    if (this._slippageSamples.length > 0) {
      const sum = this._slippageSamples.reduce((a, b) => a + b, 0);
      this.metrics.avgSlippagePct = sum / this._slippageSamples.length;
      this.metrics.maxSlippagePct = Math.max(...this._slippageSamples);
      this.metrics.slippageSampleCount = this._slippageSamples.length;
    } else {
      this.metrics.avgSlippagePct = 0;
      this.metrics.maxSlippagePct = 0;
      this.metrics.slippageSampleCount = 0;
    }

    this.metrics.totalDecisionsRecent = this._recentDecisions.length;
    if (this._recentDecisions.length > 0) {
      const holds = this._recentDecisions.filter((a) => a === "HOLD").length;
      this.metrics.holdDecisionRatio = holds / this._recentDecisions.length;
    } else {
      this.metrics.holdDecisionRatio = 0;
    }
  }

  _runChecks() {
    this._computeMetrics();
    const now = Date.now();

    for (const rule of RULES) {
      try {
        if (rule.check(this.metrics)) {
          const lastAlert = this._lastAlertAt[rule.name] || 0;
          if (now - lastAlert < rule.cooldown) continue;

          this._lastAlertAt[rule.name] = now;
          const msg = typeof rule.message === "function" ? rule.message(this.metrics) : rule.message;
          const fullMsg = `[self-audit] ${rule.severity.toUpperCase()}: ${msg}`;

          console.warn(fullMsg);
          if (rule.severity === "critical") { this.alertFn(fullMsg, rule.severity); } else { console.log("[notify-muted] self-audit " + rule.severity + ": " + msg); }
        }
      } catch (e) {
        console.error("[self-audit] Rule check failed (" + rule.name + "): " + e.message);
      }
    }
  }

  getMetrics() {
    this._computeMetrics();
    return { ...this.metrics };
  }
}

function createSelfAudit(alertFn) {
  return new SelfAudit(alertFn);
}

module.exports = { createSelfAudit, RULES };
