"use strict";

/**
 * [2026-10-21 3단계] Tests for the strategy analysis and the measured
 * blocklist.
 *
 * The point of this file is that the analysis must be able to say "this
 * signal loses money, stop trading it" AND that it must refuse to say
 * anything when it has not measured enough. The second half matters more: the
 * old feedback loop turned a broken measurement into a live risk change.
 */

const test = require("node:test");
const assert = require("node:assert");

const {
  analyzeTrades,
  deriveSignalBlocklist,
  deriveEdgeMultipliers,
  summarizeRun,
} = require("../src/strategy/trade-analytics");
const { generateSignal, DEFAULT_PARAMS } = require("../src/strategy/signals");
const positionSizer = require("../src/agent/positionSizer");

/**
 * A synthetic closed round trip.
 */
function trade(o) {
  return Object.assign({
    side: "SELL", symbol: "AAPL", date: "2026-01-02",
    entryStrategy: "momentum", entryScore: 4, entryReasons: ["sma5>sma20 uptrend"],
    regime: "bull", exitKind: "take_profit", exitReason: "take_profit", exitStrategy: "risk_exit",
    holdingBars: 5, grossPnl: 0, netPnl: 0, totalCosts: 0,
  }, o || {});
}

test("the analysis separates the strategies, the exits, the confidence, the holding period, the symbols, the regimes and the entry reasons", function () {
  const trades = [
    trade({ entryStrategy: "momentum", netPnl: 10, grossPnl: 20, totalCosts: 10, exitKind: "take_profit", exitReason: "take_profit", holdingBars: 5, entryScore: 4, regime: "bull", symbol: "AAPL", entryReasons: ["sma5>sma20 uptrend"] }),
    trade({ entryStrategy: "momentum", netPnl: -8, grossPnl: 2, totalCosts: 10, exitKind: "stop_loss", exitReason: "stop_loss", holdingBars: 2, entryScore: 4, regime: "bear", symbol: "MSFT", entryReasons: ["sma5>sma20 uptrend"] }),
    trade({ entryStrategy: "pullback", netPnl: -30, grossPnl: -20, totalCosts: 10, exitKind: "trend_exit", exitReason: "trend_exit", holdingBars: 12, entryScore: 2, regime: "sideways", symbol: "AAPL", entryReasons: ["RSI oversold 28"] }),
    trade({ entryStrategy: "mean_reversion", netPnl: 25, grossPnl: 30, totalCosts: 5, exitKind: "take_profit", exitReason: "take_profit", holdingBars: 20, entryScore: 7, regime: "sideways", symbol: "QQQ", entryReasons: ["RSI oversold 25"] }),
  ];
  const a = analyzeTrades(trades);
  assert.strictEqual(a.totalTrades, 4);
  assert.strictEqual(a.valid, true);
  // Per strategy.
  assert.strictEqual(a.byEntryStrategy.momentum.trades, 2);
  assert.strictEqual(a.byEntryStrategy.momentum.netPnl, 2);
  assert.strictEqual(a.byEntryStrategy.pullback.netPnl, -30);
  // Per exit reason.
  assert.strictEqual(a.byExitReason.take_profit.trades, 2);
  assert.strictEqual(a.byExitReason.stop_loss.trades, 1);
  assert.strictEqual(a.byExitReason.trend_exit.trades, 1);
  // Per confidence bucket.
  assert.strictEqual(a.byConfidenceBucket["4-5"].trades, 2);
  assert.strictEqual(a.byConfidenceBucket["2-3"].trades, 1);
  assert.strictEqual(a.byConfidenceBucket["6-7"].trades, 1);
  // Per holding period.
  assert.strictEqual(a.byHoldingBucket["4-7 bars"].trades, 1);
  assert.strictEqual(a.byHoldingBucket["15+ bars"].trades, 1);
  // Per symbol, per regime.
  assert.strictEqual(a.bySymbol.AAPL.trades, 2);
  assert.strictEqual(a.byRegime.bull.trades, 1);
  // Per entry reason: the evidence line is attributed the P&L of every trade
  // that carried it.
  assert.strictEqual(a.byEntryReason["sma5>sma20 uptrend"].trades, 2);
  assert.strictEqual(a.byEntryReason["sma5>sma20 uptrend"].netPnl, 2);
  // The aggregate.
  assert.strictEqual(a.overall.netPnl, -3);
  assert.strictEqual(a.overall.trades, 4);
  assert.ok(a.overall.winRate > 0 && a.overall.winRate < 1);
});

test("a strategy that loses money after costs is blocked, and the reason says so", function () {
  const trades = [];
  for (let i = 0; i < 20; i++) trades.push(trade({ entryStrategy: "default_buy", netPnl: -5, grossPnl: 5, totalCosts: 10 }));
  for (let i = 0; i < 20; i++) trades.push(trade({ entryStrategy: "mean_reversion", netPnl: 5, grossPnl: 10, totalCosts: 5 }));
  const bl = deriveSignalBlocklist(analyzeTrades(trades), { minTrades: 15 });
  const blocked = bl.blocked.map(function (b) { return b.strategy; });
  assert.ok(blocked.indexOf("default_buy") >= 0, "default_buy must be blocked");
  assert.ok(blocked.indexOf("mean_reversion") < 0, "mean_reversion must not be blocked");
  const def = bl.blocked.find(function (b) { return b.strategy === "default_buy"; });
  // Gross positive, net negative: killed by costs, and it has to say that.
  assert.strictEqual(def.grossPositiveNetNegative, true);
  assert.ok(def.reason.indexOf("killed by costs") >= 0, "the reason must name the cost: " + def.reason);
});

