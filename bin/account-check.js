"use strict";
const path = require("node:path");
const {
  fetchAccessToken, resetTokenCache, getAccounts, getBuyingPower, getHoldings,
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
  console.log("ACCOUNTS:", JSON.stringify(list));
  const acct = list[0]?.accountSeq;
  const [bp, holdings] = await Promise.all([
    getBuyingPower(token, acct, "KRW"),
    getHoldings(token, acct),
  ]);
  console.log("BUYING_POWER:", JSON.stringify(bp.body));
  console.log("HOLDINGS:", JSON.stringify(holdings.body).slice(0, 600));
}

main().catch(err => { console.error("FATAL:", err.message); process.exit(1); });
