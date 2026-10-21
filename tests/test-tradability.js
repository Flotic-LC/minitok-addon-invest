"use strict";

/**
 * Tradability gate tests.
 *
 * [2026-10-21 4단계] The gate is the last thing between a signal and a real
 * order, so it has to refuse the orders that cannot make money and let the
 * ones that can through. The checks are independent, so each one is tested
 * on its own.
 */

const test = require("node:test");
const assert = require("node:assert");
const {
  assessTradability,
  apiSupportsMarket,
  rankByOpportunity,
  API_SUPPORTED_MARKETS,
} = require("../src/agent/tradability");
const { marketSessionState, minutesUntilNextOpen } = require("../src/agent/marketCalendar");

// 2026-10-21 is a Wednesday.
// 15:00 UTC = 11:00 ET (EDT, UTC-4)  -> the US session is open.
// 12:00 UTC = 08:00 ET                 -> before the open.
// 03:00 UTC = 23:00 ET                 -> after the close.
const OPEN_AT = Date.parse("2026-10-21T15:00:00Z");
const PRE_AT = Date.parse("2026-10-21T12:00:00Z");
const CLOSED_AT = Date.parse("2026-10-21T03:00:00Z");

function base(over) {
  return Object.assign({
    symbol: "AAPL",
    market: "US",
    side: "BUY",
    price: 230,
    dollarVolume: 11_000_000_000,
    spreadBps: 5,
    dataAt: OPEN_AT - 30_000,
    lastTradeAt: OPEN_AT - 5_000,
    now: OPEN_AT,
  }, over || {});
}

test("the broker only collects data for the US market", function () {
  assert.deepStrictEqual(API_SUPPORTED_MARKETS, ["US"]);
  assert.strictEqual(apiSupportsMarket("US"), true);
  assert.strictEqual(apiSupportsMarket("JP"), false);
  assert.strictEqual(apiSupportsMarket("KR"), false);
});

test("a liquid US symbol inside the session is tradable", function () {
  const r = assessTradability(base());
  assert.strictEqual(r.tradable, true, r.reason || "");
  assert.strictEqual(r.session.state, "open");
  assert.ok(r.expectedCostPct > 0, "the round-trip cost must be reported");
  assert.strictEqual(r.fillProbability > 0, true);
});

test("a market the broker cannot price is refused", function () {
  const r = assessTradability(base({ symbol: "7203", market: "JP" }));
  assert.strictEqual(r.tradable, false);
  assert.ok(/cannot collect data/.test(r.reason), r.reason);
});

test("a closed market refuses a buy", function () {
  const r = assessTradability(base({ now: CLOSED_AT, dataAt: CLOSED_AT - 30_000, lastTradeAt: CLOSED_AT - 5_000 }));
  assert.strictEqual(r.tradable, false);
  assert.ok(/queue/.test(r.reason), r.reason);
  assert.ok(r.expectedFillMinutes > 0, "the wait must be reported");
});

test("a closed market may still queue a risk-reducing exit", function () {
  const r = assessTradability(base({
    side: "SELL", allowClosedMarket: true, now: CLOSED_AT,
    dataAt: CLOSED_AT - 30_000, lastTradeAt: CLOSED_AT - 5_000,
  }));
  assert.strictEqual(r.tradable, true, r.reason || "");
  assert.ok(r.expectedFillMinutes > 0, "the queued exit still carries the gap risk");
});

test("the pre-market window is a closed market", function () {
  const r = assessTradability(base({ now: PRE_AT, dataAt: PRE_AT - 30_000, lastTradeAt: PRE_AT - 5_000 }));
  assert.strictEqual(r.tradable, false);
  assert.strictEqual(r.session.state, "pre");
});

test("a price below the floor is refused", function () {
  const r = assessTradability(base({ price: 3 }));
  assert.strictEqual(r.tradable, false);
  assert.ok(/below the 5 floor/.test(r.reason), r.reason);
});

test("a symbol below the dollar-volume floor is refused", function () {
  const r = assessTradability(base({ dollarVolume: 1_000_000 }));
  assert.strictEqual(r.tradable, false);
  assert.ok(/dollar volume/.test(r.reason), r.reason);
});

test("a spread wider than the limit is refused", function () {
  const r = assessTradability(base({ spreadBps: 50 }));
  assert.strictEqual(r.tradable, false);
  assert.ok(/spread/.test(r.reason), r.reason);
});

test("a stale quote is refused", function () {
  const r = assessTradability(base({ dataAt: OPEN_AT - 30 * 60 * 1000 }));
  assert.strictEqual(r.tradable, false);
  assert.ok(/old/.test(r.reason), r.reason);
});

