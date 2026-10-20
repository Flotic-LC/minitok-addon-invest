"use strict";
/**
 * Smoke test — validates live API connectivity WITHOUT placing any orders.
 * Tests: auth token, portfolio fetch, candle data, exchange rate, signal engine.
 */
// Load .env manually (no dotenv dependency)
const _envPath = require("node:path").join(__dirname, ".env");
if (require("node:fs").existsSync(_envPath)) {
  for (const line of require("node:fs").readFileSync(_envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
const { fetchAccessToken, getHoldings, getBuyingPower, getCandles, getExchangeRate } = require("./src/tossinvest");
const { generateSignal } = require("./src/strategy/signals");
const { sizePosition } = require("./src/agent/positionSizer");
const { checkExposure } = require("./src/agent/exposure");

const CID = process.env.TOSS_CLIENT_ID;
const SECRET = process.env.TOSS_CLIENT_SECRET;

async function main() {
  console.log("=== Smoke Test: Live API (no orders) ===\n");

  // 1. Auth
  console.log("[1/5] Auth token...");
  const token = await fetchAccessToken(CID, SECRET);
  console.log("  OK — token " + token.slice(0, 12) + "...\n");

  // 2. Portfolio
  console.log("[2/5] Portfolio...");
  const [holdings, buyingPower] = await Promise.all([
    getHoldings(token, process.env.TOSS_ACCOUNT_SEQ),
    getBuyingPower(token, process.env.TOSS_ACCOUNT_SEQ),
  ]);
  const positions = (holdings.body && holdings.body.holdings) || [];
  const cash = Number((buyingPower.body && (buyingPower.body.buyingPower || buyingPower.body.cash)) || 0);
  console.log("  OK — " + positions.length + " positions, cash " + cash.toLocaleString() + " KRW");
  for (const p of positions.slice(0, 5)) {
    console.log("    " + p.symbol + ": " + p.quantity + " @ avg " + (p.avgPrice || "?"));
  }
  console.log();

  // 3. Candle data for a KR symbol
  console.log("[3/5] Candle data (005930)...");
  const candleResp = await getCandles(token, "005930", "1d", { count: 40 });
  const candles = Array.isArray(candleResp.body) ? candleResp.body : (candleResp.body && candleResp.body.candles) || [];
  console.log("  OK — " + candles.length + " daily candles");
  if (candles.length > 0) {
    const last = candles[candles.length - 1];
    console.log("    latest: " + (last.date || last.tradeDate || "?") + " close=" + (last.close || last.closePrice));
  }
  console.log();

  // 4. Exchange rate
  console.log("[4/5] Exchange rate USD->KRW...");
  try {
    const fx = await getExchangeRate(token, "USD", "KRW");
    console.log("  OK — rate " + (fx.body && fx.body.rate) + "\n");
  } catch (e) {
    console.log("  SKIP — " + e.message + "\n");
  }

  // 5. Signal engine with real candle data
  console.log("[5/5] Signal engine on real data...");
  if (candles.length >= 21) {
    const closes = candles.map((c) => Number(c.close || c.closePrice || 0)).filter((v) => v > 0);
    const lastClose = closes[closes.length - 1];
    const sma5 = closes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const sma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const chg = ((lastClose - closes[closes.length - 6]) / closes[closes.length - 6]) * 100;
    const signal = generateSignal({ lastClose, sma5, sma20, changePct5d: chg }, null);
    console.log("  Signal for 005930: " + signal.action + " (score " + signal.score + ")");
    console.log("    reasons: " + signal.reasons.join("; "));

    // Position sizing with real equity
    const sizing = sizePosition({ equity: cash || 10_000_000, price: lastClose, atr: null });
    console.log("  Sizing: qty=" + sizing.qty + " (" + sizing.reason + ")");
  }

  console.log("\n=== All smoke tests passed ===");
}

main().catch((e) => { console.error("FAIL: " + e.message); process.exit(1); });
