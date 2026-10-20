"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const MINITOK_ROOT = process.env.MINITOK_CLIENT_ROOT
  || path.join(__dirname, "..", "..", "minitok-client-release");
const { createAdapterRegistry, executeAdapter } = require(path.join(MINITOK_ROOT, "src", "goal", "adapter_registry"));
const { createTossInvestAdapter, resetTokenCache, normalizeSymbol, getBuyingPower, getSellableQuantity, getTrades, getCandles, getStocks, listStocksAll, getExchangeRate, getMarketCalendar, getStockWarnings, getCommissions } = require("../src/tossinvest");

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

// ---------------------------------------------------------------------------
// Mock fetch covering the new endpoints. Records the URLs/headers seen.
// buyingPower / sellableQuantity are configurable per test.
// ---------------------------------------------------------------------------
function installMock({ cashBuyingPower = "5000000", sellableQuantity = "100" } = {}) {
  const realFetch = globalThis.fetch;
  const seen = { urls: [], accountHeaders: [] };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    seen.urls.push(u.pathname + u.search);
    const hdrs = init.headers || {};
    seen.accountHeaders.push(hdrs["X-Tossinvest-Account"] ?? null);
    const respond = (status, payload) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    if (u.pathname === "/oauth2/token") return respond(200, { access_token: "mock-token", expires_in: 300 });
    if (u.pathname === "/api/v1/buying-power") return respond(200, { result: { currency: u.searchParams.get("currency") || "KRW", cashBuyingPower } });
    if (u.pathname === "/api/v1/sellable-quantity") return respond(200, { result: { sellableQuantity } });
    if (u.pathname === "/api/v1/commissions") return respond(200, { result: [{ market: "KOSPI", rate: "0.00015" }] });
    if (u.pathname === "/api/v1/orders" && (init.method || "GET").toUpperCase() === "POST") {
      return respond(200, { result: { orderId: "o-1", clientOrderId: "cid-1" } });
    }
    if (/^\/api\/v1\/orders\/[^/]+$/.test(u.pathname) && (init.method || "GET").toUpperCase() === "GET") {
      const id = decodeURIComponent(u.pathname.split("/").pop());
      return respond(200, { result: { orderId: id, status: "PENDING" } });
    }
    if (u.pathname === "/api/v1/trades") return respond(200, { result: [{ price: "72000", volume: "120", timestamp: "2026-03-25T09:30:42+09:00", currency: "KRW" }] });
    if (u.pathname === "/api/v1/candles") return respond(200, { result: { candles: [{ timestamp: "2026-03-25T00:00:00+09:00", openPrice: "71600", highPrice: "72300", lowPrice: "71500", closePrice: "72000", volume: "3521000", currency: "KRW" }] } });
    if (u.pathname === "/api/v1/stocks") return respond(200, { result: [{ symbol: u.searchParams.get("symbols"), name: "삼성전자", currency: "KRW", status: "ACTIVE" }] });
    if (u.pathname === "/api/v1/stocks/all") return respond(200, { result: [{ symbol: "005930", name: "삼성전자" }] });
    if (u.pathname === "/api/v1/exchange-rate") return respond(200, { result: { baseCurrency: u.searchParams.get("baseCurrency"), quoteCurrency: u.searchParams.get("quoteCurrency"), rate: "1380.5" } });
    if (u.pathname.startsWith("/api/v1/market-calendar/")) return respond(200, { result: { market: u.pathname.split("/").pop(), dates: ["2026-01-01"] } });
    if (/^\/api\/v1\/stocks\/[^/]+\/warnings$/.test(u.pathname)) return respond(200, { result: { symbol: decodeURIComponent(u.pathname.split("/")[3]), warnings: [] } });
    if (u.pathname === "/api/v1/accounts") return respond(200, { result: [{ accountSeq: "1" }] });
    return respond(404, { result: null, error: "unmocked" });
  };
  return { seen, restore: () => { globalThis.fetch = realFetch; } };
}

function setup(limits = {}) {
  resetTokenCache();
  return createAdapterRegistry([createTossInvestAdapter({ clientId: "id", clientSecret: "secret" }, limits)]);
}

// ---------------------------------------------------------------------------

test("normalizeSymbol strips kr:/us: prefixes", () => {
  assert.equal(normalizeSymbol("kr:005930"), "005930");
  assert.equal(normalizeSymbol("us:AAPL"), "AAPL");
  assert.equal(normalizeSymbol("KR:005930"), "005930");
  assert.equal(normalizeSymbol("005930"), "005930");
  assert.equal(normalizeSymbol("AAPL"), "AAPL");
});

