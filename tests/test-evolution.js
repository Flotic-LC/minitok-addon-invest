"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createEvolutionEngine,
  DEFAULT_CONFIG,
  DEFAULT_GENE_BOUNDS,
} = require("../src/orchestrator/evolution");
const { createShadowMode } = require("../src/orchestrator/shadow-mode");

// --- Test fixtures ---
// A minimal fake backtest that returns deterministic metrics based on args.
function makeFakeBacktest(mode) {
  // mode: "good" | "bad" | "error" | "notrade" | "varied"
  return function(candles, args) {
    if (mode === "error") throw new Error("simulated backtest failure");
    if (mode === "notrade") {
      return { sharpe: 0, winRatePct: 0, maxDrawdownPct: 0, trades: 0 };
    }
    // Use stopLoss + takeProfit to influence result (deterministic)
    const sl = args.stopLoss || -2;
    const tp = args.takeProfit || 5;
    if (mode === "bad") {
      return {
        sharpe: -0.5,
        winRatePct: 30,
        maxDrawdownPct: 35,
        trades: 20,
        totalReturnPct: -10,
      };
    }
    if (mode === "varied") {
      // Better stop-loss (closer to 0 but negative) and higher take-profit wins
      const score = (Math.abs(sl) < 3 ? 1 : 0) + (tp > 7 ? 1 : 0);
      return {
        sharpe: 0.5 + score * 0.6,
        winRatePct: 50 + score * 10,
        maxDrawdownPct: 15 - score * 3,
        trades: 30,
        totalReturnPct: 5 + score * 4,
      };
    }
    // mode === "good"
    return {
      sharpe: 1.5,
      winRatePct: 65,
      maxDrawdownPct: 10,
      trades: 40,
      totalReturnPct: 20,
    };
  };
}

function makeCandles() {
  return [{ symbol: "TEST", date: "2025-01-01", open: 100, high: 101, low: 99, close: 100, volume: 1000 }];
}

// Deterministic counter-based PRNG for reproducibility in tests
function makeCounterRng(start) {
  let i = start || 0;
  return function() {
    i++;
    return (Math.sin(i) + 1) / 2; // deterministic 0..1
  };
}

// ===== API surface =====
test("createEvolutionEngine returns expected API", () => {
  const evo = createEvolutionEngine({});
  for (const m of ["run", "evaluate", "proposeToShadow", "runAndPropose",
                  "stats", "getHistory", "getLastRun", "clear"]) {
    assert.equal(typeof evo[m], "function", "missing method " + m);
  }
  assert.ok(evo._internals, "_internals exposed");
});

test("DEFAULT_GENE_BOUNDS has all modifiable params", () => {
  const expected = ["STOP_LOSS_PCT", "TAKE_PROFIT_PCT", "TRAILING_STOP_PCT",
    "RSI_BUY_THRESHOLD", "RSI_SELL_THRESHOLD", "POSITION_SIZE_PCT",
    "ADAPTIVE_TARGET_OFFSET"];
  for (const p of expected) {
    assert.ok(DEFAULT_GENE_BOUNDS[p], "missing bound for " + p);
    assert.ok(typeof DEFAULT_GENE_BOUNDS[p].min === "number");
    assert.ok(typeof DEFAULT_GENE_BOUNDS[p].max === "number");
    assert.ok(DEFAULT_GENE_BOUNDS[p].min < DEFAULT_GENE_BOUNDS[p].max);
  }
});

test("DEFAULT_CONFIG has sensible defaults", () => {
  assert.ok(DEFAULT_CONFIG.populationSize >= 5);
  assert.ok(DEFAULT_CONFIG.generations >= 1);
  assert.ok(DEFAULT_CONFIG.mutationRate > 0 && DEFAULT_CONFIG.mutationRate <= 1);
  assert.ok(DEFAULT_CONFIG.elitismPct > 0 && DEFAULT_CONFIG.elitismPct < 1);
});

