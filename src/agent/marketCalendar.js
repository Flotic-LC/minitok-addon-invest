"use strict";

/**
 * Market session calendar with DST handling.
 *
 * Replaces runner.js's hardcoded UTC offsets (getActiveMarkets) with
 * timezone-aware session windows using IANA tz database (built into Node
 * via Intl). Optionally cross-checks the Toss market-calendar API to skip
 * trading on exchange holidays.
 *
 * Sessions (local times, exchange timezone):
 * - JP (Asia/Tokyo):    09:00–15:00 JST, Mon–Fri
 * - US (America/New_York): 09:30–16:00 ET, Mon–Fri (DST handled by tz db)
 *
 * The Korean market (KR) was removed on 2026-10-21: this bot no longer
 * trades KRX. KR is absent from SESSIONS, so it has no session window and
 * no holiday calendar, and it is absent from TRADABLE_MARKETS below.
 */

const SESSIONS = Object.freeze({
  JP: { tz: "Asia/Tokyo", open: 900, close: 1500 },
  US: { tz: "America/New_York", open: 930, close: 1600 },
});

/**
 * The markets this bot is allowed to trade.
 *
 * This allow-list is the single enforcement point for market eligibility.
 * The session check alone is NOT sufficient: the execution path lets
 * off-hours orders queue as LIMIT orders, so a market that is merely
 * "closed" can still receive orders. Only a market in this list may trade.
 */
const TRADABLE_MARKETS = Object.freeze(["US", "JP"]);

/** Is the given market one this bot may trade? */
function isTradableMarket(market) {
  return TRADABLE_MARKETS.includes(String(market || "").toUpperCase());
}

function localParts(date, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short",
  });
  const parts = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  return {
    hm: Number(parts.hour) * 100 + Number(parts.minute),
    weekday: parts.weekday, // "Mon".."Sun"
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function isWeekday(weekday) {
  return weekday !== "Sat" && weekday !== "Sun";
}

/** Is the given market in its regular trading session right now? */
function isMarketOpen(market, at = new Date(), holidays = new Set()) {
  const sess = SESSIONS[market];
  if (!sess) return false;
  const local = localParts(at, sess.tz);
  if (!isWeekday(local.weekday)) return false;
  if (holidays.has(local.date)) return false;
  return local.hm >= sess.open && local.hm < sess.close;
}

/** All markets currently in session. */
function getActiveMarkets(at = new Date(), holidays = new Set()) {
  return Object.keys(SESSIONS).filter((m) => isMarketOpen(m, at, holidays));
}

/**
 * Holiday-aware checker backed by the Toss market-calendar API.
 * fetchCalendar: async (market) => response; dates parsed best-effort.
 */
function createHolidayCache({ fetchCalendar, ttlMs = 6 * 3600 * 1000 } = {}) {
  const cache = new Map(); // market -> { dates: Set, fetchedAt }

  function extractDates(body) {
    const dates = new Set();
    const items = Array.isArray(body) ? body : (body && (body.holidays || body.days || body.items)) || [];
    for (const it of items) {
      const d = typeof it === "string" ? it : (it.date || it.holidayDate || it.day);
      if (d && /^\d{4}-?\d{2}-?\d{2}$/.test(d)) {
        dates.add(d.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3"));
      }
    }
    return dates;
  }

  async function holidaysFor(market) {
    const entry = cache.get(market);
    if (entry && Date.now() - entry.fetchedAt < ttlMs) return entry.dates;
    if (typeof fetchCalendar !== "function") return new Set();
    try {
      const resp = await fetchCalendar(market);
      const dates = extractDates(resp && resp.body);
      cache.set(market, { dates, fetchedAt: Date.now() });
      return dates;
    } catch {
      return entry ? entry.dates : new Set(); // stale cache on error
    }
  }

  async function isMarketOpenAsync(market, at = new Date()) {
    const hol = await holidaysFor(market);
    return isMarketOpen(market, at, hol);
  }

  return { holidaysFor, isMarketOpenAsync };
}

module.exports = { SESSIONS, TRADABLE_MARKETS, isTradableMarket, isMarketOpen, getActiveMarkets, localParts, createHolidayCache };
