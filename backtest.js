"use strict";

// --- [FIX #10] Backtest Framework ---
// Replays historical candle data (JSON) through the same strategy logic
// used by runner.js, with the same safety limits enforced, and reports
// performance metrics. No network traffic is generated.
//
// Usage:
//   node backtest.js --data candles.json [--initial 10000000] [--stop-loss -2] [--take-profit 5]
//
// candles.json format:
//   [ { "symbol": "005930", "date": "2025-01-02", "open": 71000, "high": 72000,
//       "low": 70500, "close": 71500, "volume": 1000000 }, ... ]
//   Candles must be sorted ascending by date. Multiple symbols allowed.

const fs = require("node:fs");
const path = require("node:path");
const { createSafety } = require("./src/agent/safety");
const { validateCandleData, validateCandle, buildResultMeta } = require("./src/strategy/candle-validation");
const { costProfile, applyExecutionCosts, roundTripCostPct, PROFILE_NAMES } = require("./src/agent/cost-model");
// [2026-10-21 3단계] The strategy analysis: the per-signal, per-confidence,
// per-holding-period, per-symbol, per-regime, per-entry-reason and
// per-exit-reason breakdowns, and the blocklist of signals proven to lose
// money after costs.
const { analyzeTrades, deriveSignalBlocklist, deriveEdgeMultipliers } = require("./src/strategy/trade-analytics");

// [P2-10 Integration] Knowledge store — feed backtest results for self-improvement
const { createKnowledgeStore } = require("./src/strategy/knowledge-store");

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {
    data: null, initial: 10000000, stopLoss: -2, takeProfit: 5,
    maxOrderValueKrw: 300000,
    // [P3-13] Slippage & market impact model
    slippagePct: 0.1,        // flat slippage per trade (0.1%)
    impactCoefficient: 0,    // sqrt market impact (0 = disabled)
    partialFillRate: 1.0,    // 1.0 = full fill, 0.7 = 70% filled
    // [2026-10-21] 0 means "use the market's own fee schedule" (the cost
    // model). The old default of 0.015 was the retired Korean rate and made
    // every backtest 16.7x cheaper than the live bot, which is what the
    // engines that tune live risk were optimising against.
    commissionPct: 0,
    // [2026-10-21] The cost scenario and the bid/ask spread.
    costProfile: "base",
    spreadPct: null,         // null = the cost model's default
    market: "US",
    // [P2-10] Knowledge store integration
    knowledgeFeed: false,    // --knowledge-feed: write results to .knowledge.json
    knowledgePath: null,     // --knowledge-path <file>: custom knowledge store path
    // [2026-10-21 3단계] --analysis <previous-result.json>: apply the previous
    // measurement's blocklist (the entry signals proven to lose money after
    // costs) and its edge multipliers (the size adjustment for the signals
    // that survive). This is what makes the improvement loop closed: measure,
    // block the losers, re-measure. The file is read EXPLICITLY, never
    // inherited from the environment, so a measurement always measures the
    // same thing unless it is told otherwise.
    analysis: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--data") args.data = argv[++i];
    else if (a === "--analysis") args.analysis = argv[++i];
    else if (a === "--initial") args.initial = Number(argv[++i]);
    else if (a === "--stop-loss") args.stopLoss = Number(argv[++i]);
    else if (a === "--take-profit") args.takeProfit = Number(argv[++i]);
    else if (a === "--max-order-value") args.maxOrderValueKrw = Number(argv[++i]);
    else if (a === "--slippage") args.slippagePct = Number(argv[++i]);
    else if (a === "--impact") args.impactCoefficient = Number(argv[++i]);
    else if (a === "--partial-fill") args.partialFillRate = Number(argv[++i]);
    else if (a === "--commission") args.commissionPct = Number(argv[++i]);
    else if (a === "--spread") args.spreadPct = Number(argv[++i]);
    else if (a === "--cost-profile") args.costProfile = String(argv[++i]);
    else if (a === "--market") args.market = String(argv[++i]);
    else if (a === "--sensitivity") args.sensitivity = true;
    else if (a === "--knowledge-feed") args.knowledgeFeed = true;
    else if (a === "--knowledge-path") args.knowledgePath = argv[++i];
  }
  return args;
}

// ---------------------------------------------------------------------------
// Indicator helpers (same formulas as fetchCandleContext in runner.js)
// ---------------------------------------------------------------------------
function sma(values, period) {
  if (values.length < period) return values.length ? values[values.length - 1] : 0;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function changePct(values, lookback) {
  if (values.length < 2) return 0;
  const start = values[Math.max(0, values.length - lookback)];
  if (!start) return 0;
  return ((values[values.length - 1] - start) / start) * 100;
}

// [P1-FITNESS] Additional indicator helpers — same formulas as runner.js fetchCandleContext.
// Required so generateSignal() has enough evidence to trigger BUY/SELL in backtest.
function ema(values, period) {
  if (values.length === 0) return 0;
  if (values.length < period) return values.reduce((a, b) => a + b, 0) / values.length;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function rsi(values, period) {
  period = period || 14;
  if (values.length < period + 1) return 50;
  let gain = 0, loss = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gain += d; else loss += Math.abs(d);
  }
  if (loss === 0) return 100;
  const rs = (gain / period) / (loss / period);
  return 100 - 100 / (1 + rs);
}

function macdCalc(values) {
  if (values.length < 26) return { macd: 0, signal: 0, histogram: 0 };
  const ema12 = ema(values.slice(-12), 12);
  const ema26 = ema(values.slice(-26), 26);
  const macdLine = ema12 - ema26;
  const macdSeries = [];
  for (let i = Math.max(0, values.length - 9); i < values.length; i++) {
    const sub = values.slice(0, i + 1);
    if (sub.length >= 26) {
      const e12 = ema(sub.slice(-12), 12);
      const e26 = ema(sub.slice(-26), 26);
      macdSeries.push(e12 - e26);
    }
  }
  const signalLine = macdSeries.length ? macdSeries.reduce((a, b) => a + b, 0) / macdSeries.length : 0;
  return { macd: macdLine, signal: signalLine, histogram: macdLine - signalLine };
}

function bollinger(values, period) {
  period = period || 20;
  if (values.length < period) return { upper: 0, lower: 0, mid: 0 };
  const slice = values.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, v) => a + (v - mid) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return { upper: mid + 2 * sd, lower: mid - 2 * sd, mid };
}

function atr(values, period) {
  period = period || 14;
  if (values.length < 2) return 0;
  let sum = 0, count = 0;
  const start = Math.max(1, values.length - period);
  for (let i = start; i < values.length; i++) {
    sum += Math.abs(values[i] - values[i - 1]);
    count++;
  }
  return count ? sum / count : 0;
}