// ===== Internals =====
test("defaultGenome uses bound defaults", () => {
  const evo = createEvolutionEngine({ rng: makeCounterRng(1) });
  const g = evo._internals.defaultGenome();
  for (const [p, b] of Object.entries(DEFAULT_GENE_BOUNDS)) {
    assert.equal(g[p], b.default, p + " default mismatch");
  }
});

test("randomGenome respects bounds", () => {
  const evo = createEvolutionEngine({ rng: makeCounterRng(7) });
  for (let i = 0; i < 10; i++) {
    const g = evo._internals.randomGenome();
    for (const [p, b] of Object.entries(DEFAULT_GENE_BOUNDS)) {
      assert.ok(g[p] >= b.min && g[p] <= b.max,
        p + " out of bounds: " + g[p] + " not in [" + b.min + "," + b.max + "]");
    }
  }
});

test("clamp respects bounds", () => {
  const evo = createEvolutionEngine({ rng: makeCounterRng(3) });
  assert.equal(evo._internals.clamp("STOP_LOSS_PCT", -50), DEFAULT_GENE_BOUNDS.STOP_LOSS_PCT.min);
  assert.equal(evo._internals.clamp("STOP_LOSS_PCT", 0), DEFAULT_GENE_BOUNDS.STOP_LOSS_PCT.max);
  assert.equal(evo._internals.clamp("STOP_LOSS_PCT", -3), -3);
});

test("mutate produces valid genome within bounds", () => {
  const evo = createEvolutionEngine({
    rng: makeCounterRng(11),
    config: { mutationRate: 1.0, mutationSigma: 0.5 },
  });
  const g = evo._internals.defaultGenome();
  const m = evo._internals.mutate(g);
  for (const [p, b] of Object.entries(DEFAULT_GENE_BOUNDS)) {
    assert.ok(m[p] >= b.min && m[p] <= b.max, p + " mutated out of bounds");
  }
});

test("crossover produces valid genome within bounds", () => {
  const evo = createEvolutionEngine({ rng: makeCounterRng(13) });
  const a = evo._internals.randomGenome();
  const b = evo._internals.randomGenome();
  const c = evo._internals.crossover(a, b);
  for (const [p, bnd] of Object.entries(DEFAULT_GENE_BOUNDS)) {
    assert.ok(c[p] >= bnd.min && c[p] <= bnd.max, p + " crossover out of bounds");
  }
});

test("tournamentSelect picks from population", () => {
  const evo = createEvolutionEngine({ rng: makeCounterRng(17) });
  const pop = [evo._internals.defaultGenome(), evo._internals.randomGenome(),
               evo._internals.randomGenome()];
  const fits = [0.5, 1.5, -0.5];
  const picked = evo._internals.tournamentSelect(pop, fits);
  assert.ok(picked && typeof picked === "object");
  // Must be one of the population members (deep-equal to one)
  const match = pop.some(g => {
    for (const k of Object.keys(g)) if (g[k] !== picked[k]) return false;
    return true;
  });
  assert.ok(match, "picked genome should be from population");
});

// ===== Fitness & evaluation =====
test("computeFitness returns -Infinity for null result", () => {
  const evo = createEvolutionEngine({});
  assert.equal(evo._internals.computeFitness(null), -Infinity);
});

test("computeFitness returns finite synthetic when sharpe is non-finite but trades exist", () => {
  const evo = createEvolutionEngine({ config: { minTradesRequired: 5 } });
  const fit = evo._internals.computeFitness({ sharpe: NaN, winRatePct: 50, maxDrawdownPct: 10, trades: 20, totalReturnPct: 5 });
  assert.ok(Number.isFinite(fit), "expected finite synthetic fitness, got " + fit);
});

