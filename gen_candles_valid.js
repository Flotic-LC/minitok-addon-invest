/**
 * Build a valid candle file for EVOLUTION_CANDLES_PATH.
 * The existing /app/candles.json has open=0/close=0, which makes backtest.js skip
 * every signal (if (!price) continue). This regenerates a realistic daily series.
 */
"use strict";
const fs = require("fs");

const OUT = process.argv[2] || "/app/candles.json";

const symbols = ["005930", "000660", "035720", "005380", "051910"];
const candles = [];

// Deterministic PRNG so runs are reproducible.
let seed = 20261015;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

const start = { "005930": 72000, "000660": 178000, "035720": 33000, "005380": 205000, "051910": 305000 };

let d = new Date("2026-04-01T00:00:00+09:00");
for (let i = 0; i < 180; i++) {
  // skip weekends (daily candles only)
  const dow = d.getDay();
  if (dow !== 0 && dow !== 6) {
    for (const sym of symbols) {
      const base = start[sym];
      // trend + noise: uptrend, pullback, chop, recovery
      const phase = i < 60 ? 0.0016 : i < 80 ? -0.0022 : i < 120 ? 0.0002 : 0.0013;
      const drift = base * (phase + (rnd() - 0.5) * 0.011);
      start[sym] = Math.max(base * 0.6, start[sym] + drift);
      const close = Math.round(start[sym] / 50) * 50;
      const open = Math.round((close - drift) / 50) * 50;
      candles.push({
        symbol: sym,
        date: d.toISOString().slice(0, 10),
        open: open,
        high: Math.max(open, close) + Math.round(base * 0.004 / 50) * 50,
        low: Math.min(open, close) - Math.round(base * 0.004 / 50) * 50,
        close: close,
        volume: 1000000 + Math.round(rnd() * 9000000),
      });
    }
  }
  d.setDate(d.getDate() + 1);
}

const bad = candles.filter((c) => !(Number(c.open) > 0 && Number(c.close) > 0 && Number(c.high) > 0 && Number(c.low) > 0));
fs.writeFileSync(OUT, JSON.stringify(candles, null, 2), "utf8");
console.log("wrote " + candles.length + " candles to " + OUT);
console.log("symbols: " + [...new Set(candles.map((c) => c.symbol))].join(","));
console.log("range: " + candles[0].date + " .. " + candles[candles.length - 1].date);
console.log("invalid rows (open/close/high/low must be >0): " + bad.length);
console.log("sample: " + JSON.stringify(candles[0]));