// ---------------------------------------------------------------------------
// Strategy: momentum / mean-reversion hybrid via shared signal engine.
// [Phase 2.4] Backtest uses the SAME src/strategy/signals.js as live runner,
// so a profitable backtest means the live signal layer would have done the
// same trades (before LLM approval/guards).
// ---------------------------------------------------------------------------
const { generateSignal, DEFAULT_PARAMS } = require("./src/strategy/signals");

function buildCtx(closes, opts) {
  const last = closes[closes.length - 1];
  const ma5 = sma(closes, 5);
  const ma20 = closes.length >= 20 ? sma(closes, 20) : null;
  const chg = changePct(closes, 5);
  // [P1-FITNESS] Provide full indicator set required by src/strategy/signals.js generateSignal().
  const ema9v = ema(closes, 9);
  const ema21v = ema(closes, 21);
  const rsi14v = rsi(closes, 14);
  const macdObj = macdCalc(closes);
  const bollObj = bollinger(closes, 20);
  const atr14v = atr(closes, 14);
  const vwapv = closes.length ? closes.reduce((a, b) => a + b, 0) / closes.length : last;
  return {
    lastClose: last,
    sma5: ma5,
    sma20: ma20,
    changePct5d: chg,
    ema9: ema9v,
    ema21: ema21v,
    rsi14: rsi14v,
    macd: { macdLine: macdObj.macd, signal: macdObj.signal, histogram: macdObj.histogram },
    bollinger: { upper: bollObj.upper, middle: bollObj.mid, lower: bollObj.lower },
    atr14: atr14v,
    vwap: vwapv,
  };
}

/**
 * [2026-10-21 3단계] Classify the exit so the round trip can be attributed to
 * the reason it was closed. The signal engine reports the exit as a single
 * "risk_exit" strategy whether it was a stop-loss or a take-profit, and the
 * two have completely different economics: a stop-loss is the cost of being
 * wrong, a take-profit is the point of the trade.
 */
function classifyExit(signal) {
  if (!signal || signal.action !== "SELL") return null;
  const reasons = Array.isArray(signal.reasons) ? signal.reasons : [];
  for (const r of reasons) {
    if (r.indexOf("stop-loss") === 0) return "stop_loss";
    if (r.indexOf("take-profit") === 0) return "take_profit";
  }
  if (signal.strategy === "trend_exit") return "trend_exit";
  if (signal.strategy === "risk_exit") return "risk_exit_other";
  return signal.strategy || "unknown";
}

/**
 * [2026-10-21 3단계] The regime a trade was opened in. The runner has a
 * hidden-Markov directional regime, but the backtest does not run the HMM,
 * so the regime here is derived from the same information the HMM uses: the
 * 20-day trend and the ATR. The P&L of a strategy has to be readable against
 * the market it was traded in — a mean reversion that only works in a
 * ranging tape looks like a good strategy until you notice the range.
 */
function classifyRegime(ctx) {
  const c20 = Number(ctx && ctx.changePct20d);
  const atrPct = ctx && ctx.atr14 && ctx.lastClose ? (ctx.atr14 / ctx.lastClose) * 100 : null;
  if (Number.isFinite(c20)) {
    if (c20 > 2) return "bull";
    if (c20 < -2) return "bear";
  }
  if (atrPct != null && atrPct > 3) return "high_vol";
  return "sideways";
}

function decide(closes, portfolio, symbol, opts) {
  const ctx = buildCtx(closes, opts);
  const pos = portfolio.positions.get(symbol);
  const signal = generateSignal(ctx, pos ? { avgPrice: pos.avgPrice, qty: pos.qty } : null, {
    ...DEFAULT_PARAMS,
    stopLossPct: opts.stopLoss,
    takeProfitPct: opts.takeProfit,
    // [2026-10-21] The market and the cost configuration for the gate. The
    // gate always uses the BASE cost profile so that a cost-sensitivity
    // comparison runs on the same trade set in all three scenarios.
    market: (opts && opts.market) || "US",
    costConfig: costProfile("base", buildCostConfigOverrides(opts)),
    // [2026-10-21 3단계] The measured blocklist and the edge multipliers are
    // passed IN, never read from the environment: a backtest that picked up
    // the live blocklist would stop measuring the strategies it is supposed to
    // be judging, and the derived blocklist would oscillate as blocked
    // strategies disappeared from the measurement. The comparison run
    // therefore applies the PREVIOUS measurement explicitly (--analysis), and
    // the default run measures everything.
    blockedStrategies: (opts && opts.blockedStrategies) || [],
  });
  return {
    action: signal.action,
    reason: signal.reasons.join("; "),
    score: signal.score,
    // [2026-10-21] Which stop and take-profit actually governed this decision.
    // The ATR override in exitSignal replaces the supplied stop/take entirely,
    // so a backtest run with --stop-loss/-take-profit silently measured
    // something else. The caller needs to know which numbers were in force.
    effectiveStopLossPct: signal.effectiveStopLossPct,
    effectiveTakeProfitPct: signal.effectiveTakeProfitPct,
    // [2026-10-21] The strategy that produced the signal, so the per-strategy
    // gross-vs-net classification can attribute a round trip to the entry
    // strategy that opened it.
    strategy: signal.strategy || null,
    // [2026-10-21 3단계] The raw reason list, the exit classification and the
    // regime, so every trade can be attributed to the signal that opened it
    // and to the reason it was closed. Without this the only performance
    // number available is one aggregate return, which cannot say which
    // signal is worth taking.
    reasons: Array.isArray(signal.reasons) ? signal.reasons : [],
    exitKind: classifyExit(signal),
    regime: classifyRegime(ctx),
  };
}

// ---------------------------------------------------------------------------
// [P3-13] Slippage & market impact model
// ---------------------------------------------------------------------------
// Realistic execution cost model.
//
// [2026-10-21] The cost model used to live here alone, and it was wrong in
// four ways: the bid/ask spread was not charged at all (the backtest traded at
// the close), the market impact was implemented but switched off in every
// caller, the tax had no term at all, and partial fills were never exercised.
// The rules now live in src/agent/cost-model.js so that the backtest, the
// live fill and the engines that tune live risk are costed identically.
function buildCostConfigOverrides(opts) {
  const o = opts || {};
  const overrides = {};
  if (o.spreadPct != null) overrides.spreadPct = Number(o.spreadPct);
  if (o.slippagePct != null) overrides.slippagePct = Number(o.slippagePct);
  if (o.impactCoefficient != null) overrides.impactCoefficient = Number(o.impactCoefficient);
  if (o.partialFillRate != null) overrides.partialFillRate = Number(o.partialFillRate);
  if (o.minAtrCostMultiple != null) overrides.minAtrCostMultiple = Number(o.minAtrCostMultiple);
  if (o.apiCostPerDecision != null) overrides.apiCostPerDecision = Number(o.apiCostPerDecision);
  return overrides;
}

function buildCostConfig(opts) {
  return costProfile((opts && opts.costProfile) || "base", buildCostConfigOverrides(opts));
}

