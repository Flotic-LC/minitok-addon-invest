"use strict";

/**
 * Trading-session window helpers.
 *
 * A "trading day" for this bot is not a calendar day: the US session runs
 * 22:30–05:00 KST and straddles midnight, so a KST-date rollup splits one
 * session across two days. These helpers resolve the most recently *closed*
 * session (market + open/close instants) so the end-of-session summary can
 * cover a whole session instead of a half of it.
 */

const { SESSIONS, localParts } = require("../agent/marketCalendar");

/** Calendar parts of an instant in a given IANA timezone. */
function partsInTz(date, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
  const p = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  return {
    y: Number(p.year), m: Number(p.month), d: Number(p.day),
    // Intl can emit hour "24" for midnight in some locales.
    hh: Number(p.hour) % 24, mm: Number(p.minute),
  };
}

/**
 * Resolve a local wall-clock time in `tz` to a UTC instant.
 * dateStr: "YYYY-MM-DD", hm: HHMM (e.g. 930).
 */
function localTimeToUtc(dateStr, hm, tz) {
  const ymd = dateStr.split("-").map(Number);
  const hh = Math.floor(hm / 100);
  const mm = hm % 100;
  // The target as if the wall clock were UTC.
  const targetUtc = Date.UTC(ymd[0], ymd[1] - 1, ymd[2], hh, mm);
  let ts = targetUtc;
  for (let i = 0; i < 4; i++) {
    const p = partsInTz(new Date(ts), tz);
    // Offset of the zone at ts: wall clock there, expressed as UTC, minus ts.
    const offset = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm) - ts;
    const next = targetUtc - offset;
    if (next === ts) break;
    ts = next;
  }
  return new Date(ts);
}

function previousDateStr(dateStr) {
  const ymd = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(ymd[0], ymd[1] - 1, ymd[2]));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

/** Is this calendar date a weekend? (Date strings are timezone-independent.) */
function isWeekendDate(dateStr) {
  const wd = new Date(dateStr + "T00:00:00Z").getUTCDay();
  return wd === 0 || wd === 6;
}

/** Walk back to the most recent weekday (max 7 days). */
function mostRecentWeekday(dateStr) {
  let d = dateStr;
  for (let i = 0; i < 7 && isWeekendDate(d); i++) d = previousDateStr(d);
  return d;
}

/**
 * The most recently closed session of every market, newest close first.
 * Returns [{ market, tz, dateStr, openAt, closeAt }].
 */
function completedSessions(now = new Date()) {
  const out = [];
  for (const market of Object.keys(SESSIONS)) {
    const sess = SESSIONS[market];
    const local = localParts(now, sess.tz);
    let dateStr;
    if (local.hm >= sess.close) {
      dateStr = local.date;            // today's session already closed
    } else if (local.hm < sess.open) {
      dateStr = previousDateStr(local.date); // before today's open -> previous day
    } else {
      continue;                        // session in progress
    }
    dateStr = mostRecentWeekday(dateStr);
    const openAt = localTimeToUtc(dateStr, sess.open, sess.tz);
    const closeAt = localTimeToUtc(dateStr, sess.close, sess.tz);
    if (closeAt.getTime() > now.getTime()) continue;
    out.push({ market, tz: sess.tz, dateStr, openAt, closeAt });
  }
  return out.sort((a, b) => b.closeAt.getTime() - a.closeAt.getTime());
}

/**
 * The most recently closed session across all known markets.
 * Returns { market, tz, openAt, closeAt, dateStr } or null.
 */
function lastCompletedSession(now = new Date()) {
  const all = completedSessions(now);
  return all.length ? all[0] : null;
}

/** Format an instant as "MM-DD HH:mm" in KST (the bot's operating timezone). */
function kstHm(date) {
  const k = new Date(new Date(date).getTime() + 9 * 3600 * 1000);
  return k.toISOString().slice(5, 16).replace("T", " ");
}

module.exports = {
  completedSessions,
  lastCompletedSession,
  localTimeToUtc,
  previousDateStr,
  isWeekendDate,
  mostRecentWeekday,
  kstHm,
};
