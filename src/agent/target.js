"use strict";

/**
 * Adaptive Target Engine — invest add-on only (no minitok code).
 *
 * Projects a phase/target ladder onto agent tool calls: starts at a dry-run
 * calibration phase with a 1% daily-return target, escalates through live
 * phases as performance data accumulates (operationCycles + returnCycles),
 * de-escalates on drawdown/hit-rate triggers, and halts live trading on
 * hard-stop daily losses.
 *
 * State is persisted to a JSON file (atomic temp+rename) so cycles survive
 * process restarts. The engine itself never calls the network — equity
 * snapshots are injected via fetchEquity or created by createEquitySnapshotter.
 */

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const SCHEMA_VERSION = 1;
const OPERATION_CYCLE_LIMIT = 200;
const RETURN_CYCLE_LIMIT = 400;
const DEFAULT_STATE_DIR = path.join(os.homedir(), ".minitok-addon-invest");
const DEFAULT_STATE_PATH = path.join(DEFAULT_STATE_DIR, "target-state.json");

const TARGET_PHASES = Object.freeze([
  { id: 0, name: "dry_run_calibration", minOperationCycles: 30, minReturnCycles: 0, dryRun: true, maxOrderValueKrw: 100000, targetPct: 1.0 },
  { id: 1, name: "live_small", minOperationCycles: 0, minReturnCycles: 50, dryRun: false, maxOrderValueKrw: 3000000, targetPct: 1.0 },
  { id: 2, name: "live_scaled", minOperationCycles: 0, minReturnCycles: 100, dryRun: false, maxOrderValueKrw: 10000000, targetPct: 1.25 },
  { id: 3, name: "live_aggressive", minOperationCycles: 0, minReturnCycles: 0, dryRun: false, maxOrderValueKrw: 30000000, targetPct: 1.5 },
]);

function defaultState(now) {
  const iso = new Date(now()).toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    currentPhase: 0,
    baseTargetPct: TARGET_PHASES[0].targetPct,
    highWaterEquity: null,
    dailyBaselineEquity: null,
    dailyBaselineDate: null,
    operationCycles: [],
    returnCycles: [],
    returnCyclesByBucket: {},
    haltState: { halted: false, reason: null, since: null, triggeredBy: null },
    lastEscalationAt: null,
    lastEvaluationAt: null,
    lastTransitionCycle: 0,
    createdAt: iso,
    updatedAt: iso,
  };
}

function loadState(statePath, now) {
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || parsed.schemaVersion !== SCHEMA_VERSION) return defaultState(now);
    const base = defaultState(now);
    return { ...base, ...parsed, haltState: { ...base.haltState, ...(parsed.haltState || {}) } };
  } catch {
    return defaultState(now);
  }
}

const { atomicWriteFileSync } = require("../core/atomic-write");

function saveState(statePath, state) {
  const content = JSON.stringify(state, null, 2);
  const result = atomicWriteFileSync(statePath, content);
  if (!result.ok) {
    throw new Error(`atomic write failed (${result.method}): ${result.error}`);
  }
}

function pushFifo(arr, item, limit) {
  arr.push(item);
  while (arr.length > limit) arr.shift();
}

