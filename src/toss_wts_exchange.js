/**
 * Toss Securities WTS Exchange Module — Server Edition
 * 
 * Dual-mode authentication:
 *   1. Environment-based (primary): WTS_UTK + WTS_XSRF from process.env
 *      → No Playwright/Chromium needed, instant startup
 *   2. Playwright fallback: browser-based login if env vars missing
 *      → Requires playwright + chromium installed
 * 
 * Endpoints (from APK reverse engineering):
 *   POST /api/v1/exchange-auto-orders            ← actual exchange
 *   GET  /api/v1/exchange-auto-orders/histories
 *   GET  /api/v1/exchange/usd/base-exchange-rate
 *   POST /api/v1/exchange/calculate/for-sell-amount
 */
"use strict";

const WTS_BASE = "https://wts-api.tossinvest.com";
const TOSS_LOGIN_URL = "https://www.tossinvest.com/login";

const MAX_EXCHANGE_USD = 5000;
const MAX_EXCHANGE_KRW = 7000000;
const COOLDOWN_MS = 60000;

let _lastExchangeTime = 0;
let _browserContext = null;
let _authState = null;

// Auto-init from environment variables (primary mode — no Playwright needed)
if (process.env.WTS_UTK) {
  _authState = {
    utk: process.env.WTS_UTK,
    xsrf: process.env.WTS_XSRF || null,
    accountKey: process.env.WTS_ACCOUNT_KEY || null,
    extractedAt: Date.now(),
    source: "env",
  };
  console.log(`[WTS] Auth initialized from environment. UTK=${_authState.utk.substring(0, 8)}...`);
}

function _getPlaywright() {
  try { return require("playwright"); }
  catch (e) { throw new Error("Playwright not installed. Run: npm install playwright && npx playwright install chromium"); }
}

async function initAuth(options = {}) {
  if (_authState && _authState.utk) { console.log("[WTS] Using existing auth state."); return _authState; }

  const { chromium } = _getPlaywright();
  const { headless = true, userDataDir, timeout = 60000 } = options;

  if (userDataDir) { _browserContext = await chromium.launchPersistentContext(userDataDir, { headless }); }
  else { const browser = await chromium.launch({ headless }); _browserContext = await browser.newContext(); }

  const page = await _browserContext.newPage();
  try {
    await page.goto(TOSS_LOGIN_URL, { waitUntil: "networkidle", timeout });
    const currentUrl = page.url();
    if (!currentUrl.includes("/login") && !currentUrl.includes("/auth")) {
      console.log("[WTS] Already logged in, extracting tokens...");
    } else {
      console.log("[WTS] Login required. Waiting for manual login or auto-redirect...");
      await page.waitForURL(url => !url.toString().includes("/login"), { timeout: 300000 });
    }
    const cookies = await _browserContext.cookies();
    const utkCookie = cookies.find(c => c.name === "UTK");
    const xsrfCookie = cookies.find(c => c.name === "XSRF-TOKEN");
    if (!utkCookie) throw new Error("UTK cookie not found after login");
    _authState = { utk: utkCookie.value, xsrf: xsrfCookie?.value || null, extractedAt: Date.now(), source: "browser" };
    try {
      const accts = await wtsGet("/api/v1/accounts", _authState);
      if (accts?.body?.result?.accounts?.length > 0) { _authState.accountKey = accts.body.result.accounts[0].key; }
    } catch (e) { console.log("[WTS] Could not fetch account key:", e.message); }
    console.log(`[WTS] Auth initialized via browser. UTK=${_authState.utk.substring(0, 8)}...`);
    return _authState;
  } finally { await page.close(); }
}
async function wtsGet(path, auth) {
  const url = `${WTS_BASE}${path}`;
  const headers = { "Accept": "application/json", "Cookie": _buildCookieHeader(auth) };
  if (auth.xsrf) headers["X-XSRF-TOKEN"] = auth.xsrf;
  if (auth.accountKey) headers["X-Tossinvest-Account"] = auth.accountKey;
  const resp = await fetch(url, { method: "GET", headers });
  const text = await resp.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  if (resp.status === 401 || resp.status === 403) {
    // [Auto-relogin 2026-10-15] refresh-utk works even with an expired token: retry once automatically.
    const refreshed = await refreshUtk(auth);
    if (refreshed) {
      const retryHeaders = { "Accept": "application/json", "Cookie": _buildCookieHeader(auth) };
      if (auth.xsrf) retryHeaders["X-XSRF-TOKEN"] = auth.xsrf;
      if (auth.accountKey) retryHeaders["X-Tossinvest-Account"] = auth.accountKey;
      const retryResp = await fetch(url, { method: "GET", headers: retryHeaders });
      const retryText = await retryResp.text();
      let retryParsed = null;
      try { retryParsed = JSON.parse(retryText); } catch {}
      if (retryResp.status !== 401 && retryResp.status !== 403) {
        console.log("[WTS] Auto-relogin succeeded, request retried OK.");
        return { status: retryResp.status, body: retryParsed };
      }
    }
    throw new Error(`WTS auth expired (${resp.status}). Re-login required.`);
  }
  return { status: resp.status, body: parsed };
}

