"use strict";

/**
 * Tradability and opportunity assessment.
 *
 * [2026-10-21 4단계] The bot used to place an order whenever a signal
 * fired. Nothing asked whether the order could realistically make money:
 * whether the broker could price the symbol at all, whether the market was
 * open, whether the data was fresh, whether the spread was wide enough to
 * eat the expected move, whether the price sat inside the broker's daily
 * limit, or whether the order could be filled before the session closed.
 *
 * The measured result was a strategy that churned 250 round trips for a net
 * loss: the friction was paid on every one of them while the opportunity was
 * taken on none. The exit analysis was even blunter - 66 trades closed
 * within one bar for a loss of 715, and 9 take-profit exits made 728.
 *
 * This module answers one question - "can this order realistically make
 * money?" - from the data the broker already provides.
 */

const { isTradableMarket, marketSessionState, minutesUntilNextOpen } = require("./marketCalendar");
const { roundTripCostPct } = require("./cost-model");

const DEFAULTS = Object.freeze({
  // The cost model already assumes a $5 floor. A symbol below it cannot
  // carry a position that pays for its own round trip.
  minPriceUsd: Number(process.env.TRADABILITY_MIN_PRICE_USD || 5),
  minDollarVolume: Number(process.env.TRADABILITY_MIN_DOLLAR_VOLUME || 5_000_000),
  // 30 bps = 0.30%. The round trip costs ~74 bps, so a 30 bps spread already
  // eats 40% of it before the position moves at all.
  maxSpreadBps: Number(process.env.TRADABILITY_MAX_SPREAD_BPS || 30),
  // The data has to be recent enough to act on.
  maxDataAgeMs: Number(process.env.TRADABILITY_MAX_DATA_AGE_MS || 15 * 60 * 1000),
  // A symbol that has not traded for a minute is not moving; a market order
  // into it is a gift to the spread.
  minTradeAgeMs: Number(process.env.TRADABILITY_MIN_TRADE_AGE_MS || 60 * 1000),
  // Stay this far inside the broker's daily price limit.
  priceLimitBufferPct: Number(process.env.TRADABILITY_PRICE_LIMIT_BUFFER_PCT || 0.5),
  // How many times the round-trip cost the expected move has to cover.
  minEdgeMultiple: Number(process.env.TRADABILITY_MIN_EDGE_MULTIPLE || 1),
});

/**
 * The markets whose data the Toss Open API actually provides.
 *
 * [2026-10-21 4단계] The runner has always warned that "Toss OpenAPI does
 * not support JP data collection" and falls back to the broker's average
 * cost for JP symbols. An average cost is not a price: it cannot be traded
 * on, it cannot be spread against, and it cannot be ranked. JP was still in
 * the tradable-market list and still in the watchlist, so the bot could
 * form an opinion about a market it cannot observe.
 *
 * The WebSocket streams US equities ("trade:us") and the REST poll prices
 * them. There is no US pre/post-market stream, no crypto, no futures, and
 * no FX order endpoint (see EXCHANGE_EXECUTION_NOTES.md: the official
 * OpenAPI has no currency-exchange order; the unofficial WTS path exists
 * but its POST body schema is unresolved).
 */
const API_SUPPORTED_MARKETS = Object.freeze(["US"]);

/** Can the broker price this market at all? */
function apiSupportsMarket(market) {
  return API_SUPPORTED_MARKETS.includes(String(market || "").toUpperCase());
}

/**
 * Assess whether an order in this symbol can realistically make money.
 *
 * @param {object} input
 *   symbol, market, side
 *   price              the price the order would use
 *   dollarVolume       daily dollar volume (shares x price)
 *   spreadBps          the observed bid/ask spread
 *   lastTradeAt        epoch ms of the last trade
 *   dataAt             epoch ms of the price snapshot
 *   upperLimitPrice    the broker's daily upper price limit (optional)
 *   lowerLimitPrice    the broker's daily lower price limit (optional)
 *   expectedMovePct    the expected gross move of the signal (optional)
 *   now                epoch ms (optional)
 * @returns {object} tradable, reason, expectedFillMinutes, expectedCostPct,
 *   fillProbability, expectedEdgePct, expectedNetEdgePct, checks
 */
