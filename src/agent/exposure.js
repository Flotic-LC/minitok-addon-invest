"use strict";

/**
 * Exposure limits — concentration risk control beyond per-order caps.
 * Checks symbol/sector/market concentration before allowing new positions.
 */

function getDefaults() {
  return {
    maxSymbolPct: Number(process.env.EXPO_MAX_SYMBOL_PCT || 20),
    maxMarketPct: Number(process.env.EXPO_MAX_MARKET_PCT || 70),
    maxSectorPct: Number(process.env.EXPO_MAX_SECTOR_PCT || 30),
    maxPositions: Number(process.env.EXPO_MAX_POSITIONS || 12),
    maxCorrelatedPct: Number(process.env.EXPO_MAX_CORR_PCT || 25),
    minCashReservePct: Number(process.env.EXPO_MIN_CASH_RESERVE_PCT || 15),
  };
}
const DEFAULTS = Object.freeze(getDefaults());

// Minimal sector map for the US/JP symbols in goals.json.
// Extend via EXPO_SECTOR_MAP='{"AAPL":"tech",...}' env.
const SECTOR_MAP = (() => {
  try { return JSON.parse(process.env.EXPO_SECTOR_MAP || "{}"); } catch { return {}; }
})();
Object.assign(SECTOR_MAP, {
  "AAPL": "tech", "MSFT": "tech", "NVDA": "tech", "TSLA": "auto",
});

function marketOf(symbol) {
  const s = String(symbol).toUpperCase();
  // A 6-digit symbol is Korean. The Korean market is not traded any more,
  // but the classification is kept so the symbol can be recognised and
  // refused rather than silently bucketed as a US position.
  if (/^\d{6}$/.test(s)) return "KR";
  if (/^\d{4}$/.test(s)) return "JP";
  if (/^[A-Z]+$/.test(s)) return "US";
  return "OTHER";
}

/**
 * Check if a proposed new position would breach concentration limits.
 * @param {object} input
 * @param {string} input.symbol - symbol to buy
 * @param {number} input.orderValueKrw - proposed order value (KRW)
 * @param {number} input.equity - total equity (KRW)
 * @param {Array} input.positions - current holdings [{symbol, qty, avgPrice, currentPrice, strategy?}]
 * @param {string} [input.strategy] - strategy tag of proposed trade (momentum/mean_reversion)
 * @param {object} [opts] - DEFAULTS overrides
 * @returns {{ ok, violations: string[], exposures }}
 */
function checkExposure(input, opts = {}) {
  const p = { ...getDefaults(), ...opts };
  // Allow caller (runner) to supply a richer sector map (e.g. from goals.json)
  const sectorMap = (opts && opts.sectorMap) || SECTOR_MAP;
  const violations = [];
  const equity = Number(input.equity) || 0;
  if (equity <= 0) return { ok: true, violations, exposures: {} }; // can't assess, let other guards handle

  // Aggregate current exposures (KRW values)
  const bySymbol = new Map(), byMarket = new Map(), bySector = new Map(), byStrategy = new Map();
  let investedKrw = 0;
  for (const pos of (input.positions || [])) {
    const qty = Number(pos.qty || pos.quantity || 0);
    if (qty <= 0) continue;
    // [2026-10-20 P0] Prefer the caller's KRW valuation.
    // The previous formula was `qty * price * (pos.fxRate || 1)`. The runner's
    // portfolio positions carry no `fxRate` field, so a USD position's dollar
    // value was added as if it were KRW — understating `invested` by ~1330x.
    // `orderKrw` was real KRW, so the two sides were in different units and
    // the check reported "invested 99.4% ~ 134.7% of equity" (>100% is
    // impossible), which blocked nearly every order.
    const valueKrw = Number(pos.valueKrw || 0);
    let value;
    if (valueKrw > 0) {
      value = valueKrw;
    } else {
      const price = Number(pos.currentPrice || pos.avgPrice || 0);
      const fx = Number(pos.fxRate != null ? pos.fxRate : 1);
      value = qty * price * fx;
    }
    investedKrw += value;
    const sym = String(pos.symbol).toUpperCase();
    bySymbol.set(sym, (bySymbol.get(sym) || 0) + value);
    const mkt = marketOf(sym);
    byMarket.set(mkt, (byMarket.get(mkt) || 0) + value);
     const sec = sectorMap[sym] || "unknown";
    bySector.set(sec, (bySector.get(sec) || 0) + value);
    if (pos.strategy) byStrategy.set(pos.strategy, (byStrategy.get(pos.strategy) || 0) + value);
  }

  const orderKrw = Number(input.orderValueKrw) || 0;
  const sym = String(input.symbol).toUpperCase();

  // 1. Symbol concentration
  const newSymbolTotal = (bySymbol.get(sym) || 0) + orderKrw;
  if ((newSymbolTotal / equity) * 100 > p.maxSymbolPct) {
    violations.push(`symbol ${sym} would reach ${((newSymbolTotal / equity) * 100).toFixed(1)}% of equity (max ${p.maxSymbolPct}%)`);
  }

  // 2. Market concentration
  const mkt = marketOf(sym);
  const newMarketTotal = (byMarket.get(mkt) || 0) + orderKrw;
  if ((newMarketTotal / equity) * 100 > p.maxMarketPct) {
    violations.push(`market ${mkt} would reach ${((newMarketTotal / equity) * 100).toFixed(1)}% (max ${p.maxMarketPct}%)`);
  }

  // 3. Sector concentration
     const sec = sectorMap[sym] || "unknown";
  if (sec !== "unknown") {
    const newSectorTotal = (bySector.get(sec) || 0) + orderKrw;
    if ((newSectorTotal / equity) * 100 > p.maxSectorPct) {
      violations.push(`sector ${sec} would reach ${((newSectorTotal / equity) * 100).toFixed(1)}% (max ${p.maxSectorPct}%)`);
    }
  }

  // 4. Total position count
  const openCount = [...bySymbol.keys()].length;
  if (!bySymbol.has(sym) && openCount >= p.maxPositions) {
    violations.push(`already ${openCount} open positions (max ${p.maxPositions})`);
  }

  // 5. Correlated strategy exposure
  if (input.strategy) {
    const newStratTotal = (byStrategy.get(input.strategy) || 0) + orderKrw;
    if ((newStratTotal / equity) * 100 > p.maxCorrelatedPct) {
      violations.push(`strategy ${input.strategy} would reach ${((newStratTotal / equity) * 100).toFixed(1)}% (max ${p.maxCorrelatedPct}%)`);
    }
  }

  // 6. Cash reserve (constitution: min_cash_reserve_pct)
  const newTotalInvested = investedKrw + orderKrw;
  const maxInvested = equity * (1 - p.minCashReservePct / 100);
  if (newTotalInvested > maxInvested) {
    violations.push(`cash reserve would drop below ${p.minCashReservePct}% (invested ${((newTotalInvested / equity) * 100).toFixed(1)}% > ${(100 - p.minCashReservePct).toFixed(1)}% max)`);
  }

  return {
    ok: violations.length === 0,
    violations,
    exposures: {
      investedPct: Math.round((investedKrw / equity) * 1000) / 10,
      openPositions: openCount,
      symbolPct: Math.round((newSymbolTotal / equity) * 1000) / 10,
      marketPct: Math.round((newMarketTotal / equity) * 1000) / 10,
    },
  };
}

module.exports = { DEFAULTS, SECTOR_MAP, marketOf, checkExposure };
