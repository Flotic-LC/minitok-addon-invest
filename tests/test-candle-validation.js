"use strict";

/**
 * Profitability measurement system — fail-closed input validation and the
 * trust gate that stands between a measurement and a live risk parameter.
 *
 * [2026-10-21] Regression cover for the failure that made the bot's
 * profitability unmeasurable: a candles file with open/close = 0 produced
 * zero trades, sharpe 0 and a flat equity curve, and because every metric is
 * a number the result was indistinguishable from a real measurement. The
 * runner read it back as "the strategy is conservative" and loosened live
 * risk (stop -2% -> -3%, take-profit 5% -> 8%).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { validateCandleData, validateCandle, buildResultMeta } = require("../src/strategy/candle-validation");
const { assessBacktestTrust } = require("../src/agent/backtest-trust");
const { runBacktest } = require("../backtest");

const REPO_ROOT = path.join(__dirname, "..");

/** Build a valid daily candle series for one symbol. */
function makeCandles(symbol, days, opts = {}) {
  const out = [];
  let price = opts.startPrice || 100;
  const base = new Date("2025-01-02T00:00:00Z");
  for (let i = 0; i < days; i++) {
    const d = new Date(base.getTime() + i * 86400000);
    const drift = opts.drift != null ? opts.drift : 0.004;
    const open = price;
    const close = price * (1 + drift);
    const high = Math.max(open, close) * 1.006;
    const low = Math.min(open, close) * 0.994;
    out.push({
      symbol,
      date: d.toISOString().slice(0, 10),
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
      volume: 1000000 + i * 1000,
    });
    price = close;
  }
  return out;
}

const BASE_OPTS = {
  initial: 10000000, stopLoss: -2, takeProfit: 5, maxOrderValueKrw: 1500000,
  slippagePct: 0.1, impactCoefficient: 0, partialFillRate: 1.0, commissionPct: 0.015,
};

// ---------------------------------------------------------------------------
// validateCandle — single candle rules
// ---------------------------------------------------------------------------

test("validateCandle rejects close=0", () => {
  const c = makeCandles("AAPL", 3)[0];
  c.close = 0;
  const r = validateCandle(c);
  assert.ok(r, "expected a rejection reason");
  assert.match(r, /close is not positive/);
});

test("validateCandle rejects open=0", () => {
  const c = makeCandles("AAPL", 3)[0];
  c.open = 0;
  assert.match(validateCandle(c), /open is not positive/);
});

test("validateCandle rejects NaN", () => {
  const c = makeCandles("AAPL", 3)[0];
  c.close = NaN;
  assert.match(validateCandle(c), /close is not a finite number/);
});

test("validateCandle rejects Infinity and non-numeric prices", () => {
  const c = makeCandles("AAPL", 3)[0];
  c.high = Infinity;
  assert.match(validateCandle(c), /high is not a finite number/);
  const d = makeCandles("AAPL", 3)[0];
  d.close = "700";
  assert.match(validateCandle(d), /close is not a finite number/);
});

test("validateCandle rejects a missing symbol, date and volume problems", () => {
  const a = makeCandles("AAPL", 3)[0];
  delete a.symbol;
  assert.match(validateCandle(a), /missing symbol/);
  const b = makeCandles("AAPL", 3)[0];
  delete b.date;
  assert.match(validateCandle(b), /missing date/);
  const c = makeCandles("AAPL", 3)[0];
  c.volume = -5;
  assert.match(validateCandle(c), /volume is negative/);
  const d = makeCandles("AAPL", 3)[0];
  d.high = d.low - 1;
  assert.match(validateCandle(d), /below low/);
});

// ---------------------------------------------------------------------------
// validateCandleData — dataset rules
// ---------------------------------------------------------------------------

test("validateCandleData accepts a clean series and reports its provenance", () => {
  const candles = makeCandles("AAPL", 60);
  const v = validateCandleData(candles);
  assert.equal(v.ok, true, v.invalidReason);
  assert.equal(v.confidence, "high");
  assert.equal(v.metadata.candleCount, 60);
  assert.equal(v.metadata.validCandleCount, 60);
  assert.equal(v.metadata.validCandleRatio, 1);
  assert.equal(v.metadata.symbolCount, 1);
  assert.equal(v.metadata.dataStart, "2025-01-02");
  assert.ok(v.metadata.dataEnd > v.metadata.dataStart);
});

test("validateCandleData rejects a dataset with a zero close", () => {
  const candles = makeCandles("AAPL", 60);
  candles[10].close = 0;
  const v = validateCandleData(candles);
  assert.equal(v.ok, false);
  assert.match(v.invalidReason, /AAPL/);
  assert.ok(v.metadata.validCandleRatio < 1);
});

