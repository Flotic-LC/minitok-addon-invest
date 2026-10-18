"use strict";

/**
 * Market Intelligence Collector — external news & sentiment.
 *
 * Zero-dependency design: uses Node >= 18 global fetch and regex-based
 * XML parsing (no rss-parser, no cheerio, no xml2js).
 *
 * Sources (public, no API key required, English-first for AI analysis):
 *   - CNBC Top News RSS (real-time US finance/economy headlines + descriptions)
 *   - Financial Times Markets RSS (global market analysis)
 *   - Yahoo Finance RSS (S&P 500 top headlines)
 *   - CNN Fear & Greed Index (public JSON endpoint)
 *
 * Emits events to the intelligence event bus:
 *   - marketIntel.news       { source, title, link, publishedAt, keywords }
 *   - marketIntel.sentiment  { source, score, label, raw }
 *
 * Usage:
 *   const { createMarketIntelCollector } = require("./src/intelligence/market-intel");
 *   const collector = createMarketIntelCollector({ eventBus });
 *   collector.start();
 */

const DEFAULTS = Object.freeze({
  tickIntervalMs: Number(process.env.MARKET_INTEL_INTERVAL_MS || 15 * 60 * 1000),
  maxItemsPerSource: Number(process.env.MARKET_INTEL_MAX_ITEMS || 20),
  requestTimeoutMs: Number(process.env.MARKET_INTEL_TIMEOUT_MS || 5000),
  userAgent: "minitok-market-intel/1.0 (+internal)",
  offline: process.env.MARKET_INTEL_OFFLINE === "1" || process.env.MARKET_INTEL_OFFLINE === "true",
  retryCount: Number(process.env.MARKET_INTEL_RETRY_COUNT || 1),
  retryBackoffMs: Number(process.env.MARKET_INTEL_RETRY_BACKOFF_MS || 1000),
  quiet: process.env.MARKET_INTEL_QUIET === "1" || process.env.MARKET_INTEL_QUIET === "true",
});

const KEYWORDS_EN = [
  "S&P 500", "Nasdaq", "Dow", "Fed", "FOMC", "inflation", "CPI", "GDP", "PPI", "PCE",
  "NVIDIA", "Tesla", "Apple", "Microsoft", "semiconductor", "AI", "earnings",
  "recession", "interest rate", "bond yield", "treasury", "oil", "gold", "bitcoin",
  "tariff", "trade", "China", "Japan", "Korea", "Europe",
  "Fed chair", "rate cut", "rate hike", "soft landing", "stagflation",
  "bull market", "bear market", "volatility", "VIX", "risk-off",
];

function _now() { return Date.now(); }

function _sleep(ms) {
  return new Promise(function(resolve) {
    var t = setTimeout(resolve, ms);
    if (t.unref) t.unref();
  });
}

function _safeFetch(url, timeoutMs, ua) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  if (t.unref) t.unref();
  return fetch(url, {
    signal: ctrl.signal,
    headers: {
      "User-Agent": ua,
      "Accept": "application/rss+xml, application/xml, text/xml, */*",
    },
  }).finally(() => clearTimeout(t));
}

async function _fetchWithRetry(url, cfg, label) {
  if (cfg.offline) return { ok: false, error: "offline_mode" };
  var lastErr = null;
  for (var attempt = 0; attempt <= cfg.retryCount; attempt++) {
    try {
      var r = await _safeFetch(url, cfg.requestTimeoutMs, cfg.userAgent);
      if (!r.ok) return { ok: false, error: "HTTP " + r.status };
      return r;
    } catch (e) {
      lastErr = e;
      if (attempt < cfg.retryCount) await _sleep(cfg.retryBackoffMs);
    }
  }
  if (!cfg.quiet) console.log("[market-intel-warn] " + label + " failed after " + (cfg.retryCount + 1) + " attempts: " + (lastErr && lastErr.message || "unknown"));
  return { ok: false, error: lastErr ? lastErr.message : "unknown" };
}

function _stripCdata(s) {
  if (!s) return "";
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/\s+/g, " ").trim();
}

function _extractItems(xml) {
  const items = [];
  const re = /<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/gi;
  let m;
  while ((m = re.exec(xml))) items.push(m[1]);
  return items;
}

function _extractTag(block, tag) {
  const re = new RegExp(
    "<(?:[^:>]+:)?" + tag + "[^>]*>([\\s\\S]*?)</(?:[^:>]+:)?" + tag + ">",
    "i"
  );
  const m = block.match(re);
  if (!m) return "";
  return _stripCdata(m[1]);
}

function _extractLink(block) {
  const plain = _extractTag(block, "link");
  if (plain) return plain;
  const href = block.match(/<link[^>]+href=["']([^"']+)["']/i);
  return href ? href[1] : "";
}