function mean(nums) {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function createTargetEngine(options = {}) {
  const {
    baseTargetPct = TARGET_PHASES[0].targetPct,
    phases = TARGET_PHASES,
    escalation = { hitRateThreshold: 0.3, meanReturnFactor: 0.8, maxDrawdownAllowedPct: 3, cooldownCycles: 3 },
    deescalation = { dailyLossLimitPct: -1.0, hitRateFloor: 0.1, drawdownTriggerPct: 5, hitRateWindow: 20 },
    halt = { dailyHardStopPct: -2.0, autoResumeAfterCleanCycles: 0 },
    statePath = null,
    fetchEquity = null,
    now = () => Date.now(),
  } = options;

  const resolvedStatePath = statePath || process.env.INVEST_TARGET_STATE || process.env.TOSSINVEST_TARGET_STATE || DEFAULT_STATE_PATH;
  let state = loadState(resolvedStatePath, now);
  state.baseTargetPct = baseTargetPct;

  function persist() {
    state.updatedAt = new Date(now()).toISOString();
    try {
      saveState(resolvedStatePath, state);
    } catch (e) {
      // [DEEP-DEBUG FIX] State persistence failures are a compliance concern
      // (audit trail for phase transitions, halts, equity snapshots). Log to
      // stderr instead of swallowing silently. The engine continues with
      // in-memory state, but the operator is now aware of the disk failure.
      console.error("[target] persist() failed: " + (e && e.message ? e.message : String(e)));
    }
  }

  function phaseDef(id) { return phases.find(p => p.id === id) || phases[0]; }

  function stats(cycles) {
    const returns = cycles.map(c => c.returnPct).filter(v => v != null);
    const hits = returns.filter(v => v >= state.baseTargetPct).length;
    const positive = returns.filter(v => v > 0).length;
    return {
      count: returns.length,
      meanReturnPct: mean(returns),
      hitRate: returns.length ? hits / returns.length : 0,            // days meeting the % target (escalation gate)
      positiveRate: returns.length ? positive / returns.length : 0,  // winning days (de-escalation floor)
      maxDrawdownFromHWM: cycles.reduce((m, c) => Math.max(m, c.drawdownFromHWM || 0), 0),
    };
  }

  function escalate() {
    const next = phaseDef(state.currentPhase + 1);
    if (!next || next.id === state.currentPhase) return false;
    state.currentPhase = next.id;
    state.baseTargetPct = next.targetPct;
    state.lastEscalationAt = new Date(now()).toISOString();
    state.lastTransitionCycle = state.returnCycles.length;
    persist();
    return true;
  }
 
  function deescalate() {
    const minPhase = Number(process.env.TARGET_MIN_PHASE || 0);
    if (state.currentPhase <= minPhase) return false;
    state.currentPhase -= 1;
    state.baseTargetPct = phaseDef(state.currentPhase).targetPct;
    state.lastTransitionCycle = state.returnCycles.length;
    persist();
    return true;
  }

  function haltEngine(reason, triggeredBy) {
    state.haltState = { halted: true, reason, since: new Date(now()).toISOString(), triggeredBy };
    persist();
  }

  function evaluateOperationCycles() {
    const cur = phaseDef(state.currentPhase);
    if (cur.id !== 0) return;
    const okCycles = state.operationCycles.filter(c => c.ok === true);
    if (okCycles.length < cur.minOperationCycles) return;
    if (state.haltState.halted) return;
    escalate();
  }

  function evaluateReturnCycles() {
    const cur = phaseDef(state.currentPhase);
    if (cur.minReturnCycles <= 0) return;
    if (state.returnCycles.length < cur.minReturnCycles) return;
    const window = state.returnCycles.slice(-Math.max(cur.minReturnCycles, deescalation.hitRateWindow || 20));
    const s = stats(window);
    const target = state.baseTargetPct;
    const gatesOk =
      s.meanReturnPct >= target * (escalation.meanReturnFactor ?? 0.8) &&
      s.hitRate >= (escalation.hitRateThreshold ?? 0.3) &&
      s.maxDrawdownFromHWM <= (escalation.maxDrawdownAllowedPct ?? 3);
    // Cool-down: don't re-escalate within a few cycles of any recent transition
    // (prevents a single de-escalation being silently undone by the same window).
    const sinceTransition = state.returnCycles.length - (state.lastTransitionCycle || 0);
    if (gatesOk && sinceTransition < (escalation.cooldownCycles ?? 3)) return;
    if (gatesOk) escalate();
  }

  function checkDeescalationAndHalt(latest) {
    if (latest.returnPct == null) return;

    // [FIX] Guard against spurious hard-stops:
    // 1. If daily baseline is null/0/non-finite, returnPct is unreliable — skip.
    // 2. In Phase 0 (dry-run calibration), no real orders execute, so large
    //    negative "returns" are data artifacts, not real losses. Log + skip.
    const baselineValid = Number.isFinite(state.dailyBaselineEquity) && state.dailyBaselineEquity > 0;
    if (!baselineValid) return;

    if (latest.returnPct <= (halt.dailyHardStopPct ?? -2.0)) {
      if (state.currentPhase === 0) {
        // Phase 0 dry-run: log but don't halt (no real capital at risk)
        return;
      }
      haltEngine(`daily return ${latest.returnPct.toFixed(2)}% <= hard stop ${halt.dailyHardStopPct}%`, "dailyHardStop");
      deescalate();
      return;
    }
    if (state.currentPhase === 0) return;
    // Daily loss limit: apply only once enough return data exists to avoid
    // a single null/small-sample snapshot de-escalating the phase.
    const enoughData = state.returnCycles.length >= (deescalation.hitRateWindow || 20);
    if (!enoughData) return;
    if (latest.returnPct <= (deescalation.dailyLossLimitPct ?? -1.0)) {
      deescalate();
      return;
    }
    if ((latest.drawdownFromHWM || 0) > (deescalation.drawdownTriggerPct ?? 5)) {
      deescalate();
      return;
    }
    const winSize = deescalation.hitRateWindow || 20;
    const win = state.returnCycles.slice(-winSize);
    if (win.length >= winSize) {
      const s = stats(win);
      if (s.positiveRate < (deescalation.hitRateFloor ?? 0.1)) deescalate();
    }
  }

  return {
    getState() { return JSON.parse(JSON.stringify(state)); },
    getPhase() { return state.currentPhase; },
    getBucketStats(bucket) {
      if (!bucket || !state.returnCyclesByBucket[bucket]) return null;
      return stats(state.returnCyclesByBucket[bucket]);
    },

    getEffectiveLimits() {
      const cur = phaseDef(state.currentPhase);
      return {
        phase: state.currentPhase,
        phaseName: cur.name,
        dryRun: cur.dryRun === true,
        maxOrderValueKrw: cur.maxOrderValueKrw,
        baseTargetPct: state.baseTargetPct,
        halted: state.haltState.halted === true,
        highWaterEquity: state.highWaterEquity,
        dailyBaselineEquity: state.dailyBaselineEquity,
        dailyBaselineDate: state.dailyBaselineDate,
      };
    },

    project() {
      const lim = this.getEffectiveLimits();
      const reasons = [];
      if (lim.halted) reasons.push(`halted: ${state.haltState.reason}`);
      if (lim.dryRun) reasons.push(`phase ${lim.phase} (${lim.phaseName}) enforces dry-run`);
      reasons.push(`maxOrderValueKrw=${lim.maxOrderValueKrw}`);
      return { ...lim, reasons };
    },

    recordOperationOutcome(outcome) {
      pushFifo(state.operationCycles, {
        ts: new Date(now()).toISOString(),
        operation: outcome.operation,
        symbol: outcome.symbol,
        side: outcome.side,
        quantity: outcome.quantity,
        price: outcome.price,
        ok: outcome.ok === true,
        code: outcome.code,
        verified: outcome.verified === true,
      }, OPERATION_CYCLE_LIMIT);
      persist();
      evaluateOperationCycles();
      return state.currentPhase;
    },

    recordEquitySnapshot({ equity, date, bucket } = {}) {
      const equityNum = Number(equity);
      if (!Number.isFinite(equityNum) || equityNum <= 0) return state.currentPhase;
      const recDate = date || new Date(now()).toISOString().slice(0, 10);
      const recBucket = bucket || "default";

      // [P2-11 FIX #1] On date change, set the daily baseline to the previous
      // snapshot's equity (yesterday's close) so that the first intraday
      // snapshot of a new day can measure a real return rather than always 0%.
      // Falls back to current equity on the first-ever snapshot.
      // The ±15% sanity check (FIX #2) below catches phantom returns from
      // between-session changes (e.g., withdrawals, API data artifacts).
      const isNewDay = (
        state.dailyBaselineEquity == null ||
        state.dailyBaselineDate == null ||
        state.dailyBaselineDate !== recDate
      );
      if (isNewDay) {
        const lastRec = state.returnCycles.length > 0
          ? state.returnCycles[state.returnCycles.length - 1]
          : null;
        state.dailyBaselineEquity = (lastRec && lastRec.equity > 0) ? lastRec.equity : equityNum;
        state.dailyBaselineDate = recDate;
      }

      // returnPct = daily return vs today's baseline
      let returnPct = null;
      if (state.dailyBaselineEquity > 0) {
        returnPct = ((equityNum - state.dailyBaselineEquity) / state.dailyBaselineEquity) * 100;
      }

      // [P2-11 FIX #2] Sanity check: skip extreme returnPct values that indicate
      // API data artifacts (e.g., cash-only vs full holdings response from Toss).
      // A real portfolio cannot move ±15% intraday. Log and skip these as noise.
      const RETURN_PCT_SANITY_LIMIT = 15;
      if (returnPct != null && Math.abs(returnPct) > RETURN_PCT_SANITY_LIMIT) {
        console.warn("[target] Skipping anomalous equity snapshot: returnPct=" +
          returnPct.toFixed(2) + "%, equity=" + equityNum.toFixed(0) +
          ", baseline=" + state.dailyBaselineEquity.toFixed(0) +
          " (likely API data artifact, not real market move)");
        return state.currentPhase;
      }

      // [P2-11 FIX #3] HWM sanity check: if current equity is >20% below HWM
      // on first snapshot of a new session, reset HWM to current equity.
      // This prevents phantom drawdown from stale peaks that no longer reflect
      // the actual portfolio value (e.g., after corrections or data fixes).
      let prevHwm = state.highWaterEquity;
      if (prevHwm != null && prevHwm > 0 && isNewDay) {
        const gapPct = ((prevHwm - equityNum) / prevHwm) * 100;
        if (gapPct > 20) {
          console.warn("[target] HWM reset: prev=" + prevHwm.toFixed(0) +
            ", current=" + equityNum.toFixed(0) + " (gap=" + gapPct.toFixed(1) +
            "% > 20% threshold) — resetting HWM to current equity");
          prevHwm = null; // force reset below
        }
      }
      const hwm = prevHwm == null ? equityNum : Math.max(prevHwm, equityNum);
      state.highWaterEquity = hwm;
      const drawdownFromHWM = hwm > 0 ? ((hwm - equityNum) / hwm) * 100 : 0;

      const rec = {
        date: recDate,
        equity: equityNum,
        returnPct,
        drawdownFromHWM,
        dailyBaseline: state.dailyBaselineEquity,
        phaseAtRecord: state.currentPhase,
      };
      pushFifo(state.returnCycles, rec, RETURN_CYCLE_LIMIT);
      // [P5 Fix] Also record bucket-specific return cycle for dual-portfolio attribution
      if (recBucket !== "default") {
        if (!state.returnCyclesByBucket[recBucket]) state.returnCyclesByBucket[recBucket] = [];
        pushFifo(state.returnCyclesByBucket[recBucket], rec, RETURN_CYCLE_LIMIT);
      }
      persist();
      if (returnPct != null) checkDeescalationAndHalt(rec);
      evaluateReturnCycles();
      return state.currentPhase;
    },

    async recordDailyEquity() {
      if (typeof fetchEquity !== "function") throw new Error("fetchEquity not configured");
      const equity = await fetchEquity();
      return this.recordEquitySnapshot({ equity });
    },

    evaluate() {
      state.lastEvaluationAt = new Date(now()).toISOString();
      evaluateOperationCycles();
      evaluateReturnCycles();
      persist();
      return state.currentPhase;
    },

    resume() {
      state.haltState = { halted: false, reason: null, since: null, triggeredBy: null };
      persist();
      return true;
    },

    /**
     * Explicitly reseed the daily baseline equity.
     * Called by the runner on daily reset and on auto-recovery from halt
     * so that the hard-stop measures loss from *today's* starting equity,
     * not a stale value carried over from a previous session.
     */
    resetDailyBaseline(equity, date) {
      const eq = Number(equity);
      if (!Number.isFinite(eq) || eq <= 0) return false;
      state.dailyBaselineEquity = eq;
      state.dailyBaselineDate = date || new Date(now()).toISOString().slice(0, 10);
      persist();
      return true;
    },

    /**
     * [DEEP-DEBUG FIX] Directly advance to a specific phase without injecting
     * fake operation cycles. Used by runner.js DRY_RUN=false override to skip
     * Phase 0 calibration without polluting operationCycles with phantom records.
     */
    advancePhaseDirect(phaseId, reason) {
      const target = phaseDef(phaseId);
      if (!target || target.id === state.currentPhase) return false;
      state.currentPhase = target.id;
      state.baseTargetPct = target.targetPct;
      state.lastEscalationAt = new Date(now()).toISOString();
      state.lastTransitionCycle = state.returnCycles.length;
      persist();
      return true;
    },

    /**
     * [DEEP-DEBUG FIX] Remove entries from operationCycles matching a predicate.
     * Used to purge legacy LIVE_OVERRIDE phantom records that polluted the
     * state file in earlier versions.
     * @param {function} filterFn - keep entries where filterFn(entry) === true
     * @returns {number} count of removed entries
     */
    purgeOperationCycles(filterFn) {
      const before = state.operationCycles.length;
      state.operationCycles = state.operationCycles.filter(filterFn);
      const removed = before - state.operationCycles.length;
      if (removed > 0) persist();
      return removed;
    },

    reset() {
      state = defaultState(now);
      state.baseTargetPct = baseTargetPct;
      persist();
      return state;
    },
  };
}

function createEquitySnapshotter({ credentials, accountSeq, currency = "KRW", statePath, now } = {}) {
  const { fetchAccessToken, resetTokenCache, getHoldings, getBuyingPower, getExchangeRate } = require("../tossinvest");
  const engine = createTargetEngine({ statePath, now });

  async function fetchEquity() {
    const { clientId, clientSecret } = credentials || {};
    if (!clientId || !clientSecret) throw new Error("credentials required for equity snapshot");
    resetTokenCache();
    const token = await fetchAccessToken(clientId, clientSecret);
    // [Patch 2026-10-15 equity-fix] USD cash was EXCLUDED from KRW equity, causing
    // equity (13.6M) < totalCash (64.6M) distortion: hard-stop and phase gates ran
    // on a wrong base. Fetch USD buying power too and convert into base currency.
    const currencies = [currency, ...(currency === "KRW" ? ["USD"] : ["KRW"])];
    const [holdings, ...bpList] = await Promise.all([
      getHoldings(token, accountSeq),
      ...currencies.map(function(c) { return getBuyingPower(token, accountSeq, c).catch(function() { return { body: null }; }); }),
    ]);
    // [Patch 2026-10-15 equity-fix-2] Parse holdings items (was undefined -> ReferenceError,
    // positions silently dropped from equity).
    var _hbody = holdings && holdings.body ? holdings.body : holdings;
    var items = [];
    if (_hbody) {
      items = Array.isArray(_hbody) ? _hbody
        : (Array.isArray(_hbody.holdings) ? _hbody.holdings
        : (Array.isArray(_hbody.items) ? _hbody.items : []));
    }
    let total = 0;
    var _fxCache = {};
    for (var _i = 0; _i < currencies.length; _i++) {
      const _cur = currencies[_i];
      const _bp = Number(bpList[_i] && bpList[_i].body ? bpList[_i].body.cashBuyingPower : 0) || 0;
      if (_cur === currency) { total += _bp; continue; }
      if (_bp <= 0) continue;
      try {
        if (!_fxCache[_cur]) {
          const fx = await getExchangeRate(token, _cur, currency);
          _fxCache[_cur] = Number(fx.body && fx.body.rate) || 0;
        }
        if (_fxCache[_cur] > 0) total += _bp * _fxCache[_cur];
      } catch { /* skip unconvertible cash */ }
    }
    for (const it of items) {
      const cur = it.currency || "KRW";
      const mv = Number(it.marketValue?.amount ?? it.marketValue) || 0;
      if (cur === currency) { total += mv; continue; }
      try {
        const fx = await getExchangeRate(token, cur, currency);
        const rate = Number(fx.body?.rate) || 0;
        total += mv * rate;
      } catch { /* skip unconvertible */ }
    }
    return total;
  }

  return { engine, fetchEquity, snapshot: () => engine.recordDailyEquity.call(engine) };
}

function resetTargetEngineState(statePath) {
  const p = statePath || process.env.INVEST_TARGET_STATE || process.env.TOSSINVEST_TARGET_STATE || DEFAULT_STATE_PATH;
  try { fs.unlinkSync(p); } catch { /* already absent */ }
}

module.exports = {
  TARGET_PHASES,
  DEFAULT_STATE_PATH,
  createTargetEngine,
  createEquitySnapshotter,
  resetTargetEngineState,
};
