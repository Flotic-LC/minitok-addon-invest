"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createSimulator } = require("../src/simulation/scenario");

test("createSimulator returns expected API", () => {
  const sim = createSimulator();
  assert.equal(typeof sim.simulate, "function");
  assert.equal(typeof sim.stressTest, "function");
  assert.equal(typeof sim.computeRisk, "function");
  assert.ok(Array.isArray(sim.STRESS_SCENARIOS));
});

test("simulate generates correct number of paths", () => {
  const sim = createSimulator({ seed: 42 });
  const r = sim.simulate({ paths: 500, days: 10 });
  assert.equal(r.paths, 500);
  assert.equal(r.results.length, 500);
});

test("path length equals days + 1", () => {
  const sim = createSimulator({ seed: 1 });
  const r = sim.simulate({ paths: 5, days: 7 });
  for (const res of r.results) {
    assert.equal(res.path.length, 8);
    assert.equal(res.path[0], 100);
  }
});

test("seed produces reproducible results", () => {
  const s1 = createSimulator({ seed: 12345 });
  const s2 = createSimulator({ seed: 12345 });
  const r1 = s1.simulate({ paths: 100, days: 20 });
  const r2 = s2.simulate({ paths: 100, days: 20 });
  for (let i = 0; i < r1.results.length; i++) {
    assert.equal(r1.results[i].finalPrice, r2.results[i].finalPrice);
  }
});

test("different seeds produce different results", () => {
  const s1 = createSimulator({ seed: 1 });
  const s2 = createSimulator({ seed: 2 });
  const r1 = s1.simulate({ paths: 50, days: 10 });
  const r2 = s2.simulate({ paths: 50, days: 10 });
  let diff = 0;
  for (let i = 0; i < r1.results.length; i++) {
    if (r1.results[i].finalPrice !== r2.results[i].finalPrice) diff++;
  }
  assert.ok(diff > 40);
});

test("positive drift produces positive mean return", () => {
  const sim = createSimulator({ seed: 42 });
  const r = sim.simulate({ paths: 5000, days: 30, drift: 0.005, volatility: 0.01 });
  const risk = sim.computeRisk(r);
  assert.ok(risk.meanReturn > 0);
});

test("computeRisk returns VaR and drawdown metrics", () => {
  const sim = createSimulator({ seed: 7 });
  const r = sim.simulate({ paths: 1000, days: 30 });
  const risk = sim.computeRisk(r);
  assert.ok(risk);
  assert.equal(risk.paths, 1000);
  assert.ok(typeof risk.var95 === "number");
  assert.ok(typeof risk.var99 === "number");
  assert.ok(typeof risk.maxDrawdownMedian === "number");
  assert.ok(risk.probabilityOfLoss >= 0 && risk.probabilityOfLoss <= 1);
  assert.ok(typeof risk.sharpeRatio === "number");
});

test("var99 worse than var95", () => {
  const sim = createSimulator({ seed: 99 });
  const r = sim.simulate({ paths: 2000, days: 30 });
  const risk = sim.computeRisk(r);
  assert.ok(risk.var99 <= risk.var95);
});

test("computeRisk returns null for empty", () => {
  const sim = createSimulator();
  assert.equal(sim.computeRisk(null), null);
  assert.equal(sim.computeRisk({ results: [] }), null);
});

test("maxDrawdown is non-negative for all paths", () => {
  const sim = createSimulator({ seed: 5 });
  const r = sim.simulate({ paths: 200, days: 30 });
  for (const res of r.results) {
    assert.ok(res.maxDrawdown >= 0);
    assert.ok(res.maxDrawdown <= 1);
  }
});

test("stressTest applies crash scenarios to positions", () => {
  const sim = createSimulator();
  const positions = [
    { symbol: "AAPL", price: 200, quantity: 10 },
    { symbol: "MSFT", price: 400, quantity: 5 },
  ];
  const results = sim.stressTest(positions);
  assert.ok(Array.isArray(results));
  assert.ok(results.length >= 5);
  for (const s of results) {
    assert.ok(typeof s.scenario === "string");
    assert.ok(typeof s.totalLoss === "number");
    assert.ok(s.totalLoss < 0);
    assert.equal(s.details.length, 2);
  }
});

test("stressTest flash crash produces ~15% loss", () => {
  const sim = createSimulator();
  const positions = [{ symbol: "X", price: 100, quantity: 1 }];
  const results = sim.stressTest(positions);
  const flash = results.find(r => r.scenario === "flash_crash");
  assert.ok(flash);
  assert.ok(Math.abs(flash.totalLossPct - (-0.15)) < 0.01);
});

test("stressTest accepts custom scenarios", () => {
  const sim = createSimulator();
  const positions = [{ symbol: "TEST", price: 1000, quantity: 100 }];
  const custom = [{ name: "custom_crash", dailyDrop: -0.20, days: 3, description: "custom" }];
  const results = sim.stressTest(positions, custom);
  assert.equal(results.length, 1);
  assert.equal(results[0].scenario, "custom_crash");
  assert.ok(results[0].totalLoss < 0);
});

test("stressTest handles empty positions", () => {
  const sim = createSimulator();
  const results = sim.stressTest([]);
  for (const r of results) {
    assert.equal(r.totalLoss, 0);
    assert.equal(r.details.length, 0);
  }
});

test("STRESS_SCENARIOS has required fields", () => {
  const sim = createSimulator();
  for (const s of sim.STRESS_SCENARIOS) {
    assert.ok(typeof s.name === "string");
    assert.ok(typeof s.dailyDrop === "number");
    assert.ok(typeof s.days === "number");
    assert.ok(s.dailyDrop < 0);
    assert.ok(s.days > 0);
  }
});

test("simulate honors custom initialPrice", () => {
  const sim = createSimulator({ seed: 1 });
  const r = sim.simulate({ paths: 10, days: 5, initialPrice: 50000 });
  for (const res of r.results) {
    assert.equal(res.path[0], 50000);
  }
});
