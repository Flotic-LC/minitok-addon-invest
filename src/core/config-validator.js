"use strict";

/**
 * Startup configuration validator — enforces env var schema, type coercion,
 * range bounds, and dangerous-flag detection before the trading loop starts.
 *
 * Returns { ok, errors, warnings, normalized } so callers can fail fast
 * instead of suffering silent misconfiguration mid-session.
 *
 * Usage:
 *   const { validateConfig } = require("./src/core/config-validator");
 *   const result = validateConfig(process.env);
 *   if (!result.ok) { console.error(result.errors.join("\n")); process.exit(1); }
 */

const SCHEMA = Object.freeze({
  // --- Auth (required, secret) ---
  TOSS_CLIENT_ID:      { type: "string", required: true, secret: true },
  TOSS_CLIENT_SECRET:  { type: "string", required: true, secret: true },
  TOSS_ACCOUNT_SEQ:    { type: "string", required: true },
  PROFUNDO_API_KEY:    { type: "string", secret: true },
  AI_FAILOVER_API_KEY: { type: "string", secret: true },

  // --- LLM endpoint config ---
  PROFUNDO_BASE_URL:   { type: "string", default: "https://api.profundoai.com/v1" },
  PROFUNDO_MODEL:      { type: "string", default: "gpt-6-astra" },
  MINITOK_CLIENT_ROOT: { type: "string" },
  // [2026-10-21 7단계] The trading add-on's commercial entitlement.
  // MINITOK_ENTITLEMENT_REQUIRED arms the gate: when it is true the add-on
  // refuses to trade without a server-verified entitlement for this
  // installation and exits with a message the operator can act on. The rest
  // describe where the server-issued artifact lives and which installation
  // it has to belong to.
  MINITOK_ENTITLEMENT_REQUIRED: { type: "boolean", default: false },
  MINITOK_SERVER_URL: { type: "string" },
  MINITOK_INSTALLATION_TOKEN: { type: "string", secret: true },
  MINITOK_ENTITLEMENT_PATH: { type: "string" },
  MINITOK_ENTITLEMENT: { type: "string", secret: true },
  MINITOK_INSTALLATION_ID: { type: "string" },
  MINITOK_ADDON_MIN_PLAN_ID: { type: "string", default: "level1" },
  MINITOK_ENTITLEMENT_GRACE_MS: { type: "string", default: "0" },

  // --- Operational modes ---
  DRY_RUN:             { type: "boolean", default: true },
  NODE_ENV:            { type: "string" },
  TZ:                  { type: "string" },
  AUDIT_LOG_ENABLED:   { type: "boolean", default: true },

  // --- Risk / sizing ---
   MAX_ORDER_VALUE_KRW: { type: "number", min: 1000, default: 5000000 },
  DAILY_MAX_VALUE_KRW: { type: "number", min: 10000, default: 5000000 },
  MAX_OPEN_ORDERS:     { type: "integer", min: 1, max: 100, default: 10 },
  MAX_POSITIONS_PER_SYMBOL: { type: "integer", min: 1, max: 10, default: 1 },
  ORDER_COOLDOWN_MS:   { type: "integer", min: 0, default: 5000 },

  // --- [Tier 2] Stop / take profit — 수익 극대화를 위해 보수적 기본값을 대폭 완화 ---
  // Tier 1 (자본 보호) 은 daily hard-stop (-2% equity), AI circuit breaker,
  // UNRESTRICTED_MODE forbidden 등으로 별도 유지됨.
  SYMBOL_MAX_LOSS_PCT: { type: "number", max: 0, min: -50, default: -12 },  // was -5: 정상 변동성 허용
  TAKE_PROFIT_PCT:     { type: "number", min: 0, max: 100, default: 12 },   // was 5: 큰 수익 추구
  TRAILING_STOP_PCT:   { type: "number", max: 0, min: -50, default: -8 },   // was -3: 추세 보유
  TRAILING_STOP_MIN_PROFIT_PCT: { type: "number", min: 0, max: 50, default: 3 }, // was 1: 단타 방지
  ATR_HARD_STOP_MULT:  { type: "number", min: 0.5, max: 10, default: 2 },
  CROSS_ASSET_GUARD_THRESHOLD: { type: "number", min: 0, max: 20, default: 3.0 }, // was 1.5: FX 일변동 일상화

  // --- Signal params ---
  SIG_RSI_OVERSOLD:    { type: "number", min: 0, max: 50, default: 30 },
  SIG_RSI_OVERBOUGHT:  { type: "number", min: 50, max: 100, default: 70 },
  SIG_MIN_SCORE:       { type: "integer", min: 0, max: 10, default: 1 },
  SIG_USE_ATR_STOPS:   { type: "boolean", default: true },
  SIG_ATR_STOP_MULT:   { type: "number", min: 0.5, max: 10, default: 2.0 },
  SIG_ATR_TAKE_MULT:   { type: "number", min: 0.5, max: 20, default: 5.0 },   // was 3.0
  SIG_MIN_STOP_PCT:    { type: "number", max: 0, min: -50, default: -15 },     // was -5: ATR stop 바닥 완화
  SIG_MAX_STOP_PCT:    { type: "number", max: 0, min: -50, default: -0.5 },
  SIG_MOMENTUM_MAX_PCT:{ type: "number", min: 0, max: 100, default: 25 },      // was 8: 강한 모멘텀 허용
   SIZE_RISK_PCT:       { type: "number", min: 0.01, max: 10, default: 1.0 },

  // --- AI / throttling ---
  AI_THROTTLE_MS:      { type: "integer", min: 1000, max: 3600000 },
  AI_CACHE_TTL_MS:     { type: "integer", min: 0, max: 600000, default: 25000 },
  AI_FALLBACK_TRIGGER_MS: { type: "integer", min: 5000, max: 3600000, default: 300000 },

  // --- Forbidden / removed flags ---
  UNRESTRICTED_MODE:   { type: "string", forbidden: true,
    reason: "Removed for safety. Use AI_MAX_PROFIT_PCT with explicit budget instead." },

  // --- Deprecated (warn but still accepted) ---
  AI_MAX_PROFIT_PCT:   { type: "number", min: 0, max: 100, default: 0,
    deprecated: "Dual-bucket mode is risky; keep at 0 unless explicitly approved." },

  // --- Alerts ---
  TELEGRAM_BOT_TOKEN:  { type: "string", secret: true },
  TELEGRAM_CHAT_ID:    { type: "string" },

  // --- Discovery ---
  DISCOVERY_MIN_PRICE:    { type: "number", min: 0, default: 1000 },
  DISCOVERY_INTERVAL_MS:  { type: "integer", min: 60000, max: 86400000, default: 1800000 },
  JPY_KRW_RATE:           { type: "number", min: 0.1, max: 100, default: 9.0 },

  // --- [Tier 2] Fallback policy (when all AI providers fail) ---
  FALLBACK_ALLOWLIST:    { type: "string" },
  FALLBACK_BLOCKLIST:    { type: "string" },
  FALLBACK_MIN_PRICE_USD:{ type: "number", min: 0, default: 1 },
  FALLBACK_MIN_PRICE_JPY:{ type: "number", min: 0, default: 100 },
  FALLBACK_MAX_ATR_PCT:  { type: "number", min: 0, max: 100, default: 25 },     // was 10: 성장주 허용
   FALLBACK_BUY_MIN_SCORE:{ type: "integer", min: 1, max: 10, default: 3 },
});

