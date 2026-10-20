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
    commissionPct: 0.015,    // Toss commission 0.015%
    // [P2-10] Knowledge store integration
    knowledgeFeed: false,    // --knowledge-feed: write results to .knowledge.json
    knowledgePath: null,     // --knowledge-path <file>: custom knowledge store path
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--data") args.data = argv[++i];
    else if (a === "--initial") args.initial = Number(argv[++i]);
    else if (a === "--stop-loss") args.stopLoss = Number(argv[++i]);
    else if (a === "--take-profit") args.takeProfit = Number(argv[++i]);
    else if (a === "--max-order-value") args.maxOrderValueKrw = Number(argv[++i]);
    else if (a === "--slippage") args.slippagePct = Number(argv[++i]);
    else if (a === "--impact") args.impactCoefficient = Number(argv[++i]);
    else if (a === "--partial-fill") args.partialFillRate = Number(argv[++i]);
    else if (a === "--commission") args.commissionPct = Number(argv[++i]);
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

function decide(closes, portfolio, symbol, opts) {
  const ctx = buildCtx(closes, opts);
  const pos = portfolio.positions.get(symbol);
  const signal = generateSignal(ctx, pos ? { avgPrice: pos.avgPrice, qty: pos.qty } : null, {
    ...DEFAULT_PARAMS,
    stopLossPct: opts.stopLoss,
    takeProfitPct: opts.takeProfit,
  });
  return { action: signal.action, reason: signal.reasons.join("; "), score: signal.score };
}

// ---------------------------------------------------------------------------
// [P3-13] Slippage & market impact model
// ---------------------------------------------------------------------------
// Realistic execution cost model:
//   executedPrice = signalPrice × (1 ± slippagePct/100 ± impact)
//   impact = impactCoefficient × sqrt(orderValue / avgDailyVolume)
//   partial fills: only partialFillRate of intended qty is executed
//   commission: applied to both entry and exit
function applySlippage(price, side, orderValue, avgVolume, opts) {
  const slip = (opts.slippagePct || 0) / 100;
  const commission = (opts.commissionPct || 0) / 100;
  let impact = 0;
  if (opts.impactCoefficient > 0 && avgVolume && avgVolume > 0) {
    // Participation rate = order / daily volume; impact ∝ sqrt(participation)
    const participation = orderValue / avgVolume;
    impact = opts.impactCoefficient * Math.sqrt(participation) / 100;
  }
  // BUY: pay more; SELL: receive less
  const direction = side === "BUY" ? 1 : -1;
  const adjustedPrice = price * (1 + direction * (slip + impact));
  const commissionCost = Math.abs(adjustedPrice * commission);
  const fillRate = Math.max(0.01, Math.min(1.0, Number(opts.partialFillRate) || 1));
  return {
    executedPrice: adjustedPrice,
    commissionPerShare: commissionCost,
    fillRate,
    effectiveCost: adjustedPrice + direction * commissionCost,
    slipPct: slip * 100,
    impactPct: impact * 100,
  };
}

// ---------------------------------------------------------------------------
// Portfolio simulation
// ---------------------------------------------------------------------------
function runBacktest(candles, opts) {
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

  // Group candles by symbol while preserving insertion order
  const bySymbol = new Map();
  for (const c of candles) {
    if (!bySymbol.has(c.symbol)) bySymbol.set(c.symbol, []);
    bySymbol.get(c.symbol).push(c);
  }

  // Build a merged timeline of unique dates (ascending)
  const allDates = [...new Set(candles.map((c) => c.date))].sort();

  for (const date of allDates) {
    for (const [symbol, series] of bySymbol) {
      const idx = series.findIndex((c) => c.date === date);
      if (idx < 0) continue;
      const closes = series.slice(0, idx + 1).map((c) => Number(c.close));
      const price = closes[closes.length - 1];
      if (!price || closes.length < 3) continue;

      const decision = decide(closes, portfolio, symbol, opts);
      // [P3-13] Use high-low spread as a proxy for average daily volume
      const recentHigh = series[idx].high ? Number(series[idx].high) : price;
      const recentLow = series[idx].low ? Number(series[idx].low) : price;
      const spread = recentHigh - recentLow;
      const avgVolume = series[idx].volume ? Number(series[idx].volume) * price : (price * 10000);

      if (decision.action === "BUY") {
        const intendedQty = Math.max(1, Math.floor(opts.maxOrderValueKrw / price));
        const slip = applySlippage(price, "BUY", intendedQty * price, avgVolume, opts);
        const qty = Math.max(1, Math.floor(intendedQty * slip.fillRate));
        const costPerShare = slip.effectiveCost;
        const totalCost = costPerShare * qty;
        const guard = safety.checkPreCreateOrder({ symbol, side: "BUY", price: costPerShare, quantity: qty });
        if (guard.ok && portfolio.cash >= totalCost) {
          portfolio.cash -= totalCost;
          const pos = portfolio.positions.get(symbol);
          if (pos) {
            const totalQty = pos.qty + qty;
            pos.avgPrice = (pos.avgPrice * pos.qty + costPerShare * qty) / totalQty;
            pos.qty = totalQty;
          } else {
            portfolio.positions.set(symbol, { qty: qty, avgPrice: costPerShare });
          }
          safety.recordPositionOpen(symbol);
          trades.push({
            date: date, symbol: symbol, side: "BUY",
            signalPrice: price, price: Number(costPerShare.toFixed(2)),
            qty: qty, slippagePct: Number(slip.slipPct.toFixed(3)),
            impactPct: Number(slip.impactPct.toFixed(3)),
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
          const pnl = (slip.effectiveCost - pos.avgPrice) * filledQty;
          if (pnl >= 0) wins++; else losses++;
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
            slippagePct: Number(slip.slipPct.toFixed(3)),
            impactPct: Number(slip.impactPct.toFixed(3)),
            partialFill: filledQty < intendedQty,
            reason: decision.reason,
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
  console.log("");

  if (process.env.BACKTEST_VERBOSE === "true") {
    for (const t of result.tradeLog) {
      console.log("  " + t.date + " " + t.side.padEnd(4) + " " + t.symbol + " qty=" + t.qty + " @ " + t.price
        + (t.pnl != null ? " pnl=" + Math.round(t.pnl) : "") + " (" + t.reason + ")");
    }
  }

  // Machine-readable output for CI / tooling
  const outPath = path.join(path.dirname(dataPath), "backtest-result.json");
  try {
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf8");
    console.log("[backtest] Full result written to " + outPath);
  } catch (e) {
    console.error("[backtest] Failed to write result: " + e.message);
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

module.exports = { runBacktest, decide, sma, changePct, parseArgs, applySlippage };
