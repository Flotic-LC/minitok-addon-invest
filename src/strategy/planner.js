"use strict";

/**
 * 3-phase planner loop — market-open plan, intraday execution gate,
 * market-close review. Decouples "what to watch and why" from per-tick
 * reactions so the bot acts on a plan instead of impulses.
 */

const { generateSignal } = require("./signals");

const PLAN_MIN_SCORE = Number(process.env.PLAN_MIN_SCORE || 2);

/**
 * Pre-market: rank universe by signal strength, produce today's plan.
 * @param {Array<{symbol, ctx}>} universe - technical contexts per symbol
 * @param {object[]} positions - current holdings
 * @returns {{ date, entries: Array, exits: Array, watch: Array, summary }}
 */
function createDailyPlan(universe, positions = []) {
  const posMap = new Map();
  for (const p of positions) {
    if (Number(p.quantity) > 0) posMap.set(String(p.symbol).toUpperCase(), p);
  }

  const entries = [], exits = [], watch = [];
  for (const { symbol, ctx } of universe) {
    if (!ctx || !ctx.lastClose) continue;
    const pos = posMap.get(String(symbol).toUpperCase());
    const signal = generateSignal(ctx, pos ? { avgPrice: pos.avgPrice, qty: pos.quantity } : null);

    if (pos && signal.action === "SELL") {
      exits.push({ symbol, score: signal.score, strategy: signal.strategy, reasons: signal.reasons });
    } else if (!pos && signal.action === "BUY" && signal.score >= PLAN_MIN_SCORE) {
      entries.push({ symbol, score: signal.score, strategy: signal.strategy, reasons: signal.reasons, lastClose: ctx.lastClose });
    } else {
      watch.push({ symbol, score: signal.score, action: signal.action });
    }
  }

  entries.sort((a, b) => b.score - a.score);
  exits.sort((a, b) => b.score - a.score);

  return {
    date: new Date().toISOString().slice(0, 10),
    entries, exits, watch,
    summary: `${entries.length} entry candidates, ${exits.length} planned exits, ${watch.length} on watch`,
  };
}

/**
 * Intraday gate: does this live signal align with (or override) the plan?
 * Risk exits always pass; plan-aligned entries pass; others need +1 score.
 */
function gateIntradaySignal(symbol, signal, plan) {
  if (!plan) return { pass: true, reason: "no plan" };
  if (signal.strategy === "risk_exit") return { pass: true, reason: "risk exit always allowed" };
  const sym = String(symbol).toUpperCase();
  const planned = plan.entries.find((e) => String(e.symbol).toUpperCase() === sym)
    || plan.exits.find((e) => String(e.symbol).toUpperCase() === sym);
  if (planned && signal.action !== "HOLD") {
    return { pass: true, reason: "aligned with plan (score " + planned.score + ")" };
  }
  // Off-plan trades require higher conviction
  if (signal.action !== "HOLD" && signal.score >= PLAN_MIN_SCORE + 1) {
    return { pass: true, reason: "off-plan but high conviction (score " + signal.score + ")" };
  }
  return { pass: false, reason: "not in plan and insufficient conviction (score " + signal.score + ")" };
}

/**
 * Post-market: compare plan vs actual trades, compute adherence metrics.
 * @param {object} plan - from createDailyPlan
 * @param {object[]} fills - [{ symbol, side, pnl? }]
 */
function reviewDay(plan, fills = []) {
  const plannedSymbols = new Set([
    ...plan.entries.map((e) => String(e.symbol).toUpperCase()),
    ...plan.exits.map((e) => String(e.symbol).toUpperCase()),
  ]);
  let plannedTrades = 0, offPlanTrades = 0, wins = 0, losses = 0, totalPnl = 0;
  for (const f of fills) {
    const sym = String(f.symbol).toUpperCase();
    if (plannedSymbols.has(sym)) plannedTrades++; else offPlanTrades++;
    if (f.pnl != null) {
      totalPnl += f.pnl;
      if (f.pnl > 0) wins++; else if (f.pnl < 0) losses++;
    }
  }
  const total = plannedTrades + offPlanTrades;
  return {
    date: plan.date,
    plannedTrades, offPlanTrades,
    adherencePct: total > 0 ? Math.round((plannedTrades / total) * 100) : 100,
    wins, losses, totalPnl: Math.round(totalPnl),
    notes: offPlanTrades > plannedTrades ? "High off-plan activity — review gate threshold" : "Plan followed",
  };
}

module.exports = { PLAN_MIN_SCORE, createDailyPlan, gateIntradaySignal, reviewDay };
