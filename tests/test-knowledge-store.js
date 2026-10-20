"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createKnowledgeStore } = require("../src/strategy/knowledge-store");

function tmpPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ks-test-")), "knowledge.json");
}

test("empty store returns zero lookups", () => {
  const ks = createKnowledgeStore({ path: tmpPath() });
  const r = ks.lookup("005930");
  assert.equal(r.trades, 0);
  assert.equal(r.winRate, 0);
});

test("recordOutcome persists and increments counters", () => {
  const p = tmpPath();
  const ks = createKnowledgeStore({ path: p });
  ks.recordOutcome({ symbol: "005930", action: "BUY", strategy: "momentum", pnl: 5000 });
  ks.recordOutcome({ symbol: "005930", action: "BUY", strategy: "momentum", pnl: -2000 });
  const r = ks.lookup("005930");
  assert.equal(r.trades, 2);
  assert.equal(r.wins, 1);
  assert.equal(r.losses, 1);
  assert.equal(r.totalPnl, 3000);
  assert.ok(fs.existsSync(p));
});

test("strategy-level lookup tracks per-strategy stats", () => {
  const ks = createKnowledgeStore({ path: tmpPath() });
  ks.recordOutcome({ symbol: "AAPL", strategy: "momentum", pnl: 1000 });
  ks.recordOutcome({ symbol: "AAPL", strategy: "momentum", pnl: 1500 });
  ks.recordOutcome({ symbol: "AAPL", strategy: "mean_reversion", pnl: -500 });
  const mom = ks.lookup("AAPL", "momentum");
  const mr = ks.lookup("AAPL", "mean_reversion");
  assert.equal(mom.trades, 2);
  assert.equal(mom.winRate, 1);
  assert.equal(mr.trades, 1);
  assert.equal(mr.losses, 1);
});

test("adjustScore returns unadjusted score with insufficient history", () => {
  const ks = createKnowledgeStore({ path: tmpPath() });
  ks.recordOutcome({ symbol: "X", strategy: "s", pnl: 100 });
  const r = ks.adjustScore(3, "X", "s");
  assert.equal(r.score, 3);
  assert.equal(r.adjustment, 0);
  assert.match(r.reason, /insufficient history/);
});

test("adjustScore gives bonus for high win rate", () => {
  const ks = createKnowledgeStore({ path: tmpPath() });
  // 4 wins, 1 loss = 80%
  for (let i = 0; i < 4; i++) ks.recordOutcome({ symbol: "Y", strategy: "s", pnl: 1000 });
  ks.recordOutcome({ symbol: "Y", strategy: "s", pnl: -500 });
  const r = ks.adjustScore(3, "Y", "s");
  assert.ok(r.score > 3, `expected bonus, got adjustment ${r.adjustment}`);
  assert.match(r.reason, /high win rate/);
});

test("adjustScore gives penalty for low win rate", () => {
  const ks = createKnowledgeStore({ path: tmpPath() });
  // 1 win, 4 losses = 20%
  ks.recordOutcome({ symbol: "Z", strategy: "s", pnl: 1000 });
  for (let i = 0; i < 4; i++) ks.recordOutcome({ symbol: "Z", strategy: "s", pnl: -500 });
  const r = ks.adjustScore(3, "Z", "s");
  assert.ok(r.score < 3, `expected penalty, got adjustment ${r.adjustment}`);
});

test("adjustScore strongly penalizes negative expected value", () => {
  const ks = createKnowledgeStore({ path: tmpPath() });
  // Even win rate but avg loss bigger than avg win → negative EV
  ks.recordOutcome({ symbol: "N", strategy: "s", pnl: 100 });
  ks.recordOutcome({ symbol: "N", strategy: "s", pnl: 100 });
  ks.recordOutcome({ symbol: "N", strategy: "s", pnl: -500 });
  const r = ks.adjustScore(3, "N", "s");
  assert.ok(r.adjustment <= -2, `expected strong penalty, got ${r.adjustment}`);
});

test("stats reports totals", () => {
  const ks = createKnowledgeStore({ path: tmpPath() });
  ks.recordOutcome({ symbol: "A", strategy: "s1", pnl: 100 });
  ks.recordOutcome({ symbol: "B", strategy: "s2", pnl: 200 });
  const s = ks.stats();
  assert.equal(s.totalOutcomes, 2);
  assert.equal(s.uniqueSymbols, 2);
  assert.equal(s.uniqueStrategies, 2);
});

test("reset clears all data and persists", () => {
  const p = tmpPath();
  const ks = createKnowledgeStore({ path: p });
  ks.recordOutcome({ symbol: "X", pnl: 100 });
  ks.reset();
  const s = ks.stats();
  assert.equal(s.totalOutcomes, 0);
  assert.equal(s.uniqueSymbols, 0);
});

test("maxHistory caps stored outcomes", () => {
  const ks = createKnowledgeStore({ path: tmpPath(), maxHistory: 5 });
  for (let i = 0; i < 20; i++) ks.recordOutcome({ symbol: "X", pnl: i });
  assert.equal(ks.stats().totalOutcomes, 5);
});

test("symbol normalization is case-insensitive", () => {
  const ks = createKnowledgeStore({ path: tmpPath() });
  ks.recordOutcome({ symbol: "aapl", pnl: 100 });
  const r = ks.lookup("AAPL");
  assert.equal(r.trades, 1);
});
