"use strict";

/**
 * AI-down fallback policy — conservative rule-based behavior when all LLM
 * providers fail.
 *
 * Design goals:
 *   1. Risk exits (stop-loss, take-profit) ALWAYS execute — capital protection.
 *   2. Trend exits require higher score than normal (conservative).
 *   3. BUY allowed ONLY for symbols passing quality gate with very high
 *      conviction (score >= 5), and quantity reduced by qtyDivisor.
 *   4. Quality gate checks: price floor, volatility cap, symbol format.
 *      No hardcoded symbol names. Optional explicit allowlist/blocklist.
 *   5. All decisions tagged `fallback: true` for audit trail.
 *
 * Environment variables (optional overrides):
 *   FALLBACK_ALLOWLIST: comma-separated symbols (blocks all others if set)
 *   FALLBACK_BLOCKLIST: comma-separated symbols to block
 *   FALLBACK_MIN_PRICE_KRW: minimum price for KR symbols (default 1000)
 *   FALLBACK_MIN_PRICE_USD: minimum price for US symbols (default 1)
 *   FALLBACK_MIN_PRICE_JPY: minimum price for JP symbols (default 100)
 *   FALLBACK_MAX_ATR_PCT: maximum ATR% for new BUY (default 10)
 *   FALLBACK_BUY_MIN_SCORE: minimum signal score (default 5)
 */

const { generateSignal } = require("./signals");

function normalizeSymbol(sym) {
  if (!sym) return "";
  return String(sym).replace(/^[A-Z]+:/i, "").toUpperCase();
}

// Detect market from symbol format — no name lookup needed.
function detectMarket(sym) {
  const s = normalizeSymbol(sym);
  if (/^\d{6}$/.test(s)) return "KR";
  if (/^\d{4}$/.test(s)) return "JP";
  if (/^[A-Z]{1,5}$/.test(s)) return "US";
  return "UNKNOWN";
}

function parseListEnv(envKey) {
  const val = process.env[envKey];
  if (!val) return null;
  return new Set(val.split(",").map((s) => s.trim()).filter(Boolean).map(normalizeSymbol));
}

/**
 * Quality gate: check if symbol meets minimum quality standards.
 * No hardcoded symbol names — only numeric/structural criteria.
 *
 * @param {string} symbol
 * @param {object} ctx - technical context (lastClose, atr14)
 * @param {object} opts - { minPriceKrw, minPriceUsd, minPriceJpy, maxAtrPct, allowlist, blocklist }
 * @returns {{ pass: boolean, reason: string }}
 */
function checkQualityGate(symbol, ctx, opts = {}) {
  const sym = normalizeSymbol(symbol);
  if (!sym) return { pass: false, reason: "invalid symbol" };

  const market = detectMarket(sym);
  if (market === "UNKNOWN") return { pass: false, reason: "unknown market format" };

  // Optional explicit allowlist (if set, only these symbols allowed)
  const allowlist = opts.allowlist || parseListEnv("FALLBACK_ALLOWLIST");
  if (allowlist && !allowlist.has(sym)) {
    return { pass: false, reason: "not in allowlist" };
  }

  // Optional explicit blocklist
  const blocklist = opts.blocklist || parseListEnv("FALLBACK_BLOCKLIST");
  if (blocklist && blocklist.has(sym)) {
    return { pass: false, reason: "in blocklist" };
  }

  // Price floor (avoid penny stocks) — per-market thresholds
  const price = Number(ctx && ctx.lastClose) || 0;
  const minPriceKrw = opts.minPriceKrw ?? Number(process.env.FALLBACK_MIN_PRICE_KRW || 1000);
  const minPriceUsd = opts.minPriceUsd ?? Number(process.env.FALLBACK_MIN_PRICE_USD || 1);
  const minPriceJpy = opts.minPriceJpy ?? Number(process.env.FALLBACK_MIN_PRICE_JPY || 100);

  if (market === "KR" && price < minPriceKrw) {
    return { pass: false, reason: "price " + price + " < min " + minPriceKrw + " KRW" };
  }
  if (market === "US" && price < minPriceUsd) {
    return { pass: false, reason: "price " + price + " < min " + minPriceUsd + " USD" };
  }
  if (market === "JP" && price < minPriceJpy) {
    return { pass: false, reason: "price " + price + " < min " + minPriceJpy + " JPY" };
  }

  // Volatility cap — [Tier 2] 성장주/반도체주도 허용하도록 25%로 완화 (was 10%)
  const atr14 = Number(ctx && ctx.atr14) || 0;
  const maxAtrPct = opts.maxAtrPct ?? Number(process.env.FALLBACK_MAX_ATR_PCT || 25);
  if (atr14 > 0 && price > 0) {
    const atrPct = (atr14 / price) * 100;
    if (atrPct > maxAtrPct) {
      return { pass: false, reason: "ATR " + atrPct.toFixed(1) + "% > max " + maxAtrPct + "%" };
    }
  }

  return { pass: true, reason: "quality gate passed" };
}

