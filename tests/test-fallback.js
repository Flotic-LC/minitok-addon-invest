"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { fallbackDecision, checkQualityGate, normalizeSymbol, detectMarket } = require("../src/strategy/fallback");

const strongBuyCtx = {
  lastClose: 105000, sma5: 104000, sma20: 100000,
  ema9: 103500, ema21: 101000, rsi14: 28, changePct5d: 3,
  macd: { macdLine: 120, signal: 100, histogram: 20 },
  bollinger: { upper: 110000, middle: 104000, lower: 104500 },
  atr14: 1500, // ~1.4% volatility — reasonable
};

test("risk exit (stop-loss) always executes in fallback", () => {
  const ctx = { lastClose: 95000 };
  const pos = { avgPrice: 100000, qty: 10 };
  const d = fallbackDecision(ctx, pos);
  assert.equal(d.action, "SELL");
  assert.equal(d.fallback, true);
  assert.equal(d.quantity, 10);
});

test("BUY blocked for penny stock (below price floor)", () => {
  const pennyCtx = { ...strongBuyCtx, lastClose: 500 }; // Below 1000 KRW floor
  const d = fallbackDecision(pennyCtx, null, { symbol: "005930" });
  assert.equal(d, null);
});

test("BUY blocked for extremely volatile stock (ATR too high)", () => {
  // atr14=30000 → 28.6% volatility, exceeds Tier 2 default cap of 25%
  const volatileCtx = { ...strongBuyCtx, atr14: 30000 };
  const d = fallbackDecision(volatileCtx, null, { symbol: "005930" });
  assert.equal(d, null);
});

test("BUY blocked for unknown market format", () => {
  const d = fallbackDecision(strongBuyCtx, null, { symbol: "INVALID_SYMBOL" });
  assert.equal(d, null);
});

test("BUY allowed with sufficient score when quality gate passes", () => {
  const weakCtx = {
    lastClose: 105000, sma5: 104000, sma20: 100000,
    ema9: 100500, ema21: 101000, rsi14: 55, changePct5d: 3,
    macd: { macdLine: 120, signal: 100, histogram: 20 },
    atr14: 1500,
  };
  const d = fallbackDecision(weakCtx, null, { symbol: "005930" });
  assert.ok(d, "expected fallback BUY decision, got null");
  assert.equal(d.action, "BUY");
});

test("BUY allowed for quality symbol with strong score", () => {
  const d = fallbackDecision(strongBuyCtx, null, { symbol: "005930" });
  assert.ok(d, "expected fallback BUY decision, got null");
  assert.equal(d.action, "BUY");
  assert.equal(d.fallback, true);
  assert.equal(d.scaled, true);
  assert.equal(d.qtyDivisor, 2);
  assert.ok(d.reason.includes("quality"));
  assert.ok(d.qualityGate);
});

test("BUY respects explicit allowlist", () => {
  const allowlist = new Set(["AAPL"]);
  const d1 = fallbackDecision(strongBuyCtx, null, { symbol: "AAPL", allowlist });
  assert.equal(d1.action, "BUY");
  const d2 = fallbackDecision(strongBuyCtx, null, { symbol: "MSFT", allowlist });
  assert.equal(d2, null); // Not in allowlist
});

test("BUY respects explicit blocklist", () => {
  const blocklist = new Set(["AAPL"]);
  const d1 = fallbackDecision(strongBuyCtx, null, { symbol: "AAPL", blocklist });
  assert.equal(d1, null); // Blocked
  const d2 = fallbackDecision(strongBuyCtx, null, { symbol: "MSFT", blocklist });
  assert.equal(d2.action, "BUY"); // Not blocked
});

test("weak trend exit stays HOLD in fallback", () => {
  const ctx = {
    lastClose: 103500, sma5: 104000,
    macd: { macdLine: 110, signal: 100, histogram: 10 },
    ema9: 103000, ema21: 101000,
  };
  const pos = { avgPrice: 103000, qty: 5 };
  const d = fallbackDecision(ctx, pos);
  assert.equal(d, null);
});

test("strong trend exit executes in fallback", () => {
  const ctx = {
    lastClose: 103500, sma5: 104000,
    macd: { macdLine: 90, signal: 100, histogram: -10 },
    ema9: 100500, ema21: 101000,
  };
  const pos = { avgPrice: 103000, qty: 5 };
  const d = fallbackDecision(ctx, pos, { fallbackMinScore: 3 });
  assert.equal(d.action, "SELL");
  assert.ok(d.reason.startsWith("fallback(conservative)"));
});

test("HOLD signal returns null", () => {
  const d = fallbackDecision({ lastClose: 0 }, null);
  assert.equal(d, null);
});

test("normalizeSymbol strips exchange prefixes", () => {
  assert.equal(normalizeSymbol("kr:005930"), "005930");
  assert.equal(normalizeSymbol("US:AAPL"), "AAPL");
  assert.equal(normalizeSymbol("aapl"), "AAPL");
});

test("detectMarket identifies markets correctly", () => {
  assert.equal(detectMarket("005930"), "KR");
  assert.equal(detectMarket("AAPL"), "US");
  assert.equal(detectMarket("7203"), "JP");
  assert.equal(detectMarket("INVALID"), "UNKNOWN");
});

test("checkQualityGate passes for reasonable KR stock", () => {
  const ctx = { lastClose: 70000, atr14: 1000 };
  const result = checkQualityGate("005930", ctx);
  assert.equal(result.pass, true);
});

test("checkQualityGate fails for penny stock", () => {
  const ctx = { lastClose: 500, atr14: 50 };
  const result = checkQualityGate("005930", ctx);
  assert.equal(result.pass, false);
  assert.ok(result.reason.includes("price"));
});

test("checkQualityGate fails for high volatility", () => {
  // atr14=30000 on price 100000 → 30% ATR, exceeds Tier 2 default cap of 25%
  const ctx = { lastClose: 100000, atr14: 30000 };
  const result = checkQualityGate("005930", ctx);
  assert.equal(result.pass, false);
  assert.ok(result.reason.includes("ATR"));
});

test("checkQualityGate respects US price floor", () => {
  const ctx = { lastClose: 0.5, atr14: 0.1 };
  const result = checkQualityGate("AAPL", ctx);
  assert.equal(result.pass, false);
  assert.ok(result.reason.includes("USD"));
});