function assessTradability(input) {
  const cfg = Object.assign({}, DEFAULTS, (input && input.config) || {});
  const now = input && input.now ? Number(input.now) : Date.now();
  const market = String((input && input.market) || "US").toUpperCase();
  const symbol = String((input && input.symbol) || "").toUpperCase();
  const side = String((input && input.side) || "BUY").toUpperCase();

  const out = {
    symbol: symbol,
    market: market,
    side: side,
    tradable: true,
    reason: null,
    expectedFillMinutes: 0,
    expectedCostPct: 0,
    fillProbability: 1,
    expectedEdgePct: null,
    expectedNetEdgePct: null,
    checks: {},
  };

  function fail(reason) {
    out.tradable = false;
    out.reason = reason;
    return out;
  }

  // --- 1. The broker must support the market, and the market must be
  // tradeable at all. -------------------------------------------------
  if (!isTradableMarket(market)) {
    out.checks.market = false;
    return fail("market " + market + " is not in the tradable-market list");
  }
  if (!apiSupportsMarket(market)) {
    out.checks.apiSupport = false;
    return fail("the broker cannot collect data for the " + market + " market");
  }
  out.checks.apiSupport = true;

  // --- 2. The session. An order placed while the market is closed queues
  // until the next open, and the position then carries the overnight gap
  // risk for the whole wait. -------------------------------
  const session = marketSessionState(market, new Date(now), (input && input.holidays) || new Set());
  out.session = session;
  if (session.state !== "open") {
    const wait = minutesUntilNextOpen(market, new Date(now), (input && input.holidays) || new Set());
    out.expectedFillMinutes = wait == null ? 1440 : wait;
    if (!(input && input.allowClosedMarket)) {
      out.checks.session = false;
      return fail("market " + market + " is " + session.state + " - the order would queue for " + out.expectedFillMinutes + " minutes");
    }
    // A risk-reducing exit is allowed to queue. Blocking it would leave the
    // position exposed to the same overnight gap the exit is meant to avoid.
    out.checks.session = "queued";
  } else {
    out.checks.session = true;
  }

  // --- 3. The data has to be fresh, and the symbol has to be moving. ----
  const dataAt = Number(input && input.dataAt) || 0;
  if (dataAt > 0) {
    const ageMs = now - dataAt;
    out.dataAgeMs = ageMs;
    out.checks.dataFresh = ageMs <= cfg.maxDataAgeMs;
    if (!out.checks.dataFresh) {
      return fail("the price data is " + Math.round(ageMs / 1000) + "s old (max " + Math.round(cfg.maxDataAgeMs / 1000) + "s)");
    }
  } else {
    out.checks.dataFresh = null;
  }

  const lastTradeAt = Number(input && input.lastTradeAt) || 0;
  if (lastTradeAt > 0) {
    const sinceMs = now - lastTradeAt;
    out.sinceLastTradeMs = sinceMs;
    out.checks.recentlyTraded = sinceMs <= cfg.minTradeAgeMs;
    if (!out.checks.recentlyTraded) {
      return fail("the last trade was " + Math.round(sinceMs / 1000) + "s ago (max " + Math.round(cfg.minTradeAgeMs / 1000) + "s)");
    }
  } else {
    out.checks.recentlyTraded = null;
  }

  // --- 4. The price floor. ---------------------------------------------
  const price = Number(input && input.price) || 0;
  if (price > 0) {
    out.checks.priceFloor = price >= cfg.minPriceUsd;
    if (!out.checks.priceFloor) {
      return fail("the price " + price + " is below the " + cfg.minPriceUsd + " floor");
    }
  } else {
    out.checks.priceFloor = null;
  }

  // --- 5. The dollar volume. ------------------------------------------
  const dollarVolume = Number(input && input.dollarVolume) || 0;
  if (dollarVolume > 0) {
    out.checks.dollarVolume = dollarVolume >= cfg.minDollarVolume;
    if (!out.checks.dollarVolume) {
      return fail("the daily dollar volume " + Math.round(dollarVolume) + " is below the " + cfg.minDollarVolume + " floor");
    }
  } else {
    out.checks.dollarVolume = null;
  }

  // --- 6. The spread. --------------------------------------------------
  const spreadBps = Number(input && input.spreadBps) || 0;
  out.spreadBps = spreadBps;
  if (spreadBps > 0) {
    out.checks.spread = spreadBps <= cfg.maxSpreadBps;
    if (!out.checks.spread) {
      return fail("the spread " + spreadBps + "bps is above the " + cfg.maxSpreadBps + "bps limit");
    }
  } else {
    out.checks.spread = null;
  }

  // --- 7. The broker's daily price limits. A limit order outside the
  // limit is rejected, a market order fills at whatever is available. ---
  const upper = Number(input && input.upperLimitPrice) || 0;
  const lower = Number(input && input.lowerLimitPrice) || 0;
  if (price > 0 && upper > 0) {
    const buffer = 1 - cfg.priceLimitBufferPct / 100;
    out.checks.priceLimit = price <= upper * buffer && (lower <= 0 || price >= lower * (2 - buffer));
    if (!out.checks.priceLimit) {
      return fail("the price " + price + " is too close to the broker's daily limit (" + lower + ".." + upper + ")");
    }
  } else {
    out.checks.priceLimit = null;
  }

  // --- 8. The economics: does the expected move cover the cost? --------
  const costPct = roundTripCostPct(market);
  const spreadPct = spreadBps > 0 ? spreadBps / 100 : 0;
  // The spread is paid on the way in and on the way out.
  out.expectedCostPct = costPct + spreadPct * 2;
  out.roundTripCostPct = costPct;
  out.spreadCostPct = spreadPct * 2;

  // The market risk of waiting: a queued order carries the overnight gap.
  // The longer the wait, the more of the expected move the gap can eat.
  const waitHours = out.expectedFillMinutes / 60;
  const gapPenaltyPct = waitHours > 0 ? Math.min(3, waitHours * 0.15) : 0;
  out.gapRiskPct = gapPenaltyPct;

  const expectedMovePct = Number(input && input.expectedMovePct);
  if (Number.isFinite(expectedMovePct) && expectedMovePct > 0) {
    out.expectedEdgePct = expectedMovePct;
    out.expectedNetEdgePct = expectedMovePct - out.expectedCostPct - gapPenaltyPct;
    out.checks.edge = out.expectedNetEdgePct > 0;
    if (!out.checks.edge) {
      return fail("the expected move " + expectedMovePct.toFixed(2) + "% does not cover the " + out.expectedCostPct.toFixed(3) + "% round-trip cost" + (gapPenaltyPct > 0 ? " plus " + gapPenaltyPct.toFixed(2) + "% of gap risk" : ""));
    }
  } else {
    out.checks.edge = null;
  }

  // The fill probability: a REST-polled market is up to one poll interval
  // stale, and a wide spread makes a fill less certain.
  out.fillProbability = Math.max(0.1, Math.min(1, 1 - spreadPct * 10 - gapPenaltyPct / 3));
  return out;
}

/**
 * Rank candidates by the net edge they can realistically deliver.
 *
 * [2026-10-21 4단계] The ranking is not by signal strength. A strong
 * signal on a wide-spread, closed, stale-priced symbol is worth less than
 * a modest signal on a liquid one that can actually be filled, because the
 * first one pays the full round trip for nothing.
 */
function rankByOpportunity(candidates) {
  return (candidates || [])
    .filter(function (c) { return c && c.tradable; })
    .map(function (c) {
      const edge = c.expectedNetEdgePct != null ? c.expectedNetEdgePct : 0;
      return Object.assign({}, c, {
        opportunity: edge * (c.fillProbability || 1),
      });
    })
    .sort(function (a, b) { return b.opportunity - a.opportunity; });
}

module.exports = {
  DEFAULTS,
  API_SUPPORTED_MARKETS,
  apiSupportsMarket,
  assessTradability,
  rankByOpportunity,
};
