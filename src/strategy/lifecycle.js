"use strict";

/**
 * Strategy Lifecycle Manager — manages strategies through their lifecycle:
 * DISCOVERY → INCUBATION → PRODUCTION → RETIREMENT
 *
 * Features:
 *   - LLM-proposed strategies enter DISCOVERY phase
 *   - Validation pipeline: walk-forward OOS + VaR check + council approval
 *   - Graduated promotion: paper → 10% → 50% → 100% allocation
 *   - Automatic retirement on performance degradation (Sharpe, DD, win rate)
 *   - State persistence across restarts
 *
 * Lifecycle phases:
 *   DISCOVERY:   LLM proposes strategy, awaiting validation
 *   INCUBATION:  Shadow mode, collecting paper performance data
 *   PRODUCTION:  Live trading with graduated allocation (10%→50%→100%)
 *   RETIREMENT:  Strategy deactivated due to performance degradation
 *
 * Retirement triggers (L45_IMPLEMENTATION_PLAN.md §7.3):
 *   - 30-day rolling Sharpe < 0.0 → revert to shadow
 *   - 60-day rolling Sharpe < 0.2 → strategy review alert
 *   - Max drawdown > strategy limit × 1.5 → killswitch + retire
 *   - Win rate < 35% over 50 trades → feed back to evolution
 *
 * Usage:
 *   const { createLifecycleManager } = require("./src/strategy/lifecycle");
 *   const lifecycle = createLifecycleManager({
 *     walkForwardValidator, varEngine, council,
 *     onRetire: (id, reason) => { ... }
 *   });
 *   const strategy = lifecycle.proposeStrategy({ name: "momentum_v2", logic: "...", hypothesis: "..." });
 *   const verdict = await lifecycle.validate(strategy.id);
 *   if (verdict.verdict === "promote") lifecycle.promote(strategy.id, "INCUBATION");
 */

const DEFAULTS = Object.freeze({
  minSharpe30d: Number(process.env.LIFECYCLE_MIN_SHARPE_30D || 0.0),
  minSharpe60d: Number(process.env.LIFECYCLE_MIN_SHARPE_60D || 0.2),
  maxDrawdownMultiplier: Number(process.env.LIFECYCLE_DD_MULTIPLIER || 1.5),
  minWinRate: Number(process.env.LIFECYCLE_MIN_WIN_RATE || 0.35),
  minTradesForWinRate: Number(process.env.LIFECYCLE_MIN_TRADES_WIN_RATE || 50),
  promotionLevels: [0.10, 0.50, 1.00], // paper → 10% → 50% → 100%
  rollingWindow30d: 30,
  rollingWindow60d: 60,
  maxHistorySize: 1000,
  maxDrawdownLimit: 1000, // default DD limit in currency units
  now: null,
});

const PHASES = Object.freeze({
  DISCOVERY: "DISCOVERY",
  INCUBATION: "INCUBATION",
  PRODUCTION: "PRODUCTION",
  RETIREMENT: "RETIREMENT",
});

