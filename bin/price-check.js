"use strict";
const path = require("node:path");
const {
  fetchAccessToken, resetTokenCache, getPrices, getPriceLimits,
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
  const [prices, limits] = await Promise.all([
    getPrices(token, "005930"),
    getPriceLimits(token, "005930"),
  ]);
  console.log("PRICE:", JSON.stringify(prices.body));
  console.log("LIMITS:", JSON.stringify(limits.body));
}

main().catch(err => { console.error("FATAL:", err.message); process.exit(1); });
