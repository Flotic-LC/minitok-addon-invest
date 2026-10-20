"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { createNotifyLevel, LEVELS } = require("../src/core/notify-level");

test("notify-level: defaults to critical only", () => {
  const nl = createNotifyLevel({});
  assert.strictEqual(nl.level, "critical");
  assert.strictEqual(nl.allowed("critical"), true);
  assert.strictEqual(nl.allowed("warn"), false);
  assert.strictEqual(nl.allowed("info"), false);
});

test("notify-level: critical level allows only critical", () => {
  const nl = createNotifyLevel({ NOTIFY_LEVEL: "critical" });
  assert.strictEqual(nl.allowed("critical"), true);
  assert.strictEqual(nl.allowed("warn"), false);
  assert.strictEqual(nl.allowed("info"), false);
  assert.strictEqual(nl.allowed("warning"), false);
});

test("notify-level: warn level allows critical and warn", () => {
  const nl = createNotifyLevel({ NOTIFY_LEVEL: "warn" });
  assert.strictEqual(nl.allowed("critical"), true);
  assert.strictEqual(nl.allowed("warn"), true);
  assert.strictEqual(nl.allowed("info"), false);
});

test("notify-level: all level allows everything", () => {
  const nl = createNotifyLevel({ NOTIFY_LEVEL: "all" });
  assert.strictEqual(nl.allowed("critical"), true);
  assert.strictEqual(nl.allowed("warn"), true);
  assert.strictEqual(nl.allowed("info"), true);
});

test("notify-level: unknown level falls back to critical", () => {
  const nl = createNotifyLevel({ NOTIFY_LEVEL: "bogus" });
  assert.strictEqual(nl.level, "critical");
  assert.strictEqual(nl.allowed("warn"), false);
});

test("notify-level: severity matching is case-insensitive, missing severity is info", () => {
  const nl = createNotifyLevel({ NOTIFY_LEVEL: "warn" });
  assert.strictEqual(nl.allowed("CRITICAL"), true);
  assert.strictEqual(nl.allowed("Warn"), true);
  assert.strictEqual(nl.allowed(undefined), false);
  assert.strictEqual(nl.allowed(null), false);
});

test("notify-level: exposes the supported level names", () => {
  assert.deepStrictEqual(LEVELS.slice(), ["critical", "warn", "all"]);
});