/**
 * @param {object} ctx - technical context (same as generateSignal)
 * @param {object|null} position - current holding for this symbol
 * @param {object} opts
 *   @param {number}   [opts.fallbackMinScore=4]   - score threshold for trend exits
 *   @param {number}   [opts.fallbackBuyMinScore]  - stricter threshold for BUY (env or 5)
 *   @param {number}   [opts.qtyDivisor=2]         - shrink BUY qty (2 = half size)
 *   @param {string}   [opts.symbol]               - symbol for quality gate check
 *   @param {Set}      [opts.allowlist]            - explicit allowlist (overrides env)
 *   @param {Set}      [opts.blocklist]            - explicit blocklist (overrides env)
 * @returns {{ action, quantity?, price?, reason, strategy?, fallback: true, scaled?, qtyDivisor?, score?, qualityGate? } | null}
 */
function fallbackDecision(ctx, position, opts = {}) {
  const minScore = opts.fallbackMinScore ?? 4;
  const buyMinScore = opts.fallbackBuyMinScore ?? Number(process.env.FALLBACK_BUY_MIN_SCORE || 2);  // lowered from 3 for more entries
  const qtyDivisor = Math.max(1, opts.qtyDivisor ?? 2);

  const signal = generateSignal(ctx, position);
  if (signal.action === "HOLD") return null;

  // --- 1. Risk exits: always allowed (capital protection) ---
  if (signal.strategy === "risk_exit") {
    return {
      action: "SELL",
      quantity: position ? position.qty : undefined,
      price: ctx.lastClose,
      reason: "fallback:" + signal.reasons.join("; "),
      strategy: signal.strategy,
      fallback: true,
    };
  }

  // --- 2. Trend exits: require higher confidence ---
  if (signal.action === "SELL" && signal.score >= minScore) {
    return {
      action: "SELL",
      quantity: position ? position.qty : undefined,
      price: ctx.lastClose,
      reason: "fallback(conservative):" + signal.reasons.join("; "),
      strategy: signal.strategy,
      fallback: true,
    };
  }

  // --- 3. BUY: quality gate + high conviction + reduced size ---
  if (signal.action === "BUY") {
    const sym = normalizeSymbol(opts.symbol);
    const quality = checkQualityGate(sym, ctx, opts);
    if (!quality.pass) {
      // Quality gate failed — block BUY (caller may log quality.reason)
      return null;
    }
    if (signal.score < buyMinScore) {
      return null; // Insufficient conviction for fallback BUY
    }
    // Scale quantity via divisor. Caller should divide base qty by qtyDivisor.
    const scaled = qtyDivisor > 1;
    return {
      action: "BUY",
      price: ctx.lastClose,
      reason: "fallback(quality,scaled):" + signal.reasons.join("; "),
      strategy: signal.strategy,
      fallback: true,
      scaled,
      qtyDivisor,
      score: signal.score,
      qualityGate: quality.reason,
    };
  }

  return null;
}

module.exports = { fallbackDecision, checkQualityGate, normalizeSymbol, detectMarket };