test("computeFitness returns finite synthetic when trades < minTradesRequired", () => {
  // [P1-FITNESS] Changed behavior: instead of -Infinity, return finite synthetic fitness
  // so GA can still differentiate genomes even with few trades.
  const evo = createEvolutionEngine({ config: { minTradesRequired: 10 } });
  const fit = evo._internals.computeFitness({ sharpe: 2, winRatePct: 70, maxDrawdownPct: 5, trades: 3, totalReturnPct: 8 });
  assert.ok(Number.isFinite(fit), "expected finite synthetic fitness, got " + fit);
  assert.ok(fit < 0.5, "synthetic fitness should be capped below real-trades range");
});

test("computeFitness produces finite positive value for good result", () => {
  const evo = createEvolutionEngine({});
  const fit = evo._internals.computeFitness({
    sharpe: 1.5, winRatePct: 65, maxDrawdownPct: 10, trades: 40,
  });
  assert.ok(Number.isFinite(fit) && fit > 0, "expected positive finite fitness, got " + fit);
});

test("computeFitness penalizes large drawdown", () => {
  const evo = createEvolutionEngine({});
  const fitLow = evo._internals.computeFitness({ sharpe: 1, winRatePct: 60, maxDrawdownPct: 5, trades: 30 });
  const fitHigh = evo._internals.computeFitness({ sharpe: 1, winRatePct: 60, maxDrawdownPct: 40, trades: 30 });
  assert.ok(fitLow > fitHigh, "high DD should produce lower fitness: " + fitLow + " vs " + fitHigh);
});

test("evaluate returns -Infinity when no runBacktest provided", () => {
  const evo = createEvolutionEngine({});
  const r = evo.evaluate(evo._internals.defaultGenome());
  assert.equal(r.fitness, -Infinity);
});

test("evaluate returns -Infinity when candles empty", () => {
  const evo = createEvolutionEngine({ runBacktest: makeFakeBacktest("good"), candles: [] });
  const r = evo.evaluate(evo._internals.defaultGenome());
  assert.equal(r.fitness, -Infinity);
});

test("evaluate returns -Infinity on backtest error", () => {
  const evo = createEvolutionEngine({
    runBacktest: makeFakeBacktest("error"),
    candles: makeCandles(),
  });
  const r = evo.evaluate(evo._internals.defaultGenome());
  assert.equal(r.fitness, -Infinity);
  assert.ok(r.error, "error message should be captured");
});

test("evaluate returns finite fitness for good backtest", () => {
  const evo = createEvolutionEngine({
    runBacktest: makeFakeBacktest("good"),
    candles: makeCandles(),
  });
  const r = evo.evaluate(evo._internals.defaultGenome());
  assert.ok(Number.isFinite(r.fitness), "expected finite fitness, got " + r.fitness);
  assert.ok(r.result, "backtest result attached");
});

test("genomeToBacktestArgs maps gene bounds with backtestKey", () => {
  const evo = createEvolutionEngine({});
  const g = evo._internals.defaultGenome();
  const args = evo._internals.genomeToBacktestArgs(g);
  assert.equal(args.stopLoss, DEFAULT_GENE_BOUNDS.STOP_LOSS_PCT.default);
  assert.equal(args.takeProfit, DEFAULT_GENE_BOUNDS.TAKE_PROFIT_PCT.default);
  // Params without backtestKey should not leak
  assert.equal(args.TRAILING_STOP_PCT, undefined);
});

// ===== Run (GA loop) =====
test("run produces bestGenome with single generation", () => {
  const evo = createEvolutionEngine({
    runBacktest: makeFakeBacktest("good"),
    candles: makeCandles(),
    rng: makeCounterRng(42),
  });
  const result = evo.run({ generations: 1, populationSize: 5 });
  assert.ok(result.bestGenome, "bestGenome should exist");
  assert.ok(Number.isFinite(result.bestFitness), "bestFitness should be finite");
  assert.equal(result.generations.length, 1);
  assert.equal(result.populationSize, 5);
});

