"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createCouncil } = require("../src/council/council");

test("HOLD decisions bypass council and return consensus 1.0", async () => {
  const council = createCouncil();
  const r = await council.evaluate({ action: "HOLD", symbol: "X" }, {});
  assert.equal(r.action, "HOLD");
  assert.equal(r.consensus, 1.0);
  assert.equal(r.votes.length, 0);
});

test("null decision returns HOLD", async () => {
  const council = createCouncil();
  const r = await council.evaluate(null, {});
  assert.equal(r.action, "HOLD");
});

test("strong BUY signal with good technicals is approved", async () => {
  const council = createCouncil();
  const decision = {
    action: "BUY", symbol: "AAPL", price: 180, quantity: 10,
    reason: "RSI oversold at 25 with MACD crossover and strong earnings catalyst expected",
  };
  const ctx = {
    totalEquity: 100000000,
    technicals: { rsi14: 28, macd: { histogram: 0.5 }, bollinger: { upper: 200, lower: 170 }, lastClose: 180 },
    regime: "expansion",
    intelligence: { vix: 15 },
    similarExperiences: [{ pnl: 5000 }, { pnl: 3000 }, { pnl: -500 }],
  };
  const r = await council.evaluate(decision, ctx);
  assert.equal(r.approved, true);
  assert.equal(r.action, "BUY");
  assert.ok(r.consensus >= 0.6);
  assert.equal(r.votes.length, 3);
});

test("BUY at overbought RSI in crisis regime is rejected", async () => {
  const council = createCouncil();
  const decision = {
    action: "BUY", symbol: "TSLA", price: 300, quantity: 50,
    reason: "momentum play",
  };
  const ctx = {
    totalEquity: 10000000,
    technicals: { rsi14: 78, macd: { histogram: -1.2 }, bollinger: { upper: 290 }, lastClose: 300 },
    regime: "crisis",
    intelligence: { vix: 45 },
    currentExposurePct: 80,
    similarExperiences: [{ pnl: -2000 }, { pnl: -1500 }, { pnl: -3000 }],
  };
  const r = await council.evaluate(decision, ctx);
  assert.equal(r.approved, false);
  assert.equal(r.action, "HOLD");
  assert.ok(r.issues.length > 0);
});

test("oversized position is rejected by risk manager", async () => {
  const council = createCouncil({ maxPositionPct: 10 });
  const decision = {
    action: "BUY", symbol: "NVDA", price: 500, quantity: 5000,
    reason: "AI sector momentum with strong earnings growth trajectory and institutional inflows",
  };
  const ctx = {
    totalEquity: 10000000,
    technicals: { rsi14: 55, macd: { histogram: 0.3 }, lastClose: 500 },
    regime: "neutral",
    intelligence: { vix: 18 },
  };
  const r = await council.evaluate(decision, ctx);
  const riskVote = r.votes.find(v => v.role === "risk_manager");
  assert.ok(riskVote);
  assert.ok(riskVote.issues.some(i => i.includes("exceeds max")));
});

test("SELL at oversold RSI is flagged by strategist", async () => {
  const council = createCouncil();
  const decision = {
    action: "SELL", symbol: "AAPL", price: 150, quantity: 10,
    reason: "Taking profits after extended run-up in tech sector rotation",
  };
  const ctx = {
    totalEquity: 100000000,
    technicals: { rsi14: 22, macd: { histogram: 0.5 }, lastClose: 150 },
    regime: "expansion",
    intelligence: { vix: 14 },
  };
  const r = await council.evaluate(decision, ctx);
  const strat = r.votes.find(v => v.role === "strategist");
  assert.ok(strat.issues.some(i => i.includes("oversold")));
});

test("critic penalizes short/missing reason", async () => {
  const council = createCouncil();
  const decision = { action: "BUY", symbol: "X", price: 100, quantity: 10, reason: "short" };
  const ctx = { totalEquity: 1e9, technicals: { rsi14: 50 }, regime: "neutral", intelligence: { vix: 15 } };
  const r = await council.evaluate(decision, ctx);
  const critic = r.votes.find(v => v.role === "critic");
  assert.ok(critic.issues.some(i => i.includes("Insufficient justification")));
});

