"use strict";

/**
 * Scenario Simulator — Monte Carlo path simulation + historical stress tests.
 *
 * Provides:
 *   - simulate(paths, days, params): Monte Carlo price path generation
 *   - stressTest(positions, scenarios): apply historical crash scenarios
 *   - computeRisk(simResults): VaR, max drawdown, loss probability
 *
 * Usage:
 *   const { createSimulator } = require("./src/simulation/scenario");
 *   const sim = createSimulator({ seed: 42 });
 *   const result = sim.simulate({ paths: 10000, days: 30, drift: 0.0003, vol: 0.02 });
 *   const risk = sim.computeRisk(result);
 */

const DEFAULTS = Object.freeze({
  paths: 10000,
  days: 30,
  drift: 0.0003,   // daily expected return (~7.5% annualized)
  volatility: 0.02, // daily vol (~32% annualized)
  initialPrice: 100,
  seed: null,
});

// Simple seeded PRNG (mulberry32) for reproducibility
function mulberry32(seed) {
  let s = seed | 0;
  return function() {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Box-Muller transform for normal distribution
function normalRandom(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function createSimulator(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const rng = cfg.seed != null ? mulberry32(cfg.seed) : Math.random;

  // --- Monte Carlo Simulation ---
  function simulate(params = {}) {
    const p = { ...cfg, ...params };
    const results = [];

    for (let i = 0; i < p.paths; i++) {
      let price = p.initialPrice;
      const path = [price];
      let maxPrice = price;
      let maxDrawdown = 0;

      for (let d = 0; d < p.days; d++) {
        const shock = normalRandom(rng);
        const dailyReturn = p.drift + p.volatility * shock;
        price *= (1 + dailyReturn);
        path.push(price);
        if (price > maxPrice) maxPrice = price;
        const dd = (maxPrice - price) / maxPrice;
        if (dd > maxDrawdown) maxDrawdown = dd;
      }

      results.push({
        finalPrice: price,
        totalReturn: (price - p.initialPrice) / p.initialPrice,
        maxDrawdown,
        path,
      });
    }

    return { paths: p.paths, days: p.days, results, params: p };
  }

  // --- Historical Stress Scenarios ---
  const STRESS_SCENARIOS = [
    { name: "2008_financial_crisis", dailyDrop: -0.05, days: 10, description: "Global financial crisis" },
    { name: "2020_march_crash", dailyDrop: -0.08, days: 5, description: "Pandemic crash" },
    { name: "2022_rate_shock", dailyDrop: -0.03, days: 20, description: "Fed rate hike cycle" },
    { name: "flash_crash", dailyDrop: -0.15, days: 1, description: "Single-day flash crash" },
    { name: "korea_1997", dailyDrop: -0.10, days: 7, description: "Asian financial crisis (KRX)" },
  ];

  function stressTest(positions, scenarios) {
    const activeScenarios = scenarios || STRESS_SCENARIOS;
    const results = [];

    for (const scenario of activeScenarios) {
      let totalLoss = 0;
      const details = [];

      for (const pos of (positions || [])) {
        const value = (pos.price || 0) * (pos.quantity || 0);
        // Compound daily drops
        const finalValue = value * Math.pow(1 + scenario.dailyDrop, scenario.days);
        const loss = finalValue - value;
        totalLoss += loss;
        details.push({ symbol: pos.symbol, initialValue: value, finalValue, loss });
      }

      results.push({
        scenario: scenario.name,
        description: scenario.description,
        days: scenario.days,
        dailyDrop: scenario.dailyDrop,
        totalLoss,
        totalLossPct: positions && positions.length > 0 ? totalLoss / positions.reduce((s, p) => s + (p.price || 0) * (p.quantity || 0), 0) : 0,
        details,
      });
    }

    return results;
  }

  // --- Risk Metrics ---
  function computeRisk(simResult) {
    if (!simResult || !simResult.results || simResult.results.length === 0) return null;

    const returns = simResult.results.map(r => r.totalReturn).sort((a, b) => a - b);
    const drawdowns = simResult.results.map(r => r.maxDrawdown).sort((a, b) => a - b);
    const n = returns.length;

    // Value at Risk (95% and 99%)
    const var95 = returns[Math.floor(n * 0.05)];
    const var99 = returns[Math.floor(n * 0.01)];

    // Max drawdown percentiles
    const ddMedian = drawdowns[Math.floor(n * 0.5)];
    const dd95 = drawdowns[Math.floor(n * 0.05)];

    // Probability of loss
    const lossCount = returns.filter(r => r < 0).length;
    const probLoss = lossCount / n;

    // Expected return
    const meanReturn = returns.reduce((s, r) => s + r, 0) / n;

    // Sharpe approximation (annualized from daily)
    const stdDev = Math.sqrt(returns.reduce((s, r) => s + Math.pow(r - meanReturn, 2), 0) / n);
    const annualizedReturn = meanReturn * (252 / simResult.days);
    const annualizedVol = stdDev * Math.sqrt(252 / simResult.days);
    const sharpe = annualizedVol > 0 ? annualizedReturn / annualizedVol : 0;

    return {
      paths: n,
      days: simResult.days,
      var95: Number(var95.toFixed(4)),
      var99: Number(var99.toFixed(4)),
      maxDrawdownMedian: Number(ddMedian.toFixed(4)),
      maxDrawdown95: Number(dd95.toFixed(4)),
      probabilityOfLoss: Number(probLoss.toFixed(4)),
      meanReturn: Number(meanReturn.toFixed(4)),
      sharpeRatio: Number(sharpe.toFixed(3)),
    };
  }

  return { simulate, stressTest, computeRisk, STRESS_SCENARIOS };
}

module.exports = { createSimulator, DEFAULTS, STRESS_SCENARIOS: createSimulator().STRESS_SCENARIOS };