test("run with multiple generations logs each generation", () => {
  const evo = createEvolutionEngine({
    runBacktest: makeFakeBacktest("varied"),
    candles: makeCandles(),
    rng: makeCounterRng(99),
  });
  const result = evo.run({ generations: 3, populationSize: 6 });
  assert.equal(result.generations.length, 3);
  for (const gs of result.generations) {
    assert.ok(typeof gs.generation === "number");
    assert.ok(typeof gs.bestFitness === "number");
    assert.ok(typeof gs.finiteCount === "number");
  }
});

test("run invokes onGeneration callback", () => {
  let calls = 0;
  const evo = createEvolutionEngine({
    runBacktest: makeFakeBacktest("good"),
    candles: makeCandles(),
    rng: makeCounterRng(5),
    onGeneration: () => { calls++; },
  });
  evo.run({ generations: 4, populationSize: 5 });
  assert.equal(calls, 4);
});

test("run with bad backtest returns finite synthetic fitness (not -Infinity)", () => {
  // [P1-FITNESS] notrade => trades=0 => synthetic fitness fallback instead of -Infinity
  const evo = createEvolutionEngine({
    runBacktest: makeFakeBacktest("notrade"),
    candles: makeCandles(),
    rng: makeCounterRng(7),
  });
  const result = evo.run({ generations: 2, populationSize: 4 });
  assert.ok(Number.isFinite(result.bestFitness), "expected finite fitness, got " + result.bestFitness);
  assert.ok(result.bestFitness < 0.5, "synthetic fitness should be capped");
  assert.ok(result.bestGenome);
});

test("stats reflects run history", () => {
  const evo = createEvolutionEngine({
    runBacktest: makeFakeBacktest("good"),
    candles: makeCandles(),
    rng: makeCounterRng(11),
  });
  assert.equal(evo.stats().totalRuns, 0);
  evo.run({ generations: 2, populationSize: 4 });
  assert.equal(evo.stats().totalRuns, 1);
  assert.ok(evo.stats().lastRunBestFitness != null);
  assert.equal(evo.stats().lastRunGenerations, 2);
});

test("clear resets history", () => {
  const evo = createEvolutionEngine({
    runBacktest: makeFakeBacktest("good"),
    candles: makeCandles(),
    rng: makeCounterRng(3),
  });
  evo.run({ generations: 1, populationSize: 3 });
  assert.equal(evo.stats().totalRuns, 1);
  evo.clear();
  assert.equal(evo.stats().totalRuns, 0);
  assert.equal(evo.getLastRun(), null);
});


// ===== Shadow Mode integration =====
test("proposeToShadow fails when no shadow mode configured", () => {
  const evo = createEvolutionEngine({});
  const r = evo.proposeToShadow(evo._internals.defaultGenome(), {});
  assert.equal(r.ok, false);
  assert.equal(r.proposals.length, 0);
});

test("proposeToShadow fails when bestGenome is null", () => {
  const shadow = createShadowMode({ constitution: { maxDailyParamChangePct: 50, maxWeeklyParamChangePct: 100, shadowModeMinDays: 7 } });
  const evo = createEvolutionEngine({ shadowMode: shadow });
  const r = evo.proposeToShadow(null, {});
  assert.equal(r.ok, false);
});

test("proposeToShadow skips trivial changes (<0.5%)", () => {
  const shadow = createShadowMode({ constitution: { maxDailyParamChangePct: 50, maxWeeklyParamChangePct: 100, shadowModeMinDays: 7 } });
  const evo = createEvolutionEngine({ shadowMode: shadow });
  const genome = evo._internals.defaultGenome();
  const currentParams = { ...genome };
  const r = evo.proposeToShadow(genome, currentParams);
  assert.equal(r.proposals.length, 0);
  assert.equal(r.ok, false);
});

