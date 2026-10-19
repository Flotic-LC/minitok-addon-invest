"use strict";

/**
 * Multi-Agent Council — validates AI trading decisions through multiple
 * adversarial perspectives before execution.
 *
 * Roles:
 *   - Strategist: evaluates signal quality, entry timing, position sizing
 *   - RiskManager: evaluates drawdown risk, exposure, correlation, volatility
 *   - Critic: devil's advocate, finds historical failure patterns
 *   - Arbiter: final LLM-based resolution when agents disagree
 *
 * Consensus model (from constitution.yaml):
 *   - Weighted vote: strategist=1.0, risk_manager=1.5, critic=1.0
 *   - Threshold: 0.6 weighted agreement required
 *   - Default on disagreement: HOLD
 *
 * Usage:
 *   const { createCouncil } = require("./src/council/council");
 *   const council = createCouncil({ callLLM, constitution });
 *   const verdict = await council.evaluate(decision, context);
 */

const DEFAULTS = Object.freeze({
  weights: { strategist: 1.0, risk_manager: 1.5, critic: 1.0 },
  consensusThreshold: 0.6,
  defaultOnDisagreement: "HOLD",
  maxPositionPct: 20.0,
  maxDailyTrades: 50,
  maxExposurePct: 85.0,
  minCashReservePct: 15.0,
  vixCrisisThreshold: 40,
  callLLM: null,
  constitutionHardLimits: null,
  maxHistory: Number(process.env.COUNCIL_MAX_HISTORY || 2000),
});

/**
 * Constitution Hard Limits — inviolable checks that run BEFORE council voting.
 * Any violation results in immediate rejection regardless of council consensus.
 * These enforce the absolute boundaries defined in constitution.yaml §1.
 *
 * Checked limits:
 *   - maxSinglePositionPct: single order cannot exceed X% of equity
 *   - maxTotalExposurePct: total portfolio exposure cap
 *   - maxOpenPositions: maximum concurrent positions
 *   - minCashReservePct: minimum cash buffer
 *   - maxSingleOrderKrw: absolute KRW cap per order
 *   - maxDailyTrades: daily trade count cap
 *   - maxPairwiseCorrelation: portfolio correlation cap (if ctx provides it)
 */
function checkConstitutionHardLimits(decision, ctx, limits) {
  var violations = [];
  if (!limits || !decision || decision.action === "HOLD") return violations;

  // Position size as % of equity
  if (limits.maxSinglePositionPct != null && ctx.totalEquity > 0 && decision.price && decision.quantity) {
    var positionPct = (decision.price * decision.quantity / ctx.totalEquity) * 100;
    if (positionPct > limits.maxSinglePositionPct) {
      violations.push("CONSTITUTION: Position " + positionPct.toFixed(1) + "% exceeds hard limit " + limits.maxSinglePositionPct + "%");
    }
  }

  // Total exposure check (would-be exposure after this trade)
  if (limits.maxTotalExposurePct != null && ctx.currentExposurePct != null) {
    var projectedExposure = ctx.currentExposurePct;
    if (decision.action === "BUY" && ctx.totalEquity > 0 && decision.price && decision.quantity) {
      projectedExposure += (decision.price * decision.quantity / ctx.totalEquity) * 100;
    }
    if (projectedExposure > limits.maxTotalExposurePct) {
      violations.push("CONSTITUTION: Projected exposure " + projectedExposure.toFixed(1) + "% exceeds hard limit " + limits.maxTotalExposurePct + "%");
    }
  }

  // Max open positions (only blocks new BUY)
  if (limits.maxOpenPositions != null && ctx.openPositions != null && decision.action === "BUY") {
    if (ctx.openPositions >= limits.maxOpenPositions) {
      violations.push("CONSTITUTION: Open positions " + ctx.openPositions + " at hard limit " + limits.maxOpenPositions);
    }
  }

  // Cash reserve (only blocks new BUY)
  if (limits.minCashReservePct != null && ctx.cashReservePct != null && decision.action === "BUY") {
    if (ctx.cashReservePct < limits.minCashReservePct) {
      violations.push("CONSTITUTION: Cash reserve " + ctx.cashReservePct.toFixed(1) + "% below hard limit " + limits.minCashReservePct + "%");
    }
  }

  // Absolute KRW cap per order
  if (limits.maxSingleOrderKrw != null && decision.price && decision.quantity) {
    var orderValue = decision.price * decision.quantity;
    if (orderValue > limits.maxSingleOrderKrw) {
      violations.push("CONSTITUTION: Order value " + orderValue + " KRW exceeds hard limit " + limits.maxSingleOrderKrw + " KRW");
    }
  }

  // Daily trade count cap
  if (limits.maxDailyTrades != null && ctx.dailyTradeCount != null) {
    if (ctx.dailyTradeCount >= limits.maxDailyTrades) {
      violations.push("CONSTITUTION: Daily trades " + ctx.dailyTradeCount + " at hard limit " + limits.maxDailyTrades);
    }
  }

  // Pairwise correlation cap (if portfolio correlation matrix provided)
  if (limits.maxPairwiseCorrelation != null && ctx.maxPairwiseCorrelation != null) {
    if (ctx.maxPairwiseCorrelation > limits.maxPairwiseCorrelation && decision.action === "BUY") {
      violations.push("CONSTITUTION: Portfolio correlation " + ctx.maxPairwiseCorrelation.toFixed(2) + " exceeds hard limit " + limits.maxPairwiseCorrelation);
    }
  }

  return violations;
}

