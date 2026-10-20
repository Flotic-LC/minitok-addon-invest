"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const logger = require("../src/agent/logger");
const { createNotifier } = require("../src/agent/notifier");

test("logger outputs valid JSON in json mode", () => {
  process.env.LOG_FORMAT = "json";
  // Capture stdout
  const orig = process.stdout.write;
  let captured = "";
  process.stdout.write = (s) => { captured += s; return true; };
  logger.warn("test message", { symbol: "005930" });
  process.stdout.write = orig;
  process.env.LOG_FORMAT = "text";
  const parsed = JSON.parse(captured.trim());
  assert.equal(parsed.level, "warn");
  assert.equal(parsed.msg, "test message");
  assert.equal(parsed.symbol, "005930");
  assert.ok(parsed.ts);
});

test("logger child adds sub field", () => {
  process.env.LOG_FORMAT = "json";
  const orig = process.stdout.write;
  let captured = "";
  process.stdout.write = (s) => { captured += s; return true; };
  logger.child("planner").info("plan built", { entries: 3 });
  process.stdout.write = orig;
  process.env.LOG_FORMAT = "text";
  const parsed = JSON.parse(captured.trim());
  assert.equal(parsed.sub, "planner");
  assert.equal(parsed.entries, 3);
});

test("notifier rate-limits repeated warnings", async () => {
  const sent = [];
  const n = createNotifier(async (msg, sev) => sent.push({ msg, sev }), { minIntervalWarnMs: 1000 });
  await n.warn("same warning");
  const r2 = await n.warn("same warning"); // suppressed
  assert.equal(sent.length, 1);
  assert.equal(r2.suppressed, true);
});

test("notifier allows critical through always", async () => {
  const sent = [];
  const n = createNotifier(async (msg, sev) => sent.push({ msg, sev }));
  await n.critical("halt!");
  await n.critical("halt!"); // not suppressed
  assert.equal(sent.length, 2);
  assert.ok(sent.every((s) => s.sev === "critical"));
});

test("notifier dedupes by message prefix not full text", async () => {
  const sent = [];
  const n = createNotifier(async (msg) => sent.push(msg), { minIntervalWarnMs: 60000 });
  await n.warn("ORDER_BLOCKED 005930 reason A");
  await n.warn("ORDER_BLOCKED 005930 reason B"); // same 40-char prefix -> suppressed
  assert.equal(sent.length, 1);
});

test("notifier reset clears rate limits", async () => {
  const sent = [];
  const n = createNotifier(async (msg) => sent.push(msg), { minIntervalWarnMs: 60000 });
  await n.warn("test");
  n.resetLimits();
  await n.warn("test");
  assert.equal(sent.length, 2);
});
