"use strict";
/**
 * AI decision pipeline test — calls the same functions the runner uses
 * to verify the full chain: signal → AI → safety → sizing → exposure.
 */
const fs = require("node:fs");
const path = require("node:path");

// Load .env
for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const { fetchAccessToken, getCandles, getHoldings, getBuyingPower } = require("./src/tossinvest");
const { generateSignal } = require("./src/strategy/signals");
const { sizePosition } = require("./src/agent/positionSizer");
const { checkExposure } = require("./src/agent/exposure");
const { createSafety } = require("./src/agent/safety");

const PROFUNDO_API_KEY = process.env.PROFUNDO_API_KEY;
const PROFUNDO_BASE_URL = process.env.PROFUNDO_BASE_URL || "https://api.profundoai.com/v1";
const MODEL = process.env.PROFUNDO_MODEL || "gpt-6-astra";

async function callAI(messages) {
  const https = require("https");
  const url = new URL(PROFUNDO_BASE_URL + "/chat/completions");
  const body = JSON.stringify({ model: MODEL, messages, max_tokens: 500, temperature: 0.3 });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname, path: url.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + PROFUNDO_API_KEY, "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let d = ""; res.on("data", (c) => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); } });
    });
    req.on("error", reject);
    req.write(body); req.end();
  });
}

async function main() {
  console.log("=== AI Decision Pipeline Test ===\n");

  // 1. Get real market data
  const token = await fetchAccessToken(process.env.TOSS_CLIENT_ID, process.env.TOSS_CLIENT_SECRET);
  const symbol = "005930"; // Samsung Electronics
  const resp = await getCandles(token, symbol, "1d", { count: 40 });
  const raw = Array.isArray(resp.body) ? resp.body : (resp.body && resp.body.candles) || [];
  const candles = raw.map((c) => ({
    open: Number(c.open || c.openPrice || 0), high: Number(c.high || c.highPrice || 0),
    low: Number(c.low || c.lowPrice || 0), close: Number(c.close || c.closePrice || 0),
  })).filter((c) => c.close > 0);

  if (candles.length < 21) { console.log("Insufficient candles"); return; }

  const closes = candles.map((c) => c.close);
  const lastClose = closes[closes.length - 1];
  const sma5 = closes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const sma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const chg5d = ((lastClose - closes[closes.length - 6]) / closes[closes.length - 6]) * 100;

  // 2. Generate signal
  const signal = generateSignal({ lastClose, sma5, sma20, changePct5d: chg5d }, null);
  console.log("[Signal] " + symbol + ": " + signal.action + " (score " + signal.score + ")");
  console.log("  reasons: " + (signal.reasons.join("; ") || "none"));

  // 3. Get portfolio
  const [holdings, buyingPower] = await Promise.all([
    getHoldings(token, process.env.TOSS_ACCOUNT_SEQ),
    getBuyingPower(token, process.env.TOSS_ACCOUNT_SEQ),
  ]);
  const positions = (holdings.body && holdings.body.holdings) || [];
  const cash = Number((buyingPower.body && (buyingPower.body.buyingPower || buyingPower.body.cash)) || 0);
  console.log("[Portfolio] " + positions.length + " positions, cash " + cash.toLocaleString() + " KRW");

  // 4. Ask AI for decision
  const prompt = `You are a stock trading AI. Current market data for ${symbol} (Samsung Electronics):
- Last close: ${lastClose.toLocaleString()} KRW
- SMA5: ${Math.round(sma5).toLocaleString()}, SMA20: ${Math.round(sma20).toLocaleString()}
- 5-day change: ${chg5d.toFixed(1)}%
- Trend: ${sma5 > sma20 ? "UP" : "DOWN"}
- Technical signal: ${signal.action} (score ${signal.score})
- Portfolio: ${positions.length} positions, ${cash.toLocaleString()} KRW cash
- Max order value: 100,000 KRW (small test)
- Stop loss: -1.5%, Take profit: +3%

Based on this data, what action should we take? Respond with exactly one word: BUY, SELL, or HOLD.`;

  console.log("\n[AI] Calling Profundo (" + MODEL + ")...");
  const aiResp = await callAI([{ role: "user", content: prompt }]);
  const aiText = aiResp.choices && aiResp.choices[0] && aiResp.choices[0].message && aiResp.choices[0].message.content;
  console.log("[AI] Response: " + (aiText || JSON.stringify(aiResp).slice(0, 200)));

  // 5. Safety check (simulate a BUY order)
  const safety = createSafety({ maxOrderValueKrw: 100000, maxPositions: 2, allowedSymbols: ["005930", "000660", "035720"] });
  const safetyCheck = safety.checkPreCreateOrder({ symbol, side: "buy", quantity: 1, price: lastClose, positionCount: positions.length, openOrderCount: 0 });
  console.log("\n[Safety] Order check: " + (safetyCheck.ok ? "PASS" : "BLOCKED — " + safetyCheck.reason));

  // 6. Position sizing
  const sizing = sizePosition({ equity: cash || 74_000_000, price: lastClose, atr: null });
  console.log("[Sizing] qty=" + sizing.qty + " value=" + (sizing.qty * lastClose).toLocaleString() + " KRW (" + sizing.reason + ")");

  // 7. Exposure check
  const exposure = checkExposure({ positions, newOrder: { symbol, value: sizing.qty * lastClose }, equity: cash || 74_000_000 });
  console.log("[Exposure] " + (exposure.ok ? "PASS" : "BLOCKED — " + exposure.reason));

  console.log("\n=== Pipeline test complete ===");
}

main().catch((e) => { console.error("FAIL: " + e.message); process.exit(1); });
