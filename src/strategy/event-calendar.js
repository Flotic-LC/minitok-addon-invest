"use strict";

/**
 * Economic event calendar guard — reduces position sizing or blocks new
 * entries near high-impact macro events (FOMC, CPI, BOK, BOJ, NFP).
 *
 * Usage:
 *   const { createEventGuard } = require("./event-calendar");
 *   const guard = createEventGuard({ customEvents: [...] });
 *   const check = guard.check(new Date());
 */

// [Tier 2] 수익 극대화: 이벤트 기간에도 완전 차단 대신 축소만 적용.
// guardMult 0.5 = 절반 포지션으로 계속 매매, warnMult 0.75 = 25% 축소.
const DEFAULTS = Object.freeze({
  guardWindowHours: Number(process.env.EVENT_GUARD_HOURS || 2),     // [Tier 2] 4h → 2h로 창 축소
  warningWindowHours: Number(process.env.EVENT_WARN_HOURS || 12),  // [Tier 2] 24h → 12h로 창 축소
  guardSizeMultiplier: Number(process.env.EVENT_GUARD_MULT || 0.5),  // [Tier 2] 완전차단 → 50%
  warningSizeMultiplier: Number(process.env.EVENT_WARN_MULT || 0.75),// [Tier 2] 50% → 75%
});

const SCHEDULES = [
  {
    id: "fomc", name: "FOMC Rate Decision", market: "US", impact: "high",
    schedule(year, month) {
      const dates = []; let wedCount = 0;
      for (let d = 1; d <= 31; d++) {
        const dt = new Date(Date.UTC(year, month, d));
        if (dt.getUTCMonth() !== month) break;
        if (dt.getUTCDay() === 3) { wedCount++; if (wedCount === 3) { dates.push(dt); break; } }
      }
      return dates;
    },
  },
  {
    id: "us_cpi", name: "US CPI Release", market: "US", impact: "high",
    schedule(year, month) { return [new Date(Date.UTC(year, month, 13, 12, 30))]; },
  },
  {
    id: "us_nfp", name: "US Non-Farm Payrolls", market: "US", impact: "high",
    schedule(year, month) {
      for (let d = 1; d <= 7; d++) {
        const dt = new Date(Date.UTC(year, month, d, 12, 30));
        if (dt.getUTCDay() === 5) return [dt];
      }
      return [];
    },
  },
  {
    id: "boj", name: "BOJ Rate Decision", market: "JP", impact: "high",
    schedule(year, month) {
      const lastDay = new Date(Date.UTC(year, month + 1, 0));
      for (let d = lastDay.getUTCDate(); d >= lastDay.getUTCDate() - 7; d--) {
        const dt = new Date(Date.UTC(year, month, d, 0, 0));
        if (dt.getUTCDay() === 4) return [dt];
      }
      return [lastDay];
    },
  },
];

function createEventGuard(options = {}) {
  const p = { ...DEFAULTS, ...options.defaults };
  const schedules = options.schedules || SCHEDULES;
  const customEvents = (options.customEvents || []).map(e => ({ ...e, date: new Date(e.date) }));

  function getUpcomingEvents(at = new Date(), windowHours = 48) {
    const now = at.getTime();
    const horizon = now + windowHours * 3600000;
    const results = [];
    const year = at.getUTCFullYear();
    const month = at.getUTCMonth();
    for (const sched of schedules) {
      for (const m of [month, (month + 1) % 12]) {
        const y = m < month ? year + 1 : year;
        try {
          const dates = sched.schedule(y, m);
          for (const d of dates) {
            const t = d.getTime();
            if (t >= now - 3600000 && t <= horizon) {
              results.push({
                id: sched.id, name: sched.name, market: sched.market,
                impact: sched.impact, date: d, hoursAway: (t - now) / 3600000,
              });
            }
          }
        } catch {}
      }
    }
    for (const evt of customEvents) {
      const t = evt.date.getTime();
      if (t >= now - 3600000 && t <= horizon) {
        results.push({ ...evt, hoursAway: (t - now) / 3600000 });
      }
    }
    results.sort((a, b) => a.hoursAway - b.hoursAway);
    return results;
  }

  function check(at = new Date(), market = null) {
    const events = getUpcomingEvents(at, p.warningWindowHours);
    const relevant = market ? events.filter(e => e.market === market || e.market === "GLOBAL") : events;
    for (const evt of relevant) {
      if (evt.impact !== "high" && evt.impact !== "medium") continue;
      if (evt.hoursAway >= 0 && evt.hoursAway <= p.guardWindowHours) {
        return {
          active: true, event: evt,
          sizeMultiplier: p.guardSizeMultiplier,
          blockNewBuys: evt.impact === "high",
          reason: evt.name + " in " + evt.hoursAway.toFixed(1) + "h (" + evt.impact + " impact)",
        };
      }
      if (evt.hoursAway > p.guardWindowHours && evt.hoursAway <= p.warningWindowHours) {
        return {
          active: true, event: evt,
          sizeMultiplier: p.warningSizeMultiplier,
          blockNewBuys: false,
          reason: evt.name + " in " + evt.hoursAway.toFixed(1) + "h — reduced sizing",
        };
      }
    }
    return { active: false, event: null, sizeMultiplier: 1.0, blockNewBuys: false, reason: "no imminent events" };
  }

  return { check, getUpcomingEvents, SCHEDULES: schedules, DEFAULTS: p };
}

module.exports = { createEventGuard, SCHEDULES, DEFAULTS };
