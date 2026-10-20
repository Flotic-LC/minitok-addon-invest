"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const MINITOK_ROOT = process.env.MINITOK_CLIENT_ROOT
  || path.join(__dirname, "..", "..", "minitok-client-release");
const { createAdapterRegistry, executeAdapter } = require(path.join(MINITOK_ROOT, "src", "goal", "adapter_registry"));
const { createTossInvestAdapter, resetTokenCache, normalizeApiError } = require("../src/tossinvest");

const environment = { commands: {}, tools: [], package: {}, capabilities: { local: true }, external_connectivity: true };
function gateOptions(ledger) {
  return {
    capabilities: ["read", "inspect", "external_call", "credential_use"],
    mode: "authorized_external",
    production_adapter_opt_in: true,
    audit_persisted: true,
    integrity_preflight: true,
    environment_observation: environment,
    operation_ledger: ledger || new Map(),
  };
}

function setupRegistry(limits = {}) {
  resetTokenCache();
  return createAdapterRegistry([createTossInvestAdapter({ clientId: "id", clientSecret: "secret" }, limits)]);
}

// Track network calls
let callCount = 0;
const realFetch = globalThis.fetch;

function installCountingMock() {
  callCount = 0;
  globalThis.fetch = async (url, init = {}) => {
    callCount++;
    const u = new URL(url);
    const method = (init.method || "GET").toUpperCase();
    const respond = (status, payload) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    if (u.pathname === "/oauth2/token") return respond(200, { access_token: "mock-token", expires_in: 300 });
    if (u.pathname === "/api/v1/orders" && method === "POST") {
      return respond(200, { result: { orderId: "o-1", clientOrderId: "cid-1" } });
    }
    if (u.pathname === "/api/v1/orders" && method === "GET") {
      return respond(200, { result: { orders: [], nextCursor: null, hasNext: false } });
    }
    if (/^\/api\/v1\/orders\/[^/]+$/.test(u.pathname) && method === "GET") {
      const id = decodeURIComponent(u.pathname.split("/").pop());
      return respond(200, { result: { orderId: id, status: "PENDING" } });
    }
    return respond(404, { result: null, error: "unmocked" });
  };
  return () => { globalThis.fetch = realFetch; };
}

test("dry-run create_order sends no network requests", async () => {
  const restore = installCountingMock();
  try {
    const registry = setupRegistry();
    const result = await executeAdapter(registry, "api", {
      operation: "create_order",
      target: { accountSeq: "1" },
      symbol: "kr:005930",
      side: "BUY",
      orderType: "LIMIT",
      quantity: 1,
      price: 1000,
      dryRun: true,
    }, gateOptions());
    assert.equal(result.success, true);
    assert.equal(result.simulated, true);
    assert.equal(result.http_status, 0);
    assert.equal(result.verifier_evidence[0].executed, false);
    assert.equal(result.verifier_evidence[0].simulated, true);
    assert.equal(callCount, 0, "dry-run must not call network");
  } finally { restore(); }
});

test("dry-run cancel_order sends no network requests", async () => {
  const restore = installCountingMock();
  try {
    const registry = setupRegistry();
    const result = await executeAdapter(registry, "api", {
      operation: "cancel_order",
      target: { accountSeq: "1" },
      orderId: "o-9",
      dryRun: true,
    }, gateOptions());
    assert.equal(result.success, true);
    assert.equal(result.simulated, true);
    assert.equal(callCount, 0);
  } finally { restore(); }
});

test("dry_run (snake_case) alias works", async () => {
  const restore = installCountingMock();
  try {
    const registry = setupRegistry();
    const result = await executeAdapter(registry, "api", {
      operation: "create_order",
      target: { accountSeq: "1" },
      symbol: "kr:005930",
      side: "BUY",
      orderType: "LIMIT",
      quantity: 1,
      price: 1000,
      dry_run: true,
    }, gateOptions());
    assert.equal(result.simulated, true);
    assert.equal(callCount, 0);
  } finally { restore(); }
});

test("non-dry-run create_order still calls network", async () => {
  const restore = installCountingMock();
  try {
    const registry = setupRegistry();
    const result = await executeAdapter(registry, "api", {
      operation: "create_order",
      target: { accountSeq: "1" },
      symbol: "kr:005930",
      side: "BUY",
      orderType: "LIMIT",
      quantity: 1,
      price: 1000,
    }, gateOptions());
    assert.equal(result.success, true);
    assert.ok(callCount > 0, "real order must call network");
  } finally { restore(); }
});

test("normalizeApiError maps insufficient funds", () => {
  const err = normalizeApiError(400, { error: "insufficient-funds", error_description: "잔액 부족" }, null);
  assert.equal(err.mappedCode, "INSUFFICIENT_BALANCE");
  assert.equal(err.message, "잔액 부족");
  assert.equal(err.status, 400);
});

test("normalizeApiError maps rate limit", () => {
  const err = normalizeApiError(429, { error: "too-many-requests" }, null);
  assert.equal(err.mappedCode, "RATE_LIMITED");
});

test("normalizeApiError maps server error", () => {
  const err = normalizeApiError(503, { error: "service-unavailable" }, null);
  assert.equal(err.mappedCode, "TOSS_SERVER_ERROR");
});

test("normalizeApiError maps auth error", () => {
  const err = normalizeApiError(401, { error: "invalid-token" }, null);
  assert.equal(err.mappedCode, "TOSS_AUTH_ERROR");
});

test("normalizeApiError maps reject", () => {
  const err = normalizeApiError(400, { error: "order-rejected" }, null);
  assert.equal(err.mappedCode, "ORDER_REJECTED");
});

test("executor returns mapped error code on API failure", async () => {
  const restore = installCountingMock();
  try {
    // override to return 400 insufficient-funds on order create
    globalThis.fetch = async (url, init = {}) => {
      const u = new URL(url);
      const respond = (status, payload) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
      if (u.pathname === "/oauth2/token") return respond(200, { access_token: "t", expires_in: 300 });
      if (u.pathname === "/api/v1/orders" && (init.method || "GET").toUpperCase() === "POST") {
        return respond(400, { result: { error: "insufficient-funds", error_description: "Insufficient available balance" } });
      }
      return respond(404, { result: null, error: "unmocked" });
    };
    resetTokenCache();
    const registry = createAdapterRegistry([createTossInvestAdapter({ clientId: "id", clientSecret: "secret" })]);
    const result = await executeAdapter(registry, "api", {
      operation: "create_order",
      target: { accountSeq: "1" },
      symbol: "kr:005930",
      side: "BUY",
      orderType: "LIMIT",
      quantity: 1,
      price: 1000,
    }, gateOptions());
    assert.equal(result.success, false);
    assert.equal(result.code, "INSUFFICIENT_BALANCE");
    assert.equal(result.reason, "Insufficient available balance");
  } finally { restore(); }
});

test("input_schema includes dryRun and dry_run", () => {
  resetTokenCache();
  const adapter = createTossInvestAdapter({ clientId: "id", clientSecret: "secret" });
  assert.equal(adapter.input_schema.properties.dryRun.type, "boolean");
  assert.equal(adapter.input_schema.properties.dry_run.type, "boolean");
});
