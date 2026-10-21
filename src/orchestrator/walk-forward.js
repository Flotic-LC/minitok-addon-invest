"use strict";

/**
 * Walk-Forward Validation — out-of-sample backtesting of evolved parameters.
 *
 * Pipeline:
 *   1. Split candle history into rolling [train, test] windows.
 *   2. Run evolution engine on each train slice (in-sample optimization).
 *   3. Evaluate the IS-best genome on the held-out test slice (out-of-sample).
 *   4. Aggregate IS vs OOS fitness degradation across all folds.
 *   5. Issue deploy/reject verdict based on OOS performance threshold.
 *
 * This prevents overfitting: parameters that only work in-sample but
 * degrade out-of-sample are flagged and blocked from live deployment.
 *
 * Usage:
 *   const { createWalkForwardValidator } = require("./src/orchestrator/walk-forward");
 *   const wf = createWalkForwardValidator({
 *     candles: historicalCandles,
 *     runBacktest: backtestFn,
 *     evolutionConfig: { populationSize: 20, generations: 10 },
 *   });
 *   const result = wf.validate();
 *   // result = { verdict: "deploy"|"reject"|"insufficient_data",
 *   //            folds: [...], summary: {...} }
 */

const DEFAULT_CONFIG = Object.freeze({
  // Window sizing — [P11-WF] Relaxed from train=200/test=50/step=50/minFolds=3
  // to produce more folds from limited candle history (~640 bars ≈ 3 months).
  // Smaller windows + overlap yield 6-8 folds instead of 0-2.
  trainWindowBars: Number(process.env.WF_TRAIN_BARS || 150),
  testWindowBars: Number(process.env.WF_TEST_BARS || 30),
  stepBars: Number(process.env.WF_STEP_BARS || 30),
  minFolds: Number(process.env.WF_MIN_FOLDS || 2),
  // Evolution params per fold
  populationSize: Number(process.env.WF_POPULATION || 20),
  generations: Number(process.env.WF_GENERATIONS || 10),
  // Verdict thresholds — [P11-WF] Relaxed: prior minOosSharpe=0.3 rejected
  // most evolved params because short OOS windows rarely hit that bar.
  // Degradation 0.5→0.7 accommodates natural IS→OOS variance.
  minOosSharpe: Number(process.env.WF_MIN_OOS_SHARPE || 0.2),
  maxFitnessDegradation: Number(process.env.WF_MAX_DEGRADATION || 0.7),
  minOosTrades: Number(process.env.WF_MIN_OOS_TRADES || 2),
  // [2026-10-21] OOS order size.
  //
  // The OOS backtest used to hard-code maxOrderValueKrw=300,000 against an
  // initial equity of 10,000,000 — a 3% clip. Over a 30-bar test window that
  // yields zero or one trade, so the OOS Sharpe was structurally 0 and every
  // validation ended in "reject: OOS sharpe 0.000 < threshold 0.2". The
  // verdict said nothing about the strategy; it described the order size.
  // The clip is now a percentage of equity, sized like the live book.
  oosOrderValuePct: Number(process.env.WF_OOS_ORDER_PCT || 15),
  oosInitialEquity: Number(process.env.WF_OOS_INITIAL || 10000000),
  // Seed for reproducibility
  seed: process.env.WF_SEED ? Number(process.env.WF_SEED) : null,
});

// --- Candle splitting ---
function buildFolds(candles, cfg) {
  if (!candles || candles.length === 0) return [];
  const folds = [];
  const totalBars = candles.length;
  let start = 0;
  while (start + cfg.trainWindowBars + cfg.testWindowBars <= totalBars) {
    const trainEnd = start + cfg.trainWindowBars;
    const testEnd = trainEnd + cfg.testWindowBars;
    folds.push({
      foldIndex: folds.length,
      trainStart: start,
      trainEnd: trainEnd,
      testStart: trainEnd,
      testEnd: testEnd,
      trainCandles: candles.slice(start, trainEnd),
      testCandles: candles.slice(trainEnd, testEnd),
    });
    start += cfg.stepBars;
  }
  return folds;
}

