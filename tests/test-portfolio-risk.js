"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createPortfolioRisk } = require("../src/risk/portfolio-risk");

// --- Basic portfolio VaR ---
test("portfolioVaR returns zero for empty positions", () => {
  const pr = createPortfolioRisk();
  const result = pr.portfolioVaR([], []);
  assert.equal(result.totalVaR, 0);
  assert.equal(result.totalValue, 0);
  assert.deepEqual(result.weights, []);
});

test("single position VaR uses diagonal variance", () => {
  const pr = createPortfolioRisk({ confidence: 0.95, holdingDays: 1 });
  const positions = [{ symbol: "AAPL", qty: 10, currentPrice: 150 }];
  const cov = [[0.0004]]; // 2% daily vol
  const result = pr.portfolioVaR(positions, cov);
  assert.ok(result.totalVaR > 0, "VaR should be positive");
  assert.equal(result.totalValue, 1500);
  assert.deepEqual(result.weights, [1]);
  assert.equal(result.marginal.length, 1);
  assert.equal(result.component.length, 1);
});

test("two-position portfolio with correlation", () => {
  const pr = createPortfolioRisk({ confidence: 0.95 });
  const positions = [
    { symbol: "AAPL", qty: 10, currentPrice: 150 },
    { symbol: "MSFT", qty: 10, currentPrice: 300 },
  ];
  const cov = [[0.0004, 0.0002], [0.0002, 0.0004]];
  const result = pr.portfolioVaR(positions, cov);
  assert.ok(result.totalVaR > 0);
  assert.equal(result.totalValue, 4500);
  assert.equal(result.weights.length, 2);
  const compSum = result.component.reduce((s, c) => s + c.componentVaR, 0);
  assert.ok(Math.abs(compSum - result.varPct) < 0.001, "component VaR should sum to total varPct");
});

test("diversified portfolio has lower VaR than sum of individual VaRs", () => {
  const pr = createPortfolioRisk({ confidence: 0.95 });
  const pos1 = [{ symbol: "A", qty: 10, currentPrice: 100 }];
  const pos2 = [{ symbol: "B", qty: 10, currentPrice: 100 }];
  const both = [...pos1, ...pos2];
  const cov1 = [[0.0004]];
  const cov2 = [[0.0004]];
  const covBoth = [[0.0004, 0], [0, 0.0004]];
  const varA = pr.portfolioVaR(pos1, cov1).totalVaR;
  const varB = pr.portfolioVaR(pos2, cov2).totalVaR;
  const varBoth = pr.portfolioVaR(both, covBoth).totalVaR;
  assert.ok(varBoth < varA + varB, "diversified VaR should be less than sum of individual VaRs");
});

// --- Marginal VaR ---
test("marginal VaR identifies largest risk contributor", () => {
  const pr = createPortfolioRisk({ confidence: 0.95 });
  const positions = [
    { symbol: "SMALL", qty: 1, currentPrice: 100 },
    { symbol: "BIG", qty: 100, currentPrice: 100 },
  ];
  const cov = [[0.0004, 0.0001], [0.0001, 0.0004]];
  const result = pr.portfolioVaR(positions, cov);
  const bigComp = result.component.find(c => c.symbol === "BIG");
  const smallComp = result.component.find(c => c.symbol === "SMALL");
  assert.ok(bigComp.contributionPct > smallComp.contributionPct, "BIG should contribute more risk");
});

// --- Component VaR sums to total ---
test("component VaR sums to total varPct (Euler decomposition)", () => {
  const pr = createPortfolioRisk({ confidence: 0.95 });
  const positions = [
    { symbol: "A", qty: 10, currentPrice: 100 },
    { symbol: "B", qty: 20, currentPrice: 50 },
    { symbol: "C", qty: 5, currentPrice: 200 },
  ];
  const cov = [
    [0.0004, 0.0001, 0.00005],
    [0.0001, 0.0009, 0.0002],
    [0.00005, 0.0002, 0.0006],
  ];
  const result = pr.portfolioVaR(positions, cov);
  const compSum = result.component.reduce((s, c) => s + c.componentVaR, 0);
  assert.ok(Math.abs(compSum - result.varPct) < 0.0001, "Euler decomposition should sum to total");
  const pctSum = result.component.reduce((s, c) => s + c.contributionPct, 0);
  assert.ok(Math.abs(pctSum - 100) < 1, "contribution % should sum to ~100");
});

// --- Risk Budget ---
test("checkRiskBudget passes when under budget", () => {
  const pr = createPortfolioRisk({ confidence: 0.95, riskBudgetPct: 5.0 });
  const positions = [{ symbol: "A", qty: 10, currentPrice: 100 }];
  const cov = [[0.0004]];
  const proposed = { symbol: "B", qty: 5, currentPrice: 100 };
  const result = pr.checkRiskBudget(positions, cov, proposed, 100000);
  assert.ok(result.ok, "should pass: " + result.breach);
  assert.ok(result.budget > 0);
  assert.ok(result.proposedVaR > result.currentVaR);
});

test("checkRiskBudget blocks when over budget", () => {
  const pr = createPortfolioRisk({ confidence: 0.95, riskBudgetPct: 0.1 });
  const positions = [
    { symbol: "A", qty: 100, currentPrice: 100 },
    { symbol: "B", qty: 100, currentPrice: 100 },
  ];
  const cov = [[0.0004, 0.0002], [0.0002, 0.0004]];
  const proposed = { symbol: "C", qty: 100, currentPrice: 100 };
  const result = pr.checkRiskBudget(positions, cov, proposed, 50000);
  assert.ok(!result.ok, "should fail: budget=" + result.budget + " proposed=" + result.proposedVaR);
  assert.ok(result.breach);
});

// --- Covariance builders ---
test("buildDiagonalCov creates correct matrix", () => {
  const pr = createPortfolioRisk();
  const vols = [0.02, 0.03, 0.01];
  const cov = pr.buildDiagonalCov(vols);
  assert.equal(cov.length, 3);
  assert.equal(cov[0][0], 0.0004);
  assert.equal(cov[1][1], 0.0009);
  assert.equal(cov[2][2], 0.0001);
  assert.equal(cov[0][1], 0);
  assert.equal(cov[1][2], 0);
});

test("buildCovFromCorrelation creates correct matrix", () => {
  const pr = createPortfolioRisk();
  const vols = [0.02, 0.03];
  const corr = [[1, 0.5], [0.5, 1]];
  const cov = pr.buildCovFromCorrelation(vols, corr);
  assert.equal(cov[0][0], 0.0004);
  assert.equal(cov[1][1], 0.0009);
  assert.ok(Math.abs(cov[0][1] - 0.0003) < 0.00001, "cross-cov should be 0.02*0.03*0.5=0.0003");
  assert.equal(cov[0][1], cov[1][0]);
});

test("portfolio risk exposes config", () => {
  const pr = createPortfolioRisk({ confidence: 0.99, holdingDays: 10, riskBudgetPct: 3.0 });
  assert.equal(pr.config.confidence, 0.99);
  assert.equal(pr.config.holdingDays, 10);
  assert.equal(pr.config.riskBudgetPct, 3.0);
});

test("portfolioVaR uses identity covariance when none provided", () => {
  const pr = createPortfolioRisk({ confidence: 0.95 });
  const positions = [
    { symbol: "A", qty: 10, currentPrice: 100 },
    { symbol: "B", qty: 10, currentPrice: 100 },
  ];
  const result = pr.portfolioVaR(positions, null);
  assert.ok(result.totalVaR > 0, "should still compute VaR with default covariance");
});

