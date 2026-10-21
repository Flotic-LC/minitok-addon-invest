"use strict";

/**
 * Fail-closed behaviour of the backtest measurement system.
 *
 * [2026-10-21] These tests pin the failures that made the profitability
 * measurement untrustworthy:
 *   - a candles file with open/close = 0 produced a "normal" zero-valued
 *     result, and the live risk feedback loop read it as a measurement;
 *   - the order was sized from the raw price, so the slippage- and
 *     commission-adjusted value landed just over the order cap and every
 *     order was rejected — a backtest that could not trade at all;
 *   - the safety module's daily traded-value limit was keyed on the real
 *     clock, so a 120-day replay was measured as a single trading day;
 *   - a result with no provenance metadata was accepted, and a result with a
 *     small drawdown was treated as licence to widen the live stop.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { runBacktest, parseArgs, DEFAULT_CONFIG } = require("../backtest");
const { validateCandleData } = require("../src/strategy/candle-validation");
const { assessBacktestTrust, roundTripCostPct } = require("../src/agent/backtest-trust");
const { createSafety } = require("../src/agent/safety");

const REPO = path.join(__dirname, "..");

function makeCandles(symbol, days, startPrice, drift, seed) {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [];
  let price = startPrice;
  for (let i = 0; i < days; i++) {
    price = price * (1 + drift + 0.012 * (rnd() - 0.5));
    const close = price;
    const open = price * (1 + (rnd() - 0.5) * 0.002);
    const high = Math.max(open, close) * (1 + rnd() * 0.003);
    const low = Math.min(open, close) * (1 - rnd() * 0.003);
    out.push({
      symbol: symbol,
      date: new Date(Date.UTC(2025, 0, 2) + i * 86400000).toISOString().slice(0, 10),
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
      volume: 1000000,
    });
  }
  return out;
}

const GOOD = makeCandles("AAPL", 90, 150, 0.002, 7);

function baseOpts(overrides) {
  return Object.assign({}, DEFAULT_CONFIG, {
    initial: 10000000,
    stopLoss: -8,
    takeProfit: 8,
    maxOrderValueKrw: 1500000,
    commissionPct: 0.25,
    slippagePct: 0.1,
  }, overrides || {});
}

// --- 1. The validator refuses unusable input -------------------------------

test("validateCandleData rejects a candle with a zero close", function () {
  const candles = GOOD.map((c) => Object.assign({}, c));
  candles[10].close = 0;
  const v = validateCandleData(candles);
  assert.strictEqual(v.ok, false);
  assert.ok(/close/.test(v.invalidReason), "reason should name the close field: " + v.invalidReason);
  assert.strictEqual(v.metadata.validCandleCount, GOOD.length - 1);
});

test("validateCandleData rejects a NaN price", function () {
  const candles = GOOD.map((c) => Object.assign({}, c));
  candles[5].high = NaN;
  const v = validateCandleData(candles);
  assert.strictEqual(v.ok, false);
  assert.ok(/high/.test(v.invalidReason), "reason should name the high field: " + v.invalidReason);
});

test("validateCandleData rejects a negative volume", function () {
  const candles = GOOD.map((c) => Object.assign({}, c));
  candles[3].volume = -1;
  const v = validateCandleData(candles);
  assert.strictEqual(v.ok, false);
  assert.ok(/volume/.test(v.invalidReason), "reason should name the volume field: " + v.invalidReason);
});

test("validateCandleData rejects a dataset with too few candles per symbol", function () {
  const v = validateCandleData(GOOD.slice(0, 12), { minCandlesPerSymbol: 30 });
  assert.strictEqual(v.ok, false);
  assert.ok(/minimum/.test(v.invalidReason), v.invalidReason);
});

test("validateCandleData rejects duplicate and out-of-order timestamps", function () {
  const dup = GOOD.slice(0, 40).concat([GOOD[39]]);
  assert.strictEqual(validateCandleData(dup).ok, false, "a duplicate timestamp must be rejected");

  const scrambled = GOOD.slice(0, 40);
  const tmp = scrambled[10];
  scrambled[10] = scrambled[20];
  scrambled[20] = tmp;
  assert.strictEqual(validateCandleData(scrambled).ok, false, "out-of-order timestamps must be rejected");
});

test("validateCandleData rejects a high that does not bracket the open and close", function () {
  const candles = GOOD.map((c) => Object.assign({}, c));
  candles[7].high = candles[7].low * 0.5;
  const v = validateCandleData(candles);
  assert.strictEqual(v.ok, false);
  assert.ok(/high/.test(v.invalidReason), v.invalidReason);
});

test("validateCandleData accepts a clean series and reports full provenance", function () {
  const v = validateCandleData(GOOD);
  assert.strictEqual(v.ok, true, v.invalidReason);
  assert.strictEqual(v.metadata.candleCount, GOOD.length);
  assert.strictEqual(v.metadata.validCandleCount, GOOD.length);
  assert.strictEqual(v.metadata.validCandleRatio, 1);
  assert.strictEqual(v.metadata.symbolCount, 1);
  assert.strictEqual(v.metadata.dataStart, GOOD[0].date);
  assert.strictEqual(v.metadata.dataEnd, GOOD[GOOD.length - 1].date);
});

// --- 2. The backtest refuses to trade on unusable input ---------------------

test("runBacktest on a dataset with unusable prices produces no trades and is flagged invalid", function () {
  const broken = GOOD.map((c) => Object.assign({}, c, { open: 0, close: 0 }));
  const r = runBacktest(broken, baseOpts());
  assert.strictEqual(r.trades, 0);
  assert.notStrictEqual(r.meta.validation, "ok", "a zero-price dataset must not be reported as valid");
  assert.ok(r.meta.invalidReason, "an invalid run must carry a reason");
});

test("runBacktest on valid data performs a backtest and saves the result metadata", function () {
  const r = runBacktest(GOOD, baseOpts());
  assert.ok(r.trades > 0, "valid data must produce trades, got " + r.trades);
  assert.strictEqual(r.meta.validation, "ok");
  assert.strictEqual(r.meta.confidence, "high");
  assert.strictEqual(r.meta.candleCount, GOOD.length);
  assert.strictEqual(r.meta.trades, r.trades);
  assert.ok(r.meta.costModel, "the cost model must be recorded");
  assert.ok(r.meta.dataStart && r.meta.dataEnd);
});

test("the order fits the limit after costs, so a tight clip does not block every order", function () {
  // The order is sized so that the slippage- and commission-adjusted value
  // still fits under maxOrderValueKrw. Sizing from the raw price pushed it
  // just over the cap and the safety guard rejected every order.
  const r = runBacktest(GOOD, baseOpts({ maxOrderValueKrw: 1500000 }));
  assert.ok(r.trades > 0, "no trade was created — the order value is still exceeding the limit");
});

test("the daily traded-value limit advances with the replayed trading day", function () {
  const safety = createSafety({
    maxOrderValueKrw: 1000000,
    dailyMaxValueKrw: 1000000,
    maxOpenOrders: 10,
    maxPositionsPerSymbol: 5,
    cooldownMs: 0,
    enforcePreChecks: true,
  });
  safety.setTradingDay("2025-01-02");
  const first = safety.checkPreCreateOrder({ symbol: "AAPL", side: "BUY", price: 100, quantity: 6000 });
  assert.strictEqual(first.ok, true, "the first order is within the daily limit");
  // The daily traded value only accumulates once an order succeeds — that is
  // why the backtest had to report its fills to the safety module.
  safety.recordOrderSuccess({ price: 100, quantity: 6000 });
  const second = safety.checkPreCreateOrder({ symbol: "AAPL", side: "BUY", price: 100, quantity: 6000 });
  assert.strictEqual(second.ok, false, "the second order must exhaust the daily limit");
  safety.setTradingDay("2025-01-03");
  const third = safety.checkPreCreateOrder({ symbol: "AAPL", side: "BUY", price: 100, quantity: 6000 });
  assert.strictEqual(third.ok, true, "a new trading day must reset the daily limit");
});

// --- 3. A zero-trade result never reaches the feedback loop -----------------

test("a zero-trade result is rejected by the feedback trust gate", function () {
  const bt = {
    sharpe: 0, totalReturnPct: 0, maxDrawdownPct: 0, trades: 0, winRatePct: 0,
    meta: {
      validation: "ok", confidence: "high", trades: 0,
      dataStart: "2025-01-02", dataEnd: "2025-05-01",
      symbolCount: 5, candleCount: 600, validCandleRatio: 1,
    },
  };
  const t = assessBacktestTrust(bt, { minTrades: 20, minDataDays: 20 });
  assert.strictEqual(t.trusted, false);
  assert.ok(/trades=0/.test(t.reason), t.reason);
});

test("a result without validation metadata is rejected — absent provenance is untrusted", function () {
  const bt = { sharpe: 1.2, totalReturnPct: 12, maxDrawdownPct: 4, trades: 120, winRatePct: 55 };
  const t = assessBacktestTrust(bt, { minTrades: 20, minDataDays: 20 });
  assert.strictEqual(t.trusted, false);
  assert.ok(/metadata/i.test(t.reason), t.reason);
});

test("a result whose input validation failed is rejected", function () {
  const bt = {
    sharpe: 1.2, totalReturnPct: 12, maxDrawdownPct: 4, trades: 120, winRatePct: 55,
    meta: {
      validation: "invalid", confidence: "none", invalidReason: "close is not positive",
      trades: 120, dataStart: "2025-01-02", dataEnd: "2025-05-01",
      symbolCount: 5, candleCount: 600, validCandleRatio: 0.4,
    },
  };
  const t = assessBacktestTrust(bt, { minTrades: 20, minDataDays: 20 });
  assert.strictEqual(t.trusted, false);
});

test("a losing result may not loosen the live risk, a winning one may", function () {
  const meta = {
    validation: "ok", confidence: "high", trades: 120,
    dataStart: "2025-01-02", dataEnd: "2025-05-01",
    symbolCount: 5, candleCount: 600, validCandleRatio: 1,
  };
  const losing = assessBacktestTrust(
    Object.assign({ meta: meta }, { sharpe: -0.1, totalReturnPct: -8, maxDrawdownPct: 12, trades: 120, winRatePct: 30 }),
    { minTrades: 20, minDataDays: 20 });
  assert.strictEqual(losing.trusted, true, "a losing but valid measurement is still a valid measurement");
  assert.strictEqual(losing.mayLoosen, false, "a losing measurement must not be allowed to widen the stop");

  const winning = assessBacktestTrust(
    Object.assign({ meta: meta }, { sharpe: 1.1, totalReturnPct: 9, maxDrawdownPct: 4, trades: 120, winRatePct: 55 }),
    { minTrades: 20, minDataDays: 20 });
  assert.strictEqual(winning.trusted, true);
  assert.strictEqual(winning.mayLoosen, true);
});

// --- 4. The CLI never overwrites a good result with an unusable one ---------

test("the CLI refuses an invalid input and leaves the previous result untouched", function () {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-bt-"));
  try {
    const broken = tmp + path.sep + "candles.json";
    fs.writeFileSync(broken, JSON.stringify(GOOD.map((c) => Object.assign({}, c, { open: 0, close: 0 })), null, 2));
    const resultPath = tmp + path.sep + "backtest-result.json";
    fs.writeFileSync(resultPath, JSON.stringify({ marker: "previous-good-result" }));

    let exitCode = 0;
    try {
      execFileSync(process.execPath, [
        path.join(REPO, "backtest.js"),
        "--data", broken,
        "--initial", "10000000",
        "--max-order-value", "1500000",
      ], { cwd: tmp, stdio: "pipe" });
    } catch (e) {
      exitCode = e.status === undefined ? -1 : e.status;
    }
    assert.notStrictEqual(exitCode, 0, "an invalid input must exit non-zero");
    assert.strictEqual(
      JSON.parse(fs.readFileSync(resultPath, "utf8")).marker,
      "previous-good-result",
      "the previous result must not be overwritten"
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("the CLI quarantines a zero-trade result and leaves the previous result untouched", function () {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-bt-"));
  try {
    const good = tmp + path.sep + "candles.json";
    fs.writeFileSync(good, JSON.stringify(GOOD, null, 2));
    const resultPath = tmp + path.sep + "backtest-result.json";
    fs.writeFileSync(resultPath, JSON.stringify({ marker: "previous-good-result" }));

    // Valid data, but an order limit too small to buy a single share: the
    // run is a measurement that produced no trades, which is not a strategy
    // result.
    let exitCode = 0;
    try {
      execFileSync(process.execPath, [
        path.join(REPO, "backtest.js"),
        "--data", good,
        "--initial", "10000000",
        "--max-order-value", "1",
      ], { cwd: tmp, stdio: "pipe" });
    } catch (e) {
      exitCode = e.status === undefined ? -1 : e.status;
    }
    assert.notStrictEqual(exitCode, 0, "a zero-trade run must exit non-zero");
    assert.strictEqual(
      JSON.parse(fs.readFileSync(resultPath, "utf8")).marker,
      "previous-good-result",
      "the previous result must not be overwritten by a zero-trade run"
    );
    assert.ok(fs.existsSync(tmp + path.sep + "backtest-result.invalid.json"), "the result must be quarantined");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("the CLI writes a valid result with its metadata", function () {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "minitok-bt-"));
  try {
    const good = tmp + path.sep + "candles.json";
    fs.writeFileSync(good, JSON.stringify(GOOD, null, 2));
    execFileSync(process.execPath, [
      path.join(REPO, "backtest.js"),
      "--data", good,
      "--initial", "10000000",
      "--max-order-value", "1500000",
      "--commission", "0.25",
    ], { cwd: tmp, stdio: "pipe" });
    const result = JSON.parse(fs.readFileSync(tmp + path.sep + "backtest-result.json", "utf8"));
    assert.ok(result.trades > 0, "a valid run must produce trades");
    assert.strictEqual(result.meta.validation, "ok");
    assert.strictEqual(result.meta.confidence, "high");
    assert.strictEqual(result.meta.trades, result.trades);
    assert.ok(result.meta.costModel);
    assert.ok(result.meta.dataStart && result.meta.dataEnd);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- 5. The shipped fixtures are valid --------------------------------------

test("the round-trip cost is in percent and matches the live P&L engine", function () {
  const cost = roundTripCostPct("US");
  // 0.25% commission each way + 0.00278% regulatory fee.
  assert.ok(Math.abs(cost - 0.50278) < 0.0001, "expected ~0.5028%, got " + cost);
  // A stop narrower than a small multiple of the cost cannot pay for itself,
  // and the floor must never be looser than the -1.5% the feedback suggests.
  const floor = -(Math.abs(cost) * 3);
  assert.ok(floor < -1.5, "the cost floor must be tighter than -1.5%, got " + floor);
});

test("the shipped candle fixtures pass the validator", function () {
  const fixtures = [
    "tests/sample-candles.json",
    "tests/real-candles-005930.json",
    "tests/real-candles-005930-120d.json",
    "tests/real-candles-multi.json",
  ];
  for (const f of fixtures) {
    const p = path.join(REPO, f);
    assert.ok(fs.existsSync(p), f + " is missing");
    const candles = JSON.parse(fs.readFileSync(p, "utf8"));
    const v = validateCandleData(candles);
    assert.strictEqual(v.ok, true, f + ": " + v.invalidReason);
  }
});

test("the result reports which stop and take-profit actually governed the run", function () {
  const r = runBacktest(GOOD, baseOpts({ stopLoss: -8, takeProfit: 8 }));
  assert.ok(r.meta.effectiveStops, "the result must record the effective stops");
  // The ATR override in the exit signal replaces the supplied stop/take, so
  // the source has to say so — otherwise a measurement claims to have tested
  // a stop it never used.
  assert.ok(["atr", "cli"].includes(r.meta.effectiveStops.source), r.meta.effectiveStops.source);
  assert.strictEqual(r.meta.effectiveStops.suppliedStopLossPct, -8);
  assert.strictEqual(r.meta.effectiveStops.suppliedTakeProfitPct, 8);
});

test("the shipped baseline result is a valid, non-zero measurement", function () {
  const p = path.join(REPO, "backtest-result.json");
  assert.ok(fs.existsSync(p), "the reference baseline backtest-result.json is missing");
  const bt = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.ok(bt.trades > 0, "the baseline must contain trades");
  assert.strictEqual(bt.meta.validation, "ok");
  assert.strictEqual(bt.meta.confidence, "high");
  assert.strictEqual(bt.meta.trades, bt.trades);
  const t = assessBacktestTrust(bt, { minTrades: 20, minDataDays: 20 });
  assert.strictEqual(t.trusted, true, t.reason);
});
