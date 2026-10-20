"use strict";
/**
 * Live data parity validation — fetches real candles from Toss and
 * runs backtest-vs-live signal parity on them.
 */
const fs = require("node:fs");
const path = require("node:path");

// Load .env
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const { fetchAccessToken, getCandles } = require("./src/tossinvest");
const { runParity } = require("./validate-parity");

async function main() {
  const symbols = (process.env.PARITY_SYMBOLS || "005930,000660,035420").split(",");
  const token = await fetchAccessToken(process.env.TOSS_CLIENT_ID, process.env.TOSS_CLIENT_SECRET);

  console.log("=== Live Data Parity Validation ===\n");
  let allPass = true;

  for (const symbol of symbols) {
    console.log("[" + symbol + "] fetching candles...");
    const resp = await getCandles(token, symbol.trim(), "1d", { count: 60 });
    const raw = Array.isArray(resp.body) ? resp.body : (resp.body && resp.body.candles) || [];
    const candles = raw.map((c, i) => ({
      symbol, date: c.date || c.tradeDate || ("day" + i),
      open: Number(c.open || c.openPrice || 0), high: Number(c.high || c.highPrice || 0),
      low: Number(c.low || c.lowPrice || 0), close: Number(c.close || c.closePrice || 0),
      volume: Number(c.volume || 0),
    })).filter((c) => c.close > 0);

    if (candles.length < 25) { console.log("  SKIP — only " + candles.length + " candles\n"); continue; }
    console.log("  " + candles.length + " candles loaded");

    const r = runParity(candles);
    console.log("  Windows: " + r.total + ", Agreement: " + r.agree + " (" + r.rate.toFixed(1) + "%)");
    console.log("  Mismatches: " + r.mismatches.length + " (" + r.dataGapMismatches + " data-gap, " + r.logicDivergence + " logic divergence)");
    if (r.logicDivergence > 0) {
      allPass = false;
      for (const m of r.mismatches.filter((x) => !x.dataGap)) {
        console.log("    LOGIC DIVERGENCE: " + m.date + " bt=" + m.backtest + " live=" + m.live);
      }
    }
    console.log();
  }

  console.log("Overall: " + (allPass ? "PASS ✓ (no logic divergence)" : "FAIL ✗"));
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error("FAIL: " + e.message); process.exit(1); });
