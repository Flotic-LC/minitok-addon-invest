"use strict";
const path = require("node:path");
const {
  fetchAccessToken, resetTokenCache, getAccounts, getBuyingPower, getSellableQuantity,
} = require(path.join(__dirname, "..", "src", "tossinvest"));

async function main() {
  const clientId = process.env.TOSS_CLIENT_ID;
  const clientSecret = process.env.TOSS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("Set TOSS_CLIENT_ID and TOSS_CLIENT_SECRET environment variables first.");
    process.exit(1);
  }
  resetTokenCache();
  const token = await fetchAccessToken(clientId, clientSecret);
  const accounts = await getAccounts(token);
  const list = Array.isArray(accounts.body) ? accounts.body : [];
  const acct = list[0]?.accountSeq;

  const bp = await getBuyingPower(token, acct, "KRW");
  const cash = Number(bp.body?.cashBuyingPower);
  console.log("BUYING_POWER(KRW):", cash);

  const orderValue = 188000 * 1; // 1주 @ 하한가
  if (cash < orderValue) {
    console.log("PRECHECK: BLOCKED — INSUFFICIENT_BALANCE");
    console.log(`  required=${orderValue} KRW, available=${cash} KRW (short by ${orderValue - cash} KRW)`);
  } else {
    console.log("PRECHECK: PASS — would place order");
  }

  const sq = await getSellableQuantity(token, acct, "005930");
  console.log("SELLABLE_QTY(005930):", JSON.stringify(sq.body));
}

main().catch(err => { console.error("FATAL:", err.message); process.exit(1); });
