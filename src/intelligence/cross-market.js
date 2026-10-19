"use strict";

/**
 * Cross-Market Scanner (Phase M / L4.5) — detects arbitrage opportunities
 * across multiple exchanges by comparing FX-adjusted prices in basis points.
 *
 * Supported pair types:
 *   - GDR/ADR: Samsung KRX 005930 ↔ LSE GDR / OTC ADR
 *   - Dual-listed: TSLA NASDAQ ↔ FRA TSLA.DE / HKEX 9868
 *   - Crypto: Binance BTC-USDT ↔ Upbit BTC-KRW
 *
 * Spread calculation:
 *   1. Normalize both legs to common currency (USD) via fxProvider
 *   2. Apply ADR ratio (e.g., 1 GDR = 50 KRX shares for Samsung)
 *   3. Compute spread in basis points: ((pB - pA) / midpoint) × 10000
 *   4. Deduct round-trip cost (2 × costBps) → net spread
 *   5. Detect opportunity if |netSpread| ≥ thresholdBps
 *
 * Usage:
 *   const { createCrossMarketScanner } = require("./src/intelligence/cross-market");
 *   const scanner = createCrossMarketScanner({
 *     priceFeeds: { KRX: async (sym) => 71000, LSE: async (sym) => 1050 },
 *     fxProvider: async (pair) => 0.00075, // KRW/USD
 *     config: { thresholdBps: 50, costBps: 10 },
 *   });
 *   scanner.registerPair({ id: "samsung_gdr", name: "Samsung GDR",
 *     assetA: { exchange: "KRX", symbol: "005930", currency: "KRW" },
 *     assetB: { exchange: "LSE", symbol: "SMSN", currency: "USD", adrRatio: 50 }
 *   });
 *   const result = await scanner.scan();
 *   // result.opportunities: [{ pair, direction, grossBps, netBps, prices, fx }]
 */

const DEFAULTS = Object.freeze({
  thresholdBps: Number(process.env.CROSS_MARKET_THRESHOLD_BPS || 20),
  costBps: Number(process.env.CROSS_MARKET_COST_BPS || 10), // one-way cost
  scanIntervalMs: Number(process.env.CROSS_MARKET_SCAN_INTERVAL_MS || 60000),
  fetchTimeoutMs: Number(process.env.CROSS_MARKET_FETCH_TIMEOUT_MS || 5000),
  maxHistorySize: Number(process.env.CROSS_MARKET_MAX_HISTORY || 1000),
  baseCurrency: "USD", // normalize all legs to this currency
  now: null,
});

