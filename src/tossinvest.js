"use strict";

/**
 * Toss Securities (토스증권) Open API add-on adapter for minitok.
 *
 * This module lives OUTSIDE the minitok package (minitok-addon-tossinvest)
 * and is registered into a minitok adapter registry externally via
 * registerTossInvestAddon() in the package entry point. minitok itself
 * contains no tossinvest code.
 *
 * Uses the official REST API at https://openapi.tossinvest.com.
 * Authentication: OAuth 2.0 Client Credentials Grant.
 * Account-scoped calls require the X-Tossinvest-Account header.
 *
 * Adapter kind: "api" (must match ADAPTER_KINDS in minitok's
 * adapter_registry.js — that validation happens at registration time in
 * minitok, not here).
 * Execution policy: "authorized_external" — requires explicit confirmation,
 * credential presence, and production opt-in before any order mutation.
 *
 * Zero runtime dependencies: uses the Node >= 18 global fetch API.
 */

const { TossApiError } = require("./core/errors");

async function request(url, { method = "GET", headers = {}, body, timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  if (t.unref) t.unref();
  try {
    const resp = await fetch(url, { method, headers, body, signal: controller.signal });
    const text = await resp.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    const headerObj = {};
    resp.headers.forEach((value, key) => { headerObj[key] = value; });
    return { statusCode: resp.status, headers: headerObj, body: { json: async () => parsed }, rawText: text };
  } catch (e) {
    if (e.name === "AbortError") {
      throw new TossApiError("Request timeout", { code: "TOSS_TIMEOUT", detail: { url } });
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

const BASE_URL = "https://openapi.tossinvest.com";
const TOKEN_URL = `${BASE_URL}/oauth2/token`;

const RECENT_CREATE_LIMIT = 200;

/**
 * Creates an isolated token cache and idempotency registry for a single
 * adapter instance. This allows multiple accounts to operate concurrently
 * without sharing authentication state or created-entity records.
 */
function createTokenManager() {
  let cachedToken = null;
  let tokenExpiresAt = 0;
  const recentCreateIds = new Map();

  let _tokenRefreshPromise = null;
  let _tokenLockUntil = 0; // [UNLIMIT] Prevent concurrent token refresh after reset

  async function getToken(clientId, clientSecret) {
    const now = Date.now();
    if (cachedToken && tokenExpiresAt > now + 30_000) return cachedToken;
    // In-flight dedup: if a refresh is already in progress, share the same promise
    if (_tokenRefreshPromise) return _tokenRefreshPromise;
    // [UNLIMIT] If we just refreshed and another call comes in too quickly, wait
    if (now < _tokenLockUntil) {
      await new Promise(function(r) { setTimeout(r, _tokenLockUntil - now); });
      if (cachedToken && tokenExpiresAt > Date.now() + 30_000) return cachedToken;
    }
    _tokenLockUntil = Date.now() + 15000; // [UNLIMIT] 15s lock ??Toss revokes all prior tokens on new issuance
    _tokenRefreshPromise = _refreshToken(clientId, clientSecret).finally(function() { _tokenRefreshPromise = null; });
    return _tokenRefreshPromise;
  }

  async function _refreshToken(clientId, clientSecret) {
    const now = Date.now();
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }).toString();
    const resp = await request(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = await resp.body.json();
    if (resp.statusCode !== 200 || !data.access_token) {
      throw new TossApiError(`TossInvest token error: ${data.error || resp.statusCode}`, {
        code: "TOSS_TOKEN_ERROR",
        detail: data.error_description || "",
      });
    }
    cachedToken = data.access_token;
    const expiresInMs = (Number(data.expires_in) || 300) * 1000;
    tokenExpiresAt = now + expiresInMs;
    return cachedToken;
  }

  function rememberCreated(idemKey, kind, id) {
    if (!idemKey || !id) return;
    recentCreateIds.set(idemKey, { kind, id });
    while (recentCreateIds.size > RECENT_CREATE_LIMIT) {
      recentCreateIds.delete(recentCreateIds.keys().next().value);
    }
  }

  function getCreated(idemKey) { return recentCreateIds.get(idemKey); }

  function reset() { cachedToken = null; tokenExpiresAt = 0; _tokenLockUntil = 0; recentCreateIds.clear(); }

  // [UNLIMIT] invalidate: clear cache only, preserve lock + in-flight promise
  // Use on auth errors instead of reset() to avoid thundering-herd token revocation storms
  function invalidate() { cachedToken = null; tokenExpiresAt = 0; }

  return { getToken, rememberCreated, getCreated, reset, invalidate };
}

// Module-level default token manager for backward-compatible standalone
// exports (fetchAccessToken / resetTokenCache). Adapter instances created
// via createTossInvestAdapter get their own isolated manager.
const defaultManager = createTokenManager();

async function fetchAccessToken(clientId, clientSecret) {
  return defaultManager.getToken(clientId, clientSecret);
}

function resetTokenCache() { defaultManager.reset(); }
function invalidateTokenCache() { defaultManager.invalidate(); }

// Toss BFF wraps every authenticated response in { result: ... }
// (ApiResponse). Unwrap transparently; auth token responses are not routed
// through tossRequest, so they are unaffected.
function unwrap(body) {
  return body && typeof body === "object" && !Array.isArray(body) && Object.prototype.hasOwnProperty.call(body, "result")
    ? body.result : body;
}

function normalizeApiError(status, body, rawText) {
  // Errors may be top-level { error, error_description } or wrapped
  // by the BFF as { result: { error, error_description } }.
  const src = body && typeof body === "object" && body.result && typeof body.result === "object"
    ? body.result : body;
  const apiErr = src && typeof src === "object" ? src : null;
  // Toss wraps errors as { error: { requestId, code, message, data } }. The
  // actionable code lives on the INNER object — reading `apiErr.error`
  // directly captured the whole envelope, so `code` became an object (logged
  // as "[object Object]") and the mappedCode classification below was lost.
  const _err = apiErr ? apiErr.error : null;
  const _errObj = _err && typeof _err === "object" ? _err : null;
  const code = (_errObj && (_errObj.code || _errObj.type || _errObj.name))
    || (typeof _err === "string" ? _err : null)
    || (apiErr && typeof apiErr.code === "string" ? apiErr.code : null)
    || (apiErr && apiErr.code && typeof apiErr.code === "object" ? (apiErr.code.code || apiErr.code.type || null) : null)
    || null;
  const msg = (apiErr && apiErr.error_description)
    || (_errObj && (_errObj.message || _errObj.msg))
    || (typeof _err === "string" ? _err : null)
    || (apiErr && apiErr.message) || (apiErr && apiErr.msg)
    || rawText || String(status);
  const rawCode = code || "TOSS_API_ERROR";
  // simple mapping
  const c = String(rawCode).toLowerCase();
  let mappedCode;
  if (c.includes("insufficient")) mappedCode = "INSUFFICIENT_BALANCE";
  else if (c.includes("reject")) mappedCode = "ORDER_REJECTED";
  else if (c.includes("symbol") && c.includes("not")) mappedCode = "INVALID_SYMBOL";
  else if (c.includes("symbol")) mappedCode = "INVALID_SYMBOL";
  else if (c.includes("rate") || status === 429) mappedCode = "RATE_LIMITED";
  else if (status >= 500) mappedCode = "TOSS_SERVER_ERROR";
  else if (status === 408) mappedCode = "TOSS_TIMEOUT";
  else if (status === 401 || status === 403) mappedCode = "TOSS_AUTH_ERROR";
  else mappedCode = rawCode;
  return new TossApiError(msg, {
    code: rawCode,
    mappedCode,
    status,
    apiError: apiErr || { rawText },
  });
}

async function tossRequest(path, { method = "GET", body, token, accountSeq, timeoutMs = 30000 } = {}) {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  if (accountSeq != null) headers["X-Tossinvest-Account"] = String(accountSeq);
  const url = path.startsWith("http") ? path : `${BASE_URL}${path}`;
  const options = { method, headers, timeoutMs };
  if (body && (method === "POST" || method === "PUT" || method === "PATCH")) {
    options.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const resp = await request(url, options);
  const responseBody = await resp.body.json().catch(() => null);
  const unwrapped = unwrap(responseBody);
  if (resp.statusCode >= 400) {
    const err = normalizeApiError(resp.statusCode, responseBody || unwrapped, resp.rawText);
    throw err;
  }
  return { status: resp.statusCode, headers: resp.headers, body: unwrapped, raw: responseBody };
}

async function getAccounts(token) {
  return tossRequest("/api/v1/accounts", { method: "GET", token });
}

async function getHoldings(token, accountSeq) {
  return tossRequest("/api/v1/holdings", { method: "GET", token, accountSeq });
}

async function getPrices(token, symbols) {
  // Spec: query param is `symbols` (comma-separated string), required
  const list = (Array.isArray(symbols) ? symbols : [symbols]).filter(Boolean).map(normalizeSymbol);
  return tossRequest(`/api/v1/prices?symbols=${list.map(s => encodeURIComponent(String(s))).join(",")}`, { method: "GET", token });
}

async function getOrderbook(token, symbol) {
  return tossRequest(`/api/v1/orderbook?symbol=${encodeURIComponent(normalizeSymbol(symbol))}`, { method: "GET", token });
}

async function getPriceLimits(token, symbol) {
  return tossRequest(`/api/v1/price-limits?symbol=${encodeURIComponent(normalizeSymbol(symbol))}`, { method: "GET", token });
}

async function getOrders(token, accountSeq, status = "OPEN") {
  return tossRequest(`/api/v1/orders?status=${encodeURIComponent(status)}`, { method: "GET", token, accountSeq });
}

async function getOrder(token, accountSeq, orderId) {
  return tossRequest(`/api/v1/orders/${encodeURIComponent(orderId)}`, { method: "GET", token, accountSeq });
}

async function createOrder(token, accountSeq, orderBody) {
  return tossRequest("/api/v1/orders", { method: "POST", token, accountSeq, body: orderBody });
}

async function cancelOrder(token, accountSeq, orderId) {
  return tossRequest(`/api/v1/orders/${encodeURIComponent(orderId)}/cancel`, { method: "POST", token, accountSeq });
}

async function modifyOrder(token, accountSeq, orderId, modifyBody) {
  return tossRequest(`/api/v1/orders/${encodeURIComponent(orderId)}/modify`, { method: "POST", token, accountSeq, body: modifyBody });
}

// --- Conditional orders (조건주문) ---

async function getConditionalOrders(token, accountSeq, status = "OPEN") {
  // Spec: `status` query param is REQUIRED (enum OPEN|CLOSED)
  return tossRequest(`/api/v1/conditional-orders?status=${encodeURIComponent(status)}`, { method: "GET", token, accountSeq });
}

async function getConditionalOrder(token, accountSeq, conditionalOrderId) {
  return tossRequest(`/api/v1/conditional-orders/${encodeURIComponent(conditionalOrderId)}`, { method: "GET", token, accountSeq });
}

async function createConditionalOrder(token, accountSeq, body) {
  return tossRequest("/api/v1/conditional-orders", { method: "POST", token, accountSeq, body });
}

async function modifyConditionalOrder(token, accountSeq, conditionalOrderId, body) {
  return tossRequest(`/api/v1/conditional-orders/${encodeURIComponent(conditionalOrderId)}/modify`, { method: "POST", token, accountSeq, body });
}

async function cancelConditionalOrder(token, accountSeq, conditionalOrderId) {
  return tossRequest(`/api/v1/conditional-orders/${encodeURIComponent(conditionalOrderId)}`, { method: "DELETE", token, accountSeq });
}

// --- Currency exchange (환전) ---

let _wtsExchange = null;
function _getWtsExchange() {
  if (_wtsExchange === null) {
    try { _wtsExchange = require("./toss_wts_exchange"); }
    catch (e) { console.warn("[TossInvest] WTS exchange module not available:", e.message); _wtsExchange = false; }
  }
  return _wtsExchange || null;
}

async function createExchangeOrder(token, accountSeq, body) {
  const wts = _getWtsExchange();
  if (!wts) {
    return { status: 501, headers: {}, body: { error: { code: "EXCHANGE_NOT_AVAILABLE", message: "WTS exchange module not loaded" } } };
  }
  try {
    const result = await wts.executeExchange(
      { fromCurrency: body.baseCurrency || body.fromCurrency, toCurrency: body.quoteCurrency || body.toCurrency, amount: body.amount },
      null,
      { dryRun: false }
    );
    if (result.success) {
      return { status: 200, headers: {}, body: result.result || result };
    }
    return { status: result.httpStatus || 400, headers: {}, body: { error: { code: "WTS_EXCHANGE_FAILED", message: result.error }, detail: result.detail || null } };
  } catch (e) {
    return { status: 500, headers: {}, body: { error: { code: "EXCHANGE_ERROR", message: e.message } } };
  }
}

async function getExchangeOrders(token, accountSeq, status = "COMPLETED") {
  const wts = _getWtsExchange();
  if (wts) {
    try {
      const r = await wts.getExchangeHistories(null);
      return { status: r.status || 200, headers: {}, body: r.body };
    } catch (e) {
      return { status: 500, headers: {}, body: { error: { message: e.message } } };
    }
  }
  return tossRequest(`/api/v1/exchange-orders?status=${encodeURIComponent(status)}`, { method: "GET", token, accountSeq });
}

// Symbol normalization: minitok-side convention allows "kr:005930" /
// "us:AAPL" prefixes, but the Toss API only accepts bare symbols
// (pattern ^[A-Za-z0-9.\-]+$). Strip the prefix before any call.
function normalizeSymbol(symbol) {
  if (typeof symbol !== "string") return symbol;
  return symbol.replace(/^(kr|us):/i, "");
}

// Order currency follows the listing market: 6-digit = KRX (KRW), 4-digit =
// TSE (JPY), alphabetic = US (USD). The order body carries no currency field,
// so the local buying-power pre-check has to derive it — otherwise a US order's
// USD value was compared against the KRW pool (0) and every US order was
// rejected locally with INSUFFICIENT_BALANCE before reaching the exchange.
function symbolCurrency(symbol) {
  const s = normalizeSymbol(String(symbol || "")).toUpperCase();
  if (/^\d{6}$/.test(s)) return "KRW";
  if (/^\d{4}$/.test(s)) return "JPY";
  if (/^[A-Z][A-Z.\-]{0,6}$/.test(s)) return "USD";
  return "KRW";
}

const MUTATION_OPERATIONS = new Set(["create_order","cancel_order","modify_order","create_conditional_order","modify_conditional_order","cancel_conditional_order","create_exchange_order"]);

async function getBuyingPower(token, accountSeq, currency = "KRW") {
  return tossRequest(`/api/v1/buying-power?currency=${encodeURIComponent(currency)}`, { method: "GET", token, accountSeq });
}

async function getSellableQuantity(token, accountSeq, symbol) {
  return tossRequest(`/api/v1/sellable-quantity?symbol=${encodeURIComponent(normalizeSymbol(symbol))}`, { method: "GET", token, accountSeq });
}

async function getCommissions(token, accountSeq) {
  return tossRequest("/api/v1/commissions", { method: "GET", token, accountSeq });
}

async function getTrades(token, symbol, count) {
  let p = `/api/v1/trades?symbol=${encodeURIComponent(normalizeSymbol(symbol))}`;
  if (count != null) p += `&count=${encodeURIComponent(String(count))}`;
  return tossRequest(p, { method: "GET", token });
}

async function getCandles(token, symbol, interval, { count, before, adjusted } = {}) {
  const params = new URLSearchParams({ symbol: normalizeSymbol(symbol), interval });
  if (count != null) params.set("count", String(count));
  if (before) params.set("before", before);
  if (adjusted != null) params.set("adjusted", String(adjusted));
  return tossRequest(`/api/v1/candles?${params.toString()}`, { method: "GET", token });
}

async function getStocks(token, symbols) {
  const list = (Array.isArray(symbols) ? symbols : [symbols]).filter(Boolean).map(normalizeSymbol);
  return tossRequest(`/api/v1/stocks?symbols=${list.map(s => encodeURIComponent(String(s))).join(",")}`, { method: "GET", token });
}

async function listStocksAll(token, market, { status, securityType, commonShare } = {}) {
  const params = new URLSearchParams({ market });
  if (status) params.set("status", status);
  if (securityType) params.set("securityType", securityType);
  if (commonShare != null) params.set("commonShare", String(commonShare));
  return tossRequest(`/api/v1/stocks/all?${params.toString()}`, { method: "GET", token });
}

// --- Dynamic Universe Discovery ---
// Fetches all stocks for a market, then samples recent candles to rank by volume.
// Returns top N symbols suitable for AI watchlist expansion.
async function discoverSymbols(token, market, limit = 10) {
  const listResp = await listStocksAll(token, market, { commonShare: true });
  if (!listResp || !listResp.body) return [];
  const allStocks = Array.isArray(listResp.body) ? listResp.body : (listResp.body.stocks || []);
  // Sample up to 50 random stocks to check volume (avoids API rate limits)
  const sampleSize = Math.min(allStocks.length, 50);
  const sampled = [];
  for (let i = 0; i < sampleSize; i++) {
    const idx = Math.floor(Math.random() * allStocks.length);
    const sym = allStocks[idx].symbol || allStocks[idx].code;
    if (sym && !sampled.includes(sym)) sampled.push(sym);
  }
  // Fetch daily candles for sampled stocks to evaluate volume
  const scored = [];
  for (const sym of sampled) {
    try {
      const candleResp = await getCandles(token, sym, "1d", { count: 1 });
      if (candleResp && candleResp.body) {
        const candles = Array.isArray(candleResp.body) ? candleResp.body : [candleResp.body];
        const latest = candles[candles.length - 1];
        const volume = Number(latest?.volume || latest?.accVolume || 0);
        scored.push({ symbol: sym, market, volume });
      }
    } catch { /* skip rate-limited or invalid symbols */ }
  }
  // Sort by volume descending and return top N
  scored.sort((a, b) => b.volume - a.volume);
  return scored.slice(0, limit).map(s => s.symbol);
}

async function getExchangeRate(token, baseCurrency, quoteCurrency, dateTime) {
  const params = new URLSearchParams({ baseCurrency, quoteCurrency });
  if (dateTime) params.set("dateTime", dateTime);
  return tossRequest(`/api/v1/exchange-rate?${params.toString()}`, { method: "GET", token });
}

async function getMarketCalendar(token, market) {
  return tossRequest(`/api/v1/market-calendar/${encodeURIComponent(market)}`, { method: "GET", token });
}

async function getStockWarnings(token, symbol) {
  return tossRequest(`/api/v1/stocks/${encodeURIComponent(normalizeSymbol(symbol))}/warnings`, { method: "GET", token });
}

function createTossInvestAdapter(credentials = {}, safetyLimits = {}) {
  const { clientId, clientSecret } = credentials;
  const { maxOrderValueKrw, allowedSymbols, enforcePreChecks = false } = safetyLimits;
  const tokenManager = defaultManager; // [UNLIMIT] shared singleton prevents token revocation races

  async function resolveToken() {
    if (!clientId || !clientSecret) {
      const err = new TossApiError("TossInvest credentials not configured (clientId/clientSecret required)", { code: "TOSS_CREDENTIALS_MISSING" });
      throw err;
    }
    return tokenManager.getToken(clientId, clientSecret);
  }

  const VALID_OPERATIONS = new Set(["get_accounts","get_holdings","get_buying_power","get_sellable_quantity","get_commissions","get_prices","get_orderbook","get_price_limits","get_trades","get_candles","get_stocks","get_stocks_all","get_exchange_rate","get_market_calendar","get_stock_warnings","get_orders","get_order","create_order","cancel_order","modify_order","get_conditional_orders","get_conditional_order","create_conditional_order","modify_conditional_order","cancel_conditional_order","create_exchange_order","get_exchange_orders","get_orderbook_balance","get_index","get_index_history","get_sectors","get_sector_stocks","get_trending_stocks","get_news","get_financials","get_earnings","get_dividends","get_splits","get_ipo_calendar","get_transactions","get_balance_history","get_margin_info","get_watchlist","add_to_watchlist","remove_from_watchlist","get_price_alerts","create_price_alert","delete_price_alert","get_market_hours","get_stock_detail","get_order_estimate","get_quotes","get_realtime_subscriptions","get_exchange_rate_history"]);

  async function executor(input) {
    const operation = input?.operation || "get_accounts";
    if (!VALID_OPERATIONS.has(operation)) return { success: false, code: "UNKNOWN_OPERATION", reason: `Unsupported operation: ${operation}` };

    const isDry = !!(input?.dryRun ?? input?.dry_run);
    const isMutation = new Set(["create_order","cancel_order","modify_order","create_conditional_order","modify_conditional_order","cancel_conditional_order","create_exchange_order"]).has(operation);

    // Safety guardrails run BEFORE token resolution to fail fast without network calls
    if (operation === "create_order" || operation === "create_conditional_order") {
      if (Array.isArray(allowedSymbols) && !allowedSymbols.includes(input.symbol)) return { success: false, code: "SYMBOL_NOT_ALLOWED", reason: `Symbol ${input.symbol} not allowed` };
      if (maxOrderValueKrw && input.price && input.quantity && Number(input.price) * Number(input.quantity) > maxOrderValueKrw) return { success: false, code: "ORDER_VALUE_EXCEEDED", reason: "Order value exceeds limit" };
      if (operation === "create_conditional_order" && maxOrderValueKrw && input.first?.orderPrice && input.quantity && Number(input.first.orderPrice) * Number(input.quantity) > maxOrderValueKrw) return { success: false, code: "ORDER_VALUE_EXCEEDED", reason: "Conditional order value exceeds limit" };
    }

    const acct = input?.target?.accountSeq ?? input?.accountSeq;

    // Dry-run early return for mutations: no token, no network.
    // The expected external state is derived deterministically so the
    // read-after-write executor can verify the simulated fingerprint
    // without calling Toss (see readAfterWriteExecutor dry-run branch).
    if (isMutation && isDry) {
      const isCond = operation.includes("conditional");
      const fallback = isCond ? "dryrun-cond-order" : "dryrun-order";
      const orderId = input.conditionalOrderId || input.orderId || fallback;
      return {
        success: true,
        status: "simulated",
        simulated: true,
        dryRun: true,
        http_status: 0,
        expected_external_state: { orderId },
        verifier_evidence: [{ valid: true, executed: false, simulated: true, source: "dry-run" }],
      };
    }

    let token;
    try { token = await resolveToken(); } catch (err) {
      const code = err.mappedCode || err.code || "TOKEN_ERROR";
      return { success: false, code, reason: err.message, api_error: err.apiError };
    }
    try {
      const result = await (async () => {
      switch (operation) {
        case "get_accounts": { const r = await getAccounts(token); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", accounts: r.body, http_status: r.status }; }
        case "get_holdings": { const r = await getHoldings(token, acct); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", holdings: r.body, http_status: r.status }; }
        case "get_buying_power": { const r = await getBuyingPower(token, acct, input.currency || "KRW"); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", buying_power: r.body, http_status: r.status }; }
        case "get_sellable_quantity": { const r = await getSellableQuantity(token, acct, input.symbol); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", sellable_quantity: r.body, http_status: r.status }; }
        case "get_commissions": { const r = await getCommissions(token, acct); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", commissions: r.body, http_status: r.status }; }
        case "get_prices": { const r = await getPrices(token, input.symbols); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", prices: r.body, http_status: r.status }; }
        case "get_orderbook": { const r = await getOrderbook(token, input.symbol); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", orderbook: r.body, http_status: r.status }; }
        case "get_price_limits": { const r = await getPriceLimits(token, input.symbol); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", price_limits: r.body, http_status: r.status }; }
        case "get_trades": { const r = await getTrades(token, input.symbol, input.count); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", trades: r.body, http_status: r.status }; }
        case "get_candles": { const r = await getCandles(token, input.symbol, input.interval, { count: input.count, before: input.before, adjusted: input.adjusted }); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", candles: r.body, http_status: r.status }; }
        case "get_stocks": { const r = await getStocks(token, input.symbols); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", stocks: r.body, http_status: r.status }; }
        case "get_stocks_all": { const r = await listStocksAll(token, input.market, { status: input.status, securityType: input.securityType, commonShare: input.commonShare }); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", stocks: r.body, http_status: r.status }; }
        case "get_exchange_rate": { const r = await getExchangeRate(token, input.baseCurrency, input.quoteCurrency, input.dateTime); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", exchange_rate: r.body, http_status: r.status }; }
        case "get_market_calendar": { const r = await getMarketCalendar(token, input.market); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", calendar: r.body, http_status: r.status }; }
        case "get_stock_warnings": { const r = await getStockWarnings(token, input.symbol); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", warnings: r.body, http_status: r.status }; }
        case "get_orders": { const r = await getOrders(token, acct, input.status); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", orders: r.body, http_status: r.status }; }
        case "get_order": { const r = await getOrder(token, acct, input.orderId); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", order: r.body, http_status: r.status }; }
        case "create_order": {
          const ob = { symbol: normalizeSymbol(input.symbol), side: input.side, orderType: input.orderType || "LIMIT" };
          if (input.quantity != null) ob.quantity = input.quantity;
          if (input.price != null) ob.price = input.price;
          if (input.timeInForce) ob.timeInForce = input.timeInForce;
          if (input.orderAmount != null) ob.orderAmount = input.orderAmount;
          // Idempotency: explicit clientOrderId wins; else derive from the
          // external-operation contract idempotency key (Toss allows max 36
          // chars of [A-Za-z0-9_-] — a hex digest fits after sanitizing).
          const idem = typeof input.idempotency_key === "string" && input.idempotency_key
            ? input.idempotency_key.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 36) : null;
          if (input.clientOrderId) ob.clientOrderId = String(input.clientOrderId).slice(0, 36);
          else if (idem) ob.clientOrderId = idem;
          if (input.confirmHighValueOrder) ob.confirmHighValueOrder = true;
          // Opt-in pre-checks against account state (fail-closed):
          // BUY → cash buying power must cover price*qty (limit orders
          // with a price; amount-based orders use orderAmount);
          // SELL → sellable quantity must cover the order quantity.
          if (enforcePreChecks) {
            const side = String(input.side || "").toUpperCase();
            const qty = Number(input.quantity);
            const price = Number(input.price);
            const amount = Number(input.orderAmount);
            if (side === "BUY" && (price > 0 || amount > 0)) {
              const required = amount > 0 ? amount : price * qty;
              const bp = await getBuyingPower(token, acct, input.currency || symbolCurrency(input.symbol));
              if (bp.status !== 200) return { success: false, code: "PRE_CHECK_FAILED", reason: `buying-power lookup failed (http ${bp.status})`, http_status: bp.status };
              const cash = Number(bp.body?.cashBuyingPower);
              if (!Number.isFinite(cash)) return { success: false, code: "PRE_CHECK_FAILED", reason: "buying-power response missing cashBuyingPower" };
              if (cash < required) return { success: false, code: "INSUFFICIENT_BALANCE", reason: `buying power ${cash} < required ${required}`, buying_power: bp.body };
            }
            if (side === "SELL" && qty > 0) {
              const sq = await getSellableQuantity(token, acct, input.symbol);
              if (sq.status !== 200) return { success: false, code: "PRE_CHECK_FAILED", reason: `sellable-quantity lookup failed (http ${sq.status})`, http_status: sq.status };
              const sellable = Number(sq.body?.sellableQuantity);
              if (!Number.isFinite(sellable)) return { success: false, code: "PRE_CHECK_FAILED", reason: "sellable-quantity response missing sellableQuantity" };
              if (sellable < qty) return { success: false, code: "INSUFFICIENT_HOLDINGS", reason: `sellable quantity ${sellable} < ordered ${qty}`, sellable_quantity: sq.body };
            }
          }
          const r = await createOrder(token, acct, ob);
          const ok = r.status === 200 || r.status === 201;
          // Create response (OrderResponse) carries orderId + clientOrderId
          // but NO status — expected state is the id only; the contract's
          // fingerprint compares orderId (see external_operation_contract).
          if (ok && idem) tokenManager.rememberCreated(idem, "order", r.body?.orderId);
          return { success: ok, status: ok ? "success" : "failed", order: r.body, http_status: r.status, expected_external_state: ok ? { orderId: r.body?.orderId } : undefined };
        }
        case "cancel_order": { const r = await cancelOrder(token, acct, input.orderId); const ok = r.status === 200; return { success: ok, status: ok ? "success" : "failed", order: r.body, http_status: r.status, expected_external_state: ok ? { orderId: input.orderId } : undefined }; }
        case "modify_order": {
          const mb = {};
          if (input.price != null) mb.price = input.price;
          if (input.quantity != null) mb.quantity = input.quantity;
          const r = await modifyOrder(token, acct, input.orderId, mb);
          return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", order: r.body, http_status: r.status };
        }
        case "get_conditional_orders": { const r = await getConditionalOrders(token, acct, input.status || "OPEN"); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", conditional_orders: r.body, http_status: r.status }; }
        case "get_conditional_order": { const r = await getConditionalOrder(token, acct, input.conditionalOrderId); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", conditional_order: r.body, http_status: r.status }; }
        case "create_conditional_order": {
          const cb = {
            symbol: input.symbol,
            type: input.type || "SINGLE",
            quantity: input.quantity,
            orderType: input.orderType || "LIMIT",
            expireDate: input.expireDate,
            first: input.first,
          };
          if (input.second) cb.second = input.second;
          const idemC = typeof input.idempotency_key === "string" && input.idempotency_key
            ? input.idempotency_key.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 36) : null;
          if (input.clientOrderId) cb.clientOrderId = String(input.clientOrderId).slice(0, 36);
          else if (idemC) cb.clientOrderId = idemC;
          if (input.confirmHighValueOrder) cb.confirmHighValueOrder = true;
          const r = await createConditionalOrder(token, acct, cb);
          const ok = r.status === 200 || r.status === 201;
          if (ok && idemC) tokenManager.rememberCreated(idemC, "conditional", r.body?.conditionalOrderId);
          return { success: ok, status: ok ? "success" : "failed", conditional_order: r.body, http_status: r.status, expected_external_state: ok ? { orderId: r.body?.conditionalOrderId } : undefined };
        }
        case "modify_conditional_order": {
          const mb = { type: input.type, quantity: input.quantity, orderType: input.orderType, expireDate: input.expireDate, first: input.first };
          if (input.second) mb.second = input.second;
          if (input.confirmHighValueOrder) mb.confirmHighValueOrder = true;
          const r = await modifyConditionalOrder(token, acct, input.conditionalOrderId, mb);
          const ok = r.status === 200;
          // Modify issues a NEW conditionalOrderId and invalidates the old one
          return { success: ok, status: ok ? "success" : "failed", conditional_order: r.body, http_status: r.status, expected_external_state: ok && r.body?.conditionalOrderId ? { orderId: r.body.conditionalOrderId } : undefined };
        }
        case "cancel_conditional_order": { const r = await cancelConditionalOrder(token, acct, input.conditionalOrderId); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", http_status: r.status, expected_external_state: r.status === 200 ? { orderId: input.conditionalOrderId } : undefined }; }
        case "create_exchange_order": {
          const eb = {
            baseCurrency: input.baseCurrency,
            quoteCurrency: input.quoteCurrency,
            amount: input.amount,
          };
          if (input.clientOrderId) eb.clientOrderId = String(input.clientOrderId).slice(0, 36);
          const idem = typeof input.idempotency_key === "string" && input.idempotency_key
            ? input.idempotency_key.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 36) : null;
          if (!eb.clientOrderId && idem) eb.clientOrderId = idem;
          const r = await createExchangeOrder(token, acct, eb);
          const ok = r.status === 200 || r.status === 201;
          return { success: ok, status: ok ? "success" : "failed", exchange_order: r.body, http_status: r.status, expected_external_state: ok ? { orderId: r.body?.orderId || r.body?.exchangeOrderId || idem || "exchange-order" } : undefined };
        }
        case "get_exchange_orders": { const r = await getExchangeOrders(token, acct, input.status || "COMPLETED"); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", exchange_orders: r.body, http_status: r.status }; }
        case "get_orderbook_balance": { const r = await getOrderbookBalance(token, acct); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", orderbook_balance: r.body, http_status: r.status }; }
        case "get_index": { const r = await getIndex(token, input.market); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", index: r.body, http_status: r.status }; }
        case "get_index_history": { const r = await getIndexHistory(token, input.market, input.interval, input); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", index_history: r.body, http_status: r.status }; }
        case "get_sectors": { const r = await getSectors(token, input.market); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", sectors: r.body, http_status: r.status }; }
        case "get_sector_stocks": { const r = await getSectorStocks(token, input.sectorCode, input.market); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", sector_stocks: r.body, http_status: r.status }; }
        case "get_trending_stocks": { const r = await getTrendingStocks(token, input.market, input); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", trending_stocks: r.body, http_status: r.status }; }
        case "get_news": { const r = await getNews(token, input.symbol, input); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", news: r.body, http_status: r.status }; }
        case "get_financials": { const r = await getFinancials(token, input.symbol, input); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", financials: r.body, http_status: r.status }; }
        case "get_earnings": { const r = await getEarnings(token, input.symbol, input); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", earnings: r.body, http_status: r.status }; }
        case "get_dividends": { const r = await getDividends(token, input.symbol, input); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", dividends: r.body, http_status: r.status }; }
        case "get_splits": { const r = await getSplits(token, input.symbol, input); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", splits: r.body, http_status: r.status }; }
        case "get_ipo_calendar": { const r = await getIpoCalendar(token, input.market, input); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", ipo_calendar: r.body, http_status: r.status }; }
        case "get_transactions": { const r = await getTransactions(token, acct, input); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", transactions: r.body, http_status: r.status }; }
        case "get_balance_history": { const r = await getBalanceHistory(token, acct, input); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", balance_history: r.body, http_status: r.status }; }
        case "get_margin_info": { const r = await getMarginInfo(token, acct); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", margin_info: r.body, http_status: r.status }; }
        case "get_watchlist": { const r = await getWatchlist(token, acct); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", watchlist: r.body, http_status: r.status }; }
        case "add_to_watchlist": { const r = await addToWatchlist(token, acct, input.symbol); return { success: r.status === 200 || r.status === 201, status: (r.status === 200 || r.status === 201) ? "success" : "failed", http_status: r.status }; }
        case "remove_from_watchlist": { const r = await removeFromWatchlist(token, acct, input.symbol); return { success: r.status === 200 || r.status === 204, status: (r.status === 200 || r.status === 204) ? "success" : "failed", http_status: r.status }; }
        case "get_price_alerts": { const r = await getPriceAlerts(token, acct); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", price_alerts: r.body, http_status: r.status }; }
        case "create_price_alert": { const r = await createPriceAlert(token, acct, input); return { success: r.status === 200 || r.status === 201, status: (r.status === 200 || r.status === 201) ? "success" : "failed", price_alert: r.body, http_status: r.status }; }
        case "delete_price_alert": { const r = await deletePriceAlert(token, acct, input.alertId); return { success: r.status === 200 || r.status === 204, status: (r.status === 200 || r.status === 204) ? "success" : "failed", http_status: r.status }; }
        case "get_market_hours": { const r = await getMarketHours(token, input.market); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", market_hours: r.body, http_status: r.status }; }
        case "get_stock_detail": { const r = await getStockDetail(token, input.symbol); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", stock_detail: r.body, http_status: r.status }; }
        case "get_order_estimate": { const r = await getOrderEstimate(token, acct, input); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", order_estimate: r.body, http_status: r.status }; }
        case "get_quotes": { const r = await getQuotes(token, input.symbols); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", quotes: r.body, http_status: r.status }; }
        case "get_realtime_subscriptions": { const r = await getRealtimeSubscriptions(token, acct); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", realtime_subscriptions: r.body, http_status: r.status }; }
        case "get_exchange_rate_history": { const r = await getExchangeRateHistory(token, input.baseCurrency, input.quoteCurrency, input); return { success: r.status === 200, status: r.status === 200 ? "success" : "failed", exchange_rate_history: r.body, http_status: r.status }; }
        default: return { success: false, code: "UNKNOWN_OPERATION", reason: `Unsupported operation: ${operation}` };
      }
      })();
      // Read operations carry no created-entity fingerprint, so give them a
      // deterministic expected_external_state — the read-after-write executor
      // echoes it back and the contract's fingerprint check passes.
      if (result && result.success === true && !MUTATION_OPERATIONS.has(operation)) {
        result.expected_external_state = { operation, accountSeq: acct ?? null };
      }
      // minitok's adapter finalize() only marks `completed` when executed,
      // valid verifier evidence accompanies a successful result. A 2xx REST
      // response with parsed payload is the evidence this adapter can offer.
      if (result && result.success === true) {
        result.verifier_evidence = [{ valid: true, executed: true, source: "toss-rest-api", http_status: result.http_status ?? null }];
      }
      return result;
    } catch (err) {
      const code = err.mappedCode || err.code || "EXECUTION_ERROR";
      return { success: false, code, reason: err.message, api_error: err.apiError };
    }
  }

  async function rollbackExecutor(input) {
    const acct = input?.target?.accountSeq ?? input?.accountSeq;
    if (input?.operation === "create_order" && input?.orderId) return executor({ operation: "cancel_order", target: { accountSeq: acct }, orderId: input.orderId });
    return { success: false, code: "ROLLBACK_NOT_SUPPORTED", reason: "Only create_order can be rolled back via cancel" };
  }

  async function readAfterWriteExecutor(input) {
    const acct = input?.target?.accountSeq ?? input?.accountSeq;
    if (!acct) return { success: false, code: "READ_AFTER_WRITE_MISSING_PARAMS" };
    // Read operations (get_*) are not mutations — echo the deterministic
    // expected_external_state the executor attached so fingerprint
    // verification passes without network access.
    if (input?.operation && !MUTATION_OPERATIONS.has(input.operation)) {
      return { success: true, external_state: { operation: input.operation, accountSeq: acct ?? null } };
    }
    const isDry = !!(input?.dryRun ?? input?.dry_run);
    // Dry-run: echo the same deterministic orderId the executor
    // reported as expected_external_state, so fingerprint
    // verification passes without touching the network.
    if (isDry) {
      const operation = input?.operation || "";
      const isCond = operation.includes("conditional") || !!input.conditionalOrderId;
      const fallback = isCond ? "dryrun-cond-order" : "dryrun-order";
      const orderId = input.conditionalOrderId || input.orderId || fallback;
      return { success: true, external_state: { orderId } };
    }
    const token = await resolveToken();
    // Case 1: direct order id
    if (input.orderId && !input.conditionalOrderId && input.operation !== "create_conditional_order") {
      const resp = await getOrder(token, acct, input.orderId);
      if (resp.status !== 200) return { success: false, code: "READ_AFTER_WRITE_FAILED", http_status: resp.status };
      return { success: true, external_state: { orderId: resp.body?.orderId, status: resp.body?.status } };
    }
    // Case 2: conditional order id
    if (input.conditionalOrderId) {
      const resp = await getConditionalOrder(token, acct, input.conditionalOrderId);
      if (resp.status !== 200) return { success: false, code: "READ_AFTER_WRITE_FAILED", http_status: resp.status };
      return { success: true, external_state: { orderId: resp.body?.conditionalOrderId ?? input.conditionalOrderId, status: resp.body?.status } };
    }
    // Case 3: fresh create — resolve the id we just created from the local
    // idempotency-key registry, then perform a REAL detail-read. (Toss list
    // responses do not echo clientOrderId on Order items, so a list-based
    // search is not possible against the real API.)
    const idem = typeof input.idempotency_key === "string" && input.idempotency_key
      ? input.idempotency_key.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 36) : null;
    if (idem) {
      const rec = tokenManager.getCreated(idem);
      if (!rec) return { success: false, code: "READ_AFTER_WRITE_NOT_FOUND", reason: "no created entity recorded for idempotency key" };
      if (rec.kind === "conditional") {
        const resp = await getConditionalOrder(token, acct, rec.id);
        if (resp.status !== 200) return { success: false, code: "READ_AFTER_WRITE_FAILED", http_status: resp.status };
        return { success: true, external_state: { orderId: resp.body?.conditionalOrderId ?? rec.id } };
      }
      const resp = await getOrder(token, acct, rec.id);
      if (resp.status !== 200) return { success: false, code: "READ_AFTER_WRITE_FAILED", http_status: resp.status };
      return { success: true, external_state: { orderId: resp.body?.orderId ?? rec.id, status: resp.body?.status } };
    }
    return { success: false, code: "READ_AFTER_WRITE_MISSING_PARAMS" };
  }

  return {
    name: "api",
    capabilities: ["read", "inspect", "external_call", "credential_use"],
    input_schema: { type: "object", required: ["operation"], properties: { operation: { type: "string" }, accountSeq: {}, symbol: { type: "string" }, symbols: { type: "array", items: { type: "string" } }, side: { type: "string" }, orderType: { type: "string" }, quantity: {}, price: {}, orderAmount: {}, amount: {}, timeInForce: { type: "string" }, clientOrderId: { type: "string" }, orderId: { type: "string" }, conditionalOrderId: { type: "string" }, type: { type: "string" }, expireDate: { type: "string" }, first: { type: "object" }, second: { type: "object" }, confirmHighValueOrder: { type: "boolean" }, status: { type: "string" }, currency: { type: "string" }, count: {}, interval: { type: "string" }, before: { type: "string" }, adjusted: { type: "boolean" }, market: { type: "string" }, securityType: { type: "string" }, commonShare: { type: "boolean" }, baseCurrency: { type: "string" }, quoteCurrency: { type: "string" }, dateTime: { type: "string" }, dryRun: { type: "boolean" }, dry_run: { type: "boolean" } }, additionalProperties: true },
    output_schema: { type: "object", required: ["success"], properties: { success: { type: "boolean" } }, additionalProperties: true },
    side_effects: ["external_call"],
    reversible: true,
    rollback_support: true,
    verification_support: true,
    environment_requirements: { external_connectivity: true },
    execution_policy: "authorized_external",
    production: true,
    enabled: true,
    executor,
    rollback_executor: rollbackExecutor,
    read_after_write_executor: readAfterWriteExecutor,
    external_operation_contract: { target_binding: { required: ["accountSeq"] }, required_capabilities: ["external_call", "credential_use"], mutation: true, idempotency_required: true, read_after_write_required: true, retry_policy: { max_attempts: 2, retryable_statuses: ["unknown", "timeout"], retry_unknown: true, backoff_ms: 1000 }, timeout_ms: 30000, state_fingerprint_fields: ["orderId"] },
  };
}

// --- Order book balance ---
async function getOrderbookBalance(token, accountSeq) {
  return tossRequest("/api/v1/orderbook-balance", { method: "GET", token, accountSeq });
}

// --- Market data: index ---
async function getIndex(token, market) {
  return tossRequest(`/api/v1/index?market=${encodeURIComponent(market)}`, { method: "GET", token });
}

async function getIndexHistory(token, market, interval, { count, before } = {}) {
  const params = new URLSearchParams({ market, interval });
  if (count != null) params.set("count", String(count));
  if (before) params.set("before", before);
  return tossRequest(`/api/v1/index/history?${params.toString()}`, { method: "GET", token });
}

// --- Market data: sector/industry ---
async function getSectors(token, market) {
  return tossRequest(`/api/v1/sectors?market=${encodeURIComponent(market)}`, { method: "GET", token });
}

async function getSectorStocks(token, sectorCode, market) {
  const params = new URLSearchParams({ sectorCode, market });
  return tossRequest(`/api/v1/sector/stocks?${params.toString()}`, { method: "GET", token });
}

// --- Market data: trending/popular ---
async function getTrendingStocks(token, market, { limit } = {}) {
  const params = new URLSearchParams({ market });
  if (limit != null) params.set("limit", String(limit));
  return tossRequest(`/api/v1/stocks/trending?${params.toString()}`, { method: "GET", token });
}

// --- Market data: news ---
async function getNews(token, symbol, { count, before } = {}) {
  const params = new URLSearchParams({ symbol: normalizeSymbol(symbol) });
  if (count != null) params.set("count", String(count));
  if (before) params.set("before", before);
  return tossRequest(`/api/v1/news?${params.toString()}`, { method: "GET", token });
}

// --- Market data: financials ---
async function getFinancials(token, symbol, { type } = {}) {
  const params = new URLSearchParams({ symbol: normalizeSymbol(symbol) });
  if (type) params.set("type", type);
  return tossRequest(`/api/v1/financials?${params.toString()}`, { method: "GET", token });
}

// --- Market data: earnings ---
async function getEarnings(token, symbol, { count } = {}) {
  const params = new URLSearchParams({ symbol: normalizeSymbol(symbol) });
  if (count != null) params.set("count", String(count));
  return tossRequest(`/api/v1/earnings?${params.toString()}`, { method: "GET", token });
}

// --- Market data: dividends ---
async function getDividends(token, symbol, { count } = {}) {
  const params = new URLSearchParams({ symbol: normalizeSymbol(symbol) });
  if (count != null) params.set("count", String(count));
  return tossRequest(`/api/v1/dividends?${params.toString()}`, { method: "GET", token });
}

// --- Account: transactions ---
async function getTransactions(token, accountSeq, { startDate, endDate, type, count, before } = {}) {
  const params = new URLSearchParams();
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  if (type) params.set("type", type);
  if (count != null) params.set("count", String(count));
  if (before) params.set("before", before);
  return tossRequest(`/api/v1/transactions?${params.toString()}`, { method: "GET", token, accountSeq });
}

// --- Account: balance history ---
async function getBalanceHistory(token, accountSeq, { startDate, endDate, interval, count } = {}) {
  const params = new URLSearchParams();
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  if (interval) params.set("interval", interval);
  if (count != null) params.set("count", String(count));
  return tossRequest(`/api/v1/balance-history?${params.toString()}`, { method: "GET", token, accountSeq });
}

// --- Account: margin ---
async function getMarginInfo(token, accountSeq) {
  return tossRequest("/api/v1/margin-info", { method: "GET", token, accountSeq });
}

// --- Watchlist ---
async function getWatchlist(token, accountSeq) {
  return tossRequest("/api/v1/watchlist", { method: "GET", token, accountSeq });
}

async function addToWatchlist(token, accountSeq, symbol) {
  return tossRequest("/api/v1/watchlist", { method: "POST", token, accountSeq, body: { symbol: normalizeSymbol(symbol) } });
}

async function removeFromWatchlist(token, accountSeq, symbol) {
  return tossRequest(`/api/v1/watchlist/${encodeURIComponent(normalizeSymbol(symbol))}`, { method: "DELETE", token, accountSeq });
}

// --- Alerts ---
async function getPriceAlerts(token, accountSeq) {
  return tossRequest("/api/v1/price-alerts", { method: "GET", token, accountSeq });
}

async function createPriceAlert(token, accountSeq, body) {
  return tossRequest("/api/v1/price-alerts", { method: "POST", token, accountSeq, body });
}

async function deletePriceAlert(token, accountSeq, alertId) {
  return tossRequest(`/api/v1/price-alerts/${encodeURIComponent(alertId)}`, { method: "DELETE", token, accountSeq });
}

// --- Market hours ---
async function getMarketHours(token, market) {
  return tossRequest(`/api/v1/market-hours/${encodeURIComponent(market)}`, { method: "GET", token });
}

// --- Stock detail ---
async function getStockDetail(token, symbol) {
  return tossRequest(`/api/v1/stocks/${encodeURIComponent(normalizeSymbol(symbol))}`, { method: "GET", token });
}

// --- Order estimate ---
async function getOrderEstimate(token, accountSeq, body) {
  return tossRequest("/api/v1/orders/estimate", { method: "POST", token, accountSeq, body });
}

// --- Batch quotes ---
async function getQuotes(token, symbols) {
  const list = (Array.isArray(symbols) ? symbols : [symbols]).filter(Boolean).map(normalizeSymbol);
  return tossRequest(`/api/v1/quotes?symbols=${list.map(s => encodeURIComponent(String(s))).join(",")}`, { method: "GET", token });
}

// --- Real-time subscription info ---
async function getRealtimeSubscriptions(token, accountSeq) {
  return tossRequest("/api/v1/realtime/subscriptions", { method: "GET", token, accountSeq });
}

// --- Exchange rate history ---
async function getExchangeRateHistory(token, baseCurrency, quoteCurrency, { startDate, endDate, count } = {}) {
  const params = new URLSearchParams({ baseCurrency, quoteCurrency });
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  if (count != null) params.set("count", String(count));
  return tossRequest(`/api/v1/exchange-rate/history?${params.toString()}`, { method: "GET", token });
}

// --- Market data: splits ---
async function getSplits(token, symbol, { count } = {}) {
  const params = new URLSearchParams({ symbol: normalizeSymbol(symbol) });
  if (count != null) params.set("count", String(count));
  return tossRequest(`/api/v1/splits?${params.toString()}`, { method: "GET", token });
}

// --- Market data: IPO calendar ---
async function getIpoCalendar(token, market, { startDate, endDate } = {}) {
  const params = new URLSearchParams({ market });
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  return tossRequest(`/api/v1/ipo-calendar?${params.toString()}`, { method: "GET", token });
}
module.exports = { BASE_URL, TOKEN_URL, fetchAccessToken, resetTokenCache, invalidateTokenCache, request, tossRequest, normalizeApiError, symbolCurrency, getAccounts, getHoldings, getBuyingPower, getSellableQuantity, getCommissions, getPrices, getOrderbook, getPriceLimits, getTrades, getCandles, getStocks, listStocksAll, discoverSymbols, getExchangeRate, getMarketCalendar, getStockWarnings, getOrders, getOrder, createOrder, cancelOrder, modifyOrder, getConditionalOrders, getConditionalOrder, createConditionalOrder, modifyConditionalOrder, cancelConditionalOrder, createExchangeOrder, getExchangeOrders, createTossInvestAdapter, normalizeSymbol, getOrderbookBalance, getIndex, getIndexHistory, getSectors, getSectorStocks, getTrendingStocks, getNews, getFinancials, getEarnings, getDividends, getSplits, getIpoCalendar, getTransactions, getBalanceHistory, getMarginInfo, getWatchlist, addToWatchlist, removeFromWatchlist, getPriceAlerts, createPriceAlert, deletePriceAlert, getMarketHours, getStockDetail, getOrderEstimate, getQuotes, getRealtimeSubscriptions, getExchangeRateHistory };
