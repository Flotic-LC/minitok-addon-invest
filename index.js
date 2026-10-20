"use strict";

/**
 * minitok-addon-tossinvest — entry point.
 *
 * A standalone add-on that registers a Toss Securities (토스증권) Open API
 * adapter into a minitok adapter registry. minitok does not know about this
 * package; integration happens exclusively through minitok's public
 * registerAdapter() extension point, from the outside.
 *
 * Usage (from a host script / runner, not from inside minitok):
 *
 *   const { createAdapterRegistry } = require("<minitok>/src/goal/adapter_registry");
 *   const { registerTossInvestAddon } = require("minitok-addon-tossinvest");
 *
 *   const registry = createAdapterRegistry();
 *   registerTossInvestAddon(registry, {
 *     minitokRoot: "C:/path/to/minitok-client-release",
 *     credentials: { clientId: "...", clientSecret: "..." },
 *     safetyLimits: { maxOrderValueKrw: 1000000, allowedSymbols: ["kr:005930"] },
 *   });
 *
 * minitok's registerAdapter validates the descriptor against ADAPTER_KINDS
 * (the adapter uses kind "api"), so an invalid descriptor fails closed here
 * rather than being silently swallowed.
 */

const path = require("node:path");
const { createTossInvestAdapter, ...api } = require("./src/tossinvest");
const { createAgentTools, createSafety, createTargetEngine, createEquitySnapshotter, resetTargetEngineState, TARGET_PHASES, DEFAULT_STATE_PATH } = require("./src/agent");
const { createAuditLogger } = require("./src/core/audit-logger");
const { validateConfig, SCHEMA: CONFIG_SCHEMA } = require("./src/core/config-validator");
const { createConnectionManager, STATES: CONN_STATES } = require("./src/core/connection-manager");
const { checkCorrelation, adjustForCorrelation } = require("./src/agent/correlation");
const { createEventGuard } = require("./src/strategy/event-calendar");
const { computeDynamicRisk } = require("./src/strategy/dynamic-risk");
const { createProviderRouter } = require("./src/ai/provider-router");
const { createMultiAccountManager, STRATEGIES: MA_STRATEGIES } = require("./src/agent/multi-account");
const { createKnowledgeStore } = require("./src/strategy/knowledge-store");
const { createPerformanceMonitor } = require("./src/agent/performance-monitor");
const { createStrategyRegistry } = require("./src/strategy/registry");
// [Phase M] Cross-market arbitrage scanner
const { createCrossMarketScanner, DEFAULTS: CROSS_MARKET_DEFAULTS } = require("./src/intelligence/cross-market");
// [Phase N] Human escalation protocol
const { createEscalationManager, DEFAULTS: ESCALATION_DEFAULTS, SEVERITIES: ESCALATION_SEVERITIES } = require("./src/orchestrator/escalation");

function resolveMinitokRoot(options = {}) {
  return options.minitokRoot
    || process.env.MINITOK_CLIENT_ROOT
    || path.join(__dirname, "..", "minitok-client-release");
}

/**
 * Register the Toss Securities adapter into an existing minitok adapter registry.
 *
 * @param {Map} registry - a registry created by minitok's createAdapterRegistry()
 * @param {object} options - { minitokRoot, credentials, safetyLimits }
 * @returns {object} the registered adapter descriptor
 */
function registerTossInvestAddon(registry, options = {}) {
  if (!(registry instanceof Map)) {
    throw new TypeError("registerTossInvestAddon: registry must be a minitok adapter registry (Map)");
  }
  const minitokRoot = resolveMinitokRoot(options);
  const { registerAdapter } = require(path.join(minitokRoot, "src", "goal", "adapter_registry"));
  const descriptor = createTossInvestAdapter(options.credentials || {}, options.safetyLimits || {});
  return registerAdapter(registry, descriptor);
}

module.exports = {
  createTossInvestAdapter,
  registerTossInvestAddon,
  resolveMinitokRoot,
  createAgentTools,
  createSafety,
  createTargetEngine,
  createEquitySnapshotter,
  resetTargetEngineState,
  TARGET_PHASES,
  DEFAULT_STATE_PATH,
  // [P2-8] Audit
  createAuditLogger,
  // [P2-11] Config validation
  validateConfig,
  CONFIG_SCHEMA,
  // [P2-10] Connection state machine
  createConnectionManager,
  CONN_STATES,
  // [P1-6] Correlation-aware sizing
  checkCorrelation,
  adjustForCorrelation,
  // [P1-7] Event calendar guard
  createEventGuard,
  // [P0-4] Dynamic risk parameters
  computeDynamicRisk,
  // [P0-3] Multi-provider LLM router
  createProviderRouter,
  // [P3-14] Multi-account manager
  createMultiAccountManager,
  MA_STRATEGIES,
  // [P3-15] Knowledge store (self-improvement)
  createKnowledgeStore,
  // [P2-9] Performance monitor + Prometheus
  createPerformanceMonitor,
  // [P3-12] Strategy plugin registry
  createStrategyRegistry,
  // [Phase M] Cross-market arbitrage scanner (L4.5)
  createCrossMarketScanner,
  CROSS_MARKET_DEFAULTS,
  // [Phase N] Human escalation protocol (L4.5)
  createEscalationManager,
  ESCALATION_DEFAULTS,
  ESCALATION_SEVERITIES,
  ...api,
};
