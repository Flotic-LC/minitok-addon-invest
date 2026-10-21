"use strict";

/**
 * Candle data validation — the fail-closed gate for every backtest input.
 *
 * [2026-10-21] The profitability measurement system was silently broken.
 * A candles file whose open/close were 0 (high/low were fine) produced
 * zero trades, sharpe 0, a flat equity curve and a 0% return — and because
 * every one of those is a number, the result file looked exactly like a
 * normal result. The runner then read it back as "the strategy is safe but
 * underperforming" and LOOSENED live risk on the strength of no evidence:
 * stop-loss -2% -> -3%, take-profit 5% -> 8%.
 *
 * The root cause was that nothing distinguished "the strategy did not trade"
 * from "the input could not be traded". This module makes that distinction
 * explicit and attaches the provenance to every result, so a consumer can
 * tell a real measurement from a computation failure.
 *
 * Usage:
 *   const { validateCandleData } = require("./src/strategy/candle-validation");
 *   const v = validateCandleData(candles);
 *   if (!v.ok) return;               // refuse to run / refuse to save
 *   console.log(v.metadata);         // provenance for the result file
 */

const DEFAULTS = Object.freeze({
  // A symbol needs enough bars for the indicator set the signal engine uses
  // (MACD 26, Bollinger 20, RSI/ATR 14) plus enough history to actually
  // contain a signal. Below this the engine cannot judge anything.
  minCandlesPerSymbol: Number(process.env.BT_MIN_CANDLES_PER_SYMBOL || 30),
});

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function dateSortKey(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

/**
 * Validate one candle.
 * @returns {string|null} null when the candle is usable, otherwise the reason.
 */
function validateCandle(c) {
  if (!c || typeof c !== "object" || Array.isArray(c)) return "candle is not an object";
  if (typeof c.symbol !== "string" || !c.symbol.trim()) return "missing symbol";
  if (typeof c.date !== "string" || !c.date.trim()) return "missing date";
  for (const f of ["open", "high", "low", "close"]) {
    const v = c[f];
    if (!isFiniteNumber(v)) return f + " is not a finite number (" + String(v) + ")";
    if (v <= 0) return f + " is not positive (" + String(v) + ")";
  }
  if (c.high < c.low) return "high (" + c.high + ") below low (" + c.low + ")";
  if (c.high < Math.max(c.open, c.close)) return "high (" + c.high + ") below open/close";
  if (c.low > Math.min(c.open, c.close)) return "low (" + c.low + ") above open/close";
  if (c.volume != null) {
    if (!isFiniteNumber(c.volume)) return "volume is not a finite number";
    if (c.volume < 0) return "volume is negative (" + c.volume + ")";
  }
  return null;
}

/**
 * Validate a whole candle dataset.
 *
 * Error-level (ok=false): the dataset cannot be measured at all.
 *   - empty / not an array
 *   - a symbol with no valid candles
 *   - a symbol with fewer than minCandlesPerSymbol valid candles
 *   - duplicate timestamps inside a symbol
 *   - out-of-order timestamps inside a symbol
 *   - unparseable dates (ordering cannot be verified)
 *
 * Warning-level (ok=true but confidence="degraded"): some candles were
 * invalid and were excluded from the run. The result is still computed, but
 * it is NOT written as a normal backtest result.
 */
function validateCandleData(candles, options = {}) {
  const cfg = { ...DEFAULTS, ...(options || {}) };
  const metadata = {
    dataStart: null,
    dataEnd: null,
    symbolCount: 0,
    symbols: [],
    candleCount: 0,
    validCandleCount: 0,
    validCandleRatio: 0,
    minCandlesPerSymbol: cfg.minCandlesPerSymbol,
    perSymbol: {},
    issues: [],
  };

  if (!Array.isArray(candles) || candles.length === 0) {
    metadata.issues.push("candle data is empty or not an array");
    return {
      ok: false,
      invalidReason: "candle data is empty or not an array",
      issues: metadata.issues.slice(),
      metadata,
    };
  }

  metadata.candleCount = candles.length;

  const validFlags = new Array(candles.length).fill(false);
  const invalidReasons = new Map();
  for (let i = 0; i < candles.length; i++) {
    const reason = validateCandle(candles[i]);
    if (reason === null) validFlags[i] = true;
    else invalidReasons.set(i, reason);
  }
  metadata.validCandleCount = validFlags.filter(Boolean).length;
  metadata.validCandleRatio = Number((metadata.validCandleCount / metadata.candleCount).toFixed(4));

  // Group by symbol, preserving input order.
  const bySymbol = new Map();
  for (let i = 0; i < candles.length; i++) {
    const raw = candles[i] && typeof candles[i].symbol === "string" ? candles[i].symbol : "";
    const key = raw.trim().toUpperCase() || "(missing-symbol)";
    if (!bySymbol.has(key)) bySymbol.set(key, []);
    bySymbol.get(key).push(i);
  }
  metadata.symbols = [...bySymbol.keys()].sort();
  metadata.symbolCount = metadata.symbols.length;

  let minKey = null;
  let maxKey = null;
  const errors = [];

  for (const [sym, idxs] of bySymbol) {
    const info = {
      candles: idxs.length,
      valid: 0,
      first: null,
      last: null,
      duplicates: 0,
      outOfOrder: 0,
      unparseableDates: 0,
    };
    let firstInvalidReason = null;
    let prevKey = null;
    const seen = new Set();
    for (const i of idxs) {
      const c = candles[i];
      if (validFlags[i]) info.valid++;
      else if (firstInvalidReason == null) firstInvalidReason = invalidReasons.get(i) || "unknown";
      if (typeof c.date === "string" && c.date.trim()) {
        if (info.first == null) info.first = c.date;
        info.last = c.date;
      }
      const k = dateSortKey(c.date);
      if (k == null) {
        info.unparseableDates++;
        continue;
      }
      if (minKey == null || k < minKey) minKey = k;
      if (maxKey == null || k > maxKey) maxKey = k;
      if (seen.has(k)) info.duplicates++;
      seen.add(k);
      if (prevKey != null && k <= prevKey) info.outOfOrder++;
      prevKey = k;
    }
    metadata.perSymbol[sym] = info;

    if (info.valid === 0) {
      errors.push(sym + ": no valid candles (all " + info.candles + " rejected)");
    } else if (info.valid < cfg.minCandlesPerSymbol) {
      errors.push(sym + ": only " + info.valid + " valid candles, minimum is " + cfg.minCandlesPerSymbol);
    }
    if (info.unparseableDates > 0) {
      errors.push(sym + ": " + info.unparseableDates + " candles have unparseable dates");
    }
    if (info.duplicates > 0) {
      errors.push(sym + ": " + info.duplicates + " duplicate timestamps");
    }
    if (info.outOfOrder > 0) {
      errors.push(sym + ": " + info.outOfOrder + " out-of-order timestamps");
    }
    if (info.valid < info.candles) {
      // [2026-10-21] Fail-closed: a dataset that contains even one unusable
      // candle is refused outright. We know the data is damaged, and a
      // dataset that is damaged in one place may be damaged in ways that
      // do not show up as a per-candle error. The issue list names the
      // symbol and the count so the operator can find the bad bars.
      errors.push(sym + ": " + (info.candles - info.valid) + " invalid candles (" + firstInvalidReason + ")");
    }
  }

  if (minKey != null) metadata.dataStart = new Date(minKey).toISOString().slice(0, 10);
  if (maxKey != null) metadata.dataEnd = new Date(maxKey).toISOString().slice(0, 10);
  if (metadata.symbolCount === 0) errors.push("no symbols found in candle data");

  const allIssues = errors.concat(metadata.issues);
  metadata.issues = allIssues;
  const ok = errors.length === 0;
  const confidence = !ok ? "none" : (metadata.validCandleRatio < 1 ? "degraded" : "high");

  return {
    ok,
    invalidReason: ok ? null : errors.join("; "),
    issues: allIssues,
    confidence,
    metadata,
  };
}

/**
 * Build the metadata block that every backtest result must carry.
 * The consumer (runner.js loadBacktestFeedback) refuses any result whose
 * meta.validation is not "ok" or whose confidence is "none" — a result
 * written by an older build carries no meta at all and is therefore
 * untrusted by default.
 */
function buildResultMeta(validation, extra) {
  const meta = Object.assign(
    {
      validation: "invalid",
      confidence: "none",
      invalidReason: null,
      dataStart: null,
      dataEnd: null,
      symbolCount: 0,
      symbols: [],
      candleCount: 0,
      validCandleCount: 0,
      validCandleRatio: 0,
      trades: 0,
      costModel: null,
    },
    (validation && validation.metadata) || {},
    (extra || {})
  );
  if (validation && validation.ok) {
    meta.validation = "ok";
    meta.confidence = validation.confidence || "high";
    meta.invalidReason = null;
  } else {
    meta.validation = "invalid";
    meta.confidence = "none";
    meta.invalidReason = (validation && validation.invalidReason) || "unknown";
  }
  return meta;
}

module.exports = {
  validateCandleData,
  validateCandle,
  buildResultMeta,
  DEFAULTS,
};
