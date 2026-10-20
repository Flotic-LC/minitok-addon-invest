"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { isMarketOpen, getActiveMarkets, createHolidayCache, isTradableMarket, TRADABLE_MARKETS, SESSIONS } = require("../src/agent/marketCalendar");

test("the Korean market is no longer tradable", () => {
  // [2026-10-21] KRX was removed: no session window and not on the
  // allow-list, so a Korean symbol can never be traded.
  assert.equal(isTradableMarket("KR"), false);
  assert.equal(isTradableMarket("US"), true);
  assert.equal(isTradableMarket("JP"), true);
  assert.ok(!TRADABLE_MARKETS.includes("KR"));
  assert.ok(!("KR" in SESSIONS));
  // Even during KRX hours the market is not open.
  assert.equal(isMarketOpen("KR", new Date("2026-01-05T01:00:00Z")), false); // 10:00 KST
  assert.equal(isMarketOpen("KR", new Date("2026-01-05T07:00:00Z")), false); // 16:00 KST
  assert.equal(isMarketOpen("KR", new Date("2026-01-03T01:00:00Z")), false); // Saturday
});

test("US session handles DST: summer vs winter open hour in UTC", () => {
  // Summer (EDT, UTC-4): 09:30 ET = 13:30 UTC
  assert.equal(isMarketOpen("US", new Date("2026-07-06T13:30:00Z")), true);
  assert.equal(isMarketOpen("US", new Date("2026-07-06T13:29:00Z")), false);
  // Winter (EST, UTC-5): 09:30 ET = 14:30 UTC
  assert.equal(isMarketOpen("US", new Date("2026-01-05T14:30:00Z")), true);
  assert.equal(isMarketOpen("US", new Date("2026-01-05T14:29:00Z")), false);
});

test("holiday set blocks trading", () => {
  const monday = new Date("2026-01-05T01:00:00Z"); // 10:00 JST Monday
  assert.equal(isMarketOpen("JP", monday), true);
  assert.equal(isMarketOpen("JP", monday, new Set(["2026-01-05"])), false);
});

test("getActiveMarkets returns only open markets", () => {
  // 2026-01-05 02:00 UTC = 11:00 JST open, US closed
  const active = getActiveMarkets(new Date("2026-01-05T02:00:00Z"));
  assert.ok(!active.includes("KR"));
  assert.ok(active.includes("JP"));
  assert.ok(!active.includes("US"));
});

test("holiday cache fetches once and reuses within TTL", async () => {
  let calls = 0;
  const cache = createHolidayCache({
    fetchCalendar: async () => { calls++; return { body: [{ date: "2026-01-01" }] }; },
    ttlMs: 60000,
  });
  const h1 = await cache.holidaysFor("JP");
  const h2 = await cache.holidaysFor("JP");
  assert.equal(calls, 1);
  assert.ok(h1.has("2026-01-01"));
  assert.ok(h2.has("2026-01-01"));
});

test("holiday cache survives API errors with empty set", async () => {
  const cache = createHolidayCache({ fetchCalendar: async () => { throw new Error("down"); } });
  const h = await cache.holidaysFor("US");
  assert.equal(h.size, 0);
});