test("arbiter override can flip marginal rejection", async () => {
  let llmCalled = false;
  const callLLM = async (msgs) => {
    llmCalled = true;
    return { verdict: "APPROVE", reason: "Arbiter sees positive EV despite concerns" };
  };
  const council = createCouncil({ callLLM, consensusThreshold: 0.65 });
  const decision = {
    action: "BUY", symbol: "X", price: 100, quantity: 10,
    reason: "Mixed signals but positive expected value setup based on macro catalyst",
  };
  const ctx = {
    totalEquity: 1e9,
    technicals: { rsi14: 72, macd: { histogram: -0.2 }, bollinger: { upper: 105 }, lastClose: 100 },
    regime: "neutral",
    intelligence: { vix: 18 },
    similarExperiences: [{ pnl: -100 }, { pnl: 200 }],
  };
  const r = await council.evaluate(decision, ctx);
  assert.ok(typeof r.approved === "boolean");
  if (llmCalled) {
    assert.ok(r.arbiterNote);
  }
});

test("arbiter failure does not throw", async () => {
  const callLLM = async () => { throw new Error("LLM down"); };
  const council = createCouncil({ callLLM, consensusThreshold: 0.6 });
  const decision = {
    action: "BUY", symbol: "X", price: 100, quantity: 10,
    reason: "Mixed setup with reasonable risk/reward profile in current market conditions",
  };
  const ctx = {
    totalEquity: 1e9,
    technicals: { rsi14: 68, macd: { histogram: -0.1 }, lastClose: 100 },
    regime: "neutral",
    intelligence: { vix: 18 },
  };
  const r = await council.evaluate(decision, ctx);
  assert.ok(r);
  assert.ok(typeof r.approved === "boolean");
});

test("stats tracks evaluations correctly", async () => {
  const council = createCouncil();
  const goodCtx = {
    totalEquity: 1e9,
    technicals: { rsi14: 30, macd: { histogram: 0.5 }, bollinger: { upper: 200 }, lastClose: 100 },
    regime: "expansion",
    intelligence: { vix: 12 },
    similarExperiences: [{ pnl: 1000 }, { pnl: 500 }],
  };
  const decision = { action: "BUY", symbol: "X", price: 100, quantity: 10, reason: "Oversold with positive MACD crossover" };
  await council.evaluate(decision, goodCtx);
  await council.evaluate({ action: "HOLD" }, {});
  await council.evaluate(decision, goodCtx);
  const s = council.stats();
  assert.ok(s.totalEvaluations >= 2);
  assert.ok(typeof s.approvals === "number");
  assert.ok(typeof s.rejections === "number");
  assert.equal(s.consensusThreshold, 0.6);
});

test("clearHistory resets stats", async () => {
  const council = createCouncil();
  await council.evaluate({ action: "BUY", symbol: "X", price: 100, quantity: 1, reason: "test reason long enough" }, { totalEquity: 1e9, regime: "neutral", intelligence: { vix: 15 } });
  council.clearHistory();
  assert.equal(council.stats().totalEvaluations, 0);
});

test("DEFAULTS export is frozen", () => {
  const { DEFAULTS } = require("../src/council/council");
  assert.ok(Object.isFrozen(DEFAULTS));
  assert.equal(DEFAULTS.consensusThreshold, 0.6);
  assert.equal(DEFAULTS.defaultOnDisagreement, "HOLD");
});

test("VIX > crisis threshold heavily penalizes BUY", async () => {
  const council = createCouncil({ vixCrisisThreshold: 40 });
  const decision = {
    action: "BUY", symbol: "X", price: 100, quantity: 10,
    reason: "Attempting to catch falling knife during panic selling",
  };
  const ctx = {
    totalEquity: 1e9,
    technicals: { rsi14: 50, macd: { histogram: 0 }, lastClose: 100 },
    regime: "neutral",
    intelligence: { vix: 50 },
  };
  const r = await council.evaluate(decision, ctx);
  const risk = r.votes.find(v => v.role === "risk_manager");
  assert.ok(risk.issues.some(i => i.includes("VIX")));
});

