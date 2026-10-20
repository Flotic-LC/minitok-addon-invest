"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const {
  loadConstitution,
  parseYaml,
  parseScalar,
  mapToKillswitchConfig,
  mapToApprovalGateConfig,
  mapToCouncilConfig,
  mapToHardLimits,
  mapToSelfModificationConfig,
} = require("../src/core/constitution-loader");

// ---------------------------------------------------------------------------
// parseScalar
// ---------------------------------------------------------------------------

test("parseScalar: numbers", function() {
  assert.equal(parseScalar("3.0"), 3.0);
  assert.equal(parseScalar("42"), 42);
  assert.equal(parseScalar("0.6"), 0.6);
  assert.equal(parseScalar("50000000"), 50000000);
});

test("parseScalar: booleans and null", function() {
  assert.equal(parseScalar("true"), true);
  assert.equal(parseScalar("false"), false);
  assert.equal(parseScalar("null"), null);
  assert.equal(parseScalar("~"), null);
  assert.equal(parseScalar(""), null);
});

test("parseScalar: quoted strings", function() {
  assert.equal(parseScalar('"hello"'), "hello");
  assert.equal(parseScalar("'world'"), "world");
  assert.equal(parseScalar('"09:00"'), "09:00");
});

test("parseScalar: unquoted strings", function() {
  assert.equal(parseScalar("telegram"), "telegram");
  assert.equal(parseScalar("HOLD"), "HOLD");
});

test("parseScalar: inline arrays", function() {
  const arr = parseScalar('["pnl", "trades", "win_rate"]');
  assert.deepEqual(arr, ["pnl", "trades", "win_rate"]);
});

test("parseScalar: empty inline array", function() {
  assert.deepEqual(parseScalar("[]"), []);
});

// ---------------------------------------------------------------------------
// parseYaml — basic structures
// ---------------------------------------------------------------------------

test("parseYaml: flat key-value pairs", function() {
  const doc = parseYaml('version: "1.0.0"\nname: test\ncount: 42');
  assert.equal(doc.version, "1.0.0");
  assert.equal(doc.name, "test");
  assert.equal(doc.count, 42);
});

test("parseYaml: nested objects", function() {
  const yaml = [
    "risk_limits:",
    "  daily_max_loss_pct: 3.0",
    "  max_open_positions: 15",
  ].join("\n");
  const doc = parseYaml(yaml);
  assert.equal(doc.risk_limits.daily_max_loss_pct, 3.0);
  assert.equal(doc.risk_limits.max_open_positions, 15);
});

test("parseYaml: deeply nested objects", function() {
  const yaml = [
    "trading_hours:",
    "  kr:",
    '    open: "09:00"',
    '    close: "15:30"',
    '    timezone: "Asia/Seoul"',
  ].join("\n");
  const doc = parseYaml(yaml);
  assert.equal(doc.trading_hours.kr.open, "09:00");
  assert.equal(doc.trading_hours.kr.timezone, "Asia/Seoul");
});

test("parseYaml: block array of scalars", function() {
  const yaml = [
    "items:",
    '  - "alpha"',
    '  - "beta"',
    '  - "gamma"',
  ].join("\n");
  const doc = parseYaml(yaml);
  assert.deepEqual(doc.items, ["alpha", "beta", "gamma"]);
});

test("parseYaml: block array of objects", function() {
  const yaml = [
    "halt_rules:",
    '  - condition: "loss >= 3"',
    '    reason: "Daily loss"',
    '  - condition: "vix > 40"',
    '    reason: "VIX crisis"',
  ].join("\n");
  const doc = parseYaml(yaml);
  assert.equal(doc.halt_rules.length, 2);
  assert.equal(doc.halt_rules[0].condition, "loss >= 3");
  assert.equal(doc.halt_rules[0].reason, "Daily loss");
  assert.equal(doc.halt_rules[1].condition, "vix > 40");
});

test("parseYaml: comments are stripped", function() {
  const yaml = [
    "# Top comment",
    "key1: value1  # inline comment",
    "key2: 42",
  ].join("\n");
  const doc = parseYaml(yaml);
  assert.equal(doc.key1, "value1");
  assert.equal(doc.key2, 42);
});

