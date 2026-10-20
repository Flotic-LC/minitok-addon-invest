/**
 * Test the transfer/foreign-exchange/send/* endpoints which appear to be
 * the actual exchange execution paths (not exchange-auto-orders).
 */
"use strict";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const LAUNCHER = "https://wts-api.tossinvest.com";
const CERT = "https://wts-cert-api.tossinvest.com";

// Auth from environment (same as toss_wts_exchange.js)
const UTK = process.env.WTS_UTK || "";
const XSRF = process.env.WTS_XSRF || "";
const ACCOUNT_KEY = process.env.WTS_ACCOUNT_KEY || "";
console.log("Auth: UTK=" + (UTK ? UTK.substring(0,8)+"..." : "MISSING") + " XSRF=" + (XSRF ? "SET" : "MISSING") + " ACCT=" + (ACCOUNT_KEY || "MISSING"));

function hdr() {
  const cookies = ["UTK=" + UTK];
  const H = {
    Accept: "application/json", "Content-Type": "application/json",
    Origin: "https://www.tossinvest.com", Referer: "https://www.tossinvest.com/",
    "app-version": "v261013.1802", "browser-tab-id": "browser-tab-" + "f".repeat(32),
    "User-Agent": UA, Cookie: cookies.join("; "),
  };
  if (XSRF) H["X-XSRF-TOKEN"] = XSRF;
  if (ACCOUNT_KEY) H["X-Tossinvest-Account"] = ACCOUNT_KEY;
  return H;
}

const PATHS = [
  "/api/v1/transfer/foreign-exchange/send-preview",
  "/api/v1/transfer/foreign-exchange/pre-check",
  "/api/v1/transfer/foreign-exchange/check-duplicate",
  "/api/v1/transfer/foreign-exchange/withdraw-info",
  "/api/v2/transfer/foreign-exchange/withdraw-info",
  "/api/v1/transfer/foreign-exchange/send/sign",
  "/api/v1/transfer/foreign-exchange/send/ars",
  "/api/v1/transfer/foreign-exchange/send/sign/token",
];

(async () => {
  // First get a fresh calc token
  const calcBody = { buyCurrency: "KRW", sellCurrency: "USD", checkBalance: true, sellAmount: 1 };
  const c = await (await fetch(`${LAUNCHER}/api/v1/exchange/calculate/for-sell-amount`, { method: "POST", headers: hdr(), body: JSON.stringify(calcBody) })).json();
  console.log("calc token:", c?.result?.token);
  const token = c?.result?.token;

  for (const host of [LAUNCHER, CERT]) {
    const hname = host === LAUNCHER ? "launcher" : "cert";
    console.log(`\n=== ${hname} ===`);
    for (const p of PATHS) {
      for (const method of ["GET", "POST"]) {
        try {
          const body = method === "POST" ? JSON.stringify({ token, sellCurrency: "USD", buyCurrency: "KRW", sellAmount: 1 }) : undefined;
          const r = await fetch(host + p, { method, headers: hdr(), body });
          const txt = (await r.text()).substring(0, 200);
          if (r.status !== 404) {
            console.log(`  ${method} ${p} → ${r.status} ${txt}`);
          }
        } catch (e) {
          console.log(`  ${method} ${p} → ERR ${e.message}`);
        }
      }
    }
  }
})();