"use strict";

/**
 * Deterministic candle fixture generator for the backtest measurement suite.
 *
 * [2026-10-21] The previous fixtures were unusable:
 *   - tests/real-candles-multi.json had 299 of 300 candles with an empty
 *     date, so the series could not be ordered or de-duplicated;
 *   - tests/real-candles-*.json used "day0".."day59" as the date, which is
 *     not a timestamp at all;
 *   - tests/sample-candles.json held 15 candles, fewer than the indicator
 *     set needs (MACD 26, Bollinger 20, RSI/ATR 14);
 *   - backtest-result.json and tests/backtest-result.json were the
 *     zero-valued results of a run whose input had open/close = 0, and they
 *     are what the live risk feedback loop was reading.
 *
 * Every fixture produced here is validated by src/strategy/candle-validation
 * before it is written, so a broken generator can never publish a broken
 * fixture again.
 *
 * Usage:
 *   node tests/gen-candles.js            # regenerate every fixture
 *   node tests/gen-candles.js --check    # validate the existing fixtures
 */

const fs = require("node:fs");
const path = require("node:path");
const { validateCandleData } = require("../src/strategy/candle-validation");

/** Deterministic PRNG (mulberry32) so a fixture is reproducible. */
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function isoDate(index) {
  const base = Date.UTC(2025, 0, 2);
  return new Date(base + index * 86400000).toISOString().slice(0, 10);
}

/**
 * Build a daily series for one symbol.
 * The OHLC range always brackets the open and the close, and the dates are
 * strictly increasing ISO dates.
 */
function buildSeries(symbol, days, startPrice, drift, vol, seed) {
  const rng = makeRng(seed);
  const out = [];
  let price = startPrice;
  for (let i = 0; i < days; i++) {
    const ret = drift + vol * gauss(rng);
    price = price * (1 + ret);
    const close = price;
    const open = price * (1 + (rng() - 0.5) * 0.003);
    const high = Math.max(open, close) * (1 + Math.abs(gauss(rng)) * 0.004);
    const low = Math.min(open, close) * (1 - Math.abs(gauss(rng)) * 0.004);
    out.push({
      symbol: symbol,
      date: isoDate(i),
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
      volume: Math.floor(500000 + rng() * 4000000),
    });
  }
  return out;
}

// US large caps — the universe the bot actually trades.
const SYMBOLS = [
  { symbol: "AAPL", start: 185, drift: 0.0012, vol: 0.016, seed: 11 },
  { symbol: "MSFT", start: 410, drift: 0.0010, vol: 0.015, seed: 23 },
  { symbol: "NVDA", start: 120, drift: 0.0026, vol: 0.032, seed: 37 },
  { symbol: "SPY", start: 560, drift: 0.0008, vol: 0.011, seed: 41 },
  { symbol: "QQQ", start: 480, drift: 0.0011, vol: 0.015, seed: 53 },
];

const OUT_DIR = __dirname;

function writeFixture(name, candles) {
  const v = validateCandleData(candles);
  if (!v.ok) {
    console.error("[gen-candles] REFUSING to write " + name + ": " + v.invalidReason);
    process.exitCode = 1;
    return false;
  }
  const out = path.join(OUT_DIR, name);
  fs.writeFileSync(out, JSON.stringify(candles, null, 2), "utf8");
  console.log("[gen-candles] wrote " + candles.length + " candles (" + v.metadata.symbolCount
    + " symbol(s), " + v.metadata.dataStart + " .. " + v.metadata.dataEnd + ") to " + out);
  return true;
}

function main() {
  const checkOnly = process.argv.includes("--check");
  const targets = [
    ["sample-candles.json", [buildSeries("AAPL", 90, 185, 0.0012, 0.016, 11)]],
    ["real-candles-005930.json", [buildSeries("AAPL", 60, 185, 0.0012, 0.016, 11)]],
    ["real-candles-005930-120d.json", [buildSeries("AAPL", 120, 185, 0.0012, 0.016, 11)]],
    ["real-candles-multi.json", SYMBOLS.map(s => buildSeries(s.symbol, 120, s.start, s.drift, s.vol, s.seed))],
  ];

  if (checkOnly) {
    let bad = 0;
    for (const [name] of targets) {
      const p = path.join(OUT_DIR, name);
      if (!fs.existsSync(p)) { console.error("MISSING " + name); bad++; continue; }
      const candles = JSON.parse(fs.readFileSync(p, "utf8"));
      const v = validateCandleData(candles);
      if (!v.ok) { console.error("INVALID " + name + ": " + v.invalidReason); bad++; }
      else console.log("OK     " + name + " (" + candles.length + " candles)");
    }
    if (bad) process.exitCode = 1;
    return;
  }

  for (const [name, series] of targets) {
    writeFixture(name, [].concat.apply([], series));
  }
}

if (require.main === module) main();

module.exports = { buildSeries, makeRng, SYMBOLS };
