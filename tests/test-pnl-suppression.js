"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");

const MINITOK_ROOT = process.env.MINITOK_CLIENT_ROOT
  || path.join(__dirname, "..", "..", "minitok-client-release");

const { createStore } = require("../src/store");
const { createPerformanceMonitor } = require("../src/agent/performance-monitor");
const { createAttributionEngine } = require("../src/intelligence/attribution");

function tmpStorePath() {
  return path.join(os.tmpdir(), `toss-suppression-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
}

// ---------------------------------------------------------------------------
// [P10-2] P&L suppression scenario tests
// When a SELL fill has no entry price, P&L is suppressed (pnl=null).
// The trade should still be recorded across all consumers as a suppressed trade.
// ---------------------------------------------------------------------------

test("event-store records PNL_SUPPRESSED events with metadata", () => {
  const dir = tmpStorePath();
  const store = createStore({ dir, statePath: dir + ".json" });
  store.append("PNL_SUPPRESSED", {
    symbol: "SPY",
    reason: "no_entry_price",
    fillPrice: 550,
    orderPrice: 548,
    quantity: 10,
    strategy: "max_profit",
    decisionSource: "ai",
    suppressed: true,
  });
  const events = store.query({ types: ["PNL_SUPPRESSED"] });
  assert.equal(events.length, 1, "should have 1 PNL_SUPPRESSED event");
  assert.equal(events[0].symbol, "SPY");
  assert.equal(events[0].suppressed, true);
  assert.equal(events[0].strategy, "max_profit");
  assert.equal(events[0].type, "PNL_SUPPRESSED");
});

test("performance-monitor records suppressed trades with pnl=0 and suppressed=true", () => {
  const mon = createPerformanceMonitor();
  mon.recordTrade({ symbol: "QQQ", side: "SELL", pnl: 0, suppressed: true });
  mon.recordTrade({ symbol: "AAPL", side: "SELL", pnl: 5000, suppressed: false });
  const report = mon.report();
  assert.equal(report.totalTrades, 2, "should count both trades");
  assert.equal(report.suppressedTrades, 1, "should count suppressed trades");
});

test("attribution engine records FILL event with null pnl for suppressed trades", () => {
  const eng = createAttributionEngine();
  eng.recordFill({
    symbol: "BRK.B",
    strategy: "base_signals",
    source: "ai",
    metaCogIntervened: false,
    pnl: null,
  });
  const rep = eng.report();
  const brk = rep.bySymbol["BRK.B"];
  assert.ok(brk, "should have BRK.B entry");
  assert.equal(brk.count, 1, "should have 1 fill");
  assert.equal(brk.pnl, 0, "pnl should be 0 (null coerced to 0 for aggregation)");
  assert.equal(brk.wins, 0, "no wins");
  assert.equal(brk.losses, 0, "no losses");
});

test("suppressed and non-suppressed trades have same count in attribution", () => {
  const eng = createAttributionEngine();
  eng.recordFill({ symbol: "SPY", strategy: "base_signals", source: "ai", metaCogIntervened: false, pnl: null });
  eng.recordFill({ symbol: "SPY", strategy: "base_signals", source: "ai", metaCogIntervened: false, pnl: 9503.42 });
  const rep = eng.report();
  assert.equal(rep.totalFills, 2, "should have 2 fills total");
  assert.equal(rep.bySymbol["SPY"].count, 2);
});
