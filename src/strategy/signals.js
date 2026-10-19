"use strict";

/**
 * Rule-based signal engine — shared by live runner AND backtest.
 *
 * Pure functions over technical indicator context (as produced by
 * fetchCandleContext in runner.js). Deterministic: same input -> same signal.
 * LLM evaluates these candidates; on AI failure the fallback uses them alone.
 */

// [Tier 2] 수익 극대화 기본값 — 자율성 확보를 위해 보수적 기본값을 대폭 완화.
// Tier 1 (자본 보호) 장치는 runner.js의 daily hard-stop, AI circuit breaker,
// UNRESTRICTED_MODE forbidden 등으로 별도 유지됨.
const DEFAULT_PARAMS = Object.freeze({
  rsiOversold: Number(process.env.SIG_RSI_OVERSOLD || 30),
  rsiOverbought: Number(process.env.SIG_RSI_OVERBOUGHT || 70),
  momentumMaxPct: Number(process.env.SIG_MOMENTUM_MAX_PCT || 25),  // [Tier 2] 강한 모멘텀도 추구 (was 8)
  stopLossPct: Number(process.env.SIG_STOP_LOSS_PCT || -2),
  takeProfitPct: Number(process.env.SIG_TAKE_PROFIT_PCT || 12),    // [Tier 2] 큰 수익 추구 (was 5)
  bbTouchPct: Number(process.env.SIG_BB_TOUCH_PCT || 0.3),          // within 0.3% of band = touch
  minScore: Number(process.env.SIG_MIN_SCORE || 2),                 // evidence count to act

  // [P1-5] ATR-based dynamic stop/take (overrides fixed % when ATR available)
  useAtrStops: process.env.SIG_USE_ATR_STOPS !== "false",
  atrStopMult: Number(process.env.SIG_ATR_STOP_MULT || 2.0),        // stop = entry - 2×ATR
  atrTakeMult: Number(process.env.SIG_ATR_TAKE_MULT || 5.0),        // [Tier 2] ATR 수익 목표 확대 (was 3)
  minStopPct: Number(process.env.SIG_MIN_STOP_PCT || -15),          // [Tier 2] ATR stop 바닥 완화 (was -5)
  maxStopPct: Number(process.env.SIG_MAX_STOP_PCT || -0.5),         // ceiling for ATR stop

  // [Patch 2026-10-15 #4] Pullback entry: buy the dip WITHIN an uptrend.
  // Trend intact (sma5>sma20 or ema9>ema21) but price pulled back to a short-term
  // support zone (RSI mid-range + price near/below sma5). Restores entry density
  // lost when mean_reversion was disabled, WITHOUT its negative edge (that strategy
  // bought oversold in DOWNTRENDS; pullback requires an established UPTREND).
  pullbackEnabled: process.env.SIG_PULLBACK_ENABLED !== "false",
  pullbackRsiMin: Number(process.env.SIG_PULLBACK_RSI_MIN || 40),  // not oversold, just cooled off
  pullbackRsiMax: Number(process.env.SIG_PULLBACK_RSI_MAX || 55),  // not overheated
  pullbackNearSma5Pct: Number(process.env.SIG_PULLBACK_NEAR_SMA5_PCT || 1.5), // within 1.5% of sma5

  // [Patch 2026-10-15 #6] Intraday strategies (1h momentum, 1h pullback, gap, VWAP)
  intradayEnabled: process.env.SIG_INTRADAY_ENABLED !== "false",
  intradayRsiMin: Number(process.env.SIG_INTRADAY_RSI_MIN || 50),
  intradayRsiMax: Number(process.env.SIG_INTRADAY_RSI_MAX || 70),
  gapEnabled: process.env.SIG_GAP_ENABLED !== "false",
  gapMinPct: Number(process.env.SIG_GAP_MIN_PCT || 2.0), // minimum gap % to trigger
  vwapEnabled: process.env.SIG_VWAP_ENABLED !== "false",
  vwapMinBelowPct: Number(process.env.SIG_VWAP_MIN_BELOW_PCT || 0.5), // must be >0.5% below VWAP
  vwapRsiMin: Number(process.env.SIG_VWAP_RSI_MIN || 40),
  vwapRsiMax: Number(process.env.SIG_VWAP_RSI_MAX || 55),
});