async function wtsPost(path, body, auth) {
  const url = `${WTS_BASE}${path}`;
  const headers = { "Content-Type": "application/json", "Accept": "application/json", "Cookie": _buildCookieHeader(auth) };
  if (auth.xsrf) headers["X-XSRF-TOKEN"] = auth.xsrf;
  if (auth.accountKey) headers["X-Tossinvest-Account"] = auth.accountKey;
  const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await resp.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  if (resp.status === 401 || resp.status === 403) {
    // [Auto-relogin 2026-10-15] Same auto-refresh + retry logic as wtsGet
    const refreshed = await refreshUtk(auth);
    if (refreshed) {
      const retryHeaders = { "Content-Type": "application/json", "Accept": "application/json", "Cookie": _buildCookieHeader(auth) };
      if (auth.xsrf) retryHeaders["X-XSRF-TOKEN"] = auth.xsrf;
      if (auth.accountKey) retryHeaders["X-Tossinvest-Account"] = auth.accountKey;
      const retryResp = await fetch(url, { method: "POST", headers: retryHeaders, body: JSON.stringify(body) });
      const retryText = await retryResp.text();
      let retryParsed = null;
      try { retryParsed = JSON.parse(retryText); } catch {}
      if (retryResp.status !== 401 && retryResp.status !== 403) {
        console.log("[WTS] Auto-relogin succeeded, request retried OK.");
        try { if (resp && resp.headers) _persistSetCookies(resp.headers, auth); } catch (e) {}
        try { if (retryResp && retryResp.headers) _persistSetCookies(retryResp.headers, auth); } catch (e) {}
  return { status: retryResp.status, body: retryParsed };
      }
    }
    throw new Error(`WTS auth expired (${resp.status}). Re-login required.`);
  }
  return { status: resp.status, body: parsed };
}

async function getBaseExchangeRate() {
  const url = `${WTS_BASE}/api/v1/exchange/usd/base-exchange-rate`;
  const resp = await fetch(url, { method: "GET", headers: { "Accept": "application/json" } });
  const text = await resp.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  return { status: resp.status, body: parsed };
}

async function getCurrentQuoteForBuy(auth) { return wtsGet("/api/v1/exchange/current-quote/for-buy", auth); }
async function getCurrentQuoteForSell(auth) { return wtsGet("/api/v1/exchange/current-quote/for-sell", auth); }
async function calculateForBuyAmount(params, auth) { return wtsPost("/api/v1/exchange/calculate/for-buy-amount", params, auth); }
async function calculateForSellAmount(params, auth) { return wtsPost("/api/v1/exchange/calculate/for-sell-amount", params, auth); }
async function getExchangeHistories(auth) { return wtsGet("/api/v1/exchange-auto-orders/histories", auth); }