// --- Helpers ---
function bps(a, b) {
  // basis points difference: ((b - a) / midpoint) * 10000
  if (!a || !b || a <= 0 || b <= 0) return 0;
  var mid = (a + b) / 2;
  if (mid === 0) return 0;
  return ((b - a) / mid) * 10000;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
function createCrossMarketScanner(options) {
  var opts = options || {};
  var cfg = Object.assign({}, DEFAULTS, opts.config || {});
  var priceFeeds = opts.priceFeeds || {};
  var fxProvider = typeof opts.fxProvider === "function" ? opts.fxProvider : null;
  var onOpportunity = typeof opts.onOpportunity === "function" ? opts.onOpportunity : function() {};
  var onError = typeof opts.onError === "function" ? opts.onError : function() {};
  var now = typeof cfg.now === "function" ? cfg.now : function() { return Date.now(); };

  var pairs = new Map();
  var history = [];
  var counters = {
    scans: 0,
    pairsScanned: 0,
    opportunities: 0,
    errors: 0,
    lastScanAt: null,
  };

  function addHistory(entry) {
    history.push(entry);
    if (history.length > cfg.maxHistorySize) {
      history.splice(0, history.length - cfg.maxHistorySize);
    }
  }

  // =========================================================================
  // Pair management
  // =========================================================================
  function validatePair(pair) {
    if (!pair || typeof pair !== "object") throw new Error("pair must be an object");
    if (!pair.id || typeof pair.id !== "string") throw new Error("pair.id required (string)");
    if (!pair.assetA || !pair.assetA.exchange || !pair.assetA.symbol || !pair.assetA.currency) {
      throw new Error("pair.assetA requires exchange, symbol, currency");
    }
    if (!pair.assetB || !pair.assetB.exchange || !pair.assetB.symbol || !pair.assetB.currency) {
      throw new Error("pair.assetB requires exchange, symbol, currency");
    }
    return true;
  }

  function registerPair(pair) {
    validatePair(pair);
    pairs.set(pair.id, {
      id: pair.id,
      name: pair.name || pair.id,
      assetA: Object.assign({}, pair.assetA),
      assetB: Object.assign({}, pair.assetB),
      active: pair.active !== false,
      registeredAt: now(),
    });
    return { id: pair.id, registered: true };
  }

  function removePair(pairId) {
    return pairs.delete(pairId);
  }

  function listPairs() {
    return Array.from(pairs.values()).map(function(p) {
      return { id: p.id, name: p.name, active: p.active, assetA: p.assetA, assetB: p.assetB };
    });
  }

  // =========================================================================
  // Price + FX fetchers (with timeout + error isolation)
  // =========================================================================
  function fetchPrice(exchange, symbol) {
    var feed = priceFeeds[exchange];
    if (typeof feed !== "function") {
      return Promise.reject(new Error("no price feed for exchange: " + exchange));
    }
    return new Promise(function(resolve, reject) {
      var timer = setTimeout(function() {
        reject(new Error("price fetch timeout (" + cfg.fetchTimeoutMs + "ms): " + exchange + "/" + symbol));
      }, cfg.fetchTimeoutMs);
      if (timer.unref) timer.unref();
      Promise.resolve()
        .then(function() { return feed(symbol); })
        .then(function(price) {
          clearTimeout(timer);
          if (price == null || !(Number.isFinite(price)) || price <= 0) {
            reject(new Error("invalid price from " + exchange + "/" + symbol + ": " + price));
          } else {
            resolve(Number(price));
          }
        })
        .catch(function(e) {
          clearTimeout(timer);
          reject(e);
        });
    });
  }

  function fetchFx(currency) {
    if (currency === cfg.baseCurrency) return Promise.resolve(1);
    if (!fxProvider) return Promise.reject(new Error("no fxProvider configured"));
    var pair = currency + cfg.baseCurrency;
    return new Promise(function(resolve, reject) {
      var timer = setTimeout(function() {
        reject(new Error("fx fetch timeout: " + pair));
      }, cfg.fetchTimeoutMs);
      if (timer.unref) timer.unref();
      Promise.resolve()
        .then(function() { return fxProvider(pair); })
        .then(function(rate) {
          clearTimeout(timer);
          if (rate == null || !(Number.isFinite(rate)) || rate <= 0) {
            reject(new Error("invalid fx rate for " + pair + ": " + rate));
          } else {
            resolve(Number(rate));
          }
        })
        .catch(function(e) {
          clearTimeout(timer);
          reject(e);
        });
    });
  }

  // =========================================================================
  // Core: compute FX-adjusted spread for a single pair
  // =========================================================================
  function normalizePrice(rawPrice, currency, adrRatio) {
    return fetchFx(currency).then(function(fx) {
      return { price: rawPrice * fx * (adrRatio || 1), fx: fx, raw: rawPrice };
    });
  }

  function computeSpread(pair) {
    var ts = now();
    var assetA = pair.assetA;
    var assetB = pair.assetB;
    return Promise.all([
      fetchPrice(assetA.exchange, assetA.symbol),
      fetchPrice(assetB.exchange, assetB.symbol),
    ]).then(function(prices) {
      return Promise.all([
        normalizePrice(prices[0], assetA.currency, assetA.adrRatio),
        normalizePrice(prices[1], assetB.currency, assetB.adrRatio),
      ]).then(function(norms) {
        var normA = norms[0];
        var normB = norms[1];
        var grossBps = bps(normA.price, normB.price);
        var costTotal = cfg.costBps * 2;
        var absGross = Math.abs(grossBps);
        var netBps = absGross > costTotal
          ? (grossBps > 0 ? grossBps - costTotal : grossBps + costTotal)
          : 0;
        var direction = null;
        if (grossBps > cfg.thresholdBps) direction = "A_TO_B";
        else if (grossBps < -cfg.thresholdBps) direction = "B_TO_A";
        var opportunity = direction !== null && Math.abs(netBps) >= cfg.thresholdBps;
        return {
          pairId: pair.id,
          pairName: pair.name,
          ts: ts,
          grossBps: Number(grossBps.toFixed(2)),
          netBps: Number(netBps.toFixed(2)),
          costBps: costTotal,
          thresholdBps: cfg.thresholdBps,
          direction: direction,
          opportunity: opportunity,
          prices: {
            A: { raw: normA.raw, normalized: Number(normA.price.toFixed(6)), fx: normA.fx, currency: assetA.currency, exchange: assetA.exchange, symbol: assetA.symbol },
            B: { raw: normB.raw, normalized: Number(normB.price.toFixed(6)), fx: normB.fx, currency: assetB.currency, exchange: assetB.exchange, symbol: assetB.symbol },
          },
        };
      });
    });
  }

  function scan() {
    counters.scans++;
    counters.lastScanAt = now();
    var activePairs = Array.from(pairs.values()).filter(function(p) { return p.active; });
    counters.pairsScanned = activePairs.length;
    if (activePairs.length === 0) {
      return Promise.resolve({ scannedAt: counters.lastScanAt, pairsScanned: 0, opportunities: [], results: [] });
    }
    var promises = activePairs.map(function(pair) {
      return computeSpread(pair).catch(function(err) {
        counters.errors++;
        var errorEntry = { pairId: pair.id, pairName: pair.name, ts: now(), error: err.message, opportunity: false };
        addHistory(errorEntry);
        try { onError(pair.id, err); } catch (e) { /* ignore */ }
        return errorEntry;
      });
    });
    return Promise.all(promises).then(function(results) {
      var opportunities = [];
      for (var i = 0; i < results.length; i++) {
        var r = results[i];
        addHistory(r);
        if (r.opportunity) {
          opportunities.push(r);
          counters.opportunities++;
          try { onOpportunity(r); } catch (e) { /* ignore */ }
        }
      }
      return { scannedAt: counters.lastScanAt, pairsScanned: activePairs.length, opportunities: opportunities, results: results };
    });
  }


  // =========================================================================
  // Accessors + state
  // =========================================================================
  function getHistory(limit) {
    var lim = limit || history.length;
    return history.slice(-lim);
  }

  function stats() {
    return {
      enabled: true,
      totalPairs: pairs.size,
      activePairs: Array.from(pairs.values()).filter(function(p) { return p.active; }).length,
      scans: counters.scans,
      pairsScanned: counters.pairsScanned,
      opportunities: counters.opportunities,
      errors: counters.errors,
      lastScanAt: counters.lastScanAt,
      historySize: history.length,
      thresholdBps: cfg.thresholdBps,
      costBps: cfg.costBps,
      baseCurrency: cfg.baseCurrency,
    };
  }

  function state() {
    return {
      pairs: Array.from(pairs.entries()),
      history: history.slice(-cfg.maxHistorySize),
      counters: Object.assign({}, counters),
    };
  }

  function restore(savedState) {
    if (!savedState) return;
    if (savedState.pairs && Array.isArray(savedState.pairs)) {
      pairs.clear();
      for (var i = 0; i < savedState.pairs.length; i++) {
        var entry = savedState.pairs[i];
        pairs.set(entry[0], entry[1]);
      }
    }
    if (savedState.history && Array.isArray(savedState.history)) {
      history.length = 0;
      for (var j = 0; j < savedState.history.length; j++) {
        history.push(savedState.history[j]);
      }
    }
    if (savedState.counters) {
      Object.assign(counters, savedState.counters);
    }
  }

  function reset() {
    pairs.clear();
    history.length = 0;
    counters.scans = 0;
    counters.pairsScanned = 0;
    counters.opportunities = 0;
    counters.errors = 0;
    counters.lastScanAt = null;
  }

  return {
    registerPair: registerPair,
    removePair: removePair,
    listPairs: listPairs,
    scan: scan,
    computeSpread: computeSpread,
    getHistory: getHistory,
    stats: stats,
    state: state,
    restore: restore,
    reset: reset,
    _internals: { bps: bps, DEFAULTS: DEFAULTS },
  };
}

module.exports = { createCrossMarketScanner: createCrossMarketScanner, DEFAULTS: DEFAULTS };