test("parseYaml: booleans in context", function() {
  const yaml = [
    "flags:",
    "  enabled: true",
    "  disabled: false",
  ].join("\n");
  const doc = parseYaml(yaml);
  assert.equal(doc.flags.enabled, true);
  assert.equal(doc.flags.disabled, false);
});

// ---------------------------------------------------------------------------
// loadConstitution — real file
// ---------------------------------------------------------------------------

test("loadConstitution: loads real constitution.yaml", function() {
  const doc = loadConstitution();
  assert.ok(!doc._error, "Should not have error: " + doc._error);
  assert.equal(doc.version, "1.0.0");
  assert.ok(doc.risk_limits, "Should have risk_limits");
  assert.ok(doc.killswitch, "Should have killswitch");
  assert.ok(doc.approval_gates, "Should have approval_gates");
  assert.ok(doc.council, "Should have council");
  assert.ok(doc.self_modification, "Should have self_modification");
  assert.ok(doc.trading_hours, "Should have trading_hours");
  assert.ok(doc.reporting, "Should have reporting");
});

test("loadConstitution: risk_limits values", function() {
  const doc = loadConstitution();
  assert.equal(doc.risk_limits.daily_max_loss_pct, 3.0);
  assert.equal(doc.risk_limits.max_single_position_pct, 20.0);
  assert.equal(doc.risk_limits.max_total_exposure_pct, 85.0);
  assert.equal(doc.risk_limits.max_open_positions, 15);
  assert.equal(doc.risk_limits.max_daily_trades, 50);
  assert.equal(doc.risk_limits.min_cash_reserve_pct, 15.0);
});

test("loadConstitution: killswitch section", function() {
  const doc = loadConstitution();
  assert.equal(doc.killswitch.recovery_requires_approval, true);
  assert.equal(doc.killswitch.min_cooldown_hours, 24);
  assert.ok(Array.isArray(doc.killswitch.immediate_halt), "immediate_halt should be array");
  assert.equal(doc.killswitch.immediate_halt.length, 5);
});

test("loadConstitution: council section", function() {
  const doc = loadConstitution();
  assert.equal(doc.council.consensus_threshold, 0.6);
  assert.equal(doc.council.default_on_disagreement, "HOLD");
  assert.equal(doc.council.min_members_for_decision, 3);
  assert.equal(doc.council.roles.strategist.weight, 1.0);
  assert.equal(doc.council.roles.risk_manager.weight, 1.5);
  assert.equal(doc.council.roles.critic.weight, 1.0);
});

test("loadConstitution: self_modification arrays", function() {
  const doc = loadConstitution();
  assert.ok(Array.isArray(doc.self_modification.modifiable_params));
  assert.ok(doc.self_modification.modifiable_params.includes("STOP_LOSS_PCT"));
  assert.ok(Array.isArray(doc.self_modification.protected_params));
  assert.ok(doc.self_modification.protected_params.includes("DAILY_MAX_LOSS_PCT"));
});

test("loadConstitution: returns error for missing file", function() {
  const doc = loadConstitution("/nonexistent/path.yaml");
  assert.ok(doc._error, "Should have error");
});

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

test("mapToKillswitchConfig: extracts all thresholds", function() {
  const doc = loadConstitution();
  const cfg = mapToKillswitchConfig(doc);
  assert.ok(cfg, "Should return config");
  assert.equal(cfg.dailyMaxLossPct, 3.0);
  assert.equal(cfg.maxTotalExposurePct, 85.0);
  assert.equal(cfg.minCooldownHours, 24);
  assert.equal(cfg.recoveryRequiresApproval, true);
  assert.equal(cfg.consecutiveLossLimit, 10);
  assert.equal(cfg.apiFailureLimit, 5);
  assert.equal(cfg.aiFailureLimit, 5);
  assert.equal(cfg.vixCrisisThreshold, 40);
});

test("mapToApprovalGateConfig: maps all gates", function() {
  const doc = loadConstitution();
  const cfg = mapToApprovalGateConfig(doc);
  assert.ok(cfg, "Should return config");
  assert.equal(cfg.newSymbol.requireApproval, true);
  assert.equal(cfg.newSymbol.timeoutSec, 3600);
  assert.equal(cfg.largePosition.thresholdPct, 15.0);
  assert.equal(cfg.largePosition.timeoutSec, 1800);
  assert.equal(cfg.significantParamChange.maxChangePct, 10.0);
  assert.equal(cfg.significantParamChange.timeoutSec, 7200);
  assert.equal(cfg.regimeStrategyChange.requireApproval, true);
  assert.equal(cfg.regimeStrategyChange.timeoutSec, 3600);
});

