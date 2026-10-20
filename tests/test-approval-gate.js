"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApprovalGate } = require("../src/orchestrator/approval-gate");

test("createApprovalGate returns expected API", () => {
  const gate = createApprovalGate();
  assert.equal(typeof gate.request, "function");
  assert.equal(typeof gate.approve, "function");
  assert.equal(typeof gate.reject, "function");
  assert.equal(typeof gate.status, "function");
  assert.equal(typeof gate.getPending, "function");
  assert.equal(typeof gate.getResolved, "function");
  assert.equal(typeof gate.expireStale, "function");
  assert.equal(typeof gate.stats, "function");
  assert.equal(typeof gate.clear, "function");
});

test("request creates pending entry", () => {
  const gate = createApprovalGate();
  const id = gate.request("new_symbol", { symbol: "GOOGL" });
  assert.ok(id.startsWith("approval_"));
  const s = gate.status(id);
  assert.equal(s.status, "pending");
  assert.equal(s.type, "new_symbol");
});

test("approve resolves pending request", () => {
  const gate = createApprovalGate();
  const id = gate.request("large_position", { symbol: "AAPL", pct: 18 });
  const r = gate.approve(id, "admin");
  assert.equal(r.ok, true);
  assert.equal(r.entry.status, "approved");
  assert.equal(r.entry.resolvedBy, "admin");
});

test("reject resolves pending request", () => {
  const gate = createApprovalGate();
  const id = gate.request("new_symbol", { symbol: "TSLA" });
  const r = gate.reject(id, "admin", "too risky");
  assert.equal(r.ok, true);
  assert.equal(r.entry.status, "rejected");
  assert.equal(r.entry.rejectReason, "too risky");
});

test("double approve fails", () => {
  const gate = createApprovalGate();
  const id = gate.request("new_symbol", { symbol: "X" });
  gate.approve(id);
  const r2 = gate.approve(id);
  assert.equal(r2.ok, false);
});

test("approve nonexistent id fails", () => {
  const gate = createApprovalGate();
  const r = gate.approve("fake_id");
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("not found"));
});

test("notify callback fires on request", () => {
  let notified = false;
  const gate = createApprovalGate({ notify: () => { notified = true; } });
  gate.request("new_symbol", { symbol: "Y" });
  assert.ok(notified);
});

test("expireStale removes timed-out requests", () => {
  let t = Date.now();
  const gate = createApprovalGate({ now: () => t });
  const id = gate.request("new_symbol", { symbol: "Z" });
  t += 4000 * 1000; // advance past 3600s timeout
  gate.expireStale();
  const s = gate.status(id);
  assert.equal(s.status, "expired");
});

test("getPending returns only pending", () => {
  const gate = createApprovalGate();
  gate.request("new_symbol", { symbol: "A" });
  const id2 = gate.request("new_symbol", { symbol: "B" });
  gate.approve(id2);
  assert.equal(gate.getPending().length, 1);
});

test("getResolved returns completed", () => {
  const gate = createApprovalGate();
  const id = gate.request("new_symbol", { symbol: "C" });
  gate.reject(id);
  assert.equal(gate.getResolved().length, 1);
  assert.equal(gate.getResolved()[0].status, "rejected");
});

test("stats tracks correctly", () => {
  const gate = createApprovalGate();
  const id1 = gate.request("new_symbol", { symbol: "D" });
  const id2 = gate.request("new_symbol", { symbol: "E" });
  gate.approve(id1);
  gate.reject(id2);
  const s = gate.stats();
  assert.equal(s.pending, 0);
  assert.equal(s.approved, 1);
  assert.equal(s.rejected, 1);
});

test("clear resets state", () => {
  const gate = createApprovalGate();
  gate.request("new_symbol", { symbol: "F" });
  gate.clear();
  assert.equal(gate.getPending().length, 0);
  assert.equal(gate.getResolved().length, 0);
});

test("approve expired request fails", () => {
  let t = Date.now();
  const gate = createApprovalGate({ now: () => t });
  const id = gate.request("new_symbol", { symbol: "G" });
  t += 4000 * 1000; // past timeout
  const r = gate.approve(id);
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("expired"));
});
