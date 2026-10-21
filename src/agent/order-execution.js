"use strict";

/**
 * Order execution quality: the order state machine, the idempotency guard,
 * the fill-quality metrics and the reconciliation against the broker.
 *
 * [2026-10-21 5단계] Three defects lived in this area:
 *
 *  1. A fill that the polling loop missed was invisible. The order monitor
 *     found the order "timed out", saw a non-zero filled quantity, treated
 *     it as a PARTIAL fill, charged the cost and CANCELLED it - an order
 *     that had actually filled. The position existed at the broker and the
 *     runner did not know about it: a phantom position and a phantom P&L.
 *  2. A retry after a timeout could submit the same order twice. The
 *     broker's order API takes no client order id, so the only protection
 *     was the 60s decision cooldown - which is a throttle, not an
 *     idempotency guarantee.
 *  3. Nothing measured the execution quality, so a symbol whose fills were
 *     slow, rejected or expensive kept being traded at full size.
 *
 * The state machine, the guard and the tracker are kept in a module of their
 * own so that every one of them can be tested against the failure modes
 * that produced the defects: a disconnect, a duplicate fill, a delayed
 * fill, a partial fill, a broker 500, a timeout, a token expiry, a process
 * restart and a corrupted state file.
 */

const ORDER_STATES = Object.freeze({
  NEW: "NEW",
  PENDING: "PENDING",
  PARTIALLY_FILLED: "PARTIALLY_FILLED",
  FILLED: "FILLED",
  CANCELED: "CANCELED",
  REJECTED: "REJECTED",
  EXPIRED: "EXPIRED",
  UNKNOWN: "UNKNOWN",
});

const TERMINAL_STATES = Object.freeze([
  ORDER_STATES.FILLED,
  ORDER_STATES.CANCELED,
  ORDER_STATES.REJECTED,
  ORDER_STATES.EXPIRED,
]);

/** The broker's status strings, mapped onto the state machine. */
const STATUS_MAP = Object.freeze({
  PENDING: ORDER_STATES.PENDING,
  NEW: ORDER_STATES.NEW,
  ORDERED: ORDER_STATES.PENDING,
  ACCEPTED: ORDER_STATES.PENDING,
  PARTIALLY_FILLED: ORDER_STATES.PARTIALLY_FILLED,
  PARTIAL: ORDER_STATES.PARTIALLY_FILLED,
  FILLED: ORDER_STATES.FILLED,
  COMPLETED: ORDER_STATES.FILLED,
  CANCELED: ORDER_STATES.CANCELED,
  CANCELLED: ORDER_STATES.CANCELED,
  REJECTED: ORDER_STATES.REJECTED,
  EXPIRED: ORDER_STATES.EXPIRED,
});

/**
 * Map a broker status onto the order state machine.
 *
 * An unknown status is UNKNOWN, not a terminal state: the order is neither
 * confirmed nor dead, so the monitor keeps polling it until the timeout
 * decides. Guessing a terminal state here is what loses fills.
 */
function classifyOrderStatus(raw) {
  const s = String(raw == null ? "" : raw).trim().toUpperCase();
  if (!s) return ORDER_STATES.UNKNOWN;
  return STATUS_MAP[s] || ORDER_STATES.UNKNOWN;
}

function isTerminal(state) {
  return TERMINAL_STATES.indexOf(state) >= 0;
}

/** A state in which the order has (partially) executed. */
function isFillProgress(state) {
  return state === ORDER_STATES.FILLED || state === ORDER_STATES.PARTIALLY_FILLED;
}

/**
 * What the broker reports about an order: the quantity that actually filled
 * and the average price it filled at.
 *
 * `avgFilledPrice` is the average across the partial fills, so it is the
 * correct price to book - not the last fill price.
 */
function readFillInfo(body) {
  const b = body && typeof body === "object" ? body : {};
  const filledQuantity = Number(b.filledQuantity || b.executedQuantity || 0) || 0;
  const avgPrice = Number(b.avgFilledPrice || b.filledPrice || b.price || 0) || 0;
  return { filledQuantity, avgPrice };
}

