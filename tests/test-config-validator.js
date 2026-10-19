"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { validateConfig, SCHEMA } = require("../src/core/config-validator");

function baseEnv(overrides = {}) {
  return {
    TOSS_CLIENT_ID: "id-abc",
    TOSS_CLIENT_SECRET: "secret-xyz",
    TOSS_ACCOUNT_SEQ: "1234567",
    PROFUNDO_API_KEY: "pk_test",
    ...overrides,
  };
}

test("valid minimal env returns ok", () => {
  const r = validateConfig(baseEnv());
  assert.equal(r.ok, true, r.errors.join("\n"));
  assert.equal(r.errors.length, 0);
  assert.equal(r.normalized.MAX_ORDER_VALUE_KRW, 5000000);
  assert.equal(r.normalized.DRY_RUN, true);
  assert.equal(r.normalized.SIG_MIN_SCORE, 1);
});

test("missing required TOSS_CLIENT_ID fails", () => {
  const env = baseEnv();
  delete env.TOSS_CLIENT_ID;
  const r = validateConfig(env);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith("MISSING") && e.includes("TOSS_CLIENT_ID")));
});

test("FORBIDDEN UNRESTRICTED_MODE produces error", () => {
  const r = validateConfig(baseEnv({ UNRESTRICTED_MODE: "true" }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith("FORBIDDEN") && e.includes("UNRESTRICTED_MODE")));
});

test("invalid numeric type is rejected", () => {
  const r = validateConfig(baseEnv({ MAX_ORDER_VALUE_KRW: "not-a-number" }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith("INVALID") && e.includes("MAX_ORDER_VALUE_KRW")));
});

test("out-of-range numeric value is rejected", () => {
  const r = validateConfig(baseEnv({ SYMBOL_MAX_LOSS_PCT: "-100" }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith("OUT_OF_RANGE")));
});

test("boolean coercion accepts multiple truthy forms", () => {
  for (const v of ["true", "TRUE", "1", "yes", "on"]) {
    const r = validateConfig(baseEnv({ DRY_RUN: v }));
    assert.equal(r.ok, true, "failed for " + v + ": " + r.errors.join(","));
    assert.equal(r.normalized.DRY_RUN, true);
  }
  for (const v of ["false", "0", "no", "off"]) {
    const r = validateConfig(baseEnv({ DRY_RUN: v }));
    assert.equal(r.normalized.DRY_RUN, false);
  }
});

test("MAX_ORDER > DAILY_MAX triggers warning", () => {
  const r = validateConfig(baseEnv({
    MAX_ORDER_VALUE_KRW: "50000000",
    DAILY_MAX_VALUE_KRW: "1000000",
  }));
  assert.equal(r.ok, true); // warning, not error
  assert.ok(r.warnings.some((w) => w.includes("MAX_ORDER_VALUE_KRW")));
});

test("DRY_RUN=false produces LIVE_MODE warning", () => {
  const r = validateConfig(baseEnv({ DRY_RUN: "false" }));
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.startsWith("LIVE_MODE")));
});

test("AI_MAX_PROFIT_PCT > 0 triggers deprecation warning", () => {
  const r = validateConfig(baseEnv({ AI_MAX_PROFIT_PCT: "50" }));
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.startsWith("DEPRECATED")));
});

test("unknown TOSS_/AI_ prefixed vars produce UNKNOWN warning", () => {
  const r = validateConfig(baseEnv({ TOSS_TYPO_FLAG: "x", AI_UNKNOWN_THING: "1" }));
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.startsWith("UNKNOWN") && w.includes("TOSS_TYPO_FLAG")));
  assert.ok(r.warnings.some((w) => w.startsWith("UNKNOWN") && w.includes("AI_UNKNOWN_THING")));
});

test("secrets list identifies sensitive keys", () => {
  const r = validateConfig(baseEnv());
  assert.ok(r.secrets.includes("TOSS_CLIENT_ID"));
  assert.ok(r.secrets.includes("TOSS_CLIENT_SECRET"));
  assert.ok(r.secrets.includes("PROFUNDO_API_KEY"));
});

test("SCHEMA exports frozen shape", () => {
  assert.ok(Object.isFrozen(SCHEMA));
  assert.ok("TOSS_CLIENT_ID" in SCHEMA);
  assert.ok("UNRESTRICTED_MODE" in SCHEMA);
  assert.equal(SCHEMA.UNRESTRICTED_MODE.forbidden, true);
});