function applySlippage(price, side, orderValue, avgVolume, opts) {
  const cfg = buildCostConfig(opts);
  const direction = side === "BUY" ? 1 : -1;
  // Per-share application. The spread, the slippage and the impact move the
  // execution price; the commission and the tax are charged on the executed
  // price and folded into the effective cost the portfolio actually pays.
  const r = applyExecutionCosts({
    side: side, price: price, quantity: 1,
    notional: orderValue, avgVolume: avgVolume,
    market: (opts && opts.market) || "US", config: cfg,
    // An explicit --commission overrides the market schedule; 0 means "use
    // the market's own schedule".
    fees: (opts && Number(opts.commissionPct) > 0)
      ? { buyCommissionPct: Number(opts.commissionPct), sellCommissionPct: Number(opts.commissionPct) }
      : null,
  });
  const commissionPerShare = r.costs.commission;
  const taxPerShare = r.costs.tax;
  return {
    executedPrice: r.executedPrice,
    commissionPerShare: commissionPerShare,
    taxPerShare: taxPerShare,
    fillRate: r.fillRate,
    effectiveCost: r.executedPrice + direction * (commissionPerShare + taxPerShare),
    slipPct: cfg.slippagePct,
    impactPct: price > 0 ? (r.costs.impact / price) * 100 : 0,
    spreadPct: price > 0 ? (r.costs.spread / price) * 100 : 0,
    costs: r.costs,
    totalCostPct: r.totalCostPct,
  };
}

