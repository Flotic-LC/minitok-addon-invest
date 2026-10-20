"use strict";
/**
 * Korean-market removal (2026-10-21).
 *
 * The bot no longer trades KRX. These tests pin the removal so a future
 * change cannot silently reintroduce Korean trading: the allow-list, the
 * configuration files and the per-market tables must all be free of it.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

const cal = require("../src/agent/marketCalendar");
const pnl = require("../src/agent/pnl");
const exposure = require("../src/agent/exposure");
const correlation = require("../src/agent/correlation");
const fallback = require("../src/strategy/fallback");
const eventCalendar = require("../src/strategy/event-calendar");

const KOREAN_SYMBOL = /^\d{6}$/;

test("the tradable-market allow-list excludes Korea", () => {
  assert.deepEqual([...cal.TRADABLE_MARKETS].sort(), ["JP", "US"]);
  assert.equal(cal.isTradableMarket("KR"), false);
  assert.equal(cal.isTradableMarket("US"), true);
  assert.equal(cal.isTradableMarket("JP"), true);
  assert.equal(cal.isTradableMarket("unknown"), false);
});

test("the market calendar has no Korean session", () => {
  assert.ok(!("KR" in cal.SESSIONS));
  assert.equal(cal.isMarketOpen("KR", new Date("2026-01-05T01:00:00Z")), false);
});

test("the persisted universe contains no Korean symbol", () => {
  const symbols = readJson("universe.json").symbols;
  assert.ok(symbols.length > 0);
  for (const s of symbols) assert.ok(!KOREAN_SYMBOL.test(s), `Korean symbol in universe: ${s}`);
});

test("the trading goals have no Korean market goal", () => {
  const goals = readJson("goals.json");
  assert.ok(!("KR" in goals.market_goals));
  assert.ok(goals.market_goals.US);
  assert.ok(goals.market_goals.JP);
  for (const [sector, list] of Object.entries(goals.sector_mapping)) {
    for (const s of list) assert.ok(!KOREAN_SYMBOL.test(s), `Korean symbol in sector_mapping.${sector}: ${s}`);
  }
});

test("there is no Korean fee schedule", () => {
  assert.equal(pnl.DEFAULT_FEES.KR, undefined);
  assert.ok(pnl.DEFAULT_FEES.US);
  assert.ok(pnl.DEFAULT_FEES.JP);
});

test("a Korean symbol is still classified, so it can be refused", () => {
  // Dropping the classification would make a 6-digit symbol fall through to
  // "US" and become tradable.
  assert.equal(pnl.detectMarket("005930"), "KR");
  assert.equal(exposure.marketOf("005930"), "KR");
  assert.equal(correlation.marketOf("005930"), "KR");
  assert.equal(fallback.detectMarket("005930"), "KR");
});

test("the sector maps have no Korean symbol", () => {
  for (const symbol of Object.keys(exposure.SECTOR_MAP)) {
    assert.ok(!KOREAN_SYMBOL.test(symbol), `Korean symbol in exposure sector map: ${symbol}`);
  }
  for (const symbol of Object.keys(correlation.SECTORS)) {
    assert.ok(!KOREAN_SYMBOL.test(symbol), `Korean symbol in correlation sector map: ${symbol}`);
  }
});

test("the fallback quality gate has no Korean price floor", () => {
  // A cheap "KR" symbol is no longer price-gated — the Korean floor is gone.
  const r = fallback.checkQualityGate("005930", { lastClose: 1, atr14: 0.01 });
  assert.equal(r.pass, true);
  // The US and JP floors are still in force.
  assert.equal(fallback.checkQualityGate("AAPL", { lastClose: 0.5, atr14: 0.01 }).pass, false);
  assert.equal(fallback.checkQualityGate("7203", { lastClose: 50, atr14: 1 }).pass, false);
});

test("the event calendar has no Korean macro event", () => {
  const ids = eventCalendar.SCHEDULES.map((s) => s.id);
  assert.ok(!ids.includes("bok"));
  assert.ok(!ids.includes("kr_cpi"));
  for (const s of eventCalendar.SCHEDULES) {
    assert.notEqual(s.market, "KR", `Korean event schedule still present: ${s.id}`);
  }
});
