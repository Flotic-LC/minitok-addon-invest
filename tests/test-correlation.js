"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { getCorrelation, checkCorrelation, adjustForCorrelation, sectorOf, marketOf } = require("../src/agent/correlation");

// [2026-10-21] The Korean market was removed, so the fixtures use US/JP
// symbols. A Korean symbol is still *classified* as "KR" (that is what lets
// the execution path refuse it) but it no longer has a sector, so it can no
// longer be used as a correlated-holding fixture.

test("same symbol has correlation 1.0", () => {
  assert.equal(getCorrelation("AAPL", "AAPL"), 1.0);
});

test("same sector returns high correlation", () => {
  const corr = getCorrelation("NVDA", "AMD");
  assert.ok(corr >= 0.7, `expected >= 0.7, got ${corr}`);
});

test("different sector same market returns moderate correlation", () => {
  const corr = getCorrelation("NVDA", "TSLA"); // semiconductor vs auto, both US
  assert.ok(corr >= 0.3 && corr < 0.7, `expected 0.3-0.7, got ${corr}`);
});

test("different market returns low correlation", () => {
  const corr = getCorrelation("AAPL", "7203");
  assert.ok(corr < 0.3, `expected < 0.3, got ${corr}`);
});

test("injected matrix overrides heuristic", () => {
  const matrix = { "A:B": 0.95 };
  assert.equal(getCorrelation("A", "B", matrix), 0.95);
  assert.equal(getCorrelation("B", "A", matrix), 0.95);
});

test("checkCorrelation passes with no positions", () => {
  const r = checkCorrelation({ symbol: "AAPL", positions: [] });
  assert.equal(r.ok, true);
  assert.equal(r.sizeMultiplier, 1.0);
});

test("checkCorrelation blocks highly correlated new position", () => {
  const positions = [{ symbol: "NVDA", qty: 10, currentPrice: 120 }];
  const r = checkCorrelation({ symbol: "AMD", positions });
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("correlation"));
});

test("checkCorrelation reduces size for moderately correlated", () => {
  const positions = [{ symbol: "NVDA", qty: 10, currentPrice: 120 }];
  const r = checkCorrelation({ symbol: "TSLA", positions }); // same market, diff sector
  if (r.maxCorrelation >= 0.5) {
    assert.equal(r.sizeMultiplier, 0.5);
  } else {
    assert.equal(r.sizeMultiplier, 1.0);
  }
});

test("checkCorrelation passes for uncorrelated symbol", () => {
  const positions = [{ symbol: "AAPL", qty: 10, currentPrice: 200 }];
  const r = checkCorrelation({ symbol: "7203", positions });
  assert.equal(r.ok, true);
  assert.equal(r.sizeMultiplier, 1.0);
});

test("adjustForCorrelation halves qty when correlated", () => {
  const corrResult = { sizeMultiplier: 0.5, reason: "test" };
  const r = adjustForCorrelation(10, corrResult);
  assert.equal(r.qty, 5);
  assert.equal(r.adjusted, true);
});

test("adjustForCorrelation keeps qty when multiplier is 1", () => {
  const corrResult = { sizeMultiplier: 1.0, reason: "none" };
  const r = adjustForCorrelation(10, corrResult);
  assert.equal(r.qty, 10);
  assert.equal(r.adjusted, false);
});

test("sectorOf identifies known sectors", () => {
  assert.equal(sectorOf("NVDA"), "semiconductor");
  assert.equal(sectorOf("AAPL"), "tech");
  assert.equal(sectorOf("UNKNOWN"), null);
});

test("sectorOf no longer knows Korean symbols", () => {
  assert.equal(sectorOf("005930"), null);
});

test("marketOf identifies markets", () => {
  assert.equal(marketOf("005930"), "KR");
  assert.equal(marketOf("AAPL"), "US");
  assert.equal(marketOf("7203"), "JP");
});