// ---------------------------------------------------------------------------
// Portfolio simulation
// ---------------------------------------------------------------------------
function runBacktest(candles, opts) {
  // [2026-10-21] Fail-closed input gate.
  //
  // A dataset with unusable prices (the historical failure mode: open/close
  // = 0 while high/low stayed valid) silently produced 0 trades, sharpe 0
  // and a flat equity curve. Every metric was still a number, so the result
  // file was indistinguishable from a real measurement and the runner read
  // it back as "conservative but underperforming" and loosened live risk.
  //
  // The validation is attached to the result so the consumer can tell a
  // measurement from a computation failure. Invalid candles are excluded
  // from the run; the result is marked degraded and must not be written as
  // a normal backtest result.
  const validation = validateCandleData(candles);
  const usableCandles = validation.ok
    ? candles
    : candles.filter(function(c) { return validateCandle(c) === null; });

  const safety = createSafety({
    maxOrderValueKrw: opts.maxOrderValueKrw,
    dailyMaxValueKrw: opts.initial, // full equity can be traded per day max
    maxOpenOrders: 10,
    maxPositionsPerSymbol: 1,
    cooldownMs: 0,
    enforcePreChecks: true,
  });

  const portfolio = {
    cash: opts.initial,
    positions: new Map(), // symbol -> { qty, avgPrice }
  };

  const trades = [];
  const equityCurve = [];
  let peakEquity = opts.initial;
  let maxDrawdown = 0;
  let wins = 0;
  let losses = 0;
  // [2026-10-21] Gross and net are tracked separately, per trade and per
  // strategy. A result that reports only one number cannot tell a strategy
  // that made money from one that churned through a bigger gross P&L and
  // lost it all to the costs.
  let grossWins = 0;
  let grossLosses = 0;
  let totalGrossPnl = 0;
  let totalNetPnl = 0;
  let totalRoundTripCost = 0;
  let totalCommission = 0;
  let totalTax = 0;
  let totalSpread = 0;
  let totalSlippage = 0;
  let totalImpact = 0;
  const _byStrategy = {};

  // Group candles by symbol while preserving insertion order
  const bySymbol = new Map();
  for (const c of usableCandles) {
    if (!bySymbol.has(c.symbol)) bySymbol.set(c.symbol, []);
    bySymbol.get(c.symbol).push(c);
  }

  // Build a merged timeline of unique dates (ascending)
  const allDates = [...new Set(usableCandles.map((c) => c.date))].sort();

  // [2026-10-21] Tracks which stop/take actually governed the run.
  const effectiveStops = { stopMin: null, stopMax: null, takeMin: null, takeMax: null, atrAdjusted: 0 };

  for (const date of allDates) {
    // [2026-10-21] The replay advances the safety module's trading day, so
    // the daily traded-value limit applies per historical day instead of once
    // for the whole run.
    if (typeof safety.setTradingDay === "function") safety.setTradingDay(date);
    for (const [symbol, series] of bySymbol) {
      const idx = series.findIndex((c) => c.date === date);
      if (idx < 0) continue;
      const closes = series.slice(0, idx + 1).map((c) => Number(c.close));
      const price = closes[closes.length - 1];
      if (!price || closes.length < 3) continue;

      const decision = decide(closes, portfolio, symbol, opts);
      // [2026-10-21] Track which stop/take actually governed the decisions.
      if (decision.effectiveStopLossPct != null) {
        const _sl = Number(decision.effectiveStopLossPct);
        const _tp = Number(decision.effectiveTakeProfitPct);
        if (Number.isFinite(_sl)) {
          if (effectiveStops.stopMin == null || _sl < effectiveStops.stopMin) effectiveStops.stopMin = _sl;
          if (effectiveStops.stopMax == null || _sl > effectiveStops.stopMax) effectiveStops.stopMax = _sl;
          if (Math.abs(_sl - opts.stopLoss) > 0.0001) effectiveStops.atrAdjusted++;
        }
        if (Number.isFinite(_tp)) {
          if (effectiveStops.takeMin == null || _tp < effectiveStops.takeMin) effectiveStops.takeMin = _tp;
          if (effectiveStops.takeMax == null || _tp > effectiveStops.takeMax) effectiveStops.takeMax = _tp;
        }
      }
      // [P3-13] Use high-low spread as a proxy for average daily volume
      const recentHigh = series[idx].high ? Number(series[idx].high) : price;
      const recentLow = series[idx].low ? Number(series[idx].low) : price;
      const spread = recentHigh - recentLow;
      const avgVolume = series[idx].volume ? Number(series[idx].volume) * price : (price * 10000);

      if (decision.action === "BUY") {
        // [2026-10-21] Size the order so that it FITS the limit after costs.
        // The order was sized from the raw price, so the slippage- and
        // commission-adjusted value landed just over the cap and the safety
        // guard rejected every single order — a backtest that could not trade
        // at all, which is the same failure shape as the zero-price dataset.
        const _probe = applySlippage(price, "BUY", 0, avgVolume, opts);
        const _perUnit = _probe.effectiveCost || price;
        // [2026-10-21 3단계] The loss-probability adjustment is applied to the
        // size, not only to the entry decision: a signal whose measured
        // profit factor is below 1 gets a smaller position. The multiplier
        // comes from the PREVIOUS measurement (--analysis) and defaults to 1.
        const _edgeMult = (opts && opts.edgeMultipliers && decision.strategy && Number(opts.edgeMultipliers[decision.strategy])) || 1;
        const intendedQty = Math.max(1, Math.floor((opts.maxOrderValueKrw * _edgeMult) / _perUnit));
        const slip = applySlippage(price, "BUY", intendedQty * price, avgVolume, opts);
        let qty = Math.max(1, Math.floor(intendedQty * slip.fillRate));
        const costPerShare = slip.effectiveCost;
        while (qty > 0 && costPerShare * qty > opts.maxOrderValueKrw) qty--;
        const totalCost = costPerShare * qty;
        const guard = safety.checkPreCreateOrder({ symbol, side: "BUY", price: costPerShare, quantity: qty });
        // [2026-10-21] A limit too small to buy a single share must not
        // create a zero-quantity position: the trim above can take the
        // quantity to 0, and a zero-size position would be recorded as a
        // trade while carrying no exposure.
        if (qty < 1) continue;
        if (guard.ok && portfolio.cash >= totalCost) {
          portfolio.cash -= totalCost;
          const pos = portfolio.positions.get(symbol);
          // [2026-10-21] The entry cost per share, relative to the signal
          // price. Everything the trade paid on the way in: the spread, the
          // slippage, the impact and the commission. It is tracked so the
          // round trip can be reported gross (the price move) and net (the
          // price move minus everything it cost) — a gross profit that is
          // smaller than the cost is a net loss and has to be visible as one.
          const entryCostPerShare = costPerShare - price;
          if (pos) {
            const totalQty = pos.qty + qty;
            pos.avgPrice = (pos.avgPrice * pos.qty + costPerShare * qty) / totalQty;
            pos.avgSignalPrice = ((pos.avgSignalPrice || price) * pos.qty + price * qty) / totalQty;
            pos.entryCostPerShare = ((pos.entryCostPerShare || 0) * pos.qty + entryCostPerShare * qty) / totalQty;
            pos.qty = totalQty;
          } else {
            portfolio.positions.set(symbol, {
              qty: qty, avgPrice: costPerShare, avgSignalPrice: price,
              entryCostPerShare: entryCostPerShare, strategy: decision.strategy || "standard",
              // [2026-10-21 3단계] The signal that opened the position is kept
              // on the position so the round trip can be attributed to it when
              // it closes. This is what makes "which entry signal makes money
              // after costs" answerable at all.
              entryScore: decision.score,
              entryReasons: decision.reasons,
              entryRegime: decision.regime,
              entryBarIndex: typeof idx !== "undefined" ? idx : null,
              entryDate: date,
            });
          }
          safety.recordPositionOpen(symbol);
          // [2026-10-21] The safety module only accumulates the daily traded
          // value when an order succeeds, and the backtest never told it.
          // The daily traded-value limit was therefore inert in every
          // backtest: the replay could trade more in a day than the live bot
          // is allowed to, so the measurement was optimistic by construction.
          if (typeof safety.recordOrderSuccess === "function") {
            // [2026-10-21] The daily traded-value limit counts the SIGNAL
            // notional, not the cost-inflated one. Counting the fill value
            // meant a cheaper cost model fitted more trades into the same
            // day, so the optimistic and pessimistic scenarios differed in
            // WHICH trades they took as well as in what those trades cost —
            // and a cost-sensitivity comparison has to isolate the cost.
            safety.recordOrderSuccess({ price: price, quantity: qty });
          }
          trades.push({
            date: date, symbol: symbol, side: "BUY",
            signalPrice: price, price: Number(costPerShare.toFixed(2)),
            qty: qty, slippagePct: Number(slip.slipPct.toFixed(3)),
            impactPct: Number(slip.impactPct.toFixed(3)),
            spreadPct: Number(slip.spreadPct.toFixed(3)),
            costs: {
              commission: Number(slip.costs.commission.toFixed(4)),
              tax: Number(slip.costs.tax.toFixed(4)),
              spread: Number(slip.costs.spread.toFixed(4)),
              slippage: Number(slip.costs.slippage.toFixed(4)),
              impact: Number(slip.costs.impact.toFixed(4)),
              total: Number((entryCostPerShare * qty).toFixed(4)),
            },
            costRatio: null,
            strategy: decision.strategy || "standard",
            reason: decision.reason,
          });
        }
      } else if (decision.action === "SELL") {
        const pos = portfolio.positions.get(symbol);
        if (pos) {
          const intendedQty = pos.qty;
          const slip = applySlippage(price, "SELL", intendedQty * price, avgVolume, opts);
          const filledQty = Math.max(1, Math.floor(intendedQty * slip.fillRate));
          const proceeds = filledQty * slip.effectiveCost;
          portfolio.cash += proceeds;
          if (typeof safety.recordOrderSuccess === "function") {
            safety.recordOrderSuccess({ price: price, quantity: filledQty });
          }
          const pnl = (slip.effectiveCost - pos.avgPrice) * filledQty;
          // [2026-10-21] Gross vs net. The gross is the price move between the
          // signal prices; the net is that move minus everything the round
          // trip cost — the entry spread/slippage/impact/commission, the exit
          // ones, and the tax. A trade can be a gross winner and a net loser,
          // and the result has to say so instead of reporting one number.
          const entrySignalPrice = pos.avgSignalPrice || pos.avgPrice;
          const entryCostPerShare = pos.entryCostPerShare || 0;
          const exitCostPerShare = price - slip.effectiveCost;
          const grossPnl = (price - entrySignalPrice) * filledQty;
          const entryCost = entryCostPerShare * filledQty;
          const exitCost = exitCostPerShare * filledQty;
          const roundTripCost = entryCost + exitCost;
          const netPnl = grossPnl - roundTripCost;
          const costRatio = Math.abs(grossPnl) > 0 ? roundTripCost / Math.abs(grossPnl) : null;
          if (pnl >= 0) wins++; else losses++;
          if (grossPnl >= 0) grossWins++; else grossLosses++;
          totalGrossPnl += grossPnl;
          totalNetPnl += netPnl;
          totalRoundTripCost += roundTripCost;
          totalCommission += slip.costs.commission * filledQty;
          totalTax += slip.costs.tax * filledQty;
          totalSpread += slip.costs.spread * filledQty;
          totalSlippage += slip.costs.slippage * filledQty;
          totalImpact += slip.costs.impact * filledQty;
          const _strat = pos.strategy || "standard";
          if (!_byStrategy[_strat]) _byStrategy[_strat] = { strategy: _strat, trades: 0, grossPnl: 0, netPnl: 0, costs: 0, wins: 0, losses: 0 };
          _byStrategy[_strat].trades++;
          _byStrategy[_strat].grossPnl += grossPnl;
          _byStrategy[_strat].netPnl += netPnl;
          _byStrategy[_strat].costs += roundTripCost;
          if (netPnl >= 0) _byStrategy[_strat].wins++; else _byStrategy[_strat].losses++;
          safety.recordPositionClose(symbol);
          if (filledQty >= pos.qty) {
            portfolio.positions.delete(symbol);
          } else {
            pos.qty -= filledQty;
          }
          trades.push({
            date: date, symbol: symbol, side: "SELL",
            signalPrice: price, price: Number(slip.effectiveCost.toFixed(2)),
            qty: filledQty, pnl: Number(pnl.toFixed(2)),
            grossPnl: Number(grossPnl.toFixed(4)),
            netPnl: Number(netPnl.toFixed(4)),
            costs: {
              commission: Number(slip.costs.commission.toFixed(4)),
              tax: Number(slip.costs.tax.toFixed(4)),
              spread: Number(slip.costs.spread.toFixed(4)),
              slippage: Number(slip.costs.slippage.toFixed(4)),
              impact: Number(slip.costs.impact.toFixed(4)),
              entry: Number(entryCost.toFixed(4)),
              exit: Number(exitCost.toFixed(4)),
              total: Number(roundTripCost.toFixed(4)),
            },
            costRatio: costRatio == null ? null : Number(costRatio.toFixed(4)),
            slippagePct: Number(slip.slipPct.toFixed(3)),
            impactPct: Number(slip.impactPct.toFixed(3)),
            spreadPct: Number(slip.spreadPct.toFixed(3)),
            partialFill: filledQty < intendedQty,
            strategy: _strat,
            exitStrategy: decision.strategy || null,
            reason: decision.reason,
            // [2026-10-21 3단계] The full attribution of the round trip: the
            // signal that opened it (strategy, score, the individual evidence
            // lines, the regime), the classified reason it was closed, and how
            // long it was held. These are the axes the strategy analysis is
            // cut along.
            entryStrategy: _strat,
            entryScore: pos.entryScore != null ? pos.entryScore : null,
            entryReasons: Array.isArray(pos.entryReasons) ? pos.entryReasons : [],
            confidence: pos.entryScore != null ? pos.entryScore : null,
            regime: pos.entryRegime || decision.regime || null,
            exitKind: decision.exitKind || null,
            exitReason: decision.exitKind || decision.strategy || "unknown",
            holdingBars: (typeof idx !== "undefined" && pos.entryBarIndex != null) ? (idx - pos.entryBarIndex) : null,
            entryDate: pos.entryDate || null,
          });
        }
      }
    }

    // Mark-to-market equity for this date
    let equity = portfolio.cash;
    for (const [symbol, pos] of portfolio.positions) {
      const series = bySymbol.get(symbol);
      const lastCandle = series[series.length - 1];
      equity += pos.qty * Number(lastCandle.close);
    }
    equityCurve.push({ date: date, equity: equity });
    if (equity > peakEquity) peakEquity = equity;
    const dd = ((peakEquity - equity) / peakEquity) * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Final liquidation value
  let finalEquity = portfolio.cash;
  for (const [symbol, pos] of portfolio.positions) {
    const series = bySymbol.get(symbol);
    finalEquity += pos.qty * Number(series[series.length - 1].close);
  }

  const totalReturnPct = ((finalEquity - opts.initial) / opts.initial) * 100;
  const winRate = wins + losses > 0 ? (wins / (wins + losses)) * 100 : 0;

  // Sharpe-like ratio from daily equity returns (annualized, 252 days)
  const returns = [];
  for (let i = 1; i < equityCurve.length; i++) {
    returns.push((equityCurve[i].equity - equityCurve[i - 1].equity) / equityCurve[i - 1].equity);
  }
  const mean = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance = returns.length
    ? returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length
    : 0;
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  // [P3-13] Aggregate slippage impact stats
  let totalSlippageCost = 0;
  let partialFillCount = 0;
  for (const t of trades) {
    if (t.signalPrice && t.price) {
      const diff = Math.abs(t.price - t.signalPrice) * t.qty;
      totalSlippageCost += diff;
    }
    if (t.partialFill) partialFillCount++;
  }

  // [2026-10-21] Mark the open positions to the last close so that the
  // realised net P&L and the equity change can be reconciled. The average
  // price is the effective cost, so this is already net of the entry costs
  // and gross of the exit costs that have not been paid yet.
  let _unrealizedPnl = 0;
  let _openPositions = 0;
  for (const [sym, pos] of portfolio.positions) {
    const _series = bySymbol.get(sym) || [];
    const _lastClose = _series.length ? Number(_series[_series.length - 1].close) : pos.avgPrice;
    _unrealizedPnl += (_lastClose - pos.avgPrice) * pos.qty;
    _openPositions++;
  }

  return {
    initialEquity: opts.initial,
    finalEquity: Math.round(finalEquity),
    totalReturnPct: Number(totalReturnPct.toFixed(3)),
    maxDrawdownPct: Number(maxDrawdown.toFixed(3)),
    sharpe: Number(sharpe.toFixed(3)),
    trades: trades.length,
    buys: trades.filter((t) => t.side === "BUY").length,
    sells: trades.filter((t) => t.side === "SELL").length,
    wins: wins,
    losses: losses,
    winRatePct: Number(winRate.toFixed(2)),
    // [2026-10-21] Gross vs net, and the cost that separates them. Before
    // this, a result carried one number (the equity return) and no way to
    // tell a strategy that earned from one that churned. These fields make
    // the difference explicit and auditable.
    grossPnl: Number(totalGrossPnl.toFixed(4)),
    netPnl: Number(totalNetPnl.toFixed(4)),
    grossWinRatePct: grossWins + grossLosses > 0 ? Number(((grossWins / (grossWins + grossLosses)) * 100).toFixed(2)) : 0,
    totalCosts: Number(totalRoundTripCost.toFixed(4)),
    costBreakdown: {
      commission: Number(totalCommission.toFixed(4)),
      tax: Number(totalTax.toFixed(4)),
      spread: Number(totalSpread.toFixed(4)),
      slippage: Number(totalSlippage.toFixed(4)),
      impact: Number(totalImpact.toFixed(4)),
      total: Number(totalRoundTripCost.toFixed(4)),
    },
    // How much of the gross the costs consumed. Above 1 the strategy was a
    // gross winner and a net loser.
    costRatio: Math.abs(totalGrossPnl) > 0 ? Number((totalRoundTripCost / Math.abs(totalGrossPnl)).toFixed(4)) : null,
    // The per-strategy gross vs net. A strategy is only valid if it survives
    // the costs; see classifyStrategies().
    byStrategy: Object.keys(_byStrategy).sort().map(function(k) {
      const s = _byStrategy[k];
      return {
        strategy: s.strategy, trades: s.trades, wins: s.wins, losses: s.losses,
        grossPnl: Number(s.grossPnl.toFixed(4)),
        netPnl: Number(s.netPnl.toFixed(4)),
        costs: Number(s.costs.toFixed(4)),
        costRatio: Math.abs(s.grossPnl) > 0 ? Number((s.costs / Math.abs(s.grossPnl)).toFixed(4)) : null,
        survivesCosts: s.netPnl > 0,
      };
    }),
    roundTripCostPct: Number(roundTripCostPct((opts && opts.market) || "US", buildCostConfig(opts)).toFixed(4)),
    // [2026-10-21 3단계] The strategy analysis. It is computed from the SAME
    // trade records as the headline numbers above, so it cannot disagree with
    // them, and it carries the blocklist of entry signals that are proven to
    // lose money once the round-trip cost is paid. The blocklist is what
    // turns this measurement into an actual change in the trading code: the
    // signal engine refuses those strategies outright.
    tradeAnalytics: (function () {
      const _a = analyzeTrades(trades);
      const _minTrades = (opts && opts.minTradesForBlock) || 15;
      const _bl = deriveSignalBlocklist(_a, { minTrades: _minTrades });
      return {
        totalTrades: _a.totalTrades,
        valid: _a.valid,
        overall: _a.overall,
        byEntryStrategy: _a.byEntryStrategy,
        byEntryStrategyList: _a.byEntryStrategyList,
        byExitStrategy: _a.byExitStrategy,
        byExitReason: _a.byExitReason,
        byConfidenceBucket: _a.byConfidenceBucket,
        byHoldingBucket: _a.byHoldingBucket,
        bySymbol: _a.bySymbol,
        byRegime: _a.byRegime,
        byEntryReason: _a.byEntryReason,
        blocklist: _bl,
        edgeMultipliers: deriveEdgeMultipliers(_a, { minTrades: _minTrades }),
      };
    })(),
    // [2026-10-21] The open positions at the end of the run, marked to the
    // last close. The closed-trade net P&L and the equity return are
    // different numbers — one is realised, the other is the whole account —
    // and without this the two could not be reconciled.
    unrealizedPnl: Number(_unrealizedPnl.toFixed(4)),
    openPositions: _openPositions,
    // The reconciliation: realised net + unrealised ~= the change in equity.
    // The gap is the exit cost that has not been paid yet.
    equityChange: Number((finalEquity - opts.initial).toFixed(4)),
    costProfile: (opts && opts.costProfile) || "base",
    // [2026-10-21] Provenance. A consumer MUST check meta.validation before
    // treating any of the numbers above as a strategy measurement. A result
    // with meta.validation !== "ok" or meta.confidence === "none" is a
    // computation failure, not a strategy verdict.
    meta: buildResultMeta(validation, {
      trades: trades.length,
      costModel: {
        commissionPct: opts.commissionPct,
        spreadPct: buildCostConfig(opts).spreadPct,
        slippagePct: opts.slippagePct,
        impactCoefficient: opts.impactCoefficient,
        partialFillRate: opts.partialFillRate,
        maxOrderValueKrw: opts.maxOrderValueKrw,
        initialEquity: opts.initial,
        costProfile: (opts && opts.costProfile) || "base",
        roundTripCostPct: Number(roundTripCostPct((opts && opts.market) || "US", buildCostConfig(opts)).toFixed(4)),
      },
      // [2026-10-21] The signal parameters the run actually used, and the
      // environment they came from. The signal defaults are read from the
      // process environment, so the SAME data and the SAME command line can
      // measure two different configurations depending on whether the .env
      // was loaded — the cron measures the live bot, a manual run does not.
      // The fingerprint makes that visible instead of silent.
      signalParams: {
        minScore: DEFAULT_PARAMS.minScore,
        atrStopMult: DEFAULT_PARAMS.atrStopMult,
        atrTakeMult: DEFAULT_PARAMS.atrTakeMult,
        useAtrStops: DEFAULT_PARAMS.useAtrStops,
        minStopPct: DEFAULT_PARAMS.minStopPct,
        stopLossPct: opts.stopLoss,
        takeProfitPct: opts.takeProfit,
      },
      envFingerprint: {
        SIG_MIN_SCORE: process.env.SIG_MIN_SCORE || null,
        SIG_ATR_STOP_MULT: process.env.SIG_ATR_STOP_MULT || null,
        SIG_ATR_TAKE_MULT: process.env.SIG_ATR_TAKE_MULT || null,
        SIG_MIN_STOP_PCT: process.env.SIG_MIN_STOP_PCT || null,
        SIG_MIN_ATR_COST_MULTIPLE: process.env.SIG_MIN_ATR_COST_MULTIPLE || null,
        COST_SPREAD_PCT: process.env.COST_SPREAD_PCT || null,
        COST_SLIPPAGE_PCT: process.env.COST_SLIPPAGE_PCT || null,
        COST_IMPACT_COEFFICIENT: process.env.COST_IMPACT_COEFFICIENT || null,
        PNL_BUY_COMMISSION_PCT: process.env.PNL_BUY_COMMISSION_PCT || null,
        PNL_SELL_COMMISSION_PCT: process.env.PNL_SELL_COMMISSION_PCT || null,
      },
      // [2026-10-21] Which stop and take-profit were actually in force. The
      // ATR override in the exit signal replaces the supplied stop/take, so
      // a run with --stop-loss/-take-profit can measure something entirely
      // different from what it claims. A measurement that does not say which
      // parameters governed it cannot be used to tune them.
      effectiveStops: {
        source: effectiveStops.atrAdjusted > 0 ? "atr" : "cli",
        suppliedStopLossPct: opts.stopLoss,
        suppliedTakeProfitPct: opts.takeProfit,
        stopLossPct: effectiveStops.stopMin,
        takeProfitPct: effectiveStops.takeMin,
        stopLossPctMax: effectiveStops.stopMax,
        takeProfitPctMax: effectiveStops.takeMax,
        atrAdjustedDecisions: effectiveStops.atrAdjusted,
      },
    }),
    // [P3-13] Slippage / execution realism
    slippageConfig: {
      slippagePct: opts.slippagePct,
      impactCoefficient: opts.impactCoefficient,
      partialFillRate: opts.partialFillRate,
      commissionPct: opts.commissionPct,
    },
    totalSlippageCostKrw: Math.round(totalSlippageCost),
    partialFillTrades: partialFillCount,
    tradeLog: trades,
    equityCurve: equityCurve,
  };
}

// ---------------------------------------------------------------------------
// [2026-10-21] Cost sensitivity analysis and strategy classification
// ---------------------------------------------------------------------------
/**
 * Run the same dataset under the three cost scenarios and say what survives.
 *
 * The signal set is deliberately held constant — the cost gate always uses
 * the BASE cost, so the three scenarios differ only in what a trade COST, not
 * in which trades were taken. Otherwise the comparison would mix two effects
 * and a strategy could look profitable only because the pessimistic scenario
 * took fewer trades.
 *
 * A strategy is classified as valid only when it is profitable NET in the
 * base case AND in the pessimistic case. A strategy that is a gross winner
 * but a net loser does not have an edge — it has a cost assumption.
 */
function runCostSensitivity(candles, opts) {
  const base = Object.assign({}, opts || {});
  const runs = {};
  for (const name of PROFILE_NAMES) {
    // [2026-10-21] Every scenario fills completely. A partial fill changes
    // the position sizes, which changes which orders the size limit admits,
    // so a partial fill would make the scenarios differ in WHICH trades they
    // took as well as in what those trades cost. The comparison has to
    // isolate the cost. The fill mechanic is exercised on its own.
    const r = runBacktest(candles, Object.assign({}, base, { costProfile: name, partialFillRate: 1.0 }));
    runs[name] = {
      costProfile: name,
      totalReturnPct: r.totalReturnPct,
      sharpe: r.sharpe,
      trades: r.trades,
      grossPnl: r.grossPnl,
      netPnl: r.netPnl,
      totalCosts: r.totalCosts,
      costRatio: r.costRatio,
      roundTripCostPct: r.roundTripCostPct,
      byStrategy: r.byStrategy,
    };
  }
  const strategies = {};
  for (const name of PROFILE_NAMES) {
    for (const s of runs[name].byStrategy) {
      if (!strategies[s.strategy]) strategies[s.strategy] = { strategy: s.strategy, scenarios: {} };
      strategies[s.strategy].scenarios[name] = {
        grossPnl: s.grossPnl, netPnl: s.netPnl, costs: s.costs, trades: s.trades, costRatio: s.costRatio,
      };
    }
  }
  const byStrategy = Object.keys(strategies).sort().map(function(k) {
    const s = strategies[k];
    const baseNet = s.scenarios.base ? s.scenarios.base.netPnl : null;
    const pessNet = s.scenarios.pessimistic ? s.scenarios.pessimistic.netPnl : null;
    const grossEver = Object.keys(s.scenarios).some(function(n) { return s.scenarios[n].grossPnl > 0; });
    const netEver = Object.keys(s.scenarios).some(function(n) { return s.scenarios[n].netPnl > 0; });
    const survives = baseNet != null && pessNet != null && baseNet > 0 && pessNet > 0;
    return {
      strategy: k,
      scenarios: s.scenarios,
      survivesCosts: survives,
      grossPositive: grossEver,
      netPositive: netEver,
      verdict: survives ? "survives"
        : (grossEver && !netEver ? "gross winner, net loser — killed by costs"
          : (grossEver ? "gross positive but net negative in every scenario" : "not profitable")),
    };
  });
  return {
    runs: runs,
    byStrategy: byStrategy,
    survivors: byStrategy.filter(function(s) { return s.survivesCosts; }).map(function(s) { return s.strategy; }),
    killedByCosts: byStrategy.filter(function(s) { return s.grossPositive && !s.survivesCosts; }).map(function(s) { return s.strategy; }),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv);
  if (!args.data) {
    console.error("Usage: node backtest.js --data <candles.json> [--initial 10000000] [--stop-loss -2] [--take-profit 5] [--max-order-value 300000]");
    process.exit(1);
  }
  const dataPath = path.resolve(args.data);
  if (!fs.existsSync(dataPath)) {
    console.error("[backtest] Data file not found: " + dataPath);
    process.exit(1);
  }
  const candles = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  if (!Array.isArray(candles) || candles.length === 0) {
    console.error("[backtest] Data file must be a non-empty JSON array of candles");
    process.exit(1);
  }

  console.log("[backtest] Loaded " + candles.length + " candles from " + dataPath);
  console.log("[backtest] Config: initial=" + args.initial + " KRW, stopLoss=" + args.stopLoss + "%, takeProfit=" + args.takeProfit + "%, maxOrder=" + args.maxOrderValueKrw + " KRW");

  // [2026-10-21] Validate the input BEFORE the run so the operator sees the
  // reason a dataset is unusable instead of a silently flat result.
  const validation = validateCandleData(candles);
  if (!validation.ok) {
    console.error("[backtest] INPUT DATA REJECTED: " + validation.invalidReason);
    for (const issue of validation.issues) console.error("[backtest]   - " + issue);
    console.error("[backtest] No result was written. Fix or replace the candle data first.");
    process.exit(2);
  }
  console.log("[backtest] Data validation OK: " + validation.metadata.symbolCount + " symbol(s), "
    + validation.metadata.candleCount + " candles, " + validation.metadata.dataStart
    + " .. " + validation.metadata.dataEnd + ", valid ratio " + validation.metadata.validCandleRatio);

  // [2026-10-21 3단계] Apply the previous measurement, if one was given.
  //
  // This is the closed loop: the measurement says which entry signals lose
  // money after costs, and the next run refuses those signals and sizes the
  // survivors by their measured edge. It is fail-closed in the same way the
  // rest of the measurement system is: an analysis whose own validation failed,
  // or which carries no valid trade set, applies NOTHING. A broken analysis
  // can never change what is traded.
  if (args.analysis) {
    try {
      const _ap = path.resolve(args.analysis);
      if (!fs.existsSync(_ap)) {
        console.warn("[backtest] --analysis file not found (" + _ap + ") — running without the previous measurement");
      } else {
        const _prev = JSON.parse(fs.readFileSync(_ap, "utf8"));
        const _prevMeta = _prev && _prev.meta;
        const _prevValid = _prevMeta && _prevMeta.validation === "ok" && _prevMeta.confidence !== "none";
        const _prevTa = _prev && _prev.tradeAnalytics;
        if (!_prevValid || !_prevTa || !_prevTa.valid) {
          console.warn("[backtest] The previous measurement is not valid (validation="
            + (_prevMeta ? _prevMeta.validation : "missing") + ", trades="
            + (_prevTa ? _prevTa.totalTrades : 0) + ") — NO blocklist and NO size adjustment applied");
        } else {
          const _blockedNames = (_prevTa.blocklist && _prevTa.blocklist.blocked || []).map(function (b) { return b.strategy; });
          args.blockedStrategies = _blockedNames;
          args.edgeMultipliers = _prevTa.edgeMultipliers || {};
          console.log("[backtest] Applied the previous measurement: blocking " + (_blockedNames.length ? _blockedNames.join(", ") : "(nothing)") + "; edge multipliers " + JSON.stringify(args.edgeMultipliers));
        }
      }
    } catch (e) {
      console.warn("[backtest] Failed to read the previous measurement (" + e.message + ") — running without it");
    }
  }

  const result = runBacktest(candles, args);

  console.log("");
  console.log("=== Backtest Results ===");
  console.log("Initial equity : " + result.initialEquity.toLocaleString() + " KRW");
  console.log("Final equity   : " + result.finalEquity.toLocaleString() + " KRW");
  console.log("Total return   : " + result.totalReturnPct + "%");
  console.log("Max drawdown   : " + result.maxDrawdownPct + "%");
  console.log("Sharpe (ann.)  : " + result.sharpe);
  console.log("Trades         : " + result.trades + " (BUY " + result.buys + " / SELL " + result.sells + ")");
  console.log("Win rate       : " + result.winRatePct + "% (" + result.wins + "W / " + result.losses + "L)");
  console.log("Validation     : " + result.meta.validation + " (confidence " + result.meta.confidence + ")"
    + (result.meta.invalidReason ? " — " + result.meta.invalidReason : ""));
  console.log("");
  // [2026-10-21] Gross vs net. The equity return alone cannot tell a
  // strategy that earned from one that churned through a bigger gross P&L
  // and lost it all to the costs, so both are printed with the cost that
  // separates them.
  console.log("=== Gross vs Net ===");
  console.log("Gross P&L      : " + result.grossPnl + " (win rate " + result.grossWinRatePct + "%)");
  console.log("Total costs    : " + result.totalCosts
    + " (commission " + result.costBreakdown.commission
    + ", tax " + result.costBreakdown.tax
    + ", spread " + result.costBreakdown.spread
    + ", slippage " + result.costBreakdown.slippage
    + ", impact " + result.costBreakdown.impact + ")");
  console.log("Net P&L        : " + result.netPnl);
  console.log("Cost ratio     : " + (result.costRatio == null ? "n/a" : result.costRatio)
    + (result.costRatio != null && result.costRatio > 1 ? "  <-- the costs ate more than the gross" : ""));
  console.log("Round-trip cost: " + result.roundTripCostPct + "% per round trip (profile " + result.costProfile + ")");
  console.log("");

  // [2026-10-21] The per-strategy classification: which strategies survive
  // the costs and which are gross winners that die net.
  if (result.byStrategy && result.byStrategy.length > 0) {
    console.log("=== Per strategy (gross vs net) ===");
    for (const s of result.byStrategy) {
      console.log("  " + String(s.strategy).padEnd(18)
        + " trades=" + String(s.trades).padStart(4)
        + " gross=" + String(s.grossPnl).padStart(12)
        + " net=" + String(s.netPnl).padStart(12)
        + " costRatio=" + (s.costRatio == null ? "n/a" : s.costRatio)
        + (s.survivesCosts ? "  SURVIVES" : "  killed by costs"));
    }
    console.log("");
  }

  // [2026-10-21] The cost sensitivity analysis: the same trade set under the
  // optimistic, base and pessimistic cost scenarios, and what survives.
  let sensitivity = null;
  if (args.sensitivity) {
    console.log("=== Cost sensitivity ===");
    sensitivity = runCostSensitivity(candles, args);
    for (const name of PROFILE_NAMES) {
      const r = sensitivity.runs[name];
      console.log("  " + name.padEnd(12)
        + " roundTripCost=" + String(r.roundTripCostPct).padStart(7) + "%"
        + " trades=" + String(r.trades).padStart(4)
        + " gross=" + String(r.grossPnl).padStart(12)
        + " net=" + String(r.netPnl).padStart(12)
        + " return=" + String(r.totalReturnPct).padStart(8) + "%"
        + " sharpe=" + String(r.sharpe).padStart(7));
    }
    console.log("  survivors        : " + (sensitivity.survivors.join(", ") || "(none)"));
    console.log("  killed by costs  : " + (sensitivity.killedByCosts.join(", ") || "(none)"));
    console.log("");
  }

  if (process.env.BACKTEST_VERBOSE === "true") {
    for (const t of result.tradeLog) {
      console.log("  " + t.date + " " + t.side.padEnd(4) + " " + t.symbol + " qty=" + t.qty + " @ " + t.price
        + (t.pnl != null ? " pnl=" + Math.round(t.pnl) : "") + " (" + t.reason + ")");
    }
  }

  // [2026-10-21] Fail-closed write gate.
  //
  // A result is only written as the canonical backtest-result.json when the
  // input validated cleanly AND the run actually produced trades. A 0-trade
  // run is a computation failure, not a strategy verdict, and must never
  // overwrite a previous good result — that is exactly how a broken dataset
  // reached the live risk loop in the first place.
  const outPath = path.join(path.dirname(dataPath), "backtest-result.json");
  const quarantinePath = path.join(path.dirname(dataPath), "backtest-result.invalid.json");
  const trustworthy = result.meta.validation === "ok"
    && result.meta.confidence === "high"
    && result.trades > 0;

  try {
    if (trustworthy) {
      fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf8");
      console.log("[backtest] Full result written to " + outPath);
    } else {
      const reason = result.trades === 0
        ? "no trades were generated — the input cannot be traded, or the strategy did not fire"
        : (result.meta.invalidReason || "validation did not pass");
      fs.writeFileSync(quarantinePath, JSON.stringify(result, null, 2), "utf8");
      console.error("[backtest] RESULT NOT TRUSTWORTHY (" + reason + ")");
      console.error("[backtest] Quarantined to " + quarantinePath + " — the previous " + outPath + " was left untouched.");
      process.exitCode = 3;
    }
  } catch (e) {
    console.error("[backtest] Failed to write result: " + e.message);
    process.exitCode = 1;
  }

  // [2026-10-21] The sensitivity analysis is written next to the result so
  // that the operator can see which strategies survive the costs without
  // re-running the backtest.
  if (sensitivity) {
    try {
      const sensPath = path.join(path.dirname(dataPath), "backtest-cost-sensitivity.json");
      fs.writeFileSync(sensPath, JSON.stringify(sensitivity, null, 2), "utf8");
      console.log("[backtest] Cost sensitivity written to " + sensPath);
    } catch (e) {
      console.error("[backtest] Failed to write the sensitivity analysis: " + e.message);
    }
  }

  // [P2-10 Integration] Feed backtest SELL trades into knowledge store
  if (args.knowledgeFeed && result.tradeLog && result.tradeLog.length > 0) {
    const ksPath = args.knowledgePath || path.join(__dirname, ".knowledge.json");
    const ks = createKnowledgeStore({ path: ksPath });
    let fed = 0;
    for (const t of result.tradeLog) {
      if (t.side === "SELL" && t.pnl != null) {
        ks.recordOutcome({
          symbol: t.symbol,
          action: "SELL",
          strategy: "backtest",
          score: 0,
          pnl: t.pnl,
          reason: "backtest_feed:" + (t.reason || ""),
        });
        fed++;
      }
    }
    console.log("[backtest] Fed " + fed + " SELL outcomes to knowledge store (" + ksPath + ")");
    console.log("[backtest] Knowledge store stats: " + JSON.stringify(ks.stats()));
  }
}

if (require.main === module) main();

module.exports = { runBacktest, runCostSensitivity, decide, sma, changePct, parseArgs, applySlippage, buildCostConfig };