test("max open positions reached blocks new BUY", async () => {
  // [2026-10-21] The position limit is max_open_positions, not
  // max_daily_trades — the risk manager used to compare the open-position
  // count against the daily-trade cap.
  const council = createCouncil({ maxOpenPositions: 5 });
  const decision = {
    action: "BUY", symbol: "NEW", price: 100, quantity: 10,
    reason: "Expanding portfolio with new uncorrelated position for diversification",
  };
  const ctx = {
    totalEquity: 1e9,
    technicals: { rsi14: 50, macd: { histogram: 0.2 }, lastClose: 100 },
    regime: "neutral",
    intelligence: { vix: 15 },
    openPositions: 10,
  };
  const r = await council.evaluate(decision, ctx);
  const risk = r.votes.find(v => v.role === "risk_manager");
  assert.ok(risk.issues.some(i => i.includes("Max positions")));
});

test("open positions below the limit do not block a BUY", async () => {
  const council = createCouncil({ maxOpenPositions: 15 });
  const decision = {
    action: "BUY", symbol: "NEW", price: 100, quantity: 10,
    reason: "Expanding portfolio with new uncorrelated position for diversification",
  };
  const ctx = {
    totalEquity: 1e9,
    technicals: { rsi14: 50, macd: { histogram: 0.2 }, lastClose: 100 },
    regime: "neutral",
    intelligence: { vix: 15 },
    openPositions: 4,
  };
  const r = await council.evaluate(decision, ctx);
  const risk = r.votes.find(v => v.role === "risk_manager");
  assert.ok(!risk.issues.some(i => i.includes("Max positions")));
});

// ---------------------------------------------------------------------------
// Constitution Hard Limits (P1-5) — inviolable pre-vote gate
// ---------------------------------------------------------------------------

test("constitution: position exceeding maxSinglePositionPct is rejected before voting", async () => {
  const council = createCouncil({ constitutionHardLimits: { maxSinglePositionPct: 10 } });
  const decision = {
    action: "BUY", symbol: "AAPL", price: 200, quantity: 10000,
    reason: "Strong earnings catalyst with positive momentum and institutional inflows",
  };
  const ctx = {
    totalEquity: 10000000, // 200*10000=2M=20% > 10%
    technicals: { rsi14: 30, macd: { histogram: 0.5 }, lastClose: 200 },
    regime: "expansion", intelligence: { vix: 15 },
  };
  const r = await council.evaluate(decision, ctx);
  assert.equal(r.approved, false);
  assert.equal(r.constitutionViolation, true);
  assert.equal(r.consensus, 0);
  assert.equal(r.votes.length, 0);
  assert.ok(r.issues.some(i => i.includes("CONSTITUTION") && i.includes("Position")));
});

test("constitution: projected exposure exceeding maxTotalExposurePct blocks BUY", async () => {
  const council = createCouncil({ constitutionHardLimits: { maxTotalExposurePct: 85 } });
  const decision = {
    action: "BUY", symbol: "MSFT", price: 400, quantity: 500,
    reason: "Cloud growth accelerating with strong enterprise pipeline and AI integration",
  };
  const ctx = {
    totalEquity: 10000000, currentExposurePct: 80,
    technicals: { rsi14: 50, macd: { histogram: 0.2 }, lastClose: 400 },
    regime: "neutral", intelligence: { vix: 18 },
  };
  const r1 = await council.evaluate(decision, ctx);
  assert.equal(r1.constitutionViolation, undefined);
  const ctx2 = { ...ctx, currentExposurePct: 84 };
  const r2 = await council.evaluate(decision, ctx2);
  assert.equal(r2.approved, false);
  assert.equal(r2.constitutionViolation, true);
  assert.ok(r2.issues.some(i => i.includes("Projected exposure")));
});

