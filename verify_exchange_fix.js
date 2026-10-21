/**
 * Live verification of the fixed module using the real captured auth state.
 * Read-only by default: quotes + history. Pass --live to attempt the POST.
 */
"use strict";
const path = require("path");
const fs = require("fs");
const mod = require("/app/src/toss_wts_exchange.js");

(async () => {
  const state = JSON.parse(fs.readFileSync("/app/src/wts_auth_state.json", "utf8"));
  mod.authState = state;
  const auth = state;

  console.log("hosts:", mod.WTS_BASE, mod.WTS_CERT_BASE);

  // 1. quote (launcher)
  const q = await mod.calculateForSellAmount(
    { buyCurrency: "KRW", sellCurrency: "USD", checkBalance: true, sellAmount: 1 }, auth);
  console.log("\n[1] calculate/for-sell-amount →", q.status);
  console.log("    token:", q.body?.result?.token);
  console.log("    rate :", q.body?.result?.appliedBuyAmount, "KRW for 1 USD");

  // 2. history (cert) — proves cert host + cookie jar work
  const h = await mod.getExchangeHistories(auth);
  console.log("\n[2] exchange-auto-orders/histories →", h.status, "entries:", h.body?.result?.body?.length);

  // 3. active auto orders (cert)
  const a = await mod.getExchangeAutoOrders(auth);
  console.log("[3] exchange-auto-orders →", a.status, JSON.stringify(a.body).substring(0, 120));

  // 4. executeExchange in dry-run (quote path only)
  const d = await mod.executeExchange({ fromCurrency: "USD", toCurrency: "KRW", amount: 1 }, auth, { dryRun: true });
  console.log("\n[4] executeExchange(dryRun) success:", d.success, "token:", d.calculation?.token ? "yes" : "no");

  if (process.argv.includes("--live")) {
    console.log("\n[5] executeExchange(LIVE)...");
    const r = await mod.executeExchange({ fromCurrency: "USD", toCurrency: "KRW", amount: 1 }, auth, {});
    console.log(JSON.stringify(r, null, 2).substring(0, 1200));
  }
  process.exit(0);
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });