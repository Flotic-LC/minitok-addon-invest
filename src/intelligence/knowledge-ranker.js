"use strict";

/**
 * Knowledge Ranker — Phase R-6.
 * Enhances hypothesis ranking with historical knowledge-store outcomes.
 * Also records hypothesis outcomes back to knowledge-store.
 */

var DEFAULTS = Object.freeze({
  winRateBonus: Number(process.env.KR_WIN_BONUS || 0.3),
  winRatePenalty: Number(process.env.KR_WIN_PENALTY || 0.3),
  negativeEVPenalty: Number(process.env.KR_NEG_EV_PENALTY || 0.5),
  minTrades: Number(process.env.KR_MIN_TRADES || 3),
  highWinRate: Number(process.env.KR_HIGH_WIN || 0.6),
  lowWinRate: Number(process.env.KR_LOW_WIN || 0.3),
});

function createKnowledgeRanker(options) {
  var cfg = Object.assign({}, DEFAULTS, options || {});
  var knowledgeStore = cfg.knowledgeStore || null;
  var hypothesisEngine = cfg.hypothesisEngine || null;
  var outcomeFeedback = cfg.outcomeFeedback || null;

  var history = [];
  var installed = false, originalRankProposals = null;
  var counters = { rankings: 0, boosted: 0, penalized: 0, outcomesRecorded: 0 };

  function record(e) { history.push(e); if (history.length > 500) history.shift(); }

function adjustScore(score, hyp) {
    if (!knowledgeStore || typeof knowledgeStore.lookup !== "function") return { score: score, adjustment: 0 };
    var symbol = hyp.symbol || hyp.targetSymbol || null;
    var strategy = hyp.strategy || hyp.targetStrategy || null;
    if (!strategy && hyp.type === "regime_shift_weight" && hyp.action) {
      var m = hyp.action.match(/(\w+) strategy/i); if (m) strategy = m[1];
    }
    var info = null;
    if (symbol) info = knowledgeStore.lookup(symbol, strategy);
    else if (strategy) {
      info = { trades: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0, expectedValue: 0 };
      if (typeof knowledgeStore.lookup === "function") info = knowledgeStore.lookup("AGGREGATE", strategy);
    }
    if (!info || info.trades < cfg.minTrades) return { score: score, adjustment: 0, reason: "insufficient_history" };
    var adjustment = 0, reason = "";
    if (info.expectedValue < 0) { adjustment = -cfg.negativeEVPenalty; reason = "negative EV"; counters.penalized++; }
    else if (info.winRate >= cfg.highWinRate) { adjustment = cfg.winRateBonus; reason = "high WR " + (info.winRate * 100).toFixed(0) + "%"; counters.boosted++; }
    else if (info.winRate <= cfg.lowWinRate) { adjustment = -cfg.winRatePenalty; reason = "low WR " + (info.winRate * 100).toFixed(0) + "%"; counters.penalized++; }
    else reason = "neutral WR " + (info.winRate * 100).toFixed(0) + "%";
    return { score: score + adjustment, adjustment: adjustment, reason: reason, info: info };
  }

  function enhancedRankProposals() {
    counters.rankings++;
    var original = originalRankProposals.call(hypothesisEngine);
    if (!Array.isArray(original)) return original;
    var enhanced = [];
    for (var i = 0; i < original.length; i++) {
      var item = Object.assign({}, original[i]);
      var adj = adjustScore(item.score || 0, item);
      item.originalScore = item.score;
      item.score = Number(adj.score.toFixed(3));
      item.knowledgeAdjustment = adj.adjustment;
      item.knowledgeReason = adj.reason || null;
      enhanced.push(item);
    }
    enhanced.sort(function(a, b) { return b.score - a.score; });
    return enhanced;
  }

  function recordVerdict(verdict) {
    if (!knowledgeStore || typeof knowledgeStore.recordOutcome !== "function") return { ok: false, reason: "no_knowledgeStore" };
    if (!verdict || !verdict.hypothesisId) return { ok: false, reason: "no_hypothesisId" };
    var hyp = null;
    if (hypothesisEngine && typeof hypothesisEngine.getHypotheses === "function") {
      var hyps = hypothesisEngine.getHypotheses(500);
      for (var i = 0; i < hyps.length; i++) if (hyps[i].id === verdict.hypothesisId) { hyp = hyps[i]; break; }
    }
    var outcome = { symbol: (hyp && hyp.symbol) || verdict.symbol || "UNKNOWN",
      action: "hypothesis_" + (hyp ? hyp.type : "unknown"),
      strategy: (hyp && hyp.strategy) || verdict.strategy || null,
      score: (hyp && hyp.confidence) || 0.5,
      pnl: verdict.confirmed ? (verdict.lift || 1) : -(Math.abs(verdict.lift || 1)),
      reason: "hypothesis " + (verdict.confirmed ? "confirmed" : "rejected") };
    knowledgeStore.recordOutcome(outcome);
    counters.outcomesRecorded++;
    record({ ts: new Date().toISOString(), hypId: verdict.hypothesisId, confirmed: verdict.confirmed });
    return { ok: true };
  }

  function install() {
    if (installed) return { ok: false, reason: "already_installed" };
    if (!hypothesisEngine || typeof hypothesisEngine.rankProposals !== "function") return { ok: false, reason: "rankProposals not found" };
    originalRankProposals = hypothesisEngine.rankProposals;
    hypothesisEngine.rankProposals = enhancedRankProposals;
    hypothesisEngine.rankProposals._knowledgeRanker = true;
    installed = true;
    if (outcomeFeedback && typeof outcomeFeedback.on === "function") outcomeFeedback.on("verdict", recordVerdict);
    return { ok: true };
  }
  function uninstall() {
    if (!installed || !hypothesisEngine || !originalRankProposals) return { ok: false, reason: "not_installed" };
    hypothesisEngine.rankProposals = originalRankProposals;
    installed = false; originalRankProposals = null;
    return { ok: true };
  }
  function getHistory(limit) { return history.slice(-(limit || 30)); }
  function stats() {
    return { installed: installed, rankings: counters.rankings, boosted: counters.boosted,
      penalized: counters.penalized, outcomesRecorded: counters.outcomesRecorded, historySize: history.length, config: cfg };
  }
  function clear() { history.length = 0; counters.rankings = 0; counters.boosted = 0; counters.penalized = 0; counters.outcomesRecorded = 0; }
  return { install: install, uninstall: uninstall, adjustScore: adjustScore, recordVerdict: recordVerdict,
    getHistory: getHistory, stats: stats, clear: clear, _cfg: cfg };
}
module.exports = { createKnowledgeRanker, DEFAULTS };