test("proposeToShadow submits non-trivial changes to shadow mode", () => {
  const shadow = createShadowMode({
    constitution: { maxDailyParamChangePct: 200, maxWeeklyParamChangePct: 500, shadowModeMinDays: 7 },
  });
  const evo = createEvolutionEngine({ shadowMode: shadow });
  const genome = { ...evo._internals.defaultGenome(), STOP_LOSS_PCT: -3.0, TAKE_PROFIT_PCT: 8.0 };
  const currentParams = { ...evo._internals.defaultGenome() };
  const r = evo.proposeToShadow(genome, currentParams);
  assert.ok(r.ok, "at least one proposal should be accepted");
  assert.ok(r.proposals.length >= 2, "should have at least 2 proposals");
  const okProposals = r.proposals.filter(p => p.result.ok);
  assert.ok(okProposals.length >= 2, "both proposals should fit within daily limit of 200%");
  assert.equal(shadow.stats().observing, okProposals.length);
});

test("proposeToShadow respects shadow daily limit", () => {
  const shadow = createShadowMode({
    constitution: { maxDailyParamChangePct: 6, maxWeeklyParamChangePct: 100, shadowModeMinDays: 7 },
  });
  const evo = createEvolutionEngine({ shadowMode: shadow });
  const genome = { ...evo._internals.defaultGenome(), STOP_LOSS_PCT: -3.0, TAKE_PROFIT_PCT: 8.0 };
  const currentParams = { ...evo._internals.defaultGenome() };
  const r = evo.proposeToShadow(genome, currentParams);
  assert.ok(shadow.stats().dailyChangeUsed <= 6.5);
});

test("proposeToShadow invokes onProposal callback for accepted proposals", () => {
  const shadow = createShadowMode({
    constitution: { maxDailyParamChangePct: 200, maxWeeklyParamChangePct: 500, shadowModeMinDays: 7 },
  });
  let calls = 0;
  const evo = createEvolutionEngine({
    shadowMode: shadow,
    onProposal: () => { calls++; },
  });
  const genome = { ...evo._internals.defaultGenome(), STOP_LOSS_PCT: -4.0 };
  evo.proposeToShadow(genome, evo._internals.defaultGenome());
  assert.ok(calls >= 1);
});

test("proposeToShadow skips params with zero current value", () => {
  const shadow = createShadowMode({
    constitution: { maxDailyParamChangePct: 50, maxWeeklyParamChangePct: 100, shadowModeMinDays: 7 },
  });
  const evo = createEvolutionEngine({ shadowMode: shadow });
  const genome = { ...evo._internals.defaultGenome(), ADAPTIVE_TARGET_OFFSET: 0.5 };
  const currentParams = { ...evo._internals.defaultGenome() };
  const r = evo.proposeToShadow(genome, currentParams);
  const atoProposal = r.proposals.find(p => p.param === "ADAPTIVE_TARGET_OFFSET");
  assert.equal(atoProposal, undefined);
});


// ===== runAndPropose end-to-end =====
test("runAndPropose runs evolution and submits best to shadow", () => {
  const shadow = createShadowMode({
    constitution: { maxDailyParamChangePct: 50, maxWeeklyParamChangePct: 100, shadowModeMinDays: 7 },
  });
  const evo = createEvolutionEngine({
    runBacktest: makeFakeBacktest("varied"),
    candles: makeCandles(),
    shadowMode: shadow,
    rng: makeCounterRng(123),
  });
  const currentParams = { ...evo._internals.defaultGenome() };
  const r = evo.runAndPropose({ generations: 2, populationSize: 6 }, currentParams);
  assert.ok(r.run, "run result attached");
  assert.ok(r.run.bestGenome, "bestGenome exists");
  assert.ok(r.proposal, "proposal attached");
  assert.equal(typeof r.proposal.ok, "boolean");
});

test("runAndPropose returns result even when all fitness -Infinity", () => {
  const shadow = createShadowMode({ constitution: { maxDailyParamChangePct: 50, maxWeeklyParamChangePct: 100, shadowModeMinDays: 7 } });
  const evo = createEvolutionEngine({
    runBacktest: makeFakeBacktest("notrade"),
    candles: makeCandles(),
    shadowMode: shadow,
    rng: makeCounterRng(77),
  });
  const r = evo.runAndPropose({ generations: 1, populationSize: 3 }, {});
  assert.ok(r.run);
  assert.ok(r.proposal);
});