test("mapToCouncilConfig: maps weights and thresholds", function() {
  const doc = loadConstitution();
  const cfg = mapToCouncilConfig(doc);
  assert.ok(cfg, "Should return config");
  assert.equal(cfg.consensusThreshold, 0.6);
  assert.equal(cfg.defaultOnDisagreement, "HOLD");
  assert.equal(cfg.weights.strategist, 1.0);
  assert.equal(cfg.weights.risk_manager, 1.5);
  assert.equal(cfg.weights.critic, 1.0);
  assert.equal(cfg.maxPositionPct, 20.0);
  assert.equal(cfg.maxExposurePct, 85.0);
  assert.equal(cfg.maxDailyTrades, 50);
  assert.equal(cfg.minCashReservePct, 15.0);
});

test("mapToHardLimits: extracts all risk limit fields", function() {
  const doc = loadConstitution();
  const cfg = mapToHardLimits(doc);
  assert.ok(cfg, "Should return config");
  assert.equal(cfg.maxSinglePositionPct, 20.0);
  assert.equal(cfg.maxTotalExposurePct, 85.0);
  assert.equal(cfg.maxOpenPositions, 15);
  assert.equal(cfg.minCashReservePct, 15.0);
  assert.equal(cfg.maxSingleOrderKrw, 50000000);
  assert.equal(cfg.maxDailyTrades, 50);
  assert.equal(cfg.maxPairwiseCorrelation, 0.85);
  assert.equal(cfg.dailyMaxLossPct, 3.0);
  assert.equal(cfg.maxSectorConcentrationPct, 40.0);
});

test("mapToHardLimits: returns null on error doc", function() {
  assert.equal(mapToHardLimits(null), null);
  assert.equal(mapToHardLimits({ _error: "parse failed" }), null);
});

test("mapToHardLimits: returns null when no risk_limits", function() {
  const doc = parseYaml('version: "1.0.0"\nname: test');
  assert.equal(mapToHardLimits(doc), null);
});

test("mapToHardLimits: partial risk_limits returns only present fields", function() {
  const yaml = [
    "risk_limits:",
    "  max_open_positions: 10",
    "  daily_max_loss_pct: 5.0",
  ].join("\n");
  const doc = parseYaml(yaml);
  const cfg = mapToHardLimits(doc);
  assert.ok(cfg);
  assert.equal(cfg.maxOpenPositions, 10);
  assert.equal(cfg.dailyMaxLossPct, 5.0);
  assert.equal(cfg.maxSinglePositionPct, undefined);
  assert.equal(cfg.maxTotalExposurePct, undefined);
});

test("mapToSelfModificationConfig: maps all fields", function() {
  const doc = loadConstitution();
  const cfg = mapToSelfModificationConfig(doc);
  assert.ok(cfg, "Should return config");
  assert.equal(cfg.maxDailyParamChangePct, 5.0);
  assert.equal(cfg.maxWeeklyParamChangePct, 15.0);
  assert.equal(cfg.shadowModeMinDays, 7);
  assert.ok(Array.isArray(cfg.modifiableParams));
  assert.equal(cfg.modifiableParams.length, 7);
  assert.ok(Array.isArray(cfg.protectedParams));
  assert.equal(cfg.protectedParams.length, 5);
  assert.equal(cfg.auditAllChanges, true);
  assert.equal(cfg.autoRollbackOnDegradation, true);
  assert.equal(cfg.degradationThresholdPct, 20.0);
});

test("mappers return null for error doc", function() {
  const errDoc = { _error: "test" };
  assert.equal(mapToKillswitchConfig(errDoc), null);
  assert.equal(mapToApprovalGateConfig(errDoc), null);
  assert.equal(mapToCouncilConfig(errDoc), null);
  assert.equal(mapToSelfModificationConfig(errDoc), null);
});

test("mappers return null for null input", function() {
  assert.equal(mapToKillswitchConfig(null), null);
  assert.equal(mapToApprovalGateConfig(null), null);
  assert.equal(mapToCouncilConfig(null), null);
  assert.equal(mapToSelfModificationConfig(null), null);
});