/**
 * Generate a trading signal from technical context.
 * @param {object} ctx
 *   @param {number} ctx.lastClose - current price
 *   @param {number} ctx.sma5 - 5-period SMA
 *   @param {number} ctx.sma20 - 20-period SMA
 *   @param {number} ctx.ema9 - 9-period EMA
 *   @param {number} ctx.ema21 - 21-period EMA
 *   @param {number} ctx.vwap - volume-weighted avg price
 *   @param {number} ctx.rsi14 - 14-period RSI
 *   @param {object} ctx.macd - { macdLine, signal, histogram }
 *   @param {object} ctx.bollinger - { upper, middle, lower }
 *   @param {number} ctx.changePct5d - 5-day % change
 *   @param {number} ctx.atr14 - 14-period ATR
 *   @param {object} [ctx.multiTf] - multi-timeframe alignment (optional)
 *     @param {string} ctx.multiTf.trend5m - "up"|"down"|"neutral"
 *     @param {string} ctx.multiTf.trend1h - "up"|"down"|"neutral"
 *     @param {string} ctx.multiTf.trend1d - "up"|"down"|"neutral"
 * @param {object|null} position - { avgPrice, qty } if holding, else null
 * @param {object} params - DEFAULT_PARAMS overrides
 * @returns {{ action: "BUY"|"SELL"|"HOLD", score, reasons: string[], strategy: string|null }}
 */
function generateSignal(ctx, position, params = DEFAULT_PARAMS) {
  if (!ctx || !ctx.lastClose || ctx.lastClose <= 0) {
    return { action: "HOLD", score: 0, reasons: ["no price data"], strategy: null };
  }
  const p = { ...DEFAULT_PARAMS, ...params };

  if (position && Number(position.avgPrice) > 0 && Number(position.qty) > 0) {
    return exitSignal(ctx, position, p);
  }
  return entrySignal(ctx, p);
}