test("a symbol that has not traded recently is refused", function () {
  const r = assessTradability(base({ lastTradeAt: OPEN_AT - 10 * 60 * 1000 }));
  assert.strictEqual(r.tradable, false);
  assert.ok(/last trade/.test(r.reason), r.reason);
});

test("a price on the broker's daily limit is refused", function () {
  const r = assessTradability(base({ price: 240, upperLimitPrice: 240, lowerLimitPrice: 100 }));
  assert.strictEqual(r.tradable, false);
  assert.ok(/daily limit/.test(r.reason), r.reason);
});

test("an expected move smaller than the round trip is refused", function () {
  const r = assessTradability(base({ expectedMovePct: 0.3 }));
  assert.strictEqual(r.tradable, false);
  assert.ok(/expected move/.test(r.reason), r.reason);
});

test("an expected move that clears the cost is accepted", function () {
  const r = assessTradability(base({ expectedMovePct: 2 }));
  assert.strictEqual(r.tradable, true, r.reason || "");
  assert.ok(r.expectedNetEdgePct > 0, "the net edge must be reported");
  assert.ok(r.expectedNetEdgePct < r.expectedEdgePct, "the cost must be subtracted");
});

test("a missing spread or volume is not a reason to refuse", function () {
  const r = assessTradability(base({ spreadBps: 0, dollarVolume: 0, lastTradeAt: 0 }));
  assert.strictEqual(r.tradable, true, r.reason || "");
});

test("the ranking prefers the opportunity that survives the cost", function () {
  // A 20 bps spread is still tradable against a 2% expected move, but it
  // eats twice as much of it as a 2 bps spread does.
  const wide = assessTradability(base({ symbol: "WIDE", spreadBps: 20, expectedMovePct: 2.0 }));
  const tight = assessTradability(base({ symbol: "TIGHT", spreadBps: 2, expectedMovePct: 2.0 }));
  assert.strictEqual(wide.tradable, true, wide.reason || "");
  assert.strictEqual(tight.tradable, true, tight.reason || "");
  const ranked = rankByOpportunity([wide, tight]);
  assert.strictEqual(ranked.length, 2);
  assert.strictEqual(ranked[0].symbol, "TIGHT", "the tighter spread must rank first");
  assert.ok(ranked[0].opportunity > ranked[1].opportunity);
});

test("a candidate whose spread eats the expected move is not tradable at all", function () {
  const r = assessTradability(base({ symbol: "WIDE", spreadBps: 25, expectedMovePct: 1.0 }));
  assert.strictEqual(r.tradable, false);
  assert.ok(/expected move/.test(r.reason), r.reason);
});

test("the ranking drops the candidates that are not tradable", function () {
  const bad = assessTradability(base({ symbol: "BAD", price: 1 }));
  const good = assessTradability(base({ symbol: "GOOD" }));
  const ranked = rankByOpportunity([bad, good]);
  assert.strictEqual(ranked.length, 1);
  assert.strictEqual(ranked[0].symbol, "GOOD");
});

/**
 * [2026-10-21 4단계] The session boundaries are HHMM (930 = 09:30). The
 * remaining time has to be computed in minutes of the day: comparing the
 * two as HHMM reported a 487-minute wait for a session that opens in 46.
 */
test("the wait for the next open is in minutes, not in HHMM", function () {
  // 12:00 UTC = 08:00 New York (EDT, UTC-4) -> 90 minutes to the 09:30 open.
  const pre = marketSessionState("US", new Date(Date.parse("2026-10-21T12:00:00Z")));
  assert.strictEqual(pre.state, "pre");
  assert.strictEqual(pre.opensInMinutes, 90);
  assert.strictEqual(minutesUntilNextOpen("US", new Date(Date.parse("2026-10-21T12:00:00Z"))), 90);

  // 15:00 UTC = 11:00 New York -> the session is open, 5 hours to the close.
  const open = marketSessionState("US", new Date(Date.parse("2026-10-21T15:00:00Z")));
  assert.strictEqual(open.state, "open");
  assert.strictEqual(open.closesInMinutes, 300);

  // 03:00 UTC = 23:00 New York -> after the close; the next open is tomorrow.
  const post = marketSessionState("US", new Date(Date.parse("2026-10-21T03:00:00Z")));
  assert.strictEqual(post.state, "post");
  const wait = minutesUntilNextOpen("US", new Date(Date.parse("2026-10-21T03:00:00Z")));
  assert.ok(wait > 600 && wait <= 1440, "expected roughly a night of waiting, got " + wait);
});