test("pre-check: BUY blocked when buying power insufficient", async () => {
  const mock = installMock({ cashBuyingPower: "1000" }); // only 1000 KRW
  try {
    const registry = setup({ enforcePreChecks: true });
    const result = await executeAdapter(registry, "api", {
      operation: "create_order",
      target: { accountSeq: "1" },
      symbol: "kr:005930",
      side: "BUY",
      orderType: "LIMIT",
      quantity: 1,
      price: 70000, // needs 70000 > 1000
    }, gateOptions());
    assert.equal(result.success, false);
    assert.equal(result.code, "INSUFFICIENT_BALANCE");
    assert.ok(!mock.seen.urls.some(u => u.startsWith("/api/v1/orders")), "order must not be sent");
  } finally { mock.restore(); }
});

test("pre-check: BUY passes when buying power sufficient and order is sent with bare symbol", async () => {
  const mock = installMock({ cashBuyingPower: "1000000" });
  try {
    const registry = setup({ enforcePreChecks: true });
    const result = await executeAdapter(registry, "api", {
      operation: "create_order",
      target: { accountSeq: "1" },
      symbol: "kr:005930",
      side: "BUY",
      orderType: "LIMIT",
      quantity: 1,
      price: 70000,
    }, gateOptions());
    assert.equal(result.success, true, JSON.stringify(result));
    assert.ok(mock.seen.urls.some(u => u.startsWith("/api/v1/orders")), "order sent");
    // symbol normalization: buying-power call went with account header
    assert.ok(mock.seen.accountHeaders.includes("1"));
  } finally { mock.restore(); }
});

test("pre-check: SELL blocked when sellable quantity insufficient", async () => {
  const mock = installMock({ sellableQuantity: "5" });
  try {
    const registry = setup({ enforcePreChecks: true });
    const result = await executeAdapter(registry, "api", {
      operation: "create_order",
      target: { accountSeq: "1" },
      symbol: "005930",
      side: "SELL",
      orderType: "LIMIT",
      quantity: 100, // needs 100 > 5
      price: 70000,
    }, gateOptions());
    assert.equal(result.success, false);
    assert.equal(result.code, "INSUFFICIENT_HOLDINGS");
    assert.ok(!mock.seen.urls.some(u => u.startsWith("/api/v1/orders")), "order must not be sent");
  } finally { mock.restore(); }
});

test("pre-check: SELL passes when sellable quantity sufficient", async () => {
  const mock = installMock({ sellableQuantity: "100" });
  try {
    const registry = setup({ enforcePreChecks: true });
    const result = await executeAdapter(registry, "api", {
      operation: "create_order",
      target: { accountSeq: "1" },
      symbol: "005930",
      side: "SELL",
      orderType: "LIMIT",
      quantity: 100,
      price: 70000,
    }, gateOptions());
    assert.equal(result.success, true, JSON.stringify(result));
  } finally { mock.restore(); }
});

test("pre-check disabled by default (no buying-power call)", async () => {
  const mock = installMock({ cashBuyingPower: "0" }); // would block if enforced
  try {
    const registry = setup(); // no enforcePreChecks
    const result = await executeAdapter(registry, "api", {
      operation: "create_order",
      target: { accountSeq: "1" },
      symbol: "005930",
      side: "BUY",
      orderType: "LIMIT",
      quantity: 1,
      price: 70000,
    }, gateOptions());
    assert.equal(result.success, true, JSON.stringify(result));
    assert.ok(!mock.seen.urls.some(u => u.startsWith("/api/v1/buying-power")), "buying-power not queried when disabled");
  } finally { mock.restore(); }
});

test("buying_power operation returns cashBuyingPower", async () => {
  const mock = installMock({ cashBuyingPower: "5000000" });
  try {
    const registry = setup();
    const result = await executeAdapter(registry, "api", {
      operation: "get_buying_power",
      target: { accountSeq: "1" },
      currency: "KRW",
    }, gateOptions());
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.buying_power.cashBuyingPower, "5000000");
    assert.equal(result.buying_power.currency, "KRW");
  } finally { mock.restore(); }
});

test("sellable_quantity operation returns quantity and sends account header", async () => {
  const mock = installMock({ sellableQuantity: "42" });
  try {
    const registry = setup();
    const result = await executeAdapter(registry, "api", {
      operation: "get_sellable_quantity",
      target: { accountSeq: "77" },
      symbol: "005930",
    }, gateOptions());
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.sellable_quantity.sellableQuantity, "42");
    assert.ok(mock.seen.accountHeaders.includes("77"));
  } finally { mock.restore(); }
});

test("commissions operation returns list", async () => {
  const mock = installMock();
  try {
    const registry = setup();
    const result = await executeAdapter(registry, "api", { operation: "get_commissions", target: { accountSeq: "1" } }, gateOptions());
    assert.equal(result.success, true, JSON.stringify(result));
    assert.ok(Array.isArray(result.commissions));
  } finally { mock.restore(); }
});