function createCouncil(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const totalWeight = cfg.weights.strategist + cfg.weights.risk_manager + cfg.weights.critic;
  const history = [];

  // --- Strategist: signal quality & timing ---
  function strategistEvaluate(decision, ctx) {
    const issues = [];
    let score = 0.5;

    if (ctx.technicals && ctx.technicals.rsi14 != null) {
      const rsi = ctx.technicals.rsi14;
      if (decision.action === "BUY" && rsi > 70) {
        issues.push("BUY at overbought RSI=" + rsi.toFixed(1));
        score -= 0.3;
      } else if (decision.action === "BUY" && rsi < 30) {
        score += 0.2;
      } else if (decision.action === "SELL" && rsi < 30) {
        issues.push("SELL at oversold RSI=" + rsi.toFixed(1));
        score -= 0.2;
      } else if (decision.action === "SELL" && rsi > 70) {
        score += 0.2;
      }
    }

    if (ctx.technicals && ctx.technicals.macd) {
      const hist = ctx.technicals.macd.histogram || 0;
      if (decision.action === "BUY" && hist < 0) {
        issues.push("BUY against negative MACD histogram");
        score -= 0.1;
      } else if (decision.action === "SELL" && hist > 0) {
        issues.push("SELL against positive MACD histogram");
        score -= 0.1;
      }
    }

    if (ctx.regime === "crisis" && decision.action === "BUY") {
      issues.push("BUY during crisis regime");
      score -= 0.3;
    }
    if (ctx.regime === "expansion" && decision.action === "BUY") {
      score += 0.1;
    }

    return { role: "strategist", score: Math.max(0, Math.min(1, score)), issues, approve: score >= 0.4 };
  }

  // --- RiskManager: exposure, sizing, volatility ---
  function riskManagerEvaluate(decision, ctx) {
    const issues = [];
    let score = 0.7;

    if (ctx.totalEquity > 0 && decision.price && decision.quantity) {
      const orderValue = decision.price * decision.quantity;
      const positionPct = (orderValue / ctx.totalEquity) * 100;
      if (positionPct > cfg.maxPositionPct) {
        issues.push("Position " + positionPct.toFixed(1) + "% exceeds max " + cfg.maxPositionPct + "%");
        score -= 0.4;
      }
    }

    if (ctx.currentExposurePct != null && ctx.currentExposurePct > cfg.maxExposurePct) {
      issues.push("Current exposure " + ctx.currentExposurePct.toFixed(1) + "% exceeds max " + cfg.maxExposurePct + "%");
      score -= 0.3;
    }

    if (ctx.intelligence && ctx.intelligence.vix > cfg.vixCrisisThreshold) {
      issues.push("VIX " + ctx.intelligence.vix + " > crisis threshold " + cfg.vixCrisisThreshold);
      score -= 0.5;
    }

    if (ctx.regime === "crisis" || ctx.regime === "contraction") {
      if (decision.action === "BUY") {
        issues.push("BUY in " + ctx.regime + " regime — elevated risk");
        score -= 0.2;
      }
    }

    if (ctx.openPositions != null && ctx.openPositions >= cfg.maxDailyTrades) {
      issues.push("Max positions reached");
      score -= 0.5;
    }

    return { role: "risk_manager", score: Math.max(0, Math.min(1, score)), issues, approve: score >= 0.4 };
  }

  // --- Critic: devil's advocate ---
  function criticEvaluate(decision, ctx) {
    const issues = [];
    let score = 0.5;

    if (ctx.similarExperiences && ctx.similarExperiences.length > 0) {
      const losses = ctx.similarExperiences.filter(e => e.pnl != null && e.pnl < 0);
      if (losses.length > ctx.similarExperiences.length / 2) {
        issues.push(losses.length + "/" + ctx.similarExperiences.length + " similar past decisions lost money");
        score -= 0.3;
      }
    }

    if (!decision.reason || decision.reason.length < 10) {
      issues.push("Insufficient justification for " + decision.action);
      score -= 0.2;
    }

    if (ctx.technicals && decision.action === "BUY") {
      const bb = ctx.technicals.bollinger;
      if (bb && ctx.technicals.lastClose > bb.upper) {
        issues.push("BUY above Bollinger upper band");
        score -= 0.2;
      }
    }

    if (decision.action === "HOLD") {
      score = 0.8;
    }

    return { role: "critic", score: Math.max(0, Math.min(1, score)), issues, approve: score >= 0.4 };
  }

  // --- Weighted consensus ---
  function computeConsensus(votes) {
    let weightedApprove = 0;
    let weightedTotal = 0;
    for (const v of votes) {
      const w = cfg.weights[v.role] || 1.0;
      weightedTotal += w;
      if (v.approve) weightedApprove += w;
    }
    return weightedTotal > 0 ? weightedApprove / weightedTotal : 0;
  }

  // --- Main evaluate ---
  async function evaluate(decision, context) {
    if (!decision || decision.action === "HOLD") {
      return { action: "HOLD", consensus: 1.0, votes: [], reason: "HOLD requires no validation" };
    }

    // --- Constitution Hard Limits (P1-5): inviolable, pre-vote gate ---
    const hardViolations = checkConstitutionHardLimits(decision, context || {}, cfg.constitutionHardLimits);
    if (hardViolations.length > 0) {
      history.push({
        ts: new Date().toISOString(),
        decision: decision.action,
        symbol: decision.symbol,
        consensus: 0,
        approved: false,
        arbiterOverride: false,
        constitutionViolation: true,
      });
      if (history.length > cfg.maxHistory) history.splice(0, history.length - cfg.maxHistory);
      return {
        action: cfg.defaultOnDisagreement,
        consensus: 0,
        votes: [],
        issues: hardViolations,
        approved: false,
        constitutionViolation: true,
        originalAction: decision.action,
        arbiterNote: null,
      };
    }

    const votes = [
      strategistEvaluate(decision, context),
      riskManagerEvaluate(decision, context),
      criticEvaluate(decision, context),
    ];

    const consensus = computeConsensus(votes);
    const approved = consensus >= cfg.consensusThreshold;
    const allIssues = votes.reduce((acc, v) => acc.concat(v.issues), []);

    // Arbiter: if close to threshold, try LLM override
    let arbiterNote = null;
    if (!approved && consensus >= cfg.consensusThreshold * 0.8 && cfg.callLLM) {
      try {
        const prompt = [
          { role: "system", content: "You are a trading council arbiter. Decide APPROVE or REJECT. JSON: {\"verdict\":\"APPROVE\"|\"REJECT\",\"reason\":\"string\"}" },
          { role: "user", content: JSON.stringify({ decision: { action: decision.action, symbol: decision.symbol }, votes: votes.map(v => ({ role: v.role, score: v.score, issues: v.issues })), consensus }) },
        ];
        const arb = await cfg.callLLM(prompt);
        if (arb && arb.verdict === "APPROVE") {
          arbiterNote = arb.reason || "Arbiter override";
          history.push({ ts: new Date().toISOString(), decision: decision.action, symbol: decision.symbol, consensus, approved: true, arbiterOverride: true });
          if (history.length > cfg.maxHistory) history.splice(0, history.length - cfg.maxHistory);
          return { action: decision.action, consensus, votes, issues: allIssues, approved: true, arbiterNote };
        } else if (arb) {
          arbiterNote = arb.reason || "Arbiter rejected";
        }
      } catch { /* arbiter failure = reject */ }
    }

    const finalAction = approved ? decision.action : cfg.defaultOnDisagreement;
    history.push({ ts: new Date().toISOString(), decision: decision.action, symbol: decision.symbol, consensus, approved, arbiterOverride: false });
    if (history.length > cfg.maxHistory) history.splice(0, history.length - cfg.maxHistory);

    return {
      action: finalAction,
      consensus: Number(consensus.toFixed(3)),
      votes,
      issues: allIssues,
      approved,
      arbiterNote,
      originalAction: decision.action,
    };
  }

  function stats() {
    return {
      totalEvaluations: history.length,
      approvals: history.filter(h => h.approved).length,
      rejections: history.filter(h => !h.approved).length,
      arbiterOverrides: history.filter(h => h.arbiterOverride).length,
      consensusThreshold: cfg.consensusThreshold,
    };
  }

  function clearHistory() { history.length = 0; }

  return { evaluate, stats, clearHistory };
}

module.exports = { createCouncil, DEFAULTS };