function coerce(value, spec) {
  if (value === undefined || value === null || value === "") return undefined;
  const raw = String(value).trim();
  if (spec.type === "boolean") {
    const low = raw.toLowerCase();
    if (["true", "1", "yes", "on"].includes(low)) return true;
    if (["false", "0", "no", "off"].includes(low)) return false;
    throw new Error("must be boolean (true/false/1/0/yes/no), got: " + raw);
  }
  if (spec.type === "integer") {
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error("must be integer, got: " + raw);
    return n;
  }
  if (spec.type === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error("must be number, got: " + raw);
    return n;
  }
  return raw;
}

function validateConfig(env = process.env, options = {}) {
  const schema = options.schema || SCHEMA;
  const errors = [];
  const warnings = [];
  const normalized = {};
  const secrets = [];

  // 1. Walk schema
  for (const [key, spec] of Object.entries(schema)) {
    const raw = env[key];
    const isSet = raw !== undefined && raw !== null && raw !== "";

    if (spec.secret && isSet) secrets.push(key);

    // Forbidden flags
    if (spec.forbidden && isSet) {
      errors.push(`FORBIDDEN: ${key} is set (value=***). ${spec.reason || "This flag has been removed."}`);
      continue;
    }

    // Required check
    if (spec.required && !isSet) {
      errors.push(`MISSING: required variable ${key} is not set`);
      continue;
    }

    if (!isSet) {
      if ("default" in spec) normalized[key] = spec.default;
      continue;
    }

    // Coerce
    let coerced;
    try {
      coerced = coerce(raw, spec);
    } catch (e) {
      errors.push(`INVALID: ${key} ${e.message}`);
      continue;
    }

    // Range / enum
    if (spec.type === "number" || spec.type === "integer") {
      if (spec.min !== undefined && coerced < spec.min) {
        errors.push(`OUT_OF_RANGE: ${key}=${coerced} is below minimum ${spec.min}`);
        continue;
      }
      if (spec.max !== undefined && coerced > spec.max) {
        errors.push(`OUT_OF_RANGE: ${key}=${coerced} exceeds maximum ${spec.max}`);
        continue;
      }
    }
    if (spec.allowed && !spec.allowed.includes(coerced)) {
      errors.push(`INVALID: ${key}=${coerced} not in allowed set [${spec.allowed.join(",")}]`);
      continue;
    }

    if (spec.deprecated) {
      // Only warn if the value is meaningfully non-default (e.g., AI_MAX_PROFIT_PCT > 0)
      const isEffectivelySet = (spec.type === "number" || spec.type === "integer")
        ? coerced !== 0
        : coerced !== false && coerced !== "" && coerced !== null;
      if (isEffectivelySet) {
        warnings.push(`DEPRECATED: ${key} is set — ${spec.deprecated}`);
      }
    }

    normalized[key] = spec.transform ? spec.transform(coerced) : coerced;
  }

  // 2. Unknown env vars that look like ours (typo detection)
  const knownPrefixes = ["TOSS_", "AI_", "SIG_", "TRAILING_", "DISCOVERY_", "TELEGRAM_", "PROFUNDO_"];
  for (const key of Object.keys(env)) {
    if (key in schema) continue;
    if (knownPrefixes.some((p) => key.startsWith(p))) {
      warnings.push(`UNKNOWN: ${key} looks like a trading config var but is not in schema (typo?)`);
    }
  }

  // 3. Cross-field sanity checks
  if (normalized.MAX_ORDER_VALUE_KRW && normalized.DAILY_MAX_VALUE_KRW) {
    if (normalized.MAX_ORDER_VALUE_KRW > normalized.DAILY_MAX_VALUE_KRW) {
      warnings.push(
        `WARN: MAX_ORDER_VALUE_KRW (${normalized.MAX_ORDER_VALUE_KRW}) > DAILY_MAX_VALUE_KRW (${normalized.DAILY_MAX_VALUE_KRW}) — single order could exhaust daily budget`
      );
    }
  }
  if (normalized.DRY_RUN === false) {
    warnings.push(`LIVE_MODE: DRY_RUN=false — real orders will be submitted to Toss Securities`);
  }

  return { ok: errors.length === 0, errors, warnings, normalized, secrets };
}

module.exports = { validateConfig, SCHEMA };