// [Patch 2026-10-15b] SESSION cookie chain support
function _persistSetCookies(resHeaders, auth) {
  try {
    var raw = null;
    if (resHeaders && typeof resHeaders.getSetCookie === "function") {
      raw = resHeaders.getSetCookie();
    } else if (resHeaders && typeof resHeaders.raw === "function") {
      var rh = resHeaders.raw();
      raw = rh["set-cookie"] || rh["Set-Cookie"];
    } else if (resHeaders) {
      raw = resHeaders["set-cookie"] || resHeaders["Set-Cookie"];
    }
    if (!raw) return false;
    var list = Array.isArray(raw) ? raw : [raw];
    var changed = false;
    for (var i = 0; i < list.length; i++) {
      var c = String(list[i]);
      var m = c.match(/^([^=;\s]+)=([^;]*)/);
      if (!m) continue;
      var name = m[1], value = m[2];
      if (!value) continue;
      if (/^(SESSION|UTK|XSRF-TOKEN)$/i.test(name)) {
        var key = name.toUpperCase() === "XSRF-TOKEN" ? "xsrf" : name.toLowerCase();
        if (auth[key] !== value) { changed = true; }
        auth[key] = value;
      }
    }
    return changed;
  } catch (e) { return false; }
}

function _buildCookieHeader(authArg) {
  var a = authArg || _authState || {};
  var parts = [];
  if (a.utk) parts.push("UTK=" + a.utk);
  if (a.session) parts.push("SESSION=" + a.session);
  if (a.xsrf) parts.push("XSRF-TOKEN=" + a.xsrf);
  return parts.length > 0 ? parts.join("; ") : "";
}

async function refreshUtk(auth) {
  // [Fix 2026-10-15] refresh-utk returns a NEW UTK in Set-Cookie and body.result.
  // Raw fetch (not wtsGet) so we can read response headers and update auth state.
  try {
    const url = `${WTS_BASE}/api/v1/refresh-utk`;
    const headers = { "Accept": "application/json", "Cookie": `UTK=${auth.utk}` };
    if (auth.xsrf) headers["X-XSRF-TOKEN"] = auth.xsrf;
    if (auth.accountKey) headers["X-Tossinvest-Account"] = auth.accountKey;
    const resp = await fetch(url, { method: "GET", headers });
    if (resp.status === 200) {
      // New UTK from body.result, falling back to Set-Cookie
      let newUtk = null;
      let newXsrf = null;
      try {
        const bodyText = await resp.text();
        try { const j = JSON.parse(bodyText); newUtk = j.result || null; } catch {}
        if (!newUtk) { const mm = bodyText.match(/UTK=([^;\s]+)/); if (mm) newUtk = mm[1]; }
      } catch {}
      if (resp.headers.getSetCookie) {
        for (const c of resp.headers.getSetCookie()) {
          const mu = c.match(/^UTK=([^;]+)/);
          if (mu && !newUtk) newUtk = mu[1];
          const mx = c.match(/^XSRF-TOKEN=([^;]+)/);
          if (mx) newXsrf = mx[1];
        }
      }
      if (newUtk && newUtk.length > 20 && newUtk !== auth.utk) {
        auth.utk = newUtk;
        if (newXsrf) auth.xsrf = newXsrf;
        auth.extractedAt = Date.now();
        _persistSetCookies(resp && resp.headers, auth); console.log("[WTS] UTK refreshed successfully (new token acquired, len=" + newUtk.length + ").");
        return true;
      }
      if (newUtk && newUtk === auth.utk) {
        auth.extractedAt = Date.now();
        console.log("[WTS] refresh-utk returned the same token (still valid).");
        return true;
      }
      // 200 but no parseable token: treat as failure so callers fall back to full re-login
      console.log("[WTS] refresh-utk 200 but no token in response.");
      return false;
    }
    console.log("[WTS] refresh-utk status " + resp.status + " - token likely expired beyond refresh window.");
    return false;
  } catch (e) { console.log("[WTS] UTK refresh failed:", e.message); }
  return false;
}