// --- Statistics helpers ---
function mean(arr) {
  if (!arr || arr.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

function stddev(arr, mu) {
  if (!arr || arr.length < 2) return 0;
  if (mu == null) mu = mean(arr);
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += Math.pow(arr[i] - mu, 2);
  return Math.sqrt(s / arr.length);
}

/**
 * Compute rolling Sharpe ratio from a daily returns series.
 * Annualized with sqrt(252).
 */
function computeRollingSharpe(returns, windowDays) {
  if (!returns || returns.length < 2) return 0;
  const recent = windowDays ? returns.slice(-windowDays) : returns;
  if (recent.length < 2) return 0;
  const mu = mean(recent);
  const sd = stddev(recent, mu);
  if (sd === 0) return 0; // zero variance = undefined Sharpe, treat as 0 (conservative)
  return (mu / sd) * Math.sqrt(252);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
function createLifecycleManager(options) {
  const opts = options || {};
  const cfg = { ...DEFAULTS, ...(opts.config || {}) };
  const walkForwardValidator = opts.walkForwardValidator || null;
  const varEngine = opts.varEngine || null;
  const council = opts.council || null;
  const onPromote = typeof opts.onPromote === "function" ? opts.onPromote : function() {};
  const onRetire = typeof opts.onRetire === "function" ? opts.onRetire : function() {};
  const onReview = typeof opts.onReview === "function" ? opts.onReview : function() {};
  const now = typeof cfg.now === "function" ? cfg.now : function() { return Date.now(); };

  const strategies = new Map();
  const history = [];
  let idCounter = 0;

  function generateId() {
    return "strat_" + (++idCounter) + "_" + now();
  }

  function addHistory(event, payload) {
    const entry = Object.assign({ ts: new Date(now()).toISOString(), event: event }, payload || {});
    history.push(entry);
    if (history.length > cfg.maxHistorySize) {
      history.splice(0, history.length - cfg.maxHistorySize);
    }
    return entry;
  }

  // ===========================================================================
  // proposeStrategy — LLM-proposed strategy enters DISCOVERY
  // ===========================================================================
  function proposeStrategy(llmContext) {
    if (!llmContext || !llmContext.name) {
      throw new Error("proposeStrategy requires llmContext with 'name'");
    }
    if (typeof llmContext.name !== "string" || llmContext.name.trim().length === 0) {
      throw new Error("proposeStrategy: name must be a non-empty string");
    }
    const id = generateId();
    const strategy = {
      id: id,
      name: llmContext.name.trim(),
      logic: llmContext.logic || null,
      hypothesis: llmContext.hypothesis || null,
      parameters: llmContext.parameters || {},
      phase: PHASES.DISCOVERY,
      allocationPct: 0,
      promotionLevel: -1, // -1 = not yet promoted; 0 = paper (10%), 1 = 50%, 2 = 100%
      createdAt: now(),
      promotedAt: null,
      retiredAt: null,
      retirementReason: null,
      performance: {
        fills: [],
        totalPnl: 0,
        wins: 0,
        losses: 0,
        maxDrawdown: 0,
        peakPnl: 0,
        currentDrawdown: 0,
        dailyReturns: [], // [{ date, returnPct }]
      },
      validationAttempts: 0,
      lastValidationResult: null,
    };
    strategies.set(id, strategy);
    addHistory("PROPOSE", { strategyId: id, name: strategy.name });
    return { id: strategy.id, name: strategy.name, phase: strategy.phase };
  }

  // ===========================================================================
  // validate — walk-forward OOS + VaR + council pipeline
  // ===========================================================================
  async function validate(strategyId) {
    const strat = strategies.get(strategyId);
    if (!strat) throw new Error("Strategy not found: " + strategyId);
    if (strat.phase !== PHASES.DISCOVERY) {
      return { verdict: "reject", score: 0, reason: "Strategy not in DISCOVERY phase (current: " + strat.phase + ")" };
    }

    strat.validationAttempts++;
    const details = { walkForward: null, varCheck: null, council: null };
    let score = 0;
    let checksPassed = 0;
    let checksAttempted = 0;

    // 1. Walk-forward OOS validation
    if (walkForwardValidator) {
      checksAttempted++;
      try {
        const wfResult = walkForwardValidator.validate ? walkForwardValidator.validate() : null;
        details.walkForward = wfResult;
        if (wfResult && wfResult.verdict === "deploy") {
          score += 0.4;
          checksPassed++;
        } else if (wfResult && wfResult.verdict === "reject") {
          strat.lastValidationResult = {
            verdict: "reject", score: 0,
            reason: "Walk-forward rejected: " + (wfResult.reason || "unknown"),
            details: details,
          };
          addHistory("VALIDATE_REJECT", { strategyId: strategyId, reason: "walk_forward" });
          return strat.lastValidationResult;
        }
      } catch (e) {
        details.walkForward = { error: e.message };
      }
    }

    // 2. VaR risk check
    if (varEngine && strat.parameters && strat.parameters.returns) {
      checksAttempted++;
      try {
        const varReport = varEngine.fullReport ? varEngine.fullReport(strat.parameters.returns) : null;
        details.varCheck = varReport;
        if (varReport && varReport.summary) {
          const varPct = (varReport.summary.parametricVaR || 0) * 100;
          if (varPct < 5) { score += 0.3; checksPassed++; }
          else if (varPct < 10) { score += 0.15; checksPassed++; }
        }
      } catch (e) {
        details.varCheck = { error: e.message };
      }
    }

    // 3. Council approval
    if (council && council.evaluate) {
      checksAttempted++;
      try {
        const councilVerdict = await council.evaluate(
          { action: "BUY", symbol: "STRATEGY_PROPOSAL", strategyName: strat.name },
          { strategyProposal: strat, validationDetails: details }
        );
        details.council = councilVerdict;
        if (councilVerdict && councilVerdict.approved) {
          score += 0.3;
          checksPassed++;
        }
      } catch (e) {
        details.council = { error: e.message };
      }
    }

    // Decision logic
    let verdict = "reject";
    let reason = "";
    if (checksAttempted === 0) {
      verdict = "shadow";
      reason = "No validators configured; entering shadow mode for observation";
    } else if (score >= 0.7) {
      verdict = "promote";
      reason = "Validation passed (score=" + score.toFixed(2) + ", checks=" + checksPassed + "/" + checksAttempted + ")";
    } else if (score >= 0.4) {
      verdict = "shadow";
      reason = "Partial validation (score=" + score.toFixed(2) + "), entering shadow mode";
    } else {
      reason = "Insufficient validation (score=" + score.toFixed(2) + ", checks=" + checksPassed + "/" + checksAttempted + ")";
    }

    strat.lastValidationResult = { verdict: verdict, score: Number(score.toFixed(3)), reason: reason, details: details };
    addHistory("VALIDATE_" + verdict.toUpperCase(), { strategyId: strategyId, score: score, reason: reason });
    return strat.lastValidationResult;
  }

  // ===========================================================================
  // promote — advance strategy to next phase or allocation level
  // ===========================================================================
  function promote(strategyId, targetPhase) {
    var strat = strategies.get(strategyId);
    if (!strat) throw new Error("Strategy not found: " + strategyId);

    if (targetPhase === PHASES.INCUBATION) {
      if (strat.phase !== PHASES.DISCOVERY) {
        throw new Error("Can only promote to INCUBATION from DISCOVERY (current: " + strat.phase + ")");
      }
      strat.phase = PHASES.INCUBATION;
      strat.promotedAt = now();
      strat.allocationPct = 0; // paper trading
      strat.promotionLevel = -1;
    } else if (targetPhase === PHASES.PRODUCTION) {
      if (strat.phase !== PHASES.INCUBATION && strat.phase !== PHASES.PRODUCTION) {
        throw new Error("Can only promote to PRODUCTION from INCUBATION or PRODUCTION (current: " + strat.phase + ")");
      }
      strat.phase = PHASES.PRODUCTION;
      if (!strat.promotedAt) strat.promotedAt = now();
      var nextLevel = strat.promotionLevel + 1;
      if (nextLevel < cfg.promotionLevels.length) {
        strat.promotionLevel = nextLevel;
        strat.allocationPct = cfg.promotionLevels[nextLevel];
      } else {
        strat.allocationPct = cfg.promotionLevels[cfg.promotionLevels.length - 1];
      }
    } else if (targetPhase === PHASES.RETIREMENT) {
      return retire(strategyId, "manual_retirement");
    } else {
      throw new Error("Invalid target phase: " + targetPhase);
    }

    addHistory("PROMOTE", { strategyId: strategyId, toPhase: strat.phase, allocationPct: strat.allocationPct, promotionLevel: strat.promotionLevel });
    try { onPromote(strategyId, strat.phase, strat.allocationPct); } catch {}
    return { id: strat.id, name: strat.name, phase: strat.phase, allocationPct: strat.allocationPct, promotionLevel: strat.promotionLevel };
  }

  // ===========================================================================
  // retire — deactivate strategy
  // ===========================================================================
  function retire(strategyId, reason) {
    var strat = strategies.get(strategyId);
    if (!strat) throw new Error("Strategy not found: " + strategyId);
    if (strat.phase === PHASES.RETIREMENT) {
      return { id: strat.id, name: strat.name, phase: strat.phase, reason: strat.retirementReason };
    }
    var prevPhase = strat.phase;
    strat.phase = PHASES.RETIREMENT;
    strat.retiredAt = now();
    strat.retirementReason = reason || "unknown";
    strat.allocationPct = 0;
    addHistory("RETIRE", { strategyId: strategyId, reason: reason, fromPhase: prevPhase });
    try { onRetire(strategyId, reason, prevPhase); } catch {}
    return { id: strat.id, name: strat.name, phase: strat.phase, reason: strat.retirementReason };
  }

  // ===========================================================================
  // recordFill — record a trade result for a strategy
  // ===========================================================================
  function recordFill(strategyId, fill) {
    var strat = strategies.get(strategyId);
    if (!strat) throw new Error("Strategy not found: " + strategyId);
    if (!fill || fill.pnl == null) return;

    strat.performance.fills.push(fill);
    strat.performance.totalPnl += fill.pnl;
    if (fill.pnl > 0) strat.performance.wins++;
    else if (fill.pnl < 0) strat.performance.losses++;

    if (strat.performance.totalPnl > strat.performance.peakPnl) {
      strat.performance.peakPnl = strat.performance.totalPnl;
    }
    strat.performance.currentDrawdown = strat.performance.peakPnl - strat.performance.totalPnl;
    if (strat.performance.currentDrawdown > strat.performance.maxDrawdown) {
      strat.performance.maxDrawdown = strat.performance.currentDrawdown;
    }

    // Daily returns tracking
    var date = new Date(fill.timestamp || now()).toISOString().split("T")[0];
    var existing = null;
    for (var i = 0; i < strat.performance.dailyReturns.length; i++) {
      if (strat.performance.dailyReturns[i].date === date) {
        existing = strat.performance.dailyReturns[i];
        break;
      }
    }
    if (existing) {
      existing.pnl += fill.pnl;
    } else {
      strat.performance.dailyReturns.push({ date: date, pnl: fill.pnl });
    }
  }

  // ===========================================================================
  // checkRetirement — evaluate retirement conditions
  // ===========================================================================
  function checkRetirement(strategyId) {
    var strat = strategies.get(strategyId);
    if (!strat) throw new Error("Strategy not found: " + strategyId);
    if (strat.phase === PHASES.RETIREMENT) {
      return { shouldRetire: false, reason: "already_retired", metrics: {} };
    }

    var perf = strat.performance;
    var totalTrades = perf.wins + perf.losses;
    var winRate = totalTrades > 0 ? perf.wins / totalTrades : 0;

    var dailyPnls = perf.dailyReturns.map(function(d) { return d.pnl; });
    var sharpe30d = computeRollingSharpe(dailyPnls, cfg.rollingWindow30d);
    var sharpe60d = computeRollingSharpe(dailyPnls, cfg.rollingWindow60d);

    var ddLimit = (strat.parameters && strat.parameters.maxDrawdownLimit) || cfg.maxDrawdownLimit;

    var metrics = {
      totalTrades: totalTrades,
      winRate: Number(winRate.toFixed(3)),
      sharpe30d: Number(sharpe30d.toFixed(3)),
      sharpe60d: Number(sharpe60d.toFixed(3)),
      maxDrawdown: perf.maxDrawdown,
      totalPnl: perf.totalPnl,
      dailyReturnCount: dailyPnls.length,
    };

    // Retirement condition checks (priority order)
    if (perf.maxDrawdown > ddLimit * cfg.maxDrawdownMultiplier) {
      return { shouldRetire: true, reason: "max_drawdown_exceeded", metrics: metrics };
    }
    if (dailyPnls.length >= cfg.rollingWindow30d && sharpe30d < cfg.minSharpe30d) {
      return { shouldRetire: true, reason: "30d_sharpe_below_threshold", metrics: metrics };
    }
    if (dailyPnls.length >= cfg.rollingWindow60d && sharpe60d < cfg.minSharpe60d) {
      return { shouldRetire: true, reason: "60d_sharpe_below_threshold", metrics: metrics };
    }
    if (totalTrades >= cfg.minTradesForWinRate && winRate < cfg.minWinRate) {
      return { shouldRetire: true, reason: "win_rate_below_threshold", metrics: metrics };
    }

    // Review alert (not retirement)
    if (dailyPnls.length >= Math.floor(cfg.rollingWindow60d * 0.5) && sharpe60d < cfg.minSharpe60d) {
      try { onReview(strategyId, "60d_sharpe_low", metrics); } catch {}
    }

    return { shouldRetire: false, reason: null, metrics: metrics };
  }


  // ===========================================================================
  // Accessors
  // ===========================================================================
  function getStrategy(strategyId) {
    var strat = strategies.get(strategyId);
    if (!strat) return null;
    return {
      id: strat.id,
      name: strat.name,
      logic: strat.logic,
      hypothesis: strat.hypothesis,
      parameters: strat.parameters,
      phase: strat.phase,
      allocationPct: strat.allocationPct,
      promotionLevel: strat.promotionLevel,
      createdAt: strat.createdAt,
      promotedAt: strat.promotedAt,
      retiredAt: strat.retiredAt,
      retirementReason: strat.retirementReason,
      performance: {
        totalPnl: strat.performance.totalPnl,
        wins: strat.performance.wins,
        losses: strat.performance.losses,
        maxDrawdown: strat.performance.maxDrawdown,
        currentDrawdown: strat.performance.currentDrawdown,
        totalTrades: strat.performance.wins + strat.performance.losses,
        fillCount: strat.performance.fills.length,
      },
      validationAttempts: strat.validationAttempts,
      lastValidationResult: strat.lastValidationResult,
    };
  }

  function listStrategies() {
    return Array.from(strategies.values()).map(function(s) {
      return {
        id: s.id, name: s.name, phase: s.phase,
        allocationPct: s.allocationPct, promotionLevel: s.promotionLevel,
        totalTrades: s.performance.wins + s.performance.losses,
        totalPnl: s.performance.totalPnl,
        maxDrawdown: s.performance.maxDrawdown,
      };
    });
  }

  function getByPhase(phase) {
    return listStrategies().filter(function(s) { return s.phase === phase; });
  }

  function stats() {
    var all = listStrategies();
    return {
      totalStrategies: all.length,
      byPhase: {
        discovery: all.filter(function(s) { return s.phase === PHASES.DISCOVERY; }).length,
        incubation: all.filter(function(s) { return s.phase === PHASES.INCUBATION; }).length,
        production: all.filter(function(s) { return s.phase === PHASES.PRODUCTION; }).length,
        retirement: all.filter(function(s) { return s.phase === PHASES.RETIREMENT; }).length,
      },
      totalAllocatedPct: Number(all.reduce(function(sum, s) { return sum + s.allocationPct; }, 0).toFixed(4)),
      historySize: history.length,
    };
  }

  function getHistory(limit) {
    var lim = limit || history.length;
    return history.slice(-lim);
  }


  // ===========================================================================
  // State persistence
  // ===========================================================================
  function state() {
    return {
      strategies: Array.from(strategies.entries()),
      history: history.slice(-cfg.maxHistorySize),
      idCounter: idCounter,
    };
  }

  function restore(savedState) {
    if (!savedState) return;
    if (savedState.strategies && Array.isArray(savedState.strategies)) {
      strategies.clear();
      for (var i = 0; i < savedState.strategies.length; i++) {
        var entry = savedState.strategies[i];
        strategies.set(entry[0], entry[1]);
      }
    }
    if (savedState.history && Array.isArray(savedState.history)) {
      history.length = 0;
      for (var j = 0; j < savedState.history.length; j++) {
        history.push(savedState.history[j]);
      }
    }
    if (savedState.idCounter != null) idCounter = savedState.idCounter;
  }

  // ===========================================================================
  // registerExisting — register an already-live strategy directly into PRODUCTION
  // [P2-LIFECYCLE] Used at startup to reflect strategies that are already
  // running in production (e.g. base_signals) without going through DISCOVERY.
  // ===========================================================================
  function registerExisting(meta) {
    if (!meta || !meta.name) {
      throw new Error("registerExisting requires meta with 'name'");
    }
    // Idempotent: skip if a strategy with the same name is already registered
    for (const [, s] of strategies) {
      if (s.name === meta.name) {
        return { id: s.id, name: s.name, phase: s.phase, existing: true };
      }
    }
    const id = generateId();
    const strategy = {
      id: id,
      name: meta.name.trim(),
      logic: meta.logic || "pre-existing live strategy",
      hypothesis: meta.hypothesis || "Already running in production",
      parameters: meta.parameters || {},
      phase: PHASES.PRODUCTION,
      allocationPct: meta.allocationPct != null ? meta.allocationPct : 1.0,
      promotionLevel: 2, // 100% allocation (already live)
      createdAt: now(),
      promotedAt: now(),
      retiredAt: null,
      retirementReason: null,
      performance: {
        fills: [],
        totalPnl: 0,
        wins: 0,
        losses: 0,
        maxDrawdown: 0,
        peakPnl: 0,
        currentDrawdown: 0,
        dailyReturns: [],
      },
      validationAttempts: 0,
      lastValidationResult: null,
    };
    strategies.set(id, strategy);
    addHistory("REGISTER_EXISTING", { strategyId: id, name: strategy.name, phase: strategy.phase, allocationPct: strategy.allocationPct });
    return { id: strategy.id, name: strategy.name, phase: strategy.phase, existing: false };
  }

  function reset() {
    strategies.clear();
    history.length = 0;
    idCounter = 0;
  }

  return {
    proposeStrategy: proposeStrategy,
    validate: validate,
    promote: promote,
    retire: retire,
    recordFill: recordFill,
    checkRetirement: checkRetirement,
    getStrategy: getStrategy,
    listStrategies: listStrategies,
    getByPhase: getByPhase,
    stats: stats,
    getHistory: getHistory,
    state: state,
    restore: restore,
    reset: reset,
    registerExisting: registerExisting,
    _internals: { computeRollingSharpe: computeRollingSharpe, PHASES: PHASES },
  };
}

module.exports = { createLifecycleManager: createLifecycleManager, DEFAULTS: DEFAULTS, PHASES: PHASES };

