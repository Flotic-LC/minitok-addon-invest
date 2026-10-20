"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// minitok is an EXTERNAL peer of this add-on. Point MINITOK_CLIENT_ROOT at
// the minitok client checkout, or rely on the default sibling location.
const MINITOK_ROOT = process.env.MINITOK_CLIENT_ROOT
  || path.join(__dirname, "..", "..", "minitok-client-release");

const { createAdapterRegistry, executeAdapter, validateAdapterDescriptor } = require(path.join(MINITOK_ROOT, "src", "goal", "adapter_registry"));
const { createTossInvestAdapter, resetTokenCache } = require("../src/tossinvest");

const environment = { commands: {}, tools: [], package: {}, capabilities: { local: true }, external_connectivity: true };
function makeBaseOptions() {
  return {
    capabilities: ["read", "inspect", "external_call", "credential_use"],
    mode: "authorized_external",
    production_adapter_opt_in: true,
    audit_persisted: true,
    integrity_preflight: true,
    environment_observation: environment,
    operation_ledger: new Map(),
  };
}

function setup() { resetTokenCache(); }

test("tossinvest adapter descriptor passes validation", () => {
  setup();
  const adapter = createTossInvestAdapter({ clientId: "test-id", clientSecret: "test-secret" });
  const result = validateAdapterDescriptor(adapter);
  assert.equal(result.valid, true, `Validation errors: ${JSON.stringify(result.errors)}`);
});

test("tossinvest adapter uses 'api' kind which is in ADAPTER_KINDS", () => {
  setup();
  const adapter = createTossInvestAdapter({ clientId: "test-id", clientSecret: "test-secret" });
  assert.equal(adapter.name, "api");
});

test("tossinvest adapter has authorized_external execution policy", () => {
  setup();
  const adapter = createTossInvestAdapter({ clientId: "test-id", clientSecret: "test-secret" });
  assert.equal(adapter.execution_policy, "authorized_external");
});


test("tossinvest adapter cannot execute without production opt-in", () => {
  setup();
  const adapter = createTossInvestAdapter({ clientId: "test-id", clientSecret: "test-secret" });
  const registry = createAdapterRegistry([adapter]);
  const opts = makeBaseOptions();
  opts.production_adapter_opt_in = false;
  const result = executeAdapter(registry, "api", { operation: "get_accounts", target: { accountSeq: "0" } }, opts);
  assert.equal(result.code, "PRODUCTION_ADAPTER_DISABLED");
  assert.equal(result.completed, false);
});

test("tossinvest adapter cannot execute without audit_persisted and integrity_preflight", () => {
  setup();
  const adapter = createTossInvestAdapter({ clientId: "test-id", clientSecret: "test-secret" });
  const registry = createAdapterRegistry([adapter]);
  const opts = makeBaseOptions();
  opts.audit_persisted = false;
  opts.integrity_preflight = false;
  const result = executeAdapter(registry, "api", { operation: "get_accounts", target: { accountSeq: "0" } }, opts);
  assert.equal(result.code, "PRODUCTION_AUDIT_REQUIRED");
});

test("tossinvest adapter fails closed on capability mismatch", () => {
  setup();
  const adapter = createTossInvestAdapter({ clientId: "test-id", clientSecret: "test-secret" });
  const registry = createAdapterRegistry([adapter]);
  const opts = makeBaseOptions();
  opts.capabilities = ["read"];
  const result = executeAdapter(registry, "api", { operation: "get_accounts", target: { accountSeq: "0" } }, opts);
  assert.equal(result.code, "ADAPTER_CAPABILITY_MISMATCH");
  assert.ok(result.missing_capabilities.includes("external_call"));
  assert.ok(result.missing_capabilities.includes("credential_use"));
});

test("tossinvest adapter rejects unknown operations gracefully", async () => {
  setup();
  const adapter = createTossInvestAdapter({ clientId: "test-id", clientSecret: "test-secret" });
  const registry = createAdapterRegistry([adapter]);
  const result = await executeAdapter(registry, "api", { operation: "nonexistent_op", target: { accountSeq: "0" } }, makeBaseOptions());
  assert.equal(result.success, false);
  assert.equal(result.code, "UNKNOWN_OPERATION");
});

test("safety limits block disallowed symbols", async () => {
  setup();
  const adapter = createTossInvestAdapter(
    { clientId: "test-id", clientSecret: "test-secret" },
    { allowedSymbols: ["kr:005930"] }
  );
  const registry = createAdapterRegistry([adapter]);
  const result = await executeAdapter(registry, "api", {
    operation: "create_order",
    target: { accountSeq: "12345" },
    symbol: "kr:000660",
    side: "BUY",
    orderType: "LIMIT",
    quantity: 10,
    price: 100000,
  }, makeBaseOptions());
  assert.equal(result.success, false);
  assert.equal(result.code, "SYMBOL_NOT_ALLOWED");
});

test("safety limits block orders exceeding max value", async () => {
  setup();
  const adapter = createTossInvestAdapter(
    { clientId: "test-id", clientSecret: "test-secret" },
    { maxOrderValueKrw: 1000000 }
  );
  const registry = createAdapterRegistry([adapter]);
  const result = await executeAdapter(registry, "api", {
    operation: "create_order",
    target: { accountSeq: "12345" },
    symbol: "kr:005930",
    side: "BUY",
    orderType: "LIMIT",
    quantity: 100,
    price: 70000,
  }, makeBaseOptions());
  assert.equal(result.success, false);
  assert.equal(result.code, "ORDER_VALUE_EXCEEDED");
});

test("adapter has external_operation_contract configured", () => {
  setup();
  const adapter = createTossInvestAdapter({ clientId: "test-id", clientSecret: "test-secret" });
  assert.ok(adapter.external_operation_contract);
  assert.equal(adapter.external_operation_contract.idempotency_required, true);
  assert.equal(adapter.external_operation_contract.read_after_write_required, true);
  assert.deepEqual(adapter.external_operation_contract.target_binding.required, ["accountSeq"]);
  assert.equal(adapter.external_operation_contract.timeout_ms, 30000);
});

test("adapter supports rollback via cancel", () => {
  setup();
  const adapter = createTossInvestAdapter({ clientId: "test-id", clientSecret: "test-secret" });
  assert.equal(adapter.reversible, true);
  assert.equal(adapter.rollback_support, true);
  assert.equal(typeof adapter.rollback_executor, "function");
});

test("credentials are required for token resolution", async () => {
  setup();
  const adapter = createTossInvestAdapter({});
  const registry = createAdapterRegistry([adapter]);
  const result = await executeAdapter(registry, "api", { operation: "get_accounts", target: { accountSeq: "0" } }, makeBaseOptions());
  assert.equal(result.success, false);
  assert.equal(result.code, "TOSS_CREDENTIALS_MISSING");
});