// ===== Constitution guards =====
test("evolution genome contains only modifiable params (no protected params leak)", () => {
  const evo = createEvolutionEngine({ rng: makeCounterRng(21) });
  const g = evo._internals.randomGenome();
  const protectedParams = ["DAILY_MAX_LOSS_PCT", "MAX_SINGLE_POSITION_PCT",
    "MAX_TOTAL_EXPOSURE_PCT", "MAX_OPEN_POSITIONS", "MIN_CASH_RESERVE_PCT"];
  for (const p of protectedParams) {
    assert.equal(g[p], undefined, "protected param " + p + " should not exist in genome");
  }
});

test("gene bounds do not include any constitution protected param", () => {
  const protectedParams = ["DAILY_MAX_LOSS_PCT", "MAX_SINGLE_POSITION_PCT",
    "MAX_TOTAL_EXPOSURE_PCT", "MAX_OPEN_POSITIONS", "MIN_CASH_RESERVE_PCT"];
  for (const p of protectedParams) {
    assert.equal(DEFAULT_GENE_BOUNDS[p], undefined, "protected " + p + " must not be in gene bounds");
  }
});

test("full pipeline: backtest → evolution → shadow propose", () => {
  const shadow = createShadowMode({
    constitution: { maxDailyParamChangePct: 50, maxWeeklyParamChangePct: 100, shadowModeMinDays: 1 },
    now: () => new Date("2026-01-01T00:00:00Z").getTime(),
  });
  const evo = createEvolutionEngine({
    runBacktest: makeFakeBacktest("varied"),
    candles: makeCandles(),
    shadowMode: shadow,
    rng: makeCounterRng(555),
  });
  const current = { ...evo._internals.defaultGenome() };
  const r = evo.runAndPropose({ generations: 2, populationSize: 5 }, current);
  assert.equal(evo.stats().totalRuns, 1);
  assert.ok(shadow.getHistory().length >= 0);
  if (r.proposal.ok) {
    assert.ok(shadow.stats().observing >= 1, "shadow should be observing at least one param");
  }
});

test("getHistory returns chronological run entries", () => {
  const evo = createEvolutionEngine({
    runBacktest: makeFakeBacktest("good"),
    candles: makeCandles(),
    rng: makeCounterRng(9),
  });
  evo.run({ generations: 1, populationSize: 3 });
  evo.run({ generations: 2, populationSize: 4 });
  const h = evo.getHistory();
  assert.equal(h.length, 2);
  assert.ok(h[0].ts);
  assert.equal(h[0].generations, 1);
  assert.equal(h[1].generations, 2);
});

test("getLastRun returns null before any run", () => {
  const evo = createEvolutionEngine({});
  assert.equal(evo.getLastRun(), null);
});

test("getLastRun returns full run result after run", () => {
  const evo = createEvolutionEngine({
    runBacktest: makeFakeBacktest("good"),
    candles: makeCandles(),
    rng: makeCounterRng(31),
  });
  evo.run({ generations: 1, populationSize: 3 });
  const last = evo.getLastRun();
  assert.ok(last);
  assert.ok(last.bestGenome);
  assert.ok(Number.isFinite(last.bestFitness));
  assert.equal(last.generations.length, 1);
  assert.ok(last.ts);
});

test("evolution handles custom geneBounds override (merge with defaults)", () => {
  const evo = createEvolutionEngine({
    rng: makeCounterRng(41),
    geneBounds: {
      STOP_LOSS_PCT: { min: -5, max: -1, default: -2, backtestKey: "stopLoss" },
    },
  });
  const g = evo._internals.randomGenome();
  // Custom STOP_LOSS_PCT overrides default bounds
  assert.ok(g.STOP_LOSS_PCT >= -5 && g.STOP_LOSS_PCT <= -1);
  // Other defaults still present (merge behavior, consistent with cfg/constitution pattern)
  assert.ok(g.TAKE_PROFIT_PCT != null);
});

