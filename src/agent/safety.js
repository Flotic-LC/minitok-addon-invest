"use strict";

function createSafety(safetyLimits = {}) {
  const {
    maxOrderValueKrw,
    allowedSymbols,
    maxQuantity,
    maxOpenOrders = 10,
    maxPositionsPerSymbol = 1,
    dailyMaxValueKrw = 5000000,
    cooldownMs = 0,
    enforcePreChecks = true,
  } = safetyLimits;
  const last = new Map();

  // [FIX #3] Stateful risk tracking
  let dailyTradedValueKrw = 0;
  let dailyResetDate = new Date().toISOString().slice(0, 10);
  const openOrderCount = { value: 0 };
  const positionCounts = new Map(); // symbol -> count

  function resetDailyIfNewDay() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== dailyResetDate) {
      dailyTradedValueKrw = 0;
      dailyResetDate = today;
    }
  }

  return {
    // Expose for external sync (e.g. runner can update openOrderCount after fills)
    setOpenOrderCount(count) { openOrderCount.value = count; },
    recordPositionOpen(symbol) {
      positionCounts.set(symbol, (positionCounts.get(symbol) || 0) + 1);
    },
    recordPositionClose(symbol) {
      const c = (positionCounts.get(symbol) || 0) - 1;
      if (c <= 0) positionCounts.delete(symbol);
      else positionCounts.set(symbol, c);
    },
     getDailyTradedValue() { return dailyTradedValueKrw; },
     recordOrderSuccess(input) {
       if (!input) return;
       const orderValue = Number(input.price) * Number(input.quantity);
       if (Number.isFinite(orderValue) && orderValue > 0) dailyTradedValueKrw += orderValue;
     },

    checkPreCreateOrder(input) {
      if (!enforcePreChecks) return { ok: true };
      resetDailyIfNewDay();

      if (Array.isArray(allowedSymbols) && input.symbol && !allowedSymbols.includes(input.symbol)) {
        return { ok: false, code: "SYMBOL_NOT_ALLOWED", reason: `Symbol ${input.symbol} not allowed` };
      }
      if (maxOrderValueKrw && input.price != null && input.quantity != null) {
        const v = Number(input.price) * Number(input.quantity);
        if (v > maxOrderValueKrw) return { ok: false, code: "ORDER_VALUE_EXCEEDED", reason: "Order value exceeds limit" };
      }
      if (maxQuantity && input.quantity != null && Number(input.quantity) > maxQuantity) {
        return { ok: false, code: "QUANTITY_EXCEEDED", reason: "Quantity exceeds limit" };
      }

      // [FIX #3] Daily traded value cap (check only; increment happens on success via recordOrderSuccess)
      if (dailyMaxValueKrw && input.price != null && input.quantity != null) {
        const orderValue = Number(input.price) * Number(input.quantity);
        if (dailyTradedValueKrw + orderValue > dailyMaxValueKrw) {
          return { ok: false, code: "DAILY_VALUE_EXCEEDED", reason: `Daily traded value would exceed ${dailyMaxValueKrw} KRW (current: ${dailyTradedValueKrw})` };
        }
      }

      // [FIX #3] Max open orders cap
      if (maxOpenOrders && openOrderCount.value >= maxOpenOrders) {
        return { ok: false, code: "MAX_OPEN_ORDERS", reason: `Open order count (${openOrderCount.value}) at limit (${maxOpenOrders})` };
      }

      // [FIX #3] Max positions per symbol (BUY only)
      if (maxPositionsPerSymbol && input.side === "BUY" && input.symbol) {
        const posCount = positionCounts.get(input.symbol) || 0;
        if (posCount >= maxPositionsPerSymbol) {
          return { ok: false, code: "MAX_POSITIONS_PER_SYMBOL", reason: `Already ${posCount} position(s) in ${input.symbol} (max: ${maxPositionsPerSymbol})` };
        }
      }

      if (cooldownMs > 0) {
        const k = `${input.symbol}:${input.side}`;
        const now = Date.now();
        const prev = last.get(k);
        if (prev && now - prev < cooldownMs) return { ok: false, code: "COOLDOWN_ACTIVE", reason: "Cooldown in effect" };
        last.set(k, now);
      }
      return { ok: true };
    },
    checkPreCreateConditional(input) {
      if (!enforcePreChecks) return { ok: true };
      if (Array.isArray(allowedSymbols) && input.symbol && !allowedSymbols.includes(input.symbol)) {
        return { ok: false, code: "SYMBOL_NOT_ALLOWED", reason: `Symbol ${input.symbol} not allowed` };
      }
      const price = input.first?.orderPrice;
      if (maxOrderValueKrw && price != null && input.quantity != null) {
        const v = Number(price) * Number(input.quantity);
        if (v > maxOrderValueKrw) return { ok: false, code: "ORDER_VALUE_EXCEEDED", reason: "Conditional order value exceeds limit" };
      }
      if (maxQuantity && input.quantity != null && Number(input.quantity) > maxQuantity) {
        return { ok: false, code: "QUANTITY_EXCEEDED", reason: "Quantity exceeds limit" };
      }
      return { ok: true };
    },
    isKillswitch() {
      return process.env.TOSSINVEST_KILLSWITCH === "true";
    },
  };
}

module.exports = { createSafety };