test("validateCandleData rejects too few candles for a symbol", () => {
  const v = validateCandleData(makeCandles("AAPL", 10));
  assert.equal(v.ok, false);
  assert.match(v.invalidReason, /minimum is 30/);
});

test("validateCandleData rejects duplicate timestamps", () => {
  const candles = makeCandles("AAPL", 60);
  candles[20].date = candles[19].date;
  const v = validateCandleData(candles);
  assert.equal(v.ok, false);
  assert.match(v.invalidReason, /duplicate timestamps/);
});

test("validateCandleData rejects out-of-order timestamps", () => {
  const candles = makeCandles("AAPL", 60);
  const tmp = candles[30].date;
  candles[30].date = candles[10].date;
  candles[10].date = tmp;
  const v = validateCandleData(candles);
  assert.equal(v.ok, false);
  assert.match(v.invalidReason, /out-of-order/);
});

test("validateCandleData rejects an empty dataset", () => {
  const v = validateCandleData([]);
  assert.equal(v.ok, false);
  assert.match(v.invalidReason, /empty/);
});

test("validateCandleData rejects a symbol with no usable candles", () => {
  const candles = makeCandles("AAPL", 60);
  const broken = makeCandles("MSFT", 60);
  for (const c of broken) c.close = 0;
  const v = validateCandleData(candles.concat(broken));
  assert.equal(v.ok, false);
  assert.match(v.invalidReason, /MSFT/);
});

// ---------------------------------------------------------------------------
// runBacktest — metadata + the 0-trade distinction
// ---------------------------------------------------------------------------

test("runBacktest on valid data produces a result with full provenance metadata", () => {
  const candles = makeCandles("AAPL", 120, { drift: 0.003 });
  const r = runBacktest(candles, BASE_OPTS);
  assert.ok(r.meta, "result must carry meta");
  assert.equal(r.meta.validation, "ok");
  assert.equal(r.meta.confidence, "high");
  assert.equal(r.meta.symbolCount, 1);
  assert.equal(r.meta.candleCount, 120);
  assert.equal(r.meta.validCandleRatio, 1);
  assert.equal(r.meta.trades, r.trades);
  assert.ok(r.meta.dataStart && r.meta.dataEnd);
  assert.ok(r.meta.costModel, "result must record the cost model it was run with");
  assert.equal(r.meta.costModel.commissionPct, BASE_OPTS.commissionPct);
  assert.equal(r.meta.costModel.slippagePct, BASE_OPTS.slippagePct);
  assert.equal(r.meta.invalidReason, null);
});

test("runBacktest on unusable prices reports 0 trades and marks the result invalid", () => {
  const candles = makeCandles("AAPL", 120);
  for (const c of candles) c.close = 0;
  const r = runBacktest(candles, BASE_OPTS);
  assert.equal(r.trades, 0);
  assert.equal(r.meta.validation, "invalid");
  assert.equal(r.meta.confidence, "none");
  assert.ok(r.meta.invalidReason, "an invalid result must say why");
  assert.equal(r.sharpe, 0);
});

test("buildResultMeta marks a failed validation as invalid with the reason", () => {
  const v = validateCandleData(makeCandles("AAPL", 5));
  const meta = buildResultMeta(v, { trades: 0 });
  assert.equal(meta.validation, "invalid");
  assert.equal(meta.confidence, "none");
  assert.ok(meta.invalidReason);
});

// ---------------------------------------------------------------------------
// assessBacktestTrust — the gate in front of the live risk parameters
// ---------------------------------------------------------------------------

function trustedResult(overrides = {}) {
  return Object.assign({
    sharpe: 1.2, totalReturnPct: 8.5, maxDrawdownPct: 4.1, trades: 42,
    wins: 20, losses: 22, winRatePct: 47.6,
    meta: {
      validation: "ok", confidence: "high", invalidReason: null,
      dataStart: "2025-01-02", dataEnd: "2025-06-30",
      symbolCount: 3, candleCount: 360, validCandleRatio: 1, trades: 42,
      costModel: { commissionPct: 0.015 },
    },
  }, overrides);
}

test("assessBacktestTrust accepts a validated result with enough trades", () => {
  const t = assessBacktestTrust(trustedResult());
  assert.equal(t.trusted, true, t.reason);
  assert.equal(t.provenance.trades, 42);
  assert.equal(t.provenance.symbolCount, 3);
});

test("assessBacktestTrust rejects a 0-trade result", () => {
  const zero = trustedResult({ sharpe: 0, totalReturnPct: 0, maxDrawdownPct: 0, trades: 0 });
  zero.meta.trades = 0;
  const t = assessBacktestTrust(zero);
  assert.equal(t.trusted, false);
  assert.match(t.reason, /trades=0/);
});

