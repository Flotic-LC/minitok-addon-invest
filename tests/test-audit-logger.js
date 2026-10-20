"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAuditLogger } = require("../src/core/audit-logger");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "audit-test-"));
}

function readAllLines(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  const out = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean);
    out.push(...lines.map((l) => ({ file: f, rec: JSON.parse(l) })));
  }
  return out;
}

test("audit logger writes JSONL with sequence numbers", (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const audit = createAuditLogger({ dir });
  audit.order({ symbol: "005930", side: "BUY", quantity: 5, price: 71000, orderId: "abc" });
  audit.decision({ symbol: "005930", action: "BUY", score: 3, source: "ai" });
  audit.halt({ reason: "daily_hard_stop", phase: 1 });
  audit.close();
  const lines = readAllLines(dir);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].rec.type, "order");
  assert.equal(lines[0].rec.seq, 1);
  assert.equal(lines[0].rec.symbol, "005930");
  assert.equal(lines[0].rec.qty, 5);
  assert.equal(lines[1].rec.type, "decision");
  assert.equal(lines[1].rec.seq, 2);
  assert.equal(lines[2].rec.type, "halt");
  assert.equal(lines[2].rec.reason, "daily_hard_stop");
  assert.ok(lines[0].rec.ts && lines[0].rec.v === 1);
});

test("audit logger rotates by UTC date", (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let fake = new Date("2026-01-15T12:00:00Z");
  const audit = createAuditLogger({ dir, now: () => fake });
  audit.order({ symbol: "A", side: "BUY", qty: 1, price: 1 });
  fake = new Date("2026-01-16T01:00:00Z"); // next UTC day
  audit.order({ symbol: "B", side: "BUY", qty: 1, price: 1 });
  audit.close();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  assert.equal(files.length, 2);
  assert.ok(files.includes("audit-2026-01-15.jsonl"));
  assert.ok(files.includes("audit-2026-01-16.jsonl"));
});

test("disabled logger writes nothing", (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const audit = createAuditLogger({ dir, enabled: false });
  audit.order({ symbol: "X", side: "BUY", qty: 1, price: 1 });
  audit.close();
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 0);
});

test("stats() tracks seq and dropped count", (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const audit = createAuditLogger({ dir });
  for (let i = 0; i < 5; i++) audit.signal({ symbol: "X", action: "HOLD", score: 0 });
  assert.equal(audit.stats().seq, 5);
  assert.equal(audit.stats().dropped, 0);
  audit.close();
});

test("oversized payloads are truncated, not dropped", (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const audit = createAuditLogger({ dir });
  const huge = "x".repeat(10000);
  audit.error({ source: "test", message: huge });
  audit.close();
  const lines = readAllLines(dir);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].rec._truncated, true);
  assert.ok(lines[0].rec.message.length < 10000);
});
