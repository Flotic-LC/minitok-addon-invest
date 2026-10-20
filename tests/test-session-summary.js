"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { formatSessionSummary } = require("../src/core/session-summary");

const session = {
  market: "US",
  openAt: new Date("2026-10-19T13:30:00Z"),
  closeAt: new Date("2026-10-19T20:00:00Z"),
};

const pnl = {
  totalTrades: 2,
  buys: 1,
  sells: 1,
  realizedPnl: 12345,
  commissionPaid: 890,
  taxPaid: 0,
  wins: 1,
  losses: 0,
  winRate: "100.0",
  profitFactor: "2.50",
  closedTrades: [{ symbol: "MSFT", qty: 5, price: 534.2, netPnl: 12345, pnlPct: "1.20%" }],
  openPositions: [{ symbol: "AAPL", qty: 3, entryPrice: 263.1 }],
  suspiciousCount: 0,
  correctionCount: 0,
};

const health = {
  selfAudit: { equityKrw: 74570349, executionErrorsLastHour: 0, authFailuresLastHour: 0 },
  ai: { successes: 4144, failures: 19 },
  limits: { phaseName: "production", halted: false },
};

test("session-summary: renders the session window in KST", () => {
  const out = formatSessionSummary({ session, pnl, health });
  assert.ok(out.includes("US 마감 후"), "expected the market label");
  assert.ok(out.includes("10-19 22:30 ~ 10-20 05:00 KST"), "expected the KST window, got: " + out);
});

test("session-summary: renders trade counts, P&L, win rate and profit factor", () => {
  const out = formatSessionSummary({ session, pnl, health });
  assert.ok(out.includes("거래 2건 (매수 1 / 매도 1)"), out);
  assert.ok(out.includes("실현손익 ₩12,345"), out);
  assert.ok(out.includes("수수료 ₩890"), out);
  assert.ok(out.includes("승률 100.0% (1승 0패)"), out);
  assert.ok(out.includes("PF 2.50"), out);
});

test("session-summary: lists closed and open positions", () => {
  const out = formatSessionSummary({ session, pnl, health });
  assert.ok(out.includes("청산 1건 · 미결 1건"), out);
  assert.ok(out.includes("MSFT 5@534.2"), out);
  assert.ok(out.includes("AAPL 3@263.1"), out);
});

test("session-summary: output carries no Telegram Markdown entity markers", () => {
  // The report is delivered as plain text; a stray _ * ` would make Telegram's
  // legacy Markdown parser reject the whole message with HTTP 400.
  const out = formatSessionSummary({ session, pnl, health });
  for (const marker of ["*", "_", "`"]) {
    assert.strictEqual(out.split(marker).length - 1, 0, "unexpected " + marker + " in: " + out);
  }
});

test("session-summary: renders equity, phase and error counters", () => {
  const out = formatSessionSummary({ session, pnl, health });
  assert.ok(out.includes("자기자본 ₩74,570,349"), out);
  assert.ok(out.includes("Phase production · Halted false"), out);
  assert.ok(out.includes("실행오류(1h) 0"), out);
  assert.ok(out.includes("AI 4144/19"), out);
});

test("session-summary: a halted engine is flagged", () => {
  const out = formatSessionSummary({
    session, pnl,
    health: { selfAudit: {}, ai: {}, limits: { phaseName: "recovery", halted: true } },
  });
  assert.ok(out.includes("Halted 🚨 HALTED"), out);
});

test("session-summary: a day without trades still renders", () => {
  const out = formatSessionSummary({
    session,
    pnl: { totalTrades: 0, buys: 0, sells: 0, realizedPnl: 0, commissionPaid: 0, taxPaid: 0,
           wins: 0, losses: 0, winRate: "0.0", profitFactor: "0", closedTrades: [], openPositions: [],
           suspiciousCount: 0, correctionCount: 0 },
    health,
  });
  assert.ok(out.includes("거래 0건"), out);
  assert.ok(out.includes("청산 0건 · 미결 0건"), out);
  assert.ok(out.includes("실현손익 ₩0"), out);
});

test("session-summary: suspicious fills are called out", () => {
  const out = formatSessionSummary({
    session, pnl: Object.assign({}, pnl, { suspiciousCount: 2 }), health,
  });
  assert.ok(out.includes("의심 거래 2건"), out);
});
