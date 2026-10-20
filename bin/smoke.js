#!/usr/bin/env node
"use strict";

/**
 * Toss Securities Open API smoke test for the minitok add-on.
 *
 * Default mode is READ-ONLY (token, accounts, holdings, prices, open orders,
 * conditional order list). Live order placement requires BOTH an explicit
 * flag and confirmation:
 *
 *   node bin/smoke.js --place-order --symbol kr:005930 --qty 1 --price 1000
 *
 * The place-order path creates a limit order far below market (unlikely to
 * fill), verifies it via read-after-write, then cancels it.
 *
 * Credentials (never hardcode): TOSS_CLIENT_ID / TOSS_CLIENT_SECRET env vars.
 * The account header uses accountSeq from GET /api/v1/accounts (--account to
 * override when multiple accounts exist).
 *
 * Exit code 0 = all requested steps passed, 1 = failure.
 */

const path = require("node:path");
const {
  fetchAccessToken, resetTokenCache, getAccounts, getHoldings, getPrices,
  getOrderbook, getPriceLimits, getOrders, getOrder, createOrder, cancelOrder,
  getConditionalOrders, normalizeSymbol,
} = require(path.join(__dirname, "..", "src", "tossinvest"));

function parseArgs(argv) {
  const args = { placeOrder: false, symbol: null, qty: null, price: null, account: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--place-order") args.placeOrder = true;
    else if (a === "--symbol") args.symbol = argv[++i];
    else if (a === "--qty") args.qty = Number(argv[++i]);
    else if (a === "--price") { const p = argv[++i]; args.price = p === "auto" ? "auto" : Number(p); }
    else if (a === "--account") args.account = argv[++i];
  }
  return args;
}

function step(name, ok, detail = "") {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const clientId = process.env.TOSS_CLIENT_ID;
  const clientSecret = process.env.TOSS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("Set TOSS_CLIENT_ID and TOSS_CLIENT_SECRET environment variables first.");
    process.exit(1);
  }

  let failures = 0;
  const json = value => { try { return JSON.stringify(value).slice(0, 400); } catch { return String(value); } };

  // 1. Token
  resetTokenCache();
  let token;
  try {
    token = await fetchAccessToken(clientId, clientSecret);
    failures += !step("OAuth2 token", true, "issued");
  } catch (err) {
    failures += !step("OAuth2 token", false, `${err.message}${err.detail ? ` (${err.detail})` : ""} — check credentials / allowed IP`);
    process.exitCode = 1;
    return;
  }

  // 2. Accounts
  const accountsResp = await getAccounts(token);
  const accounts = Array.isArray(accountsResp.body) ? accountsResp.body : accountsResp.body?.accounts ?? [];
  failures += !step("Accounts", accountsResp.status === 200 && accounts.length > 0, `status=${accountsResp.status}, count=${accounts.length}`);
  if (accountsResp.status !== 200) { console.log(json(accountsResp.body)); process.exitCode = 1; return; }
  const accountSeq = args.account || accounts[0].accountSeq;
  console.log(`       using accountSeq=${accountSeq}`);

  // 3. Holdings
  const holdings = await getHoldings(token, accountSeq);
  failures += !step("Holdings", holdings.status === 200, `status=${holdings.status}`);

  // 4. Prices (read-only market data)
  const symbol = args.symbol || "005930";
  const prices = await getPrices(token, symbol);
  failures += !step(`Prices (${symbol})`, prices.status === 200, `status=${prices.status}`);

  // 5. Open orders
  const orders = await getOrders(token, accountSeq, "OPEN");
  failures += !step("Open orders", orders.status === 200, `status=${orders.status}`);

  // 6. Conditional order list
  const conds = await getConditionalOrders(token, accountSeq);
  failures += !step("Conditional orders", conds.status === 200, `status=${conds.status}`);

  // 7. Optional: tiny live order round-trip (create → verify → cancel)
  if (args.placeOrder) {
    if (!args.symbol || !args.qty) {
      console.error("--place-order requires --symbol and --qty (--price optional: number or 'auto'; default auto = lower limit)");
      process.exit(1);
    }
    // Resolve price: explicit number, or auto = lower limit (buy at the floor
    // — fills are unlikely, and the order is canceled right after verification).
    let price = args.price;
    if (price == null || price === "auto" || Number.isNaN(price)) {
      const limits = await getPriceLimits(token, args.symbol);
      const lower = limits.body?.lowerLimitPrice;
      if (limits.status !== 200 || !lower) {
        console.error(`Could not resolve price limits for ${args.symbol} (status=${limits.status})`);
        console.log(json(limits.body));
        process.exit(1);
      }
      price = Number(lower);
      console.log(`\nprice limits for ${args.symbol}: lower=${limits.body.lowerLimitPrice} upper=${limits.body.upperLimitPrice} (${limits.body.currency})`);
      console.log(`auto price → LOWER LIMIT ${price} (fill unlikely; canceled right after verification)`);
    }
    console.log(`LIVE ORDER: BUY ${args.qty} ${args.symbol} @ ${price} (limit, will cancel right after verification)`);
    const clientIdKey = `smoke-${Date.now().toString(36)}`;
    // The create-order API expects a bare symbol (no kr:/us: prefix).
    const created = await createOrder(token, accountSeq, {
      symbol: normalizeSymbol(args.symbol), side: "BUY", orderType: "LIMIT",
      quantity: args.qty, price, clientOrderId: clientIdKey,
    });
    const createdOk = created.status === 200 || created.status === 201;
    failures += !step("Create order", createdOk, `status=${created.status}`);
    if (createdOk) {
      const orderId = created.body?.orderId;
      console.log(`       orderId=${orderId}`);
      const detail = await getOrder(token, accountSeq, orderId);
      failures += !step("Read-after-write verify", detail.status === 200 && detail.body?.orderId === orderId, `status=${detail.status}, body.orderId=${detail.body?.orderId}`);
      const canceled = await cancelOrder(token, accountSeq, orderId);
      failures += !step("Cancel order", canceled.status === 200, `status=${canceled.status}`);
      const after = await getOrder(token, accountSeq, orderId);
      console.log(`       post-cancel status=${after.body?.status ?? after.body?.orderStatus ?? "?"}`);
    } else {
      console.log(json(created.body));
      if (created.status === 422) console.log("hint: 422 = validation rejected (price out of range / order hours closed / insufficient funds) — check market hours and price limits");
    }
  } else {
    console.log("\n(read-only mode — pass --place-order with --symbol/--qty/--price for a live order round-trip)");
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error("FATAL:", err.message); process.exit(1); });