test("constitution: maxOpenPositions blocks new BUY at limit", async () => {
  const council = createCouncil({ constitutionHardLimits: { maxOpenPositions: 5 } });
  const decision = {
    action: "BUY", symbol: "NEW", price: 100, quantity: 10,
    reason: "Adding uncorrelated position for portfolio diversification benefit",
  };
  const ctx = {
    totalEquity: 1e9, openPositions: 5, technicals: { rsi14: 45 },
    regime: "neutral", intelligence: { vix: 15 },
  };
  const r = await council.evaluate(decision, ctx);
  assert.equal(r.approved, false);
  assert.equal(r.constitutionViolation, true);
  assert.ok(r.issues.some(i => i.includes("Open positions")));
});

test("constitution: SELL is not blocked by maxOpenPositions", async () => {
  const council = createCouncil({ constitutionHardLimits: { maxOpenPositions: 5 } });
  const decision = {
    action: "SELL", symbol: "OLD", price: 100, quantity: 10,
    reason: "Taking profits after target reached and rotating to better opportunities",
  };
  const ctx = {
    totalEquity: 1e9, openPositions: 5, technicals: { rsi14: 70 },
    regime: "neutral", intelligence: { vix: 15 },
  };
  const r = await council.evaluate(decision, ctx);
  assert.equal(r.constitutionViolation, undefined);
});

test("constitution: HOLD bypasses hard limits check", async () => {
  const council = createCouncil({ constitutionHardLimits: { maxSinglePositionPct: 1, maxOpenPositions: 1 } });
  const r = await council.evaluate({ action: "HOLD", symbol: "X" }, { totalEquity: 1e9, openPositions: 100 });
  assert.equal(r.action, "HOLD");
  assert.equal(r.consensus, 1.0);
  assert.equal(r.constitutionViolation, undefined);
});

test("constitution: null decision bypasses hard limits", async () => {
  const council = createCouncil({ constitutionHardLimits: { maxOpenPositions: 1 } });
  const r = await council.evaluate(null, { openPositions: 100 });
  assert.equal(r.action, "HOLD");
});

test("constitution: no limits configured means no hard limit checks", async () => {
  const council = createCouncil();
  const decision = {
    action: "BUY", symbol: "X", price: 200, quantity: 100000,
    reason: "Large position with strong conviction based on fundamental analysis",
  };
  const ctx = {
    totalEquity: 1000000, technicals: { rsi14: 30, macd: { histogram: 0.5 } },
    regime: "expansion", intelligence: { vix: 12 }, openPositions: 100, dailyTradeCount: 999,
  };
  const r = await council.evaluate(decision, ctx);
  assert.equal(r.constitutionViolation, undefined);
});

test("constitution: multiple violations are all reported", async () => {
  const council = createCouncil({
    constitutionHardLimits: { maxSinglePositionPct: 10, maxOpenPositions: 5, maxDailyTrades: 50, maxSingleOrderKrw: 1000 },
  });
  const decision = { action: "BUY", symbol: "X", price: 100, quantity: 100, reason: "Testing multiple simultaneous violations" };
  const ctx = {
    totalEquity: 1000, openPositions: 10, dailyTradeCount: 60, technicals: { rsi14: 50 },
    regime: "neutral", intelligence: { vix: 15 },
  };
  const r = await council.evaluate(decision, ctx);
  assert.equal(r.approved, false);
  assert.equal(r.constitutionViolation, true);
  assert.ok(r.issues.length >= 3, "Expected >=3 violations, got " + r.issues.length);
});

test("constitution: hard limit rejection is recorded in stats", async () => {
  const council = createCouncil({ constitutionHardLimits: { maxOpenPositions: 1 } });
  await council.evaluate(
    { action: "BUY", symbol: "X", price: 100, quantity: 10, reason: "test reason for constitution check" },
    { totalEquity: 1e9, openPositions: 5, technicals: { rsi14: 50 }, regime: "neutral", intelligence: { vix: 15 } },
  );
  const s = council.stats();
  assert.equal(s.totalEvaluations, 1);
  assert.equal(s.rejections, 1);
  assert.equal(s.approvals, 0);
});