function entrySignal(ctx, p) {
  const reasons = [];
  let score = 0;

  // Momentum evidence
  const trendUp = ctx.sma5 != null && ctx.sma20 != null && ctx.sma5 > ctx.sma20;
  const priceAboveSma5 = ctx.sma5 != null && ctx.lastClose > ctx.sma5;
  const momentumOk = ctx.changePct5d != null && ctx.changePct5d > 0 && ctx.changePct5d < p.momentumMaxPct;
  const macdBullish = ctx.macd && ctx.macd.histogram != null && ctx.macd.histogram > 0;
  const emaBullish = ctx.ema9 != null && ctx.ema21 != null && ctx.ema9 > ctx.ema21;

  // Mean-reversion evidence
  const rsiOversold = ctx.rsi14 != null && ctx.rsi14 <= p.rsiOversold;
  const rsiOverbought = ctx.rsi14 != null && ctx.rsi14 >= p.rsiOverbought;
  const nearLowerBB = ctx.bollinger && ctx.bollinger.lower != null
    && ctx.lastClose <= ctx.bollinger.lower * (1 + p.bbTouchPct / 100);
  const belowVwap = ctx.vwap != null && ctx.lastClose < ctx.vwap;

  if (trendUp) { score++; reasons.push("sma5>sma20 uptrend"); }
  if (priceAboveSma5) { score++; reasons.push("price>sma5"); }
  if (momentumOk) { score++; reasons.push("5d momentum " + ctx.changePct5d.toFixed(1) + "% (not overheated)"); }
  if (macdBullish) { score++; reasons.push("MACD histogram positive"); }
  if (emaBullish) { score++; reasons.push("ema9>ema21"); }
  if (rsiOversold) { score++; reasons.push("RSI oversold " + ctx.rsi14); }
  if (nearLowerBB) { score++; reasons.push("near lower Bollinger band"); }
  if (belowVwap) { reasons.push("below VWAP (cheap intraday)"); } // informational only

  // [P1-5] Multi-timeframe alignment bonus
  if (ctx.multiTf) {
    const { trend5m, trend1h, trend1d } = ctx.multiTf;
    const aligned = trend5m === "up" && trend1h === "up" && trend1d === "up";
    const conflicting = trend1d === "down" && trend1h === "down";
    if (aligned) {
      score += 2;
      reasons.push("multi-TF aligned (5m+1h+1d all up)");
    } else if (conflicting) {
      score -= 2;
      reasons.push("multi-TF conflict (1h+1d down) — penalty");
    }
  }

  if (rsiOverbought) { score -= 2; reasons.push("RSI overbought " + ctx.rsi14 + " (penalty)"); }

  let strategy = null;
  if (trendUp && macdBullish) strategy = "momentum";

  // [Patch 2026-10-15 #4] Pullback entry: trend intact + short-term dip.
  // Qualifies only when there IS an uptrend but price is NOT currently extended
  // (i.e. the pure-momentum branch above did not fire).
  if (p.pullbackEnabled && !strategy) {
    var _trendIntact = trendUp || emaBullish;
    var _rsiMid = ctx.rsi14 != null && ctx.rsi14 >= p.pullbackRsiMin && ctx.rsi14 <= p.pullbackRsiMax;
    var _nearSma5 = ctx.sma5 != null && ctx.sma5 > 0
      && ctx.lastClose <= ctx.sma5 * (1 + p.pullbackNearSma5Pct / 100)
      && ctx.lastClose >= ctx.sma5 * (1 - 5); // not a breakdown (within -5% below sma5)
    var _notBreakingDown = ctx.sma20 != null && ctx.lastClose > ctx.sma20 * 0.97; // above 20d support
    if (_trendIntact && _rsiMid && _nearSma5 && _notBreakingDown) {
      strategy = "pullback";
      score += 2; // pullback-in-uptrend is a higher-quality setup than chasing
      reasons.push("pullback: uptrend intact, RSI " + (ctx.rsi14 != null ? ctx.rsi14.toFixed(0) : "?") + " cooled, price near sma5, above sma20 support");
    }
  }
  // [Strategy 7] Intraday momentum — 1h trendUp + RSI 50-70 + MACD bullish + 3-candle rise
  if (p.intradayEnabled && ctx.candleCtx1h && ctx.candleCtx1h.trendUp) {
    var rsi1h = ctx.candleCtx1h.rsi14;
    var macd1h = ctx.candleCtx1h.macd;
    var roc3_1h = ctx.candleCtx1h.changePct5d; // approximate 3-period ROC using 5d change as proxy
    if (rsi1h != null && rsi1h >= p.intradayRsiMin && rsi1h <= p.intradayRsiMax
        && macd1h != null && macd1h.histogram > 0
        && roc3_1h != null && roc3_1h > 0) {
      if (!strategy) {
        strategy = "intraday_momentum";
        score += 2;
        reasons.push("intraday_momentum: 1h trendUp, RSI1h " + rsi1h.toFixed(0) + ", MACD1h bullish, ROC>0");
      }
    }
  }

  // [Strategy 8] 1h pullback — 1h trendUp but short-term dip (RSI 35-50, near 1h sma5)
  if (p.intradayEnabled && ctx.candleCtx1h && ctx.candleCtx1h.trendUp) {
    var rsi1h_pb = ctx.candleCtx1h.rsi14;
    var sma5_1h = ctx.candleCtx1h.sma5;
    var price_1h = ctx.candleCtx1h.lastClose;
    if (rsi1h_pb != null && rsi1h_pb >= p.pullbackRsiMin && rsi1h_pb <= p.pullbackRsiMax
        && sma5_1h != null && price_1h != null && sma5_1h > 0
        && Math.abs(price_1h - sma5_1h) / sma5_1h <= p.pullbackNearSma5Pct / 100) {
      if (!strategy) {
        strategy = "intraday_pullback";
        score += 2;
        reasons.push("intraday_pullback: 1h trendUp, RSI1h " + rsi1h_pb.toFixed(0) + " cooled, price near 1h sma5");
      }
    }
  }

  // [Strategy 9] Gap trading — open vs prevClose gap >= threshold
  if (p.gapEnabled && ctx.openPrice != null && ctx.prevClose != null && ctx.prevClose > 0) {
    var gapPct = ((ctx.openPrice - ctx.prevClose) / ctx.prevClose) * 100;
    if (Math.abs(gapPct) >= p.gapMinPct) {
      if (gapPct > 0 && ctx.trendUp && ctx.rsi14 != null && ctx.rsi14 < 70) {
        if (!strategy) {
          strategy = "gap_follow";
          score += 2;
          reasons.push("gap_follow: gap up " + gapPct.toFixed(2) + "%, trend intact, RSI " + ctx.rsi14.toFixed(0));
        }
      } else if (gapPct < 0 && ctx.trendUp && ctx.rsi14 != null && ctx.rsi14 < 50) {
        if (!strategy) {
          strategy = "gap_fade";
          score += 2;
          reasons.push("gap_fade: gap down " + gapPct.toFixed(2) + "%, trend intact, RSI " + ctx.rsi14.toFixed(0) + " oversold");
        }
      }
    }
  }

  // [Strategy 10] VWAP reversion — price below VWAP, RSI recovering, expect bounce to VWAP
  if (p.vwapEnabled && ctx.vwap != null && ctx.lastClose != null && ctx.rsi14 != null) {
    var belowVwapPct = ((ctx.vwap - ctx.lastClose) / ctx.vwap) * 100;
    if (belowVwapPct > p.vwapMinBelowPct && ctx.rsi14 >= p.vwapRsiMin && ctx.rsi14 <= p.vwapRsiMax && ctx.trendUp) {
      if (!strategy) {
        strategy = "vwap_reversion";
        score += 2;
        reasons.push("vwap_reversion: price " + belowVwapPct.toFixed(2) + "% below VWAP, RSI " + ctx.rsi14.toFixed(0) + " recovering");
      }
    }
  }

  // Mean-reversion: configurable via env. Disabled by default (negative edge measured).
  // Enable with SIG_MEAN_REVERSION_ENABLED=true to A/B test.
  const meanReversionEnabled = process.env.SIG_MEAN_REVERSION_ENABLED !== "false";
  if (meanReversionEnabled && (rsiOversold || nearLowerBB) && !strategy) {
    strategy = "mean_reversion";
    score += 2;
    reasons.push("mean_reversion: RSI oversold (" + ctx.rsi14.toFixed(0) + ") or near BB lower");
  } else if (rsiOversold || nearLowerBB) {
    reasons.push("mean_reversion evidence ignored (negative edge - set SIG_MEAN_REVERSION_ENABLED=true to enable)");
  }

  // Safety: minScore must be positive. Zero or negative values would bypass
  // the evidence threshold and are treated as a misconfiguration.
  if (!Number.isFinite(p.minScore) || p.minScore <= 0) {
    return { action: "HOLD", score: 0, reasons: [...reasons, "invalid minScore config (must be >0)"], strategy: null };
  }

  if (score >= p.minScore && strategy) {
    return { action: "BUY", score, reasons, strategy };
  }
  return { action: "HOLD", score, reasons, strategy };
}

