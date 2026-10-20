"use strict";

// Generates a deterministic sample candle series for backtest.js validation.
// The price path rises, pulls back, then rises again so the momentum/
// mean-reversion strategy produces both BUY and SELL trades (wins + losses).
const fs = require("node:fs");
const path = require("node:path");

const dates = [
  "2025-01-02", "2025-01-03", "2025-01-06", "2025-01-07", "2025-01-08",
  "2025-01-09", "2025-01-10", "2025-01-13", "2025-01-14", "2025-01-15",
  "2025-01-16", "2025-01-17", "2025-01-20", "2025-01-21", "2025-01-22",
];
const drift = [500, 500, 800, 400, 600, 400, 600, 400, -700, -500, -200, -300, 400, 400, 500];

let price = 70000;
const candles = [];
for (let i = 0; i < dates.length; i++) {
  const open = price;
  const close = price + drift[i];
  const high = Math.max(open, close) + 300;
  const low = Math.min(open, close) - 300;
  candles.push({
    symbol: "005930",
    date: dates[i],
    open: open,
    high: high,
    low: low,
    close: close,
    volume: 1000000 + i * 50000,
  });
  price = close;
}

const out = path.join(__dirname, "sample-candles.json");
fs.writeFileSync(out, JSON.stringify(candles, null, 2), "utf8");
console.log("wrote " + candles.length + " candles to " + out);