function _matchKeywords(text) {
  const t = (text || "").toLowerCase();
  const hits = [];
  for (const k of KEYWORDS_EN) if (t.includes(k.toLowerCase())) hits.push(k);
  return hits;
}

function _parseRss(xml, source, maxItems) {
  const items = _extractItems(xml).slice(0, maxItems);
  const out = [];
  for (const block of items) {
    const title = _extractTag(block, "title");
    const link = _extractLink(block);
    const desc = _extractTag(block, "description") || _extractTag(block, "summary") || "";
    const pub = _extractTag(block, "pubDate") || _extractTag(block, "published") || _extractTag(block, "updated");
    const combined = (title + " " + desc).trim();
    const keywords = _matchKeywords(combined);
    out.push({
      source,
      title: title.substring(0, 300),
      link,
      description: desc.substring(0, 500),
      publishedAt: pub ? new Date(pub).toISOString() : null,
      publishedTs: pub ? Date.parse(pub) || null : null,
      keywords,
    });
  }
  return out;
}

// ---------- Source fetchers ----------

async function fetchCnbcTop(cfg) {
  const url = "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114";
  try {
    const r = await _fetchWithRetry(url, cfg, "cnbc-top");
    if (!r.ok) return { error: r.error };
    const xml = await r.text();
    return { items: _parseRss(xml, "cnbc-top", cfg.maxItemsPerSource) };
  } catch (e) {
    return { error: e.message };
  }
}

async function fetchYahooFinance(cfg) {
  const url = "https://feeds.finance.yahoo.com/rss/2.0/headline?s=^GSPC&region=US&lang=en-US";
  try {
    const r = await _fetchWithRetry(url, cfg, "yahoo-finance");
    if (!r.ok) return { error: r.error };
    const xml = await r.text();
    return { items: _parseRss(xml, "yahoo-finance", cfg.maxItemsPerSource) };
  } catch (e) {
    return { error: e.message };
  }
}

async function fetchFtMarkets(cfg) {
  const url = "https://www.ft.com/markets?format=rss";
  try {
    const r = await _fetchWithRetry(url, cfg, "ft-markets");
    if (!r.ok) return { error: r.error };
    const xml = await r.text();
    return { items: _parseRss(xml, "ft-markets", cfg.maxItemsPerSource) };
  } catch (e) {
    return { error: e.message };
  }
}

async function fetchFearGreed(cfg) {
  const url = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata";
  try {
    const r = await _fetchWithRetry(url, cfg, "cnn-fear-greed");
    if (!r.ok) return { error: r.error };
    const data = await r.json();
    const fg = (data && data.fear_and_greed) || (data && data.score) || null;
    if (!fg) return { error: "no payload" };
    const score = typeof fg === "object" ? (fg.score || fg.value || null) : fg;
    const label = (fg && (fg.rating || fg.label)) || "";
    return { score: Number(score), label: String(label) };
  } catch (e) {
    return { error: e.message };
  }
}

// ---------- Collector ----------

