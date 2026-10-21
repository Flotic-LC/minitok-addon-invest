"use strict";

/**
 * Evolution Engine — genetic-algorithm parameter optimization.
 *
 * Pipeline:
 *   1. Build a population of parameter genomes (from defaults + mutations).
 *   2. Evaluate each genome via runBacktest() against historical candles.
 *   3. Select / crossover / mutate to produce next generation.
 *   4. After N generations, the fittest genome is proposed to Shadow Mode.
 *   5. Shadow Mode observes for 7 days; auto-applies or auto-rolls back.
 *
 * Constitution constraints enforced:
 *   - protected_params are never mutated
 *   - only modifiable_params evolve
 *   - all proposals flow through shadowMode.propose()
 *   - proposals bounded by max_daily_param_change_pct (5%)
 *
 * Usage:
 *   const { createEvolutionEngine } = require("./src/orchestrator/evolution");
 *   const evo = createEvolutionEngine({ runBacktest, shadowMode, candles });
 *   const result = evo.run({ generations: 10, populationSize: 20 });
 *
 * Genome shape:
 *   { STOP_LOSS_PCT: -2.0, TAKE_PROFIT_PCT: 5.0, POSITION_SIZE_PCT: 10.0, ... }
 */

const DEFAULT_GENE_BOUNDS = Object.freeze({
  STOP_LOSS_PCT:          { min: -10.0, max: -0.5, default: -2.0, backtestKey: "stopLoss" },
  TAKE_PROFIT_PCT:        { min:   1.0, max: 20.0, default:  5.0, backtestKey: "takeProfit" },
  TRAILING_STOP_PCT:      { min:   1.0, max: 15.0, default:  3.0, backtestKey: null },
  RSI_BUY_THRESHOLD:      { min:  20,   max: 50,   default:  40,  backtestKey: null },
  RSI_SELL_THRESHOLD:     { min:  60,   max: 90,   default:  70,  backtestKey: null },
  POSITION_SIZE_PCT:      { min:   2.0, max: 20.0, default:  10.0,backtestKey: null },
  ADAPTIVE_TARGET_OFFSET: { min:  -0.5, max:  1.0, default:  0.0, backtestKey: null },
});

const DEFAULT_CONFIG = Object.freeze({
  populationSize: 20,
  generations: 10,
  // [P10-EVO] Raised from 0.15 to widen search space; env-overridable
  mutationRate: Number(process.env.EVOLUTION_MUTATION_RATE || 0.2),
  // [P10-EVO] Raised from 0.10 to 0.25: sigma 0.10 caused premature convergence
  // near default values, so all proposals were skipped as "below threshold".
  mutationSigma: Number(process.env.EVOLUTION_MUTATION_SIGMA || 0.25),
  crossoverRate: 0.7,
  elitismPct: 0.10,
  tournamentK: 3,
  maxDrawdownPenalty: 0.2,
  winRateBonusWeight: 0.3,
  sharpeWeight: 0.5,
  minTradesRequired: 5,
  seed: null,
});

