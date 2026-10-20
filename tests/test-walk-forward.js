"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createWalkForwardValidator, buildFolds, computeFitness, DEFAULT_CONFIG } = require("../src/orchestrator/walk-forward");
const { DEFAULT_GENE_BOUNDS } = require("../src/orchestrator/evolution");

// --- Helper: generate synthetic candles with a trend + noise ---
function generateCandles(n, startPrice, drift, vol, seed) {
  let s = seed | 0;
  function rng() {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function norm() {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  const candles = [];
  let price = startPrice;
  for (let i = 0; i < n; i++) {
    const ret = drift + vol * norm();
    price = price * (1 + ret);
    const high = price * (1 + Math.abs(norm()) * 0.005);
    const low = price * (1 - Math.abs(norm()) * 0.005);
    const open = price * (1 + (rng() - 0.5) * 0.002);
    candles.push({
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(price.toFixed(2)),
      volume: Math.floor(100000 + rng() * 900000),
      timestamp: Date.now() - (n - i) * 60000,
    });
  }
  return candles;
}

// --- Mock backtest function ---
function mockBacktest(candles, args) {
  if (!candles || candles.length < 2) return { sharpe: 0, trades: 0, winRatePct: 0, maxDrawdownPct: 0 };
  const stopLoss = args.stopLoss || -2.0;
  const takeProfit = args.takeProfit || 5.0;
  let trades = 0, wins = 0, losses = 0;
  let peak = candles[0].close, maxDD = 0;
  let equity = args.initial || 10000000;
  const returns = [];
  for (let i = 1; i < candles.length; i++) {
    const ret = (candles[i].close - candles[i - 1].close) / candles[i - 1].close;
    // Simple strategy: buy if RSI-like momentum is positive
    if (i > 5) {
      const momentum = (candles[i].close - candles[i - 5].close) / candles[i - 5].close;
      if (momentum > 0.01) {
        trades++;
        const pnlPct = ret * 100;
        if (pnlPct >= takeProfit) { wins++; returns.push(takeProfit / 100); }
        else if (pnlPct <= stopLoss) { losses++; returns.push(stopLoss / 100); }
        else { returns.push(pnlPct / 100); if (pnlPct > 0) wins++; else losses++; }
      }
    }
    equity *= (1 + ret * 0.1); // 10% position size
    if (equity > peak) peak = equity;
    const dd = ((peak - equity) / peak) * 100;
    if (dd > maxDD) maxDD = dd;
  }
  const avgRet = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const stdRet = returns.length > 1
    ? Math.sqrt(returns.reduce((s, r) => s + (r - avgRet) * (r - avgRet), 0) / (returns.length - 1))
    : 1;
  const sharpe = stdRet > 0 ? (avgRet / stdRet) * Math.sqrt(252) : 0;
  return {
    sharpe: Number(sharpe.toFixed(4)),
    trades: trades,
    winRatePct: trades > 0 ? Number(((wins / trades) * 100).toFixed(2)) : 0,
    maxDrawdownPct: Number(maxDD.toFixed(2)),
    totalReturn: Number(((equity / (args.initial || 10000000)) - 1) * 100).toFixed(2),
  };
}

// --- buildFolds ---
test("buildFolds returns correct number of folds", () => {
  const candles = generateCandles(500, 100, 0.001, 0.02, 42);
  const folds = buildFolds(candles, { trainWindowBars: 200, testWindowBars: 50, stepBars: 50 });
  // (500 - 200 - 50) / 50 + 1 = 6 folds
  assert.equal(folds.length, 6);
  assert.equal(folds[0].trainCandles.length, 200);
  assert.equal(folds[0].testCandles.length, 50);
});

test("buildFolds returns empty for insufficient data", () => {
  const candles = generateCandles(100, 100, 0.001, 0.02, 42);
  const folds = buildFolds(candles, { trainWindowBars: 200, testWindowBars: 50, stepBars: 50 });
  assert.equal(folds.length, 0);
});

test("buildFolds folds are sequential and non-overlapping train/test", () => {
  const candles = generateCandles(500, 100, 0.001, 0.02, 42);
  const folds = buildFolds(candles, { trainWindowBars: 200, testWindowBars: 50, stepBars: 50 });
  for (const f of folds) {
    assert.equal(f.trainEnd, f.testStart);
    assert.ok(f.trainCandles.length === 200);
    assert.ok(f.testCandles.length === 50);
  }
});

// --- computeFitness ---
test("computeFitness returns finite synthetic for insufficient trades (P11-WF)", () => {
  // [P11-WF] Changed behavior: synthetic fitness fallback instead of -Infinity
  const fit = computeFitness({ sharpe: 1.5, trades: 2, winRatePct: 60, maxDrawdownPct: 5 }, { minTrades: 5 });
  assert.ok(Number.isFinite(fit), "expected finite synthetic fitness, got " + fit);
  assert.ok(fit < 0.5, "synthetic fitness should be capped below real-trades range, got " + fit);
});

// --- createWalkForwardValidator ---
test("createWalkForwardValidator returns instance with expected API", () => {
  const wf = createWalkForwardValidator({ candles: [], runBacktest: mockBacktest });
  assert.equal(typeof wf.validate, "function");
  assert.equal(typeof wf.validateGenome, "function");
  assert.equal(typeof wf.stats, "function");
  assert.equal(typeof wf.getHistory, "function");
  assert.equal(typeof wf.clear, "function");
});

test("validate returns insufficient_data for empty candles", () => {
  const wf = createWalkForwardValidator({ candles: [], runBacktest: mockBacktest });
  const result = wf.validate();
  assert.equal(result.verdict, "insufficient_data");
});

test("validate returns insufficient_data when too few folds possible", () => {
  const candles = generateCandles(200, 100, 0.001, 0.02, 42);
  const wf = createWalkForwardValidator({
    candles: candles,
    runBacktest: mockBacktest,
    config: { trainWindowBars: 150, testWindowBars: 50, stepBars: 50, minFolds: 3 },
  });
  const result = wf.validate();
  assert.equal(result.verdict, "insufficient_data");
});

test("validate runs folds and produces verdict with summary", () => {
  const candles = generateCandles(500, 100, 0.002, 0.015, 77);
  const wf = createWalkForwardValidator({
    candles: candles,
    runBacktest: mockBacktest,
    geneBounds: DEFAULT_GENE_BOUNDS,
    config: {
      trainWindowBars: 100, testWindowBars: 30, stepBars: 50, minFolds: 2,
      populationSize: 8, generations: 3,
      minOosSharpe: -1.0, // very permissive for synthetic data
      maxFitnessDegradation: 10.0,
      minOosTrades: 1,
      seed: 42,
    },
  });
  const result = wf.validate();
  assert.ok(["deploy", "reject"].includes(result.verdict), "verdict should be deploy or reject, got " + result.verdict);
  assert.ok(result.folds.length >= 2);
  assert.ok(result.summary);
  assert.equal(result.summary.totalFolds, result.folds.length);
  // Every fold should have IS and OOS fitness populated
  for (const f of result.folds) {
    assert.ok(f.foldIndex != null);
    assert.ok(f.trainBars > 0);
    assert.ok(f.testBars > 0);
  }
});

test("validate emits reject when OOS sharpe is below threshold", () => {
  // Use tiny candle set + impossible threshold to force reject
  const candles = generateCandles(400, 100, -0.005, 0.05, 88); // bearish, noisy
  const wf = createWalkForwardValidator({
    candles: candles,
    runBacktest: mockBacktest,
    geneBounds: DEFAULT_GENE_BOUNDS,
    config: {
      trainWindowBars: 100, testWindowBars: 30, stepBars: 50, minFolds: 2,
      populationSize: 6, generations: 2,
      minOosSharpe: 50.0, // truly unreachable → must reject
      maxFitnessDegradation: 100.0,
      minOosTrades: 1,
      seed: 42,
    },
  });
  const result = wf.validate();
  assert.equal(result.verdict, "reject");
  assert.ok(result.reason.length > 0);
});

test("validateGenome evaluates a specific genome OOS", () => {
  const candles = generateCandles(100, 100, 0.001, 0.02, 99);
  const wf = createWalkForwardValidator({
    candles: candles,
    runBacktest: mockBacktest,
    geneBounds: DEFAULT_GENE_BOUNDS,
    config: { minOosTrades: 1 },
  });
  const genome = {
    STOP_LOSS_PCT: -3.0,
    TAKE_PROFIT_PCT: 6.0,
    TRAILING_STOP_PCT: 3.0,
    RSI_BUY_THRESHOLD: 40,
    RSI_SELL_THRESHOLD: 70,
    POSITION_SIZE_PCT: 10.0,
    ADAPTIVE_TARGET_OFFSET: 0.0,
  };
  const result = wf.validateGenome(genome, candles);
  assert.equal(result.ok, true);
  assert.ok(Number.isFinite(result.fitness));
  assert.ok(result.trades >= 0);
});

test("validateGenome returns error for missing inputs", () => {
  const wf = createWalkForwardValidator({ candles: [], runBacktest: mockBacktest });
  const r1 = wf.validateGenome(null, []);
  assert.equal(r1.ok, false);
  const r2 = wf.validateGenome({ STOP_LOSS_PCT: -2.0 }, null);
  assert.equal(r2.ok, false);
});

test("stats and history track validation runs", () => {
  const candles = generateCandles(400, 100, 0.001, 0.02, 55);
  const wf = createWalkForwardValidator({
    candles: candles,
    runBacktest: mockBacktest,
    geneBounds: DEFAULT_GENE_BOUNDS,
    config: {
      trainWindowBars: 100, testWindowBars: 30, stepBars: 100, minFolds: 2,
      populationSize: 5, generations: 2,
      minOosSharpe: -5.0, maxFitnessDegradation: 100.0, minOosTrades: 1, seed: 42,
    },
  });
  wf.validate();
  wf.validate();
  const s = wf.stats();
  assert.equal(s.totalValidations, 2);
  assert.ok(s.lastVerdict);
  assert.equal(wf.getHistory().length, 2);
});

test("clear resets history and last result", () => {
  const candles = generateCandles(400, 100, 0.001, 0.02, 33);
  const wf = createWalkForwardValidator({
    candles: candles,
    runBacktest: mockBacktest,
    geneBounds: DEFAULT_GENE_BOUNDS,
    config: {
      trainWindowBars: 100, testWindowBars: 30, stepBars: 100, minFolds: 2,
      populationSize: 5, generations: 2,
      minOosSharpe: -5.0, maxFitnessDegradation: 100.0, minOosTrades: 1, seed: 42,
    },
  });
  wf.validate();
  wf.clear();
  assert.equal(wf.stats().totalValidations, 0);
  assert.equal(wf.stats().lastVerdict, null);
  assert.equal(wf.getHistory().length, 0);
});

test("onFold callback is invoked per fold", () => {
  const candles = generateCandles(400, 100, 0.001, 0.02, 22);
  const seen = [];
  const wf = createWalkForwardValidator({
    candles: candles,
    runBacktest: mockBacktest,
    geneBounds: DEFAULT_GENE_BOUNDS,
    onFold: (f) => seen.push(f.foldIndex),
    config: {
      trainWindowBars: 100, testWindowBars: 30, stepBars: 100, minFolds: 2,
      populationSize: 5, generations: 2,
      minOosSharpe: -5.0, maxFitnessDegradation: 100.0, minOosTrades: 1, seed: 42,
    },
  });
  wf.validate();
  assert.ok(seen.length >= 2);
  assert.deepEqual(seen.slice(0, 2), [0, 1]);
});

test("computeFitness returns finite value for valid result", () => {
  const fit = computeFitness({ sharpe: 1.5, trades: 20, winRatePct: 60, maxDrawdownPct: 5 }, { minTrades: 5 });
  assert.ok(Number.isFinite(fit));
  assert.ok(fit > 0);
});

test("computeFitness penalizes high drawdown", () => {
  const fitLow = computeFitness({ sharpe: 1.0, trades: 20, winRatePct: 55, maxDrawdownPct: 10 }, { minTrades: 5 });
  const fitHigh = computeFitness({ sharpe: 1.0, trades: 20, winRatePct: 55, maxDrawdownPct: 40 }, { minTrades: 5 });
  assert.ok(fitLow > fitHigh);
});
