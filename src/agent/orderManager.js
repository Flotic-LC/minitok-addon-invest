"use strict";

/**
 * Order lifecycle manager — tracks pending orders, handles expiry,
 * partial fills, and retries.
 *
 * Replaces the ad-hoc pendingOrders Map in runner.js with a testable,
 * injectable module.
 */

const DEFAULTS = Object.freeze({
  timeoutMs: Number(process.env.ORDER_MONITOR_TIMEOUT_MS || 180000), // 3 min
  pollMs: Number(process.env.ORDER_MONITOR_POLL_MS || 30000),         // 30s
  maxRetries: Number(process.env.ORDER_MAX_RETRIES || 3),
});

function createOrderManager(deps = {}) {
  const {
    getOrder,        // async (orderId) => { body: { status, filledQuantity, filledPrice } }
    cancelOrder,     // async (orderId) => { ok }
    onFilled,        // (order, fillInfo) => void
    onExpired,       // (order) => void
    onPartialFill,   // (order, partialInfo) => void
    onFailed,        // (order, reason) => void
    timeoutMs = DEFAULTS.timeoutMs,
    maxRetries = DEFAULTS.maxRetries,
    now = () => Date.now(),
  } = deps;

  if (typeof getOrder !== "function") throw new TypeError("orderManager: getOrder is required");

  const orders = new Map(); // orderId -> tracked order

  function track(orderId, meta = {}) {
    orders.set(orderId, {
      orderId,
      symbol: meta.symbol,
      side: meta.side,
      price: Number(meta.price) || 0,
      quantity: Number(meta.quantity) || 0,
      filledQuantity: 0,
      remainingQuantity: Number(meta.quantity) || 0,
      retries: 0,
      createdAt: now(),
      status: "OPEN",
    });
    return orders.get(orderId);
  }

  function untrack(orderId) {
    orders.delete(orderId);
  }

  function size() { return orders.size; }
  function get(orderId) { return orders.get(orderId); }
  function list() { return [...orders.values()]; }

  /**
   * Poll all tracked orders once. Returns summary { filled, expired, failed, open }.
   */
  async function poll() {
    const summary = { filled: 0, expired: 0, failed: 0, partial: 0, open: 0 };
    for (const [orderId, ord] of orders) {
      try {
        const resp = await getOrder(orderId);
        const body = resp && resp.body ? resp.body : {};
        const status = String(body.status || "").toUpperCase();
        const filledQty = Number(body.filledQuantity || body.filledQty || 0);
        const filledPrice = Number(body.filledPrice || body.avgFilledPrice || 0);

        // Partial fill detection
        if (filledQty > ord.filledQuantity && filledQty < ord.quantity) {
          const newFilled = filledQty - ord.filledQuantity;
          ord.filledQuantity = filledQty;
          ord.remainingQuantity = ord.quantity - filledQty;
          summary.partial++;
          if (onPartialFill) onPartialFill(ord, { newFilled, filledPrice, totalFilled: filledQty });
          continue;
        }

        if (status === "FILLED" || status === "COMPLETED" || filledQty >= ord.quantity) {
          ord.status = "FILLED";
          ord.filledQuantity = ord.quantity;
          ord.remainingQuantity = 0;
          summary.filled++;
          orders.delete(orderId);
          if (onFilled) onFilled(ord, { filledPrice: filledPrice || ord.price, filledQuantity: ord.quantity });
          continue;
        }

        if (status === "CANCELED" || status === "CANCELLED") {
          ord.status = "CANCELED";
          orders.delete(orderId);
          continue;
        }

        if (status === "REJECTED") {
          ord.status = "REJECTED";
          ord.retries++;
          if (ord.retries >= maxRetries) {
            summary.failed++;
            orders.delete(orderId);
            if (onFailed) onFailed(ord, "REJECTED after " + ord.retries + " attempts");
          }
          continue;
        }

        // Timeout check
        if (now() - ord.createdAt > timeoutMs) {
          ord.status = "EXPIRED";
          summary.expired++;
          orders.delete(orderId);
          if (cancelOrder) { try { await cancelOrder(orderId); } catch (e) { console.error("[order-mgr] Failed to cancel expired order " + orderId + ": " + e.message); } }
          if (onExpired) onExpired(ord);
          continue;
        }

        summary.open++;
      } catch (e) {
        ord.retries++;
        if (ord.retries >= maxRetries) {
          summary.failed++;
          orders.delete(orderId);
          if (onFailed) onFailed(ord, e.message);
        }
      }
    }
    return summary;
  }

  return { track, untrack, get, list, size, poll };
}

module.exports = { createOrderManager, DEFAULTS };