async function closeBrowser() {
  if (_browserContext) { try { await _browserContext.close(); } catch {} _browserContext = null; }
}

async function executeExchange(params, auth, options = {}) {
  const { dryRun = false, maxUsd = MAX_EXCHANGE_USD, maxKrw = MAX_EXCHANGE_KRW } = options;
  const { fromCurrency, toCurrency, amount } = params;

  const activeAuth = auth || _authState;
  if (!activeAuth || !activeAuth.utk) { return { success: false, error: "Auth required. Set WTS_UTK env var or call initAuth()." }; }
  if (!fromCurrency || !toCurrency || typeof amount !== "number" || amount <= 0) {
    return { success: false, error: "Invalid params: fromCurrency, toCurrency, positive amount required." };
  }

  const now = Date.now();
  if (now - _lastExchangeTime < COOLDOWN_MS) {
    const remaining = Math.ceil((COOLDOWN_MS - (now - _lastExchangeTime)) / 1000);
    return { success: false, error: `Cooldown active. Wait ${remaining}s.` };
  }
  if (fromCurrency === "USD" && amount > maxUsd) { return { success: false, error: `Amount $${amount} exceeds max $${maxUsd}` }; }
  if (fromCurrency === "KRW" && amount > maxKrw) { return { success: false, error: `Amount ₩${amount} exceeds max ₩${maxKrw}` }; }

  console.log(`[WTS] Calculating: ${amount} ${fromCurrency} → ${toCurrency}`);
  let calcResult;
  try {
    if (toCurrency === "KRW") { calcResult = await calculateForSellAmount({ amount, fromCurrency, toCurrency }, activeAuth); }
    else { calcResult = await calculateForBuyAmount({ amount, fromCurrency, toCurrency }, activeAuth); }
  } catch (e) { return { success: false, error: `Calculation failed: ${e.message}` }; }

  if (!calcResult || calcResult.status !== 200) { return { success: false, error: `Calc status ${calcResult?.status}`, detail: calcResult?.body }; }
  console.log(`[WTS] Quote received. Rate=${calcResult.body?.appliedRate || "n/a"}`);

  if (dryRun) { console.log("[WTS] DRY RUN - no exchange executed."); return { success: true, dryRun: true, calculation: calcResult.body }; }

  console.log(`[WTS] Executing exchange: ${amount} ${fromCurrency} → ${toCurrency}`);
  let orderResult;
  try { orderResult = await wtsPost("/api/v1/exchange-auto-orders", { fromCurrency, toCurrency, amount }, activeAuth); }
  catch (e) { return { success: false, error: `Order failed: ${e.message}` }; }

  _lastExchangeTime = Date.now();
  if (orderResult.status === 200 || orderResult.status === 201) {
    const orderId = orderResult.body?.orderId || orderResult.body?.exchangeOrderId || "unknown";
    console.log(`[WTS] Exchange SUCCESS: ${orderId}`);
    return { success: true, orderId, result: orderResult.body, calculation: calcResult.body };
  }
  return { success: false, error: `Order status ${orderResult.status}`, detail: orderResult.body, httpStatus: orderResult.status };
}

module.exports = {
  initAuth, getBaseExchangeRate, getCurrentQuoteForBuy, getCurrentQuoteForSell,
  calculateForBuyAmount, calculateForSellAmount, executeExchange, getExchangeHistories,
  refreshUtk, closeBrowser,
  get authState() { return _authState; },
  set authState(v) { _authState = v; },
  WTS_BASE, MAX_EXCHANGE_USD, MAX_EXCHANGE_KRW,
};