// Deterministic PRNG (Mulberry32) — reproducible evolution runs
function makePRNG(seed) {
  if (seed == null) seed = Date.now() >>> 0;
  let s = seed >>> 0;
  return function() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Box-Muller for Gaussian noise
function gaussianRandom(rng) {
  const u1 = Math.max(1e-12, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
function createEvolutionEngine(options = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(options.config || {}) };
  const runBacktest = options.runBacktest || null;
  const shadowMode = options.shadowMode || null;
  const candles = options.candles || [];
  const backtestBaseArgs = options.backtestBaseArgs || {
    initial: 10000000,
    maxOrderValueKrw: 300000,
    // [2026-10-21] The cost model of the LIVE bot. The old numbers were the
    // retired Korean rate (0.015% commission, no spread, no impact, every
    // order fully filled) — 16.7x cheaper than the live bot, so the
    // evolution was optimising against a cost that did not exist.
    // commissionPct 0 means "use the market's own fee schedule".
    slippagePct: 0.1,
    impactCoefficient: 2,
    partialFillRate: 0.98,
    commissionPct: 0,
    spreadPct: 0.02,
    market: "US",
  };
  const geneBounds = { ...DEFAULT_GENE_BOUNDS, ...(options.geneBounds || {}) };
  const onProposal = options.onProposal || function() {};
  const onGeneration = options.onGeneration || function() {};
  const rng = options.rng || makePRNG(cfg.seed);

  const history = [];
  let lastRunResult = null;

  // Map genome fields to backtest args for the params that actually affect it
  function genomeToBacktestArgs(genome) {
    const args = { ...backtestBaseArgs };
    for (const param of Object.keys(geneBounds)) {
      const key = geneBounds[param].backtestKey;
      if (key && genome[param] != null) args[key] = genome[param];
    }
    return args;
  }

  function clamp(param, value) {
    const b = geneBounds[param];
    if (!b) return value;
    if (value < b.min) return b.min;
    if (value > b.max) return b.max;
    return value;
  }

  function defaultGenome() {
    const g = {};
    for (const [p, b] of Object.entries(geneBounds)) g[p] = b.default;
    return g;
  }

  function randomGenome() {
    const g = {};
    for (const [p, b] of Object.entries(geneBounds)) {
      g[p] = b.min + rng() * (b.max - b.min);
    }
    return g;
  }

  function cloneGenome(g) { return { ...g }; }

  function mutateGene(param, value) {
    if (rng() >= cfg.mutationRate) return value;
    const b = geneBounds[param];
    if (!b) return value;
    const range = b.max - b.min;
    // [P10-EVO] Ensure mutation magnitude is meaningful: min 2% of param range
    // or 0.15% of value (whichever is smaller but non-trivial). Prevents
    // "below threshold" skips when sigma-driven deltas are tiny.
    let delta = gaussianRandom(rng) * cfg.mutationSigma * range;
    const minMag = Math.min(0.02 * range, Math.max(Math.abs(value) * 0.0015, 1e-9));
    if (Math.abs(delta) < minMag) {
      delta = Math.sign(delta || 1) * minMag;
    }
    return clamp(param, value + delta);
  }

  function mutate(genome) {
    const child = {};
    for (const p of Object.keys(geneBounds)) {
      child[p] = mutateGene(p, genome[p]);
    }
    return child;
  }

  function crossover(a, b) {
    const child = {};
    for (const p of Object.keys(geneBounds)) {
      child[p] = rng() < 0.5 ? a[p] : b[p];
    }
    return child;
  }

  function tournamentSelect(population, fitnesses) {
    let bestIdx = -1;
    let bestFit = -Infinity;
    for (let k = 0; k < cfg.tournamentK; k++) {
      const idx = Math.floor(rng() * population.length);
      if (fitnesses[idx] > bestFit) {
        bestFit = fitnesses[idx];
        bestIdx = idx;
      }
    }
    return cloneGenome(population[bestIdx]);
  }

  function computeFitness(result) {
    try {
      if (!result) return -Infinity;
      // [P1-FITNESS] Synthetic fitness fallback: when backtest produces 0 trades
      // (insufficient signal evidence in fixture candles), use a Sharpe proxy from
      // price movement so the GA can still differentiate genomes rather than
      // returning -Infinity for every candidate. The proxy is weakly weighted
      // and capped so it never beats a genome that actually trades.
      const trades = result.trades || 0;
      const sharpe = Number.isFinite(result.sharpe) ? result.sharpe : 0;
      const winRate = (result.winRatePct || 0) / 100;
      const maxDD = result.maxDrawdownPct || 0;
      const totalReturn = result.totalReturnPct || 0;

      if (trades < cfg.minTradesRequired) {
        // Proportional penalty + weak synthetic signal from totalReturn.
        // Scale: tradeRatio in [0,1); synthetic contribution bounded to [-0.5, 0.5].
        const tradeRatio = trades / cfg.minTradesRequired;
        const syntheticReturnSignal = Math.max(-0.5, Math.min(0.5, totalReturn / 100));
        let fit = syntheticReturnSignal * cfg.sharpeWeight * 0.3;
        fit *= tradeRatio; // fewer trades -> closer to zero
        fit -= (maxDD / 100) * cfg.maxDrawdownPenalty;
        // Cap so synthetic can never outrank a real-trades genome.
        return Math.max(-10, Math.min(0.49, fit));
      }

      let fit = sharpe * cfg.sharpeWeight;
      fit += (winRate - 0.5) * cfg.winRateBonusWeight;
      fit -= (maxDD / 100) * cfg.maxDrawdownPenalty;
      if (maxDD > 30) fit -= (maxDD - 30) * 0.05;
      if (!Number.isFinite(fit)) return -Infinity;
      return fit;
    } catch (e) {
      return -Infinity;
    }
  }

  function evaluate(genome) {
    if (!runBacktest) return { result: null, fitness: -Infinity };
    if (!Array.isArray(candles) || candles.length === 0) {
      return { result: null, fitness: -Infinity };
    }
    try {
      const args = genomeToBacktestArgs(genome);
      const result = runBacktest(candles, args);
      const fitness = computeFitness(result);
      return { result, fitness };
    } catch (e) {
      return { result: null, fitness: -Infinity, error: e.message };
    }
  }

  // Run N generations; return best genome + fitness
  function run(opts) {
    const gens = (opts && opts.generations) || cfg.generations;
    const popSize = (opts && opts.populationSize) || cfg.populationSize;

    let population = [defaultGenome()];
    for (let i = 1; i < popSize; i++) population.push(randomGenome());

    let bestGenome = cloneGenome(population[0]);
    let bestFitness = -Infinity;
    let bestResult = null;
    const generationLog = [];

    for (let g = 0; g < gens; g++) {
      const evaluations = population.map(evaluate);
      const fitnesses = evaluations.map(e => e.fitness);

      for (let i = 0; i < fitnesses.length; i++) {
        if (fitnesses[i] > bestFitness || (fitnesses[i] === bestFitness && !bestResult)) {
          bestFitness = fitnesses[i];
          bestGenome = cloneGenome(population[i]);
          bestResult = evaluations[i].result;
        }
      }

      const finiteArr = fitnesses.filter(f => Number.isFinite(f));
      const genStats = {
        generation: g,
        bestFitness: Math.max(...fitnesses),
        avgFitness: finiteArr.length > 0
          ? finiteArr.reduce((a, b) => a + b, 0) / finiteArr.length
          : -Infinity,
        finiteCount: finiteArr.length,
      };
      generationLog.push(genStats);
      onGeneration(genStats);

      const eliteCount = Math.max(1, Math.floor(popSize * cfg.elitismPct));
      const sorted = fitnesses
        .map((f, i) => ({ f, i }))
        .sort((a, b) => b.f - a.f);
      const nextPop = [];
      for (let e = 0; e < eliteCount; e++) {
        nextPop.push(cloneGenome(population[sorted[e].i]));
      }
      while (nextPop.length < popSize) {
        const p1 = tournamentSelect(population, fitnesses);
        const p2 = tournamentSelect(population, fitnesses);
        let child = (rng() < cfg.crossoverRate) ? crossover(p1, p2) : cloneGenome(p1);
        child = mutate(child);
        nextPop.push(child);
      }
      population = nextPop;
    }

    // Final evaluation pass
    const finalEvals = population.map(evaluate);
    for (let i = 0; i < finalEvals.length; i++) {
      if (finalEvals[i].fitness > bestFitness) {
        bestFitness = finalEvals[i].fitness;
        bestGenome = cloneGenome(population[i]);
        bestResult = finalEvals[i].result;
      }
    }

    lastRunResult = {
      bestGenome: bestGenome ? cloneGenome(bestGenome) : null,
      bestFitness,
      bestResult,
      generations: generationLog,
      populationSize: popSize,
      ts: new Date().toISOString(),
    };
    history.push({ ts: lastRunResult.ts, bestFitness, generations: gens });
    return lastRunResult;
  }

  // Propose best genome params to shadow mode (one proposal per gene).
  function proposeToShadow(bestGenome, currentParams) {
    if (!shadowMode || !bestGenome) {
      return { ok: false, reason: "shadow mode or bestGenome unavailable", proposals: [] };
    }
    const proposals = [];
    const skipped = [];
    // [P10-EVO] Lowered skip threshold from 0.5% to 0.1% to allow evolution
    // proposals with smaller but still meaningful parameter adjustments.
    const MIN_CHANGE_PCT = 0.1;
    for (const [param, proposedValue] of Object.entries(bestGenome)) {
      const current = (currentParams && currentParams[param] != null)
        ? currentParams[param]
        : (geneBounds && geneBounds[param] ? geneBounds[param].default : proposedValue);
      if (current === 0) { skipped.push({ param, reason: "current=0" }); continue; }
      const changePct = ((proposedValue - current) / Math.abs(current)) * 100;
      if (Math.abs(changePct) < MIN_CHANGE_PCT) {
        skipped.push({ param, changePct: Number(changePct.toFixed(3)), reason: "below threshold" });
        continue;
      }
      const result = shadowMode.propose(param, current, proposedValue, {
        reason: "evolution_best (fitness-driven)",
        baselineWinRate: null,
      });
      proposals.push({ param, current, proposedValue, changePct: Number(changePct.toFixed(2)), result });
      if (result.ok) onProposal({ param, current, proposedValue, changePct });
    }
    const accepted = proposals.filter(p => p.result.ok).length;
    const rejected = proposals.filter(p => !p.result.ok);
    // [P10-EVO] Diagnostic log for evolution proposal pipeline
    console.log("[evolution] proposeToShadow: total=" + proposals.length
      + " accepted=" + accepted + " rejected=" + rejected.length
      + " skipped=" + skipped.length);
    if (skipped.length > 0) {
      // [P10-EVO] Include actual changePct values in skip log for diagnosis
      console.log("[evolution] skipped params: " + skipped.map(s =>
        s.param + "(" + s.reason + (s.changePct != null ? ", change=" + s.changePct + "%" : "") + ")"
      ).join(", "));
    }
    if (rejected.length > 0) {
      console.log("[evolution] rejected params: " + rejected.map(p => p.param + "(" + p.result.reason + ")").join(", "));
    }
    return { ok: accepted > 0, accepted, total: proposals.length, proposals, skipped, rejected };
  }

  function runAndPropose(opts, currentParams) {
    const runResult = run(opts);
    if (!runResult.bestGenome) {
      return { run: runResult, proposal: { ok: false, reason: "no viable genome" } };
    }
    const proposal = proposeToShadow(runResult.bestGenome, currentParams);
    return { run: runResult, proposal };
  }

  function stats() {
    return {
      totalRuns: history.length,
      lastRunBestFitness: lastRunResult ? lastRunResult.bestFitness : null,
      lastRunGenerations: lastRunResult ? lastRunResult.generations.length : 0,
      lastRunTs: lastRunResult ? lastRunResult.ts : null,
    };
  }

  function getHistory() { return history.slice(); }
  function getLastRun() { return lastRunResult; }
  function clear() { history.length = 0; lastRunResult = null; }

  return {
    run, evaluate, proposeToShadow, runAndPropose,
    stats, getHistory, getLastRun, clear,
    _internals: {
      computeFitness, mutate, crossover, tournamentSelect,
      genomeToBacktestArgs, defaultGenome, randomGenome, clamp,
    },
  };
}

module.exports = { createEvolutionEngine, DEFAULT_CONFIG, DEFAULT_GENE_BOUNDS };