test("trades operation returns recent trades", async () => {
  const mock = installMock();
  try {
    const registry = setup();
    const result = await executeAdapter(registry, "api", { operation: "get_trades", target: { accountSeq: "1" }, symbol: "kr:005930", count: 10 }, gateOptions());
    assert.equal(result.success, true, JSON.stringify(result));
    assert.ok(Array.isArray(result.trades));
    assert.ok(mock.seen.urls.some(u => u.includes("/api/v1/trades?symbol=005930")), `symbol normalized in URL: ${mock.seen.urls.join(",")}`);
  } finally { mock.restore(); }
});

test("candles operation sends interval and returns candles", async () => {
  const mock = installMock();
  try {
    const registry = setup();
    const result = await executeAdapter(registry, "api", { operation: "get_candles", target: { accountSeq: "1" }, symbol: "005930", interval: "1d", count: 10 }, gateOptions());
    assert.equal(result.success, true, JSON.stringify(result));
    assert.ok(mock.seen.urls.some(u => u.includes("interval=1d")), mock.seen.urls.join(","));
  } finally { mock.restore(); }
});

test("stocks and stocks_all operations", async () => {
  const mock = installMock();
  try {
    const registry = setup();
    const r1 = await executeAdapter(registry, "api", { operation: "get_stocks", target: { accountSeq: "1" }, symbols: ["005930"] }, gateOptions());
    assert.equal(r1.success, true, JSON.stringify(r1));
    const r2 = await executeAdapter(registry, "api", { operation: "get_stocks_all", target: { accountSeq: "1" }, market: "KOSPI", status: "ACTIVE" }, gateOptions());
    assert.equal(r2.success, true, JSON.stringify(r2));
  } finally { mock.restore(); }
});

test("exchange_rate and market_calendar operations", async () => {
  const mock = installMock();
  try {
    const registry = setup();
    const r1 = await executeAdapter(registry, "api", { operation: "get_exchange_rate", target: { accountSeq: "1" }, baseCurrency: "USD", quoteCurrency: "KRW" }, gateOptions());
    assert.equal(r1.success, true, JSON.stringify(r1));
    assert.equal(r1.exchange_rate.rate, "1380.5");
    const r2 = await executeAdapter(registry, "api", { operation: "get_market_calendar", target: { accountSeq: "1" }, market: "KR" }, gateOptions());
    assert.equal(r2.success, true, JSON.stringify(r2));
  } finally { mock.restore(); }
});

test("stock_warnings operation returns warnings for symbol", async () => {
  const mock = installMock();
  try {
    const registry = setup();
    const result = await executeAdapter(registry, "api", { operation: "get_stock_warnings", target: { accountSeq: "1" }, symbol: "us:AAPL" }, gateOptions());
    assert.equal(result.success, true, JSON.stringify(result));
    assert.ok(mock.seen.urls.some(u => u.includes("/api/v1/stocks/AAPL/warnings")), `symbol normalized: ${mock.seen.urls.join(",")}`);
  } finally { mock.restore(); }
});

test("direct API helpers build correct paths (unit)", async () => {
  const mock = installMock();
  try {
    resetTokenCache();
    await getBuyingPower("tok", "1", "USD");
    await getSellableQuantity("tok", "1", "kr:005930");
    await getTrades("tok", "kr:005930", 5);
    await getCandles("tok", "005930", "1m", { count: 20 });
    await getStocks("tok", ["005930", "us:AAPL"]);
    await listStocksAll("tok", "KOSPI", { status: "ACTIVE" });
    await getExchangeRate("tok", "USD", "KRW", "2026-03-25T09:30:00+09:00");
    await getMarketCalendar("tok", "US");
    await getStockWarnings("tok", "kr:005930");
    await getCommissions("tok", "1");
    assert.ok(mock.seen.urls.some(u => u.includes("/api/v1/buying-power?currency=USD")));
    assert.ok(mock.seen.urls.some(u => u.includes("/api/v1/sellable-quantity?symbol=005930")));
    assert.ok(mock.seen.urls.some(u => u.includes("/api/v1/trades?symbol=005930&count=5")));
    assert.ok(mock.seen.urls.some(u => u.includes("/api/v1/candles?symbol=005930&interval=1m&count=20")));
    assert.ok(mock.seen.urls.some(u => u.includes("/api/v1/stocks?symbols=005930,AAPL")));
    assert.ok(mock.seen.urls.some(u => u.includes("/api/v1/stocks/all?market=KOSPI&status=ACTIVE")));
    assert.ok(mock.seen.urls.some(u => u.includes("/api/v1/exchange-rate?baseCurrency=USD&quoteCurrency=KRW&dateTime=")));
    assert.ok(mock.seen.urls.some(u => u.includes("/api/v1/market-calendar/US")));
    assert.ok(mock.seen.urls.some(u => u.includes("/api/v1/stocks/005930/warnings")));
    assert.ok(mock.seen.urls.some(u => u.includes("/api/v1/commissions")));
  } finally { mock.restore(); }
});
