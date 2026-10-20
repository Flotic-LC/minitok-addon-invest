"use strict";

const test = require("node:test");
const assert = require("node:assert");
const {
  lastCompletedSession,
  localTimeToUtc,
  previousDateStr,
  isWeekendDate,
  mostRecentWeekday,
  kstHm,
} = require("../src/core/session-window");

test("session-window: local time converts to the right UTC instant", () => {
  assert.strictEqual(
    localTimeToUtc("2026-10-20", 930, "Asia/Seoul").toISOString(),
    "2026-10-20T00:30:00.000Z"
  );
  assert.strictEqual(
    localTimeToUtc("2026-10-20", 900, "Asia/Tokyo").toISOString(),
    "2026-10-20T00:00:00.000Z"
  );
  // US: EDT (UTC-4) in October, EST (UTC-5) in January
  assert.strictEqual(
    localTimeToUtc("2026-10-16", 930, "America/New_York").toISOString(),
    "2026-10-16T13:30:00.000Z"
  );
  assert.strictEqual(
    localTimeToUtc("2026-01-16", 930, "America/New_York").toISOString(),
    "2026-01-16T14:30:00.000Z"
  );
  assert.strictEqual(
    localTimeToUtc("2026-10-16", 1600, "America/New_York").toISOString(),
    "2026-10-16T20:00:00.000Z"
  );
});

test("session-window: previous date rolls over month and year boundaries", () => {
  assert.strictEqual(previousDateStr("2026-10-20"), "2026-10-19");
  assert.strictEqual(previousDateStr("2026-10-01"), "2026-09-30");
  assert.strictEqual(previousDateStr("2026-01-01"), "2025-12-31");
  assert.strictEqual(previousDateStr("2026-03-01"), "2026-02-28");
});

test("session-window: weekend detection and weekday walk-back", () => {
  assert.strictEqual(isWeekendDate("2026-10-17"), true);  // Saturday
  assert.strictEqual(isWeekendDate("2026-10-18"), true);  // Sunday
  assert.strictEqual(isWeekendDate("2026-10-19"), false); // Monday
  // Sunday -> back to Friday
  assert.strictEqual(mostRecentWeekday("2026-10-18"), "2026-10-16");
  // Saturday -> back to Friday
  assert.strictEqual(mostRecentWeekday("2026-10-17"), "2026-10-16");
  // A weekday is returned unchanged
  assert.strictEqual(mostRecentWeekday("2026-10-19"), "2026-10-19");
});

test("session-window: after the JP close the JP session is the latest closed one", () => {
  const s = lastCompletedSession(new Date("2026-10-20T06:00:00Z"));
  assert.ok(s, "expected a completed session");
  assert.strictEqual(s.market, "JP");
  assert.strictEqual(s.closeAt.toISOString(), "2026-10-20T06:00:00.000Z");
  assert.strictEqual(s.openAt.toISOString(), "2026-10-20T00:00:00.000Z");
});

test("session-window: while KR/JP are open the last closed session is US", () => {
  const s = lastCompletedSession(new Date("2026-10-20T00:10:00Z"));
  assert.ok(s, "expected a completed session");
  assert.strictEqual(s.market, "US");
  assert.strictEqual(s.closeAt.toISOString(), "2026-10-19T20:00:00.000Z");
  assert.strictEqual(s.openAt.toISOString(), "2026-10-19T13:30:00.000Z");
});

test("session-window: a session in progress is never reported as closed", () => {
  // 2026-10-19T14:00:00Z = US 10:00 EDT -> the US session is still running
  const s = lastCompletedSession(new Date("2026-10-19T14:00:00Z"));
  assert.ok(s, "expected a completed session");
  assert.notStrictEqual(s.market, "US");
  assert.ok(s.closeAt.getTime() <= new Date("2026-10-19T14:00:00Z").getTime());
});

test("session-window: on a weekend the last session is the previous Friday", () => {
  const s = lastCompletedSession(new Date("2026-10-18T06:00:00Z"));
  assert.ok(s, "expected a completed session");
  assert.strictEqual(s.market, "US");
  assert.strictEqual(s.closeAt.toISOString(), "2026-10-16T20:00:00.000Z");
});

test("session-window: kstHm renders KST wall-clock time", () => {
  assert.strictEqual(kstHm(new Date("2026-10-19T13:30:00Z")), "10-19 22:30");
  assert.strictEqual(kstHm(new Date("2026-10-19T20:00:00Z")), "10-20 05:00");
});
