"use strict";

const path = require("node:path");
const fs = require("node:fs");

// --- 0. Load .env file (no dotenv dependency) ---
(function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  try {
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eqIdx = line.indexOf("=");
      if (eqIdx < 1) continue;
      const key = line.slice(0, eqIdx).trim();
      let val = line.slice(eqIdx + 1).trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      // Do not override existing env vars (shell-exported values take precedence)
      if (!(key in process.env)) {
        process.env[key] = val;
      }
    }
  } catch (e) {
    console.warn("[runner] Warning: failed to load .env: " + e.message);
  }
})();

// --- 1. Toss environment variables ---
const {
  TOSS_CLIENT_ID,
  TOSS_CLIENT_SECRET,
  TOSS_ACCOUNT_SEQ,
} = process.env;

if (!TOSS_CLIENT_ID || !TOSS_CLIENT_SECRET || !TOSS_ACCOUNT_SEQ) {
  console.error("[runner] FATAL: TOSS_CLIENT_ID, TOSS_CLIENT_SECRET, TOSS_ACCOUNT_SEQ must be set");
  process.exit(1);
}

// --- 2. Lightweight LLM config from minitok.yml + env vars ---
function loadLocalConfig() {
  const ymlPath = path.join(__dirname, "minitok.yml");
  const cfg = { providers: {}, roles: {} };
  if (fs.existsSync(ymlPath)) {
    const lines = fs.readFileSync(ymlPath, "utf8").split("\n");
    let section = null, subSection = null;
    for (const raw of lines) {
      const line = raw.replace(/#.*$/, "").trimEnd();
      if (!line.trim()) continue;
      if (/^default_provider:/.test(line)) cfg.default_provider = line.split(":")[1].trim();
      else if (/^model:/.test(line) && !section) cfg.model = line.split(":")[1].trim();
      else if (/^providers:/.test(line)) { section = "providers"; subSection = null; }
      else if (/^roles:/.test(line)) { section = "roles"; subSection = null; }
      else if (section === "providers" && /^  [a-zA-Z]/.test(line)) { subSection = line.trim().replace(":", ""); cfg.providers[subSection] = {}; }
      else if (section === "providers" && subSection && /^    /.test(line)) {
        const m = line.trim().match(/^([^:]+):\s*(.*)$/);
        if (m) cfg.providers[subSection][m[1].trim()] = m[2].trim();
      }
      else if (section === "roles" && /^  [a-zA-Z]/.test(line)) { subSection = line.trim().replace(":", ""); cfg.roles[subSection] = {}; }
      else if (section === "roles" && subSection && /^    /.test(line)) {
        const m = line.trim().match(/^([^:]+):\s*(.*)$/);
        if (m) cfg.roles[subSection][m[1].trim()] = m[2].trim();
      }
    }
  }
  return cfg;
}

const minitokConfig = loadLocalConfig();
const providerName = minitokConfig.default_provider || Object.keys(minitokConfig.providers || {})[0] || "profundo";
const providerConfig = (minitokConfig.providers && minitokConfig.providers[providerName]) || {};
const aiModel = (minitokConfig.roles && minitokConfig.roles.work && minitokConfig.roles.work.model)
  || providerConfig.model || minitokConfig.model || "gpt-6-astra";

const apiKeyEnvVar = providerConfig.api_key_env || "PROFUNDO_API_KEY";
const apiKey = process.env[apiKeyEnvVar] || process.env.PROFUNDO_API_KEY || "";
const baseUrl = process.env.PROFUNDO_BASE_URL || providerConfig.base_url || "https://api.profundoai.com/v1";

if (!apiKey) {
  console.error("[runner] FATAL: No API key found. Set " + apiKeyEnvVar + " or PROFUNDO_API_KEY");
  process.exit(1);
}

// --- [P2-11] Config validation (fail fast on misconfiguration) ---
const { validateConfig } = require("./src/core/config-validator");
const configResult = validateConfig(process.env);
if (configResult.warnings.length > 0) {
  for (const w of configResult.warnings) console.warn("[config] " + w);
}
if (!configResult.ok) {
  console.error("[config] FATAL: invalid configuration:");
  for (const e of configResult.errors) console.error("  - " + e);
  process.exit(1);
}

// --- [DEEP-DEBUG] Structured file logger (daily rotation) ---
const { createFileLogger } = require("./src/core/file-logger");
const fileLogger = createFileLogger({ dir: path.join(__dirname, "logs") });
fileLogger.prune(); // clean up old log files on startup

// --- [P2-8] Audit logger (synchronous, append-only) ---
const { createAuditLogger } = require("./src/core/audit-logger");
const audit = createAuditLogger({
  dir: path.join(__dirname, ".audit"),
  enabled: process.env.AUDIT_LOG_ENABLED !== "false",
});
audit.config({ key: "startup", oldValue: null, newValue: "runner.js initializing", source: "runner" });

// --- [P0-3] Multi-provider LLM router ---
const { createProviderRouter } = require("./src/ai/provider-router");

// --- [Phase A / L4.5] Intelligence Pipeline + Trading Memory ---
const { createIntelligencePipeline } = require("./src/intelligence/pipeline");
const { createTradingMemory } = require("./src/memory/trading-memory");
const intelligence = createIntelligencePipeline({
  newsApiKey: process.env.INTEL_NEWS_API_KEY || "",
  fredApiKey: process.env.INTEL_FRED_API_KEY || "",
});
const tradingMemory = createTradingMemory({
  dir: path.join(__dirname, ".memory"),
});
console.log("[phase-a] Intelligence pipeline enabled=" + intelligence.stats().enabled + ", trading memory entries=" + tradingMemory.stats().totalEntries);

// --- [Phase I / L4.5] Meta-Cognition Engine ---
const { createMetaCognition } = require("./src/intelligence/meta-cognition");
const metaCognition = createMetaCognition({
  threshold: Number(process.env.META_COG_THRESHOLD || 0.55),
  recalibrateEvery: Number(process.env.META_COG_RECALIBRATE_EVERY || 100),
});
// Map to track BUY decision IDs for linking to SELL outcomes
const metaCogDecisionMap = new Map(); // symbol -> { decisionId, ts }
console.log("[phase-i] Meta-cognition engine enabled (threshold=" + metaCognition.stats().threshold + ", recalibrateEvery=" + metaCognition.stats().maxHistory + ")");

// --- [Constitution Loader] Load inviolable rules from constitution.yaml ---
const { loadConstitution, mapToKillswitchConfig, mapToApprovalGateConfig, mapToCouncilConfig, mapToHardLimits, mapToSelfModificationConfig } = require("./src/core/constitution-loader");
const constitution = loadConstitution();
const constitutionCouncilConfig = mapToCouncilConfig(constitution);
const constitutionKillswitchConfig = mapToKillswitchConfig(constitution);
const constitutionApprovalGateConfig = mapToApprovalGateConfig(constitution);
const constitutionHardLimits = mapToHardLimits(constitution);
const constitutionSelfModConfig = mapToSelfModificationConfig(constitution);
if (constitution._error) {
  console.warn("[constitution] Failed to load: " + constitution._error + " — using defaults");
} else {
  console.log("[constitution] Loaded from " + constitution._path + " (version=" + constitution.version + ", hardLimits=" + (constitutionHardLimits ? Object.keys(constitutionHardLimits).length : 0) + " keys)");
}

// --- [Phase B / L4.5] Multi-Agent Council + Scenario Simulator ---
const { createCouncil } = require("./src/council/council");
const { createSimulator } = require("./src/simulation/scenario");
const council = createCouncil({
  callLLM: null, // Arbiter disabled initially; enable after validation
  consensusThreshold: (constitutionCouncilConfig && constitutionCouncilConfig.consensusThreshold) || 0.6,
  defaultOnDisagreement: (constitutionCouncilConfig && constitutionCouncilConfig.defaultOnDisagreement) || "HOLD",
  weights: (constitutionCouncilConfig && constitutionCouncilConfig.weights) || { strategist: 1.0, risk_manager: 1.5, critic: 1.0 },
  maxPositionPct: (constitutionCouncilConfig && constitutionCouncilConfig.maxPositionPct) || (tradingGoals && tradingGoals.risk_parameters && tradingGoals.risk_parameters.max_single_position_pct) || 20,
  maxExposurePct: (constitutionCouncilConfig && constitutionCouncilConfig.maxExposurePct) || 85.0,
  maxDailyTrades: (constitutionCouncilConfig && constitutionCouncilConfig.maxDailyTrades) || 50,
  minCashReservePct: (constitutionCouncilConfig && constitutionCouncilConfig.minCashReservePct) || 15.0,
  vixCrisisThreshold: (constitutionKillswitchConfig && constitutionKillswitchConfig.vixCrisisThreshold) || 40,
  constitutionHardLimits: constitutionHardLimits || null,
});
const simulator = createSimulator({ seed: null });
// Large-position threshold for mandatory scenario simulation
const COUNCIL_SIM_THRESHOLD_PCT = Number(process.env.COUNCIL_SIM_THRESHOLD_PCT || 10);
console.log("[phase-b] Council enabled (threshold=" + council.stats().consensusThreshold + ", maxPos=" + council.stats().consensusThreshold + "), Simulator ready");

// --- [Phase C / L4.5] Shadow Mode + Killswitch + Approval Gate ---
const { createShadowMode } = require("./src/orchestrator/shadow-mode");
const { createKillswitch } = require("./src/orchestrator/killswitch");
const { createApprovalGate } = require("./src/orchestrator/approval-gate");
const shadowMode = createShadowMode({
  onChange: function(entry) {
    console.log("[shadow] APPLIED: " + entry.param + " = " + entry.proposedValue + " (was " + entry.currentValue + ")");
    audit.config({ key: "shadow_apply_" + entry.param, oldValue: entry.currentValue, newValue: entry.proposedValue, source: "shadow-mode" });
    liveParamsOverride = liveParamsOverride || {};
    liveParamsOverride[entry.param] = entry.proposedValue;
  },
  onRollback: function(entry) {
    console.log("[shadow] ROLLED BACK: " + entry.param + " — " + entry.rollbackReason);
    sendTelegramAlert("⚠️ *Shadow Rollback*\n" + entry.param + " rolled back: " + entry.rollbackReason, "warning");
  },
});
const killswitch = createKillswitch(Object.assign({}, constitutionKillswitchConfig || {}, {
  onHalt: function(reason) {
    console.error("[killswitch] HALTED: " + reason);
    sendTelegramAlert("🛑 *KILLSWITCH TRIGGERED*\n" + reason + "\nRecovery requires human approval after 24h cooldown.", "critical");
    journalEntry({ type: "KILLSWITCH_HALTED", reason: reason });
    metrics.counter("killswitch_halts");
    // [Phase N] Escalate killswitch halt to human operator with structured options
    try {
      if (escalationManager) {
        escalationManager.escalate({
          severity: "critical",
          summary: "Killswitch triggered — all trading halted",
          bullets: [
            "Reason: " + reason,
            "Recovery requires human approval + 24h cooldown",
            "Check /health and /self-healing endpoints for details",
          ],
          options: [
            { id: "acknowledge", label: "Acknowledged — investigating", recommended: true },
            { id: "shadow", label: "Switch to shadow mode on recovery" },
            { id: "abort", label: "Full abort — liquidate all positions" },
          ],
          timeoutMs: 3600000,
          fallbackOptionId: "acknowledge",
          cooldownKey: "killswitch_halt",
        });
      }
    } catch (e) { console.error("[killswitch] escalation error: " + e.message); }
  },
  onRecovery: function() {
    console.log("[killswitch] RECOVERED — trading resumed");
    sendTelegramAlert("✅ *Killswitch Recovery*\nTrading resumed after human approval.");
  },
}));
const approvalGate = createApprovalGate({
  config: constitutionApprovalGateConfig || undefined,
  notify: function(msg) {
    console.log("[approval] " + msg);
    sendTelegramAlert("🔐 " + msg);
  },
});
// Track known symbols for new-symbol detection
const knownSymbols = new Set();
console.log("[phase-c] Shadow mode, killswitch, and approval gate initialized");

// --- [Phase J / L4.5] Self-Healing Framework — incident classification + auto-mitigation ---
const { createSelfHealer } = require("./src/orchestrator/self-healing");
const selfHealer = createSelfHealer({
  onIncident: function(type, ctx) {
    console.warn("[self-heal] INCIDENT: " + type + (ctx ? " " + JSON.stringify(ctx).substring(0, 200) : ""));
    journalEntry({ type: "SELF_HEAL_INCIDENT", incidentType: type, ctx: ctx });
    metrics.counter("self_heal_incidents_" + type.toLowerCase());
    sendTelegramAlert("🔧 *Self-Healing Incident*\nType: " + type + "\n" + (ctx ? JSON.stringify(ctx).substring(0, 150) : ""), "warning");
  },
  onMitigation: function(type, action) {
    console.log("[self-heal] MITIGATION: " + type + " -> " + (action && action.action ? action.action : "unknown"));
    journalEntry({ type: "SELF_HEAL_MITIGATION", incidentType: type, action: action });
  },
  onEscalation: function(type, info) {
    console.error("[self-heal] ESCALATION: " + type + " (count=" + info.count + ") — requires human intervention");
    sendTelegramAlert("🚨 *Self-Healing Escalation*\nType: " + type + "\nCount: " + info.count + "\nRequires human intervention.", "critical");
    journalEntry({ type: "SELF_HEAL_ESCALATION", incidentType: type, count: info.count });
    metrics.counter("self_heal_escalations");
    // [Phase N] Structured escalation to human operator with options
    try {
      if (escalationManager) {
        var _escBullets = [
          "Incident type: " + type,
          "Occurrences: " + info.count + " (threshold: " + selfHealer.stats().escalationThreshold + ")",
        ];
        if (info.ctx) {
          _escBullets.push("Context: " + JSON.stringify(info.ctx).substring(0, 200));
        }
        _escBullets.push("Auto-mitigations exhausted — human decision required");
        escalationManager.escalate({
          severity: "critical",
          summary: "Self-healing escalation: " + type,
          bullets: _escBullets,
          options: [
            { id: "wait", label: "Wait 1h and re-evaluate", recommended: true },
            { id: "shadow", label: "Switch to shadow mode" },
            { id: "abort", label: "Full trading abort" },
          ],
          timeoutMs: 7200000,
          fallbackOptionId: "wait",
          cooldownKey: "self_heal_" + type,
        });
      }
    } catch (e) { console.error("[self-heal] escalation error: " + e.message); }
  },
});
console.log("[phase-j] Self-healing framework initialized (escalationThreshold=" + selfHealer.stats().escalationThreshold + ")");

// --- [SENTINEL] Telegram watchdog + auto-repair ---
const { createSentinel } = require("./src/agent/sentinel");
const sentinel = createSentinel({
  selfHealer: selfHealer,
  journalEntry: function(e) { try { journalEntry(e); } catch {} },
  getHealth: function() {
    return {
      ok: true,
      phase: (typeof targetEngine !== "undefined" && targetEngine && targetEngine.project) ? targetEngine.project().phase : -1,
      halted: (typeof targetEngine !== "undefined" && targetEngine && targetEngine.project) ? targetEngine.project().halted : false,
      authFailures: consecutiveAuthFailures,
      cacheAge: portfolioCacheAt ? (Date.now() - portfolioCacheAt) : -1,
    };
  },
  onRepair: function(r) {
    try {
      console.log("[sentinel] REPAIR: " + r.action + " (" + r.source + ")");
      if (r.action === "reset_token") {
        try { resetTokenCache(); } catch {}
      } else if (r.action === "reset_auth") {
        try { resetTokenCache(); } catch {}
        consecutiveAuthFailures = 0;
      } else if (r.action === "invalidate_portfolio") {
        try { invalidatePortfolioCache(); } catch {}
      } else if (r.action === "restart") {
        sendTelegramAlert("🛡️ *Sentinel*: restarting container via /restart", "warning");
        setTimeout(function() { process.exit(0); }, 2000);
      }
    } catch (e) { console.error("[sentinel] repair err: " + e.message); }
  },
});
// Tee stdout/stderr into sentinel log buffer
(function() {
  var _origLog = console.log, _origWarn = console.warn, _origErr = console.error;
  console.log = function() {
    try { sentinel.ingestLog(Array.prototype.slice.call(arguments).join(" ")); } catch {}
    return _origLog.apply(console, arguments);
  };
  console.warn = function() {
    try { sentinel.ingestLog("[WARN] " + Array.prototype.slice.call(arguments).join(" ")); } catch {}
    return _origWarn.apply(console, arguments);
  };
  console.error = function() {
    try { sentinel.ingestLog("[ERR] " + Array.prototype.slice.call(arguments).join(" ")); } catch {}
    return _origErr.apply(console, arguments);
  };
})();
sentinel.start();
console.log("[sentinel] Watchdog started (poll=15s, scan=30s)");

// --- [Phase K / L4.5] Confidence Calibration — LLM uncertainty quantification ---
const { createConfidenceCalibrator } = require("./src/ai/confidence");
const CONFIDENCE_ENABLED = process.env.CONFIDENCE_ENABLED !== "false";
const confidenceCalibrator = CONFIDENCE_ENABLED ? createConfidenceCalibrator({
  config: {
    sampleCount: Number(process.env.CONFIDENCE_SAMPLE_COUNT || 3),
    minThreshold: Number(process.env.CONFIDENCE_MIN_THRESHOLD || 0.40),
    skipThreshold: Number(process.env.CONFIDENCE_SKIP_THRESHOLD || 0.20),
    positionScaleFloor: Number(process.env.CONFIDENCE_POSITION_FLOOR || 0.25),
  },
  onLowConfidence: function(result) {
    console.warn("[confidence] LOW: conf=" + result.confidence + " rec=" + result.recommendation + " scale=" + result.positionScale);
    journalEntry({ type: "CONFIDENCE_LOW", confidence: result.confidence, recommendation: result.recommendation, modal: result.modal });
    metrics.counter("confidence_low");
    sendTelegramAlert("🎯 *Low Confidence Decision*\nConfidence: " + result.confidence + "\nRecommendation: " + result.recommendation + " (scale=" + result.positionScale + ")", "warning");
  },
}) : null;
console.log("[phase-k] Confidence calibration " + (CONFIDENCE_ENABLED ? "enabled (sampleCount=" + confidenceCalibrator.stats().sampleCount + ", minThreshold=" + confidenceCalibrator.stats().minThreshold + ")" : "disabled"));

// --- [Phase D / L4.5] Evolution Engine — genetic-algorithm parameter optimization ---
// Opt-in: set EVOLUTION_ENABLED=true to enable weekly self-evolution cycle.
const EVOLUTION_ENABLED = process.env.EVOLUTION_ENABLED === "true";
const EVOLUTION_INTERVAL_HOURS = Number(process.env.EVOLUTION_INTERVAL_HOURS || 168);
const EVOLUTION_CANDLES_PATH = process.env.EVOLUTION_CANDLES_PATH || null;
const EVOLUTION_GENERATIONS = Number(process.env.EVOLUTION_GENERATIONS || 10);
const EVOLUTION_POPULATION = Number(process.env.EVOLUTION_POPULATION || 20);
// [P10-EVO] Mutation rate/sigma configurable via env (Case C: widen mutation spread
// so best genome diverges from current params enough to clear proposal threshold).
// Raised rate 0.15→0.2 and sigma 0.10→0.25: prior values caused premature convergence
// near defaults, so every proposal was skipped as "below threshold" (changePct < 0.1%).
const EVOLUTION_MUTATION_RATE = Number(process.env.EVOLUTION_MUTATION_RATE || 0.2);
const EVOLUTION_MUTATION_SIGMA = Number(process.env.EVOLUTION_MUTATION_SIGMA || 0.25);
let evolutionEngine = null;
let evolutionTimer = null;

if (EVOLUTION_ENABLED) {
  try {
    const { createEvolutionEngine } = require("./src/orchestrator/evolution");
    const { runBacktest } = require("./backtest");
    evolutionEngine = createEvolutionEngine({
      runBacktest: runBacktest,
      shadowMode: shadowMode,
      candles: [],
      config: { populationSize: EVOLUTION_POPULATION, generations: EVOLUTION_GENERATIONS, mutationRate: EVOLUTION_MUTATION_RATE, mutationSigma: EVOLUTION_MUTATION_SIGMA },
      onProposal: function(p) {
        console.log("[evolution] PROPOSED: " + p.param + " " + p.current + " → " + p.proposedValue + " (" + p.changePct.toFixed(2) + "%)");
        audit.config({ key: "evolution_propose_" + p.param, oldValue: p.current, newValue: p.proposedValue, source: "evolution" });
        sendTelegramAlert("🧬 *Evolution Proposal*\n" + p.param + ": " + p.current + " → " + p.proposedValue);
      },
      onGeneration: function(gs) {
        if (gs.generation === 0 || (gs.generation + 1) % 5 === 0) {
          console.log("[evolution] gen=" + gs.generation + " bestFit=" + gs.bestFitness.toFixed(3));
        }
      },
    });
    // runEvolutionCycle defined below after all modules loaded
    console.log("[phase-d] Evolution engine initialized (gens=" + EVOLUTION_GENERATIONS + ", pop=" + EVOLUTION_POPULATION + ")");
  } catch (e) {
    console.error("[phase-d] Evolution engine FAILED to initialize: " + e.message);
  }
} else {
  console.log("[phase-d] Evolution engine disabled (set EVOLUTION_ENABLED=true to activate)");
}

// --- [P0-FIX] Global error handlers — prevent silent crashes, preserve state ---
process.on("unhandledRejection", function(reason, promise) {
  const msg = reason && reason.stack ? reason.stack : String(reason);
  console.error("[runner] UNHANDLED REJECTION: " + msg);
  try { audit.error({ source: "runner", code: "unhandled_rejection", message: msg.substring(0, 500) }); } catch {}
  // Best-effort state dump so we can recover
  try { if (typeof dumpRunnerState === "function") dumpRunnerState(); } catch {}
});
process.on("uncaughtException", function(err) {
  const msg = err && err.stack ? err.stack : String(err);
  console.error("[runner] UNCAUGHT EXCEPTION: " + msg);
  try { audit.error({ source: "runner", code: "uncaught_exception", message: msg.substring(0, 500) }); } catch {}
  try { if (typeof dumpRunnerState === "function") dumpRunnerState(); } catch {}
  // Give logs time to flush, then exit (sentinel/watchdog will restart)
  setTimeout(function() { process.exit(1); }, 1000);
});

// --- 3. Initialize add-on modules ---
  const { createAgentTools, createTargetEngine, createEquitySnapshotter } = require("./src/agent");
const { createTossWsClient } = require("./src/ws");
const { fetchAccessToken, resetTokenCache, getHoldings, getBuyingPower, getOrders, getOrder, getCandles, getPriceLimits, getStockWarnings, getExchangeRate, createExchangeOrder, createConditionalOrder, getOrderbook, getTrades, getMarketCalendar } = require("./src/tossinvest");
// [Phase 1] New modules: P&L calculator, durable event store, order manager, market calendar, metrics
const { computeRoundTripPnl, computeUnrealizedPnl, detectMarket } = require("./src/agent/pnl");
const scalper = require("./src/agent/scalper");
const { createStore } = require("./src/store");
const { createOrderManager } = require("./src/agent/orderManager");
const cal = require("./src/agent/marketCalendar");
const { createMetrics } = require("./src/agent/metrics");
const { generateSignal } = require("./src/strategy/signals");
const { fallbackDecision } = require("./src/strategy/fallback");
const planner = require("./src/strategy/planner");
const positionSizer = require("./src/agent/positionSizer");
const exposure = require("./src/agent/exposure");

// [P0-4 Integration] Dynamic risk — ATR/VIX-based hard-stop adjustment
const { computeDynamicRisk } = require("./src/strategy/dynamic-risk");

// [P1-6 Integration] Correlation-aware position sizing
const { checkCorrelation, adjustForCorrelation } = require("./src/agent/correlation");

// [P1-7 Integration] Event guard — checks FOMC/CPI/BOK/BOJ/NFP proximity
const { createEventGuard } = require("./src/strategy/event-calendar");
const eventGuard = createEventGuard();

// [P1-4 Integration] Knowledge store — self-improvement via past outcome feedback
const { createKnowledgeStore } = require("./src/strategy/knowledge-store");
const knowledgeStore = createKnowledgeStore({ path: path.join(__dirname, ".knowledge.json") });

// [P1-5 Integration] Performance monitor — Sharpe/Sortino/MaxDD + Prometheus
const { createPerformanceMonitor } = require("./src/agent/performance-monitor");
const perfMonitor = createPerformanceMonitor();



// [L1 Self-Audit] Runtime anomaly detector — catches silent failures automatically
const { createSelfAudit } = require("./src/agent/selfAudit");

// [P2-6 Integration] Connection state machine — monitors WS/API connection lifecycle
const { createConnectionManager, STATES: CONN_STATES } = require("./src/core/connection-manager");
const wsConnMgr = createConnectionManager({
  onStateChange: function(from, to) {
    console.log("[conn-mgr] WS state: " + from + " → " + to);
    audit.custom("conn_state", { from: from, to: to, source: "ws" });
  },
  onHalted: function(err) {
    console.error("[conn-mgr] WS HALTED: " + (err ? err.message : "unknown"));
    sendTelegramAlert("🔌 *WS Connection Halted*\nCircuit breaker tripped. Manual resume may be required.", "critical");
    audit.error({ source: "conn-mgr", code: "ws_halted", message: err ? err.message : "circuit breaker" });
  },
});

// [P2-7 Integration] Multi-account manager — rotates orders across accounts
const { createMultiAccountManager, STRATEGIES: MA_STRATEGIES } = require("./src/agent/multi-account");
const maAccounts = [];
if (process.env.MA_ACCOUNTS) {
  // Format: "seq1:weight1,seq2:weight2" e.g. "1:0.6,2:0.4"
  try {
    for (const entry of process.env.MA_ACCOUNTS.split(",")) {
      const parts = entry.trim().split(":");
      if (parts.length >= 1) {
        maAccounts.push({ id: parts[0].trim(), clientSeq: parts[0].trim(), weight: Number(parts[1]) || 1, dailyMaxKrw: Number(process.env.DAILY_MAX_VALUE_KRW) || 5000000 });
      }
    }
  } catch (e) { console.error("[multi-account] Failed to parse MA_ACCOUNTS: " + e.message); }
}
// Fallback: single account from TOSS_ACCOUNT_SEQ
if (maAccounts.length === 0 && TOSS_ACCOUNT_SEQ) {
  maAccounts.push({ id: TOSS_ACCOUNT_SEQ, clientSeq: TOSS_ACCOUNT_SEQ, weight: 1, dailyMaxKrw: Number(process.env.DAILY_MAX_VALUE_KRW) || 5000000 });
}
const multiAccountMgr = maAccounts.length > 0
  ? createMultiAccountManager({ accounts: maAccounts, strategy: process.env.MA_STRATEGY || MA_STRATEGIES.ROUND_ROBIN })
  : null;
if (multiAccountMgr) {
  console.log("[multi-account] Initialized with " + maAccounts.length + " account(s), strategy=" + (process.env.MA_STRATEGY || "round_robin"));
  audit.config({ key: "multi_account", oldValue: null, newValue: maAccounts.map(function(a) { return a.id; }).join(","), source: "runner" });
}

// [P2-8 Integration] Strategy plugin registry — extensible signal generation
const { createStrategyRegistry } = require("./src/strategy/registry");
const strategyRegistry = createStrategyRegistry();
// Register the default signals.js as the base strategy plugin
strategyRegistry.register({ name: "base_signals", generateSignal: generateSignal, metadata: { description: "Default momentum/mean-reversion hybrid", version: "1.0" } });
console.log("[strategy-registry] Registered base_signals plugin");

// [Phase E / L4.5] Multi-Strategy Orchestrator — performance-weighted capital allocation
const { createStrategyOrchestrator } = require("./src/strategy/orchestrator");
const strategyOrchestrator = createStrategyOrchestrator({
  registry: strategyRegistry,
  shadowMode: shadowMode,
  config: {
    minAllocationPct: Number(process.env.ORCH_MIN_ALLOC_PCT || 10),
    maxAllocationPct: Number(process.env.ORCH_MAX_ALLOC_PCT || 70),
    explorationReservePct: Number(process.env.ORCH_EXPLORATION_PCT || 10),
    rebalanceChangeThresholdPct: Number(process.env.ORCH_REBALANCE_THRESHOLD_PCT || 5),
    minTradesForEval: Number(process.env.ORCH_MIN_TRADES || 10),
  },
  onRebalance: function(result) {
    if (result.changes && result.changes.length > 0) {
      console.log("[orchestrator] Rebalanced: " + result.changes.map(function(c) {
        return c.name + " " + (c.oldWeight * 100).toFixed(1) + "% → " + (c.newWeight * 100).toFixed(1) + "%";
      }).join(", "));
      sendTelegramAlert("⚖️ *Strategy Rebalance*\n" + result.changes.map(function(c) {
        return c.name + ": " + (c.oldWeight * 100).toFixed(1) + "% → " + (c.newWeight * 100).toFixed(1) + "% (" + c.changePct + "%)";
      }).join("\n"));
    }
  },
});
strategyOrchestrator.registerStrategy("base_signals");
console.log("[phase-e] Strategy orchestrator initialized (strategies=1, allocation=" + JSON.stringify(strategyOrchestrator.getAllocation()) + ")");

// [Phase F] VaR / CVaR Risk Engine — parametric + historical + Monte Carlo
const { createVaREngine } = require("./src/risk/var-engine");
const { createPortfolioRisk } = require("./src/risk/portfolio-risk");
const varEngine = createVaREngine({
  confidence: Number(process.env.RISK_CONFIDENCE || 0.95),
  holdingDays: Number(process.env.RISK_HOLDING_DAYS || 1),
  mcPaths: Number(process.env.RISK_MC_PATHS || 10000),
  mcDays: Number(process.env.RISK_MC_DAYS || 10),
  mcSeed: process.env.RISK_MC_SEED ? Number(process.env.RISK_MC_SEED) : null,
});
const portfolioRisk = createPortfolioRisk({
  confidence: Number(process.env.RISK_CONFIDENCE || 0.95),
  holdingDays: Number(process.env.RISK_HOLDING_DAYS || 1),
  riskBudgetPct: Number(process.env.RISK_BUDGET_PCT || 2.0),
});
console.log("[phase-f] Risk engine initialized (confidence=" + varEngine.config.confidence + ", holdingDays=" + varEngine.config.holdingDays + ", budget=" + portfolioRisk.config.riskBudgetPct + "%)");

// [Phase 2.3] Daily plan state — rebuilt each morning (KST), reviewed at close
let dailyPlan = null;
let dailyPlanDate = null;
// --- Dynamic Universe Reference ---
// Initialized in start(), but declared at module level so cleanup/hold-tracking
// functions can access it without being passed as arguments everywhere.
let universe = null;

// [Phase 3.1] Latest candle context per symbol for ATR sizing
const lastCandleCtx = new Map();

const eventStore = createStore({});
const metrics = createMetrics({
  dumpPath: path.join(__dirname, ".metrics.json"),
  dumpIntervalMs: Number(process.env.METRICS_DUMP_INTERVAL_MS || 60000),
});
metrics.start();

// --- Telegram Alert Helper (for Hard Stop notifications) ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
async function _sendTelegramRaw(message) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: `[Bot] ${message}`, parse_mode: "Markdown" })
    });
  } catch (e) { console.error("[telegram] Send failed: " + e.message); }
}
// [Phase 4.2] Severity-routed notifications with rate limiting
const { createNotifier } = require("./src/agent/notifier");
const _notifier = createNotifier(_sendTelegramRaw);
// Legacy signature: plain string = info (backward compat). Object: { msg, severity }
async function sendTelegramAlert(message, severity) {
  // [notify-minimal] only critical alerts reach Telegram; warn/info muted (log only)
  // Scheduled info summaries (daily report) are whitelisted so they still arrive.
  const _plain = typeof message === "string" ? message : (message && message.msg);
  const _sev = (typeof message === "string") ? (severity || "info") : ((message && message.severity) || "info");
  const _allowedInfo = ["*Daily Report*"];
  const _infoAllowed = _allowedInfo.some(function(p) { return _plain && String(_plain).includes(p); });
  if (_sev !== "critical" && !_infoAllowed) {
    try { console.log("[notify-muted] sev=" + _sev + " " + String(_plain || "").split("\n")[0].slice(0, 100)); } catch {}
    return { sent: false, muted: true, severity: _sev };
  }
  try {
    if (typeof message === "string") {
      const sev = severity || "info";
      const fn = _notifier[sev] || _notifier.warn || _notifier.info;
      if (typeof fn !== "function") return _sendTelegramRaw(message, sev);
      return fn.call(_notifier, message);
    }
    const sev = (message && message.severity) || "info";
    const msg = (message && message.msg) || String(message);
    const fn = _notifier[sev] || _notifier.warn || _notifier.info;
    if (typeof fn !== "function") return _sendTelegramRaw(msg, sev);
    return fn.call(_notifier, msg);
  } catch (e) {
    // Last-resort: never let a notifier bug crash the runner
    try { await _sendTelegramRaw(typeof message === "string" ? message : (message && message.msg) || "alert", "info"); } catch {}
  }
}

// [L1 Self-Audit] Instantiate anomaly detector with Telegram alerting
const selfAudit = createSelfAudit(sendTelegramAlert);

// --- [Phase R / L4.5] Reflection Engine — signal collection + post-mortem analysis ---
const { createEventBus } = require("./src/intelligence/event-bus");
const { createSignalCollector } = require("./src/intelligence/signal-collector");
const { createReflectionEngine } = require("./src/intelligence/reflection");
const { createCorrelationEngine } = require("./src/intelligence/correlation");
const { createHypothesisEngine } = require("./src/intelligence/hypothesis");
const { createAttributionEngine } = require("./src/intelligence/attribution");
const { createExperimentEngine } = require("./src/intelligence/experiment");
const { createAutoLoop } = require("./src/intelligence/auto-loop");

// Phase R-7: Experiment Coordinator
const { createExperimentCoordinator } = require("./src/intelligence/experiment-coordinator");
const { createOutcomeFeedback } = require("./src/intelligence/outcome-feedback");
// [Phase R-5] Execution-layer modules — close the self-improvement loop
const { createParamTuner } = require("./src/intelligence/param-tuner");
const { createTrafficSplitter } = require("./src/intelligence/traffic-splitter");
const { createActionRegistry } = require("./src/intelligence/action-registry");
const eventBus = createEventBus();
const signalCollector = createSignalCollector({ eventBus });
const reflectionEngine = createReflectionEngine({ eventBus });
const correlationEngine = createCorrelationEngine({ eventBus });
const hypothesisEngine = createHypothesisEngine({ eventBus, reflectionEngine, correlationEngine });
const attributionEngine = createAttributionEngine();
const experimentEngine = createExperimentEngine();
// [Phase R-5 FIX] Wire real selfHealer (was null in R-3) so param-tuner can mutate cooldowns/escalation
const autoLoop = createAutoLoop({ selfHealer: selfHealer, experimentEngine, hypothesisEngine, attributionEngine });
const outcomeFeedback = createOutcomeFeedback({ experimentEngine, hypothesisEngine });
// [Phase R-5] Execution wiring: paramTuner ↔ selfHealer/strategyOrchestrator, trafficSplitter ↔ experimentEngine
const paramTuner = createParamTuner({ selfHealer: selfHealer, strategyOrchestrator: strategyOrchestrator });
const trafficSplitter = createTrafficSplitter({ experimentEngine: experimentEngine });
const actionRegistry = createActionRegistry({
  paramTuner: paramTuner, trafficSplitter: trafficSplitter,
  autoLoop: autoLoop, hypothesisEngine: hypothesisEngine, experimentEngine: experimentEngine,
});
var _arInstall = actionRegistry.install();
signalCollector.attachSelfAudit(selfAudit);
console.log("[phase-r] Reflection engine initialized (event-bus + signal-collector + reflection + correlation + hypothesis + attribution + experiment + auto-loop + outcome-feedback)");
console.log("[phase-r5] Execution layer wired: paramTuner + trafficSplitter + actionRegistry (installed=" + (_arInstall.installed || 0) + " handlers)");

// --- [Phase S / L4.5] Market Intelligence — RSS/JSON news & sentiment collection ---
var marketIntel = null;
try {
  const { createMarketIntelCollector } = require("./src/intelligence/market-intel");
  marketIntel = createMarketIntelCollector({ eventBus: eventBus });
  marketIntel.start();
  console.log("[phase-s] Market intel collector started (interval=" + marketIntel.stats().tickIntervalMs + "ms, sources=" + marketIntel.sources().length + ")");
} catch (_miErr) {
  console.error("[phase-s] Market intel collector FAILED: " + _miErr.message);
}


// Phase R-7: Experiment Coordinator wiring
var experimentCoordinator = null;
try {
  experimentCoordinator = createExperimentCoordinator({
    experimentEngine: experimentEngine,
    attributionEngine: attributionEngine,
    marketIntel: marketIntel,
  });
  if (experimentCoordinator && typeof experimentCoordinator.start === "function") {
    experimentCoordinator.start();
    console.log("[phase-r7] Experiment coordinator started");
  }
} catch (_r7Err) {
  console.error("[phase-r7] Coordinator init failed: " + _r7Err.message);
}
// --- [Phase R-6] Continuous improvement integration layer ---
const { createShadowGate } = require("./src/intelligence/shadow-gate");
const { createPersistence } = require("./src/intelligence/persistence");
const { createRegimeAdvisor } = require("./src/intelligence/regime-advisor");
const { createEvolutionBridge } = require("./src/intelligence/evolution-bridge");
const { createKnowledgeRanker } = require("./src/intelligence/knowledge-ranker");
// R-6 degradation detector — aliased to avoid collision with existing perfMonitor (L388)
const { createPerformanceMonitor: createDegradationDetector } = require("./src/intelligence/performance-monitor");
const { createBlindSpotBridge } = require("./src/intelligence/blindspot-bridge");

// Shadow gate: intercepts paramTuner.apply to enforce shadow-mode constraints
const shadowGate = createShadowGate({ paramTuner: paramTuner, shadowMode: shadowMode });
var _sgInstall = shadowGate.install();

// Knowledge ranker: patches hypothesisEngine.rankProposals with win-rate adjustments
const knowledgeRanker = createKnowledgeRanker({
  knowledgeStore: knowledgeStore, hypothesisEngine: hypothesisEngine, outcomeFeedback: outcomeFeedback,
});
var _krInstall = knowledgeRanker.install();

// Persistence: atomic save/restore of R-2~R-5 state
const PERSISTENCE_PATH = path.join(__dirname, ".intelligence-state.json");
const persistence = createPersistence({
  path: PERSISTENCE_PATH,
  hypothesisEngine: hypothesisEngine, experimentEngine: experimentEngine,
  paramTuner: paramTuner, actionRegistry: actionRegistry,
  autoLoop: autoLoop, outcomeFeedback: outcomeFeedback,
  // Deferred: performanceMonitor and blindSpotBridge are defined below,
  // but persistence.save() reads them at call time (not at creation time),
  // so we pass them via a getter-like approach after instantiation.
});
// Patch persistence config to include R-6 monitor/bridge (they are defined after persistence)
// This is safe because persistence.save() reads cfg.performanceMonitor at call time.
var _persistenceR6Patch = function() {
  if (persistence && persistence._cfg) {
    persistence._cfg.degradationDetector = degradationDetector;
    persistence._cfg.blindSpotBridge = blindSpotBridge;
  }
};
// Restore state from disk (best-effort, never blocks startup)
try {
  var _persistRestore = persistence.restore();
  console.log("[phase-r6] persistence restored: " + JSON.stringify(_persistRestore));
} catch (_pre) { console.error("[phase-r6] persistence restore failed: " + _pre.message); }

// Regime advisor and evolution bridge require regimeHMM/evolutionEngine which
// are defined later in the file. Defer their instantiation to a lazy init function
// called after those modules are loaded.
var regimeAdvisor = null;
var evolutionBridge = null;
function _r6DeferredInit() {
  try {
    if (typeof regimeHMM !== "undefined" && regimeHMM && !regimeAdvisor) {
      regimeAdvisor = createRegimeAdvisor({ regimeHMM: regimeHMM, hypothesisEngine: hypothesisEngine });
      console.log("[phase-r6] regime-advisor initialized");
    }
    if (typeof evolutionEngine !== "undefined" && evolutionEngine && !evolutionBridge) {
      evolutionBridge = createEvolutionBridge({
        evolution: evolutionEngine, hypothesisEngine: hypothesisEngine, shadowMode: shadowMode,
      });
      console.log("[phase-r6] evolution-bridge initialized");
    }
  } catch (_r6e) { console.error("[phase-r6] deferred init failed: " + _r6e.message); }
}

// R-6 degradation detector: tracks rolling win rate / Sharpe / PF, auto-generates
// degradation hypotheses when sustained underperformance is detected.
// Distinct from existing perfMonitor (L388) which handles Prometheus metrics.
const degradationDetector = createDegradationDetector({
  hypothesisEngine: hypothesisEngine, selfHealer: selfHealer,
  notify: function(msg) { try { sendTelegramAlert(msg, "info"); } catch {} },
});

// Blind-spot bridge: converts reflectionEngine blind spots into hypotheses
const blindSpotBridge = createBlindSpotBridge({
  reflectionEngine: reflectionEngine, hypothesisEngine: hypothesisEngine,
  notify: function(msg) { console.log(msg); },
});

// Patch persistence config to include R-6 modules now that they are defined
if (typeof _persistenceR6Patch === "function") _persistenceR6Patch();

console.log("[phase-r6] Integration layer wired: shadowGate(installed=" + (_sgInstall && _sgInstall.ok) + ") + knowledgeRanker(installed=" + (_krInstall && _krInstall.ok) + ") + persistence(path=" + PERSISTENCE_PATH + ") + degradationDetector + blindSpotBridge");

// --- Load trading goals template ---
function loadGoals() {
  const goalsPath = path.join(__dirname, "goals.json");
  try {
    if (fs.existsSync(goalsPath)) {
      return JSON.parse(fs.readFileSync(goalsPath, "utf8"));
    }
  } catch (e) { console.error("[goals] Failed to load: " + e.message); }
  return null;
}
const tradingGoals = loadGoals();

// --- Live trading override: DRY_RUN=false skips Phase 0 calibration ---
const forceLive = process.env.DRY_RUN === "false" || process.env.DRY_RUN === "0";
// [P2-11 FIX] Persist target engine state to durable volume (/app/state) so that
// phase progression, returnCycles, and haltState survive container recreation.
// Previously stored under __dirname which lives in the ephemeral container layer
// and was lost on redeploy, causing the bot to reset to Phase 0 on every restart.
const targetStatePath = path.join(
  process.env.STATE_DIR || path.join(__dirname, "state"),
  ".target-state.json"
);
// [FIX #1] State preservation: do NOT delete state file on restart.
// returnCycles and phase progression must survive across restarts so that
// Phase escalation (P1→P2 after 50 returnCycles) is achievable.
const targetEngine = createTargetEngine({ statePath: targetStatePath });

// [DEEP-DEBUG FIX] Remove legacy LIVE_OVERRIDE pollution from state.
// Previous versions injected 31 fake INIT operations to force phase skip,
// which permanently polluted operationCycles and skewed hit-rate stats.
// Clean these on startup so only genuine operations remain.
(function purgeLegacyOverrides() {
  const removed = targetEngine.purgeOperationCycles(c => c.code !== "LIVE_OVERRIDE");
  if (removed > 0) {
    console.log("[runner] Purged " + removed + " legacy LIVE_OVERRIDE entries from operationCycles");
  }
})();

if (forceLive && targetEngine.project().phase === 0) {
  // [DEEP-DEBUG FIX] Use direct phase advancement instead of fake operations.
  // This avoids polluting operationCycles with phantom records.
  targetEngine.advancePhaseDirect(1, "DRY_RUN=false startup override");
  console.log("[runner] LIVE MODE: DRY_RUN=false advanced to Phase " + targetEngine.project().phase + " (no fake operations injected)");
}

const snapshotter = createEquitySnapshotter({
  credentials: { clientId: TOSS_CLIENT_ID, clientSecret: TOSS_CLIENT_SECRET },
  accountSeq: TOSS_ACCOUNT_SEQ,
  currency: "KRW",
});

const tools = createAgentTools({
  credentials: { clientId: TOSS_CLIENT_ID, clientSecret: TOSS_CLIENT_SECRET },
  safetyLimits: {
    maxOrderValueKrw: Number(process.env.MAX_ORDER_VALUE_KRW || 300000),
    allowedSymbols: process.env.ALLOWED_SYMBOLS ? process.env.ALLOWED_SYMBOLS.split(",") : null,
    maxOpenOrders: Number(process.env.MAX_OPEN_ORDERS || 10),
    maxPositionsPerSymbol: Number(process.env.MAX_POSITIONS_PER_SYMBOL || 1),
    dailyMaxValueKrw: Number(process.env.DAILY_MAX_VALUE_KRW || 5000000),
    cooldownMs: Number(process.env.ORDER_COOLDOWN_MS || 5000),
    enforcePreChecks: true,
  },
  dryRunDefault: targetEngine.project().dryRun,
  targetEngine,
  fetchEquity: snapshotter.fetchEquity,
});

// --- 4. Global market awareness & dynamic throttle ---
// [FIX] Reset token cache on startup to prevent stale/revoked tokens
// from previous sessions causing immediate WS 401 failures.
try { resetTokenCache(); } catch (e) { /* best-effort */ }

// --- [FIX #7] Shared auth backoff state (prevents infinite retry on invalid-token) ---
// Used by both fetchPortfolioContext and pollMarkets.
let consecutiveAuthFailures = 0;
const MAX_CONSECUTIVE_AUTH_FAILURES = 10;
const BASE_BACKOFF_MS = 5000;
const MAX_BACKOFF_MS = 300000; // 5 minutes

function isAuthError(msg) {
  const lower = (msg || "").toLowerCase();
  return lower.indexOf("invalid-token") !== -1 ||
         lower.indexOf("invalid_token") !== -1 ||
         lower.indexOf("token-revoked") !== -1 ||
         lower.indexOf("token_revoked") !== -1 ||
         lower.indexOf("toss_auth_error") !== -1 ||
         lower.indexOf("unauthorized") !== -1;
}

// [Phase 1.3] DST-aware sessions via src/agent/marketCalendar; holidays
// cross-checked against Toss market-calendar API (cached 6h).
const holidayCache = cal.createHolidayCache({
  fetchCalendar: async (market) => {
    const token = await fetchAccessToken(TOSS_CLIENT_ID, TOSS_CLIENT_SECRET);
    return getMarketCalendar(token, market);
  },
});

function getActiveMarkets() {
  return cal.getActiveMarkets(new Date());
}

function getDynamicThrottleMs() {
  if (process.env.AI_THROTTLE_MS) return Number(process.env.AI_THROTTLE_MS);
  // Always use 30s throttle regardless of market hours — quality analysis > token savings.
  // Trade execution is still guarded by market-hours check in _executeDecisionInner().
  return 30000;
}

let lastAiCallAt = 0;

// --- [CASH-RESCUE] Cached FX rates for equity KRW conversion ---
const cachedFxRates = { FX_USD_KRW: 1350, FX_JPY_KRW: 9 };
async function refreshCachedFxRates() {
  try {
    var _fxToken = await fetchAccessToken(TOSS_CLIENT_ID, TOSS_CLIENT_SECRET);
    var pairs = [["USD","KRW"],["JPY","KRW"]];
    for (var pair of pairs) {
      try {
        var r = await getExchangeRate(_fxToken, pair[0], pair[1]);
        // Toss wraps FX response in {result:{rate:"..."}} — try result.rate first, fall back to body.rate
        var rawRate = r && r.body && (r.body.result && r.body.result.rate ? r.body.result.rate : r.body.rate);
        if (rawRate) {
          var rate = Number(rawRate);
          // Toss returns JPY rate per 100 units typically — detect and normalize
          if (pair[0] === "JPY" && rate < 50) rate = rate * 100;
          cachedFxRates["FX_" + pair[0] + "_" + pair[1]] = rate;
        }
      } catch (_fxp) { /* best-effort, keep stale */ }
    }
    console.log("[fx] Cached rates: USD=" + cachedFxRates.FX_USD_KRW + ", JPY=" + cachedFxRates.FX_JPY_KRW);
  } catch (_fxe) { console.warn("[fx] refresh failed: " + _fxe.message); }
}
// Initial refresh + periodic (every 30min)
try { setTimeout(function(){ refreshCachedFxRates(); }, 15000); } catch {}
try { setInterval(function(){ refreshCachedFxRates(); }, 1800000); } catch {}


// --- [FIX] Per-symbol WS throttle to prevent WS ticks from starving REST-poll askAI ---
const wsThrottleMap = new Map(); // symbol -> lastCallAt (per-symbol WS throttle)
const WS_THROTTLE_MS = Number(process.env.WS_THROTTLE_MS || 60000); // 60s per-symbol throttle for WS

// --- [P3-3] AI Decision TTL Cache ---
// Caches AI decisions per symbol for a short TTL to avoid redundant LLM calls
// when multiple ticks arrive for the same symbol within the throttle window.
const AI_CACHE_TTL_MS = Number(process.env.AI_CACHE_TTL_MS || 25000); // 25s default (slightly under 30s active throttle)
const aiDecisionCache = new Map(); // symbol -> { decision, cachedAt }

function getCachedDecision(symbol) {
  if (!symbol) return null;
  var key = String(symbol).toUpperCase();
  var entry = aiDecisionCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > AI_CACHE_TTL_MS) {
    aiDecisionCache.delete(key);
    return null;
  }
  return entry.decision;
}

function setCachedDecision(symbol, decision) {
  if (!symbol || !decision) return;
  // Don't cache HOLD decisions aggressively — only actionable ones
  if (decision.action === "HOLD") return;
  aiDecisionCache.set(String(symbol).toUpperCase(), { decision: decision, cachedAt: Date.now() });
  // Evict stale entries to prevent unbounded growth
  while (aiDecisionCache.size > 50) {
    var oldest = aiDecisionCache.keys().next().value;
    aiDecisionCache.delete(oldest);
  }
}

// --- [P4-2] Consecutive HOLD Detection & Proactive Exploration ---
// Tracks how many times the AI returns HOLD for the same symbol consecutively.
// When threshold is exceeded, temporarily removes the symbol from the universe
// to force exploration of more actionable instruments.
const HOLD_EVICTION_THRESHOLD = Number(process.env.HOLD_EVICTION_THRESHOLD || 10);
const HOLD_EVICTION_COOLDOWN_MS = Number(process.env.HOLD_EVICTION_COOLDOWN_MS || 600000); // 10 min
const consecutiveHolds = new Map(); // symbol -> count
const holdEvictedAt = new Map(); // symbol -> timestamp when evicted
const holdOffHoursLoggedAt = new Map(); // [P8-OFF-HOURS] symbol -> last off-hours log timestamp
let aiCacheHits = 0; // [P4-3] metric for daily report
let slippageOffsetApplied = 0; // [P4-3] metric for daily report

function trackHoldDecision(symbol, decision) {
  if (!symbol || !decision) return;
  var sym = String(symbol).toUpperCase();
  // [self-audit] Record every AI decision (incl. HOLD) for hold-dominant rule
  try { selfAudit.recordDecision(decision.action); } catch {}

  // [P8-OFF-HOURS] Skip eviction during market off-hours to prevent universe loss.
  // When a market is closed, AI naturally returns HOLD; evicting these symbols would
  // remove them from the watchlist before market reopens, missing post-open opportunities.
  try {
    var market = (typeof detectMarket === "function" ? detectMarket(sym) : "US") || "US";
    var isOpen = (typeof cal !== "undefined" && typeof cal.isMarketOpen === "function") ? cal.isMarketOpen(market) : true;
    if (!isOpen) {
      // Reset counter during off-hours so HOLD streaks don't accumulate unfairly
      consecutiveHolds.delete(sym);
      // Don't log every tick to avoid spam — only log on first off-hours HOLD
      if (decision.action === "HOLD") {
        var lastOffHoursLog = holdOffHoursLoggedAt.get(sym);
        if (!lastOffHoursLog || (Date.now() - lastOffHoursLog) > 600000) { // log once per 10 min
          console.log("[hold-eviction] SKIP " + sym + " (market " + market + " off-hours)");
          holdOffHoursLoggedAt.set(sym, Date.now());
        }
      }
      return;
    }
  } catch (_offHoursErr) {
    // If market check fails, proceed with normal eviction logic
  }

  // Check if symbol was previously evicted and cooldown has passed
  var evictedTs = holdEvictedAt.get(sym);
  if (evictedTs && (Date.now() - evictedTs) >= HOLD_EVICTION_COOLDOWN_MS) {
    holdEvictedAt.delete(sym);
    consecutiveHolds.delete(sym);
    // Re-add to universe if it was removed
    try { if (typeof universe !== "undefined" && universe.add) universe.add(symbol); } catch {}
  }
  if (evictedTs) return; // Still in cooldown

  if (decision.action === "HOLD") {
    var count = (consecutiveHolds.get(sym) || 0) + 1;
    consecutiveHolds.set(sym, count);
    if (count >= HOLD_EVICTION_THRESHOLD) {
      console.log("[hold-eviction] " + sym + " returned HOLD " + count + " consecutive times. Temporarily removing from universe for " + (HOLD_EVICTION_COOLDOWN_MS / 60000) + " min.");
      try {
        if (typeof universe !== "undefined" && universe.remove) universe.remove(sym);
      } catch {}
      holdEvictedAt.set(sym, Date.now());
      consecutiveHolds.delete(sym);
      journalEntry({ type: "HOLD_EVICTION", symbol: sym, holds: count });
    }
  } else {
    // Actionable decision resets the counter
    consecutiveHolds.delete(sym);
  }
}

// --- [P0-1] AI Failure Metrics ---
let aiSuccesses = 0;
let aiFailures = 0;
let aiConsecutiveFailures = 0;
const AI_CONSECUTIVE_FAIL_THRESHOLD = Number(process.env.AI_CONSECUTIVE_FAIL_THRESHOLD || 5);

// --- [P5-2] Recent Fills Ring Buffer ---
const MAX_RECENT_FILLS = 20;
const recentFills = [];

function recordRecentFill(symbol, side, price, quantity, knownPnl) {
  var pnl = null;
  // [P10-1] Use pre-computed P&L if provided (avoids entryPrices.delete ordering issue)
  if (knownPnl != null) {
    pnl = knownPnl;
  } else if (side === "SELL" && price > 0) {
    var entry = entryPrices.get(String(symbol).toUpperCase());
    if (entry && entry > 0) {
      pnl = (price - entry) * quantity;
    }
  }
  recentFills.push({ symbol: symbol, side: side, price: price, quantity: quantity, pnl: pnl, at: new Date().toISOString() });
  if (recentFills.length > MAX_RECENT_FILLS) recentFills.shift();
}

// --- [IMPROVE #5] Market Regime Detection ---
// Classifies volatility regime based on recent ATR relative to price.
// Returns: "low_vol", "normal", "high_vol", "extreme_vol"
const REGIME_ATR_LOW = Number(process.env.REGIME_ATR_LOW || 0.005);    // ATR/price < 0.5%
const REGIME_ATR_HIGH = Number(process.env.REGIME_ATR_HIGH || 0.015);  // ATR/price > 1.5%
const REGIME_ATR_EXTREME = Number(process.env.REGIME_ATR_EXTREME || 0.03); // ATR/price > 3%
let currentRegime = "normal";
let regimeChangedAt = Date.now();
// [FIX] Only representative indices drive the global regime — prevents per-symbol ATR noise from causing rapid regime flips
const REGIME_ANCHOR_SYMBOLS = ["SPY", "QQQ", "005930", "KS200"]; // US large-cap + KR bellwether

function detectRegime(atr14, lastClose) {
  if (!atr14 || !lastClose || lastClose <= 0) return currentRegime;
  const atrPct = atr14 / lastClose;
  let regime;
  if (atrPct < REGIME_ATR_LOW) regime = "low_vol";
  else if (atrPct < REGIME_ATR_HIGH) regime = "normal";
  else if (atrPct < REGIME_ATR_EXTREME) regime = "high_vol";
  else regime = "extreme_vol";
  if (regime !== currentRegime) {
    console.log("[regime] Changed: " + currentRegime + " -> " + regime + " (ATR%=" + (atrPct * 100).toFixed(2) + "%)");
    currentRegime = regime;
    regimeChangedAt = Date.now();
    if (regime === "high_vol" || regime === "extreme_vol") {
      sendTelegramAlert("⚠️ *Volatility Regime Change*\nNow: " + regime + " (ATR%=" + (atrPct * 100).toFixed(2) + "%)\nPosition sizing reduced by 50%.\nPrefer defensive trades.");
    }
  }
  return currentRegime;
}

function getRegimePositionMultiplier() {
  // [Phase G] Prefer HMM-derived multiplier when trained
  if (regimeHMM && regimeHMM.trained) {
    try {
      const mult = regimeHMM.getPositionMultiplier();
      if (mult > 0 && mult < 10) return mult;
    } catch (e) { /* fall through to ATR-based */ }
  }
  if (currentRegime === "extreme_vol") return 0.25; // 75% reduction
  if (currentRegime === "high_vol") return 0.5;     // 50% reduction
  return 1.0;
}

// [Phase G] Regime HMM — trained on rolling returns, infers bull/bear/sideways
const { createRegimeHMM } = require("./src/strategy/regime-hmm");
const regimeHMM = createRegimeHMM({
  nStates: Number(process.env.HMM_N_STATES || 3),
  seed: process.env.HMM_SEED ? Number(process.env.HMM_SEED) : 42,
  maxIter: Number(process.env.HMM_MAX_ITER || 50),
});
const _hmmReturnsBuffer = [];
const _hmmLastClose = { value: null, symbol: null, ts: 0 };
const HMM_RETRAIN_MIN = Number(process.env.HMM_RETRAIN_MIN || 60); // min observations before training
const HMM_RETRAIN_INTERVAL_MS = Number(process.env.HMM_RETRAIN_INTERVAL_MS || 3600000); // 1h
let _hmmLastTrainTs = 0;
console.log("[phase-g] Regime HMM initialized (states=" + regimeHMM.config.nStates + ", labels=" + regimeHMM.config.labels.join(",") + ")");

function _hmmPushReturn(symbol, close) {
  if (!close || close <= 0) return;
  if (_hmmLastClose.symbol === symbol && _hmmLastClose.value && _hmmLastClose.value > 0) {
    const ret = (close - _hmmLastClose.value) / _hmmLastClose.value;
    if (Number.isFinite(ret) && Math.abs(ret) < 0.5) { // cap at 50% to reject bad data
      _hmmReturnsBuffer.push(ret);
      if (_hmmReturnsBuffer.length > 500) _hmmReturnsBuffer.shift();
    }
  }
  _hmmLastClose.value = close;
  _hmmLastClose.symbol = symbol;
  _hmmLastClose.ts = Date.now();
}

function _hmmMaybeRetrain() {
  const now = Date.now();
  if (_hmmReturnsBuffer.length < HMM_RETRAIN_MIN) return;
  if (now - _hmmLastTrainTs < HMM_RETRAIN_INTERVAL_MS) return;
  try {
    const result = regimeHMM.train(_hmmReturnsBuffer.slice());
    if (result.ok) {
      console.log("[phase-g] Regime HMM trained: iter=" + result.iterations + " obs=" + result.observations + " ll=" + (result.logLik || 0).toFixed(2));
      // Update orchestrator with current regime label if available
      const current = regimeHMM.filter(_hmmReturnsBuffer.length > 0
        ? [_hmmReturnsBuffer[_hmmReturnsBuffer.length - 1], Math.abs(_hmmReturnsBuffer[_hmmReturnsBuffer.length - 1]), _hmmReturnsBuffer[_hmmReturnsBuffer.length - 1]]
        : null);
      if (current && current.label && current.label !== "unknown") {
        console.log("[phase-g] Current regime (HMM): " + current.label + " (p=" + current.prob + ", mult=" + regimeHMM.getPositionMultiplier().toFixed(2) + "x)");
      }
    }
    _hmmLastTrainTs = now;
  } catch (e) {
    console.error("[phase-g] HMM retrain error: " + e.message);
  }
}

// --- [Phase H] Walk-Forward Validation — OOS backtesting of evolved parameters ---
const WALK_FORWARD_ENABLED = process.env.WALK_FORWARD_ENABLED === "true";
let walkForwardValidator = null;
let walkForwardLastResult = null;
if (WALK_FORWARD_ENABLED) {
  try {
    const { createWalkForwardValidator } = require("./src/orchestrator/walk-forward");
    const { runBacktest: wfRunBacktest } = require("./backtest");
    const { DEFAULT_GENE_BOUNDS: wfGeneBounds } = require("./src/orchestrator/evolution");
    walkForwardValidator = createWalkForwardValidator({
      candles: [],
      runBacktest: wfRunBacktest,
      geneBounds: wfGeneBounds,
      config: {
        // [P11-WF] Relaxed: train=150, test=30, step=30, minFolds=2
        // to produce 6-8 folds from ~640 bars (was 0-2 with train=200/test=50)
        trainWindowBars: Number(process.env.WF_TRAIN_BARS || 150),
        testWindowBars: Number(process.env.WF_TEST_BARS || 30),
        stepBars: Number(process.env.WF_STEP_BARS || 30),
        minFolds: Number(process.env.WF_MIN_FOLDS || 2),
        populationSize: Number(process.env.WF_POPULATION || 20),
        generations: Number(process.env.WF_GENERATIONS || 10),
        // [P11-WF] Relaxed: minOosSharpe 0.3→0.2, maxDegradation 0.5→0.7
        minOosSharpe: Number(process.env.WF_MIN_OOS_SHARPE || 0.2),
        maxFitnessDegradation: Number(process.env.WF_MAX_DEGRADATION || 0.7),
        minOosTrades: Number(process.env.WF_MIN_OOS_TRADES || 2),
        seed: process.env.WF_SEED ? Number(process.env.WF_SEED) : null,
      },
      onFold: function(f) {
        console.log("[phase-h] fold=" + f.foldIndex + " isFit=" + (Number.isFinite(f.isFitness) ? f.isFitness.toFixed(3) : "N/A")
          + " oosFit=" + (Number.isFinite(f.oosFitness) ? f.oosFitness.toFixed(3) : "N/A")
          + " deg=" + (Number.isFinite(f.degradation) ? f.degradation.toFixed(3) : "N/A"));
      },
    });
    console.log("[phase-h] Walk-forward validator initialized (train=" + (process.env.WF_TRAIN_BARS || 150)
      + ", test=" + (process.env.WF_TEST_BARS || 30) + ", step=" + (process.env.WF_STEP_BARS || 30)
      + ", minFolds=" + (process.env.WF_MIN_FOLDS || 2) + ", minOosSharpe=" + (process.env.WF_MIN_OOS_SHARPE || 0.2) + ")");
  } catch (e) {
    console.error("[phase-h] Walk-forward validator FAILED to initialize: " + e.message);
  }
} else {
  console.log("[phase-h] Walk-forward validation disabled (set WALK_FORWARD_ENABLED=true to activate)");
}

// --- [Phase L / L4.5] Strategy Lifecycle Manager — DISCOVERY → INCUBATION → PRODUCTION → RETIREMENT ---
// Manages LLM-proposed strategies through validation, graduated promotion, and automatic retirement.
const LIFECYCLE_ENABLED = process.env.LIFECYCLE_ENABLED !== "false";
let lifecycleManager = null;
// [P1-4] Declare goalBridge early so lifecycle callbacks (which close over this
// scope) can fan out into the goal bridge when it is initialized below.
const GOAL_BRIDGE_ENABLED = process.env.GOAL_BRIDGE_ENABLED !== "false";
let goalBridge = null;
if (LIFECYCLE_ENABLED) {
  try {
    const { createLifecycleManager } = require("./src/strategy/lifecycle");
    lifecycleManager = createLifecycleManager({
      walkForwardValidator: walkForwardValidator || null,
      varEngine: varEngine || null,
      council: council || null,
      config: {
        minSharpe30d: Number(process.env.LIFECYCLE_MIN_SHARPE_30D || 0.0),
        minSharpe60d: Number(process.env.LIFECYCLE_MIN_SHARPE_60D || 0.2),
        maxDrawdownMultiplier: Number(process.env.LIFECYCLE_DD_MULTIPLIER || 1.5),
        minWinRate: Number(process.env.LIFECYCLE_MIN_WIN_RATE || 0.35),
        minTradesForWinRate: Number(process.env.LIFECYCLE_MIN_TRADES_WIN_RATE || 50),
      },
      onPromote: function(id, phase, alloc) {
        console.log("[phase-l] PROMOTE: id=" + id + " phase=" + phase + " alloc=" + alloc);
        try { journalEntry({ type: "LIFECYCLE_PROMOTE", strategyId: id, phase: phase, allocationPct: alloc }); } catch {}
        try { metrics.counter("lifecycle_promote"); } catch {}
        try { sendTelegramAlert("🚀 *Strategy Promoted*\nID: " + id + "\nPhase: " + phase + "\nAllocation: " + (alloc * 100).toFixed(0) + "%"); } catch {}
        // [P1-4] Fan-out to goal bridge (late-bound; goalBridge assigned after this block)
        try { if (goalBridge) goalBridge.onPromote(id, phase, alloc); } catch (_gbe) { console.error("[p1-4] onPromote bridge error: " + (_gbe && _gbe.message ? _gbe.message : _gbe)); }
      },
      onRetire: function(id, reason, fromPhase) {
        console.warn("[phase-l] RETIRE: id=" + id + " reason=" + reason + " from=" + fromPhase);
        try { journalEntry({ type: "LIFECYCLE_RETIRE", strategyId: id, reason: reason, fromPhase: fromPhase }); } catch {}
        try { metrics.counter("lifecycle_retire"); } catch {}
        try { sendTelegramAlert("⚰️ *Strategy Retired*\nID: " + id + "\nReason: " + reason + "\nFrom: " + fromPhase, "warning"); } catch {}
        // [P1-4] Fan-out to goal bridge
        try { if (goalBridge) goalBridge.onRetire(id, reason, fromPhase); } catch (_gbe) { console.error("[p1-4] onRetire bridge error: " + (_gbe && _gbe.message ? _gbe.message : _gbe)); }
      },
      onReview: function(id, reason, metricsSnapshot) {
        console.log("[phase-l] REVIEW: id=" + id + " reason=" + reason + " sharpe60d=" + (metricsSnapshot.sharpe60d || 0));
        try { journalEntry({ type: "LIFECYCLE_REVIEW", strategyId: id, reason: reason, sharpe60d: metricsSnapshot.sharpe60d }); } catch {}
        // [P1-4] Fan-out to goal bridge
        try { if (goalBridge) goalBridge.onReview(id, reason, metricsSnapshot); } catch (_gbe) { console.error("[p1-4] onReview bridge error: " + (_gbe && _gbe.message ? _gbe.message : _gbe)); }
      },
    });
    var _lcStats = lifecycleManager.stats();
    console.log("[phase-l] Strategy lifecycle enabled (strategies=" + _lcStats.totalStrategies + ", promotionLevels=[10%,50%,100%])");
  } catch (e) {
    console.error("[phase-l] Lifecycle manager FAILED to initialize: " + e.message);
  }
} else {
  console.log("[phase-l] Strategy lifecycle disabled (set LIFECYCLE_ENABLED=true to activate)");
}

// --- [P1-4] Goal-Agent Bridge — bridges Phase L with minitok goal lifecycle ---
if (GOAL_BRIDGE_ENABLED) {
  try {
    const { createGoalBridge } = require("./src/agent/goal-bridge");
    goalBridge = createGoalBridge({
      lifecycleManager: lifecycleManager,
      workspaceRoot: process.env.MINITOK_CLIENT_ROOT || null,
    });
    goalBridge.attach();
    var _gbStats = goalBridge.stats();
    console.log("[p1-4] Goal bridge enabled (goalClient=" + _gbStats.goalClientAvailable + ", workspace=" + (_gbStats.workspaceRoot || "<none>") + ")");
  } catch (e) {
    console.error("[p1-4] Goal bridge FAILED to initialize: " + e.message);
  }
} else {
  console.log("[p1-4] Goal bridge disabled (set GOAL_BRIDGE_ENABLED=true to activate)");
}

// --- [Phase M / L4.5] Cross-Market Arbitrage Scanner ---
// Detects FX-adjusted price discrepancies across exchanges (KRX/LSE/NASDAQ/Binance/Upbit).
const CROSS_MARKET_ENABLED = process.env.CROSS_MARKET_ENABLED === "true";
let crossMarketScanner = null;
if (CROSS_MARKET_ENABLED) {
  try {
    const { createCrossMarketScanner } = require("./src/intelligence/cross-market");
    crossMarketScanner = createCrossMarketScanner({
      priceFeeds: {},  // populated by external price feed integrations
      fxProvider: null, // populated by external FX feed
      config: {
        thresholdBps: Number(process.env.CROSS_MARKET_THRESHOLD_BPS || 50),
        costBps: Number(process.env.CROSS_MARKET_COST_BPS || 10),
        scanIntervalMs: Number(process.env.CROSS_MARKET_SCAN_INTERVAL_MS || 60000),
        fetchTimeoutMs: Number(process.env.CROSS_MARKET_FETCH_TIMEOUT_MS || 5000),
        maxHistorySize: Number(process.env.CROSS_MARKET_MAX_HISTORY || 1000),
      },
      onOpportunity: function(opp) {
        console.log("[phase-m] OPPORTUNITY: " + opp.pairId + " " + opp.direction + " " + opp.netBps.toFixed(2) + "bps");
        try { journalEntry({ type: "CROSS_MARKET_OPPORTUNITY", pairId: opp.pairId, direction: opp.direction, netBps: opp.netBps }); } catch {}
        try { metrics.counter("cross_market_opportunity"); } catch {}
        try { sendTelegramAlert("💰 *Cross-Market Arbitrage*\nPair: " + opp.pairId + "\nDirection: " + opp.direction + "\nNet Spread: " + opp.netBps.toFixed(2) + "bps"); } catch {}
        // [Phase N] Escalate high-value opportunities (>= 2x threshold) to human
        try {
          if (escalationManager && opp.netBps >= (Number(process.env.CROSS_MARKET_THRESHOLD_BPS || 50) * 2)) {
            escalationManager.escalate({
              severity: "info",
              summary: "High-value cross-market arbitrage detected",
              bullets: [
                "Pair: " + opp.pairId,
                "Direction: " + opp.direction,
                "Net spread: " + opp.netBps.toFixed(2) + " bps (" + (opp.netBps / Number(process.env.CROSS_MARKET_THRESHOLD_BPS || 50)).toFixed(1) + "x threshold)",
                "Consider manual execution for optimal fill",
              ],
              options: [
                { id: "execute", label: "Execute arbitrage manually", recommended: true },
                { id: "ignore", label: "Ignore — auto-handle" },
                { id: "monitor", label: "Add to watchlist" },
              ],
              timeoutMs: 1800000,
              fallbackOptionId: "ignore",
              cooldownKey: "cross_market_" + opp.pairId,
            });
          }
        } catch (e) { console.error("[phase-m] escalation error: " + e.message); }
      },
      onError: function(pairId, err) {
        console.error("[phase-m] SCAN ERROR: " + pairId + ": " + (err && err.message ? err.message : err));
        try { metrics.counter("cross_market_error"); } catch {}
      },
    });
    var _cmStats = crossMarketScanner.stats();
    console.log("[phase-m] Cross-market scanner enabled (threshold=" + _cmStats.thresholdBps + "bps, costBps=" + _cmStats.costBps + ", interval=" + (Number(process.env.CROSS_MARKET_SCAN_INTERVAL_MS || 60000)) + "ms)");
  } catch (e) {
    console.error("[phase-m] Cross-market scanner FAILED to initialize: " + e.message);
  }
} else {
  console.log("[phase-m] Cross-market scanner disabled (set CROSS_MARKET_ENABLED=true to activate)");
}

// --- [Phase N / L4.5] Human Escalation Protocol ---
// Structured decision requests with multi-channel broadcast, timeout fallback, and audit trail.
const ESCALATION_ENABLED = process.env.ESCALATION_ENABLED !== "false";
let escalationManager = null;
if (ESCALATION_ENABLED) {
  try {
    const { createEscalationManager } = require("./src/orchestrator/escalation");
    escalationManager = createEscalationManager({
      channels: {
        telegram: function(msg) {
          try { sendTelegramAlert(msg.message || msg, msg.severity === "critical" ? "critical" : "warning"); } catch {}
          return Promise.resolve();
        },
      },
      config: {
        enabled: true,
        dailyLimit: Number(process.env.ESCALATION_DAILY_LIMIT || 3),
        defaultTimeoutMs: Number(process.env.ESCALATION_DEFAULT_TIMEOUT_MS || 14400000),
        timeoutFallback: process.env.ESCALATION_TIMEOUT_FALLBACK || "default",
        cooldownMs: Number(process.env.ESCALATION_COOLDOWN_MS || 300000),
        maxHistorySize: Number(process.env.ESCALATION_MAX_HISTORY || 500),
      },
      onResponse: function(id, optionId, entry) {
        console.log("[phase-n] RESPONSE: id=" + id + " option=" + optionId);
        try { journalEntry({ type: "ESCALATION_RESPONSE", escalationId: id, optionId: optionId, summary: entry.summary }); } catch {}
        try { metrics.counter("escalation_response"); } catch {}
      },
      onTimeout: function(id, fallback, entry) {
        console.warn("[phase-n] TIMEOUT: id=" + id + " fallback=" + fallback + " summary=" + entry.summary);
        try { journalEntry({ type: "ESCALATION_TIMEOUT", escalationId: id, fallback: fallback, summary: entry.summary }); } catch {}
        try { metrics.counter("escalation_timeout"); } catch {}
        try { sendTelegramAlert("⏰ *Escalation Timeout*\nID: " + id + "\nFallback: " + fallback + "\nSummary: " + entry.summary, "warning"); } catch {}
      },
      audit: function(event) {
        try { audit.custom("escalation_" + event.event, event.data); } catch {}
      },
    });
    var _escStats = escalationManager.stats();
    console.log("[phase-n] Escalation manager enabled (dailyLimit=" + _escStats.dailyLimit + ", timeout=" + (Number(process.env.ESCALATION_DEFAULT_TIMEOUT_MS || 14400000)) + "ms, fallback=" + (process.env.ESCALATION_TIMEOUT_FALLBACK || "default") + ", channels=" + _escStats.channels.join(",") + ")");
  } catch (e) {
    console.error("[phase-n] Escalation manager FAILED to initialize: " + e.message);
  }
} else {
  console.log("[phase-n] Escalation manager disabled (set ESCALATION_ENABLED=false to deactivate)");
}

// --- [P1-6] MCP Tool Bridge — exposes escalation + lifecycle as MCP tools ---
const MCP_BRIDGE_ENABLED = process.env.MCP_BRIDGE_ENABLED !== "false";
let mcpBridge = null;
if (MCP_BRIDGE_ENABLED) {
  try {
    const { createMcpBridge } = require("./src/agent/mcp-bridge");
    mcpBridge = createMcpBridge({
      scalper: scalper,
      escalationManager: escalationManager,
      lifecycleManager: lifecycleManager,
      audit: function(evt) {
        try { if (auditFederation) auditFederation.write("mcp_bridge_" + evt.event, evt.data); else if (audit && audit.custom) audit.custom("mcp_bridge_" + evt.event, evt.data); } catch {}
      },
    });
    var _mbStats = mcpBridge.stats();
    console.log("[p1-6] MCP bridge enabled (tools=" + _mbStats.tools.join(",") + ", escalation=" + _mbStats.escalationAvailable + ", lifecycle=" + _mbStats.lifecycleAvailable + ")");
  } catch (e) {
    console.error("[p1-6] MCP bridge FAILED to initialize: " + e.message);
  }
} else {
  console.log("[p1-6] MCP bridge disabled (set MCP_BRIDGE_ENABLED=true to activate)");
}

// --- [P-WebTools] AI web access tools (web_search, web_fetch) for agentic function-calling ---
const WEB_TOOLS_ENABLED = process.env.WEB_TOOLS_ENABLED !== "false";
let webTools = null;
if (WEB_TOOLS_ENABLED) {
  try {
    const { createWebTools } = require("./src/agent/web-tools");
    webTools = createWebTools({ braveApiKey: process.env.BRAVE_SEARCH_API_KEY || "" });
    var _wtStats = webTools.stats();
    console.log("[web-tools] Enabled (brave=" + (_wtStats.braveConfigured ? "yes" : "no, DDG fallback") + ", schemas=" + webTools.getSchemas().length + ")");
  } catch (e) {
    console.error("[web-tools] Init failed: " + e.message);
    webTools = null;
  }
} else {
  console.log("[web-tools] Disabled (set WEB_TOOLS_ENABLED=true to activate)");
}

// --- [P1-7] Audit Federation — routes audit events to local + minitok + remote sinks ---
const AUDIT_FEDERATION_ENABLED = process.env.AUDIT_FEDERATION_ENABLED !== "false";
let auditFederation = null;
if (AUDIT_FEDERATION_ENABLED) {
  try {
    const { createAuditFederation } = require("./src/core/audit-federation");
    var _minitokAuditModule = null;
    if (process.env.MINITOK_CLIENT_ROOT) {
      try {
        var _auditPath = require("node:path").join(process.env.MINITOK_CLIENT_ROOT, "src", "core", "audit");
        _minitokAuditModule = require(_auditPath);
      } catch (_ae) { /* minitok audit optional */ }
    }
    auditFederation = createAuditFederation({
      localAudit: audit || null,
      minitokAudit: _minitokAuditModule,
      remoteEndpoint: process.env.AUDIT_REMOTE_URL || null,
    });
    var _afStats = auditFederation.stats();
    console.log("[p1-7] Audit federation enabled (local=" + _afStats.sinks.local + ", minitok=" + _afStats.sinks.minitok + ", remote=" + _afStats.sinks.remote + ")");
  } catch (e) {
    console.error("[p1-7] Audit federation FAILED to initialize: " + e.message);
  }
} else {
  console.log("[p1-7] Audit federation disabled (set AUDIT_FEDERATION_ENABLED=true to activate)");
}

// --- [Phase M / L4.5] Periodic cross-market scan timer ---
var crossMarketTimer = null;
if (crossMarketScanner) {
  var _cmInterval = Number(process.env.CROSS_MARKET_SCAN_INTERVAL_MS || 60000);
  crossMarketTimer = setInterval(function() {
    try {
      crossMarketScanner.scan().then(function(result) {
        if (result.opportunities.length > 0) {
          console.log("[phase-m] Scan complete: " + result.pairsScanned + " pairs, " + result.opportunities.length + " opportunities");
        }
      }).catch(function(err) {
        console.error("[phase-m] Periodic scan error: " + (err && err.message ? err.message : err));
      });
    } catch (e) {
      console.error("[phase-m] Timer error: " + e.message);
    }
  }, _cmInterval);
  console.log("[phase-m] Periodic scan timer started (interval=" + _cmInterval + "ms)");
}

// --- [IMPROVE #6] Slippage Tracking ---
// Tracks expected vs actual fill price for all executed orders.
const slippageStats = { count: 0, totalPct: 0, maxSlippagePct: 0, worstSymbol: "", entries: [] };

function recordSlippage(symbol, side, expectedPrice, actualPrice) {
  if (!expectedPrice || !actualPrice) return;
  const slippagePct = ((actualPrice - expectedPrice) / expectedPrice) * 100;
  // For BUY, positive slippage = paid more = bad. For SELL, negative = sold lower = bad.
  const effectiveSlippage = side === "BUY" ? slippagePct : -slippagePct;
  slippageStats.count++;
  slippageStats.totalPct += effectiveSlippage;
  if (effectiveSlippage > slippageStats.maxSlippagePct) {
    slippageStats.maxSlippagePct = effectiveSlippage;
    slippageStats.worstSymbol = symbol;
  }
  slippageStats.entries.push({ symbol, side, expected: expectedPrice, actual: actualPrice, slippagePct: Number(effectiveSlippage.toFixed(4)), ts: new Date().toISOString() });
  if (slippageStats.entries.length > 200) slippageStats.entries = slippageStats.entries.slice(-200);
  console.log("[slippage] " + symbol + " " + side + ": expected=" + expectedPrice + " actual=" + actualPrice + " slippage=" + effectiveSlippage.toFixed(4) + "%");
  // [self-audit] Feed slippage sample for Layer 1 excessive-slippage rule
  try { selfAudit.recordSlippage(effectiveSlippage); } catch {}
}

// --- [IMPROVE #7] Symbol Performance Tracking for Universe Quality ---
// Tracks per-symbol trade outcomes to identify underperformers.
// [BUGFIX] entryPrices stores actual BUY fill prices so SELL P&L is accurate.
const entryPrices = new Map(); // symbol -> last BUY fill price
const symbolPerformance = new Map(); // symbol -> { trades, wins, losses, totalPnl }

const SYMBOL_PERF_MAX_SIZE = 200;

function recordSymbolOutcome(symbol, pnl, suppressed) {
  if (!symbol) return;
  const s = String(symbol).toUpperCase();
  if (!symbolPerformance.has(s)) {
    // [P0-FIX] Cap map size — evict least-recently-updated entries when full
    if (symbolPerformance.size >= SYMBOL_PERF_MAX_SIZE) {
      const oldest = symbolPerformance.keys().next().value;
      symbolPerformance.delete(oldest);
    }
    symbolPerformance.set(s, { trades: 0, wins: 0, losses: 0, totalPnl: 0, suppressedTrades: 0 });
  }
  const perf = symbolPerformance.get(s);
  perf.trades++;
  if (suppressed) perf.suppressedTrades++;
  if (pnl > 0) perf.wins++;
  else if (pnl < 0) perf.losses++;
  perf.totalPnl += pnl;
}

// [P0-FIX] Periodic cleanup: remove stale entries from Maps for symbols no longer in universe
function cleanupStaleSymbolData() {
  if (typeof universe === "undefined" || !universe) return;
  const activeSymbols = new Set(universe.getAll().map(function(s) { return String(s).toUpperCase(); }));
  // Only entryPrices indicates a genuinely open position (set on BUY fill, deleted on SELL fill).
  // peakPrices / atrStopPrices must NOT extend the active set — otherwise zombie entries
  // for evicted symbols would keep themselves alive forever via self-reference.
  for (const sym of entryPrices.keys()) activeSymbols.add(String(sym).toUpperCase());

  let cleanedCandles = 0;
  for (const sym of lastCandleCtx.keys()) {
    if (!activeSymbols.has(String(sym).toUpperCase())) {
      lastCandleCtx.delete(sym);
      cleanedCandles++;
    }
  }

  // Purge trailing-stop / ATR-stop zombies for symbols no longer active.
  // These should have been deleted on SELL fill, but can linger if a position
  // was closed externally or the symbol was evicted mid-hold.
  let cleanedStops = 0;
  for (const sym of peakPrices.keys()) {
    if (!activeSymbols.has(String(sym).toUpperCase())) { peakPrices.delete(sym); cleanedStops++; }
  }
  for (const sym of atrStopPrices.keys()) {
    if (!activeSymbols.has(String(sym).toUpperCase())) { atrStopPrices.delete(sym); cleanedStops++; }
  }

  // Purge HOLD-eviction tracking for symbols no longer watched.
  let cleanedHolds = 0;
  for (const sym of consecutiveHolds.keys()) {
    if (!activeSymbols.has(String(sym).toUpperCase())) { consecutiveHolds.delete(sym); cleanedHolds++; }
  }
  for (const sym of holdEvictedAt.keys()) {
    if (!activeSymbols.has(String(sym).toUpperCase())) { holdEvictedAt.delete(sym); cleanedHolds++; }
  }

  // Purge stale AI decision cache entries for evicted symbols.
  let cleanedCache = 0;
  for (const sym of aiDecisionCache.keys()) {
    if (!activeSymbols.has(String(sym).toUpperCase())) { aiDecisionCache.delete(sym); cleanedCache++; }
  }

  // Note: symbolPerformance is kept longer (needed for eviction decisions)
  // but is capped at SYMBOL_PERF_MAX_SIZE by recordSymbolOutcome above
  const totalCleaned = cleanedCandles + cleanedStops + cleanedHolds + cleanedCache;
  if (totalCleaned > 0) {
    console.log("[cleanup] Purged: candles=" + cleanedCandles + ", stops=" + cleanedStops + ", holds=" + cleanedHolds + ", aiCache=" + cleanedCache);
  }
}

function getWorstSymbols(minTrades, count) {
  const results = [];
  for (const [sym, perf] of symbolPerformance.entries()) {
    if (perf.trades >= minTrades) {
      results.push({ symbol: sym, ...perf });
    }
  }
  results.sort(function(a, b) { return a.totalPnl - b.totalPnl; });
  return results.slice(0, count);
}

// [P6-2] Best performing symbols for daily report and AI context
function getBestSymbols(minTrades, count) {
  const results = [];
  for (const [sym, perf] of symbolPerformance.entries()) {
    if (perf.trades >= minTrades) {
      results.push({ symbol: sym, ...perf });
    }
  }
  results.sort(function(a, b) { return b.totalPnl - a.totalPnl; });
  return results.slice(0, count);
}

// [P6-1] Build compact performance summary for AI payload
function buildSymbolPerformanceSummary(currentSym) {
  var summary = {};
  // Always include the symbol currently being evaluated
  if (currentSym && symbolPerformance.has(currentSym)) {
    summary[currentSym] = symbolPerformance.get(currentSym);
  }
  // Include top 3 worst and best performers for broader context
  var worst = getWorstSymbols(1, 3);
  var best = getBestSymbols(1, 3);
  for (var w of worst) { summary[w.symbol] = { trades: w.trades, wins: w.wins, losses: w.losses, totalPnl: Math.round(w.totalPnl) }; }
  for (var b of best) { summary[b.symbol] = { trades: b.trades, wins: b.wins, losses: b.losses, totalPnl: Math.round(b.totalPnl) }; }
  // Cap at 10 entries to keep payload small
  var keys = Object.keys(summary);
  if (keys.length > 10) {
    var trimmed = {};
    for (var i = 0; i < 10; i++) trimmed[keys[i]] = summary[keys[i]];
    return trimmed;
  }
  return summary;
}

// --- [AI-MAX-PROFIT] Dual Portfolio Mode ---
// When AI_MAX_PROFIT_PCT > 0, the portfolio is split into two buckets:
//   - max_profit bucket (AI_MAX_PROFIT_PCT% of equity): full AI autonomy, no targets/stops/halts
//   - standard bucket (remaining %): existing target engine + safety constraints
// Set AI_MAX_PROFIT_PCT=0 to disable dual mode and use legacy UNRESTRICTED behavior.
const AI_MAX_PROFIT_PCT = Number(process.env.AI_MAX_PROFIT_PCT || 0);
const AI_MAX_PROFIT = AI_MAX_PROFIT_PCT > 0;

function getBucketBudget(totalEquity, strategy) {
  if (!totalEquity || totalEquity <= 0) return 0;
  if (strategy === "max_profit") return totalEquity * (AI_MAX_PROFIT_PCT / 100);
  return totalEquity * ((100 - AI_MAX_PROFIT_PCT) / 100);
}

// --- [P1-2] Per-Symbol Max Loss Monitor ---
// Checks open positions against entry prices and forces SELL if loss exceeds threshold.
// [Tier 2] -5% → -12%: 정상 변동성 내에서 강제 청산 방지.
// Tier 1 daily hard-stop (-2% equity) 은 별도 유지되어 전체 계좌 보호.
const SYMBOL_MAX_LOSS_PCT = Number(process.env.SYMBOL_MAX_LOSS_PCT || -12); // -12% default
const SYMBOL_LOSS_CHECK_MS = Number(process.env.SYMBOL_LOSS_CHECK_MS || 60000); // 1 min

async function checkSymbolMaxLoss() {
  if (AI_MAX_PROFIT_PCT >= 100) return; // Only skip entirely if 100% max-profit
  if (targetEngine.project().halted) return;
  try {
    var portfolio = await fetchPortfolioContext();
    for (var pos of portfolio.positions) {
      var sym = pos.symbol;
      var currentPrice = pos.currentPrice;
      var qty = pos.quantity;
      if (!sym || !currentPrice || !qty || qty <= 0) continue;
      // Check against our tracked entry price first, then avgPrice from holdings
      var entry = entryPrices.get(sym) || pos.avgPrice;
      if (!entry || entry <= 0) continue;
      var lossPct = ((currentPrice - entry) / entry) * 100;
      if (lossPct <= SYMBOL_MAX_LOSS_PCT) {
        console.warn("[symbol-loss] " + sym + " at " + lossPct.toFixed(2) + "% loss (entry=" + entry + ", now=" + currentPrice + "). Forcing SELL...");
        journalEntry({ type: "SYMBOL_FORCE_SELL", symbol: sym, lossPct: Number(lossPct.toFixed(2)), entryPrice: entry, currentPrice: currentPrice, quantity: qty });
        sendTelegramAlert("🔻 *Symbol Stop-Loss*\n" + sym + " forced SELL at " + lossPct.toFixed(2) + "% loss", "critical");
        await executeDecision({ action: "SELL", symbol: sym, quantity: qty, price: currentPrice, reason: "symbol_max_loss_" + SYMBOL_MAX_LOSS_PCT + "pct" });
        entryPrices.delete(sym);
        peakPrices.delete(sym); // [P10-2c] Clear trailing stop peak
      }
    }
  } catch (e) {
    console.error("[symbol-loss] Check failed: " + e.message);
  }
}

// --- [P8-1] Trailing Stop-Loss ---
// Tracks peak price per symbol; forces SELL if price drops TRAILING_STOP_PCT from peak.
// [Tier 2] -3% → -8%: 더 큰 변동 허용하여 추세 보유.
// [Tier 2] activation +1% → +3%: 진짜 추세만 추적 (단타 방지).
const TRAILING_STOP_PCT = Number(process.env.TRAILING_STOP_PCT || -8); // -8% from peak default
const TRAILING_STOP_MIN_PROFIT_PCT = Number(process.env.TRAILING_STOP_MIN_PROFIT_PCT || 3); // Only trail after +3% profit
// [Phase 3.3] ATR hard stop — always active from entry (not just after profit)
const AUTO_EXCHANGE_MODE = process.env.AUTO_EXCHANGE_MODE || "alert";
const ATR_HARD_STOP_MULT = Number(process.env.ATR_HARD_STOP_MULT || 2); // stop = entry - 2*ATR

// --- [CASH-RESCUE] Held Position Sweep ---
const HELD_SWEEP_INTERVAL_MS = Number(process.env.HELD_SWEEP_INTERVAL_MS || 300000);
const HELD_SWEEP_MAX_PER_CYCLE = Number(process.env.HELD_SWEEP_MAX_PER_CYCLE || 3);

async function heldPositionSweep() {
  // [CASH-RESCUE] Bypass halt check — sweep is a rescue mechanism that must work even when halted
  // Only skip if killswitch is explicitly halted (human intervention required)
  try { var _ksHalt = killswitch.state(); if (_ksHalt.halted) return; } catch {}
  try {
    var portfolio = await fetchPortfolioContext();
    if (!portfolio || !portfolio.positions || portfolio.positions.length === 0) return;
    var cashKrw = portfolio.cashKrw || 0;
    var cashUsd = portfolio.cashUsd || 0;
    var fxUsdKrw = cachedFxRates.FX_USD_KRW || 1350;
    var totalCashKrw = cashKrw + cashUsd * fxUsdKrw; // USD is directly usable for US-market buys
    var totalEquity = computeTotalEquityKrw(portfolio);
    // [Patch 2026-10-15] KRW-denominated shortage gate: USD holdings must NOT mask KRW=0.
    // Auto-exchange (USD->KRW) exists precisely for this state, so gate on cashKrw itself.
    var CASH_RESCUE_KRW_MIN = Number(process.env.CASH_RESCUE_KRW_MIN || 100000);
    var cashRescueMode = cashKrw < CASH_RESCUE_KRW_MIN && (totalEquity > 1000000 || positions.length > 0);
    var positions = portfolio.positions.slice().sort(function(a, b) { return (b.marketValue || 0) - (a.marketValue || 0); });
    var reviewed = 0;
    var maxReviews = cashRescueMode ? HELD_SWEEP_MAX_PER_CYCLE * 2 : HELD_SWEEP_MAX_PER_CYCLE;
    for (var pos of positions) {
      if (reviewed >= maxReviews) break;
      var sym = pos.symbol;
      if (!sym || !pos.quantity || pos.quantity <= 0) continue;
      if (inFlightSymbols.has(String(sym).toUpperCase())) continue;
      if (pendingOffHoursSells.has(String(sym).toUpperCase())) { console.log("[held-sweep] SKIP " + sym + " (pending off-hours SELL)"); continue; }
      if (universe && !universe.symbols.has(String(sym).toUpperCase())) {
        try { universe.add(sym); console.log("[held-sweep] Added " + sym + " to universe"); } catch {}
      }
      var currentPrice = pos.currentPrice || pos.lastPrice;
      if (!currentPrice || currentPrice <= 0) {
        try {
          var _sweepToken = await fetchAccessToken(TOSS_CLIENT_ID, TOSS_CLIENT_SECRET);
          var priceResp = await getPrices(_sweepToken, [sym]);
          if (priceResp && priceResp.body) {
            var pa = Array.isArray(priceResp.body) ? priceResp.body : [priceResp.body];
            if (pa.length > 0) currentPrice = Number(pa[0].price || pa[0].lastPrice || 0);
          }
        } catch (_pe) { /* best-effort */ }
      }
      if (!currentPrice || currentPrice <= 0) { console.log("[held-sweep] SKIP " + sym + " (no price)"); continue; }
      var marketData = {
        source: "held-sweep", market: (typeof detectMarket === "function" ? detectMarket(sym) : "US") || "US",
        symbol: sym, price: { symbol: sym, price: currentPrice, lastPrice: currentPrice },
        _heldReview: true, _cashRescueMode: cashRescueMode,
        _positionInfo: { quantity: pos.quantity, avgPrice: pos.avgPrice || 0, marketValue: pos.marketValue || 0,
          pnlPct: pos.profitLossPct != null ? pos.profitLossPct : (pos.avgPrice > 0 ? ((currentPrice - pos.avgPrice) / pos.avgPrice * 100) : 0) }
      };
      var decision = await askAI(marketData, { bypassThrottle: true });
      reviewed++;
      if (!decision) { console.log("[held-sweep] NULL_DECISION " + sym + " (askAI returned null)"); continue; }
      if (decision && decision.action === "SELL") {
        if (!decision.quantity || decision.quantity <= 0) decision.quantity = pos.quantity;
        decision.price = decision.price || currentPrice;
        decision._decisionSource = "held-sweep";
        console.log("[held-sweep] SELL " + sym + " qty=" + decision.quantity + " @ " + currentPrice + " reason=" + (decision.reason || ""));
        journalEntry({ type: "HELD_SWEEP_SELL", symbol: sym, quantity: decision.quantity, price: currentPrice, pnlPct: marketData._positionInfo.pnlPct, cashRescue: cashRescueMode });
        try { sendTelegramAlert("[Sweep] SELL " + sym + " qty=" + decision.quantity + " (pnl=" + marketData._positionInfo.pnlPct.toFixed(2) + "%)"); } catch {}
        await executeDecision(decision);
      } else if (decision) {
        console.log("[held-sweep] " + decision.action + " " + sym + " (pnl=" + marketData._positionInfo.pnlPct.toFixed(2) + "%, rescue=" + cashRescueMode + ")");
      }
    }
    if (reviewed > 0) console.log("[held-sweep] Reviewed " + reviewed + "/" + positions.length + " positions, cashKrw=" + Math.round(cashKrw) + ", cashUsd=" + cashUsd.toFixed(2) + ", totalCashKrw=" + Math.round(totalCashKrw) + ", equityKrw=" + Math.round(totalEquity) + ", rescue=" + cashRescueMode + ", fxUSD=" + cachedFxRates.FX_USD_KRW);

    // [AUTO-EXCHANGE] If KRW cash is still critically low after sweep, check USD buying power
    // and auto-convert USD → KRW to restore liquidity.
    if (cashRescueMode) {
      try {
        var token = await fetchAccessToken(TOSS_CLIENT_ID, TOSS_CLIENT_SECRET);
        var usdBp = await getBuyingPower(token, TOSS_ACCOUNT_SEQ, "USD");
        var usdCash = Number(usdBp.body?.cashBuyingPower || 0);
        var fxRate = cachedFxRates.FX_USD_KRW || 1350;
        var usdCashKrw = usdCash * fxRate;
        console.log("[auto-exchange] USD cash=" + usdCash.toFixed(2) + " (≈" + Math.round(usdCashKrw) + " KRW), cashKrw=" + Math.round(cashKrw));
        if (usdCash > 10 && cashKrw < 50000) {
          var exchangeAmount = Math.min(usdCash, Math.ceil((100000 - cashKrw) / fxRate));
          if (exchangeAmount < 1) exchangeAmount = Math.min(usdCash, 1);
          console.log("[auto-exchange] Converting " + exchangeAmount.toFixed(2) + " USD → KRW (rate=" + fxRate + ")");
          if (AUTO_EXCHANGE_MODE === "execute") {
          var exchangeResp = await createExchangeOrder(token, TOSS_ACCOUNT_SEQ, {
            baseCurrency: "USD",
            quoteCurrency: "KRW",
            amount: exchangeAmount,
          });
          if (exchangeResp.status === 200 || exchangeResp.status === 201) {
            console.log("[auto-exchange] SUCCESS: " + exchangeAmount.toFixed(2) + " USD → KRW");
            journalEntry({ type: "AUTO_EXCHANGE", from: "USD", to: "KRW", amount: exchangeAmount, fxRate: fxRate });
            sendTelegramAlert("💱 *Auto Exchange*\n" + exchangeAmount.toFixed(2) + " USD → KRW\nRate: " + fxRate + "\nReason: cash rescue");
            // Invalidate portfolio cache so next sweep sees updated cash
            try { invalidatePortfolioCache(); } catch {}
          } else {
            console.warn("[auto-exchange] FAILED: status=" + exchangeResp.status + " body=" + JSON.stringify(exchangeResp.body));
          }
          } else {
            console.log("[auto-exchange] ALERT: USD->KRW " + exchangeAmount.toFixed(2) + " suggested, skip execution");
            sendTelegramAlert("[EXCHANGE] " + exchangeAmount.toFixed(2) + " USD->KRW manual. Rate=" + fxRate + " KRW=" + Math.round(cashKrw), "warn");
            journalEntry({ type: "EXCHANGE_ALERT", from: "USD", to: "KRW", suggestedAmount: exchangeAmount, fxRate: fxRate });
          }
        }
      } catch (exErr) {
        console.warn("[auto-exchange] Error: " + exErr.message);
      }
    }

    // [AUTO-EXCHANGE KRW->USD] If USD cash is critically low but KRW is available,
    // auto-convert KRW -> USD so US-market BUY orders can proceed.
    // Trigger when USD cash < threshold AND KRW cash is comfortably above the rescue floor.
    try {
      var token2 = await fetchAccessToken(TOSS_CLIENT_ID, TOSS_CLIENT_SECRET);
      var usdBp2 = await getBuyingPower(token2, TOSS_ACCOUNT_SEQ, "USD");
      var usdCashNow = Number(usdBp2.body?.cashBuyingPower || 0);
      var krwBp = await getBuyingPower(token2, TOSS_ACCOUNT_SEQ, "KRW");
      var krwCashNow = Number(krwBp.body?.cashBuyingPower || 0);
      var fx2 = cachedFxRates.FX_USD_KRW || 1350;
      // USD floor: enough for at least one US order (min order ~ $20). KRW keep floor: 200k.
      var USD_MIN = 50, KRW_KEEP = 200000;
      if (usdCashNow < USD_MIN && krwCashNow > KRW_KEEP + 100000) {
        var exchangeKrw = Math.min(krwCashNow - KRW_KEEP, Math.ceil((200 - usdCashNow) * fx2));
        if (exchangeKrw >= 10000) {
          console.log("[auto-exchange] Converting " + exchangeKrw + " KRW -> USD (rate=" + fx2 + ")");
          if (AUTO_EXCHANGE_MODE === "execute") {
          var exResp2 = await createExchangeOrder(token2, TOSS_ACCOUNT_SEQ, {
            baseCurrency: "KRW",
            quoteCurrency: "USD",
            amount: exchangeKrw,
          });
          if (exResp2.status === 200 || exResp2.status === 201) {
            console.log("[auto-exchange] SUCCESS: " + exchangeKrw + " KRW -> USD");
            journalEntry({ type: "AUTO_EXCHANGE", from: "KRW", to: "USD", amount: exchangeKrw, fxRate: fx2 });
            sendTelegramAlert("\u{1F4B1} *Auto Exchange*\n" + exchangeKrw + " KRW -> USD\nRate: " + fx2 + "\nReason: USD liquidity for US buys");
            try { invalidatePortfolioCache(); } catch {}
          } else {
            console.warn("[auto-exchange] KRW->USD FAILED: status=" + exResp2.status + " body=" + JSON.stringify(exResp2.body));
          }
          } else {
            console.log("[auto-exchange] ALERT: KRW->USD " + exchangeKrw + " suggested, skip execution");
            sendTelegramAlert("[EXCHANGE] " + exchangeKrw + " KRW->USD manual. Rate=" + fx2, "warn");
            journalEntry({ type: "EXCHANGE_ALERT", from: "KRW", to: "USD", suggestedAmount: exchangeKrw, fxRate: fx2 });
          }
        }
      }
    } catch (ex2) {
      console.warn("[auto-exchange] KRW->USD error: " + ex2.message);
    }
  } catch (e) { console.error("[held-sweep] Error: " + e.message); }
}

let trailingStopTriggers = 0;
let atrHardStopTriggers = 0;
const peakPrices = new Map(); // symbol -> highest observed price since entry
const atrStopPrices = new Map(); // symbol -> hard stop price (entry - N*ATR)

// Register an ATR hard stop after a BUY fill. Called from executeDecision.
function registerAtrStop(symbol, entryPrice, atr) {
  if (!symbol || !entryPrice || !atr || atr <= 0) return;
  const stop = entryPrice - ATR_HARD_STOP_MULT * atr;
  atrStopPrices.set(symbol, Math.round(stop * 100) / 100);
  console.log("[atr-stop] " + symbol + " hard stop set at " + stop.toFixed(2) + " (entry " + entryPrice + ", " + ATR_HARD_STOP_MULT + "x ATR " + atr + ")");
}

async function checkTrailingStops() {
  if (AI_MAX_PROFIT_PCT >= 100) return; // Only skip entirely if 100% max-profit
  if (targetEngine.project().halted) return;
  try {
    // [P0-1 Integration] Compute dynamic risk parameters from current regime.
    // Adjusts trailing stop and hard-stop based on ATR, VIX proxy, drawdown.
    var portfolio = await fetchPortfolioContext();
    var totalEquity = computeTotalEquityKrw(portfolio);
    // [FIX] Use public API instead of internal _state access
    var proj = targetEngine.project();
    var hwm = proj.highWaterEquity;
    var ddPct = (hwm && hwm > 0 && totalEquity > 0) ? ((hwm - totalEquity) / hwm) * 100 : 0;
    // Use average ATR% of open positions as portfolio volatility proxy
    var atrSum = 0, atrCount = 0;
    for (var p of portfolio.positions) {
      var cachedCtx = lastCandleCtx.get(p.symbol);
      if (cachedCtx && cachedCtx.atr14 && cachedCtx.lastClose > 0) {
        atrSum += (cachedCtx.atr14 / cachedCtx.lastClose) * 100;
        atrCount++;
      }
    }
    var portfolioAtrPct = atrCount > 0 ? atrSum / atrCount : 1.5;
    var dynRisk = computeDynamicRisk({ portfolioAtrPct: portfolioAtrPct, recentDrawdownPct: -ddPct });
    // Apply dynamic adjustment to trailing stop percentage
    var effectiveTrailingPct = TRAILING_STOP_PCT * dynRisk.trailingStopAdjust;

    for (var pos of portfolio.positions) {
      var sym = pos.symbol;
      var currentPrice = pos.currentPrice;
      var qty = pos.quantity;
      if (!sym || !currentPrice || !qty || qty <= 0) continue;
      var entry = entryPrices.get(sym) || pos.avgPrice;
      if (!entry || entry <= 0) continue;
      var profitPct = ((currentPrice - entry) / entry) * 100;

      // [Phase 3.3] ATR hard stop — checked FIRST, before profit gate.
      // Cuts losers at entry-2*ATR even if never reached trailing activation.
      var hardStop = atrStopPrices.get(sym);
      if (hardStop != null && currentPrice <= hardStop) {
        console.warn("[atr-stop] " + sym + " hit hard stop " + hardStop + " (now " + currentPrice + ", entry=" + entry + "). Forcing SELL...");
        journalEntry({ type: "ATR_HARD_STOP_TRIGGERED", symbol: sym, stopPrice: hardStop, currentPrice: currentPrice, lossPct: Number(profitPct.toFixed(2)), quantity: qty });
        sendTelegramAlert("🛑 *ATR Hard Stop*\n" + sym + " sold at " + profitPct.toFixed(2) + "% (hit stop " + hardStop + ")", "critical");
        atrHardStopTriggers++;
        await executeDecision({ action: "SELL", symbol: sym, quantity: qty, price: currentPrice, reason: "atr_hard_stop" });
        entryPrices.delete(sym);
        peakPrices.delete(sym);
        atrStopPrices.delete(sym);
        continue;
      }

      // Only activate trailing stop after minimum profit threshold
      if (profitPct < TRAILING_STOP_MIN_PROFIT_PCT) {
        peakPrices.delete(sym);
        continue;
      }
      // Update peak price
      var peak = peakPrices.get(sym) || entry;
      if (currentPrice > peak) {
        peakPrices.set(sym, currentPrice);
        peak = currentPrice;
      }
      // Check trailing stop: drop from peak
      // [P0-1] Use dynamic-risk adjusted trailing percentage
      var dropFromPeakPct = ((currentPrice - peak) / peak) * 100;
      if (dropFromPeakPct <= effectiveTrailingPct) {
        console.warn("[trailing-stop] " + sym + " dropped " + dropFromPeakPct.toFixed(2) + "% from peak " + peak + " (now " + currentPrice + ", entry=" + entry + ", effTrail=" + effectiveTrailingPct.toFixed(2) + "%). Forcing SELL...");
        journalEntry({ type: "TRAILING_STOP_TRIGGERED", symbol: sym, peakPrice: peak, currentPrice: currentPrice, dropPct: Number(dropFromPeakPct.toFixed(2)), profitPct: Number(profitPct.toFixed(2)), quantity: qty, regime: dynRisk.regime });
        sendTelegramAlert("📉 *Trailing Stop Triggered*\n" + sym + " sold at " + profitPct.toFixed(2) + "% profit (dropped " + dropFromPeakPct.toFixed(2) + "% from peak, regime=" + dynRisk.regime + ")");
        trailingStopTriggers++;
        await executeDecision({ action: "SELL", symbol: sym, quantity: qty, price: currentPrice, reason: "trailing_stop_" + effectiveTrailingPct.toFixed(2) + "pct_" + dynRisk.regime });
        entryPrices.delete(sym);
        peakPrices.delete(sym);
      }
    }
  } catch (e) {
    console.error("[trailing-stop] Check failed: " + e.message);
  }
}

// --- [P8-2] Adaptive Win-Rate Target Adjustment ---
// Adjusts effective daily target based on recent trade win rate.
const ADAPTIVE_TARGET_WINDOW = Number(process.env.ADAPTIVE_TARGET_WINDOW || 20); // last N trades
const ADAPTIVE_TARGET_BONUS_PCT = Number(process.env.ADAPTIVE_TARGET_BONUS_PCT || 0.5); // +0.5% target when hot
const ADAPTIVE_TARGET_PENALTY_PCT = Number(process.env.ADAPTIVE_TARGET_PENALTY_PCT || -0.3); // -0.3% target when cold
let adaptiveTargetOffset = 0;

// [P9-3] Recent win rate weighted toward last N fills from ring buffer
function computeRecentWinRate() {
  // First try recent fills for a more current signal
  var recentSells = recentFills.filter(function(f) { return f.side === "SELL" && f.pnl !== null; });
  // [P10-3] Apply ADAPTIVE_TARGET_WINDOW to use only the last N sells
  if (recentSells.length > ADAPTIVE_TARGET_WINDOW) {
    recentSells = recentSells.slice(recentSells.length - ADAPTIVE_TARGET_WINDOW);
  }
  if (recentSells.length >= 3) {
    var recentWins = recentSells.filter(function(f) { return f.pnl > 0; }).length;
    return recentWins / recentSells.length;
  }
  // Fallback to cumulative symbol performance if not enough recent data
  var totalWins = 0, totalTrades = 0;
  for (var perf of symbolPerformance.values()) {
    totalWins += perf.wins;
    totalTrades += perf.trades;
  }
  if (totalTrades === 0 || totalTrades < 5) return null;
  return totalWins / totalTrades;
}

function updateAdaptiveTarget() {
  var winRate = computeRecentWinRate();
  if (winRate === null) return;
  var proj = targetEngine.project();
  if (winRate >= 0.6) {
    adaptiveTargetOffset = ADAPTIVE_TARGET_BONUS_PCT;
    console.log("[adaptive-target] Win rate " + (winRate * 100).toFixed(0) + "% >= 60%. Target offset: +" + adaptiveTargetOffset + "%");
  } else if (winRate <= 0.4) {
    adaptiveTargetOffset = ADAPTIVE_TARGET_PENALTY_PCT;
    console.log("[adaptive-target] Win rate " + (winRate * 100).toFixed(0) + "% <= 40%. Target offset: " + adaptiveTargetOffset + "%");
  } else {
    adaptiveTargetOffset = 0;
  }
}

function getEffectiveTargetPct() {
  var proj = targetEngine.project();
  return proj.baseTargetPct + adaptiveTargetOffset;
}

// --- [IMPROVE #8] Backtest -> Live Feedback Loop ---
// Reads backtest-result.json and adjusts live parameters if available.
let liveParamsOverride = null;

// [P10-1] A backtest with zero trades is a COMPUTATION FAILURE, not a strategy
// verdict. Feeding it into the live risk loop is dangerous: every metric is 0,
// which satisfies "drawdown < 1%" and "winRate < 40 && sharpe < 0.5", so the
// loop concludes the strategy is safe-but-underperforming and LOOSENS risk
// (stop -2% -> -3%, take-profit 5% -> 8%) on the strength of no evidence.
const BT_MIN_TRADES = Number(process.env.BT_MIN_TRADES || 20);

function loadBacktestFeedback() {
  const btPath = path.join(__dirname, "backtest-result.json");
  try {
    if (!fs.existsSync(btPath)) return null;
    const bt = JSON.parse(fs.readFileSync(btPath, "utf8"));
    if (!bt || typeof bt.sharpe !== "number") return null;

    // [P10-1] Trust gate. Reject anything that cannot support a parameter change.
    const trades = Number(bt.trades || 0);
    if (trades < BT_MIN_TRADES) {
      console.warn(
        "[backtest-feedback] REJECTED: trades=" + trades + " < min " + BT_MIN_TRADES +
        " (sharpe=" + bt.sharpe + ", return=" + bt.totalReturnPct + "%, dd=" + bt.maxDrawdownPct + "%)." +
        " Keeping default STOP_LOSS_PCT/TAKE_PROFIT_PCT." +
        (trades === 0
          ? " NOTE: 0 trades usually means the candle input had no usable prices (open/close = 0), so backtest.js skipped every signal."
          : "")
      );
      return null;
    }
    if (bt.sharpe === 0 && bt.totalReturnPct === 0 && bt.maxDrawdownPct === 0) {
      console.warn("[backtest-feedback] REJECTED: all metrics are zero despite " + trades + " trades — input data is suspect. Keeping defaults.");
      return null;
    }

    const feedback = { loadedAt: new Date().toISOString(), sharpe: bt.sharpe, totalReturnPct: bt.totalReturnPct, maxDrawdownPct: bt.maxDrawdownPct, trades: trades };
    // Adjust stop-loss based on backtest drawdown
    if (bt.maxDrawdownPct > 3) {
      feedback.suggestedStopLossPct = -1.5; // Tighten stop
      feedback.note = "Backtest drawdown > 3%, tightening stop-loss to -1.5%";
    } else if (bt.maxDrawdownPct < 1) {
      feedback.suggestedStopLossPct = -3; // Loosen stop for more room
      feedback.note = "Backtest drawdown < 1%, loosening stop-loss to -3%";
    }
    // Adjust take-profit based on win rate
    if (bt.winRatePct < 40 && bt.sharpe < 0.5) {
      feedback.suggestedTakeProfitPct = 8; // Wider TP to let winners run
      feedback.note = (feedback.note ? feedback.note + "; " : "") + "Low win rate, widening take-profit to 8%";
    }
    console.log("[backtest-feedback] Loaded: Sharpe=" + bt.sharpe + ", Return=" + bt.totalReturnPct + "%, DD=" + bt.maxDrawdownPct + "%, trades=" + trades);
    if (feedback.note) console.log("[backtest-feedback] " + feedback.note);
    return feedback;
  } catch (e) {
    console.error("[backtest-feedback] Failed to load: " + e.message);
    return null;
  }
}

// --- [FIX #2] Portfolio Context Cache ---
// Fetches current holdings, cash balance, and open orders.
// Cached for 60 seconds to avoid excessive API calls.
let portfolioCache = null;
let portfolioCacheAt = 0;
const PORTFOLIO_CACHE_MS = 60000;

// [P5-1] Force-refresh: invalidate cache so next fetch hits the API
function invalidatePortfolioCache() {
  portfolioCacheAt = 0;
}

// [FIX] Sidecar fetch helper with timeout and error handling
async function fetchSidecar(path, options) {
  const SIDECAR_URL = process.env.SIDECAR_URL || "http://localhost:8471";
  const timeout = (options && options.timeout) || 2000;
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(SIDECAR_URL + path, {
      signal: controller.signal,
      headers: { "Accept": "application/json" }
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error("Sidecar returned " + response.status);
    }
    
    return await response.json();
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

let _portfolioFetchPromise = null;

async function fetchPortfolioContext(retryOnTokenRevoked) {
  const now = Date.now();
  if (portfolioCache && now - portfolioCacheAt < PORTFOLIO_CACHE_MS) return portfolioCache;
  // In-flight dedup: if a fetch is already in progress, share the same promise
  if (_portfolioFetchPromise) return _portfolioFetchPromise;
  _portfolioFetchPromise = _doFetchPortfolio(retryOnTokenRevoked).finally(function() { _portfolioFetchPromise = null; });
  return _portfolioFetchPromise;
}

async function _doFetchPortfolio(retryOnTokenRevoked) {
  const now = Date.now();

  // Circuit breaker: if shared auth failures exceeded limit, return stale cache immediately
  if (consecutiveAuthFailures >= MAX_CONSECUTIVE_AUTH_FAILURES) {
    console.warn("[portfolio] Circuit breaker OPEN (" + consecutiveAuthFailures + " auth failures). Returning stale cache.");
    return portfolioCache || { cashKrw: 0, cashUsd: 0, positions: [], openOrders: [], fetchedAt: null };
  }

  const maxAttempts = retryOnTokenRevoked === false ? 1 : 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const token = await fetchAccessToken(TOSS_CLIENT_ID, TOSS_CLIENT_SECRET);
      const [holdingsResp, bpResp, bpUsdResp, ordersResp] = await Promise.all([
        getHoldings(token, TOSS_ACCOUNT_SEQ),
        getBuyingPower(token, TOSS_ACCOUNT_SEQ, "KRW"),
        getBuyingPower(token, TOSS_ACCOUNT_SEQ, "USD"),
        getOrders(token, TOSS_ACCOUNT_SEQ, "OPEN"),
      ]);
      const holdings = Array.isArray(holdingsResp.body) ? holdingsResp.body : (holdingsResp.body?.items || []);
      const positions = holdings.map(function(h) {
        return {
          symbol: h.symbol || h.code || "",
          name: h.name || "",
          quantity: Number(h.quantity || 0),
          avgPrice: Number(h.averagePrice || h.avgPrice || 0),
          currentPrice: Number(h.currentPrice || h.lastPrice || h.price || 0),
          lastPrice: Number(h.lastPrice || h.currentPrice || h.price || 0),
          marketValue: Number((h.marketValue?.amount ?? h.marketValue) || 0),
          currency: h.currency || "KRW",
          profitLoss: Number((h.profitLoss?.amount ?? h.profitLoss) || 0),
          profitLossRate: Number(h.profitLoss?.rate || 0),
          profitLossPct: Number(h.profitLoss?.rate || 0) * 100,
        };
      }).filter(function(p) { return p.quantity > 0; });
      const openOrders = Array.isArray(ordersResp.body?.orders) ? ordersResp.body.orders : (Array.isArray(ordersResp.body) ? ordersResp.body : []);
      portfolioCache = {
        cashKrw: Number(bpResp.body?.cashBuyingPower || 0),
        cashUsd: Number(bpUsdResp.body?.cashBuyingPower || 0),
        positions: positions,
        openOrders: openOrders.map(function(o) {
          return { orderId: o.orderId, symbol: o.symbol, side: o.side, quantity: o.quantity, price: o.price, status: o.status };
        }),
        fetchedAt: new Date().toISOString(),
      };
      portfolioCacheAt = now;
      // Success — reset shared failure counter
      consecutiveAuthFailures = 0;
      return portfolioCache;
    } catch (e) {
      const msg = e.message || "";
      if (isAuthError(msg)) {
        consecutiveAuthFailures++;
        const backoffMs = Math.min(BASE_BACKOFF_MS * Math.pow(2, consecutiveAuthFailures - 1), MAX_BACKOFF_MS);
        // [Phase J] Report auth transient to self-healer
        try { selfHealer.reportIncident("API_TRANSIENT", { source: "portfolio", code: "auth", consecutive: consecutiveAuthFailures }); } catch {}
        console.error("[portfolio] AUTH error (" + consecutiveAuthFailures + "/" + MAX_CONSECUTIVE_AUTH_FAILURES + "): " + msg +
          ". Backing off " + Math.round(backoffMs / 1000) + "s...");
        try { resetTokenCache(); } catch {}
        invalidatePortfolioCache();
        if (consecutiveAuthFailures >= MAX_CONSECUTIVE_AUTH_FAILURES) {
          console.error("[portfolio] Circuit breaker TRIPPED. Halting portfolio fetches until auth recovers.");
          break;
        }
        // Wait before retrying
        if (attempt < maxAttempts) {
          await new Promise(function(r) { var t = setTimeout(r, backoffMs); if (t.unref) t.unref(); });
          continue;
        }
      } else {
        const isTokenRevoked = msg.indexOf("token-revoked") !== -1 || msg.indexOf("token_revoked") !== -1 || (msg.indexOf("revoked") !== -1 && msg.indexOf("token") !== -1);
        if (isTokenRevoked && attempt < maxAttempts) {
          console.warn("[portfolio] Token revoked detected (attempt " + attempt + "). Resetting token cache and retrying...");
          try { resetTokenCache(); } catch {}
          invalidatePortfolioCache();
          continue;
        }
        console.error("[portfolio] Fetch failed: " + msg);
      }
      return portfolioCache || { cashKrw: 0, cashUsd: 0, positions: [], openOrders: [], fetchedAt: null };
    }
  }
  return portfolioCache || { cashKrw: 0, cashUsd: 0, positions: [], openOrders: [], fetchedAt: null };
}

// --- [FIX #6] Candle/Indicator Context ---
// Fetches recent candles for a symbol to give AI rich technical context.
// Computes: SMA(5,20), RSI(14), MACD(12,26,9), Bollinger(20,2), ATR(14)

function computeRSI(closes, period) {
  if (closes.length < period + 1) return null;
  var gains = 0, losses = 0;
  for (var i = closes.length - period; i < closes.length; i++) {
    var diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  var avgGain = gains / period;
  var avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  var rs = avgGain / avgLoss;
  return Number((100 - 100 / (1 + rs)).toFixed(2));
}

function computeEMASeries(data, period) {
  if (data.length < period) return [];
  var k = 2 / (period + 1);
  var ema = data.slice(0, period).reduce(function(a, b) { return a + b; }, 0) / period;
  var series = [ema];
  for (var i = period; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
    series.push(ema);
  }
  return series;
}

function computeMACD(closes) {
  if (closes.length < 35) return null;
  var ema12Series = computeEMASeries(closes, 12);
  var ema26Series = computeEMASeries(closes, 26);
  if (ema12Series.length === 0 || ema26Series.length === 0) return null;
  var offset = ema12Series.length - ema26Series.length;
  var macdSeries = [];
  for (var i = 0; i < ema26Series.length; i++) {
    macdSeries.push(ema12Series[i + offset] - ema26Series[i]);
  }
  var macdLine = macdSeries[macdSeries.length - 1];
  if (macdSeries.length < 9) return { macdLine: Number(macdLine.toFixed(4)), signal: null, histogram: null };
  var signalSeries = computeEMASeries(macdSeries, 9);
  var signal = signalSeries[signalSeries.length - 1];
  return {
    macdLine: Number(macdLine.toFixed(4)),
    signal: Number(signal.toFixed(4)),
    histogram: Number((macdLine - signal).toFixed(4)),
  };
}

function computeBollingerBands(closes, period, mult) {
  if (closes.length < period) return null;
  var slice = closes.slice(-period);
  var sma = slice.reduce(function(a, b) { return a + b; }, 0) / period;
  var variance = slice.reduce(function(sum, v) { return sum + Math.pow(v - sma, 2); }, 0) / period;
  var stdDev = Math.sqrt(variance);
  return {
    upper: Number((sma + mult * stdDev).toFixed(2)),
    middle: Number(sma.toFixed(2)),
    lower: Number((sma - mult * stdDev).toFixed(2)),
  };
}

function computeATR(candles, period) {
  if (candles.length < period + 1) return null;
  var recent = candles.slice(-(period + 1));
  var atrSum = 0;
  for (var i = 1; i < recent.length; i++) {
    var high = Number(recent[i].high || recent[i].highPrice || 0);
    var low = Number(recent[i].low || recent[i].lowPrice || 0);
    var prevClose = Number(recent[i - 1].close || recent[i - 1].closePrice || 0);
    var tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    atrSum += tr;
  }
  return Number((atrSum / period).toFixed(2));
}

async function fetchCandleContext(token, symbol, interval) {
  try {
    var iv = interval || "1d";
    var cnt = iv === "1h" ? 40 : 40; // 40 hours ≈ 5 trading days for 1h; 40 days for 1d
    var resp = await getCandles(token, symbol, iv, { count: cnt });
    if (!resp || !resp.body) return null;
    var candles = Array.isArray(resp.body) ? resp.body : (resp.body.candles || []);
    if (candles.length === 0) return null;
    var closes = candles.map(function(c) { return Number(c.close || c.closePrice || 0); }).filter(function(v) { return v > 0; });
    if (closes.length === 0) return null;
    var latest = closes[closes.length - 1];
    // [Patch 2026-10-15 #6] Extract open/prevClose for gap trading
    var todayOpen = candles.length > 0 ? Number(candles[candles.length - 1].open || candles[candles.length - 1].openPrice || 0) : null;
    var prevClose = candles.length > 1 ? Number(candles[candles.length - 2].close || candles[candles.length - 2].closePrice || 0) : null;
    // SMA
    var sma5 = closes.length >= 5 ? Number((closes.slice(-5).reduce(function(a, b) { return a + b; }, 0) / 5).toFixed(2)) : null;
    var sma20 = closes.length >= 20 ? Number((closes.slice(-20).reduce(function(a, b) { return a + b; }, 0) / 20).toFixed(2)) : null;
    var changePct5d = closes.length >= 6 ? Number(((latest - closes[closes.length - 6]) / closes[closes.length - 6] * 100).toFixed(2)) : 0;
    var changePct20d = closes.length >= 21 ? Number(((latest - closes[closes.length - 21]) / closes[closes.length - 21] * 100).toFixed(2)) : null;
    // RSI
    var rsi14 = computeRSI(closes, 14);
    // MACD
    var macd = computeMACD(closes);
    // Bollinger Bands
    var bb = computeBollingerBands(closes, 20, 2);
    // ATR
    var atr14 = computeATR(candles, 14);
    // [P2-2] EMA(9, 21)
    var ema9Series = computeEMASeries(closes, 9);
    var ema21Series = computeEMASeries(closes, 21);
    var ema9 = ema9Series.length > 0 ? Number(ema9Series[ema9Series.length - 1].toFixed(2)) : null;
    var ema21 = ema21Series.length > 0 ? Number(ema21Series[ema21Series.length - 1].toFixed(2)) : null;
    // [P2-2] VWAP approximation (using typical price weighted by volume over available candles)
    var vwap = null;
    try {
      var cumVol = 0, cumTpVol = 0;
      for (var ci = 0; ci < candles.length; ci++) {
        var ch = Number(candles[ci].high || candles[ci].highPrice || 0);
        var cl = Number(candles[ci].low || candles[ci].lowPrice || 0);
        var cc = Number(candles[ci].close || candles[ci].closePrice || 0);
        var cv = Number(candles[ci].volume || candles[ci].accVolume || candles[ci].tradeVolume || 0);
        if (ch > 0 && cl > 0 && cc > 0 && cv > 0) {
          var tp = (ch + cl + cc) / 3;
          cumTpVol += tp * cv;
          cumVol += cv;
        }
      }
      if (cumVol > 0) vwap = Number((cumTpVol / cumVol).toFixed(2));
    } catch {}
    return {
      lastClose: latest,
      openPrice: todayOpen > 0 ? todayOpen : null,
      prevClose: prevClose > 0 ? prevClose : null,
      sma5: sma5,
      sma20: sma20,
      ema9: ema9,
      ema21: ema21,
      vwap: vwap,
      changePct5d: changePct5d,
      changePct20d: changePct20d,
      rsi14: rsi14,
      macd: macd,
      bollinger: bb,
      atr14: atr14,
      candleCount: candles.length,
    };
  } catch (e) {
    return null;
  }
}

async function askAI(marketData, opts) {
  const now = Date.now();
  const throttleMs = getDynamicThrottleMs();
  var bypassThrottle = opts && opts.bypassThrottle;
  if (!bypassThrottle && now - lastAiCallAt < throttleMs) return null;
  if (!bypassThrottle) lastAiCallAt = now;

  // [FIX] Fetch macro context from sidecar (8s timeout; fresh FRED/BOK/yahoo can exceed 2s, fallback to empty)
  try {
    const macroContext = await fetchSidecar("/api/v1/macro-context", { timeout: 8000 });
    if (macroContext && typeof macroContext === "object") {
      marketData.macroContext = macroContext;
      console.log("[sidecar] macro-context fetched: regime=" + (macroContext.regime || "unknown"));
    } else {
      marketData.macroContext = {};
      console.log("[sidecar] macro-context empty, using fallback");
    }
  } catch (sidecarErr) {
    console.warn("[sidecar] Failed to fetch macro context: " + (sidecarErr && sidecarErr.message));
    marketData.macroContext = {};
  }

  // [P3-3] Check AI decision cache before making LLM call
  const sym = marketData && (marketData.symbol || marketData.code);
  if (sym) {
    const cached = getCachedDecision(sym);
    if (cached) {
      aiCacheHits++;
      console.log("[ai-cache] Hit for " + sym + ": " + cached.action);
      trackHoldDecision(sym, cached);
      return cached;
    }
  }

  const projection = targetEngine.project();
  const activeMarkets = getActiveMarkets();
  const utcNow = new Date().toISOString();
  const promptLines = AI_MAX_PROFIT ? [
    "You are a dual-portfolio autonomous trading agent. Total equity is split into two buckets:",
    "  BUCKET A (max_profit): " + AI_MAX_PROFIT_PCT + "% of total equity. OBJECTIVE: MAXIMIZE ABSOLUTE RETURN. No daily target ceiling, no mechanical stop-losses, no position limits. You have full discretion over entry, exit, and sizing within this bucket.",
    "  BUCKET B (standard): " + (100 - AI_MAX_PROFIT_PCT) + "% of total equity. Target: " + projection.baseTargetPct + "% daily return. Follow conservative risk management with trailing stops and position sizing.",
    "For EVERY trade decision, you MUST declare which bucket to use via the 'strategy' field.",
    "Use 'max_profit' for high-conviction aggressive opportunities. Use 'standard' for disciplined target-based trades.",
    "Current UTC time: " + utcNow + ". Active markets: [" + (activeMarkets.join(", ") || "none - off-hours") + "].",
    "Phase: " + projection.phase + ", dryRun: " + projection.dryRun + ", halted: " + projection.halted + ".",
    "Market regime (ATR): " + currentRegime + ". HMM regime: " + (regimeHMM && regimeHMM.trained ? (function() { var lr = _hmmReturnsBuffer.length > 0 ? _hmmReturnsBuffer[_hmmReturnsBuffer.length - 1] : null; var ft = lr != null ? [lr, Math.abs(lr), lr] : null; var r = ft ? regimeHMM.filterOnline(ft) : null; return r ? r.label + " (p=" + r.prob + ")" : "unknown"; })() : "not trained") + ". Position multiplier: " + getRegimePositionMultiplier().toFixed(2) + "x.",
    "Recent win rate: " + ((computeRecentWinRate() || 0) * 100).toFixed(0) + "%.",
    "",
  ] : [
    "You are a global autonomous stock trading agent operating across all major markets.",
    "Current UTC time: " + utcNow + ". Active markets: [" + (activeMarkets.join(", ") || "none - off-hours") + "].",
    "Phase: " + projection.phase + ", dryRun: " + projection.dryRun + ", halted: " + projection.halted + ".",
    "Target: " + projection.baseTargetPct + "% daily return, max order: " + projection.maxOrderValueKrw + " KRW.",
    // [P9-1] Inject P8 adaptive metrics into AI context
    "Effective target: " + getEffectiveTargetPct().toFixed(2) + "% (adaptive offset: " + adaptiveTargetOffset.toFixed(2) + "%).",
    "Trailing stop: active at " + TRAILING_STOP_PCT + "% from peak (min profit activation: " + TRAILING_STOP_MIN_PROFIT_PCT + "%).",
    "Recent win rate: " + ((computeRecentWinRate() || 0) * 100).toFixed(0) + "%. Adjust position sizing accordingly.",
    "Market regime (ATR): " + currentRegime + ". HMM regime: " + (regimeHMM && regimeHMM.trained ? (function() { var lr = _hmmReturnsBuffer.length > 0 ? _hmmReturnsBuffer[_hmmReturnsBuffer.length - 1] : null; var ft = lr != null ? [lr, Math.abs(lr), lr] : null; var r = ft ? regimeHMM.filterOnline(ft) : null; return r ? r.label + " (p=" + r.prob + ")" : "unknown"; })() : "not trained") + ". Position multiplier: " + getRegimePositionMultiplier().toFixed(2) + "x.",
    "",
  ];
  // Inject goals template if available
  if (tradingGoals) {
    promptLines.push("=== TRADING OBJECTIVES ===");
    if (tradingGoals.global_objectives) {
      promptLines.push("Global objectives: " + tradingGoals.global_objectives.join("; "));
    }
    if (tradingGoals.market_goals) {
      for (const mkt of Object.keys(tradingGoals.market_goals)) {
        const g = tradingGoals.market_goals[mkt];
        promptLines.push(mkt + " strategy: " + (g.strategy || "N/A") + " Focus: " + (g.focus || []).join(", "));
      }
    }
    if (tradingGoals.risk_parameters) {
      promptLines.push("Risk limits: max single position " + tradingGoals.risk_parameters.max_single_position_pct + "%, max sector " + tradingGoals.risk_parameters.max_sector_exposure_pct + "%, stop loss guideline " + tradingGoals.risk_parameters.stop_loss_guideline_pct + "%");
    }
    if (tradingGoals.expansion_criteria) {
      promptLines.push("Expand watchlist when: " + (tradingGoals.expansion_criteria.add_symbol_when || []).join("; "));
    }
    promptLines.push("");
  }
  promptLines.push("Rules:");
  promptLines.push("- Trade any available instrument: Korean (KRX), US (NYSE/NASDAQ), Japanese (TSE), ETFs, indices.");
  promptLines.push("- Consider multi-currency FX rates: KRW/USD, USD/JPY, KRW/JPY for cross-border positions.");
  promptLines.push("- Factor in global macro events, overnight futures, pre/post-market sentiment, sector rotation.");
  promptLines.push("- During off-hours, prefer HOLD unless a significant overnight catalyst warrants positioning.");
  promptLines.push("- Continuously evaluate whether new symbols should be added based on expansion criteria.");
  promptLines.push("- You receive a JSON payload with: marketData (price tick), portfolio (cashKrw, cashUsd, positions, openOrders), technicals (lastClose, sma5, sma20, ema9, ema21, vwap, changePct5d, changePct20d, rsi14, macd, bollinger, atr14), orderbook (bid/ask top 3 levels, imbalance ratio), warnings (exchange alerts), recentFills (your last 5 executions), and symbolPerformance (historical PnL per symbol).");
  // [P6-3] Dynamic self-awareness instruction
  promptLines.push("- Learn from symbolPerformance: avoid BUY on symbols with repeated losses; favor symbols with positive totalPnl and high win rates.");
  promptLines.push("- intelligence (when present): macro regime (tightening/easing/expansion/contraction/crisis/neutral), sentiment label, VIX, news summary. Bias direction by regime — e.g., avoid aggressive longs in crisis/tightening.");
  promptLines.push("- similarExperiences (when present): your past decisions in similar market conditions with PnL outcomes. Replicate winning setups; avoid repeating losing patterns.");
  promptLines.push("- Use portfolio context to avoid over-concentration. Do not exceed max_single_position_pct of total equity in one symbol.");
  promptLines.push("- Use technicals to confirm signals: RSI<30=oversold(buy), RSI>70=overbought(sell), MACD histogram crossover, price vs Bollinger bands, ATR for volatility-adjusted sizing.");
  promptLines.push("- EMA crossovers: EMA9 crossing above EMA21 is bullish; below is bearish. Price above VWAP suggests intraday strength.");
  promptLines.push("- Orderbook imbalance: bidAskImbalance > 0.2 means heavy buy-side pressure (bullish); < -0.2 means sell-side pressure (bearish). Use as short-term confirmation only.");
  promptLines.push("- Warnings: If exchange warnings exist for the symbol, factor them into risk assessment before trading.");
  promptLines.push("- Prefer BUY when: RSI<35 AND price below Bollinger lower AND MACD histogram turning positive.");
  promptLines.push("- Prefer SELL when: RSI>70 OR price above Bollinger upper OR MACD histogram turning negative.");
  promptLines.push("- Active exit management: take profits at +10-15%, cut chronic losers, rebalance if single position exceeds 20% of equity.");
  promptLines.push("- When cashKrw is near zero, consider partial SELL of profitable positions to free capital for higher-conviction opportunities.");
  promptLines.push("- CRITICAL cash rules: cashKrw/cashUsd/cashJpy are SEPARATE currency pools. Use the pool matching portfolio.symbolCurrency. The payload ALREADY contains authoritative per-symbol affordability: portfolio.affordable (bool), portfolio.availableCashForSymbol (number in symbol currency), portfolio.priceNative, portfolio.maxBuyQuantity. DO NOT recompute affordability yourself and NEVER claim 'insufficient cash' contradicting portfolio.affordable. If portfolio.affordable is true, a BUY is permitted. Only treat a symbol as unaffordable when portfolio.affordable is false.");
  promptLines.push("- DEPLOYMENT RULE: portfolio.deployedPct shows how much of total equity is currently invested vs targetDeployPct. Idle cash earns ZERO toward the daily-return target. When portfolio.underDeployed is true and you see a valid momentum/trend setup, you SHOULD deploy capital (BUY) rather than hold cash. Do not let deployable cash sit idle without a specific reason.");
  promptLines.push("- DIVERSIFICATION RULE: portfolio.positionCount shows how many symbols you currently hold (target targetPositionCount). portfolio.tooConcentrated=true means returns are fragile (too few holdings or one position too large). Prefer opening NEW positions in UNHELD watchlist symbols with valid momentum setups over adding to existing positions, to broaden return sources. Still respect max_single_position_pct per symbol.");
  promptLines.push("- In high-volatility regimes (ATR > 2x average), reduce position size by 50%.");
  promptLines.push("- walkForward (when present): OOS validation verdict for evolved parameters. If verdict='reject', parameters failed out-of-sample testing — prefer conservative defaults. If verdict='deploy', evolved parameters passed OOS validation.");
  if (webTools && webTools.enabled) {
    promptLines.push("=== WEB RESEARCH TOOLS ===");
    promptLines.push("You have access to web_search(query) and web_fetch(url) tools. Use them when:");
    promptLines.push("- The payload lacks recent news or macro data you need for a confident decision.");
    promptLines.push("- You see a symbol/event in warnings or headlines but need more context.");
    promptLines.push("- Breaking news could materially affect a position you are considering.");
    promptLines.push("Do NOT call tools for routine HOLD decisions — only when additional information would change your action. After gathering information, produce your final JSON decision as usual.");
    promptLines.push("");
  }
    // [CASH-RESCUE] Held-position review context
  if (marketData && marketData._heldReview) {
    promptLines.push("=== HELD POSITION REVIEW ===");
    promptLines.push("You are reviewing a currently HELD position. Focus on EXIT analysis: SELL or HOLD?");
    promptLines.push("Do NOT recommend BUY for this symbol during this review.");
    if (marketData._cashRescueMode) {
      promptLines.push("CASH RESCUE MODE: Portfolio has near-zero KRW cash. Strongly consider SELLING profitable or underperforming positions to free capital.");
      promptLines.push("Prefer SELL if: position is profitable (lock in gains) OR chronic underperformer (cut dead weight).");
    }
    if (marketData._positionInfo) {
      promptLines.push("Position: qty=" + marketData._positionInfo.quantity + ", avgCost=" + marketData._positionInfo.avgPrice + ", currentValue=" + Math.round(marketData._positionInfo.marketValue) + " KRW, unrealizedPnl=" + marketData._positionInfo.pnlPct.toFixed(2) + "%");
    }
    promptLines.push("Respond with SELL + quantity (full or partial) if exit warranted, or HOLD with reasoning.");
  }
  promptLines.push("- Respond with valid JSON only, no markdown.");
  if (AI_MAX_PROFIT) {
    promptLines.push('- Schema: {"action":"BUY"|"SELL"|"HOLD","symbol":"string","quantity":number,"price":number,"reason":"string","strategy":"max_profit"|"standard"}.');
  } else {
    promptLines.push('- Schema: {"action":"BUY"|"SELL"|"HOLD","symbol":"string","quantity":number,"price":number,"reason":"string"}.');
  }
  promptLines.push('- To add a new symbol to the watchlist, respond: {"action":"ADD_SYMBOL","symbol":"string","reason":"string"}.');
  promptLines.push('- If halted or uncertain, respond {"action":"HOLD"}.');
  // [DUAL-PORTFOLIO] Fetch portfolio early to inject bucket budgets into AI prompt
  const portfolio = await fetchPortfolioContext();
  const totalEquity = computeTotalEquityKrw(portfolio);
  if (AI_MAX_PROFIT && totalEquity > 0) {
    const budgetA = getBucketBudget(totalEquity, "max_profit");
    const budgetB = getBucketBudget(totalEquity, "standard");
    promptLines.push("=== DUAL PORTFOLIO BUDGETS ===");
    promptLines.push("BUCKET A (max_profit) available: " + Math.round(budgetA).toLocaleString() + " KRW. Your BUY orders with strategy='max_profit' will be capped to this budget.");
    promptLines.push("BUCKET B (standard) available: " + Math.round(budgetB).toLocaleString() + " KRW. Your BUY orders with strategy='standard' follow normal position sizing rules.");
    promptLines.push("");
  }
  const systemPrompt = promptLines.join("\n");
  let candleCtx = null;
  // [P3-1] Single token fetch reused across all API calls in this decision cycle
  let tossToken = null;
  if (sym) {
    try { tossToken = await fetchAccessToken(TOSS_CLIENT_ID, TOSS_CLIENT_SECRET); } catch { /* best-effort */ }
  }
  if (sym && tossToken) {
    try {
      candleCtx = await fetchCandleContext(tossToken, sym);
      if (candleCtx) lastCandleCtx.set(sym, candleCtx); // [Phase 3.1] for ATR sizing
      // [Patch 2026-10-15 #6] Fetch 1h candles for intraday strategies
      var candleCtx1h = await fetchCandleContext(tossToken, sym, "1h");
      if (candleCtx && candleCtx1h) candleCtx.candleCtx1h = candleCtx1h;
    } catch { /* best-effort */ }
  }
  // [IMPROVE #5] Detect market regime from ATR and inject into payload
  if (candleCtx && candleCtx.atr14 && candleCtx.lastClose) {
    // [FIX] Only anchor symbols update the global regime — individual stocks have idiosyncratic ATR that causes spurious flips
    var _isAnchor = REGIME_ANCHOR_SYMBOLS.indexOf(sym) !== -1;
    if (_isAnchor) {
      detectRegime(candleCtx.atr14, candleCtx.lastClose);
    }
    // [Phase G] Feed close into HMM returns buffer + maybe retrain
    _hmmPushReturn(sym, candleCtx.lastClose);
    _hmmMaybeRetrain();
    // [Phase J] Feed regime into self-healer for REGIME_MISMATCH detection
    try { selfHealer.tick({ currentRegime: currentRegime }); } catch {}
  }
  // [P2-1] Fetch orderbook for bid/ask imbalance
  let orderbookCtx = null;
  if (sym && tossToken) {
    try {
      const obResp = await getOrderbook(tossToken, sym);
      if (obResp && obResp.body) {
        const ob = obResp.body;
        const bids = Array.isArray(ob.bids) ? ob.bids.slice(0, 3) : [];
        const asks = Array.isArray(ob.asks) ? ob.asks.slice(0, 3) : [];
        const totalBidVol = bids.reduce(function(s, b) { return s + Number(b.volume || b.qty || b.quantity || 0); }, 0);
        const totalAskVol = asks.reduce(function(s, a) { return s + Number(a.volume || a.qty || a.quantity || 0); }, 0);
        const totalVol = totalBidVol + totalAskVol;
        const imbalance = totalVol > 0 ? Number(((totalBidVol - totalAskVol) / totalVol).toFixed(4)) : 0;
        orderbookCtx = {
          topBids: bids.map(function(b) { return { price: Number(b.price || 0), volume: Number(b.volume || b.qty || b.quantity || 0) }; }),
          topAsks: asks.map(function(a) { return { price: Number(a.price || 0), volume: Number(a.volume || a.qty || a.quantity || 0) }; }),
          bidAskImbalance: imbalance,
        };
        // [Phase J] Compute spread in bps and feed to self-healer for LIQUIDITY_SHOCK detection
        try {
          var _bestBid = bids.length > 0 ? Number(bids[0].price || 0) : 0;
          var _bestAsk = asks.length > 0 ? Number(asks[0].price || 0) : 0;
          if (_bestBid > 0 && _bestAsk > 0) {
            var _mid = (_bestBid + _bestAsk) / 2;
            var _spreadBps = ((_bestAsk - _bestBid) / _mid) * 10000;
            orderbookCtx.spreadBps = Number(_spreadBps.toFixed(2));
            selfHealer.tick({ spreadBps: orderbookCtx.spreadBps });
          }
        } catch {}
      }
    } catch { /* best-effort */ }
  }
  // [P2-3] Fetch stock warnings for news/event context
  let warningsCtx = null;
  if (sym && tossToken) {
    try {
      const wResp = await getStockWarnings(tossToken, sym);
      if (wResp && wResp.body) {
        const wBody = wResp.body;
        const warnings = Array.isArray(wBody) ? wBody : (Array.isArray(wBody.warnings) ? wBody.warnings : []);
        if (warnings.length > 0) {
          warningsCtx = warnings.map(function(w) { return typeof w === "string" ? w : (w.message || w.description || JSON.stringify(w)); }).slice(0, 5);
        }
      }
    } catch { /* best-effort */ }
  }
  // [Phase A / L4.5] Intelligence pipeline + memory recall (best-effort, never blocks)
  let intelligenceCtx = null;
  let memoryCtx = null;
  if (sym) {
    try {
      intelligenceCtx = await intelligence.gather(sym, callAI);
    } catch (e) { console.error("[intel] gather failed for " + sym + ": " + e.message); }
    try {
      memoryCtx = tradingMemory.recallSimilar({
        symbol: sym,
        rsi14: candleCtx ? candleCtx.rsi14 : null,
        macd: candleCtx ? candleCtx.macd : null,
        regime: currentRegime,
        lastClose: candleCtx ? candleCtx.lastClose : null,
      }, 3);
    } catch (e) { console.error("[memory] recall failed for " + sym + ": " + e.message); }
  }

  // [P4-1] Portfolio data freshness
  var dataAgeSec = null;
  if (portfolio.fetchedAt) {
    try { dataAgeSec = Math.round((Date.now() - new Date(portfolio.fetchedAt).getTime()) / 1000); } catch {}
  }
  // [Patch 2026-10-15] Pre-compute per-symbol affordability in the CORRECT currency.
  // Prevents the AI from wrongly using cashKrw for US symbols. Injected as authoritative.
  var _symMarket = (typeof detectMarket === "function" ? detectMarket(sym) : (marketData.market || "US"));
  var _isUS = (_symMarket === "US");
  var _isJP = (_symMarket === "JP");
  var _availCash = _isUS ? Number(portfolio.cashUsd || 0)
              : _isJP ? Number(portfolio.cashJpy || 0)
              : Number(portfolio.cashKrw || 0);
  var _priceNative = Number(marketData.price || (candleCtx && candleCtx.lastClose) || 0);
  var _affordable = _priceNative > 0 && _availCash >= _priceNative;
  var _maxQty = (_priceNative > 0 && _availCash > 0) ? Math.floor(_availCash / _priceNative) : 0;
  // [Patch 2026-10-15 #1] Portfolio deployment ratio (how much capital is actually invested).
  // Cash sitting idle earns nothing toward the daily-return target.
  var _totalEquity = (typeof computeTotalEquityKrw === "function") ? computeTotalEquityKrw(portfolio) : 0;
  var _cashKrwEq = Number(portfolio.cashKrw || 0)
    + Number(portfolio.cashUsd || 0) * (cachedFxRates.FX_USD_KRW || 1350)
    + Number(portfolio.cashJpy || 0) * (cachedFxRates.FX_JPY_KRW || 9);
  var _investedKrw = Math.max(0, _totalEquity - _cashKrwEq);
  var _deployedPct = _totalEquity > 0 ? (_investedKrw / _totalEquity) * 100 : 0;
  var _targetDeployPct = Number(process.env.TARGET_DEPLOY_PCT || 70);
  var _underDeployed = _deployedPct < _targetDeployPct;
  // [Patch 2026-10-15 #2] Position concentration: count & per-symbol weight of holdings.
  // Few concentrated holdings = fragile return stream. Encourage breadth.
  var _posList = Array.isArray(portfolio.positions) ? portfolio.positions : [];
  var _posCount = 0;
  var _maxPosPct = 0;
  var _heldSymbols = [];
  for (var _pi = 0; _pi < _posList.length; _pi++) {
    var _pp = _posList[_pi];
    if (!_pp || !(_pp.quantity > 0)) continue;
    var _mv = Number(_pp.marketValue || 0);
    if (_pp.currency && _pp.currency !== "KRW") {
      var _fx = cachedFxRates["FX_" + _pp.currency + "_KRW"] || 1;
      _mv = _mv * _fx;
    }
    if (_mv > 0) {
      _posCount++;
      _heldSymbols.push(String(_pp.symbol || _pp.code || "?"));
      var _wpct = _totalEquity > 0 ? (_mv / _totalEquity) * 100 : 0;
      if (_wpct > _maxPosPct) _maxPosPct = _wpct;
    }
  }
  var _targetPosCount = Number(process.env.TARGET_POSITION_COUNT || 6);
  var _maxSinglePct = Number(process.env.MAX_SINGLE_POSITION_PCT_ENV || 15);
  var _tooConcentrated = (_posCount > 0 && _posCount < _targetPosCount) || _maxPosPct > _maxSinglePct;


  const userPayload = {
    marketData: marketData,
    portfolio: {
      cashKrw: portfolio.cashKrw,
      cashUsd: (portfolio.cashUsd != null ? portfolio.cashUsd : 0),
      cashJpy: (portfolio.cashJpy != null ? portfolio.cashJpy : 0),
      // [Patch 2026-10-15] Authoritative affordability (do NOT recompute; trust these)
      symbolMarket: _symMarket,
      symbolCurrency: (_isUS ? "USD" : _isJP ? "JPY" : "KRW"),
      availableCashForSymbol: _availCash,
      priceNative: _priceNative,
      affordable: _affordable,
      maxBuyQuantity: _maxQty,
      // [Patch 2026-10-15 #1] Deployment state
      totalEquityKrw: Math.round(_totalEquity),
      investedKrw: Math.round(_investedKrw),
      deployedPct: Number(_deployedPct.toFixed(1)),
      targetDeployPct: _targetDeployPct,
      underDeployed: _underDeployed,
      // [Patch 2026-10-15 #2] Diversification state
      positionCount: _posCount,
      targetPositionCount: _targetPosCount,
      maxSinglePositionPct: Number(_maxPosPct.toFixed(1)),
      heldSymbols: _heldSymbols,
      tooConcentrated: _tooConcentrated,
      positions: portfolio.positions,
      openOrders: portfolio.openOrders,
      dataAgeSec: dataAgeSec,
    },
    technicals: candleCtx,
    orderbook: orderbookCtx,
    warnings: warningsCtx,
    regime: currentRegime,
    regimeMultiplier: getRegimePositionMultiplier(),
    // [Phase G] HMM regime state (trained on rolling returns)
    regimeHMM: (function() {
      if (!regimeHMM || !regimeHMM.trained) return { trained: false };
      try {
        const lastRet = _hmmReturnsBuffer.length > 0 ? _hmmReturnsBuffer[_hmmReturnsBuffer.length - 1] : null;
        const feats = lastRet != null ? [lastRet, Math.abs(lastRet), lastRet] : null;
        const f = feats ? regimeHMM.filterOnline(feats) : null;
        return {
          trained: true,
          observations: _hmmReturnsBuffer.length,
          label: f ? f.label : "unknown",
          prob: f ? f.prob : 0,
          probs: f ? f.probs : [],
          multiplier: regimeHMM.getPositionMultiplier(feats),
          history: regimeHMM.history.slice(-3),
        };
      } catch (e) {
        return { trained: true, error: e.message };
      }
    })(),
    // [Phase H] Walk-forward validation state (OOS backtesting of evolved params)
    walkForward: (function() {
      if (!walkForwardValidator || !walkForwardLastResult) return { enabled: WALK_FORWARD_ENABLED, validated: false };
      var r = walkForwardLastResult;
      return {
        enabled: true,
        validated: true,
        verdict: r.verdict,
        reason: r.reason || null,
        summary: r.summary || null,
        totalValidations: walkForwardValidator.stats().totalValidations,
        lastRun: walkForwardValidator.getHistory().length > 0
          ? walkForwardValidator.getHistory()[walkForwardValidator.getHistory().length - 1].ts
          : null,
      };
    })(),
    recentFills: recentFills.slice(-5),
    // [P6-1] Symbol performance summary so AI learns from past outcomes
    symbolPerformance: buildSymbolPerformanceSummary(sym),
    // [P9-1] P8 adaptive metrics in user payload for structured AI consumption
    adaptiveTarget: { effectivePct: getEffectiveTargetPct(), offset: adaptiveTargetOffset },
    trailingStop: { active: true, triggerPct: TRAILING_STOP_PCT, minProfitPct: TRAILING_STOP_MIN_PROFIT_PCT },
    recentWinRate: computeRecentWinRate(),
    // [Phase A / L4.5] Intelligence + memory context for L4.5 cognition
    intelligence: intelligenceCtx ? {
      regime: intelligenceCtx.macro ? intelligenceCtx.macro.regime : null,
      sentiment: intelligenceCtx.sentiment ? intelligenceCtx.sentiment.label : null,
      bullBearRatio: intelligenceCtx.sentiment ? intelligenceCtx.sentiment.bullBearRatio : null,
      newsSummary: intelligenceCtx.news ? intelligenceCtx.news.summary : null,
      topHeadlines: intelligenceCtx.news ? intelligenceCtx.news.topHeadlines : null,
      fedFundsRate: intelligenceCtx.macro ? intelligenceCtx.macro.fedFundsRate : null,
      vix: intelligenceCtx.macro ? intelligenceCtx.macro.vix : null,
      gatherMs: intelligenceCtx.gatherMs,
    } : null,
    similarExperiences: memoryCtx && memoryCtx.length > 0 ? memoryCtx.map(function(m) {
      return { symbol: m.symbol, action: m.action, regime: m.regime, pnl: m.pnl, outcome: m.outcome, similarityScore: m.similarityScore, ts: m.ts };
    }) : null,
    // [DUAL-PORTFOLIO] Inject bucket budgets into structured payload
    ...(AI_MAX_PROFIT ? {
      dualPortfolio: {
        enabled: true,
        maxProfitPct: AI_MAX_PROFIT_PCT,
        standardPct: 100 - AI_MAX_PROFIT_PCT,
        maxProfitBudgetKrw: Math.round(getBucketBudget(totalEquity, "max_profit")),
        standardBudgetKrw: Math.round(getBucketBudget(totalEquity, "standard")),
        totalEquityKrw: Math.round(totalEquity),
      },
    } : {}),
  };
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: JSON.stringify(userPayload) },
  ];

  // [FIX #8] Multi-provider fallback. With web-tools enabled, use agentic loop
  // so the AI can invoke web_search/web_fetch before producing its final decision.
  const aiT0 = Date.now();
  let result;
  if (webTools && webTools.enabled) {
    result = await callAIWithTools(
      messages,
      webTools.getSchemas(),
      function(n, a) { return webTools.handle(n, a); },
      Number(process.env.WEB_TOOLS_MAX_ROUNDS || 3)
    );
    // callAIWithTools handles metrics, counters, and selfAudit internally
  } else {
    result = await callAI(messages);
    metrics.observe("ai_latency_ms", Date.now() - aiT0);
    metrics.counter(result ? "ai_success" : "ai_failure");
    if (result) selfAudit.recordAiCall();
  }
  // [Phase 2.2] AI-down fallback: conservative rule-based decision
  // [P0-2] Now supports whitelisted BUY with reduced sizing
  if (!result && sym && candleCtx) {
    var fbPos = null;
    for (var p of (portfolio.positions || [])) {
      if (String(p.symbol).toUpperCase() === String(sym).toUpperCase() && Number(p.quantity) > 0) {
        fbPos = { avgPrice: Number(p.avgPrice) || entryPrices.get(sym) || 0, qty: Number(p.quantity) };
        break;
      }
    }
    var fb = fallbackDecision(candleCtx, fbPos, { symbol: sym });
    if (fb) {
      fb.symbol = sym;
      result = fb;
      console.warn("[fallback] AI down — rule-based " + fb.action + " for " + sym + ": " + fb.reason);
      journalEntry({ type: "AI_FALLBACK_DECISION", symbol: sym, action: fb.action, reason: fb.reason, scaled: fb.scaled });
      metrics.counter("ai_fallback_decisions");
      audit.fallback({ symbol: sym, action: fb.action, reason: fb.reason, providerCount: aiProviderList.length });
      // [self-audit] Track fallback usage for Layer 1 ai_fallback_frequent rule
      try { selfAudit.recordFallback(); } catch {}
    }
  }
  // [P3-3] Cache actionable decisions
  if (result && sym) {
    setCachedDecision(sym, result);
    // [P4-2] Track HOLD streaks for proactive exploration
    trackHoldDecision(sym, result);
  }
  // [Phase B / L4.5] Attach council context to BUY/SELL decisions for downstream validation.
  // Best-effort: never throws, never blocks. Council gate in executeDecision wrapper.
  if (result && (result.action === "BUY" || result.action === "SELL")) {
    try {
      var _expoPct = 0;
      if (totalEquity > 0 && portfolio.positions && portfolio.positions.length > 0) {
        var _invested = portfolio.positions.reduce(function(s, p) { return s + (p.marketValue || 0); }, 0);
        _expoPct = (_invested / totalEquity) * 100;
      }
      result._councilCtx = {
        technicals: candleCtx,
        intelligence: intelligenceCtx ? {
          regime: intelligenceCtx.macro ? intelligenceCtx.macro.regime : null,
          vix: intelligenceCtx.macro ? intelligenceCtx.macro.vix : null,
          sentiment: intelligenceCtx.sentiment ? intelligenceCtx.sentiment.label : null,
        } : null,
        similarExperiences: memoryCtx && memoryCtx.length > 0 ? memoryCtx.map(function(m) {
          return { symbol: m.symbol, action: m.action, regime: m.regime, pnl: m.pnl, outcome: m.outcome };
        }) : null,
        regime: currentRegime,
        totalEquity: totalEquity,
        currentExposurePct: _expoPct,
        openPositions: portfolio.positions ? portfolio.positions.length : 0,
      };
      // [Phase I / L4.5] Attach meta-cognition inputs to decision for downstream scoring
      result._metaCogIntel = intelligenceCtx || null;
      result._metaCogMemory = memoryCtx && memoryCtx.length > 0 ? memoryCtx : null;
      // Council result will be populated after council.evaluate() — use prior decision's consensus as prior
      result._metaCogCouncil = null;
    } catch (e) { console.error("[council] ctx attach failed: " + e.message); }
  }
  return result;
}

// --- [P0-3] Multi-Provider LLM Router (replaces inline callAI) ---
// Builds provider list from minitok.yml, primary first, with circuit breaker
// and health tracking via src/ai/provider-router.
const aiProviderList = [];
if (minitokConfig.providers) {
  for (const [pname, pcfg] of Object.entries(minitokConfig.providers)) {
    const pKey = process.env[pcfg.api_key_env || "PROFUNDO_API_KEY"] || (pname === providerName ? apiKey : "");
    const pUrl = pcfg.base_url;
    const pModel = pcfg.model || minitokConfig.model || "gpt-6-astra";
    if (pKey && pUrl) aiProviderList.push({ name: pname, key: pKey, baseUrl: pUrl, model: pModel });
  }
}
// Fallback: if minitok.yml had no providers section, use the resolved primary
if (aiProviderList.length === 0 && apiKey && baseUrl) {
  aiProviderList.push({ name: providerName, key: apiKey, baseUrl: baseUrl, model: aiModel });
}
// Ensure primary provider sorts first
aiProviderList.sort(function(a, b) { return (a.name === providerName ? -1 : 0) - (b.name === providerName ? -1 : 0); });

const aiRouter = createProviderRouter({ providers: aiProviderList });
audit.config({
  key: "ai_router",
  oldValue: null,
  newValue: aiProviderList.map(function(p) { return p.name + "(" + p.model + ")"; }).join(","),
  source: "runner",
});
console.log("[ai-router] Initialized " + aiProviderList.length + " provider(s): " +
  aiProviderList.map(function(p) { return p.name; }).join(", "));

// Thin wrapper preserving legacy counter interface used elsewhere in runner.js
async function callAI(messages) {
  var parsed = await aiRouter.call(messages);
  if (parsed) {
    aiSuccesses++;
    aiConsecutiveFailures = 0;
    return parsed;
  }
  aiFailures++;
  aiConsecutiveFailures++;
  // [Phase J] Report LLM degradation to self-healer
  try {
    var _llmErrPct = (aiSuccesses + aiFailures) > 0 ? aiFailures / (aiSuccesses + aiFailures) : 0;
    selfHealer.reportIncident("LLM_DEGRADATION", { parseErrorPct: _llmErrPct, consecutive: aiConsecutiveFailures });
  } catch {}
  if (aiConsecutiveFailures >= AI_CONSECUTIVE_FAIL_THRESHOLD) {
    console.warn("[ai-fallback] " + aiConsecutiveFailures + " consecutive AI failures (total: " +
      aiFailures + "/" + (aiSuccesses + aiFailures) + "). REST polling will serve as backup.");
    audit.error({ source: "ai-router", code: "consecutive_failures",
      message: aiConsecutiveFailures + " consecutive failures, circuit breakers active" });
    // [self-audit] Snapshot peak consecutive count before reset for Layer 1 rule
    try { selfAudit.updateAiConsecutiveFailures(aiConsecutiveFailures); } catch {}
    aiConsecutiveFailures = 0;
  } else {
    try { selfAudit.updateAiConsecutiveFailures(aiConsecutiveFailures); } catch {}
  }
  return null;
}

// --- [P-WebTools] Agentic AI call with function-calling loop ---
// Supports multi-round tool use: AI can call web_search/web_fetch, receive results,
// then produce its final JSON decision. Max rounds bounded to control latency.
async function callAIWithTools(messages, tools, toolHandler, maxRounds) {
  maxRounds = Math.max(1, Math.min(10, Number(maxRounds) || 3));
  var workingMessages = messages.slice();
  var aiT0 = Date.now();
  var toolCallsTotal = 0;
  for (var round = 0; round < maxRounds; round++) {
    var raw = await aiRouter.callRaw(workingMessages, { tools: tools && tools.length > 0 ? tools : null });
    if (!raw || !raw.message) {
      aiFailures++;
      aiConsecutiveFailures++;
      metrics.counter("ai_failure");
      try {
        var _ePct = (aiSuccesses + aiFailures) > 0 ? aiFailures / (aiSuccesses + aiFailures) : 0;
        selfHealer.reportIncident("LLM_DEGRADATION", { parseErrorPct: _ePct, consecutive: aiConsecutiveFailures });
      } catch {}
      if (aiConsecutiveFailures >= AI_CONSECUTIVE_FAIL_THRESHOLD) {
        console.warn("[ai-fallback] " + aiConsecutiveFailures + " consecutive AI failures");
        try { selfAudit.updateAiConsecutiveFailures(aiConsecutiveFailures); } catch {}
        aiConsecutiveFailures = 0;
      } else {
        try { selfAudit.updateAiConsecutiveFailures(aiConsecutiveFailures); } catch {}
      }
      return null;
    }
    var msg = raw.message;
    if (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      workingMessages.push({
        role: "assistant",
        content: msg.content || null,
        tool_calls: msg.tool_calls,
      });
      for (var ti = 0; ti < msg.tool_calls.length; ti++) {
        var tc = msg.tool_calls[ti];
        var toolResult;
        try {
          var tArgs = typeof tc.function.arguments === "string"
            ? JSON.parse(tc.function.arguments || "{}")
            : (tc.function.arguments || {});
          toolResult = await toolHandler(tc.function.name, tArgs);
          toolCallsTotal++;
          metrics.counter("ai_tool_call_" + tc.function.name);
        } catch (e) {
          toolResult = { error: "tool execution failed: " + (e.message || String(e)) };
        }
        workingMessages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult),
        });
      }
      continue;
    }
    // Final text response — extract JSON decision
    var text = (msg.content || "").trim();
    metrics.observe("ai_latency_ms", Date.now() - aiT0);
    if (!text) {
      aiFailures++;
      aiConsecutiveFailures++;
      metrics.counter("ai_failure");
      return null;
    }
    var parsed = aiRouter.extractJson(text);
    if (!parsed) {
      aiFailures++;
      aiConsecutiveFailures++;
      metrics.counter("ai_failure");
      console.warn("[ai-tools] JSON parse failed after " + round + " tool rounds: " + text.slice(0, 100));
      return null;
    }
    aiSuccesses++;
    aiConsecutiveFailures = 0;
    metrics.counter("ai_success");
    if (toolCallsTotal > 0) metrics.observe("ai_tool_calls_per_decision", toolCallsTotal);
    selfAudit.recordAiCall();
    return parsed;
  }
  console.warn("[ai-tools] max rounds (" + maxRounds + ") exceeded, returning null");
  aiFailures++;
  aiConsecutiveFailures++;
  return null;
}

// --- [FIX #9] Circuit Breaker / Price Limit Check ---
// Skips BUY if symbol is at/near its daily price limit (circuit breaker).
async function checkPriceLimit(symbol, side) {
  if (side !== "BUY") return true;
  try {
    const token = await fetchAccessToken(TOSS_CLIENT_ID, TOSS_CLIENT_SECRET);
    const resp = await getPriceLimits(token, symbol);
    if (!resp || !resp.body) return true;
    const upper = Number(resp.body.upperLimitPrice || 0);
    const current = Number(resp.body.currentPrice || resp.body.closePrice || 0);
    if (upper > 0 && current > 0 && current >= upper * 0.98) {
      console.log("[circuit-breaker] " + symbol + " at/near upper limit (" + current + "/" + upper + "). Skipping BUY.");
      return false;
    }
    return true;
  } catch { return true; }
}

// --- [FIX #9b] FX Rate Monitor ---
let lastFxRate = null;
let fxAlertSent = false;
// [P7-1] Cross-asset FX guard state
let usdKrwChangePct = 0;
let crossAssetGuardTriggers = 0;
// [Tier 2] 1.5% → 3.0%: USD/KRW 1.5% 변동은 일상. 진짜 충격(3%+)만 guard.
const CROSS_ASSET_GUARD_THRESHOLD = Number(process.env.CROSS_ASSET_GUARD_THRESHOLD || 3.0); // 3.0% move triggers guard

function isCrossAssetBuyBlocked(symbol) {
  var s = String(symbol).toUpperCase();
  var isKR = /^\d{6}$/.test(s);
  var isJP = /^\d{4}$/.test(s);
  // If USD/KRW spiked up (KRW weakening), block new KR buys to avoid currency drag
  if (isKR && usdKrwChangePct > CROSS_ASSET_GUARD_THRESHOLD) {
    crossAssetGuardTriggers++;
    console.log("[cross-asset-guard] Blocked BUY " + symbol + ": USD/KRW up " + usdKrwChangePct.toFixed(2) + "% (KRW weakening)");
    return true;
  }
  // If USD/KRW dropped sharply (KRW strengthening), block new JP buys (JPY typically inverse-correlated)
  if (isJP && usdKrwChangePct < -CROSS_ASSET_GUARD_THRESHOLD) {
    crossAssetGuardTriggers++;
    console.log("[cross-asset-guard] Blocked BUY " + symbol + ": USD/KRW down " + usdKrwChangePct.toFixed(2) + "% (KRW strengthening, JPY risk)");
    return true;
  }
  return false;
}

async function checkFxRisk() {
  try {
    const token = await fetchAccessToken(TOSS_CLIENT_ID, TOSS_CLIENT_SECRET);
    const resp = await getExchangeRate(token, "USD", "KRW");
    // Toss wraps FX response in {result:{rate:"..."}}
    const rate = Number(resp.body?.result?.rate ?? resp.body?.rate ?? 0);
    if (rate <= 0) return;
    if (lastFxRate === null) { lastFxRate = rate; return; }
    const changePct = ((rate - lastFxRate) / lastFxRate) * 100;
    // [P7-1] Track rolling FX change for cross-asset guard
    usdKrwChangePct = changePct;
    if (Math.abs(changePct) > 2 && !fxAlertSent) {
      sendTelegramAlert("⚠️ *FX Risk Alert*\nUSD/KRW changed " + changePct.toFixed(2) + "% (now " + rate + ").\nConsider reducing cross-border exposure.");
      fxAlertSent = true;
    }
    if (Math.abs(changePct) < 1) fxAlertSent = false;
    lastFxRate = rate;
  } catch { /* best-effort */ }
}

// --- [FIX #7] Trade Journal ---
const journalPath = path.join(__dirname, "trade-journal.json");
let tradeJournal = [];
try {
  if (fs.existsSync(journalPath)) tradeJournal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
} catch (e) {
  // [DEEP-DEBUG FIX] Log journal load failure — corrupted trade journal
  // means historical trade data is lost silently.
  console.error("[journal] Failed to load trade-journal.json: " + (e && e.message ? e.message : String(e)));
  tradeJournal = [];
}

function journalEntry(entry) {
  tradeJournal.push({ ...entry, timestamp: new Date().toISOString() });
  // Keep last 500 entries
  if (tradeJournal.length > 500) tradeJournal = tradeJournal.slice(-500);
  try {
    fs.writeFileSync(journalPath, JSON.stringify(tradeJournal, null, 2), "utf8");
  } catch (e) {
    // [DEEP-DEBUG FIX] Journal write failure means trade records may be lost
    // on restart. The event store mirror below provides some redundancy,
    // but the JSON journal is the primary human-readable record.
    console.error("[journal] Failed to write trade-journal.json: " + (e && e.message ? e.message : String(e)));
  }
  // [Phase 1.4] Mirror to durable event store
  eventStore.append("JOURNAL", entry);
}

// --- [FIX #7b] Daily Report ---
function sendDailyReport() {
  const today = new Date().toISOString().slice(0, 10);
  const todayTrades = tradeJournal.filter(function(e) { return e.timestamp && e.timestamp.startsWith(today) && e.type === "TRADE_EXECUTED"; });
  const buys = todayTrades.filter(function(e) { return e.action === "BUY"; }).length;
  const sells = todayTrades.filter(function(e) { return e.action === "SELL"; }).length;
  const errors = todayTrades.filter(function(e) { return !e.ok; }).length;
  const proj = targetEngine.project();
  // [IMPROVE #6] Slippage summary
  const avgSlippage = slippageStats.count > 0 ? (slippageStats.totalPct / slippageStats.count).toFixed(4) : "N/A";
  // [IMPROVE #7] Symbol performance summary
  const worstSymbols = getWorstSymbols(3, 3);
  const worstStr = worstSymbols.length > 0 ? worstSymbols.map(function(w) { return w.symbol + "(" + w.totalPnl.toFixed(0) + ")"; }).join(", ") : "N/A";
  // [P6-2] Best performing symbols
  const bestSymbols = getBestSymbols(3, 3);
  const bestStr = bestSymbols.length > 0 ? bestSymbols.map(function(b) { return b.symbol + "(" + b.totalPnl.toFixed(0) + ")"; }).join(", ") : "N/A";
  const msg = [
    "📊 *Daily Report* (" + today + ")",
    "Phase: " + proj.phase + ", Halted: " + proj.halted,
    "Trades: " + todayTrades.length + " (BUY:" + buys + " SELL:" + sells + " ERR:" + errors + ")",
    "Daily traded value: " + (tools._safety && tools._safety.getDailyTradedValue ? tools._safety.getDailyTradedValue() : 0) + " KRW",
    "Pending orders: " + pendingOrders.size,
    "High-water equity: " + (proj.highWaterEquity || "N/A") + " KRW",
    "Regime: " + currentRegime + " (mult: " + getRegimePositionMultiplier() + "x)",
    "Slippage: avg=" + avgSlippage + "%, max=" + slippageStats.maxSlippagePct.toFixed(4) + "% (" + slippageStats.worstSymbol + "), n=" + slippageStats.count,
    "Top symbols: " + bestStr,
    "Worst symbols: " + worstStr,
    "AI cache hits: " + aiCacheHits + ", Slippage offsets: " + slippageOffsetApplied + ", Hold evictions: " + holdEvictedAt.size,
    "Cross-asset guards: " + crossAssetGuardTriggers,
    "Trailing stops: " + trailingStopTriggers + ", Win rate: " + ((computeRecentWinRate() || 0) * 100).toFixed(0) + "%, Eff. target: " + getEffectiveTargetPct().toFixed(2) + "%",
  ].join("\n");
  console.log("[daily-report] " + msg.replace(/\n/g, " | "));
  sendTelegramAlert(msg);
  journalEntry({ type: "DAILY_REPORT", buys: buys, sells: sells, errors: errors, pending: pendingOrders.size, aiCacheHits: aiCacheHits, slippageOffsets: slippageOffsetApplied, holdEvictions: holdEvictedAt.size, topSymbols: bestStr, worstSymbols: worstStr, crossAssetGuards: crossAssetGuardTriggers, trailingStops: trailingStopTriggers, winRate: computeRecentWinRate(), effectiveTarget: getEffectiveTargetPct() });
}

// --- [FIX #4] Order Monitoring ---
const ORDER_MONITOR_TIMEOUT_MS = Number(process.env.ORDER_MONITOR_TIMEOUT_MS || 180000); // 3 min default
const ORDER_MONITOR_POLL_MS = Number(process.env.ORDER_MONITOR_POLL_MS || 30000); // 30s
const pendingOrders = new Map(); // orderId -> { symbol, side, price, quantity, createdAt }

// [P0-FIX] Removed dead orderManager instance. The pendingOrders Map and
// monitorPendingOrders() loop handle the full order lifecycle. The orderManager
// was instantiated but never polled, causing redundant memory usage.

async function monitorPendingOrders() {
  const now = Date.now();
  for (const [orderId, info] of pendingOrders.entries()) {
    if (now - info.createdAt > ORDER_MONITOR_TIMEOUT_MS) {
      // Timeout: cancel the order
      console.log("[order-monitor] Order " + orderId + " unfilled after " + Math.round(ORDER_MONITOR_TIMEOUT_MS / 60000) + "min. Cancelling...");
      try {
        await tools.cancel({ operation: "cancel_order", target: { accountSeq: TOSS_ACCOUNT_SEQ }, orderId });
        console.log("[order-monitor] Cancelled order " + orderId);
      } catch (e) {
        console.error("[order-monitor] Cancel failed: " + e.message);
      }
      pendingOrders.delete(orderId);
      continue;
    }
    // Poll status
    try {
      const token = await fetchAccessToken(TOSS_CLIENT_ID, TOSS_CLIENT_SECRET);
      const resp = await getOrder(token, TOSS_ACCOUNT_SEQ, orderId);
      const status = resp.body?.status || "";
      // [P1-1] Partial fill tracking
      if (status === "PARTIALLY_FILLED") {
        const filledQty = Number(resp.body.filledQuantity || resp.body.executedQuantity || 0);
        const remainingQty = Number(resp.body.remainingQuantity || (info.quantity - filledQty));
        if (filledQty > 0 && !info.partialLogged) {
          console.log("[order-monitor] Order " + orderId + " PARTIALLY FILLED: " + filledQty + "/" + info.quantity + " (remaining: " + remainingQty + ")");
          info.partialLogged = true;
          info.filledQuantity = filledQty;
        }
        // Update tracked quantity to remaining so timeout/slippage calculations stay accurate
        info.quantity = remainingQty > 0 ? remainingQty : info.quantity;
        continue;
      }
      if (status === "FILLED" || status === "COMPLETED") {
        console.log("[order-monitor] Order " + orderId + " FILLED.");
        // [IMPROVE #6] Record slippage: compare expected vs actual fill price
        const fillPrice = Number(resp.body.filledPrice || resp.body.avgFilledPrice || resp.body.price || 0);
        if (fillPrice > 0 && info.price > 0) {
          recordSlippage(info.symbol, info.side, info.price, fillPrice);
        }
        // [IMPROVE #7] Record entry price on BUY fill for accurate P&L tracking
        if (info.side === "BUY" && fillPrice > 0) {
          entryPrices.set(info.symbol, fillPrice);
          peakPrices.delete(info.symbol); // [P10-2a] Reset peak for new entry
        }
        // [P10-1] Compute SELL P&L BEFORE entryPrices.delete() so it can be passed to recordRecentFill
        var sellPnl = null;
        // [IMPROVE #7] Record SELL outcome for symbol performance tracking
        if (info.side === "SELL" && fillPrice > 0) {
          // [P2-10 FIX] Robust entry price resolution. Order of preference:
          //   1. entryPrices (in-memory, set on BUY fill this session)
          //   2. Broker avgPrice from portfolio cache (survives restarts)
          //   3. info.price (order price — last resort, may ≈ fillPrice → grossPnl≈0)
          var entryPrice = entryPrices.get(info.symbol);
          var entryPriceSource = "memory";
          if (!entryPrice || entryPrice <= 0) {
            try {
              var _pc = portfolioCache;
              if (_pc && Array.isArray(_pc.positions)) {
                var _hit = _pc.positions.find(function(p) {
                  return String(p.symbol).toUpperCase() === String(info.symbol).toUpperCase();
                });
                if (_hit && _hit.avgPrice > 0) {
                  entryPrice = _hit.avgPrice;
                  entryPriceSource = "broker_avg";
                }
              }
            } catch (_e) { /* ignore cache lookup failure */ }
          }
          if (!entryPrice || entryPrice <= 0) {
            // [P10-2] No reliable entry price anywhere. Do NOT invent a P&L by
            // reusing the order price: entry ≈ exit makes grossPnl ≈ 0 and the
            // whole loss shows up as costs (observed as pnlPct=-0.5028 on BRK.B/SPY).
            // Those fabricated losses then poison symbol performance, the kill-switch
            // and the AI's own history. Report pnl:null so consumers treat it as
            // unknown rather than as a real loss.
            entryPrice = info.price;
            entryPriceSource = "order_price";
            sellPnl = null;
            console.warn("[pnl] " + info.symbol + " SELL: no entry price in memory or broker cache — P&L SUPPRESSED (pnl=null). Would have fallen back to order price " + info.price + " and reported a false loss.");
            try {
              eventStore.append("PNL_SUPPRESSED", {
                symbol: info.symbol,
                reason: "no_entry_price",
                fillPrice: fillPrice,
                orderPrice: info.price,
                quantity: info.quantity,
                strategy: info._strategy || "standard",
                decisionSource: info._decisionSource || "ai",
              });
            } catch { /* event store best-effort */ }
            // [P2 Fix] Record suppressed P&L in performance metrics with a null marker
            // so the trade is not lost from attribution, performance tracking, or kill-switch.
            try { recordSymbolOutcome(info.symbol, 0, true); } catch {}
            try { perfMonitor.recordTrade({ symbol: info.symbol, side: "SELL", pnl: 0, suppressed: true }); } catch {}
            try { degradationDetector.recordTrade({ pnl: 0, symbol: info.symbol, strategy: info._strategy || null }); } catch {}
            try { attributionEngine.recordFill({
              symbol: info.symbol,
              strategy: info._strategy || "base_signals",
              source: info._decisionSource || "ai",
              metaCogIntervened: metaCogDecisionMap.has(String(info.symbol).toUpperCase()),
              pnl: null,
            }); } catch {}
            entryPrices.delete(info.symbol);
            peakPrices.delete(info.symbol);
            atrStopPrices.delete(info.symbol);
          } else {
            console.log("[pnl] " + info.symbol + " SELL entry=" + entryPrice + " exit=" + fillPrice + " src=" + entryPriceSource);
          }
          // [Phase 1.1] Net P&L with commission + tax + FX
          // [P10-2] Skipped entirely when P&L was suppressed — see above.
          if (sellPnl !== null) {
            var market = detectMarket(info.symbol);
            // [P6 Fix] Use cachedFxRates (same as computeTotalEquityKrw) for consistency
            // between trade P&L and portfolio equity valuation. Live getExchangeRate
            // would cause the two calculations to diverge within the same cycle.
            var fxRate = 1;
            if (market === "US") {
              fxRate = cachedFxRates.FX_USD_KRW || 1350;
            } else if (market === "JP") {
              fxRate = cachedFxRates.FX_JPY_KRW || 9;
            }
            var pnlBreakdown = computeRoundTripPnl({ symbol: info.symbol, entryPrice, exitPrice: fillPrice, quantity: info.quantity, fxRate, fxRateEntry: fxRate, fxRateExit: fxRate, market, strategy: info._strategy || "standard" });
            sellPnl = pnlBreakdown.netPnl;
            recordSymbolOutcome(info.symbol, sellPnl);
          }
          // [P1-4 Integration] Record round-trip outcome for knowledge store self-improvement
          if (sellPnl !== null) {
            try {
              knowledgeStore.recordOutcome({
                symbol: info.symbol,
                action: "SELL",
                strategy: pnlBreakdown.strategy || null,
                score: 0,
                pnl: sellPnl,
                reason: "round_trip_close",
              });
            } catch (e) { console.error("[knowledge] recordOutcome failed: " + e.message); }
            // [P1-5 Integration] Record trade in performance monitor
            try { perfMonitor.recordTrade({ symbol: info.symbol, side: "SELL", pnl: sellPnl }); } catch {}
            // [Phase R-6] Feed trade into degradation detector for auto-upgrade cycle
            try { degradationDetector.recordTrade({ pnl: sellPnl, symbol: info.symbol, strategy: pnlBreakdown.strategy || null }); } catch {}
            metrics.observe("trade_pnl_krw", sellPnl);
          }
          entryPrices.delete(info.symbol); // Clear after close
          peakPrices.delete(info.symbol); // [P10-2b] Clear trailing stop peak
          atrStopPrices.delete(info.symbol); // [Phase 3.3] Clear ATR hard stop
          // [Phase I / L4.5] Meta-cognition: attach SELL outcome to original BUY decision
          if (sellPnl !== null) {
            try {
              var _mcSym = String(info.symbol).toUpperCase();
              var _mcEntry = metaCogDecisionMap.get(_mcSym);
              if (_mcEntry && _mcEntry.decisionId) {
                metaCognition.attachOutcome(_mcEntry.decisionId, { pnl: sellPnl, holdBars: null });
                console.log("[meta-cog] Attached outcome to " + _mcEntry.decisionId + " pnl=" + sellPnl);
                metaCogDecisionMap.delete(_mcSym);
              }
            } catch (e) { console.error("[meta-cog] attachOutcome failed: " + e.message); }
          }
          // [Phase 1.4] Persist fill event with full cost breakdown
          // [P2-10] Attach entryPriceSource so sentinel can flag unreliable P&L
          if (sellPnl !== null) {
            // [FIX] 상대 임계: gross가 비용의 1% 미만이면 suspicious
            var _suspicious = (Math.abs(pnlBreakdown.grossPnl) < Math.max(0.01, pnlBreakdown.totalCosts * 0.01) && pnlBreakdown.totalCosts > 0);
            eventStore.append("FILL", {
              symbol: info.symbol, side: "SELL", fillPrice, quantity: info.quantity,
              entryPrice: entryPrice, entryPriceSource: entryPriceSource,
              suspicious: _suspicious || undefined,
              ...pnlBreakdown,
            });
          } else {
            // [P10-2] Fill is real; only the P&L is unknown. Keep the record but
            // mark it explicitly instead of writing a fabricated loss.
            eventStore.append("FILL", {
              symbol: info.symbol, side: "SELL", fillPrice, quantity: info.quantity,
              entryPrice: entryPrice, entryPriceSource: entryPriceSource,
              pnlUnknown: true,
            });
          }
          metrics.counter("orders_filled");
        } else if (info.side === "BUY" && fillPrice > 0) {
          eventStore.append("FILL", { symbol: info.symbol, side: "BUY", fillPrice, quantity: info.quantity });
          metrics.counter("orders_filled");
        }
        pendingOrders.delete(orderId);
        // [P5-1] Invalidate portfolio cache after fill so next AI decision sees updated positions/cash
        invalidatePortfolioCache();
        // [P5-2] Record fill for AI context (pass pre-computed P&L to avoid stale entryPrices lookup)
        recordRecentFill(info.symbol, info.side, fillPrice, info.quantity, sellPnl);
        // [Phase E] Record fill in strategy orchestrator for performance tracking
        try {
          const orchStrategy = info._strategy || "base_signals";
          strategyOrchestrator.recordFill(orchStrategy, {
            symbol: info.symbol, side: info.side, pnl: info.side === "SELL" ? sellPnl : null,
          });
        } catch (e) { /* best-effort */ }
        // [Phase R / L4.5] Emit fill signal for Reflection Engine
        try {
          signalCollector.recordFill({
            symbol: info.symbol, side: info.side, price: fillPrice,
            quantity: info.quantity, pnl: info.side === "SELL" ? sellPnl : null,
          });
        } catch { /* best-effort */ }
        // [Phase R-3] Record fill for attribution analysis
        try {
          if (attributionEngine && info.side === "SELL") {
            var _mcIntervened = metaCogDecisionMap.has(String(info.symbol).toUpperCase());
            attributionEngine.recordFill({
              symbol: info.symbol,
              strategy: info._strategy || "base_signals",
              source: info._decisionSource || "ai",
              metaCogIntervened: _mcIntervened,
              pnl: sellPnl,
            });
          }
        } catch { /* best-effort */ }
        // [FIX #5] Register stop-loss conditional order after BUY fill
        if (info.side === "BUY") {
          await registerStopLoss(info);
        }
      } else if (status === "CANCELED" || status === "REJECTED") {
        console.log("[order-monitor] Order " + orderId + " " + status);
        pendingOrders.delete(orderId);
      }
    } catch (e) { console.error("[order-monitor] Poll error for " + orderId + ": " + (e.message || e)); }
  }
}

// [P5-3] Dynamic order monitor loop: polls faster when more orders are pending
const ORDER_MONITOR_FAST_MS = Number(process.env.ORDER_MONITOR_FAST_MS || 10000); // 10s when busy
let monitorTimer = null;

function scheduleMonitorLoop() {
  if (monitorTimer) clearTimeout(monitorTimer);
  const interval = pendingOrders.size > 2 ? ORDER_MONITOR_FAST_MS : ORDER_MONITOR_POLL_MS;
  monitorTimer = setTimeout(function() {
    monitorPendingOrders().catch(function() {});
    scheduleMonitorLoop();
  }, interval);
  if (monitorTimer.unref) monitorTimer.unref();
}
scheduleMonitorLoop();

// --- [FIX #5] Stop-Loss / Take-Profit via Conditional Orders ---
// [IMPROVE #8] Changed to let so backtest feedback can adjust at runtime
let STOP_LOSS_PCT = Number(process.env.STOP_LOSS_PCT || -2); // -2% default
let TAKE_PROFIT_PCT = Number(process.env.TAKE_PROFIT_PCT || 5); // +5% default

// [IMPROVE #4] Stop-loss registration with retry + verification
const SL_MAX_RETRIES = Number(process.env.SL_MAX_RETRIES || 3);
const SL_RETRY_DELAY_MS = Number(process.env.SL_RETRY_DELAY_MS || 2000);

async function registerStopLoss(orderInfo) {
  // [Phase 3.3] Register ATR hard stop alongside conditional order
  if (orderInfo.atr) registerAtrStop(orderInfo.symbol, orderInfo.price, orderInfo.atr);
  const stopPrice = Math.round(orderInfo.price * (1 + STOP_LOSS_PCT / 100));
  const tpPrice = Math.round(orderInfo.price * (1 + TAKE_PROFIT_PCT / 100));
  // [FIX-SL-SCHEMA] Match broker-verified conditional order schema (from live OPEN orders)
  const slBody = {
    symbol: orderInfo.symbol,
    type: "SINGLE",
    quantity: orderInfo.quantity,
    orderType: "LIMIT",
    expireDate: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
    first: {
      type: "STOP",
      orderSide: "SELL",
      triggerPrice: stopPrice,
      orderPrice: stopPrice,
    },
  };
  console.log("[stop-loss] Request body for " + orderInfo.symbol + ": " + JSON.stringify(slBody));

  for (let attempt = 1; attempt <= SL_MAX_RETRIES; attempt++) {
    try {
      const token = await fetchAccessToken(TOSS_CLIENT_ID, TOSS_CLIENT_SECRET);
      const resp = await createConditionalOrder(token, TOSS_ACCOUNT_SEQ, slBody);
      // Verify response
      if (resp && resp.body && (resp.body.orderId || resp.body.id)) {
        const orderId = resp.body.orderId || resp.body.id;
        console.log("[stop-loss] Registered SL for " + orderInfo.symbol + " @ " + stopPrice + " (orderId=" + orderId + ", attempt " + attempt + ")");
        journalEntry({ type: "STOP_LOSS_REGISTERED", symbol: orderInfo.symbol, stopPrice, tpPrice, orderId, attempt });
        return { ok: true, orderId };
      }
      // Response received but no orderId — treat as potential success but log warning
      console.log("[stop-loss] SL response for " + orderInfo.symbol + " missing orderId (attempt " + attempt + "). Response: " + JSON.stringify(resp.body).slice(0, 200));
      journalEntry({ type: "STOP_LOSS_REGISTERED", symbol: orderInfo.symbol, stopPrice, tpPrice, verified: false, attempt });
      return { ok: true, orderId: null };
    } catch (e) {
      console.error("[stop-loss] Attempt " + attempt + "/" + SL_MAX_RETRIES + " failed for " + orderInfo.symbol + ": " + e.message);
      if (attempt < SL_MAX_RETRIES) {
        await new Promise(function(r) { var t = setTimeout(r, SL_RETRY_DELAY_MS * attempt); if (t.unref) t.unref(); });
      }
    }
  }
  // All retries exhausted
  console.error("[stop-loss] FAILED all " + SL_MAX_RETRIES + " attempts for " + orderInfo.symbol + ". Position UNPROTECTED.");
  journalEntry({ type: "STOP_LOSS_FAILED", symbol: orderInfo.symbol, stopPrice, tpPrice, retries: SL_MAX_RETRIES });
  sendTelegramAlert("⚠️ *Stop-Loss Registration Failed*\nSymbol: " + orderInfo.symbol + "\nAttempts: " + SL_MAX_RETRIES + "\nPosition is UNPROTECTED. Manual action required.");
  return { ok: false };
}

// --- 5. Decision executor ---
// [IMPROVE #1] Position sizing enforcement based on goals.json risk_parameters
const MAX_SINGLE_POSITION_PCT = (tradingGoals && tradingGoals.risk_parameters && tradingGoals.risk_parameters.max_single_position_pct) || 15;

function computeTotalEquityKrw(portfolio) {
  let total = Number(portfolio.cashKrw || 0)
    + Number(portfolio.cashUsd || 0) * (cachedFxRates.FX_USD_KRW || 1350)
    + Number(portfolio.cashJpy || 0) * (cachedFxRates.FX_JPY_KRW || 9);
  for (const p of (portfolio.positions || [])) {
    var mv = p.marketValue || 0;
    // Apply FX conversion if position currency is not KRW
    if (p.currency && p.currency !== "KRW") {
      var fxKey = "FX_" + p.currency + "_KRW";
      var fxRate = (typeof globalThis !== "undefined" && globalThis[fxKey]) || cachedFxRates[fxKey] || 1;
      mv = mv * fxRate;
    }
    total += mv;
  }
  return total;
}

// --- [P1-3] Sector Exposure Enforcement ---
// Builds reverse index: symbol -> set of sectors from goals.json sector_mapping
const SECTOR_MAX_PCT = (tradingGoals && tradingGoals.risk_parameters && tradingGoals.risk_parameters.max_sector_exposure_pct) || 40;
const symbolToSectors = new Map();
if (tradingGoals && tradingGoals.sector_mapping) {
  for (const [sector, symbols] of Object.entries(tradingGoals.sector_mapping)) {
    for (const sym of symbols) {
      var key = String(sym).toUpperCase();
      if (!symbolToSectors.has(key)) symbolToSectors.set(key, new Set());
      symbolToSectors.get(key).add(sector);
    }
  }
}

function checkSectorExposure(newSymbol, orderValue, totalEquity, positions) {
  if (!symbolToSectors.size || totalEquity <= 0) return { ok: true };
  var sym = String(newSymbol).toUpperCase();
  var newSectors = symbolToSectors.get(sym);
  if (!newSectors || newSectors.size === 0) return { ok: true };
  // For each sector the new symbol belongs to, sum existing position values in same sector
  for (var sector of newSectors) {
    var sectorValue = orderValue; // include the proposed new order
    for (var pos of positions) {
      var posSym = String(pos.symbol).toUpperCase();
      var posSectors = symbolToSectors.get(posSym);
      if (posSectors && posSectors.has(sector)) {
        sectorValue += (pos.marketValue || 0);
      }
    }
    var sectorPct = (sectorValue / totalEquity) * 100;
    if (sectorPct > SECTOR_MAX_PCT) {
      return { ok: false, reason: "Sector '" + sector + "' exposure would be " + sectorPct.toFixed(1) + "% (max: " + SECTOR_MAX_PCT + "%)" };
    }
  }
  return { ok: true };
}

async function enforcePositionSizing(input, strategy) {
  // [DUAL-PORTFOLIO] max_profit bucket skips mechanical sizing but enforces bucket budget
  if (strategy === "max_profit") {
    try {
      const portfolio = await fetchPortfolioContext();
      const totalEquity = computeTotalEquityKrw(portfolio);
      const budget = getBucketBudget(totalEquity, "max_profit");
      const orderValue = input.price * input.quantity;
      if (budget > 0 && orderValue > budget) {
        const maxQty = Math.floor(budget / input.price);
        if (maxQty <= 0) return { ok: false, reason: "max_profit bucket budget exhausted (budget=" + Math.round(budget) + " KRW)" };
        console.log("[dual-portfolio] max_profit budget cap: " + input.quantity + " -> " + maxQty + " (budget " + Math.round(budget) + " KRW)");
        input.quantity = maxQty;
      }
    } catch {}
    return { ok: true };
  }
  // [P0-1] UNRESTRICTED_MODE removed — all orders follow risk management rules
  if (input.side !== "BUY") return { ok: true };
  try {
    const portfolio = await fetchPortfolioContext();
    const totalEquity = computeTotalEquityKrw(portfolio);
    if (totalEquity <= 0) return { ok: true }; // Cannot determine, allow

    // [Phase 3.1] ATR-based position sizing (replaces AI-chosen quantity)
    const candleCtx = lastCandleCtx ? lastCandleCtx.get(input.symbol) : null;
    const atr = candleCtx && candleCtx.atr14 ? candleCtx.atr14 : null;
    const market = detectMarket(input.symbol);
    let fxRate = 1;
    if (market !== "KR") {
      try {
        const fxResp = await getExchangeRate(await fetchAccessToken(TOSS_CLIENT_ID, TOSS_CLIENT_SECRET), market === "US" ? "USD" : "JPY", "KRW");
        // Toss wraps FX response in {result:{rate:"..."}}
        fxRate = Number((fxResp.body && (fxResp.body.result && fxResp.body.result.rate ? fxResp.body.result.rate : fxResp.body.rate))) || 1;
      } catch {}
    }
    // [Phase E] Scale position size by orchestrator weight for the active strategy
    const orchWeight = (function() {
      try {
        const strat = input._strategy || "base_signals";
        const w = strategyOrchestrator.getWeight(strat);
        return w > 0 ? w : 1.0;
      } catch { return 1.0; }
    })();
    const orchScaledEquity = totalEquity * orchWeight;
    const sizing = positionSizer.sizePosition({ equity: orchScaledEquity, price: input.price, atr, fxRate });
    if (sizing.qty === 0) return { ok: false, reason: "positionSizer: " + sizing.reason };
    if (sizing.qty !== input.quantity) {
      console.log("[position-sizing] ATR sized " + input.symbol + ": " + input.quantity + " -> " + sizing.qty + " (" + sizing.reason + ")" + (orchWeight < 1.0 ? " [orch=" + (orchWeight * 100).toFixed(0) + "%%]" : ""));
      input.quantity = sizing.qty;
      input.atr = atr; // pass to orderInfo for hard stop registration
    }

    // [Phase 3.2] Exposure / concentration check
    const expo = exposure.checkExposure({
      symbol: input.symbol, orderValueKrw: sizing.valueKrw, equity: totalEquity,
      positions: portfolio.positions || [],
      strategy: candleCtx && candleCtx.strategyHint ? candleCtx.strategyHint : null,
    });
    if (!expo.ok) {
      return { ok: false, reason: "exposure: " + expo.violations.join("; ") };
    }

    // [Phase F] VaR risk budget gate — block if adding position would exceed VaR budget
    try {
      const _rbPositions = (portfolio.positions || []).filter(function(p) {
        return (Number(p.qty || p.quantity || 0)) > 0;
      });
      if (_rbPositions.length > 0) {
        const _rbVols = _rbPositions.map(function() { return 0.02; }); // default 2% daily vol
        const _rbCov = portfolioRisk.buildDiagonalCov(_rbVols);
        const _rbProposed = { symbol: input.symbol, qty: input.quantity, currentPrice: input.price };
        const _rbResult = portfolioRisk.checkRiskBudget(_rbPositions, _rbCov, _rbProposed, totalEquity);
        if (!_rbResult.ok) {
          console.log("[risk-budget] BLOCKED " + input.symbol + ": " + _rbResult.breach);
          return { ok: false, reason: "risk-budget: " + _rbResult.breach };
        }
      }
    } catch (e) { /* best-effort: don't block on risk calc failure */ }

    const orderValue = input.price * input.quantity;
    const positionPct = (orderValue / totalEquity) * 100;
    // [IMPROVE #5] Always apply regime-based position multiplier
    const regimeMult = getRegimePositionMultiplier();
    const effectiveMaxPct = MAX_SINGLE_POSITION_PCT * regimeMult;
    // [P1-3] Sector exposure check before single-position check
    const sectorCheck = checkSectorExposure(input.symbol, orderValue, totalEquity, portfolio.positions || []);
    if (!sectorCheck.ok) {
      return { ok: false, reason: sectorCheck.reason };
    }
    if (positionPct > effectiveMaxPct) {
      // Reduce quantity to fit within effective limit
      const maxValue = totalEquity * (effectiveMaxPct / 100);
      const maxQty = Math.floor(maxValue / input.price);
      if (maxQty <= 0) {
        return { ok: false, reason: "Order value " + orderValue + " KRW exceeds effective " + effectiveMaxPct.toFixed(1) + "% of equity (" + Math.round(totalEquity) + " KRW). Min qty would be 0." };
      }
      console.log("[position-sizing] Reduced qty from " + input.quantity + " to " + maxQty + " (" + positionPct.toFixed(1) + "% > " + effectiveMaxPct.toFixed(1) + "% effective limit, regime=" + currentRegime + ")");
      input.quantity = maxQty;
      return { ok: true, adjusted: true };
    }
    return { ok: true };
  } catch { return { ok: true }; }
}

// --- [P3-2] Slippage-Based Dynamic Price Offset ---
// Adjusts LIMIT order price slightly based on historical slippage to improve fill rate.
function applySlippageOffset(side, requestedPrice) {
  if (slippageStats.count < 5 || !requestedPrice || requestedPrice <= 0) return requestedPrice;
  var avgSlip = slippageStats.totalPct / slippageStats.count;
  // For BUY: if avg slippage is positive (we paid more), nudge limit up slightly
  // For SELL: if avg slippage is negative (we sold lower), nudge limit down slightly
  var offsetPct = 0;
  if (side === "BUY" && avgSlip > 0.05) {
    offsetPct = Math.min(avgSlip * 0.3, 0.5); // Cap at 0.5% adjustment, use 30% of observed slippage
  } else if (side === "SELL" && avgSlip > 0.05) {
    offsetPct = -Math.min(avgSlip * 0.3, 0.5);
  }
  if (offsetPct === 0) return requestedPrice;
  var adjusted = Math.round(requestedPrice * (1 + offsetPct / 100));
  if (adjusted !== requestedPrice) {
    slippageOffsetApplied++;
    console.log("[slippage-offset] " + side + " price adjusted: " + requestedPrice + " -> " + adjusted + " (offset=" + offsetPct.toFixed(3) + "%, avgSlip=" + avgSlip.toFixed(4) + "%)");
  }
  return adjusted;
}

// --- [P0-FIX] Exchange tick size normalization ---
// Prevents invalid-price rejections caused by prices that do not align with
// exchange-specific tick size rules. Conservative rounding only; price limits
// and marketability are still handled by API/safety checks.
function normalizeTickPrice(symbol, price) {
  var p = Number(price);
  if (!isFinite(p) || p <= 0) return p;
  var market = detectMarket(symbol);
  if (market === "KR") {
    var tick;
    if (p < 2000) tick = 1;
    else if (p < 5000) tick = 5;
    else if (p < 20000) tick = 10;
    else if (p < 50000) tick = 50;
    else if (p < 200000) tick = 100;
    else if (p < 500000) tick = 500;
    else tick = 1000;
    var rounded = Math.round(p / tick) * tick;
    return Math.max(tick, rounded);
  }
  if (market === "US") {
    return Number(p.toFixed(2));
  }
  if (market === "JP") {
    return Math.max(1, Math.round(p));
  }
  return p;
}

// --- [P7-2] Concurrency Guard: prevent duplicate in-flight orders for same symbol ---
const inFlightSymbols = new Set();
// [CASH-RESCUE] Track symbols with queued off-hours SELL orders to prevent duplicates
const pendingOffHoursSells = new Set();
const PENDING_SELLS_PATH = "/app/state/pending_offhours_sells.json";
// Restore pending off-hours sells from disk (survives restarts)
try {
  if (require("fs").existsSync(PENDING_SELLS_PATH)) {
    const _restored = JSON.parse(require("fs").readFileSync(PENDING_SELLS_PATH, "utf8"));
    if (Array.isArray(_restored)) {
      _restored.forEach(function(s) { pendingOffHoursSells.add(String(s).toUpperCase()); });
      console.log("[state] Restored " + pendingOffHoursSells.size + " pending off-hours sells: " + Array.from(pendingOffHoursSells).join(", "));
    }
  }
} catch (_re) { console.warn("[state] Failed to restore pending sells: " + _re.message); }
function _savePendingSells() {
  try {
    require("fs").mkdirSync(require("path").dirname(PENDING_SELLS_PATH), { recursive: true });
    require("fs").writeFileSync(PENDING_SELLS_PATH, JSON.stringify(Array.from(pendingOffHoursSells)));
  } catch (_se) { /* best-effort */ }
}

async function executeDecision(decision) {
  if (!decision || decision.action === "HOLD" || !decision.symbol) return;
  var sym = String(decision.symbol).toUpperCase();
  // [self-audit] Record actionable decision for Layer 1 hold-dominant / activity metrics
  try { selfAudit.recordDecision(decision.action); } catch {}
  // [Phase R / L4.5] Emit decision signal for Reflection Engine
  try {
    signalCollector.recordDecision({
      symbol: sym, action: decision.action, reason: decision.reason || null,
      confidence: decision.confidence != null ? decision.confidence : null,
      strategy: decision.strategy || null,
    });
  } catch {}
  // [Phase R-3] Record decision for attribution analysis
  try {
    if (attributionEngine) {
      attributionEngine.recordDecision({
        symbol: sym,
        strategy: decision.strategy || "base_signals",
        source: decision._decisionSource || "ai",
        action: decision.action,
      });
    }
  } catch { /* best-effort */ }
  if (inFlightSymbols.has(sym)) {
    console.log("[exec] Skipped: " + sym + " already has an in-flight order");
    return;
  }
  inFlightSymbols.add(sym);
  try {
    await _executeDecisionInner(decision, sym);
  } catch (e) {
    // [self-audit] Unexpected execution exception
    try { selfAudit.recordExecutionError(); } catch {}
    console.error("[exec] Exception for " + sym + ": " + (e && e.message));
    throw e;
  } finally {
    inFlightSymbols.delete(sym);
  }
}

async function _executeDecisionInner(decision, sym) {
  // [FIX-EXEC-ERR] Verify pending sell against broker before blocking
  if (decision.action === "SELL" && pendingOffHoursSells.has(sym)) {
    try {
      var _chkToken = await fetchAccessToken(TOSS_CLIENT_ID, TOSS_CLIENT_SECRET);
      var _openOrders = await getOrders(_chkToken, TOSS_ACCOUNT_SEQ, "OPEN");
      var _hasOpenSell = false;
      if (_openOrders && _openOrders.body) {
        var _orders = Array.isArray(_openOrders.body) ? _openOrders.body : (_openOrders.body.orders || []);
        for (var _o of _orders) {
          if ((_o.symbol || _o.ticker) === sym && String(_o.side || _o.type || "").toUpperCase().includes("SELL")) {
            _hasOpenSell = true;
            break;
          }
        }
      }
      if (!_hasOpenSell) {
        pendingOffHoursSells.delete(sym);
        _savePendingSells();
        console.log("[exec-info] Cleared stale pending SELL for " + sym + " (not found in broker open orders)");
      } else {
        console.log("[exec-info] Skipped duplicate SELL " + sym + ": confirmed active pending order at broker");
        return { ok: true, skipped: true, reason: "pending_sell_exists" };
      }
    } catch (_chkE) {
      console.log("[exec-info] Pending check failed for " + sym + ", proceeding: " + _chkE.message);
    }
  }
  // Market hours guard: prevent execution when the symbol's market is closed
  const activeMarkets = getActiveMarkets();
  const symbolMarket = detectMarket(sym);
  if (symbolMarket && !activeMarkets.includes(symbolMarket)) {
    // [CASH-RESCUE] Allow SELL orders to queue as LIMIT during off-hours
    // Toss accepts LIMIT orders outside market hours and executes them at next open
    if (decision.action === "SELL") {
      // Force LIMIT order type for off-hours SELL (MARKET would be rejected)
      if (decision.orderType !== "LIMIT" && !decision.price) {
        // Use last known price as LIMIT price if not specified
        try {
          var _offToken = await fetchAccessToken(TOSS_CLIENT_ID, TOSS_CLIENT_SECRET);
          var _offP = await getPrices(_offToken, [sym]);
          var _offArr = Array.isArray(_offP.body) ? _offP.body : [_offP.body];
          if (_offArr.length > 0 && _offArr[0]) {
            var _offLast = Number(_offArr[0].lastPrice || _offArr[0].price || 0);
            if (_offLast > 0) decision.price = _offLast;
          }
        } catch (_offE) { /* best-effort */ }
      }
      if (decision.price && decision.price > 0) {
        console.log("[exec] Off-hours SELL " + sym + ": queuing as LIMIT @ " + decision.price + " (" + symbolMarket + " closed)");
      } else {
        console.log("[exec] Blocked SELL " + sym + ": " + symbolMarket + " market is closed and no LIMIT price available");
        return;
      }
    } else if (decision.action === "BUY") {
      // [Patch 2026-10-15] Allow off-hours BUY to queue as LIMIT (same as SELL path).
      // Toss accepts LIMIT orders outside market hours and executes them at next open.
      // This enables pre-market / advance buy orders the user requested.
      if (decision.orderType !== "LIMIT" && !decision.price) {
        try {
          var _obToken = await fetchAccessToken(TOSS_CLIENT_ID, TOSS_CLIENT_SECRET);
          var _obP = await getPrices(_obToken, [sym]);
          var _obArr = Array.isArray(_obP.body) ? _obP.body : [_obP.body];
          if (_obArr.length > 0 && _obArr[0]) {
            var _obLast = Number(_obArr[0].lastPrice || _obArr[0].price || 0);
            if (_obLast > 0) decision.price = _obLast;
          }
        } catch (_obE) { /* best-effort */ }
      }
      if (decision.price && decision.price > 0) {
        decision.orderType = "LIMIT";
        console.log("[exec] Off-hours BUY " + sym + ": queuing as LIMIT @ " + decision.price + " (" + symbolMarket + " closed)");
      } else {
        console.log("[exec] Blocked BUY " + sym + ": " + symbolMarket + " market is closed and no LIMIT price available");
        return;
      }
    } else {
      console.log("[exec] Blocked " + decision.action + " " + sym + ": " + symbolMarket + " market is closed");
      return;
    }
  }

  // [P0-2 Integration] Event guard: block or reduce BUY during macro events
  if (decision.action === "BUY") {
    var evCheck = eventGuard.check(new Date());
    if (evCheck.active) {
      if (evCheck.blockNewBuys) {
        console.log("[event-guard] Blocked BUY " + sym + ": " + evCheck.reason);
        journalEntry({ type: "EVENT_GUARD_BLOCKED", symbol: sym, event: evCheck.event ? evCheck.event.name : null });
        audit.custom("event_guard_block", { symbol: sym, event: evCheck.event ? evCheck.event.name : null, reason: evCheck.reason });
        return;
      }
      if (evCheck.sizeMultiplier < 1.0 && decision.quantity) {
        var evReducedQty = Math.max(1, Math.floor(Number(decision.quantity) * evCheck.sizeMultiplier));
        if (evReducedQty < Number(decision.quantity)) {
          console.log("[event-guard] Reduced BUY " + sym + " qty: " + decision.quantity + " -> " + evReducedQty + " (" + evCheck.reason + ")");
          decision.quantity = evReducedQty;
        }
      }
    }

    // [P0-3 Integration] Correlation check: prevent sector/factor concentration
    try {
      var corrPortfolio = await fetchPortfolioContext();
      var corrResult = checkCorrelation({ symbol: sym, positions: corrPortfolio.positions || [] });
      if (!corrResult.ok) {
        console.warn("[correlation] Blocked BUY " + sym + ": " + corrResult.reason);
        journalEntry({ type: "CORRELATION_BLOCKED", symbol: sym, maxCorrelation: corrResult.maxCorrelation, reason: corrResult.reason });
        audit.custom("correlation_block", { symbol: sym, maxCorrelation: corrResult.maxCorrelation, reason: corrResult.reason });
        return;
      }
      if (corrResult.sizeMultiplier < 1.0 && decision.quantity) {
        var corrAdj = adjustForCorrelation(Number(decision.quantity), corrResult);
        if (corrAdj.adjusted) {
          console.log("[correlation] Reduced BUY " + sym + " qty: " + decision.quantity + " -> " + corrAdj.qty + " (" + corrAdj.reason + ")");
          decision.quantity = corrAdj.qty;
        }
      }
    } catch (e) {
      console.error("[correlation] Check failed for " + sym + ": " + e.message);
    }
  }

  var rawPrice = Number(decision.price);
  // [P3-2] Apply slippage-based price offset
  var adjustedPrice = applySlippageOffset(decision.action, rawPrice);
  // [P0-FIX] Normalize to exchange tick size to avoid invalid-price rejections
  adjustedPrice = normalizeTickPrice(sym, adjustedPrice);

  // [P2-7 Integration] Select account for this order via multi-account manager
  var orderAccountSeq = TOSS_ACCOUNT_SEQ; // default fallback
  if (multiAccountMgr && decision.action === "BUY") {
    var orderValueEstimate = adjustedPrice * (Number(decision.quantity) || 1);
    var selectedAcct = multiAccountMgr.selectAccount(orderValueEstimate);
    if (selectedAcct) {
      orderAccountSeq = selectedAcct.clientSeq;
      // Record the trade allocation after successful execution (below)
    } else {
      console.warn("[multi-account] All accounts at daily limit. Falling back to primary account.");
    }
  }

  const input = {
    operation: "create_order", target: { accountSeq: orderAccountSeq },
    symbol: decision.symbol, side: decision.action, orderType: "LIMIT",
    quantity: Number(decision.quantity) || 1, price: adjustedPrice,
    // [P3-4 Fix] Propagate strategy + decision source through order lifecycle
    // so the fill handler can attribute P&L correctly via attributionEngine.
    _strategy: decision.strategy || "standard",
    _decisionSource: decision._decisionSource || decision.source || "ai",
  };
  if (!input.price || input.price <= 0) { console.log("[exec] Skipped: invalid price"); return; }

  // [P7-1] Cross-asset FX guard before BUY
  if (input.side === "BUY" && isCrossAssetBuyBlocked(input.symbol)) {
    console.log("[exec] Skipped: cross-asset FX guard blocked BUY for " + input.symbol);
    return;
  }

  // [FIX #9] Circuit breaker check before BUY
  if (input.side === "BUY") {
    const allowed = await checkPriceLimit(input.symbol, input.side);
    if (!allowed) { console.log("[exec] Skipped: circuit breaker active for " + input.symbol); return; }
  }

  // [Phase J / L4.5] Self-healing liquidity shock guard before BUY
  if (input.side === "BUY" && selfHealer.isMitigated("LIQUIDITY_SHOCK")) {
    console.log("[exec] Skipped: self-healer LIQUIDITY_SHOCK mitigation active for " + input.symbol);
    journalEntry({ type: "ORDER_BLOCKED", action: "BUY", symbol: input.symbol, reason: "LIQUIDITY_SHOCK" });
    return;
  }

  // [FIX P#1] pause_strategy mitigation — previously a log-only no-op; now actually halts
  //   trading while REGIME_MISMATCH or DATA_DRIFT is actively mitigated.
  //   Both incident types resolve to the "pause_strategy" action (self-healing.js).
  //   BUY is always blocked during pause. SELL is blocked by default too (a paused
  //   strategy should not act on a regime it does not trust); set
  //   SELFHEAL_ALLOW_SELL_DURING_PAUSE=1 to permit exits during pause (e.g. risk-off).
  const pauseTypes = ["REGIME_MISMATCH", "DATA_DRIFT"];
  const activePause = pauseTypes.find((t) => selfHealer.isMitigated(t));
  if (activePause) {
    const allowSell = process.env.SELFHEAL_ALLOW_SELL_DURING_PAUSE === "1";
    if (input.side === "BUY" || (input.side === "SELL" && !allowSell)) {
      console.log("[exec] Skipped: self-healer pause_strategy active (" + activePause + ") for " + input.symbol + " " + input.side);
      journalEntry({ type: "ORDER_BLOCKED", action: input.side, symbol: input.symbol, reason: "PAUSE_STRATEGY", incident: activePause });
      return;
    }
  }

  // [DUAL-PORTFOLIO] Extract strategy from AI decision (defaults to "standard")
  var orderStrategy = (decision.strategy === "max_profit") ? "max_profit" : "standard";

  // [IMPROVE #1] Position sizing enforcement (with bucket budget)
  const sizingResult = await enforcePositionSizing(input, orderStrategy);
  if (!sizingResult.ok) {
    console.log("[exec] Skipped (position sizing): " + sizingResult.reason);
    journalEntry({ type: "ORDER_BLOCKED", action: input.side, symbol: input.symbol, reason: sizingResult.reason });
    return;
  }

  console.log("[exec] " + input.side + " " + input.quantity + "x " + input.symbol + " @ " + input.price);

  // [FIX #3] Sync open order count before execution
  try {
    const portfolio = await fetchPortfolioContext();
    if (tools._safety && tools._safety.setOpenOrderCount) {
      tools._safety.setOpenOrderCount(portfolio.openOrders.length);
    }
  } catch { /* best-effort */ }

  const result = await tools.order(input);
  console.log("[exec] Result: ok=" + result.ok + ", code=" + result.code + ", account=" + orderAccountSeq);
  // [CASH-RESCUE] Track successful SELL to prevent duplicate off-hours orders
  if (result.ok && input.side === "SELL") {
    pendingOffHoursSells.add(String(input.symbol).toUpperCase());
    console.log("[exec] Tracked pending SELL: " + input.symbol + " (total pending: " + pendingOffHoursSells.size + ")");
    _savePendingSells();
  }
  // [self-audit] Track broker-side rejections for Layer 1 execution_errors_high rule
  if (!result.ok) {
    try { selfAudit.recordExecutionError(); } catch {}
  }

  // [P2-7 Integration] Record trade allocation in multi-account manager
  if (result.ok && multiAccountMgr) {
    try {
      var tradeValue = input.price * input.quantity;
      multiAccountMgr.recordTrade(orderAccountSeq, tradeValue);
    } catch (e) { console.error("[multi-account] Failed to record trade allocation: " + e.message); }
  }

  // [FIX #7] Journal the trade (with dual-portfolio strategy tag)
  journalEntry({
    type: "TRADE_EXECUTED",
    action: input.side,
    symbol: input.symbol,
    quantity: input.quantity,
    price: input.price,
    ok: result.ok,
    code: result.code,
    reason: decision.reason || "",
    strategy: orderStrategy,
  });

  // [Phase A / L4.5] Record successful execution to trading memory for future similarity recall
  if (result.ok) {
    try {
      tradingMemory.recordDecision({
        symbol: input.symbol,
        action: input.side,
        reason: decision.reason || null,
        strategy: orderStrategy,
        price: input.price,
        quantity: input.quantity,
        regime: currentRegime,
      });
    } catch (e) { console.error("[memory] recordDecision failed: " + e.message); }

    // [Phase I / L4.5] Meta-cognition: score this decision and track for outcome linkage
    try {
      var _mcId = "mc-" + Date.now() + "-" + String(input.symbol).toUpperCase();
      var _mcCtx = {
        action: input.side,
        regime: currentRegime,
        intelligence: decision._metaCogIntel || null,
        councilResult: decision._metaCogCouncil || null,
        walkForwardResult: walkForwardLastResult || null,
        similarExperiences: decision._metaCogMemory || null,
        pastFailures: null,
      };
      var _mcResult = metaCognition.recordDecision(_mcId, _mcCtx);
      if (_mcResult) {
        console.log("[meta-cog] " + input.side + " " + input.symbol + " score=" + _mcResult.aggregate +
          " weak=" + _mcResult.isWeak + " (id=" + _mcId + ")");
        // For BUY: store ID so SELL fill can attach outcome
        if (input.side === "BUY") {
          metaCogDecisionMap.set(String(input.symbol).toUpperCase(), { decisionId: _mcId, ts: Date.now() });
          // Cap map size
          while (metaCogDecisionMap.size > 200) {
            var _oldest = metaCogDecisionMap.keys().next().value;
            metaCogDecisionMap.delete(_oldest);
          }
        }
        // Journal weak decisions for observability
        if (_mcResult.isWeak) {
          journalEntry({
            type: "META_COG_WEAK_DECISION", symbol: input.symbol, action: input.side,
            aggregate: _mcResult.aggregate, scores: _mcResult.scores, decisionId: _mcId,
          });
          metrics.counter("meta_cog_weak_decisions");
        } else {
          metrics.counter("meta_cog_strong_decisions");
        }
      }
    } catch (e) { console.error("[meta-cog] recordDecision failed: " + e.message); }
  }

  // [FIX #4] Track order for fill monitoring
  if (result.ok && result.data && result.data.order && result.data.order.orderId) {
    pendingOrders.set(result.data.order.orderId, {
      symbol: input.symbol,
      side: input.side,
      price: input.price,
      quantity: input.quantity,
      createdAt: Date.now(),
      _strategy: input._strategy,
      _decisionSource: input._decisionSource,
    });
    // [P0-FIX] Removed redundant orderManager.track() — orderManager.poll() is never called,
    // causing all tracked orders to accumulate permanently in its internal Map.
    // The pendingOrders Map + monitorPendingOrders() already handles full lifecycle.
    console.log("[exec] Tracking order " + result.data.order.orderId + " for fill monitoring");
  }
}

// --- 6. WebSocket event loop ---
let wsClient = null;

async function start() {
  console.log("[runner] Starting autonomous trading bot...");
  const proj = targetEngine.project();
  console.log("[runner] Phase: " + proj.phase + " (" + proj.phaseName + "), dryRun: " + proj.dryRun + ", target: " + proj.baseTargetPct + "%");
  console.log("[runner] AI: " + aiModel + " via " + providerName + " @ " + baseUrl);
  if (tradingGoals) {
    console.log("[runner] Goals loaded: v" + tradingGoals.version + " - " + Object.keys(tradingGoals.market_goals || {}).join(", "));
  } else {
    console.log("[runner] No goals.json found - using default prompts");
  }

  // [IMPROVE #8] Load backtest feedback and apply parameter adjustments
  liveParamsOverride = loadBacktestFeedback();
  if (liveParamsOverride) {
    if (liveParamsOverride.suggestedStopLossPct != null) {
      console.log("[backtest-feedback] Adjusting STOP_LOSS_PCT: " + STOP_LOSS_PCT + " -> " + liveParamsOverride.suggestedStopLossPct);
      STOP_LOSS_PCT = liveParamsOverride.suggestedStopLossPct;
    }
    if (liveParamsOverride.suggestedTakeProfitPct != null) {
      console.log("[backtest-feedback] Adjusting TAKE_PROFIT_PCT: " + TAKE_PROFIT_PCT + " -> " + liveParamsOverride.suggestedTakeProfitPct);
      TAKE_PROFIT_PCT = liveParamsOverride.suggestedTakeProfitPct;
    }
  }

  // --- Dynamic Universe Manager (with disk persistence) ---
  const UNIVERSE_PERSIST_PATH = path.join(__dirname, "universe.json");

  function _loadPersistedUniverse() {
    try {
      if (fs.existsSync(UNIVERSE_PERSIST_PATH)) {
        const raw = fs.readFileSync(UNIVERSE_PERSIST_PATH, "utf8");
        const data = JSON.parse(raw);
        if (Array.isArray(data.symbols) && data.symbols.length > 0) {
          console.log("[universe] Loaded " + data.symbols.length + " persisted symbols from universe.json (updated=" + (data.updatedAt || "unknown") + ")");
          return data.symbols.map(function(s) { return String(s).trim().toUpperCase(); }).filter(Boolean);
        }
      }
    } catch (e) {
      console.error("[universe] Failed to load universe.json: " + e.message);
    }
    return null;
  }

  const _defaultSymbols = ["005930", "000660", "035720", "AAPL", "MSFT", "NVDA", "TSLA", "BRK.B", "SPY", "QQQ", "7203", "9984", "EWJ"];
  var initialSymbols;
  if (process.env.WATCH_SYMBOLS) {
    initialSymbols = process.env.WATCH_SYMBOLS.split(",").map(function(s) { return s.trim().toUpperCase(); }).filter(Boolean);
    console.log("[universe] Seeded from WATCH_SYMBOLS env (" + initialSymbols.length + " symbols)");
  } else {
    const _persisted = _loadPersistedUniverse();
    if (_persisted && _persisted.length > 0) {
      initialSymbols = _persisted;
    } else {
      initialSymbols = _defaultSymbols;
      console.log("[universe] No persisted universe and no WATCH_SYMBOLS; using defaults (" + initialSymbols.length + ")");
    }
  }

  // Persist helpers (debounced write + 5-min safety flush). `universe` is referenced
  // at call-time, so these are safe to define before the universe object is created.
  let _persistTimer = null;
  function _persistUniverse() {
    try {
      if (!universe) return;
      fs.writeFileSync(UNIVERSE_PERSIST_PATH, JSON.stringify({
        symbols: Array.from(universe.symbols),
        updatedAt: new Date().toISOString()
      }, null, 2));
    } catch (e) {
      console.error("[universe] Persist failed: " + e.message);
    }
  }
  function _schedulePersist() {
    if (_persistTimer) return;
    _persistTimer = setTimeout(function() {
      _persistTimer = null;
      _persistUniverse();
    }, 2000);
    if (_persistTimer.unref) _persistTimer.unref();
  }
  var _periodicPersistTimer = setInterval(function() { _persistUniverse(); }, 300000);
  if (_periodicPersistTimer.unref) _periodicPersistTimer.unref();

  universe = {
    symbols: new Set(initialSymbols),
    allowed: new Set(initialSymbols),
    add(sym) {
      const s = String(sym).trim().toUpperCase();
      if (!s || this.symbols.has(s)) return false;
      const isKR = /^\d{6}$/.test(s), isJP = /^\d{4}$/.test(s), isUS = /^[A-Z][A-Z.]{0,5}$/.test(s);
      if (!isKR && !isJP && !isUS) { console.log("[universe] Rejected invalid: " + s); return false; }
      this.symbols.add(s); this.allowed.add(s);
      console.log("[universe] Added " + s + " (total: " + this.symbols.size + ")");
      if (wsClient && (isKR || isUS)) {
        try {
          // Merge new symbol into existing subscriptions instead of replacing all
          const newType = isKR ? "trade:kr" : "trade:us";
          const currentSubs = wsClient.getSubscriptions();
          const existingEntry = currentSubs.find(function(sub) { return sub.type === newType; });
          let mergedSubs;
          if (existingEntry) {
            mergedSubs = currentSubs.map(function(sub) {
              if (sub.type === newType) return { type: newType, codes: sub.codes.concat(s) };
              return sub;
            });
          } else {
            mergedSubs = currentSubs.concat([{ type: newType, codes: [s] }]);
          }
          wsClient.subscribe(mergedSubs);
        } catch (e) { console.error("[universe] Failed to update WS subscription: " + e.message); }
      }
      _schedulePersist();
      return true;
    },
    getKR() { return Array.from(this.symbols).filter(function(s) { return /^\d{6}$/.test(s); }); },
    getUS() { return Array.from(this.symbols).filter(function(s) { return /^[A-Z][A-Z.]+$/.test(s); }); },
    getJP() { return Array.from(this.symbols).filter(function(s) { return /^\d{4}$/.test(s); }); },
    getAll() { return Array.from(this.symbols); },
    // [IMPROVE #7] Remove underperforming symbol from universe
    remove(sym) {
      const s = String(sym).trim().toUpperCase();
      if (!this.symbols.has(s)) return false;
      this.symbols.delete(s);
      this.allowed.delete(s);
      console.log("[universe] Removed " + s + " (total: " + this.symbols.size + ")");
      _schedulePersist();
      return true;
    },
  };

  // Patch safety to use dynamic allowed set
  if (tools && tools._safety) {
    const origCheck = tools._safety.checkPreCreateOrder;
    tools._safety.checkPreCreateOrder = function(input) {
      // [P0-1] UNRESTRICTED_MODE removed — all orders validated
      if (input.symbol && !universe.allowed.has(String(input.symbol).toUpperCase())) {
        return { ok: false, code: "SYMBOL_NOT_ALLOWED", reason: "Not in dynamic universe" };
      }
      return origCheck.call(this, input);
    };
  }

  // Inject ADD_SYMBOL / DISCOVER_MARKET handling
  const origExecute = executeDecision;
  executeDecision = async function(decision) {
    if (decision && decision.action === "ADD_SYMBOL" && decision.symbol) {
      const added = universe.add(decision.symbol);
      console.log("[ai] ADD_SYMBOL " + decision.symbol + ": " + (added ? "OK" : "REJECTED"));
      return { ok: added, action: "ADD_SYMBOL" };
    }

    // [Phase C / L4.5] KILLSWITCH GATE — block all BUY/SELL if halted
    if (decision && (decision.action === "BUY" || decision.action === "SELL")) {
      try {
        var _ksMetrics = { apiFailures: consecutiveAuthFailures, aiFailures: aiConsecutiveFailures };
        try {
          var _ksPortfolio = await fetchPortfolioContext();
          var _ksEquity = computeTotalEquityKrw(_ksPortfolio);
          var _ksInvested = (_ksPortfolio.positions || []).reduce(function(s, p) { return s + (p.marketValue || 0); }, 0);
          _ksMetrics.totalExposurePct = _ksEquity > 0 ? (_ksInvested / _ksEquity) * 100 : 0;
          // Daily loss % from target engine projection
          var _ksProj = targetEngine.project();
          if (_ksProj && typeof _ksProj.dailyReturnPct === "number") {
            _ksMetrics.dailyLossPct = _ksProj.dailyReturnPct < 0 ? Math.abs(_ksProj.dailyReturnPct) : 0;
          }
        } catch {}
        // Consecutive losses from recent fills ring buffer
        try {
          var _ksRecentLosses = 0;
          for (var _ri = recentFills.length - 1; _ri >= 0; _ri--) {
            if (recentFills[_ri].side === "SELL" && recentFills[_ri].pnl !== null) {
              if (recentFills[_ri].pnl < 0) _ksRecentLosses++;
              else break;
            }
          }
          _ksMetrics.consecutiveLosses = _ksRecentLosses;
          // [P10-3] An empty buffer means "unknown", not "zero losses". Leaving it
          // as 0 lets the kill-switch read a wipeout as a clean record. Surface the
          // distinction so it is visible in logs instead of silently passing.
          var _ksSellsKnown = recentFills.filter(function(f) { return f.side === "SELL" && f.pnl !== null; }).length;
          if (_ksSellsKnown === 0) {
            _ksMetrics.consecutiveLossesKnown = false;
            console.warn("[killswitch] No SELL fills with known P&L in this session (recentFills=" + recentFills.length + ") — consecutiveLosses is UNKNOWN, not 0. Daily-loss and exposure checks still apply.");
          } else {
            _ksMetrics.consecutiveLossesKnown = true;
          }
        } catch {}
        // VIX from most recently cached intelligence context (best-effort)
        try {
          var _ksIntelStats = intelligence.stats();
          if (_ksIntelStats && _ksIntelStats.lastVix != null) _ksMetrics.vix = _ksIntelStats.lastVix;
        } catch {}
        var _ksResult = killswitch.check(_ksMetrics);
        if (_ksResult.halted) {
          console.log("[killswitch] BLOCKED " + decision.action + " " + (decision.symbol || "") + " — " + _ksResult.reason);
          journalEntry({ type: "KILLSWITCH_BLOCK", symbol: decision.symbol, action: decision.action, reason: _ksResult.reason });
          metrics.counter("killswitch_blocks");
          return;
        }
      } catch (e) { console.error("[killswitch] check error: " + e.message); }

      // [Phase C / L4.5] APPROVAL GATE — new symbol / large position
      try {
        var _sym = String(decision.symbol).toUpperCase();
        if (decision.action === "BUY") {
          // New-symbol gate (first time we see this symbol request a BUY)
          if (!knownSymbols.has(_sym)) {
            knownSymbols.add(_sym);
            var _nsId = approvalGate.request("new_symbol", { symbol: _sym, reason: (decision.reason || "").slice(0, 200) });
            // L4.5 auto-approves; in L5 this becomes a true human gate via Telegram reply
            approvalGate.approve(_nsId, "auto_l4.5");
            console.log("[approval] New symbol auto-approved: " + _sym + " (id=" + _nsId + ")");
          }
          // Large-position gate (>15% equity)
          if (decision._councilCtx && decision._councilCtx.totalEquity > 0 && decision.price && decision.quantity) {
            var _lpOrderVal = decision.price * decision.quantity;
            var _lpPct = (_lpOrderVal / decision._councilCtx.totalEquity) * 100;
            if (_lpPct > 15) {
              var _lpId = approvalGate.request("large_position", { symbol: _sym, pct: Number(_lpPct.toFixed(2)), valueKrw: _lpOrderVal });
              approvalGate.approve(_lpId, "auto_l4.5");
              console.log("[approval] Large position auto-approved: " + _sym + " " + _lpPct.toFixed(1) + "% (id=" + _lpId + ")");
            }
          }
        }
        // Expire any stale approval requests each cycle
        approvalGate.expireStale();
      } catch (e) { console.error("[approval] gate error: " + e.message); }
    }

    // [Phase B / L4.5] Council validation gate for BUY/SELL decisions
    if (decision && (decision.action === "BUY" || decision.action === "SELL") && decision._councilCtx) {
      try {
        var _verdict = await council.evaluate(decision, decision._councilCtx);
        if (!_verdict.approved) {
          console.log("[council] REJECTED " + decision.action + " " + (decision.symbol || "") +
            " (consensus=" + _verdict.consensus + ", issues=" + (_verdict.issues || []).length + ")");
          if (_verdict.issues && _verdict.issues.length > 0) {
            console.log("[council] Issues: " + _verdict.issues.slice(0, 3).join("; "));
          }
          journalEntry({ type: "COUNCIL_REJECTION", action: decision.action, symbol: decision.symbol,
            consensus: _verdict.consensus, issues: (_verdict.issues || []).slice(0, 5),
            originalAction: _verdict.originalAction });
          metrics.counter("council_rejections");
          // Convert to HOLD — do not execute
          return;
        }
        // Council approved — run scenario simulation for large positions
        if (decision.action === "BUY" && decision._councilCtx.totalEquity > 0 && decision.price && decision.quantity) {
          var _orderVal = decision.price * decision.quantity;
          var _posPct = (_orderVal / decision._councilCtx.totalEquity) * 100;
          if (_posPct >= COUNCIL_SIM_THRESHOLD_PCT) {
            try {
              var _simResult = simulator.simulate({ paths: 5000, days: 30, initialPrice: decision.price,
                drift: 0.0003, volatility: 0.025 });
              var _risk = simulator.computeRisk(_simResult);
              var _stress = simulator.stressTest([{ symbol: decision.symbol, price: decision.price, quantity: decision.quantity }]);
              console.log("[scenario] " + decision.symbol + " VaR95=" + _risk.var95 + " maxDD95=" + _risk.maxDrawdown95 +
                " sharpe=" + _risk.sharpeRatio + " lossProb=" + _risk.probabilityOfLoss);
              journalEntry({ type: "SCENARIO_SIMULATION", symbol: decision.symbol, action: decision.action,
                positionPct: Number(_posPct.toFixed(2)), var95: _risk.var95, var99: _risk.var99,
                sharpe: _risk.sharpeRatio, probLoss: _risk.probabilityOfLoss,
                worstStress: _stress && _stress[0] ? _stress[0].scenario : null,
                worstStressLoss: _stress && _stress[0] ? _stress[0].totalLoss : null });
              // Block if worst-case stress exceeds 10% of total equity
              if (_stress && _stress.length > 0) {
                var _worstLoss = Math.min.apply(null, _stress.map(function(s) { return s.totalLoss; }));
                var _worstLossPct = Math.abs(_worstLoss) / decision._councilCtx.totalEquity * 100;
                if (_worstLossPct > 10) {
                  console.log("[scenario] BLOCKED: worst stress loss " + _worstLossPct.toFixed(2) + "% > 10% equity");
                  journalEntry({ type: "SCENARIO_BLOCK", symbol: decision.symbol, worstLossPct: _worstLossPct.toFixed(2) });
                  metrics.counter("scenario_blocks");
                  return;
                }
              }
            } catch (e) { console.error("[scenario] sim failed for " + decision.symbol + ": " + e.message); }
          }
        }
        console.log("[council] APPROVED " + decision.action + " " + (decision.symbol || "") +
          " (consensus=" + _verdict.consensus + (_verdict.arbiterNote ? ", arbiter: " + _verdict.arbiterNote : "") + ")");
        // [Phase I / L4.5] Feed council verdict back into meta-cognition context
        decision._metaCogCouncil = { consensus: _verdict.consensus, approved: _verdict.approved, issues: (_verdict.issues || []).length };
      } catch (e) {
        console.error("[council] evaluation error: " + e.message + " — proceeding with original decision");
      }
    }
    return origExecute(decision);
  };

  // --- Baseline Equity Initialization ---
  // Must set highWaterEquity before any trading so Target Engine can calculate returnPct and escalate phases
  try {
    console.log("[equity] Fetching initial account baseline...");
    const initialEquity = await snapshotter.fetchEquity();
    targetEngine.recordEquitySnapshot({ equity: initialEquity });
    // Feed initial equity into performance monitor for Prometheus metrics
    if (perfMonitor && initialEquity > 0) {
      perfMonitor.recordEquity(initialEquity);
    }
    // Feed initial equity into self-audit so equity_metric_zero rule has baseline
    if (selfAudit && initialEquity > 0) {
      selfAudit.updateEquity(initialEquity);
    }
    const proj = targetEngine.project();
    console.log("[equity] Baseline set. highWaterEquity=" + proj.highWaterEquity + ", dailyBaseline=" + proj.dailyBaselineEquity + ", phase=" + proj.phase);
  } catch (e) {
    console.error("[equity] Failed to fetch initial baseline: " + e.message);
  }

  // Periodic equity snapshot (every 30 minutes) to track daily return for phase escalation
  // [DEEP-DEBUG FIX] Track consecutive failures and alert — silent catch hid
  // persistent fetchEquity failures that left the hard-stop blind.
  let equitySnapshotConsecutiveFailures = 0;
  const EQUITY_SNAPSHOT_FAILURE_ALERT_THRESHOLD = 3;
  var _eqTimer = setInterval(async function() {
    try {
      const eq = await snapshotter.fetchEquity();
      targetEngine.recordEquitySnapshot({ equity: eq });
      // [P1-5 Integration] Feed equity into performance monitor for Sharpe/Sortino/MaxDD
      if (eq > 0) perfMonitor.recordEquity(eq);
      if (eq > 0) selfAudit.updateEquity(eq);
      // [Phase C / L4.5] Shadow mode daily tick — evaluate observing parameter changes
      try {
        var _smWinRate = computeRecentWinRate();
        var _smResults = shadowMode.tick({ winRate: _smWinRate });
        if (_smResults && _smResults.length > 0) {
          for (var _smR of _smResults) {
            journalEntry({ type: "SHADOW_MODE_TICK", action: _smR.action, param: _smR.entry.param,
              proposedValue: _smR.entry.proposedValue, changePct: _smR.entry.changePct });
          }
        }
      } catch (e) { console.error("[shadow] tick error: " + e.message); }
      // [NOTIFY] Hook: drawdown, phase escalation, position concentration
      try { checkDrawdownMilestone(); } catch (e) { /* silent */ }
      try { checkPhaseEscalation(); } catch (e) { /* silent */ }
      checkPositionConcentration().catch(function() {});
      if (equitySnapshotConsecutiveFailures > 0) {
        console.log("[equity] Snapshot recovered after " + equitySnapshotConsecutiveFailures + " failure(s)");
        equitySnapshotConsecutiveFailures = 0;
      }
    } catch (e) {
      equitySnapshotConsecutiveFailures++;
      if (equitySnapshotConsecutiveFailures <= 2) {
        console.warn("[equity] Snapshot failed (" + equitySnapshotConsecutiveFailures + "): " + e.message);
      } else if (equitySnapshotConsecutiveFailures === EQUITY_SNAPSHOT_FAILURE_ALERT_THRESHOLD) {
        console.error("[equity] CRITICAL: " + equitySnapshotConsecutiveFailures + " consecutive snapshot failures — hard-stop is blind!");
        sendTelegramAlert("⚠️ *Equity Snapshot Failure*\n" + equitySnapshotConsecutiveFailures + " consecutive failures.\nDaily hard-stop cannot fire without equity data.\nError: " + e.message, "warning");
      }
      // Suppress further per-cycle logs; will log again on recovery.
    }
  }, 1800000);
  if (_eqTimer.unref) _eqTimer.unref();

  // --- 9. Halt Monitor & Auto-Recovery (30-min cooldown, Phase 1 restart) ---
  let haltNotified = false;
  var _haltTimer = setInterval(function() {
    const proj = targetEngine.project();
    // [Phase C / L4.5] If killswitch is halted, override target engine halt with killswitch reason
    try {
      var _ksState = killswitch.state();
      if (_ksState.halted && !proj.halted) {
        // Surface killswitch halt through the target engine halt monitor
        console.error("[killswitch] Propagating halt to engine: " + _ksState.reason);
      }
    } catch {}
    if (proj.halted && !haltNotified) {
      console.log("[halt] TRADING HALTED. Reason: " + (proj.reasons.join(", ") || "unknown"));
      sendTelegramAlert("🛑 *TRADING HALTED*\nReason: " + (proj.reasons.join(", ") || "Hard Stop") + "\nAuto-resume in 30 minutes (Phase 1).", "critical");
      haltNotified = true;
    } else if (!proj.halted && haltNotified) {
      haltNotified = false;
    }
  }, 60000);
  if (_haltTimer.unref) _haltTimer.unref();

  async function autoRecoverFromHalt() {
    const proj = targetEngine.project();
    if (!proj.halted) return;
    // [Phase C / L4.5] Killswitch recovery requires 24h cooldown + human approval
    try {
      var _ksState = killswitch.state();
      if (_ksState.halted) {
        var _ksRecovery = killswitch.attemptRecovery(false); // no human approval in auto path
        if (!_ksRecovery.ok) {
          console.log("[recovery] Killswitch blocks auto-recovery: " + _ksRecovery.reason);
          sendTelegramAlert("🛑 *Recovery Blocked by Killswitch*\n" + _ksRecovery.reason +
            "\nReply /recover to approve manually.", "critical");
          return;
        }
      }
    } catch (e) { console.error("[recovery] killswitch check error: " + e.message); }
    console.log("[recovery] 30-min cooldown passed. Resuming at Phase 1...");
    targetEngine.resume();
    try {
      const eq = await snapshotter.fetchEquity();
      // [FIX] Reseed daily baseline at recovery equity so the hard-stop
      // measures loss from *now*, not from the morning baseline that already
      // triggered the halt (otherwise we'd re-halt immediately on same day).
      targetEngine.resetDailyBaseline(eq);
      targetEngine.recordEquitySnapshot({ equity: eq });
      console.log("[recovery] Baseline refreshed. highWaterEquity=" + eq + ", dailyBaseline=" + targetEngine.project().dailyBaselineEquity);
    } catch (e) {
      console.error("[recovery] Failed to refresh baseline: " + e.message);
    }
    sendTelegramAlert("✅ *Auto-Recovery Complete*\nTrading resumed at Phase 1 (live_small).\nBaseline equity refreshed.");
    haltNotified = false;
  }
  // Check every 5 minutes if halted; if so, schedule recovery 30 min after halt
  let haltDetectedAt = 0;
  var _recoveryTimer = setInterval(function() {
    const proj = targetEngine.project();
    if (proj.halted) {
      if (haltDetectedAt === 0) haltDetectedAt = Date.now();
      const elapsed = Date.now() - haltDetectedAt;
      if (elapsed >= 1800000) { // 30 minutes
        haltDetectedAt = 0;
        autoRecoverFromHalt().catch(function(e) { console.error("[recovery] Error: " + e.message); });
      }
    } else {
      haltDetectedAt = 0;
    }
  }, 300000);
  if (_recoveryTimer.unref) _recoveryTimer.unref();

  // --- [FIX #7b] Daily Report Timer (KST 23:50 = UTC 14:50) ---
  let lastReportDay = new Date().getUTCDate();
  var _reportTimer = setInterval(function() {
    const now = new Date();
    if (now.getUTCHours() === 14 && now.getUTCMinutes() >= 50 && now.getUTCDate() !== lastReportDay) {
      lastReportDay = now.getUTCDate();
      sendDailyReport();
    }
  }, 60000);
  if (_reportTimer.unref) _reportTimer.unref();

  // --- [FIX #9b] FX Rate Monitor Timer (every 10 minutes) ---
  var _fxTimer = setInterval(function() {
    checkFxRisk().catch(function() {});
  }, 600000);
  if (_fxTimer.unref) _fxTimer.unref();

  // --- 10. Daily Reset at KST 00:00 (UTC 15:00) ---
  // Resets halt state and re-baselines equity for the new trading day.
  async function dailyReset() {
    console.log("[daily-reset] New trading day (KST). Resetting engine state...");
    const proj = targetEngine.project();
    const wasHalted = proj.halted;
    if (wasHalted) {
      targetEngine.resume();
      console.log("[daily-reset] Halt cleared.");
    }
    try {
      const eq = await snapshotter.fetchEquity();
      // [FIX] Explicitly reseed daily baseline so the hard-stop measures
      // from today's opening equity, not a stale value from a prior session.
      targetEngine.resetDailyBaseline(eq);
      targetEngine.recordEquitySnapshot({ equity: eq });
      console.log("[daily-reset] Baseline refreshed. highWaterEquity=" + eq + ", dailyBaseline=" + targetEngine.project().dailyBaselineEquity);
    } catch (e) {
      console.error("[daily-reset] Failed to refresh baseline: " + e.message);
    }
    haltNotified = false;
    haltDetectedAt = 0;
    _notifier.resetLimits(); // [Phase 4.2] fresh rate limits for new day
    sendTelegramAlert("🌅 *Daily Reset Complete* (KST 00:00)\nHalt cleared: " + wasHalted + "\nNew baseline set. Trading resumes.");
  }

  // --- [Phase 2.3] Planner loop: morning plan + evening review (KST) ---
  async function buildDailyPlan() {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
    if (dailyPlanDate === today && dailyPlan) return dailyPlan; // already built
    try {
      // [FIX] Fetch token and portfolio within this scope (not available from askAI)
      const token = await fetchAccessToken(TOSS_CLIENT_ID, TOSS_CLIENT_SECRET);
      const portfolio = await fetchPortfolioContext();
      const activeMarkets = getActiveMarkets(); // returns ["KR", "US", ...]
      const planUniverse = [];
      // Use symbols from our dynamic universe manager, filtered by active markets
      const allSymbols = universe.getAll();
      for (const sym of allSymbols) {
        try {
          const ctx = await fetchCandleContext(token, sym);
          if (ctx) planUniverse.push({ symbol: sym, ctx });
        } catch {}
        // Limit to 20 symbols to avoid excessive API calls during plan build
        if (planUniverse.length >= 20) break;
      }
      if (planUniverse.length === 0) { console.log("[planner] No active markets/data — plan deferred"); return null; }
      dailyPlan = planner.createDailyPlan(planUniverse, portfolio.positions);
      dailyPlanDate = today;
      console.log("[planner] Daily plan: " + dailyPlan.summary);
      journalEntry({ type: "DAILY_PLAN", date: today, summary: dailyPlan.summary, entries: dailyPlan.entries.length, exits: dailyPlan.exits.length });
      metrics.counter("planner_plans_built");
      return dailyPlan;
    } catch (e) {
      console.error("[planner] Plan build failed: " + e.message);
      return null;
    }
  }

  function reviewDailyPlan() {
    if (!dailyPlan) return;
    // [FIX] Use recentFills instead of undefined tradeHistory
    const fills = recentFills.filter(function(t) {
      return t.side === "SELL" && t.at && new Date(t.at).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }) === dailyPlan.date;
    }).map(function(t) { return { symbol: t.symbol, side: t.side, pnl: t.pnl ?? null }; });
    const review = planner.reviewDay(dailyPlan, fills);
    console.log("[planner] Day review: adherence=" + review.adherencePct + "% pnl=" + review.totalPnl + " " + review.notes);
    journalEntry({ type: "DAILY_REVIEW", ...review });
    sendTelegramAlert("📋 *Day Review* (" + review.date + ")\nAdherence: " + review.adherencePct + "%\nTrades: " + (review.plannedTrades + review.offPlanTrades) + " (planned " + review.plannedTrades + ")\nP&L: " + review.totalPnl.toLocaleString() + "\n" + review.notes);
    dailyPlan = null;
    dailyPlanDate = null;
  }

  // Build plan at KST 08:30 (UTC 23:30 prev day) — before KR open 09:00
  let lastPlanDay = null;
  var _plannerTimer = setInterval(function() {
    const now = new Date();
    const kstHour = Number(now.toLocaleString("en-US", { timeZone: "Asia/Seoul", hour: "2-digit", hour12: false }));
    const kstMin = Number(now.toLocaleString("en-US", { timeZone: "Asia/Seoul", minute: "2-digit" }));
    const today = now.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
    if (kstHour === 8 && kstMin >= 30 && lastPlanDay !== today) {
      lastPlanDay = today;
      buildDailyPlan().catch(function(e) { console.error("[planner] " + e.message); });
    }
    // Review at KST 20:00 (after US pre-close data available)
    if (kstHour === 20 && kstMin >= 0 && kstMin < 5 && dailyPlan) {
      reviewDailyPlan();
    }
  }, 60000);
  if (_plannerTimer.unref) _plannerTimer.unref();

  let lastResetDay = new Date().getUTCDate();
  var _resetTimer = setInterval(function() {
    const now = new Date();
    if (now.getUTCHours() === 15 && now.getUTCDate() !== lastResetDay) {
      lastResetDay = now.getUTCDate();
      dailyReset().catch(function(e) { console.error("[daily-reset] Error: " + e.message); });
    }
  }, 60000);
  if (_resetTimer.unref) _resetTimer.unref();

  // Build WS subscription list from current universe state.
  // Called on initial connect and every reconnect so dynamically-added
  // symbols (via universe.add / ADD_SYMBOL) survive reconnections.
  function buildCurrentSubs() {
    var built = [];
    var kr = universe.getKR(), us = universe.getUS();
    if (kr.length) built.push({ type: "trade:kr", codes: kr });
    if (us.length) built.push({ type: "trade:us", codes: us });
    built.push({ type: "personal:order", codes: [TOSS_ACCOUNT_SEQ] });
    return built;
  }
  const subs = buildCurrentSubs();

  let _wsFrameCount = 0; // debug: count frames for initial logging
  wsClient = createTossWsClient({
    getToken: async function() { return fetchAccessToken(TOSS_CLIENT_ID, TOSS_CLIENT_SECRET); },
    onOpen: function() {
      console.log("[ws] Connected successfully to wss://openapi-ws.tossinvest.com/ws/v1");
      wsConnectedAt = Date.now();
      wsReconnectAttempts = 0;
      _wsFrameCount = 0;
      // [P2-6] Notify connection manager of successful connection
      try { wsConnMgr.connect().catch(function() {}); } catch {}
    },
    onClose: function(info) {
      console.log("[ws] Connection closed (user_initiated=" + (info && info.user_initiated) + ")");
      wsConnectedAt = 0;
      // [P2-6] Notify connection manager of disconnect
      if (!(info && info.user_initiated)) {
        try { wsConnMgr.reportDisconnect("ws_close"); } catch {}
      }
    },
    // [FIX] Wire onSubscriptions to log ack/rejected — catches stock-not-found,
    // symbol-market-mismatch, account-not-found immediately after subscribe().
    onSubscriptions: function(frame) {
      var sub = (frame && frame.subscribed) || [];
      var rej = (frame && frame.rejected) || [];
      console.log("[ws] subscriptions ack: subscribed=" + sub.length + " rejected=" + rej.length + (rej.length ? " rejected_detail=" + JSON.stringify(rej).substring(0, 500) : ""));
      if (rej.length > 0) {
        audit.custom("ws_rejected", { count: rej.length, sample: rej.slice(0, 5) });
      }
    },
    // [FIX] Wire onPong to confirm keepalive round-trip (logged sparingly)
    onPong: function(frame) {
      wsLastMessageAt = Date.now(); // pong counts as liveness signal
      if (_wsFrameCount < 3) {
        console.log("[ws] pong received (frame #" + _wsFrameCount + ")");
      }
    },
    onMessage: async function(frame) {
      if (frame.type !== "message" || !frame.data) return;
      _wsFrameCount++;
      wsLastMessageAt = Date.now();
      // [FIX] Record price reception for self-audit — previously only REST path called this,
      // causing pricesCollectedLast10Min to stay at 0 even when WS was delivering data.
      try { selfAudit.recordPrice(); } catch {}

      // [HYBRID SCALPER] Rule-based sub-second reaction runs BEFORE the LLM path.
      // AI only supervises (arm/disarm); the scalper executes without any LLM call.
      try {
        var _scTopic = frame.topic || "";
        var _scParts = _scTopic.split(":");
        var _scSym0 = _scParts.length >= 3 ? _scParts.slice(2).join(":") : (frame.data && frame.data.symbol);
        var _scMkt = (_scParts.length >= 2 ? _scParts[1] : "us").toUpperCase();
        var _scPrice = frame.data && Number(frame.data.price);
        if (_scSym0 && _scPrice > 0) {
          var _scFx = _scMkt === "KR" ? 1 : (_scMkt === "JP" ? (cachedFxRates.FX_JPY_KRW || 9) : (cachedFxRates.FX_USD_KRW || 1350));
          var _scPf = (typeof portfolioCache !== "undefined" ? portfolioCache : null) || { cashKrw: 0, cashUsd: 0, positions: [] };
          var _scEq = (typeof computeTotalEquityKrw === "function") ? computeTotalEquityKrw(_scPf) : 0;
          var _scDec = scalper.onTick(_scSym0, _scPrice, { equityKrw: _scEq, fxRate: _scFx });
          if (_scDec) {
            console.log("[scalper] FIRE " + _scDec.action + " " + _scSym0 + " qty=" + _scDec.quantity + " price=" + _scPrice + " reason=" + _scDec.reason);
            try { metrics.counter("scalper_fire"); } catch {}
            await executeDecision(_scDec);
          }
        }
      } catch (scErr) { console.warn("[scalper] tick error: " + (scErr && scErr.message)); }


      // [FIX] Extract symbol from topic and inject into marketData.
      // Toss WS message format: { type:"message", topic:"trade:us:TSLA", data:{price, volume, timestamp, currency} }
      // The symbol lives in the topic, NOT in data. askAI expects marketData.symbol,
      // so without this injection sym=undefined → all context fetches silently fail.
      var topicParts = (frame.topic || "").split(":");
      var wsSymbol = topicParts.length >= 3 ? topicParts.slice(2).join(":") : null;
      var wsMarket = topicParts.length >= 2 ? topicParts[1] : null;
      if (wsSymbol && frame.data && !frame.data.symbol) {
        frame.data.symbol = wsSymbol;
      }
      if (wsMarket && frame.data && !frame.data.market) {
        frame.data.market = wsMarket.toUpperCase();
      }

      // Debug: log first few raw frames to verify topic/data structure
      if (_wsFrameCount <= 3) {
        var _topic = frame.topic || "(no-topic)";
        var _dataStr = JSON.stringify(frame.data).substring(0, 400);
        console.log("[ws] frame #" + _wsFrameCount + " topic=" + _topic + " data=" + _dataStr);
      }
      // [DIAG] Log periodic AI call attempts to confirm data flows into askAI
      if (_wsFrameCount % 100 === 1) {
        console.log("[ws→ai] frame #" + _wsFrameCount + " sym=" + wsSymbol + " market=" + wsMarket + " price=" + (frame.data.price || "?") + " throttle=" + getDynamicThrottleMs() + "ms");
      }
      if (AI_MAX_PROFIT_PCT < 100 && targetEngine.project().halted) return;
      // [FIX] Per-symbol WS throttle: high-frequency ticks reset the global
      // lastAiCallAt, starving REST-poll askAI calls. Gate WS→askAI with a
      // per-symbol throttle so REST loop can still call askAI.
      var wsNow = Date.now();
      var wsLastCall = wsThrottleMap.get(wsSymbol) || 0;
      if (wsNow - wsLastCall < WS_THROTTLE_MS) {
        return;
      }
      wsThrottleMap.set(wsSymbol, wsNow);
      console.log("[ws] Calling askAI for " + wsSymbol + " (throttle passed)");
      const decision = await askAI(frame.data);
      if (decision) {
        console.log("[ws→decision] action=" + decision.action + " sym=" + (decision.symbol || wsSymbol) + " reason=" + (decision.reason || "").substring(0, 120));
        await executeDecision(decision);
      }
    },
    onError: function(err) {
      var msg = (err && err.error && err.error.message) || JSON.stringify(err);
      console.error("[ws] Error: " + msg);
      // [P2-6] Report error to connection manager for circuit breaker tracking
      try { wsConnMgr.reportDisconnect("ws_error: " + msg); } catch {}
      // [DEEP-DEBUG FIX] Broaden auth-error detection to catch generic HTTP
      // handshake rejections in addition to explicit token-revoked/expired
      // patterns. The `ws` library emits an `error` event with message
      // "Unexpected server response: 401" when the upgrade handshake fails —
      // this contains NEITHER "token" NOR "revoked|expired|invalid", so the
      // old pattern missed it entirely, leaving the stale cached token in
      // place and causing an infinite 401 reconnect storm.
      //
      // Detection now matches:
      //   - isAuthError(): invalid-token, token-revoked, toss_auth_error, unauthorized
      //   - HTTP status codes 401/403 in the error message
      //   - Generic "unexpected server response" prefix (ws library signature)
      var lowerMsg = (msg || "").toLowerCase();
      var isWsAuthError = isAuthError(msg) ||
        lowerMsg.indexOf(" 401") !== -1 || lowerMsg.indexOf(":401") !== -1 || lowerMsg.indexOf("response: 401") !== -1 ||
        lowerMsg.indexOf(" 403") !== -1 || lowerMsg.indexOf(":403") !== -1 || lowerMsg.indexOf("response: 403") !== -1 ||
        lowerMsg.indexOf("unexpected server response") !== -1;
      if (isWsAuthError) {
        consecutiveAuthFailures++;
        selfAudit.recordAuthFailure();
        console.warn("[ws] Auth error detected (#" + consecutiveAuthFailures + "/" + MAX_CONSECUTIVE_AUTH_FAILURES + "). Invalidating token cache and forcing reconnect...");
        try { resetTokenCache(); } catch (e) { /* best-effort */ }
        if (wsClient) {
          try { wsClient.close(); } catch (e) { /* already closing */ }
        }
        // Watchdog interval will trigger connectWithRetry() automatically
      }
    },
    // [FIX] Disabled REST resync on WS reconnect.
    // Calling tools.orders() here triggers fetchAccessToken() which can
    // invalidate the freshly-minted WS token (token-revoked → 401 loop).
    // Order state is synced by the main polling loop instead.
    onNeedResync: async function() {
      console.log("[ws] Reconnection detected. Skipping REST resync to protect WS token.");
    },
  });

  // Track WS state for watchdog
  let wsConnectedAt = 0;
  let wsReconnectAttempts = 0;
  let wsLastMessageAt = 0;
  let wsLastFailureAt = 0; // [DEEP-DEBUG FIX] track last failure to enforce cross-cycle backoff
  let wsReconnecting = false; // guard against concurrent reconnects
  const WS_WATCHDOG_INTERVAL_MS = 30000; // 30s
  const WS_MAX_RECONNECT_DELAY_MS = 300000; // 5min max

  async function connectWithRetry() {
    if (wsReconnecting) return; // prevent concurrent reconnect attempts
    // [DEEP-DEBUG FIX] Enforce backoff even across watchdog-triggered calls.
    // Previously, each watchdog tick (30s) could fire a fresh reconnect
    // regardless of the last failure, producing a tight reconnect storm.
    const now = Date.now();
    const backoffNeeded = Math.min(wsReconnectAttempts * 5000, WS_MAX_RECONNECT_DELAY_MS);
    if (wsLastFailureAt > 0 && (now - wsLastFailureAt) < backoffNeeded) {
      return; // still within backoff window; skip
    }
    wsReconnecting = true;
    // [DEEP-DEBUG FIX] Proactively clear the token cache before reconnecting
    // when auth failures have been observed. Without this, getToken() returns
    // the stale (but not timestamp-expired) cached token, and the handshake
    // fails with the same 401 on every attempt. The REST poller already does
    // this on auth errors, but the WS path did not — creating a divergence
    // where REST recovered but WS entered an infinite loop.
    if (consecutiveAuthFailures > 0) {
      try { resetTokenCache(); } catch {}
    }
    try {
      await wsClient.connect();
      wsClient.subscribe(buildCurrentSubs());
      // [DEEP-DEBUG FIX] Reset attempts only after a *sustained* connection
      // (a message or at least 30s of uptime), not immediately on open.
      // The ws.js "open" handler already resets its own counter; here we
      // mark success so the watchdog doesn't re-trigger.
      wsReconnectAttempts = 0;
      wsLastFailureAt = 0;
      wsConnectedAt = now;
    } catch (e) {
      wsReconnectAttempts++;
      selfAudit.recordWsReconnect();
      wsLastFailureAt = Date.now();
      const delay = Math.min(wsReconnectAttempts * 5000, WS_MAX_RECONNECT_DELAY_MS);
      console.error("[ws] Connect failed (attempt " + wsReconnectAttempts + "): " + e.message + " — retrying in " + (delay / 1000) + "s");
      var _reconnectDelay = setTimeout(function() { wsReconnecting = false; connectWithRetry(); }, delay);
      if (_reconnectDelay.unref) _reconnectDelay.unref();
      return;
    }
    wsReconnecting = false;
  }
  connectWithRetry();

  // WS watchdog: reconnect if not open
  // [DEEP-DEBUG FIX] Only log once per disconnected episode (not every 30s).
  let wsWatchdogWarnedAt = 0;
  var _wsWatchdogTimer = setInterval(function() {
    if (AI_MAX_PROFIT_PCT < 100 && targetEngine.project().halted) return;
    if (!wsClient || !wsClient.isOpen()) {
      const now = Date.now();
      // Throttle log: at most once per 2 minutes per disconnected episode
      if (now - wsWatchdogWarnedAt > 120000) {
        console.log("[ws-watchdog] Connection not open, attempting reconnect (attempts=" + wsReconnectAttempts + ")...");
        wsWatchdogWarnedAt = now;
      }
      connectWithRetry();
    } else {
      // Connection restored — reset throttle
      wsWatchdogWarnedAt = 0;
    }
  }, WS_WATCHDOG_INTERVAL_MS);
  if (_wsWatchdogTimer.unref) _wsWatchdogTimer.unref();

  console.log("[runner] Watching: " + universe.getAll().join(", "));
  console.log("[runner] Markets: KR(" + universe.getKR().length + "), US(" + universe.getUS().length + "), JP(" + universe.getJP().length + " via REST poll)");
  console.log("[runner] Dynamic Universe enabled. Max: " + (process.env.MAX_UNIVERSE_SIZE || 50));
  console.log("[runner] Bot is running. Press Ctrl+C to stop.");
  selfAudit.start(60000); // [L1 Self-Audit] Check rules every 60s

  // --- 7. Market REST polling loop (all markets, WS backup) ---
  const { getPrices, discoverSymbols } = require("./src/tossinvest");
  const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 45000);

  // Note: consecutiveAuthFailures, isAuthError, and backoff constants are
  // declared at module level (FIX #7) so fetchPortfolioContext shares state.

  // Throttle background poll logging to avoid spam during closed hours
  let lastBackgroundPollLog = 0;

  async function pollMarkets() {
    let _pollIter = 0;
    console.log("[rest-poll] pollMarkets loop STARTED (POLL_INTERVAL_MS=" + POLL_INTERVAL_MS + ", AI_MAX_PROFIT_PCT=" + AI_MAX_PROFIT_PCT + ")");
    while (true) {
      await new Promise(function(r) { var t = setTimeout(r, POLL_INTERVAL_MS); if (t.unref) t.unref(); });
      _pollIter++;
      var _proj = targetEngine.project();
      var _isHalted = AI_MAX_PROFIT_PCT < 100 && _proj.halted;
      if (_pollIter <= 3 || _pollIter % 10 === 0) {
        console.log("[rest-poll] iter=" + _pollIter + " halted=" + _isHalted + " phase=" + _proj.phase + " dryRun=" + _proj.dryRun);
      }
      if (_isHalted) continue;

      // [P0-2 Integration] Event calendar guard: check for imminent macro events
      // (FOMC, CPI, BOK, BOJ, NFP). During guard window, new BUYs are blocked
      // or sized down. This prevents entering positions right before high-impact
      // events that could gap through our stops.
      var eventCheck = eventGuard.check(new Date());
      if (eventCheck.active) {
        console.log("[event-guard] " + eventCheck.reason + " | sizeMult=" + eventCheck.sizeMultiplier + " blockBuys=" + eventCheck.blockNewBuys);
        audit.custom("event_guard", { active: true, event: eventCheck.event ? eventCheck.event.name : null, sizeMultiplier: eventCheck.sizeMultiplier, blockNewBuys: eventCheck.blockNewBuys });
      }

      // If we've hit max consecutive auth failures, halt polling with backoff
      if (consecutiveAuthFailures >= MAX_CONSECUTIVE_AUTH_FAILURES) {
        const backoffMs = Math.min(BASE_BACKOFF_MS * Math.pow(2, consecutiveAuthFailures - MAX_CONSECUTIVE_AUTH_FAILURES), MAX_BACKOFF_MS);
        console.error("[rest-poll] HALTED: " + consecutiveAuthFailures + " consecutive auth failures. " +
          "Toss credentials may be revoked or expired. Check Toss OpenAPI console. " +
          "Retrying in " + Math.round(backoffMs / 1000) + "s...");
        await new Promise(function(r) { var t = setTimeout(r, backoffMs); if (t.unref) t.unref(); });
        // Reset token cache before next attempt
        try { resetTokenCache(); } catch {}
        continue;
      }

      // Determine which markets to poll via REST
      const active = getActiveMarkets();
      const wsUp = wsClient && wsClient.isOpen();
      const allMarketsClosed = active.length === 0;
      // [FIX] Detect stale WS: connection is open but no messages received for 2min.
      // This catches the "silent failure" case where Toss WS server accepts the
      // connection but never sends subscription ack or price data.
      // Reduced from 5min to 2min for faster REST fallback activation.
      const WS_STALE_THRESHOLD_MS = 120000; // 2 minutes
      var _staleNow = Date.now();
      const wsStale = wsUp && (wsLastMessageAt === 0 || (_staleNow - wsLastMessageAt) > WS_STALE_THRESHOLD_MS);
      // [DIAG] Log market selection state for debugging
      if (_pollIter <= 3) {
        console.log("[rest-poll] state: active=" + JSON.stringify(active) + " wsUp=" + wsUp + " wsStale=" + wsStale + " allClosed=" + allMarketsClosed + " JP=" + universe.getJP().length + " KR=" + universe.getKR().length + " US=" + universe.getUS().length);
      }
      if (wsStale && wsLastMessageAt === 0 && wsConnectedAt > 0 && (_staleNow - wsConnectedAt) > 60000) {
        var _lastBgLog2 = _staleNow - (lastBackgroundPollLog || 0);
        if (_lastBgLog2 > 300000) {
          console.log("[rest-poll] WS stale: no messages since connect (" + Math.round((_staleNow - wsConnectedAt) / 1000) + "s ago) — forcing REST fallback");
          lastBackgroundPollLog = _staleNow;
        }
      } else if (wsStale && wsLastMessageAt > 0) {
        console.log("[rest-poll] WS stale: last message " + Math.round((_staleNow - wsLastMessageAt) / 1000) + "s ago — forcing REST fallback");
      }
      const wsEffectivelyUp = wsUp && !wsStale;
      const marketsToPoll = [];

      // [FIX] JP polling REMOVED — Toss Invest OpenAPI does NOT support JP market.
      // Official docs confirm only KR and US are supported. Polling JP always returns
      // empty array(0), wasting API quota. JP symbols remain in universe for reference
      // but are excluded from active data collection.

      // [FIX] US always polls via REST as backup — WS can silently fail (connected but
      // no data delivered). Parallel REST ensures data continuity even when WS is healthy.
      // KR only polls when WS is down/stale (KR market hours overlap with active WS).
      if (universe.getUS().length > 0 && (active.includes("US") || allMarketsClosed)) {
        marketsToPoll.push({ market: "US", codes: universe.getUS() });
      }
      if (!wsEffectivelyUp || allMarketsClosed) {
        if (universe.getKR().length > 0 && (active.includes("KR") || allMarketsClosed)) {
          marketsToPoll.push({ market: "KR", codes: universe.getKR() });
        }
        if (marketsToPoll.length > 0 && !wsEffectivelyUp && !allMarketsClosed) {
          console.log("[rest-poll] WS " + (wsStale ? "stale" : "down") + " — polling " + marketsToPoll.map(function(m) { return m.market + "(" + m.codes.length + ")"; }).join(", "));
        }
      }
      if (allMarketsClosed && marketsToPoll.length > 0) {
        var _bgNow = Date.now();
        if (_bgNow - lastBackgroundPollLog > 300000) {
          console.log("[rest-poll] All markets closed — background data collection: " + marketsToPoll.map(function(m) { return m.market + "(" + m.codes.length + ")"; }).join(", "));
          lastBackgroundPollLog = _bgNow;
        }
      }

      // [DIAG] Log marketsToPoll before entering the for loop
      if (_pollIter <= 3) {
        console.log("[rest-poll] marketsToPoll=" + JSON.stringify(marketsToPoll.map(function(m) { return { market: m.market, codes: m.codes.length }; })));
      }
      if (marketsToPoll.length === 0) continue;

      for (const { market, codes } of marketsToPoll) {
        // [DIAG] Log for-loop entry per market
        if (_pollIter <= 3) {
          console.log("[rest-poll] polling market=" + market + " codes=" + codes.length);
        }
        try {
          const token = await fetchAccessToken(TOSS_CLIENT_ID, TOSS_CLIENT_SECRET);
          if (_pollIter <= 3) {
            console.log("[rest-poll] " + market + " token OK, calling getPrices...");
          }
          const resp = await getPrices(token, codes);
          if (_pollIter <= 3) {
            console.log("[rest-poll] " + market + " getPrices returned, resp.body=" + (resp && resp.body ? (Array.isArray(resp.body) ? "array(" + resp.body.length + ")" : "object") : "null/undefined"));
          }
          // Success — reset failure counter
          consecutiveAuthFailures = 0;
          if (resp && resp.body) {
            const prices = Array.isArray(resp.body) ? resp.body : (resp.body.prices || [resp.body]);
            for (const p of prices) {
              selfAudit.recordPrice();
              const symbol = p.symbol || p.code || "";
              if (!symbol) continue;
              // [NOTIFY] Volume tracking for unusual-volume detection
              const vol = Number(p.volume || p.accVolume || p.tradeVolume || 0);
              if (vol > 0) {
                recordVolume(symbol, vol);
                try { checkUnusualVolume(symbol, vol); } catch (e) { /* silent */ }
              }
              // AI runs regardless of market hours — quality information > token cost savings.
              // Trade execution is still guarded by _executeDecisionInner() market-hours check.
              const marketData = { source: "rest-poll", market: market, symbol: symbol, price: p };
              const decision = await askAI(marketData);
              if (decision) await executeDecision(decision);
            }
          }
        } catch (e) {
          const msg = e.message || "";
          if (isAuthError(msg)) {
            consecutiveAuthFailures++;
            selfAudit.recordAuthFailure();
            const backoffMs = Math.min(BASE_BACKOFF_MS * Math.pow(2, consecutiveAuthFailures - 1), MAX_BACKOFF_MS);
            console.error("[rest-poll] " + market + " AUTH error (" + consecutiveAuthFailures + "/" + MAX_CONSECUTIVE_AUTH_FAILURES + "): " + msg +
              ". Backing off " + Math.round(backoffMs / 1000) + "s...");
            // Reset token cache so next attempt fetches fresh
            try { resetTokenCache(); } catch {}
            // Wait before trying next market to avoid rapid-fire token requests
            await new Promise(function(r) { var t = setTimeout(r, backoffMs); if (t.unref) t.unref(); });
            // If we've hit the limit mid-loop, break out of the market loop
            if (consecutiveAuthFailures >= MAX_CONSECUTIVE_AUTH_FAILURES) {
              console.error("[rest-poll] Max auth failures reached. Stopping this poll cycle.");
              break;
            }
          } else {
            // Non-auth errors: log but don't count toward auth backoff
            console.error("[rest-poll] " + market + " error: " + msg);
          }
        }
      }
    }
  }
  pollMarkets().catch(function(err) { console.error("[rest-poll] Fatal:", err); });

  // --- 8. Periodic Market Discovery Loop ---
  // [L4.5-HOTFIX] Reduced default from 30min to 10min for faster universe expansion.
  // First scan runs after a short startup delay (15s) instead of waiting full interval.
  const DISCOVERY_INTERVAL_MS = Number(process.env.DISCOVERY_INTERVAL_MS || 600000); // 10 min default
  const DISCOVERY_STARTUP_DELAY_MS = Number(process.env.DISCOVERY_STARTUP_DELAY_MS || 15000); // 15s after boot
  const MAX_UNIVERSE = Number(process.env.MAX_UNIVERSE_SIZE || 50);

  async function _runDiscoveryScan() {
    if (AI_MAX_PROFIT_PCT < 100 && targetEngine.project().halted) return;
    if (universe.symbols.size >= MAX_UNIVERSE) {
      console.log("[discovery] Universe at max capacity (" + MAX_UNIVERSE + "), skipping scan");
      return;
    }
    try {
      const token = await fetchAccessToken(TOSS_CLIENT_ID, TOSS_CLIENT_SECRET);
      const active = getActiveMarkets();
      const marketsToScan = active.length > 0 ? active : ["KR"];
      const targetMarket = marketsToScan[Math.floor(Math.random() * marketsToScan.length)];
      // Toss API only accepts: KOSPI, KOSDAQ, NYSE, NASDAQ, AMEX
      const tossMarkets = targetMarket === "US"
        ? ["NYSE", "NASDAQ"]
        : (targetMarket === "JP" ? ["KOSPI"] : ["KOSPI", "KOSDAQ"]); // JP fallback to KR
      const tossMarket = tossMarkets[Math.floor(Math.random() * tossMarkets.length)];
      console.log("[discovery] Scanning " + tossMarket + " for high-volume symbols...");
      const discovered = await discoverSymbols(token, tossMarket, 5);
      let addedCount = 0;
      for (const sym of discovered) {
        if (universe.symbols.size >= MAX_UNIVERSE) break;
        if (universe.add(sym)) addedCount++;
      }
      if (addedCount > 0) {
        console.log("[discovery] Added " + addedCount + " new symbols from " + targetMarket + ". Total: " + universe.symbols.size);
      }
    } catch (e) {
      console.error("[discovery] Scan failed: " + e.message);
    }
  }

  async function discoveryLoop() {
    // [L4.5-HOTFIX] Immediate initial scan after short startup delay (don't wait full interval)
    await new Promise(function(r) { var t = setTimeout(r, DISCOVERY_STARTUP_DELAY_MS); if (t.unref) t.unref(); });
    console.log("[discovery] Running initial scan (startup delay=" + DISCOVERY_STARTUP_DELAY_MS + "ms, interval=" + DISCOVERY_INTERVAL_MS + "ms)");
    await _runDiscoveryScan();
    while (true) {
      await new Promise(function(r) { var t = setTimeout(r, DISCOVERY_INTERVAL_MS); if (t.unref) t.unref(); });
      await _runDiscoveryScan();
    }
  }
  discoveryLoop().catch(function(err) { console.error("[discovery] Fatal:", err); });

  // --- [IMPROVE #7] Periodic Universe Quality Eviction (every 6 hours) ---
  const EVICTION_INTERVAL_MS = Number(process.env.EVICTION_INTERVAL_MS || 21600000); // 6h
  const EVICTION_MIN_TRADES = Number(process.env.EVICTION_MIN_TRADES || 5);
  const EVICTION_MAX_PER_CYCLE = Number(process.env.EVICTION_MAX_PER_CYCLE || 2);

  var _evictionTimer = setInterval(function() {
    if (targetEngine.project().halted) return;
    const worst = getWorstSymbols(EVICTION_MIN_TRADES, EVICTION_MAX_PER_CYCLE);
    for (const w of worst) {
      if (w.totalPnl < 0) {
        const removed = universe.remove(w.symbol);
        if (removed) {
          console.log("[eviction] Removed " + w.symbol + " (PnL=" + w.totalPnl.toFixed(0) + ", trades=" + w.trades + ", winRate=" + (w.trades > 0 ? ((w.wins / w.trades) * 100).toFixed(0) : 0) + "%)");
          journalEntry({ type: "SYMBOL_EVICTED", symbol: w.symbol, totalPnl: w.totalPnl, trades: w.trades });
        }
      }
    }
  }, EVICTION_INTERVAL_MS);
  if (_evictionTimer.unref) _evictionTimer.unref();

  // --- [P1-2] Start Symbol Max Loss Monitor ---
  var _symbolLossTimer = setInterval(function() { checkSymbolMaxLoss().catch(function(e) { console.error("[symbol-loss] Timer error: " + e.message); }); }, SYMBOL_LOSS_CHECK_MS);
  if (_symbolLossTimer.unref) _symbolLossTimer.unref();

  // --- [P8-1] Start Trailing Stop Monitor (every 90s, offset from max-loss check) ---
  const TRAILING_STOP_CHECK_MS = Number(process.env.TRAILING_STOP_CHECK_MS || 90000);
  var _trailingTimer = setInterval(function() { checkTrailingStops().catch(function(e) { console.error("[trailing-stop] Timer error: " + e.message); }); }, TRAILING_STOP_CHECK_MS);
  if (_trailingTimer.unref) _trailingTimer.unref();
  // --- [CASH-RESCUE] Start Held Position Sweep ---
  var _heldSweepTimer = setInterval(function() { heldPositionSweep().catch(function(e) { console.error("[held-sweep] Timer error: " + e.message); }); }, HELD_SWEEP_INTERVAL_MS);
  // [CASH-RESCUE] Clear pending sells when US market opens
  var _pendingCleanupTimer = setInterval(function() {
    try {
      var am = getActiveMarkets();
      if (am && am.includes("US") && pendingOffHoursSells.size > 0) {
        console.log("[held-sweep] US market open - clearing " + pendingOffHoursSells.size + " pending off-hours sells");
        pendingOffHoursSells.clear();
        _savePendingSells();
      }
    } catch (_e) {}
  }, 180000); // [FIX-EXEC-ERR] Reduced from 10min to 3min
  if (_pendingCleanupTimer.unref) _pendingCleanupTimer.unref();
  if (_heldSweepTimer.unref) _heldSweepTimer.unref();
  setTimeout(function() { heldPositionSweep().catch(function(e) { console.error("[held-sweep] Initial sweep error: " + e.message); }); }, 60000);


  // --- [P8-2] Adaptive Target Update (every 30 minutes) ---
  var _adaptiveTimer = setInterval(function() { updateAdaptiveTarget(); }, 1800000);
  if (_adaptiveTimer.unref) _adaptiveTimer.unref();

  // --- [P0-FIX] Periodic stale symbol data cleanup (every 2 hours) ---
  var _cleanupTimer = setInterval(function() {
    try { cleanupStaleSymbolData(); } catch (e) { console.error("[cleanup] Error: " + e.message); }
  }, 7200000);
  if (_cleanupTimer.unref) _cleanupTimer.unref();

  // --- [NOTIFY] Advanced Notification System (8 types) ---
  let _lastPhase = targetEngine.project().phase;
  let _drawdownMilestonesNotified = new Set();
  const DRAWDOWN_MILESTONES = [5, 10, 15, 20, 25, 30];
  let _lastWeeklySummaryWeek = -1;
  let _lastMonthlySummaryKey = -1;
  let _lastConcentrationAlertSymbol = "";
  let _lastConcentrationAlertAt = 0;
  let _taxLossNotifiedYear = -1;
  let _dividendCheckKey = "";
  const _volumeHistory = new Map();

  // 1. Weekly Summary (Sunday 22:00 KST = 13:00 UTC)
  function sendWeeklySummary() {
    var now = new Date();
    var weekStart = new Date(now);
    weekStart.setUTCDate(now.getUTCDate() - 6);
    var ws = weekStart.toISOString().slice(0, 10);
    var we = now.toISOString().slice(0, 10);
    var wt = tradeJournal.filter(function(e) { return e.timestamp && e.timestamp >= ws && e.type === "TRADE_EXECUTED"; });
    var buys = wt.filter(function(e) { return e.action === "BUY"; }).length;
    var sells = wt.filter(function(e) { return e.action === "SELL"; }).length;
    var errs = wt.filter(function(e) { return !e.ok; }).length;
    var tr = twrEngine.generateReport();
    var pj = targetEngine.project();
    var sc = {};
    wt.forEach(function(e) { if (e.symbol) sc[e.symbol] = (sc[e.symbol] || 0) + 1; });
    var top = Object.entries(sc).sort(function(a,b){return b[1]-a[1];}).slice(0,5).map(function(e){return e[0]+"("+e[1]+")";}).join(", ") || "N/A";
    var dd = pj.highWaterEquity && pj.currentEquity ? (((pj.highWaterEquity - pj.currentEquity) / pj.highWaterEquity) * 100).toFixed(2) : "N/A";
    var cr = tr.cumulative && tr.cumulative.return != null ? tr.cumulative.return : "N/A";
    var ot = tr.cumulative && tr.cumulative.onTrack ? "✅" : "❌";
    var msg = "📅 *Weekly Summary* (" + ws + " ~ " + we + ")\n" +
      "*Trades*: " + wt.length + " (B:" + buys + " S:" + sells + " E:" + errs + ")\n" +
      "*TWR cumul*: " + cr + "\n*On-track*: " + ot + "\n*DD*: " + dd + "%\n" +
      "*Phase*: " + pj.phase + " (" + pj.phaseName + ")\n*Top*: " + top;
    console.log("[weekly] " + msg.replace(/\n/g, " | "));
    sendTelegramAlert(msg);
    journalEntry({ type: "WEEKLY_SUMMARY", week: ws, trades: wt.length, buys: buys, sells: sells, errors: errs });
  }

  // 2. Drawdown Milestone (-5% ~ -30%)
  function checkDrawdownMilestone() {
    var pj = targetEngine.project();
    if (!pj.highWaterEquity || !pj.currentEquity || pj.highWaterEquity <= 0) return;
    var dd = ((pj.highWaterEquity - pj.currentEquity) / pj.highWaterEquity) * 100;
    for (var i = 0; i < DRAWDOWN_MILESTONES.length; i++) {
      var ms = DRAWDOWN_MILESTONES[i];
      var key = String(ms);
      if (dd >= ms && !_drawdownMilestonesNotified.has(key)) {
        _drawdownMilestonesNotified.add(key);
        var msg = "📉 *Drawdown -" + ms + "%*\nCurrent: " + dd.toFixed(2) + "%\n" +
          "HW: " + pj.highWaterEquity.toLocaleString() + " → " + pj.currentEquity.toLocaleString() + " KRW";
        console.log("[drawdown] -" + ms + "% reached: " + dd.toFixed(2) + "%");
        sendTelegramAlert(msg);
        journalEntry({ type: "DRAWDOWN_MILESTONE", milestone: ms, ddPct: Number(dd.toFixed(2)) });
      } else if (dd < ms - 2 && _drawdownMilestonesNotified.has(key)) {
        _drawdownMilestonesNotified.delete(key);

  // 3. Phase Escalation
  function checkPhaseEscalation() {
    var pj = targetEngine.project();
    if (pj.phase !== _lastPhase) {
      var old = _lastPhase;
      _lastPhase = pj.phase;
      var msg = "⬆️ *Phase Escalation*\n" + old + " → " + pj.phase + " (" + pj.phaseName + ")\n" +
        "Target: " + (pj.baseTargetPct * 100).toFixed(2) + "% daily";
      console.log("[phase] " + old + " → " + pj.phase);
      sendTelegramAlert(msg);
      journalEntry({ type: "PHASE_ESCALATION", from: old, to: pj.phase, phaseName: pj.phaseName });
    }
  }

  // 4. Dividend Season (Mar/Jun/Sep/Dec)
  async function checkDividendIncome() {
    var now = new Date();
    var m = now.getUTCMonth();
    if ([2,5,8,11].indexOf(m) === -1) return;
    var key = now.getUTCFullYear() + "-" + m;
    if (_dividendCheckKey === key) return;
    _dividendCheckKey = key;
    var msg = "💰 *Dividend Season*\n" + (m+1) + "월 — typical payout month.\nCheck Toss for dividend credits.";
    console.log("[dividend] " + (m+1) + "월");
    sendTelegramAlert(msg);
    journalEntry({ type: "DIVIDEND_SEASON", month: m+1, year: now.getUTCFullYear() });
  }

  // 5. Monthly P&L (1st of month 09:00 KST = 00:00 UTC)
  function sendMonthlyPnL() {
    var now = new Date();
    var lm = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    var ms = lm.toISOString().slice(0, 7);
    var mStart = lm.toISOString().slice(0, 10);
    var mEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).toISOString().slice(0, 10);
    var mt = tradeJournal.filter(function(e) {
      return e.timestamp && e.timestamp >= mStart && e.timestamp <= mEnd && e.type === "TRADE_EXECUTED";
    });
    var buys = mt.filter(function(e) { return e.action === "BUY"; }).length;
    var sells = mt.filter(function(e) { return e.action === "SELL"; }).length;
    var errs = mt.filter(function(e) { return !e.ok; }).length;
    var tr = twrEngine.generateReport();
    var pj = targetEngine.project();
    var cr = tr.cumulative && tr.cumulative.return != null ? tr.cumulative.return : "N/A";
    var ot = tr.cumulative && tr.cumulative.onTrack ? "✅" : "❌";
    var msg = "🎯 *Monthly P&L* (" + ms + ")\n" +
      "*Trades*: " + mt.length + " (B:" + buys + " S:" + sells + " E:" + errs + ")\n" +
      "*Cumul TWR*: " + cr + "\n*On-track*: " + ot + "\n" +
      "*Phase*: " + pj.phase + " (" + pj.phaseName + ")\n" +
      "*HW*: " + (pj.highWaterEquity || "N/A") + " KRW";
    console.log("[monthly] " + msg.replace(/\n/g, " | "));
    sendTelegramAlert(msg);
    journalEntry({ type: "MONTHLY_PNL", month: ms, trades: mt.length, buys: buys, sells: sells });

  // 6. Position Concentration (>20% single symbol)
  async function checkPositionConcentration() {
    try {
      var portfolio = await fetchPortfolioContext();
      var positions = portfolio.positions || [];
      if (positions.length === 0) return;
      var totalEq = computeTotalEquityKrw(portfolio);
      if (totalEq <= 0) return;
      for (var i = 0; i < positions.length; i++) {
        var pos = positions[i];
        if (!pos.marketValue || pos.marketValue <= 0) continue;
        var pct = (pos.marketValue / totalEq) * 100;
        if (pct > 20) {
          var now = Date.now();
          if (pos.symbol === _lastConcentrationAlertSymbol && (now - _lastConcentrationAlertAt) < 86400000) continue;
          _lastConcentrationAlertSymbol = pos.symbol;
          _lastConcentrationAlertAt = now;
          var msg = "🔍 *Concentration Alert*\n*" + pos.symbol + "*: " + pct.toFixed(1) + "% of equity\n" +
            "Value: " + pos.marketValue.toLocaleString() + " " + (pos.currency || "KRW") + "\n" +
            "Total: " + Math.round(totalEq).toLocaleString() + " KRW";
          console.log("[concentration] " + pos.symbol + " at " + pct.toFixed(1) + "%");
          sendTelegramAlert(msg);
          journalEntry({ type: "POSITION_CONCENTRATION", symbol: pos.symbol, pct: Number(pct.toFixed(2)) });
        }
      }
    } catch (e) { /* silent */ }
  }

  // 7. Unusual Volume (z-score > 3)
  function recordVolume(symbol, volume) {
    if (!symbol || !volume || volume <= 0) return;
    var arr = _volumeHistory.get(symbol);
    if (!arr) { arr = []; _volumeHistory.set(symbol, arr); }
    arr.push(volume);
    if (arr.length > 30) arr.shift();
  }
  function checkUnusualVolume(symbol, volume) {
    if (!symbol || !volume || volume <= 0) return;
    var arr = _volumeHistory.get(symbol);
    if (!arr || arr.length < 10) return;
    var mean = arr.reduce(function(a, b) { return a + b; }, 0) / arr.length;
    var variance = arr.reduce(function(a, b) { return a + (b - mean) * (b - mean); }, 0) / arr.length;
    var stddev = Math.sqrt(variance);
    if (stddev === 0) return;
    var z = (volume - mean) / stddev;
    if (z > 3) {
      var msg = "📊 *Volume Spike*\n*" + symbol + "*: " + volume.toLocaleString() + "\n" +
        "z-score: " + z.toFixed(2) + "σ (avg: " + Math.round(mean).toLocaleString() + ")";
      console.log("[volume-spike] " + symbol + " z=" + z.toFixed(2) + " vol=" + volume);
      sendTelegramAlert(msg);
      journalEntry({ type: "UNUSUAL_VOLUME", symbol: symbol, volume: volume, zscore: Number(z.toFixed(2)) });
    }
  }

  }

      }
    }
  }



  // 8. Tax-Loss Harvesting (Nov-Dec, once/year)
  async function checkTaxLossHarvesting() {
    var now = new Date();
    var month = now.getUTCMonth();
    if (month !== 10 && month !== 11) return;
    var year = now.getUTCFullYear();
    if (_taxLossNotifiedYear === year) return;
    try {
      var portfolio = await fetchPortfolioContext();
      var losers = (portfolio.positions || []).filter(function(p) {
        return p.profitLoss < 0 && p.quantity > 0;
      }).sort(function(a, b) { return a.profitLoss - b.profitLoss; }).slice(0, 5);
      if (losers.length === 0) return;
      var totalLoss = losers.reduce(function(s, p) { return s + p.profitLoss; }, 0);
      var lines = ["🏦 *Tax-Loss Harvesting*", "Year: " + year, "Top " + losers.length + " losses: " + totalLoss.toLocaleString() + " KRW", ""];
      losers.forEach(function(p) {
        var pnlPct = p.avgPrice > 0 ? ((p.currentPrice - p.avgPrice) / p.avgPrice * 100).toFixed(1) : "N/A";
        lines.push("• *" + p.symbol + "*: " + p.profitLoss.toLocaleString() + " KRW (" + pnlPct + "%)");
      });
      var msg = lines.join("\n");
      console.log("[tax-loss] " + losers.length + " losers, total=" + totalLoss);
      sendTelegramAlert(msg);
      journalEntry({ type: "TAX_LOSS_HARVESTING", year: year, losers: losers.length, totalLoss: totalLoss });
      _taxLossNotifiedYear = year;
    } catch (e) { /* silent */ }
  }

  console.log("[notify] Advanced notification system initialized (8 types).");

  // --- [NOTIFY] Periodic Timers ---
  // Weekly: Sunday 13:00 UTC (22:00 KST)
  setInterval(function() {
    var now = new Date();
    if (now.getUTCDay() === 0 && now.getUTCHours() === 13 && now.getUTCMinutes() < 5) {
      var jan1 = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
      var wn = Math.floor((now.getTime() - jan1.getTime()) / (7 * 86400000));
      if (_lastWeeklySummaryWeek !== wn) {
        _lastWeeklySummaryWeek = wn;
        try { sendWeeklySummary(); } catch (e) { console.error("[weekly] Error: " + e.message); }
      }
    }
  }, 60000);

  // Monthly: 1st 00:00 UTC (09:00 KST)
  setInterval(function() {
    var now = new Date();
    if (now.getUTCDate() === 1 && now.getUTCHours() === 0 && now.getUTCMinutes() < 5) {
      var mk = now.getUTCFullYear() * 100 + now.getUTCMonth();
      if (_lastMonthlySummaryKey !== mk) {
        _lastMonthlySummaryKey = mk;
        try { sendMonthlyPnL(); } catch (e) { console.error("[monthly] Error: " + e.message); }
      }
    }
  }, 60000);

  // Tax-loss: Nov-Dec 10:00 UTC (19:00 KST)
  setInterval(function() {
    var now = new Date();
    var m = now.getUTCMonth();
    if ((m === 10 || m === 11) && now.getUTCHours() === 10 && now.getUTCMinutes() < 5) {
      checkTaxLossHarvesting().catch(function(e) { console.error("[tax-loss] Error: " + e.message); });
    }
  }, 60000);

  // Dividend: 1st-3rd of Mar/Jun/Sep/Dec 11:00 UTC (20:00 KST)
  setInterval(function() {
    var now = new Date();
    var m = now.getUTCMonth();
    if ([2,5,8,11].indexOf(m) !== -1 && now.getUTCDate() <= 3 && now.getUTCHours() === 11 && now.getUTCMinutes() < 5) {
      checkDividendIncome().catch(function(e) { console.error("[dividend] Error: " + e.message); });
    }
  }, 60000);

  // --- [Phase D / L4.5] Evolution Engine Cycle (weekly GA optimization) ---
  if (evolutionEngine && EVOLUTION_ENABLED) {
    function runEvolutionCycle() {
      if (!EVOLUTION_CANDLES_PATH) {
        console.warn("[evolution] skipped — EVOLUTION_CANDLES_PATH not set");
        return;
      }
      let candles;
      try {
        candles = JSON.parse(fs.readFileSync(EVOLUTION_CANDLES_PATH, "utf8"));
      } catch (e) {
        console.error("[evolution] failed to load candles: " + e.message);
        return;
      }
      if (!Array.isArray(candles) || candles.length === 0) {
        console.error("[evolution] candles file empty or invalid");
        return;
      }
      // Create a fresh engine instance with current candles (stateless binding)
      const { createEvolutionEngine: mkEvo } = require("./src/orchestrator/evolution");
      const cycleEngine = mkEvo({
        runBacktest: require("./backtest").runBacktest,
        shadowMode: shadowMode,
        candles: candles,
        config: { populationSize: EVOLUTION_POPULATION, generations: EVOLUTION_GENERATIONS, mutationRate: EVOLUTION_MUTATION_RATE },
        onProposal: function(p) {
          console.log("[evolution] PROPOSED: " + p.param + " " + p.current + " → " + p.proposedValue);
          audit.config({ key: "evolution_propose_" + p.param, oldValue: p.current, newValue: p.proposedValue, source: "evolution" });
          sendTelegramAlert("🧬 *Evolution Proposal*\n" + p.param + ": " + p.current + " → " + p.proposedValue);
        },
        onGeneration: function(gs) {
          if (gs.generation === 0 || (gs.generation + 1) % 5 === 0) {
            console.log("[evolution] gen=" + gs.generation + " bestFit=" + gs.bestFitness.toFixed(3));
          }
        },
      });

      console.log("[evolution] === cycle start === candles=" + candles.length + " gens=" + EVOLUTION_GENERATIONS + " pop=" + EVOLUTION_POPULATION);
      const currentParams = { ...shadowMode.getActiveParams() };
      const { DEFAULT_GENE_BOUNDS } = require("./src/orchestrator/evolution");
      for (const [p, b] of Object.entries(DEFAULT_GENE_BOUNDS)) {
        if (currentParams[p] == null) currentParams[p] = b.default;
      }

      const result = cycleEngine.runAndPropose(
        { generations: EVOLUTION_GENERATIONS, populationSize: EVOLUTION_POPULATION },
        currentParams
      );

      console.log("[evolution] === cycle end === bestFit=" + (result.run.bestFitness || -Infinity).toFixed(3)
        + " accepted=" + (result.proposal.accepted || 0) + "/" + (result.proposal.total || 0));

      // [Phase H] Walk-forward validation gate — reject overfit parameters before deployment
      if (walkForwardValidator && result.run.bestGenome) {
        try {
          console.log("[phase-h] Running walk-forward validation on evolved parameters...");
          const wfResult = walkForwardValidator.validate({
            candles: candles,
            populationSize: Math.max(5, Math.floor(EVOLUTION_POPULATION / 2)), // lighter validation
            generations: Math.max(3, Math.floor(EVOLUTION_GENERATIONS / 2)),
          });
          walkForwardLastResult = wfResult;
          console.log("[phase-h] Walk-forward verdict: " + wfResult.verdict + " (reason: " + wfResult.reason + ")");
          // [Phase J] Feed walk-forward verdict to self-healer for PARAM_STALE detection
          try { selfHealer.tick({ walkForwardVerdict: wfResult.verdict }); } catch {}
          if (wfResult.summary) {
            console.log("[phase-h] OOS stats: avgSharpe=" + wfResult.summary.avgOosSharpe
              + ", avgDeg=" + wfResult.summary.avgDegradation + ", trades=" + wfResult.summary.totalOosTrades);
          }
          audit.config({ key: "walk_forward_validation", oldValue: null, newValue: {
            verdict: wfResult.verdict,
            reason: wfResult.reason,
            summary: wfResult.summary,
            ts: new Date().toISOString(),
          }, source: "walk-forward" });

          // Block deployment if walk-forward rejects
          if (wfResult.verdict === "reject") {
            console.warn("[phase-h] Walk-forward REJECTED evolved parameters — blocking deployment to prevent overfitting");
            sendTelegramAlert("🚫 *Walk-Forward Rejection*\nEvolved parameters failed OOS validation.\nReason: " + wfResult.reason + "\nKeeping current parameters.", "warning");
            audit.config({ key: "evolution_cycle", oldValue: null, newValue: {
              bestFitness: result.run.bestFitness,
              accepted: 0, // Force zero acceptance
              total: result.proposal.total || 0,
              blocked: true,
              blockReason: "walk_forward_reject",
              ts: new Date().toISOString(),
            }, source: "evolution" });
            return; // Exit early, do not apply evolved parameters
          }
        } catch (e) {
          console.error("[phase-h] Walk-forward validation error: " + e.message);
          // Continue with evolution on validation error (fail-open)
        }
      }

      audit.config({ key: "evolution_cycle", oldValue: null, newValue: {
        bestFitness: result.run.bestFitness,
        accepted: result.proposal.accepted || 0,
        total: result.proposal.total || 0,
        ts: new Date().toISOString(),
      }, source: "evolution" });
    }

    // Schedule first cycle after 5 minutes, then every EVOLUTION_INTERVAL_HOURS
    const intervalMs = EVOLUTION_INTERVAL_HOURS * 3600 * 1000;
    var _evolutionTimer = setInterval(runEvolutionCycle, intervalMs);
    if (_evolutionTimer.unref) _evolutionTimer.unref();
    setTimeout(runEvolutionCycle, 5 * 60 * 1000);
    console.log("[phase-d] Evolution cycle scheduled (interval=" + EVOLUTION_INTERVAL_HOURS + "h, first run in 5min)");
  }

  // --- [Phase E] Strategy Orchestrator Periodic Rebalance (every 4 hours) ---
  const ORCH_REBALANCE_INTERVAL_MS = Number(process.env.ORCH_REBALANCE_INTERVAL_MS || 14400000); // 4h
  var _orchRebalanceTimer = setInterval(function() {
    if (targetEngine.project().halted) return;
    try {
      const stats = strategyOrchestrator.stats();
      if (stats.totalStrategies === 0) return;
      const result = strategyOrchestrator.rebalance();
      if (result && result.ok) {
        audit.config({
          key: "orchestrator_rebalance",
          oldValue: null,
          newValue: {
            allocation: result.allocation,
            changes: (result.changes || []).length,
            ts: new Date().toISOString(),
          },
          source: "orchestrator",
        });
      } else if (result && result.reason) {
        console.log("[orchestrator] Rebalance skipped: " + result.reason);
      }
    } catch (e) {
      console.error("[orchestrator] Rebalance error: " + e.message);
    }
  }, ORCH_REBALANCE_INTERVAL_MS);
  if (_orchRebalanceTimer.unref) _orchRebalanceTimer.unref();
  // Schedule first rebalance after 2 minutes
  setTimeout(function() {
    try { strategyOrchestrator.rebalance(); } catch (e) { /* best-effort */ }
  }, 2 * 60 * 1000);
  console.log("[phase-e] Orchestrator rebalance scheduled (interval=" + (ORCH_REBALANCE_INTERVAL_MS / 3600000).toFixed(1) + "h, first run in 2min)");

  // --- [Phase F] Portfolio Risk Computation (hourly) ---
  const RISK_INTERVAL_MS = Number(process.env.RISK_INTERVAL_MS || 3600000); // 1h
  var _riskTimer = setInterval(function() {
    if (targetEngine.project().halted) return;
    try {
      const positions = targetEngine.project().positions || [];
      if (positions.length === 0) return;
      // Build diagonal covariance from per-position ATR or default 2% vol
      const vols = positions.map(function(p) {
        return Number(p.atrPct || 0.02);
      });
      const cov = portfolioRisk.buildDiagonalCov(vols);
      const risk = portfolioRisk.portfolioVaR(positions, cov);
      if (risk.totalVaR > 0) {
        audit.config({
          key: "portfolio_risk",
          oldValue: null,
          newValue: {
            totalVaR: risk.totalVaR,
            varPct: risk.varPct,
            totalValue: risk.totalValue,
            topContributor: risk.component.length > 0
              ? risk.component.reduce(function(a, b) { return a.contributionPct > b.contributionPct ? a : b; })
              : null,
            ts: new Date().toISOString(),
          },
          source: "risk_engine",
        });
        // Alert if VaR exceeds 80% of budget
        var budget = risk.totalValue * (portfolioRisk.config.riskBudgetPct / 100);
        if (risk.totalVaR > budget * 0.8) {
          sendTelegramAlert("⚠️ *Risk Warning*\nPortfolio VaR " + risk.totalVaR.toFixed(0) + " (" + (risk.varPct * 100).toFixed(1) + "%) exceeds 80% of budget " + budget.toFixed(0));
        }
      }
    } catch (e) {
      console.error("[risk-engine] Portfolio risk computation error: " + e.message);
    }
  }, RISK_INTERVAL_MS);
  if (_riskTimer.unref) _riskTimer.unref();
  // Schedule first risk computation after 3 minutes
  setTimeout(function() {
    try {
      var positions = targetEngine.project().positions || [];
      if (positions.length > 0) {
        var vols = positions.map(function(p) { return Number(p.atrPct || 0.02); });
        var cov = portfolioRisk.buildDiagonalCov(vols);
        var risk = portfolioRisk.portfolioVaR(positions, cov);
        if (risk.totalVaR > 0) {
          console.log("[risk-engine] Initial VaR: " + risk.totalVaR.toFixed(0) + " (" + (risk.varPct * 100).toFixed(1) + "% of portfolio)");
        }
      }
    } catch (e) { /* best-effort */ }
  }, 3 * 60 * 1000);
  console.log("[phase-f] Risk engine scheduled (interval=" + (RISK_INTERVAL_MS / 3600000).toFixed(1) + "h, first run in 3min)");

  // --- [Phase G] Regime HMM Snapshot (hourly, piggybacks risk timer cadence) ---
  var _regimeTimer = setInterval(function() {
    if (targetEngine.project().halted) return;
    try {
      if (!regimeHMM || !regimeHMM.trained) return;
      var lastRet = _hmmReturnsBuffer.length > 0 ? _hmmReturnsBuffer[_hmmReturnsBuffer.length - 1] : null;
      var feats = lastRet != null ? [lastRet, Math.abs(lastRet), lastRet] : null;
      var f = feats ? regimeHMM.filterOnline(feats) : null;
      audit.config({
        key: "regime_hmm",
        oldValue: null,
        newValue: {
          label: f ? f.label : "unknown",
          prob: f ? f.prob : 0,
          probs: f ? f.probs : [],
          multiplier: regimeHMM.getPositionMultiplier(feats),
          observations: _hmmReturnsBuffer.length,
          trainRuns: regimeHMM.history.length,
          ts: new Date().toISOString(),
        },
        source: "regime_hmm",
      });
      if (f && f.label !== "unknown") {
        console.log("[phase-g] Regime snapshot: " + f.label + " (p=" + f.prob + ", mult=" + regimeHMM.getPositionMultiplier(feats).toFixed(2) + "x, obs=" + _hmmReturnsBuffer.length + ")");
      }
    } catch (e) {
      console.error("[phase-g] Regime snapshot error: " + e.message);
    }
  }, RISK_INTERVAL_MS);
  if (_regimeTimer.unref) _regimeTimer.unref();
  console.log("[phase-g] Regime HMM snapshot scheduled (interval=" + (RISK_INTERVAL_MS / 3600000).toFixed(1) + "h)");

  // --- [Phase H] Walk-Forward Periodic Validation (daily by default) ---
  const WF_VALIDATION_INTERVAL_MS = Number(process.env.WF_VALIDATION_INTERVAL_MS || 86400000); // 24h
  if (walkForwardValidator && EVOLUTION_CANDLES_PATH) {
    var _wfTimer = setInterval(function() {
      if (targetEngine.project().halted) return;
      try {
        var candles;
        try {
          candles = JSON.parse(fs.readFileSync(EVOLUTION_CANDLES_PATH, "utf8"));
        } catch (e) {
          console.error("[phase-h] Failed to load candles for periodic validation: " + e.message);
          return;
        }
        if (!Array.isArray(candles) || candles.length === 0) return;
        console.log("[phase-h] Periodic walk-forward validation starting (candles=" + candles.length + ")");
        var wfResult = walkForwardValidator.validate({
          candles: candles,
          populationSize: Math.max(5, Math.floor(EVOLUTION_POPULATION / 2)),
          generations: Math.max(3, Math.floor(EVOLUTION_GENERATIONS / 2)),
        });
        walkForwardLastResult = wfResult;
        console.log("[phase-h] Periodic walk-forward verdict: " + wfResult.verdict + " (" + wfResult.reason + ")");
        audit.config({ key: "walk_forward_periodic", oldValue: null, newValue: {
          verdict: wfResult.verdict,
          reason: wfResult.reason,
          summary: wfResult.summary,
          ts: new Date().toISOString(),
        }, source: "walk-forward" });
        if (wfResult.verdict === "reject") {
          sendTelegramAlert("⚠️ *Walk-Forward Periodic Check*\nOOS validation degraded: " + wfResult.reason + "\nConsider reviewing evolved parameters.", "warning");
        }
      } catch (e) {
        console.error("[phase-h] Periodic walk-forward error: " + e.message);
      }
    }, WF_VALIDATION_INTERVAL_MS);
    if (_wfTimer.unref) _wfTimer.unref();
    console.log("[phase-h] Walk-forward periodic validation scheduled (interval=" + (WF_VALIDATION_INTERVAL_MS / 3600000).toFixed(1) + "h)");
  } else {
    console.log("[phase-h] Walk-forward periodic validation skipped (validator=" + !!walkForwardValidator + ", candlesPath=" + !!EVOLUTION_CANDLES_PATH + ")");
  }

  // [Phase I / L4.5] Periodic meta-cognition calibration (every 1h)
  var META_COG_CALIBRATION_INTERVAL_MS = Number(process.env.META_COG_CALIBRATION_INTERVAL_MS || 3600000);
  var _mcCalTimer = setInterval(function() {
    try {
      var _mcCal = metaCognition.calibrate();
      var _mcStats = metaCognition.stats();
      console.log("[meta-cog] Periodic calibration: calibrated=" + _mcCal.calibrated +
        " rho=" + (_mcCal.rho != null ? _mcCal.rho : "n/a") +
        " totalDecisions=" + _mcStats.totalDecisions +
        " weak=" + _mcStats.weakDecisions + " strong=" + _mcStats.strongDecisions);
      if (_mcCal.calibrated) {
        journalEntry({ type: "META_COG_CALIBRATION", rho: _mcCal.rho, sampleSize: _mcCal.sampleSize, weights: _mcCal.suggestedWeights || null });
        // [Phase J] Feed calibration rho to self-healer for DATA_DRIFT detection
        try { selfHealer.tick({ calibrationRho: _mcCal.rho }); } catch {}
      }
    } catch (e) { console.error("[meta-cog] periodic calibration failed: " + e.message); }
  }, META_COG_CALIBRATION_INTERVAL_MS);
  if (_mcCalTimer.unref) _mcCalTimer.unref();
  console.log("[phase-i] Meta-cognition periodic calibration scheduled (interval=" + (META_COG_CALIBRATION_INTERVAL_MS / 60000).toFixed(0) + "min)");

  // --- [Phase R / L4.5] Reflection Engine periodic cycle — analyze recent signals, discover blind spots ---
  var REFLECTION_INTERVAL_MS = Number(process.env.REFLECTION_INTERVAL_MS || 1800000); // 30min
  var _reflTimer = setInterval(function() {
    try {
      signalCollector.tick();
      var report = reflectionEngine.generateReport();
      var summary = report.summary;
      var bsCount = (report.blindSpots || []).length;
      console.log("[phase-r] Reflection report: events1h=" + summary.totalEvents1h +
        " alerts1h=" + summary.alerts1h +
        " decisions1h=" + summary.decisions1h +
        " fills1h=" + summary.fills1h +
        " patterns=" + (report.patterns || []).length +
        " blindSpots=" + bsCount +
        " recs=" + (report.recommendations || []).length);
      if (bsCount > 0) {
        try { selfHealer.tick({ reflectionBlindSpots: bsCount }); } catch {}
      }
      // [Phase R-2] Cross-layer correlation cycle
      try {
        if (correlationEngine) {
          var _corrResult = correlationEngine.correlateIncidentsWithPnL({});
          var _corrAnom = correlationEngine.detectAnomalies();
          if (_corrResult.significant || _corrAnom.length > 0) {
            console.log("[phase-r2] correlation: r=" + _corrResult.r + " lag=" + (_corrResult.lagHours || 0) + "h anomalies=" + _corrAnom.length);
          }
        }
      } catch (e) { console.error("[phase-r2] correlation cycle failed: " + e.message); }
      // [Phase R-2] Hypothesis generation cycle
      try {
        if (hypothesisEngine) {
          var _newHyps = hypothesisEngine.generateHypotheses();
          var _ranked = hypothesisEngine.rankProposals();
          if (_newHyps.length > 0) {
            console.log("[phase-r2] hypotheses: new=" + _newHyps.length + " pending=" + hypothesisEngine.stats().pending + " topScore=" + (_ranked[0] ? _ranked[0].score : "n/a"));
          }
          // Journal top-ranked hypothesis if high impact
          if (_ranked.length > 0 && _ranked[0].expectedImpact === "high") {
            journalEntry({ type: "REFLECTION_HYPOTHESIS", hypId: _ranked[0].id, hypType: _ranked[0].type, score: _ranked[0].score, action: _ranked[0].action });
          }
        }
      } catch (e) { console.error("[phase-r2] hypothesis cycle failed: " + e.message); }
      // [Phase R-3] Auto-loop: evaluate top hypotheses and launch experiments
      try {
        if (autoLoop) {
          var _loopResult = autoLoop.evaluate();
          if (_loopResult.actions.length > 0) {
            console.log("[phase-r3] auto-loop: actions=" + _loopResult.actions.length + " experiments=" + _loopResult.actions.filter(a => a.action === "launched_experiment").length);
          }
        }
      } catch (e) { console.error("[phase-r3] auto-loop cycle failed: " + e.message); }
      // [Phase R-4] Outcome feedback: propagate experiment verdicts to hypotheses
      try {
        if (outcomeFeedback) {
          var _fbResult = outcomeFeedback.tick();
          if (_fbResult.processed.length > 0) {
            console.log("[phase-r4] outcome-feedback: processed=" + _fbResult.processed.length +
              " confirmed=" + _fbResult.processed.filter(function(p) { return p.confirmed; }).length);
          }
          // [Phase R-5] For each confirmed hypothesis, re-invoke its registered action
          // so parameter changes become permanent (auto-loop's initial invocation may
          // have been dry-run or pre-experiment). This closes the full loop.
          if (actionRegistry && hypothesisEngine && _fbResult.processed.length > 0) {
            var _r5Applied = 0;
            for (var _fi = 0; _fi < _fbResult.processed.length; _fi++) {
              var _fb = _fbResult.processed[_fi];
              if (!_fb.confirmed) continue;
              var _hypList = hypothesisEngine.getHypotheses ? hypothesisEngine.getHypotheses(500) : [];
              var _hyp = null;
              for (var _hi = 0; _hi < _hypList.length; _hi++) {
                if (_hypList[_hi].id === _fb.hypothesisId) { _hyp = _hypList[_hi]; break; }
              }
              if (_hyp && _hyp.type && actionRegistry._handlers && typeof actionRegistry._handlers[_hyp.type] === "function") {
                try {
                  var _ar = actionRegistry._handlers[_hyp.type](_hyp);
                  if (_ar && _ar.ok) _r5Applied++;
                } catch (_e5) { /* ignore */ }
              }
            }
            if (_r5Applied > 0) {
              console.log("[phase-r5] confirmed-hypothesis actuation: applied=" + _r5Applied);
            }
          }
        }
      } catch (e) { console.error("[phase-r4] outcome-feedback cycle failed: " + e.message); }
      // [Phase R-6] Regime advisor tick — auto-generate regime-shift hypotheses
      try {
        _r6DeferredInit(); // ensure regimeAdvisor/evolutionBridge are created
        if (regimeAdvisor) {
          var _r6Regime = regimeAdvisor.tick();
          if (_r6Regime && _r6Regime.hypotheses && _r6Regime.hypotheses.length > 0) {
            console.log("[phase-r6] regime-advisor: hypotheses=" + _r6Regime.hypotheses.length +
              " label=" + (_r6Regime.regime ? _r6Regime.regime.label : "?"));
          }
        }
      } catch (e) { console.error("[phase-r6] regime-advisor cycle failed: " + e.message); }
      // [Phase R-6] Evolution bridge sync — GA→hypothesis and hypothesis→GA
      try {
        if (evolutionBridge) {
          var _r6FromGA = evolutionBridge.syncFromEvolution();
          var _r6ToGA = evolutionBridge.syncToEvolution();
          if ((_r6FromGA && _r6FromGA.hypotheses && _r6FromGA.hypotheses.length > 0) ||
              (_r6ToGA && _r6ToGA.seeds > 0)) {
            console.log("[phase-r6] evolution-bridge: fromGA=" +
              ((_r6FromGA && _r6FromGA.hypotheses) ? _r6FromGA.hypotheses.length : 0) +
              " toGA=" + ((_r6ToGA && _r6ToGA.seeds) || 0));
          }
        }
      } catch (e) { console.error("[phase-r6] evolution-bridge cycle failed: " + e.message); }
      // [Phase R-6] Degradation detector — detect performance degradation, auto-generate upgrade hypotheses
      try {
        if (degradationDetector) {
          var _r6PerfCheck = degradationDetector.check();
          if (_r6PerfCheck && _r6PerfCheck.degraded) {
            console.log("[phase-r6] degradation-detector: DEGRADED reasons=" + (_r6PerfCheck.reasons || []).join(",") +
              " hypotheses=" + ((_r6PerfCheck.hypotheses || []).length));
            journalEntry({ type: "PERFORMANCE_DEGRADATION", reasons: _r6PerfCheck.reasons, metrics: _r6PerfCheck.metrics });
          }
        }
      } catch (e) { console.error("[phase-r6] degradation-detector cycle failed: " + e.message); }
      // [Phase R-6] Blind-spot bridge — convert reflection blind spots into hypotheses
      try {
        if (blindSpotBridge) {
          var _r6BS = blindSpotBridge.tick();
          if (_r6BS && _r6BS.hypotheses && _r6BS.hypotheses.length > 0) {
            console.log("[phase-r6] blindspot-bridge: hypotheses=" + _r6BS.hypotheses.length +
              " blindSpotsTotal=" + (_r6BS.blindSpotsTotal || 0));
          }
        }
      } catch (e) { console.error("[phase-r6] blindspot-bridge cycle failed: " + e.message); }
      // [Phase R-6] Persistence save — atomically persist R-2~R-5 state
      try {
        if (persistence) {
          var _r6Save = persistence.save();
          if (_r6Save && _r6Save.ok) {
            // Silent unless verbose — persistence is routine
          }
        }
      } catch (e) { console.error("[phase-r6] persistence save failed: " + e.message); }
      for (var _ri = 0; _ri < (report.recommendations || []).length; _ri++) {
        var _rec = report.recommendations[_ri];
        if (_rec.priority === "high") {
          journalEntry({ type: "REFLECTION_RECOMMENDATION", recType: _rec.type, description: _rec.description, priority: _rec.priority });
        }
      }
    } catch (e) { console.error("[phase-r] reflection cycle failed: " + e.message); }
  }, REFLECTION_INTERVAL_MS);
  if (_reflTimer.unref) _reflTimer.unref();
  console.log("[phase-r] Reflection periodic cycle scheduled (interval=" + (REFLECTION_INTERVAL_MS / 60000).toFixed(0) + "min)");


  // [P1-5 Integration] Prometheus metrics HTTP endpoint
  const PROMETHEUS_PORT = Number(process.env.PROMETHEUS_PORT || 9100);
  try {
    const http = require("node:http");
    const promServer = http.createServer(function(req, res) {
      if (req.url === "/metrics" || req.url === "/metrics/") {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(perfMonitor.toPrometheus());
      } else if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        try {
          var _mcHealthStats = metaCognition.stats();
          var _shHealthStats = selfHealer.stats();
          var _confHealthStats = confidenceCalibrator ? confidenceCalibrator.stats() : null;
          res.end(JSON.stringify({
            status: "ok",
            uptime: process.uptime(),
            metaCognition: {
              totalDecisions: _mcHealthStats.totalDecisions,
              strongDecisions: _mcHealthStats.strongDecisions,
              weakDecisions: _mcHealthStats.weakDecisions,
              outcomesAttached: _mcHealthStats.outcomesAttached,
              calibrations: _mcHealthStats.calibrations,
              lastCalibrationRho: _mcHealthStats.lastCalibrationRho,
              threshold: _mcHealthStats.threshold,
            },
            selfHealing: {
              activeMitigations: _shHealthStats.activeMitigations,
              historySize: _shHealthStats.historySize,
              countsPerType: _shHealthStats.countsPerType,
              escalationThreshold: _shHealthStats.escalationThreshold,
            },
            confidence: _confHealthStats ? {
              enabled: true,
              totalEvaluations: _confHealthStats.totalEvaluations,
              lowConfidenceCount: _confHealthStats.lowConfidenceCount,
              lastConfidence: _confHealthStats.lastConfidence,
              avgConfidence: _confHealthStats.avgConfidence,
              minThreshold: _confHealthStats.minThreshold,
              sampleCount: _confHealthStats.sampleCount,
            } : { enabled: false },
            lifecycle: lifecycleManager ? Object.assign({ enabled: true }, lifecycleManager.stats()) : { enabled: false },
            crossMarket: crossMarketScanner ? Object.assign({ enabled: true }, crossMarketScanner.stats()) : { enabled: false },
            marketIntel: marketIntel ? Object.assign({ enabled: true }, marketIntel.stats()) : { enabled: false },
            escalation: escalationManager ? Object.assign({ enabled: true }, escalationManager.stats()) : { enabled: false },
            selfAudit: selfAudit ? Object.assign({ enabled: true }, selfAudit.getMetrics()) : { enabled: false },
            reflection: eventBus ? Object.assign({ enabled: true }, reflectionEngine.stats(), { eventBus: eventBus.stats() }) : { enabled: false },
            // [P12-AI] AI success rate metrics — enables monitoring of 95% target
            ai: {
              successes: aiSuccesses,
              failures: aiFailures,
              total: aiSuccesses + aiFailures,
              successRatePct: (aiSuccesses + aiFailures) > 0
                ? Math.round((aiSuccesses / (aiSuccesses + aiFailures)) * 10000) / 100
                : null,
              consecutiveFailures: aiConsecutiveFailures,
              parseErrorPct: aiRouter && typeof aiRouter.parseErrorPct === "function"
                ? Math.round(aiRouter.parseErrorPct() * 10000) / 100
                : null,
              parseWindow: aiRouter && typeof aiRouter.parseWindowStats === "function"
                ? aiRouter.parseWindowStats()
                : null,
              providers: aiRouter && typeof aiRouter.stats === "function"
                ? aiRouter.stats().providers
                : null,
              // [P12-AI] Global failure reason breakdown for root-cause monitoring
              failureReasons: aiRouter && typeof aiRouter.stats === "function"
                ? (aiRouter.stats().globalFailureReasons || null)
                : null,
              lastUsedProvider: aiRouter && typeof aiRouter.lastUsedProvider === "function"
                ? aiRouter.lastUsedProvider()
                : null,
            },
          }));
        } catch (e) {
          res.end(JSON.stringify({ status: "ok", uptime: process.uptime(), metaCognitionError: e.message }));
        }
    } else if (req.url === "/reflection") {
      try {
        const snap = experimentCoordinator && typeof experimentCoordinator.getSnapshot === "function"
          ? experimentCoordinator.getSnapshot()
          : { enabled: false };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, reflection: snap }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      } else if (req.url === "/knowledge") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(knowledgeStore.stats()));
      } else if (req.url === "/meta-cognition" || req.url === "/meta-cognition/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        try {
          var _mcDetailStats = metaCognition.stats();
          var _mcWeak = metaCognition.getWeakDecisions().slice(0, 20);
          var _mcStrong = metaCognition.getStrongDecisions().slice(0, 20);
          res.end(JSON.stringify({
            stats: _mcDetailStats,
            weakDecisions: _mcWeak.map(function(w) {
              return { id: w.id, aggregate: w.aggregate, scores: w.scores, ts: w.ts, outcome: w.outcome };
            }),
            strongDecisions: _mcStrong.map(function(w) {
              return { id: w.id, aggregate: w.aggregate, scores: w.scores, ts: w.ts, outcome: w.outcome };
            }),
            pendingOutcomes: metaCogDecisionMap.size,
          }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (req.url === "/self-healing" || req.url === "/self-healing/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        try {
          var _shDetailStats = selfHealer.stats();
          var _shActive = selfHealer.getActiveMitigations();
          var _shHistory = selfHealer.getHistory(50);
          res.end(JSON.stringify({
            stats: _shDetailStats,
            activeMitigations: _shActive,
            recentHistory: _shHistory,
          }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (req.url === "/confidence" || req.url === "/confidence/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        try {
          var _confStats = confidenceCalibrator ? confidenceCalibrator.stats() : null;
          var _confHistory = confidenceCalibrator ? confidenceCalibrator.getHistory(20) : [];
          res.end(JSON.stringify({
            enabled: !!confidenceCalibrator,
            stats: _confStats,
            recentHistory: _confHistory,
          }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (req.url === "/lifecycle" || req.url === "/lifecycle/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        try {
          if (!lifecycleManager) {
            res.end(JSON.stringify({ enabled: false }));
          } else {
            res.end(JSON.stringify({
              enabled: true,
              stats: lifecycleManager.stats(),
              strategies: lifecycleManager.listStrategies(),
              recentHistory: lifecycleManager.getHistory(30),
            }));
          }
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (req.url === "/reflection" || req.url === "/reflection/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        try {
          res.end(JSON.stringify({
            enabled: true,
            stats: reflectionEngine.stats(),
            recentFindings: reflectionEngine.getHistory(10),
            eventBus: eventBus.stats(),
          }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (req.url === "/reflection/report" || req.url === "/reflection/report/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        try {
          var _reflReport = reflectionEngine.generateReport();
          res.end(JSON.stringify(_reflReport));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (req.url === "/reflection/events" || req.url === "/reflection/events/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        try {
          var _reflEvents = eventBus.query({ limit: 200 });
          res.end(JSON.stringify({ count: _reflEvents.length, events: _reflEvents }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (req.url === "/reflection/correlation" || req.url === "/reflection/correlation/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        try {
          res.end(JSON.stringify({
            enabled: !!correlationEngine,
            stats: correlationEngine ? correlationEngine.stats() : null,
            incidentPnl: correlationEngine ? correlationEngine.correlateIncidentsWithPnL({}) : null,
            alertPerformance: correlationEngine ? correlationEngine.correlateAlertsWithPerformance({}) : null,
            matrix: correlationEngine ? correlationEngine.correlationMatrix() : null,
            anomalies: correlationEngine ? correlationEngine.detectAnomalies() : [],
            history: correlationEngine ? correlationEngine.getHistory(20) : [],
          }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (req.url === "/reflection/hypotheses" || req.url === "/reflection/hypotheses/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        try {
          res.end(JSON.stringify({
            enabled: !!hypothesisEngine,
            stats: hypothesisEngine ? hypothesisEngine.stats() : null,
            ranked: hypothesisEngine ? hypothesisEngine.rankProposals() : [],
            recent: hypothesisEngine ? hypothesisEngine.getHypotheses(30) : [],
            outcomes: hypothesisEngine ? hypothesisEngine.getOutcomes(10) : [],
          }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (req.url === "/reflection/attribution" || req.url === "/reflection/attribution/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        try {
          res.end(JSON.stringify({
            enabled: !!attributionEngine,
            stats: attributionEngine ? attributionEngine.stats() : null,
            report: attributionEngine ? attributionEngine.report() : null,
            topContributors: attributionEngine ? attributionEngine.topContributors(10) : [],
            bottomContributors: attributionEngine ? attributionEngine.bottomContributors(10) : [],
          }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (req.url === "/reflection/experiments" || req.url === "/reflection/experiments/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        try {
          res.end(JSON.stringify({
            enabled: !!experimentEngine,
            stats: experimentEngine ? experimentEngine.stats() : null,
            running: experimentEngine ? experimentEngine.list("running") : [],
            evaluated: experimentEngine ? experimentEngine.list("evaluated") : [],
          }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (req.url === "/reflection/auto-loop" || req.url === "/reflection/auto-loop/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        try {
          res.end(JSON.stringify({
            enabled: !!autoLoop,
            stats: autoLoop ? autoLoop.stats() : null,
            history: autoLoop ? autoLoop.getHistory(20) : [],
          }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (req.url === "/reflection/outcome-feedback" || req.url === "/reflection/outcome-feedback/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        try {
          res.end(JSON.stringify({
            enabled: !!outcomeFeedback,
            stats: outcomeFeedback ? outcomeFeedback.stats() : null,
            processed: outcomeFeedback ? outcomeFeedback.getProcessed().slice(-50) : [],
            history: outcomeFeedback ? outcomeFeedback.getHistory(30) : [],
          }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (req.url === "/reflection/param-tuner" || req.url === "/reflection/param-tuner/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        try {
          res.end(JSON.stringify({
            enabled: !!paramTuner,
            stats: paramTuner ? paramTuner.stats() : null,
            history: paramTuner ? paramTuner.getHistory(30) : [],
          }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (req.url === "/reflection/traffic-splitter" || req.url === "/reflection/traffic-splitter/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        try {
          res.end(JSON.stringify({
            enabled: !!trafficSplitter,
            stats: trafficSplitter ? trafficSplitter.stats() : null,
            experiments: trafficSplitter ? trafficSplitter.list() : [],
            history: trafficSplitter ? trafficSplitter.getHistory(30) : [],
          }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (req.url === "/reflection/action-registry" || req.url === "/reflection/action-registry/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        try {
          res.end(JSON.stringify({
            enabled: !!actionRegistry,
            stats: actionRegistry ? actionRegistry.stats() : null,
            audit: actionRegistry ? actionRegistry.getAudit(30) : [],
          }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (req.url && req.url.startsWith("/lifecycle/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        try {
          if (!lifecycleManager) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: "lifecycle disabled" }));
          } else {
            var _lcId = req.url.slice("/lifecycle/".length).replace(/\/+$/, "");
            var _lcStrat = lifecycleManager.getStrategy(_lcId);
            if (!_lcStrat) {
              res.writeHead(404);
              res.end(JSON.stringify({ error: "strategy not found: " + _lcId }));
            } else {
              var _lcRetireCheck = lifecycleManager.checkRetirement(_lcId);
              res.end(JSON.stringify({
                strategy: _lcStrat,
                retirementCheck: _lcRetireCheck,
              }));
            }
          }
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (req.url === "/cross-market" || req.url === "/cross-market/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        try {
          if (!crossMarketScanner) {
            res.end(JSON.stringify({ enabled: false }));
          } else {
            res.end(JSON.stringify({
              enabled: true,
              stats: crossMarketScanner.stats(),
              pairs: crossMarketScanner.listPairs(),
              recentHistory: crossMarketScanner.getHistory(30),
            }));
          }
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (req.url === "/news" || req.url === "/news/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        try {
          if (!marketIntel) {
            res.end(JSON.stringify({ enabled: false }));
          } else {
            res.end(JSON.stringify({
              enabled: true,
              stats: marketIntel.stats(),
              sources: marketIntel.sources(),
              news: marketIntel.latestNews({ limit: 30 }),
              sentiment: marketIntel.sentiment(),
            }));
          }
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (req.url === "/sentiment" || req.url === "/sentiment/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        try {
          if (!marketIntel) {
            res.end(JSON.stringify({ enabled: false }));
          } else {
            res.end(JSON.stringify({
              enabled: true,
              fearGreed: marketIntel.sentiment(),
              stats: marketIntel.stats(),
            }));
          }
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (req.url === "/escalation" || req.url === "/escalation/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        try {
          if (!escalationManager) {
            res.end(JSON.stringify({ enabled: false }));
          } else {
            res.end(JSON.stringify({
              enabled: true,
              stats: escalationManager.stats(),
              pending: escalationManager.getPending(),
              recentHistory: escalationManager.getHistory(30),
            }));
          }
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (req.url === "/escalation/respond" && req.method === "POST") {
        var body = "";
        req.on("data", function(chunk) { body += chunk; });
        req.on("end", function() {
          res.writeHead(200, { "Content-Type": "application/json" });
          try {
            if (!escalationManager) {
              res.end(JSON.stringify({ error: "escalation disabled" }));
            } else {
              var parsed = JSON.parse(body);
              var result = escalationManager.respond(parsed.escalationId, parsed.optionId);
              res.end(JSON.stringify(result));
            }
          } catch (e) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      } else if (req.url === "/goal-bridge" || req.url === "/goal-bridge/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        try {
          if (!goalBridge) {
            res.end(JSON.stringify({ enabled: false }));
          } else {
            res.end(JSON.stringify({
              enabled: true,
              stats: goalBridge.stats(),
              recentHistory: goalBridge.getHistory(30),
            }));
          }
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (req.url === "/mcp-bridge" || req.url === "/mcp-bridge/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        try {
          if (!mcpBridge) {
            res.end(JSON.stringify({ enabled: false }));
          } else {
            res.end(JSON.stringify({
              enabled: true,
              stats: mcpBridge.stats(),
              tools: mcpBridge.getToolDefinitions(),
            }));
          }
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (req.url === "/mcp-bridge/handle" && req.method === "POST") {
        var mcpBody = "";
        req.on("data", function(chunk) { mcpBody += chunk; });
        req.on("end", async function() {
          res.writeHead(200, { "Content-Type": "application/json" });
          try {
            if (!mcpBridge) {
              res.end(JSON.stringify({ error: "mcp bridge disabled" }));
            } else {
              var mcpParsed = JSON.parse(mcpBody);
              var mcpResult = await mcpBridge.handle(mcpParsed.tool, mcpParsed.args || {});
              res.end(JSON.stringify(mcpResult));
            }
          } catch (e) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: e.message, code: e.code || null }));
          }
        });
      } else if (req.url === "/audit-federation" || req.url === "/audit-federation/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        try {
          if (!auditFederation) {
            res.end(JSON.stringify({ enabled: false }));
          } else {
            res.end(JSON.stringify({
              enabled: true,
              stats: auditFederation.stats(),
              routes: auditFederation.getRoutes(),
              recentHistory: auditFederation.getHistory(30),
            }));
          }
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (req.url === "/web-tools" || req.url === "/web-tools/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        try {
          if (!webTools) {
            res.end(JSON.stringify({ enabled: false }));
          } else {
            res.end(JSON.stringify({
              enabled: true,
              stats: webTools.stats(),
              schemas: webTools.getSchemas().map(function(s) { return s.function.name; }),
            }));
          }
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (req.url === "/admin/resume" && req.method === "POST") {
        // [P2-11] Admin endpoint: clear halt state and optionally reset daily baseline.
        // Body: { "resetBaseline": true, "equity": 61423540 } (optional)
        var resumeBody = "";
        req.on("data", function(chunk) { resumeBody += chunk; });
        req.on("end", function() {
          res.writeHead(200, { "Content-Type": "application/json" });
          try {
            var parsed = resumeBody ? JSON.parse(resumeBody) : {};
            var prev = targetEngine.getEffectiveLimits();
            targetEngine.resume();
            if (parsed.resetBaseline && parsed.equity > 0) {
              targetEngine.resetDailyBaseline(parsed.equity, parsed.date || null);
            }
            var after = targetEngine.getEffectiveLimits();
            console.log("[admin] /admin/resume: halted " + prev.halted + " -> " + after.halted);
            res.end(JSON.stringify({
              ok: true,
              previous: { halted: prev.halted, phase: prev.phase },
              current: { halted: after.halted, phase: after.phase, dailyBaselineEquity: after.dailyBaselineEquity },
            }));
          } catch (e) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      } else if (req.url === "/admin/state" || req.url === "/admin/state/") {
        // [P2-11] Admin endpoint: dump full target engine state for diagnostics
        res.writeHead(200, { "Content-Type": "application/json" });
        try {
          res.end(JSON.stringify({
            statePath: targetStatePath,
            limits: targetEngine.getEffectiveLimits(),
            project: targetEngine.project(),
            fullState: targetEngine.getState(),
          }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (req.url === "/admin/advance-phase" && req.method === "POST") {
        // [P2-11] Admin endpoint: force phase advancement (emergency use)
        var advBody = "";
        req.on("data", function(chunk) { advBody += chunk; });
        req.on("end", function() {
          res.writeHead(200, { "Content-Type": "application/json" });
          try {
            var parsed = advBody ? JSON.parse(advBody) : {};
            var phaseId = Number(parsed.phaseId) || 1;
            var reason = parsed.reason || "admin manual advance";
            var prev = targetEngine.getPhase();
            var ok = targetEngine.advancePhaseDirect(phaseId, reason);
            res.end(JSON.stringify({ ok: ok, previousPhase: prev, newPhase: targetEngine.getPhase() }));
          } catch (e) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      } else if (req.url === "/admin/reset-self-healing" && req.method === "POST") {
        // [DEBUG] Admin endpoint: force-reset self-healing mitigations (manual override)
        var rshBody = "";
        req.on("data", function(chunk) { rshBody += chunk; });
        req.on("end", function() {
          res.writeHead(200, { "Content-Type": "application/json" });
          try {
            var before = selfHealer ? selfHealer.getActiveMitigations() : {};
            var cleared = Object.keys(before);
            if (selfHealer && typeof selfHealer.reset === "function") {
              selfHealer.reset();
            }
            console.log("[admin] Self-healing reset. Cleared: " + (cleared.length ? cleared.join(",") : "(none)"));
            res.end(JSON.stringify({ ok: true, cleared: cleared, previousActive: before }));
          } catch (e) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      } else {
        res.writeHead(404);
        res.end("Not found. Endpoints: /metrics, /health, /knowledge, /meta-cognition, /self-healing, /confidence, /lifecycle, /cross-market, /escalation, /goal-bridge, /mcp-bridge, /audit-federation, /web-tools, /reflection, /news, /sentiment, /admin/resume, /admin/state, /admin/advance-phase, /admin/reset-self-healing");
      }
    });
    promServer.listen(PROMETHEUS_PORT, function() {
      console.log("[prometheus] Metrics server listening on port " + PROMETHEUS_PORT + " (/metrics, /health, /knowledge, /meta-cognition, /self-healing, /confidence, /lifecycle, /cross-market, /escalation, /news, /sentiment)");
    });
    promServer.on("error", function(e) {
      console.error("[prometheus] Server error: " + e.message);
    });
  } catch (e) {
    console.error("[prometheus] Failed to start: " + e.message);
  }
}

// --- [P1-4] Graceful Shutdown State Persistence ---
// [P2-10 FIX] Persist runner state to the durable volume (/app/state) so that
// entryPrices, peakPrices, etc. survive container recreation. Previously stored
// under __dirname which lives in the ephemeral container layer and was lost on
// redeploy, causing SELL P&L to fall back to info.price and report false losses.
const RUNNER_STATE_PATH = path.join(
  process.env.STATE_DIR || path.join(__dirname, "state"),
  ".runner-state.json"
);

function dumpRunnerState() {
  try {
    var state = {
      pendingOrders: Array.from(pendingOrders.entries()),
      entryPrices: Array.from(entryPrices.entries()),
      symbolPerformance: Array.from(symbolPerformance.entries()),
      peakPrices: Array.from(peakPrices.entries()),
      atrStopPrices: Array.from(atrStopPrices.entries()), // [Phase 4.3] persist hard stops
      recentFills: recentFills.slice(), // [P10-4] Persist recent fills across restarts
      aiMetrics: { successes: aiSuccesses, failures: aiFailures },
      adaptiveTargetOffset: adaptiveTargetOffset,
      trailingStopTriggers: trailingStopTriggers,
      atrHardStopTriggers: atrHardStopTriggers,
      // [Phase H] Walk-forward validation history
      walkForwardHistory: walkForwardValidator ? walkForwardValidator.getHistory() : [],
      walkForwardLastResult: walkForwardLastResult,
      // [Phase I / L4.5] Meta-cognition state
      metaCognition: metaCognition ? metaCognition.stats() : null,
      metaCogDecisionMap: Array.from(metaCogDecisionMap.entries()),
      // [Phase J / L4.5] Self-healing state
      selfHealing: selfHealer ? selfHealer.state() : null,
      // [Phase K / L4.5] Confidence calibration state
      confidence: confidenceCalibrator ? confidenceCalibrator.state() : null,
      // [Phase L / L4.5] Strategy lifecycle state (strategies, history, idCounter)
      lifecycle: lifecycleManager ? lifecycleManager.state() : null,
      // [Phase M / L4.5] Cross-market scanner state (pairs, history, counters)
      crossMarket: crossMarketScanner ? crossMarketScanner.state() : null,
      // [Phase N / L4.5] Escalation manager state (counters, dailyCounts, cooldowns, history)
      escalation: escalationManager ? escalationManager.state() : null,
      // [P1-4] Goal bridge state (goalIds, history, counters)
      goalBridge: goalBridge ? goalBridge.state() : null,
      // [Phase R / L4.5] Reflection engine event bus state
      reflectionEventBus: eventBus ? eventBus.state() : null,
      // [Phase R-2] Correlation findings + hypothesis list
      correlationHistory: correlationEngine ? correlationEngine.getHistory(100) : [],
      correlationStats: correlationEngine ? correlationEngine.stats() : null,
      hypotheses: hypothesisEngine ? hypothesisEngine.getHypotheses(200) : [],
      hypothesisOutcomes: hypothesisEngine ? hypothesisEngine.getOutcomes(50) : [],
      hypothesisStats: hypothesisEngine ? hypothesisEngine.stats() : null,
      // [Phase R-3] Attribution + experiment + auto-loop state
      attributionStats: attributionEngine ? attributionEngine.stats() : null,
      experimentStats: experimentEngine ? experimentEngine.stats() : null,
      autoLoopStats: autoLoop ? autoLoop.stats() : null,
      autoLoopHistory: autoLoop ? autoLoop.getHistory(50) : [],
      // [Phase R-4] Outcome feedback state
      outcomeFeedbackStats: outcomeFeedback ? outcomeFeedback.stats() : null,
      outcomeFeedbackHistory: outcomeFeedback ? outcomeFeedback.getHistory(50) : [],
      outcomeFeedbackProcessed: outcomeFeedback ? outcomeFeedback.getProcessed().slice(-100) : [],
      // [Phase R-5] Execution layer state
      paramTunerStats: paramTuner ? paramTuner.stats() : null,
      paramTunerHistory: paramTuner ? paramTuner.getHistory(50) : [],
      trafficSplitterStats: trafficSplitter ? trafficSplitter.stats() : null,
      trafficSplitterExperiments: trafficSplitter ? trafficSplitter.list() : [],
      actionRegistryStats: actionRegistry ? actionRegistry.stats() : null,
      actionRegistryAudit: actionRegistry ? actionRegistry.getAudit(50) : [],
      dumpedAt: new Date().toISOString(),
    };
    // [Phase 4.3] Atomic write: tmp file + rename prevents corruption on crash mid-write
    var tmpPath = RUNNER_STATE_PATH + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmpPath, RUNNER_STATE_PATH);
    console.log("[state] Dumped runner state to " + RUNNER_STATE_PATH);
  } catch (e) {
    console.error("[state] Failed to dump: " + e.message);
  }
}

function restoreRunnerState() {
  try {
    if (!fs.existsSync(RUNNER_STATE_PATH)) return;
    var raw = JSON.parse(fs.readFileSync(RUNNER_STATE_PATH, "utf8"));
    if (raw.pendingOrders && Array.isArray(raw.pendingOrders)) {
      for (var po of raw.pendingOrders) pendingOrders.set(po[0], po[1]);
      console.log("[state] Restored " + raw.pendingOrders.length + " pending orders");
    }
    if (raw.entryPrices && Array.isArray(raw.entryPrices)) {
      for (var ep of raw.entryPrices) entryPrices.set(ep[0], ep[1]);
      console.log("[state] Restored " + raw.entryPrices.length + " entry prices");
    }
    if (raw.symbolPerformance && Array.isArray(raw.symbolPerformance)) {
      for (var sp of raw.symbolPerformance) symbolPerformance.set(sp[0], sp[1]);
      console.log("[state] Restored " + raw.symbolPerformance.length + " symbol performance records");
    }
    if (raw.peakPrices && Array.isArray(raw.peakPrices)) {
      for (var pp of raw.peakPrices) peakPrices.set(pp[0], pp[1]);
      console.log("[state] Restored " + raw.peakPrices.length + " peak prices");
    }
    if (raw.atrStopPrices && Array.isArray(raw.atrStopPrices)) {
      for (var asp of raw.atrStopPrices) atrStopPrices.set(asp[0], asp[1]);
      console.log("[state] Restored " + raw.atrStopPrices.length + " ATR hard stops");
    }
    if (raw.atrHardStopTriggers != null) atrHardStopTriggers = raw.atrHardStopTriggers;
    if (raw.aiMetrics) {
      aiSuccesses = raw.aiMetrics.successes || 0;
      aiFailures = raw.aiMetrics.failures || 0;
      console.log("[state] Restored AI metrics: success=" + aiSuccesses + ", failures=" + aiFailures);
    }
    // [P10-4] Restore recent fills ring buffer
    if (raw.recentFills && Array.isArray(raw.recentFills)) {
      recentFills.length = 0;
      for (var rf of raw.recentFills) recentFills.push(rf);
      console.log("[state] Restored " + raw.recentFills.length + " recent fills");
    }
    if (typeof raw.adaptiveTargetOffset === "number") {
      adaptiveTargetOffset = raw.adaptiveTargetOffset;
      console.log("[state] Restored adaptive target offset: " + adaptiveTargetOffset);
    }
    if (typeof raw.trailingStopTriggers === "number") {
      trailingStopTriggers = raw.trailingStopTriggers;
    }
    // [Phase H] Restore walk-forward validation history
    if (raw.walkForwardHistory && Array.isArray(raw.walkForwardHistory) && walkForwardValidator) {
      for (var wfh of raw.walkForwardHistory) {
        walkForwardValidator.getHistory().push(wfh);
      }
      console.log("[state] Restored " + raw.walkForwardHistory.length + " walk-forward validation records");
    }
    if (raw.walkForwardLastResult) {
      walkForwardLastResult = raw.walkForwardLastResult;
      console.log("[state] Restored walk-forward last result: " + (walkForwardLastResult.verdict || "unknown"));
    }
    // [Phase I / L4.5] Restore meta-cognition decision map for SELL outcome linkage
    if (raw.metaCogDecisionMap && Array.isArray(raw.metaCogDecisionMap)) {
      for (var mcdm of raw.metaCogDecisionMap) {
        metaCogDecisionMap.set(mcdm[0], mcdm[1]);
      }
      console.log("[state] Restored " + raw.metaCogDecisionMap.length + " meta-cognition decision mappings");
    }
    // [Phase J / L4.5] Restore self-healing state (history, active mitigations, counters)
    if (raw.selfHealing && selfHealer) {
      selfHealer.restore(raw.selfHealing);
      var _shRestored = selfHealer.stats();
      console.log("[state] Restored self-healing state: history=" + _shRestored.historySize + ", active=" + _shRestored.activeMitigations);
    }
    // [Phase K / L4.5] Restore confidence calibration state (history, counters)
    if (raw.confidence && confidenceCalibrator) {
      confidenceCalibrator.restore(raw.confidence);
      var _confRestored = confidenceCalibrator.stats();
      console.log("[state] Restored confidence state: history=" + _confRestored.historySize + ", evaluations=" + _confRestored.totalEvaluations);
    }
    // [Phase L / L4.5] Restore strategy lifecycle state (strategies, history, idCounter)
    if (raw.lifecycle && lifecycleManager) {
      lifecycleManager.restore(raw.lifecycle);
      var _lcRestored = lifecycleManager.stats();
      console.log("[state] Restored lifecycle state: strategies=" + _lcRestored.totalStrategies + ", history=" + _lcRestored.historySize);
    }
    // [P2-LIFECYCLE] Register already-active strategies from orchestrator into lifecycle.
    // This must run AFTER restore() so that persisted state does not overwrite the registration.
    // Idempotent: registerExisting() skips if the strategy name already exists.
    if (lifecycleManager && strategyOrchestrator) {
      try {
        var _lcAlloc = strategyOrchestrator.getAllocation();
        var _lcStratNames = Object.keys(_lcAlloc);
        for (var _lci = 0; _lci < _lcStratNames.length; _lci++) {
          var _lcName = _lcStratNames[_lci];
          var _lcWeight = _lcAlloc[_lcName] || 0;
          var _lcReg = lifecycleManager.registerExisting({
            name: _lcName,
            allocationPct: _lcWeight,
            parameters: { source: "orchestrator_auto_register" },
          });
          console.log("[phase-l] Registered existing strategy: " + _lcName + " (alloc=" + (_lcWeight * 100).toFixed(1) + "%, phase=" + _lcReg.phase + ", existing=" + _lcReg.existing + ")");
        }
        var _lcStatsAfter = lifecycleManager.stats();
        console.log("[phase-l] Post-restore lifecycle: strategies=" + _lcStatsAfter.totalStrategies + ", production=" + (_lcStatsAfter.byPhase.production || 0));
      } catch (_lcRegErr) {
        console.error("[phase-l] Failed to register existing strategies: " + _lcRegErr.message);
      }
    }
    // [Phase M / L4.5] Restore cross-market scanner state (pairs, history, counters)
    if (raw.crossMarket && crossMarketScanner) {
      crossMarketScanner.restore(raw.crossMarket);
      var _cmRestored = crossMarketScanner.stats();
      console.log("[state] Restored cross-market state: scans=" + _cmRestored.scans + ", history=" + _cmRestored.historySize);
    }
    // [Phase N / L4.5] Restore escalation manager state (counters, dailyCounts, cooldowns, history)
    if (raw.escalation && escalationManager) {
      escalationManager.restore(raw.escalation);
      var _escRestored = escalationManager.stats();
      console.log("[state] Restored escalation state: total=" + _escRestored.total + ", responded=" + _escRestored.responded + ", timedOut=" + _escRestored.timedOut);
    }
    // [P1-4] Restore goal bridge state (goalIds, history, counters)
    if (raw.goalBridge && goalBridge) {
      goalBridge.restore(raw.goalBridge);
      var _gbRestored = goalBridge.stats();
      console.log("[state] Restored goal bridge state: mappings=" + _gbRestored.activeGoalMappings);
    }
    // [Phase R / L4.5] Restore reflection event bus state
    if (raw.reflectionEventBus && eventBus) {
      eventBus.restore(raw.reflectionEventBus);
      var _ebRestored = eventBus.stats();
      console.log("[state] Restored reflection event bus: events=" + _ebRestored.currentSize + ", types=" + _ebRestored.uniqueTypes);
    }
    // [Phase R-2] Correlation and hypothesis engines are stateless beyond their eventBus dependency,
    // but we preserve statistical counters and accumulated findings for continuity across restarts.
    // correlationEngine and hypothesisEngine read from eventBus which is already restored above,
    // so their next cycle will rebuild findings naturally. No explicit restore needed.

    // Remove state file after successful restore to prevent stale data on next crash
    try { fs.unlinkSync(RUNNER_STATE_PATH); } catch {}
  } catch (e) {
    console.error("[state] Failed to restore: " + e.message);
  }
}

// Restore state before starting
restoreRunnerState();

process.on("SIGTERM", function() {
  console.log("[runner] SIGTERM received. Dumping state...");
  dumpRunnerState();
  metrics.stop();
  if (wsClient) wsClient.close();
  fileLogger.close();
  process.exit(0);
});
process.on("SIGINT", function() {
  console.log("[runner] SIGINT received. Dumping state...");
  dumpRunnerState();
  metrics.stop();
  if (wsClient) wsClient.close();
  fileLogger.close();
  process.exit(0);
});
start().catch(function(err) { console.error("[runner] Fatal:", err); process.exit(1); });