/**
 * What should the runner do with an order it is about to cancel?
 *
 * [2026-10-21 5단계] The old code only asked "is the filled quantity
 * non-zero". A fully filled order therefore looked like a partial one: it
 * was charged as a partial, cancelled, and the position it had created was
 * never booked. A full fill is a fill.
 */
function timeoutVerdict(info, brokerBody) {
  const fill = readFillInfo(brokerBody);
  const ordered = Number(info && (info.originalQuantity || info.quantity)) || 0;
  if (fill.filledQuantity > 0 && ordered > 0 && fill.filledQuantity >= ordered) {
    return { action: "APPLY_FILL", reason: "the order had in fact filled", fill };
  }
  if (fill.filledQuantity > 0) {
    return { action: "RECORD_PARTIAL", reason: "the order was partially filled", fill };
  }
  return { action: "CANCEL", reason: "the order was not filled", fill };
}

/**
 * Claim a fill once.
 *
 * The same order can be observed more than once: the monitor polls it, the
 * reconciliation sees it in the broker's list, and a restart re-reads the
 * persisted pending orders. The P&L must be booked exactly once.
 */
function markFillApplied(info) {
  if (!info || info.fillApplied) return false;
  info.fillApplied = true;
  return true;
}

/**
 * The idempotency key of a logical order.
 *
 * The broker's order API takes no client order id, so the protection has to
 * be local: a deterministic key per (symbol, side, quantity, price). A key
 * that was already claimed inside the window is a duplicate submission -
 * typically a retry after a timeout, where the first attempt may well have
 * reached the broker even though the response never arrived.
 */
function idempotencyKey(input) {
  const i = input || {};
  return [
    String(i.symbol || "").toUpperCase(),
    String(i.side || "").toUpperCase(),
    Number(i.quantity) || 0,
    Number(i.price) || 0,
  ].join("|");
}

function createIdempotencyGuard(options) {
  const cfg = Object.assign({ windowMs: 120000, maxEntries: 200 }, options || {});
  const claims = new Map(); // key -> { at, orderId }

  function claim(key, at) {
    const now = at == null ? Date.now() : at;
    const prior = claims.get(key);
    if (prior && (now - prior.at) < cfg.windowMs) {
      return {
        ok: false,
        duplicate: true,
        reason: "an identical order was submitted " + Math.round((now - prior.at) / 1000) + "s ago",
        existing: { at: prior.at, orderId: prior.orderId },
      };
    }
    claims.set(key, { at: now, orderId: null });
    if (claims.size > cfg.maxEntries) {
      const oldest = Array.from(claims.entries()).sort(function (a, b) { return a[1].at - b[1].at; })[0];
      if (oldest) claims.delete(oldest[0]);
    }
    return { ok: true, duplicate: false };
  }

  function attach(key, orderId) {
    const c = claims.get(key);
    if (c) c.orderId = orderId == null ? null : String(orderId);
  }

  function release(key) {
    claims.delete(key);
  }

  function state() {
    return Array.from(claims.entries()).map(function (e) { return [e[0], e[1]]; });
  }

  function restore(entries) {
    if (!Array.isArray(entries)) return;
    for (const e of entries) {
      if (!Array.isArray(e) || !e[0]) continue;
      const v = e[1] && typeof e[1] === "object" ? e[1] : {};
      claims.set(String(e[0]), { at: Number(v.at) || 0, orderId: v.orderId == null ? null : String(v.orderId) });
    }
  }

  return {
    claim: claim,
    attach: attach,
    release: release,
    state: state,
    restore: restore,
    size: function () { return claims.size; },
  };
}

/**
 * The execution-quality tracker.
 *
 * It records what the broker actually did with the orders: how many were
 * submitted, filled, rejected, how long the fills took and how far the
 * fill price was from the price the bot asked for. A symbol whose fills
 * are slow or expensive is restricted to a smaller size - the alternative
 * is to keep paying the same friction on a name that has already proved it
 * cannot be executed well.
 */