test("constitution: arbiter cannot override hard limits", async () => {
  let llmCalled = false;
  const callLLM = async () => { llmCalled = true; return { verdict: "APPROVE", reason: "nope" }; };
  const council = createCouncil({ callLLM, constitutionHardLimits: { maxOpenPositions: 1 } });
  const r = await council.evaluate(
    { action: "BUY", symbol: "X", price: 100, quantity: 10, reason: "test arbiter vs constitution hard limits" },
    { totalEquity: 1e9, openPositions: 5, technicals: { rsi14: 50 }, regime: "neutral", intelligence: { vix: 15 } },
  );
  assert.equal(r.approved, false);
  assert.equal(r.constitutionViolation, true);
  assert.equal(llmCalled, false);
});

test("constitution: cash reserve below minimum blocks BUY", async () => {
  const council = createCouncil({ constitutionHardLimits: { minCashReservePct: 15 } });
  const decision = {
    action: "BUY", symbol: "X", price: 100, quantity: 10,
    reason: "Positive setup with strong risk/reward profile in current market",
  };
  const ctx = {
    totalEquity: 1e9, cashReservePct: 10,
    technicals: { rsi14: 35, macd: { histogram: 0.3 } },
    regime: "expansion", intelligence: { vix: 12 },
  };
  const r = await council.evaluate(decision, ctx);
  assert.equal(r.approved, false);
  assert.equal(r.constitutionViolation, true);
  assert.ok(r.issues.some(i => i.includes("Cash reserve")));
});

test("constitution: maxSingleOrderKrw blocks oversized orders", async () => {
  const council = createCouncil({ constitutionHardLimits: { maxSingleOrderKrw: 50000000 } });
  const decision = {
    action: "BUY", symbol: "KR", price: 100000, quantity: 1000,
    reason: "Korean market opportunity with strong fundamental catalyst expected",
  };
  const ctx = {
    totalEquity: 10e9, technicals: { rsi14: 40 },
    regime: "neutral", intelligence: { vix: 15 },
  };
  const r = await council.evaluate(decision, ctx);
  assert.equal(r.approved, false);
  assert.equal(r.constitutionViolation, true);
  assert.ok(r.issues.some(i => i.includes("KRW") && i.includes("exceeds")));
});

test("constitution: maxDailyTrades blocks when daily count at limit", async () => {
  const council = createCouncil({ constitutionHardLimits: { maxDailyTrades: 50 } });
  const decision = {
    action: "BUY", symbol: "X", price: 100, quantity: 10,
    reason: "Additional trade opportunity with positive expected value setup",
  };
  const ctx = {
    totalEquity: 1e9, dailyTradeCount: 50, technicals: { rsi14: 40 },
    regime: "neutral", intelligence: { vix: 15 },
  };
  const r = await council.evaluate(decision, ctx);
  assert.equal(r.approved, false);
  assert.equal(r.constitutionViolation, true);
  assert.ok(r.issues.some(i => i.includes("Daily trades")));
});

test("constitution: maxPairwiseCorrelation blocks BUY when portfolio too correlated", async () => {
  const council = createCouncil({ constitutionHardLimits: { maxPairwiseCorrelation: 0.85 } });
  const decision = {
    action: "BUY", symbol: "TECH", price: 100, quantity: 10,
    reason: "Adding tech sector exposure to capture growth momentum in sector",
  };
  const ctx = {
    totalEquity: 1e9, maxPairwiseCorrelation: 0.92, technicals: { rsi14: 40 },
    regime: "neutral", intelligence: { vix: 15 },
  };
  const r = await council.evaluate(decision, ctx);
  assert.equal(r.approved, false);
  assert.equal(r.constitutionViolation, true);
  assert.ok(r.issues.some(i => i.includes("correlation")));
});
