"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createTradingMemory } = require("../src/memory/trading-memory");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "trading-memory-test-"));
}

test("createTradingMemory initializes with empty entries", () => {
  const dir = makeTempDir();
  const mem = createTradingMemory({ dir });
  const s = mem.stats();
  assert.equal(s.totalEntries, 0);
  assert.equal(s.uniqueSymbols, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("recordDecision stores entry and returns id", () => {
  const dir = makeTempDir();
  const mem = createTradingMemory({ dir });
  const id = mem.recordDecision({
    symbol: "005930", action: "BUY", reason: "RSI oversold",
    price: 72000, regime: "expansion",
    technicals: { rsi14: 28, macd: { histogram: 0.5 } },
  });
  assert.ok(id);
  assert.ok(id.startsWith("mem-"));
  assert.equal(mem.stats().totalEntries, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("recordDecision normalizes symbol to uppercase", () => {
  const dir = makeTempDir();
  const mem = createTradingMemory({ dir });
  mem.recordDecision({ symbol: "aapl", action: "BUY" });
  const entries = mem.getBySymbol("aapl");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].symbol, "AAPL");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("recallSimilar returns entries sorted by score", () => {
  const dir = makeTempDir();
  const mem = createTradingMemory({ dir });
  mem.recordDecision({ symbol: "005930", action: "BUY", regime: "expansion", technicals: { rsi14: 30, macd: { histogram: 0.3 } }, price: 70000 });
  mem.recordDecision({ symbol: "005930", action: "SELL", regime: "crisis", technicals: { rsi14: 75, macd: { histogram: -1.2 } }, price: 80000 });
  mem.recordDecision({ symbol: "AAPL", action: "BUY", regime: "expansion", technicals: { rsi14: 29, macd: { histogram: 0.4 } }, price: 180 });
  const similar = mem.recallSimilar({
    symbol: "005930", rsi14: 28, macd: { histogram: 0.5 }, regime: "expansion", lastClose: 71000,
  }, 5);
  assert.ok(similar.length >= 1);
  assert.equal(similar[0].symbol, "005930");
  assert.equal(similar[0].regime, "expansion");
  assert.ok(similar[0].similarityScore >= 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("recallSimilar returns empty for no match", () => {
  const dir = makeTempDir();
  const mem = createTradingMemory({ dir });
  mem.recordDecision({ symbol: "005930", action: "BUY", regime: "expansion" });
  const similar = mem.recallSimilar({ symbol: "XXXXXX", rsi14: 50, regime: "crisis" }, 5);
  assert.equal(similar.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("updateOutcome updates pnl on existing entry", () => {
  const dir = makeTempDir();
  const mem = createTradingMemory({ dir });
  const id = mem.recordDecision({ symbol: "005930", action: "BUY", price: 72000 });
  const ok = mem.updateOutcome(id, { pnl: 15000, outcome: "win" });
  assert.equal(ok, true);
  const stats = mem.getWinLossStats("005930");
  assert.equal(stats.wins, 1);
  assert.equal(stats.totalPnl, 15000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("updateOutcome returns false for nonexistent id", () => {
  const dir = makeTempDir();
  const mem = createTradingMemory({ dir });
  const ok = mem.updateOutcome("nonexistent-id", { pnl: 100 });
  assert.equal(ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("getByRegime filters correctly", () => {
  const dir = makeTempDir();
  const mem = createTradingMemory({ dir });
  mem.recordDecision({ symbol: "A", regime: "crisis" });
  mem.recordDecision({ symbol: "B", regime: "expansion" });
  mem.recordDecision({ symbol: "C", regime: "crisis" });
  const crisis = mem.getByRegime("crisis");
  assert.equal(crisis.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("getWinLossStats computes correct stats", () => {
  const dir = makeTempDir();
  const mem = createTradingMemory({ dir });
  const id1 = mem.recordDecision({ symbol: "AAPL", action: "BUY" });
  const id2 = mem.recordDecision({ symbol: "AAPL", action: "BUY" });
  const id3 = mem.recordDecision({ symbol: "AAPL", action: "BUY" });
  mem.updateOutcome(id1, { pnl: 1000 });
  mem.updateOutcome(id2, { pnl: -500 });
  mem.updateOutcome(id3, { pnl: 2000 });
  const stats = mem.getWinLossStats("AAPL");
  assert.equal(stats.total, 3);
  assert.equal(stats.wins, 2);
  assert.equal(stats.losses, 1);
  assert.ok(Math.abs(stats.winRate - 2/3) < 0.01);
  assert.equal(stats.totalPnl, 2500);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("maxEntries trims old entries", () => {
  const dir = makeTempDir();
  const mem = createTradingMemory({ dir, maxEntries: 3 });
  mem.recordDecision({ symbol: "A" });
  mem.recordDecision({ symbol: "B" });
  mem.recordDecision({ symbol: "C" });
  mem.recordDecision({ symbol: "D" });
  assert.equal(mem.stats().totalEntries, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("clear removes all entries", () => {
  const dir = makeTempDir();
  const mem = createTradingMemory({ dir });
  mem.recordDecision({ symbol: "A" });
  mem.recordDecision({ symbol: "B" });
  assert.equal(mem.stats().totalEntries, 2);
  mem.clear();
  assert.equal(mem.stats().totalEntries, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("data persists across instances", () => {
  const dir = makeTempDir();
  const mem1 = createTradingMemory({ dir });
  mem1.recordDecision({ symbol: "005930", action: "BUY" });
  const mem2 = createTradingMemory({ dir });
  assert.equal(mem2.stats().totalEntries, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("recordDecision returns false for missing symbol", () => {
  const dir = makeTempDir();
  const mem = createTradingMemory({ dir });
  const result = mem.recordDecision({ action: "BUY" });
  assert.equal(result, false);
  assert.equal(mem.stats().totalEntries, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