test("assessBacktestTrust rejects a result with too few trades", () => {
  const few = trustedResult({ trades: 3 });
  few.meta.trades = 3;
  const t = assessBacktestTrust(few);
  assert.equal(t.trusted, false);
  assert.match(t.reason, /< min/);
});

test("assessBacktestTrust rejects a result with no validation metadata", () => {
  const legacy = trustedResult();
  delete legacy.meta;
  const t = assessBacktestTrust(legacy);
  assert.equal(t.trusted, false);
  assert.match(t.reason, /no validation metadata/);
});

test("assessBacktestTrust rejects a result whose own validation failed", () => {
  const bad = trustedResult();
  bad.meta.validation = "invalid";
  bad.meta.invalidReason = "AAPL: close is not positive";
  const t = assessBacktestTrust(bad);
  assert.equal(t.trusted, false);
  assert.match(t.reason, /validation failed/);
});

test("assessBacktestTrust rejects a degraded result", () => {
  const degraded = trustedResult();
  degraded.meta.confidence = "degraded";
  const t = assessBacktestTrust(degraded);
  assert.equal(t.trusted, false);
  assert.match(t.reason, /confidence/);
});

test("assessBacktestTrust rejects a result whose trade count disagrees with its metadata", () => {
  const mismatched = trustedResult({ trades: 42 });
  mismatched.meta.trades = 41;
  const t = assessBacktestTrust(mismatched);
  assert.equal(t.trusted, false);
  assert.match(t.reason, /mismatch/);
});

test("assessBacktestTrust rejects a result over too short a data span", () => {
  const short = trustedResult();
  short.meta.dataEnd = "2025-01-10";
  const t = assessBacktestTrust(short);
  assert.equal(t.trusted, false);
  assert.match(t.reason, /data span/);
});

test("assessBacktestTrust rejects all-zero metrics", () => {
  const zeroish = trustedResult({ sharpe: 0, totalReturnPct: 0, maxDrawdownPct: 0 });
  const t = assessBacktestTrust(zeroish);
  assert.equal(t.trusted, false);
  assert.match(t.reason, /all metrics are zero/);
});

// ---------------------------------------------------------------------------
// The CLI: an invalid run must never overwrite a good result
// ---------------------------------------------------------------------------

test("the backtest CLI refuses to write a result for unusable input", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-invalid-"));
  try {
    const candles = makeCandles("AAPL", 60);
    for (const c of candles) c.close = 0;
    const dataPath = path.join(dir, "candles.json");
    fs.writeFileSync(dataPath, JSON.stringify(candles), "utf8");

    let failed = false;
    try {
      execFileSync(process.execPath, ["backtest.js", "--data", dataPath], { cwd: REPO_ROOT, stdio: "pipe" });
    } catch (e) {
      failed = true;
      assert.equal(e.status, 2, "the CLI must exit non-zero for rejected input");
      assert.match(String(e.stderr), /INPUT DATA REJECTED/);
    }
    assert.ok(failed, "the CLI must fail on unusable input");
    assert.equal(fs.existsSync(path.join(dir, "backtest-result.json")), false,
      "no result file may be written for rejected input");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the backtest CLI quarantines a 0-trade result and leaves the previous result intact", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bt-zero-"));
  try {
    const dataPath = path.join(dir, "candles.json");
    fs.writeFileSync(dataPath, JSON.stringify(makeCandles("AAPL", 60)), "utf8");

    // A previous good result that must survive the failed run.
    const goodPath = path.join(dir, "backtest-result.json");
    const good = { sharpe: 1.1, trades: 30, meta: { validation: "ok", confidence: "high" } };
    fs.writeFileSync(goodPath, JSON.stringify(good), "utf8");

    // Valid data, but every order is refused by the safety guard, so the run
    // completes with zero trades. That is a computation outcome, not a
    // strategy verdict, and it must not be published as one.
    const execArgs = ["backtest.js", "--data", dataPath, "--max-order-value", "1"];

    let exitCode = 0;
    try {
      execFileSync(process.execPath, execArgs, { cwd: REPO_ROOT, stdio: "pipe" });
    } catch (e) {
      exitCode = e.status;
    }
    assert.equal(exitCode, 3, "a 0-trade run must exit with the quarantine code");
    assert.equal(fs.readFileSync(goodPath, "utf8"), JSON.stringify(good),
      "the previous good result must not be overwritten");
    const quarantined = JSON.parse(fs.readFileSync(path.join(dir, "backtest-result.invalid.json"), "utf8"));
    assert.equal(quarantined.trades, 0);
    assert.equal(quarantined.meta.validation, "ok", "the data was fine");
    assert.equal(quarantined.meta.confidence, "high");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