function createFillQualityTracker(options) {
  const cfg = Object.assign({
    minSamples: 10,          // below this the sample is too small to judge
    maxLatencyMs: 120000,    // slower than two minutes is an execution problem
    maxSlippagePct: 0.75,    // worse than 75 bps of slippage is an execution problem
    minFillRate: 0.8,        // fewer than 80% of the ordered quantity filling is a problem
    restrictMultiplier: 0.5, // the size a restricted symbol is allowed
    minRejectionRate: 0.25,  // a quarter of the orders rejected is a problem
  }, options || {});

  const bySymbol = new Map(); // symbol -> counters

  function bucket(symbol) {
    const key = String(symbol || "").toUpperCase();
    let b = bySymbol.get(key);
    if (!b) {
      b = {
        symbol: key,
        submissions: 0,
        fills: 0,
        rejections: 0,
        orderedQty: 0,
        filledQty: 0,
        latencySumMs: 0,
        latencyCount: 0,
        slippageSumPct: 0,
        slippageCount: 0,
      };
      bySymbol.set(key, b);
    }
    return b;
  }

  function recordSubmission(symbol, orderedQty) {
    const b = bucket(symbol);
    b.submissions++;
    b.orderedQty += Number(orderedQty) || 0;
    return b;
  }

  function recordFill(symbol, info) {
    const b = bucket(symbol);
    const i = info || {};
    b.fills++;
    b.filledQty += Number(i.filledQty) || 0;
    if (Number.isFinite(Number(i.latencyMs))) {
      b.latencySumMs += Number(i.latencyMs);
      b.latencyCount++;
    }
    if (Number.isFinite(Number(i.slippagePct))) {
      b.slippageSumPct += Number(i.slippagePct);
      b.slippageCount++;
    }
    return b;
  }

  function recordRejection(symbol) {
    const b = bucket(symbol);
    b.rejections++;
    return b;
  }

  function stats(symbol) {
    const b = bySymbol.get(String(symbol || "").toUpperCase());
    if (!b) {
      return {
        symbol: String(symbol || "").toUpperCase(), submissions: 0, fills: 0, rejections: 0,
        fillRate: null, avgLatencyMs: null, avgSlippagePct: null, rejectionRate: null, sampleSize: 0,
      };
    }
    const decided = b.fills + b.rejections;
    return {
      symbol: b.symbol,
      submissions: b.submissions,
      fills: b.fills,
      rejections: b.rejections,
      sampleSize: decided,
      fillRate: decided > 0 ? b.fills / decided : null,
      avgLatencyMs: b.latencyCount > 0 ? b.latencySumMs / b.latencyCount : null,
      avgSlippagePct: b.slippageCount > 0 ? b.slippageSumPct / b.slippageCount : null,
      rejectionRate: decided > 0 ? b.rejections / decided : null,
    };
  }

  /**
   * Should this symbol be restricted?
   *
   * The decision needs a sample: a symbol with two orders and one rejection
   * is not an execution problem, it is a Tuesday. Below the minimum sample
   * nothing is restricted.
   */
  function restrictionFor(symbol) {
    const s = stats(symbol);
    if (s.sampleSize < cfg.minSamples) {
      return { restricted: false, reason: "only " + s.sampleSize + " decided orders - not enough to judge", stats: s };
    }
    const reasons = [];
    if (s.rejectionRate != null && s.rejectionRate >= cfg.minRejectionRate) {
      reasons.push("rejection rate " + (s.rejectionRate * 100).toFixed(1) + "%");
    }
    if (s.avgLatencyMs != null && s.avgLatencyMs > cfg.maxLatencyMs) {
      reasons.push("average fill latency " + Math.round(s.avgLatencyMs) + "ms");
    }
    if (s.avgSlippagePct != null && s.avgSlippagePct > cfg.maxSlippagePct) {
      reasons.push("average slippage " + s.avgSlippagePct.toFixed(3) + "%");
    }
    if (s.fillRate != null && s.fillRate < cfg.minFillRate) {
      reasons.push("fill rate " + (s.fillRate * 100).toFixed(1) + "%");
    }
    if (!reasons.length) return { restricted: false, reason: "execution quality is within limits", stats: s };
    return {
      restricted: true,
      reason: "poor execution quality: " + reasons.join(", "),
      multiplier: cfg.restrictMultiplier,
      stats: s,
    };
  }

  function state() {
    return Array.from(bySymbol.values());
  }

  function restore(entries) {
    if (!Array.isArray(entries)) return;
    for (const e of entries) {
      if (!e || typeof e !== "object" || !e.symbol) continue;
      bySymbol.set(String(e.symbol).toUpperCase(), Object.assign(bucket(e.symbol), e));
    }
  }

  return {
    recordSubmission: recordSubmission,
    recordFill: recordFill,
    recordRejection: recordRejection,
    stats: stats,
    restrictionFor: restrictionFor,
    state: state,
    restore: restore,
  };
}

