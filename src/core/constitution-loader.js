"use strict";

/**
 * Constitution Loader — parses constitution.yaml and provides typed config
 * for killswitch, approval-gate, council, and self-modification modules.
 *
 * Supports the YAML subset used by constitution.yaml:
 *   - Nested objects (indentation-based)
 *   - Block arrays (- item, - key: value)
 *   - Inline arrays (["a", "b"])
 *   - Scalars: strings (quoted/unquoted), numbers, booleans, null
 *   - Comments (# ...)
 *
 * Usage:
 *   const { loadConstitution, mapToKillswitchConfig, mapToApprovalGateConfig, mapToCouncilConfig } = require("./src/core/constitution-loader");
 *   const doc = loadConstitution(path.join(__dirname, "src/orchestrator/constitution.yaml"));
 *   const ksConfig = mapToKillswitchConfig(doc);
 *   const agConfig = mapToApprovalGateConfig(doc);
 *   const councilConfig = mapToCouncilConfig(doc);
 */

const fs = require("node:fs");
const path = require("node:path");

// ---------------------------------------------------------------------------
// Minimal YAML parser (subset)
// ---------------------------------------------------------------------------

function parseScalar(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === "" || s === "null" || s === "~") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  // Quoted string
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  // Inline array
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map(function(item) { return parseScalar(item.trim()); });
  }
  // Number
  const num = Number(s);
  if (!isNaN(num) && s !== "") return num;
  return s;
}

function stripComment(line) {
  // Remove trailing comments (not inside quotes)
  let inQuote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

function getIndent(line) {
  let count = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === " ") count++;
    else if (line[i] === "\t") count += 2;
    else break;
  }
  return count;
}

function parseYaml(text) {
  const lines = text.split(/\r?\n/);
  const filtered = [];
  for (let i = 0; i < lines.length; i++) {
    const stripped = stripComment(lines[i]);
    const trimmed = stripped.trim();
    if (!trimmed) continue;
    filtered.push({ raw: stripped, trimmed: trimmed, indent: getIndent(stripped), lineNum: i + 1 });
  }
  return parseBlock(filtered, 0, filtered.length, 0);
}

function parseBlock(lines, start, end, parentIndent) {
  if (start >= end) return null;

  // Detect if this block is an array
  const firstTrimmed = lines[start].trimmed;
  if (firstTrimmed.startsWith("- ")) {
    return parseArrayBlock(lines, start, end, lines[start].indent);
  }

  // Object block
  const result = {};
  let i = start;
  while (i < end) {
    const line = lines[i];
    if (line.indent < parentIndent) break;
    if (line.indent > parentIndent) { i++; continue; }

    const colonIdx = line.trimmed.indexOf(":");
    if (colonIdx < 0) { i++; continue; }

    const key = line.trimmed.slice(0, colonIdx).trim();
    const afterColon = line.trimmed.slice(colonIdx + 1).trim();

    if (afterColon) {
      // Inline value
      result[key] = parseScalar(afterColon);
      i++;
    } else {
      // Nested block — find extent
      const childIndent = findChildIndent(lines, i + 1, end, line.indent);
      if (childIndent == null) {
        result[key] = null;
        i++;
      } else {
        const childEnd = findBlockEnd(lines, i + 1, end, childIndent);
        result[key] = parseBlock(lines, i + 1, childEnd, childIndent);
        i = childEnd;
      }
    }
  }
  return result;
}

function parseArrayBlock(lines, start, end, blockIndent) {
  const result = [];
  let i = start;
  while (i < end) {
    const line = lines[i];
    if (line.indent < blockIndent) break;
    if (line.indent > blockIndent) { i++; continue; }
    if (!line.trimmed.startsWith("- ")) { i++; continue; }

    const itemContent = line.trimmed.slice(2).trim();

    // Check if item is a key: value (object item)
    const colonIdx = itemContent.indexOf(":");
    if (colonIdx > 0 && !itemContent.startsWith('"') && !itemContent.startsWith("'")) {
      // Object item — gather sub-lines
      const obj = {};
      const key = itemContent.slice(0, colonIdx).trim();
      const val = itemContent.slice(colonIdx + 1).trim();
      obj[key] = val ? parseScalar(val) : null;

      // Check for continuation lines (deeper indent, part of same array item)
      let j = i + 1;
      while (j < end && lines[j].indent > blockIndent) {
        const subLine = lines[j];
        const subColon = subLine.trimmed.indexOf(":");
        if (subColon > 0) {
          const subKey = subLine.trimmed.slice(0, subColon).trim();
          const subVal = subLine.trimmed.slice(subColon + 1).trim();
          obj[subKey] = subVal ? parseScalar(subVal) : null;
        }
        j++;
      }
      result.push(obj);
      i = j;
    } else {
      // Simple scalar item
      result.push(parseScalar(itemContent));
      i++;
    }
  }
  return result;
}