function createMarketIntelCollector(options) {
  const cfg = { ...DEFAULTS, ...(options || {}) };
  const eventBus = cfg.eventBus || null;
  const eventStore = cfg.eventStore || null;

  const state = {
    running: false,
    lastTickAt: 0,
    lastSuccessAt: 0,
    ticks: 0,
    successCount: 0,
    errorCount: 0,
    errorsBySource: {},
    lastItems: [],
    recentHistory: [],
    lastFearGreed: null,
  };

  const seen = new Set();
  const MAX_HISTORY = 200;
  let timer = null;

  function _emit(type, data) {
    if (!eventBus) return;
    try { eventBus.emit(type, data); } catch (_) {}
  }

  async function _collectOnce() {
    const startedAt = _now();
    state.lastTickAt = startedAt;
    state.ticks++;

    if (cfg.offline) {
      return {
        tickAt: startedAt,
        itemsCollected: 0,
        historySize: state.recentHistory.length,
        sources: { "cnbc-top": { ok: false, error: "offline" }, "ft-markets": { ok: false, error: "offline" }, "yahoo-finance": { ok: false, error: "offline" }, "cnn-fear-greed": { ok: false, error: "offline" } },
        fearGreed: state.lastFearGreed,
        durationMs: _now() - startedAt,
        offline: true,
      };
    }

    const results = await Promise.allSettled([
      fetchCnbcTop(cfg),
      fetchFtMarkets(cfg),
      fetchYahooFinance(cfg),
      fetchFearGreed(cfg),
    ]);

    const newsResults = results.slice(0, 3);
    const fgResult = results[3];
    const merged = [];
    const sourceStats = {};
    let anySuccess = false;
    const sources = ["cnbc-top", "ft-markets", "yahoo-finance"];

    newsResults.forEach(function(r, i) {
      const src = sources[i];
      if (r.status === "fulfilled" && r.value && Array.isArray(r.value.items)) {
        anySuccess = true;
        sourceStats[src] = { ok: true, count: r.value.items.length };
        for (const it of r.value.items) {
          merged.push(it);
          if (!seen.has(it.link)) {
            seen.add(it.link);
            state.recentHistory.push(it);
            _emit("marketIntel.news", it);
          }
        }
      } else {
        const err = (r.status === "fulfilled" ? (r.value && r.value.error) : r.reason && r.reason.message) || "unknown";
        sourceStats[src] = { ok: false, error: String(err).substring(0, 200) };
        state.errorsBySource[src] = (state.errorsBySource[src] || 0) + 1;
      }
    });

    while (state.recentHistory.length > MAX_HISTORY) state.recentHistory.shift();
    if (seen.size > MAX_HISTORY * 3) {
      const arr = Array.from(seen);
      for (let i = 0; i < arr.length - MAX_HISTORY; i++) seen.delete(arr[i]);
    }
    state.lastItems = merged;

    if (fgResult.status === "fulfilled" && fgResult.value && typeof fgResult.value.score === "number") {
      state.lastFearGreed = {
        score: fgResult.value.score,
        label: fgResult.value.label,
        at: new Date(startedAt).toISOString(),
      };
      _emit("marketIntel.sentiment", {
        source: "cnn-fear-greed",
        score: fgResult.value.score,
        label: fgResult.value.label,
        ts: startedAt,
      });
      anySuccess = true;
    } else if (fgResult.status === "fulfilled" && fgResult.value && fgResult.value.error) {
      state.errorsBySource["cnn-fear-greed"] = (state.errorsBySource["cnn-fear-greed"] || 0) + 1;
    }

    if (anySuccess) {
      state.successCount++;
      state.lastSuccessAt = _now();
    } else {
      state.errorCount++;
    }

    // [FIX] Persist collected market intel to event store (survives restarts)
    if (eventStore && typeof eventStore.append === "function") {
      try {
        eventStore.append("MARKET_INTEL", {
          itemsCollected: merged.length,
          sources: sourceStats,
          fearGreed: state.lastFearGreed,
          ts: new Date(startedAt).toISOString(),
        });
      } catch (e) { /* best-effort */ }
    }

    return {
      tickAt: startedAt,
      itemsCollected: merged.length,
      historySize: state.recentHistory.length,
      sources: sourceStats,
      fearGreed: state.lastFearGreed,
      durationMs: _now() - startedAt,
    };
  }

  async function tick() {
    try { return await _collectOnce(); }
    catch (e) { state.errorCount++; return { error: e.message }; }
  }

  function start() {
    if (state.running) return;
    state.running = true;
    tick().catch(function(){});
    timer = setInterval(function() { tick().catch(function(){}); }, cfg.tickIntervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    state.running = false;
    if (timer) { clearInterval(timer); timer = null; }
  }

  function latestNews(opts) {
    if (typeof opts === "number") opts = { limit: opts };
    opts = opts || {};
    const limit = Math.min(50, Math.max(1, opts.limit || 10));
    const source = opts.source || null;
    const keyword = (opts.keyword || "").toLowerCase();
    let list = state.recentHistory.slice();
    if (source) list = list.filter(function(i) { return i.source === source; });
    if (keyword) {
      list = list.filter(function(i) {
        return (i.title + " " + i.description + " " + (i.keywords || []).join(" ")).toLowerCase().includes(keyword);
      });
    }
    list.sort(function(a, b) { return (b.publishedTs || 0) - (a.publishedTs || 0); });
    return list.slice(0, limit);
  }

  function sentiment() { return state.lastFearGreed; }

  function stats() {
    return {
      running: state.running,
      tickIntervalMs: cfg.tickIntervalMs,
      ticks: state.ticks,
      successCount: state.successCount,
      errorCount: state.errorCount,
      lastTickAt: state.lastTickAt ? new Date(state.lastTickAt).toISOString() : null,
      lastSuccessAt: state.lastSuccessAt ? new Date(state.lastSuccessAt).toISOString() : null,
      historySize: state.recentHistory.length,
      errorsBySource: { ...state.errorsBySource },
      fearGreed: state.lastFearGreed,
    };
  }

  function sources() {
    return [
      { id: "cnbc-top", label: "CNBC Top News (US finance/economy)", kind: "rss" },
      { id: "ft-markets", label: "Financial Times Markets (global)", kind: "rss" },
      { id: "yahoo-finance", label: "Yahoo Finance S&P 500 Headlines", kind: "rss" },
      { id: "cnn-fear-greed", label: "CNN Fear & Greed Index", kind: "json" },
    ];
  }

  return {
    start, stop, tick,
    latestNews, sentiment, stats, sources,
  };
}

module.exports = {
  createMarketIntelCollector,
  DEFAULTS,
  KEYWORDS_EN,
};