/**
 * Compare the local pending orders with the broker's order list.
 *
 * The broker's list is the truth. A local order the broker reports as
 * filled is a fill the polling loop missed; a local order the broker does
 * not know at all was either never submitted or is already terminal; a
 * broker order the runner does not know about is an order submitted by
 * something else and must not be booked as the runner's own.
 */
function reconcileOrders(localOrders, brokerOrders) {
  const out = { fills: [], missing: [], pending: [], brokerOnly: [] };
  const local = Array.isArray(localOrders) ? localOrders : [];
  const broker = Array.isArray(brokerOrders) ? brokerOrders : [];

  const byId = new Map();
  for (const o of broker) {
    const id = String((o && (o.orderId || o.id)) || "");
    if (id) byId.set(id, o);
  }

  const localIds = new Set();
  for (const l of local) {
    const id = String((l && (l.orderId || l.id)) || "");
    if (id) localIds.add(id);
    const bo = byId.get(id);
    if (!bo) {
      out.missing.push(l);
      continue;
    }
    const state = classifyOrderStatus(bo.status);
    const fill = readFillInfo(bo);
    if (isFillProgress(state) && fill.filledQuantity > 0) {
      out.fills.push({ local: l, broker: bo, state: state, fill: fill });
    } else {
      out.pending.push({ local: l, broker: bo, state: state, fill: fill });
    }
  }

  for (const [id, bo] of byId) {
    if (!localIds.has(id)) out.brokerOnly.push(bo);
  }

  return out;
}

/**
 * Restore the persisted state defensively.
 *
 * A truncated or corrupted state file must not take the runner down, and it
 * must not resurrect half an order. Anything that does not parse is
 * discarded: the runner comes up with no pending orders, which is safe,
 * because the broker is the truth and the reconciliation will pick the
 * real state up again.
 */
function restoreState(raw, fallback) {
  const empty = fallback && typeof fallback === "object" ? fallback : {};
  if (raw == null) return { ok: false, reason: "no persisted state", value: empty };
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (e) {
    return { ok: false, reason: "the persisted state is not valid JSON: " + (e && e.message), value: empty };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "the persisted state is not an object", value: empty };
  }
  return { ok: true, reason: null, value: parsed };
}

module.exports = {
  ORDER_STATES: ORDER_STATES,
  TERMINAL_STATES: TERMINAL_STATES,
  STATUS_MAP: STATUS_MAP,
  classifyOrderStatus: classifyOrderStatus,
  isTerminal: isTerminal,
  isFillProgress: isFillProgress,
  readFillInfo: readFillInfo,
  timeoutVerdict: timeoutVerdict,
  markFillApplied: markFillApplied,
  idempotencyKey: idempotencyKey,
  createIdempotencyGuard: createIdempotencyGuard,
  createFillQualityTracker: createFillQualityTracker,
  reconcileOrders: reconcileOrders,
  restoreState: restoreState,
};