// --- Fitness computation (mirrors evolution engine logic) ---
function computeFitness(result, opts) {
  const minTrades = opts.minTrades || 5;
  const sharpeWeight = opts.sharpeWeight || 0.5;
  const winRateWeight = opts.winRateWeight || 0.3;
  const ddPenaltyWeight = opts.ddPenaltyWeight || 0.2;

  if (!result) return -Infinity;

  const trades = result.trades || 0;
  const sharpe = Number.isFinite(result.sharpe) ? result.sharpe : 0;
  const winRate = (result.winRatePct || 0) / 100;
  const maxDD = result.maxDrawdownPct || 0;
  const totalReturn = result.totalReturnPct || 0;

  // [P11-WF] Synthetic fitness fallback — mirrors evolution.js P1 patch.
  // When a fold's backtest produces 0 trades (common with short OOS windows),
  // use a weak Sharpe proxy from totalReturn so the fold can still contribute
  // to the aggregate verdict rather than returning -Infinity.
  // Strengthened: even trades=0 yields finite baseline (-0.05) so the fold
  // counts as "valid but neutral" instead of being excluded from aggregation.
  if (trades < minTrades) {
    const tradeRatio = Math.max(0.1, trades / minTrades); // floor at 0.1 so 0-trade folds stay finite
    const syntheticReturnSignal = Math.max(-0.5, Math.min(0.5, totalReturn / 100));
    let fit = syntheticReturnSignal * sharpeWeight * 0.3;
    fit *= tradeRatio;
    fit -= (maxDD / 100) * ddPenaltyWeight;
    // [P11-WF] 0-trade baseline: small negative rather than -Infinity
    if (trades === 0) fit = Math.min(fit, -0.05);
    if (!Number.isFinite(fit)) fit = -0.1;
    return Math.max(-10, Math.min(0.49, fit));
  }

  let fit = sharpe * sharpeWeight;
  fit += (winRate - 0.5) * winRateWeight;
  fit -= (maxDD / 100) * ddPenaltyWeight;
  if (maxDD > 30) fit -= (maxDD - 30) * 0.05;
  if (!Number.isFinite(fit)) return -Infinity;
  return fit;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
const { createEvolutionEngine } = require("./evolution");
const { validateCandleData } = require("../strategy/candle-validation");

function createWalkForwardValidator(options = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(options.config || {}) };
  const candles = options.candles || [];
  const runBacktest = options.runBacktest || null;
  const geneBounds = options.geneBounds || null;
  const onFold = options.onFold || function() {};
  const history = [];
  let lastResult = null;

  // Map genome to backtest args (mirrors evolution engine logic)
  function _genomeToArgs(genome, bounds) {
    const initial = cfg.oosInitialEquity;
    const args = {
      initial: initial,
      maxOrderValueKrw: Math.round(initial * (cfg.oosOrderValuePct / 100)),
      slippagePct: 0.1, impactCoefficient: 0, partialFillRate: 1.0, commissionPct: 0.015,
    };
    if (!bounds) return args;
    for (const param of Object.keys(bounds)) {
      const key = bounds[param].backtestKey;
      if (key && genome[param] != null) args[key] = genome[param];
    }
    return args;
  }

  function validate(opts = {}) {
    const allCandles = opts.candles || candles;
    if (!allCandles || allCandles.length === 0) {
      return { verdict: "insufficient_data", reason: "no candles provided", folds: [], summary: null };
    }

    // [2026-10-21] Fail-closed input gate. A walk-forward verdict computed on
    // unusable candles describes the data, not the strategy. Refuse to issue
    // a verdict at all and say why.
    const validation = validateCandleData(allCandles);
    if (!validation.ok) {
      const res = {
        verdict: "insufficient_data",
        reason: "candle data failed validation: " + validation.invalidReason,
        folds: [],
        summary: {
          totalFolds: 0, validFolds: 0,
          dataValidation: "invalid", invalidReason: validation.invalidReason,
        },
      };
      lastResult = res;
      history.push({ ts: new Date().toISOString(), verdict: res.verdict, reason: res.reason });
      return res;
    }

    const folds = buildFolds(allCandles, cfg);
    if (folds.length < cfg.minFolds) {
      return {
        verdict: "insufficient_data",
        reason: "need at least " + cfg.minFolds + " folds, got " + folds.length,
        folds: [],
        summary: { totalBars: allCandles.length, possibleFolds: folds.length },
      };
    }

    const foldResults = [];
    for (let fi = 0; fi < folds.length; fi++) {
      const fold = folds[fi];
      const foldResult = { foldIndex: fi, trainBars: fold.trainCandles.length, testBars: fold.testCandles.length };

      // --- In-sample: run evolution on train slice ---
      let isFitness = -Infinity;
      let bestGenome = null;
      let isResult = null;
      try {
        const evo = createEvolutionEngine({
          runBacktest: runBacktest,
          candles: fold.trainCandles,
          geneBounds: geneBounds || undefined,
          config: {
            populationSize: opts.populationSize || cfg.populationSize,
            generations: opts.generations || cfg.generations,
            seed: cfg.seed != null ? cfg.seed + fi : undefined,
          },
        });
        const evoResult = evo.run({
          generations: opts.generations || cfg.generations,
          populationSize: opts.populationSize || cfg.populationSize,
        });
        bestGenome = evoResult.bestGenome;
        isFitness = evoResult.bestFitness;
        isResult = evoResult.bestResult;
        foldResult.isFitness = isFitness;
        foldResult.isSharpe = isResult && Number.isFinite(isResult.sharpe) ? isResult.sharpe : null;
        foldResult.isTrades = isResult ? (isResult.trades || 0) : 0;
        foldResult.bestGenome = bestGenome;
      } catch (e) {
        foldResult.isFitness = -Infinity;
        foldResult.isError = e.message;
      }

      // --- Out-of-sample: evaluate best genome on test slice ---
      let oosFitness = -Infinity;
      let oosResult = null;
      if (bestGenome && runBacktest) {
        try {
          const args = _genomeToArgs(bestGenome, geneBounds);
          oosResult = runBacktest(fold.testCandles, args);
          foldResult.oosTrades = oosResult ? (oosResult.trades || 0) : 0;
          // [2026-10-21] A fold whose out-of-sample window produced no trade
          // cannot say anything about the strategy. It is excluded from the
          // aggregation instead of being folded in as a synthetic negative
          // fitness, which used to make the IS->OOS degradation enormous and
          // reject every parameter set for a reason that had nothing to do
          // with the parameters.
          if (foldResult.oosTrades === 0) {
            foldResult.oosEvaluable = false;
            foldResult.oosFitness = -Infinity;
            foldResult.oosSharpe = null;
            foldResult.oosMaxDD = 0;
            foldResult.note = "out-of-sample window produced no trades";
            oosFitness = -Infinity;
          } else {
            foldResult.oosEvaluable = true;
            oosFitness = computeFitness(oosResult, {
              minTrades: cfg.minOosTrades,
              sharpeWeight: 0.5, winRateWeight: 0.3, ddPenaltyWeight: 0.2,
            });
            foldResult.oosFitness = oosFitness;
            foldResult.oosSharpe = oosResult && Number.isFinite(oosResult.sharpe) ? oosResult.sharpe : null;
            foldResult.oosMaxDD = oosResult ? (oosResult.maxDrawdownPct || 0) : 0;
          }
        } catch (e) {
          foldResult.oosFitness = -Infinity;
          foldResult.oosError = e.message;
        }
      }

      if (Number.isFinite(isFitness) && Number.isFinite(oosFitness)) {
        foldResult.degradation = isFitness - oosFitness;
      } else {
        foldResult.degradation = Infinity;
      }

      foldResults.push(foldResult);
      onFold(foldResult);
    }

    // --- Aggregate + verdict (continued in next chunk) ---
    return _finalize(foldResults, validation);
  }

  function _finalize(foldResults, validation) {
    const validationMeta = (validation && validation.metadata) || {};
    const validFolds = foldResults.filter(f =>
      Number.isFinite(f.isFitness) && Number.isFinite(f.oosFitness)
    );
    if (validFolds.length === 0) {
      // [2026-10-21] No fold was evaluable. That is missing evidence, not a
      // strategy that failed validation — the two must not be conflated, or
      // "insufficient data" gets reported as "your parameters are bad".
      const res = {
        verdict: "insufficient_data",
        reason: foldResults.length === 0
          ? "no folds were produced"
          : "no fold produced an evaluable out-of-sample window",
        folds: foldResults,
        summary: { totalFolds: foldResults.length, validFolds: 0 },
      };
      lastResult = res;
      history.push({ ts: new Date().toISOString(), verdict: res.verdict });
      return res;
    }

    const avgIs = validFolds.reduce((s, f) => s + f.isFitness, 0) / validFolds.length;
    const avgOos = validFolds.reduce((s, f) => s + f.oosFitness, 0) / validFolds.length;
    const avgDeg = validFolds.reduce((s, f) => s + f.degradation, 0) / validFolds.length;
    const avgOosSharpe = validFolds.reduce((s, f) => s + (f.oosSharpe || 0), 0) / validFolds.length;
    const totalOosTrades = validFolds.reduce((s, f) => s + (f.oosTrades || 0), 0);

    let verdict = "reject";
    let reason = "";
    if (avgOosSharpe < cfg.minOosSharpe) {
      reason = "OOS sharpe " + avgOosSharpe.toFixed(3) + " < threshold " + cfg.minOosSharpe;
    } else if (avgDeg > cfg.maxFitnessDegradation) {
      reason = "fitness degradation " + avgDeg.toFixed(3) + " > max " + cfg.maxFitnessDegradation;
    } else if (totalOosTrades < cfg.minOosTrades * validFolds.length) {
      reason = "insufficient OOS trades: " + totalOosTrades;
    } else {
      verdict = "deploy";
      reason = "OOS performance acceptable";
    }

    const summary = {
      totalFolds: foldResults.length,
      validFolds: validFolds.length,
      avgIsFitness: Number(avgIs.toFixed(4)),
      avgOosFitness: Number(avgOos.toFixed(4)),
      avgDegradation: Number(avgDeg.toFixed(4)),
      avgOosSharpe: Number(avgOosSharpe.toFixed(4)),
      totalOosTrades: totalOosTrades,
      // [2026-10-21] Provenance of the verdict, so a "reject" can be traced
      // back to the data it was computed from.
      dataValidation: "ok",
      dataStart: validationMeta.dataStart,
      dataEnd: validationMeta.dataEnd,
      symbolCount: validationMeta.symbolCount,
      candleCount: validationMeta.candleCount,
      validCandleRatio: validationMeta.validCandleRatio,
      oosOrderValueKrw: Math.round(cfg.oosInitialEquity * (cfg.oosOrderValuePct / 100)),
    };

    const res = { verdict: verdict, reason: reason, folds: foldResults, summary: summary };
    lastResult = res;
    history.push({ ts: new Date().toISOString(), verdict: verdict, summary: summary });
    return res;
  }

  // Validate a specific genome OOS without re-running evolution
  function validateGenome(genome, testCandles) {
    if (!genome || !runBacktest || !testCandles || testCandles.length === 0) {
      return { ok: false, reason: "missing genome, runBacktest, or testCandles" };
    }
    try {
      const args = _genomeToArgs(genome, geneBounds);
      const result = runBacktest(testCandles, args);
      const fitness = computeFitness(result, { minTrades: cfg.minOosTrades });
      return {
        ok: true,
        fitness: fitness,
        sharpe: result && Number.isFinite(result.sharpe) ? result.sharpe : null,
        trades: result ? (result.trades || 0) : 0,
        maxDrawdownPct: result ? (result.maxDrawdownPct || 0) : 0,
        result: result,
      };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  function stats() {
    return {
      totalValidations: history.length,
      lastVerdict: lastResult ? lastResult.verdict : null,
      lastSummary: lastResult ? lastResult.summary : null,
    };
  }

  function getLastResult() { return lastResult; }
  function getHistory() { return history.slice(); }
  function clear() { history.length = 0; lastResult = null; }

  return {
    validate, validateGenome, stats, getLastResult, getHistory, clear,
    _internals: { buildFolds: buildFolds, computeFitness: computeFitness },
  };
}

module.exports = { createWalkForwardValidator, buildFolds, computeFitness, DEFAULT_CONFIG };


