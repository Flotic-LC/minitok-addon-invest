"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createEventGuard, SCHEDULES } = require("../src/strategy/event-calendar");

test("no event returns inactive when schedules disabled", () => {
  const guard = createEventGuard({ schedules: [], customEvents: [] });
  const quiet = new Date("2026-06-20T03:00:00Z");
  const r = guard.check(quiet);
  assert.equal(r.active, false);
  assert.equal(r.sizeMultiplier, 1.0);
  assert.equal(r.blockNewBuys, false);
});

test("custom event within guard window reduces size (no full block)", () => {
  const guard = createEventGuard({
    schedules: [],
    customEvents: [{
      id: "test_event",
      name: "Test FOMC",
      market: "US",
      impact: "high",
      date: "2026-06-15T14:00:00Z",
    }],
  });
  const during = new Date("2026-06-15T13:00:00Z"); // 1 hour before (inside 2h guard window)
  const r = guard.check(during);
  assert.equal(r.active, true);
  assert.equal(r.blockNewBuys, true);
  // [Tier 2] was 0 (full block), now 0.5 (half-size reduction only)
  assert.equal(r.sizeMultiplier, 0.5);
  assert.ok(r.reason.includes("Test FOMC"));
});

test("custom event in warning window reduces size", () => {
  const guard = createEventGuard({
    schedules: [],
    customEvents: [{
      id: "test_cpi",
      name: "Test CPI",
      market: "US",
      impact: "high",
      date: "2026-06-15T14:00:00Z",
    }],
  });
  // [Tier 2] warning window = 12h, so 6 hours before falls in warning zone
  const before = new Date("2026-06-15T08:00:00Z");
  const r = guard.check(before);
  assert.equal(r.active, true);
  assert.equal(r.blockNewBuys, false);
  assert.equal(r.sizeMultiplier, 0.75); // [Tier 2] was 0.5, now 0.75
});

test("event already passed returns inactive", () => {
  const guard = createEventGuard({
    schedules: [], // disable recurring schedules to isolate custom event
    customEvents: [{
      id: "past_event",
      name: "Past Event",
      market: "US",
      impact: "high",
      date: "2026-06-10T14:00:00Z",
    }],
  });
  const after = new Date("2026-06-16T12:00:00Z");
  const r = guard.check(after);
  assert.equal(r.active, false);
});

test("market filter only matches relevant events", () => {
  const guard = createEventGuard({
    schedules: [],
    customEvents: [{
      id: "us_event",
      name: "US Only",
      market: "US",
      impact: "high",
      date: "2026-06-15T14:00:00Z",
    }],
  });
  const during = new Date("2026-06-15T13:00:00Z");
  const krCheck = guard.check(during, "KR");
  assert.equal(krCheck.active, false); // US event doesn't affect KR
  const usCheck = guard.check(during, "US");
  assert.equal(usCheck.active, true);
});

test("getUpcomingEvents returns sorted list", () => {
  const guard = createEventGuard({
    schedules: [],
    customEvents: [
      { id: "e1", name: "Event A", market: "US", impact: "high", date: "2026-06-15T14:00:00Z" },
      { id: "e2", name: "Event B", market: "KR", impact: "medium", date: "2026-06-15T10:00:00Z" },
    ],
  });
  const at = new Date("2026-06-15T08:00:00Z");
  const events = guard.getUpcomingEvents(at, 24);
  assert.ok(events.length >= 2);
  assert.ok(events[0].hoursAway <= events[1].hoursAway);
});

test("SCHEDULES contains expected event types", () => {
  const ids = SCHEDULES.map(s => s.id);
  assert.ok(ids.includes("fomc"));
  assert.ok(ids.includes("us_cpi"));
  assert.ok(ids.includes("boj"));
  assert.ok(ids.includes("us_nfp"));
  // [2026-10-21] The Korean macro events were removed with the KR market.
  assert.ok(!ids.includes("bok"));
  assert.ok(!ids.includes("kr_cpi"));
});

test("medium impact events do not block BUY", () => {
  const guard = createEventGuard({
    schedules: [],
    customEvents: [{
      id: "medium_evt",
      name: "Medium Event",
      market: "KR",
      impact: "medium",
      date: "2026-06-15T14:00:00Z",
    }],
  });
  const during = new Date("2026-06-15T13:00:00Z");
  const r = guard.check(during);
  assert.equal(r.active, true);
  assert.equal(r.blockNewBuys, false); // medium doesn't block
});