function exitSignal(ctx, position, p) {
  const avg = Number(position.avgPrice);
  const retPct = ((ctx.lastClose - avg) / avg) * 100;
  const reasons = ["position return " + retPct.toFixed(2) + "%"];

  // [P1-5] Dynamic ATR-based stops if available
  let stopLossPct = p.stopLossPct;
  let takeProfitPct = p.takeProfitPct;
  if (p.useAtrStops && ctx.atr14 && ctx.atr14 > 0 && avg > 0) {
    const atrPct = (ctx.atr14 / avg) * 100;
    stopLossPct = -(p.atrStopMult * atrPct);
    takeProfitPct = p.atrTakeMult * atrPct;
    // Clamp to reasonable bounds
    stopLossPct = Math.max(p.minStopPct, Math.min(p.maxStopPct, stopLossPct));
    takeProfitPct = Math.max(1, Math.min(20, takeProfitPct));
    reasons.push("ATR-adjusted: stop=" + stopLossPct.toFixed(2) + "%, take=" + takeProfitPct.toFixed(2) + "%");
  }

  if (retPct <= stopLossPct) {
    return { action: "SELL", score: 10, reasons: [...reasons, "stop-loss " + stopLossPct.toFixed(2) + "%"], strategy: "risk_exit" };
  }
  if (retPct >= takeProfitPct) {
    return { action: "SELL", score: 10, reasons: [...reasons, "take-profit " + takeProfitPct.toFixed(2) + "%"], strategy: "risk_exit" };
  }

  let score = 0;
  // [Patch 2026-10-15] Loosen trend_exit: avoid premature exits on single-bar noise.
  // Require EITHER (a) price clearly below sma5 (>0.5%), OR (b) close < sma5 AND MACD negative.
  var _belowSma5 = ctx.sma5 != null && ctx.lastClose < ctx.sma5;
  var _belowSma5Strong = ctx.sma5 != null && ctx.lastClose < ctx.sma5 * 0.995;
  var _macdNeg = ctx.macd && ctx.macd.histogram != null && ctx.macd.histogram < 0;
  if (_belowSma5Strong) { score += 2; reasons.push("price<sma5*0.995 trend broken"); }
  else if (_belowSma5 && _macdNeg) { score += 1; reasons.push("price<sma5 + MACD negative"); }
  if (_macdNeg) { score++; reasons.push("MACD histogram negative"); }
  if (ctx.ema9 != null && ctx.ema21 != null && ctx.ema9 < ctx.ema21) { score++; reasons.push("ema9<ema21 bearish cross"); }

  if (score >= p.minScore) {
    return { action: "SELL", score, reasons, strategy: "trend_exit" };
  }
  return { action: "HOLD", score, reasons, strategy: null };
}

module.exports = { DEFAULT_PARAMS, generateSignal };