function findChildIndent(lines, start, end, parentIndent) {
  for (let i = start; i < end; i++) {
    if (lines[i].indent > parentIndent) return lines[i].indent;
    if (lines[i].indent <= parentIndent) return null;
  }
  return null;
}

function findBlockEnd(lines, start, end, childIndent) {
  for (let i = start; i < end; i++) {
    if (lines[i].indent < childIndent) return i;
  }
  return end;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

function loadConstitution(filePath) {
  const resolved = filePath || path.join(__dirname, "..", "orchestrator", "constitution.yaml");
  try {
    const text = fs.readFileSync(resolved, "utf8");
    const doc = parseYaml(text);
    if (!doc || typeof doc !== "object") {
      return { _error: "Failed to parse constitution.yaml", _path: resolved };
    }
    doc._path = resolved;
    doc._loadedAt = new Date().toISOString();
    return doc;
  } catch (e) {
    return { _error: e.message, _path: resolved };
  }
}

// ---------------------------------------------------------------------------
// Mappers: constitution → module configs
// ---------------------------------------------------------------------------

function mapToKillswitchConfig(doc) {
  if (!doc || doc._error) return null;
  const ks = doc.killswitch;
  const rl = doc.risk_limits;
  if (!ks && !rl) return null;

  const config = {};

  // From risk_limits
  if (rl) {
    if (rl.daily_max_loss_pct != null) config.dailyMaxLossPct = rl.daily_max_loss_pct;
    if (rl.max_total_exposure_pct != null) config.maxTotalExposurePct = rl.max_total_exposure_pct;
  }

  // From killswitch section
  if (ks) {
    if (ks.min_cooldown_hours != null) config.minCooldownHours = ks.min_cooldown_hours;
    if (ks.recovery_requires_approval != null) config.recoveryRequiresApproval = ks.recovery_requires_approval;

    // Parse immediate_halt conditions for numeric thresholds
    if (Array.isArray(ks.immediate_halt)) {
      for (const rule of ks.immediate_halt) {
        if (!rule || !rule.condition) continue;
        const cond = String(rule.condition);

        // consecutive_losses >= 10
        const clMatch = cond.match(/consecutive_losses\s*>=\s*(\d+)/);
        if (clMatch) config.consecutiveLossLimit = Number(clMatch[1]);

        // api_failures >= 5
        const apiMatch = cond.match(/api_failures\s*>=\s*(\d+)/);
        if (apiMatch) config.apiFailureLimit = Number(apiMatch[1]);

        // ai_failures >= 5
        const aiMatch = cond.match(/ai_failures\s*>=\s*(\d+)/);
        if (aiMatch) config.aiFailureLimit = Number(aiMatch[1]);

        // vix > 40
        const vixMatch = cond.match(/vix\s*>\s*(\d+)/);
        if (vixMatch) config.vixCrisisThreshold = Number(vixMatch[1]);
      }
    }
  }

  return Object.keys(config).length > 0 ? config : null;
}

function mapToApprovalGateConfig(doc) {
  if (!doc || doc._error) return null;
  const gates = doc.approval_gates;
  if (!gates) return null;

  const config = {};

  if (gates.new_symbol) {
    config.newSymbol = {};
    if (gates.new_symbol.require_approval != null) config.newSymbol.requireApproval = gates.new_symbol.require_approval;
    if (gates.new_symbol.timeout_sec != null) config.newSymbol.timeoutSec = gates.new_symbol.timeout_sec;
  }

  if (gates.large_position) {
    config.largePosition = {};
    if (gates.large_position.require_approval != null) config.largePosition.requireApproval = gates.large_position.require_approval;
    if (gates.large_position.threshold_pct_of_equity != null) config.largePosition.thresholdPct = gates.large_position.threshold_pct_of_equity;
    if (gates.large_position.timeout_sec != null) config.largePosition.timeoutSec = gates.large_position.timeout_sec;
  }

  if (gates.significant_param_change) {
    config.significantParamChange = {};
    if (gates.significant_param_change.require_approval != null) config.significantParamChange.requireApproval = gates.significant_param_change.require_approval;
    if (gates.significant_param_change.max_change_pct != null) config.significantParamChange.maxChangePct = gates.significant_param_change.max_change_pct;
    if (gates.significant_param_change.timeout_sec != null) config.significantParamChange.timeoutSec = gates.significant_param_change.timeout_sec;
  }

  if (gates.regime_strategy_change) {
    config.regimeStrategyChange = {};
    if (gates.regime_strategy_change.require_approval != null) config.regimeStrategyChange.requireApproval = gates.regime_strategy_change.require_approval;
    if (gates.regime_strategy_change.timeout_sec != null) config.regimeStrategyChange.timeoutSec = gates.regime_strategy_change.timeout_sec;
  }

  return Object.keys(config).length > 0 ? config : null;
}

function mapToCouncilConfig(doc) {
  if (!doc || doc._error) return null;
  const council = doc.council;
  const rl = doc.risk_limits;
  if (!council && !rl) return null;

  const config = {};

  if (council) {
    if (council.consensus_threshold != null) config.consensusThreshold = council.consensus_threshold;
    if (council.default_on_disagreement != null) config.defaultOnDisagreement = council.default_on_disagreement;
    if (council.min_members_for_decision != null) config.minMembers = council.min_members_for_decision;

    // Weights from roles
    if (council.roles) {
      const weights = {};
      for (const role of Object.keys(council.roles)) {
        if (council.roles[role] && council.roles[role].weight != null) {
          weights[role] = council.roles[role].weight;
        }
      }
      if (Object.keys(weights).length > 0) config.weights = weights;
    }
  }

  if (rl) {
    if (rl.max_single_position_pct != null) config.maxPositionPct = rl.max_single_position_pct;
    if (rl.max_total_exposure_pct != null) config.maxExposurePct = rl.max_total_exposure_pct;
    if (rl.max_daily_trades != null) config.maxDailyTrades = rl.max_daily_trades;
    if (rl.min_cash_reserve_pct != null) config.minCashReservePct = rl.min_cash_reserve_pct;
  }

  return Object.keys(config).length > 0 ? config : null;
}

function mapToHardLimits(doc) {
  if (!doc || doc._error) return null;
  const rl = doc.risk_limits;
  if (!rl) return null;

  const config = {};
  if (rl.max_single_position_pct != null) config.maxSinglePositionPct = rl.max_single_position_pct;
  if (rl.max_total_exposure_pct != null) config.maxTotalExposurePct = rl.max_total_exposure_pct;
  if (rl.max_open_positions != null) config.maxOpenPositions = rl.max_open_positions;
  if (rl.min_cash_reserve_pct != null) config.minCashReservePct = rl.min_cash_reserve_pct;
  if (rl.max_single_order_krw != null) config.maxSingleOrderKrw = rl.max_single_order_krw;
  if (rl.max_daily_trades != null) config.maxDailyTrades = rl.max_daily_trades;
  if (rl.max_pairwise_correlation != null) config.maxPairwiseCorrelation = rl.max_pairwise_correlation;
  if (rl.daily_max_loss_pct != null) config.dailyMaxLossPct = rl.daily_max_loss_pct;
  if (rl.max_sector_concentration_pct != null) config.maxSectorConcentrationPct = rl.max_sector_concentration_pct;

  return Object.keys(config).length > 0 ? config : null;
}

function mapToSelfModificationConfig(doc) {
  if (!doc || doc._error) return null;
  const sm = doc.self_modification;
  if (!sm) return null;

  const config = {};
  if (sm.max_daily_param_change_pct != null) config.maxDailyParamChangePct = sm.max_daily_param_change_pct;
  if (sm.max_weekly_param_change_pct != null) config.maxWeeklyParamChangePct = sm.max_weekly_param_change_pct;
  if (sm.shadow_mode_min_days != null) config.shadowModeMinDays = sm.shadow_mode_min_days;
  if (Array.isArray(sm.modifiable_params)) config.modifiableParams = sm.modifiable_params;
  if (Array.isArray(sm.protected_params)) config.protectedParams = sm.protected_params;
  if (sm.audit_all_changes != null) config.auditAllChanges = sm.audit_all_changes;
  if (sm.auto_rollback_on_degradation != null) config.autoRollbackOnDegradation = sm.auto_rollback_on_degradation;
  if (sm.degradation_threshold_pct != null) config.degradationThresholdPct = sm.degradation_threshold_pct;

  return Object.keys(config).length > 0 ? config : null;
}

module.exports = {
  loadConstitution: loadConstitution,
  parseYaml: parseYaml,
  parseScalar: parseScalar,
  mapToKillswitchConfig: mapToKillswitchConfig,
  mapToApprovalGateConfig: mapToApprovalGateConfig,
  mapToCouncilConfig: mapToCouncilConfig,
  mapToHardLimits: mapToHardLimits,
  mapToSelfModificationConfig: mapToSelfModificationConfig,
};