test("a strategy with too few trades is neither blocked nor adjusted", function () {
  const trades = [];
  for (let i = 0; i < 5; i++) trades.push(trade({ entryStrategy: "rare_signal", netPnl: -5, grossPnl: -5, totalCosts: 0 }));
  for (let i = 0; i < 20; i++) trades.push(trade({ entryStrategy: "momentum", netPnl: 5, grossPnl: 10, totalCosts: 5 }));
  const bl = deriveSignalBlocklist(analyzeTrades(trades), { minTrades: 15 });
  assert.strictEqual(bl.blocked.length, 0, "an unmeasured strategy must not be blocked");
  assert.ok(bl.unmeasured.some(function (u) { return u.strategy === "rare_signal"; }));
  // And it must not be resized either.
  const mult = deriveEdgeMultipliers(analyzeTrades(trades), { minTrades: 15 });
  assert.strictEqual(mult.rare_signal, undefined);
});

test("no trades means no blocklist and no resizing — a broken measurement changes nothing", function () {
  const bl = deriveSignalBlocklist(analyzeTrades([]), { minTrades: 15 });
  assert.strictEqual(bl.blocked.length, 0);
  assert.strictEqual(bl.kept.length, 0);
  assert.ok(bl.reason && bl.reason.indexOf("no closed round trips") >= 0);
  assert.deepStrictEqual(deriveEdgeMultipliers(analyzeTrades([]), {}), {});
});

test("the edge multiplier follows the measured profit factor and is clamped", function () {
  const trades = [];
  for (let i = 0; i < 20; i++) trades.push(trade({ entryStrategy: "good", netPnl: 10, grossPnl: 10, totalCosts: 0 }));
  for (let i = 0; i < 20; i++) trades.push(trade({ entryStrategy: "bad", netPnl: -1, grossPnl: 0, totalCosts: 1 }));
  const mult = deriveEdgeMultipliers(analyzeTrades(trades), { minTrades: 15, min: 0.5, max: 1.5 });
  // The good strategy has a profit factor above 1, the bad one below 1.
  assert.ok(mult.good > 1, "the good strategy should be allowed a larger size, got " + mult.good);
  assert.ok(mult.bad < 1, "the bad strategy should be sized smaller, got " + mult.bad);
  assert.ok(mult.good <= 1.5 && mult.bad >= 0.5, "the multipliers must be clamped");
});

test("the signal engine refuses a blocked strategy — the loss signal never becomes an entry", function () {
  const ctx = {
    lastClose: 100, sma5: 99, sma20: 95, changePct5d: 2, rsi14: 50,
    macd: { histogram: 1, macd: 1, signal: 0 },
    ema9: 101, ema21: 99, atr14: 2, vwap: 99, bollinger: { upper: 105, middle: 100, lower: 95, sd: 3 },
    volume: 1000, sma5Raw: 99, sma20Raw: 95,
  };
  const open = generateSignal(ctx, null, { ...DEFAULT_PARAMS, market: "US" });
  assert.strictEqual(open.action, "BUY", "the fixture must produce a BUY without the blocklist");
  assert.ok(open.strategy, "the fixture must name a strategy");
  const blocked = generateSignal(ctx, null, { ...DEFAULT_PARAMS, market: "US", blockedStrategies: [open.strategy] });
  assert.strictEqual(blocked.action, "HOLD", "a blocked strategy must not produce an entry");
  assert.ok(blocked.reasons.join(" ").indexOf("blocked by the measured signal analysis") >= 0, "the reason must say why");
});

test("the position size follows the measured edge multiplier", function () {
  const base = { equity: 10000000, price: 100, atr: 2, fxRate: 1, capEquity: 10000000, maxPositionPct: 15 };
  const plain = positionSizer.sizePosition(base);
  const half = positionSizer.sizePosition({ ...base, edgeMultiplier: 0.5 });
  assert.ok(half.qty < plain.qty, "a lower edge multiplier must produce a smaller position");
  assert.ok(half.qty > 0, "the position must still exist");
  // No measurement means no change.
  const none = positionSizer.sizePosition({ ...base, edgeMultiplier: undefined });
  assert.strictEqual(none.qty, plain.qty, "without a measurement the size must be unchanged");
});

test("the run summary reports the metrics the phase compares on", function () {
  const trades = [];
  for (let i = 0; i < 20; i++) trades.push(trade({ entryStrategy: "momentum", netPnl: 4, grossPnl: 8, totalCosts: 4 }));
  const s = summarizeRun({ totalReturnPct: 1.2, maxDrawdownPct: 3.4, sharpe: 0.7, trades: trades });
  assert.strictEqual(s.netExpectancy, 4);
  assert.ok(s.profitFactor > 0);
  assert.strictEqual(s.turnover, 20);
  assert.ok(Math.abs(s.costRatio - 0.5) < 0.0001, "the cost ratio must be the costs over the gross");
  assert.strictEqual(s.maxDrawdownPct, 3.4);
  assert.strictEqual(s.sharpe, 0.7);
});
