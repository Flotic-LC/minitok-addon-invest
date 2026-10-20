"use strict";

/**
 * Intelligence Pipeline — gathers external information for AI decision-making.
 *
 * Sources:
 *   1. News: NewsAPI.org (headlines + descriptions)
 *   2. Macro: FRED — fed funds rate, unemployment, CPI, VIX
 *   3. Sentiment: keyword-derived bull/bear ratio from news text
 *
 * All fetches are best-effort with timeouts. Failures degrade gracefully.
 *
 * Usage:
 *   const { createIntelligencePipeline } = require("./src/intelligence/pipeline");
 *   const intel = createIntelligencePipeline({ newsApiKey, fredApiKey });
 *   const data = await intel.gather("005930", callLLM);
 */

const DEFAULTS = Object.freeze({
  newsApiKey: process.env.INTEL_NEWS_API_KEY || "",
  fredApiKey: process.env.INTEL_FRED_API_KEY || "",
  fetchTimeoutMs: Number(process.env.INTEL_FETCH_TIMEOUT_MS || 5000),
  maxNewsArticles: Number(process.env.INTEL_MAX_NEWS || 10),
  maxSummaryLines: Number(process.env.INTEL_MAX_SUMMARY_LINES || 3),
  cacheTtlMs: Number(process.env.INTEL_CACHE_TTL_MS || 300000),
  fetchImpl: typeof fetch !== "undefined" ? fetch : null,
  now: () => Date.now(),
  quiet: process.env.INTEL_QUIET === "1" || process.env.INTEL_QUIET === "true",
});

const REGIMES = Object.freeze({
  TIGHTENING: "tightening",
  EASING: "easing",
  EXPANSION: "expansion",
  CONTRACTION: "contraction",
  CRISIS: "crisis",
  NEUTRAL: "neutral",
});

const BULLISH_KW = ["surge", "rally", "beat", "upgrade", "record", "growth", "profit", "bullish", "buy"];
const BEARISH_KW = ["crash", "drop", "miss", "downgrade", "loss", "decline", "bearish", "sell", "warning", "risk"];

function createIntelligencePipeline(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  if (!cfg.fetchImpl) {
    return {
      gather: async () => null,
      stats: () => ({ enabled: false, reason: "no fetch" }),
      clearCache: () => {},
      REGIMES,
    };
  }

  const cache = new Map();
  const counters = {
    newsHits: 0, newsMisses: 0,
    macroHits: 0, macroMisses: 0,
    sentimentHits: 0, sentimentMisses: 0,
    llmSummaries: 0, errors: 0,
  };

  function getCached(key) {
    const entry = cache.get(key);
    if (entry && cfg.now() < entry.expiresAt) return entry.data;
    cache.delete(key);
    return null;
  }

  function setCache(key, data) {
    cache.set(key, { data, expiresAt: cfg.now() + cfg.cacheTtlMs });
  }

  async function fetchWithTimeout(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.fetchTimeoutMs);
    if (timer.unref) timer.unref();
    try {
      const resp = await cfg.fetchImpl(url, { signal: ctrl.signal });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      return await resp.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchNews(symbol) {
    if (!cfg.newsApiKey) return null;
    const cacheKey = "news:" + symbol;
    const cached = getCached(cacheKey);
    if (cached) { counters.newsHits++; return cached; }
    counters.newsMisses++;
    try {
      const q = encodeURIComponent(symbol);
      const url = "https://newsapi.org/v2/everything?q=" + q + "&sortBy=publishedAt&pageSize=" + cfg.maxNewsArticles + "&apiKey=" + cfg.newsApiKey;
      const data = await fetchWithTimeout(url);
      const articles = Array.isArray(data.articles) ? data.articles : [];
      const result = articles.map(a => ({
        title: a.title || "", description: a.description || "",
        source: (a.source && a.source.name) || "", publishedAt: a.publishedAt || "",
      }));
      setCache(cacheKey, result);
      return result;
    } catch (e) {
      counters.errors++;
      if (!cfg.quiet) console.log("[intel-warn] news fetch failed for " + symbol + ": " + (e.message || e));
      return null;
    }
  }

  async function fetchMacro() {
    if (!cfg.fredApiKey) return null;
    const cacheKey = "macro:latest";
    const cached = getCached(cacheKey);
    if (cached) { counters.macroHits++; return cached; }
    counters.macroMisses++;
    const series = [
      { id: "DFF", name: "fedFundsRate" }, { id: "UNRATE", name: "unemployment" },
      { id: "CPIAUCSL", name: "cpi" }, { id: "VIXCLS", name: "vix" },
    ];
    const result = {};
    try {
      for (const s of series) {
        try {
          const url = "https://api.stlouisfed.org/fred/series/observations?series_id=" + s.id + "&sort_order=desc&limit=1&api_key=" + cfg.fredApiKey + "&file_type=json";
          const data = await fetchWithTimeout(url);
          const obs = data.observations && data.observations[0];
          if (obs && obs.value !== ".") {
            result[s.name] = Number(obs.value);
            result[s.name + "Date"] = obs.date;
          }
        } catch { /* skip */ }
      }
      if (Object.keys(result).length === 0) return null;
      setCache(cacheKey, result);
      return result;
    } catch (e) {
      counters.errors++;
      if (!cfg.quiet) console.log("[intel-warn] macro fetch failed: " + (e.message || e));
      return null;
    }
  }

  function deriveSentiment(news) {
    if (!news || news.length === 0) return null;
    let bullCount = 0, bearCount = 0;
    for (const a of news) {
      const t = ((a.title || "") + " " + (a.description || "")).toLowerCase();
      for (const kw of BULLISH_KW) if (t.includes(kw)) bullCount++;
      for (const kw of BEARISH_KW) if (t.includes(kw)) bearCount++;
    }
    const total = bullCount + bearCount;
    if (total === 0) return null;
    return {
      bullCount, bearCount,
      bullBearRatio: Number(((bullCount - bearCount) / total).toFixed(2)),
      label: bullCount > bearCount ? "bullish" : (bearCount > bullCount ? "bearish" : "neutral"),
    };
  }

  async function fetchSentiment(symbol, news) {
    const cacheKey = "sentiment:" + symbol;
    const cached = getCached(cacheKey);
    if (cached) { counters.sentimentHits++; return cached; }
    counters.sentimentMisses++;
    const result = deriveSentiment(news);
    if (result) setCache(cacheKey, result);
    return result;
  }

  function classifyRegime(macro) {
    if (!macro || Object.keys(macro).length === 0) return REGIMES.NEUTRAL;
    const vix = macro.vix || 0, fedRate = macro.fedFundsRate || 0, unemp = macro.unemployment || 0;
    if (vix > 30) return REGIMES.CRISIS;
    if (vix > 25 && unemp > 5) return REGIMES.CONTRACTION;
    if (fedRate > 4 && unemp < 4) return REGIMES.TIGHTENING;
    if (fedRate < 2 && unemp > 5) return REGIMES.EASING;
    if (unemp < 4 && vix < 20) return REGIMES.EXPANSION;
    return REGIMES.NEUTRAL;
  }

  async function summarizeNews(news, callLLM) {
    if (!news || news.length === 0 || !callLLM) return null;
    counters.llmSummaries++;
    try {
      const headlines = news.slice(0, 5).map(a => "- " + a.title + " (" + a.source + ")").join("\n");
      const messages = [
        { role: "system", content: "You are a financial news analyst. Summarize in " + cfg.maxSummaryLines + " bullets focusing on market impact." },
        { role: "user", content: "Headlines:\n" + headlines },
      ];
      const r = await callLLM(messages);
      if (r && typeof r === "object" && r.summary) return r.summary;
      if (typeof r === "string") return r;
      return null;
    } catch (e) { counters.errors++; return null; }
  }

  async function gather(symbol, callLLM) {
    const t0 = cfg.now();
    const [news, macro] = await Promise.all([fetchNews(symbol), fetchMacro()]);
    const sentiment = await fetchSentiment(symbol, news);
    const regime = classifyRegime(macro);
    // Opt-out gate: summarisation runs whenever an LLM is supplied, but
    // INTEL_SUMMARY_ENABLED=false disables it (it costs one extra LLM call per
    // symbol per decision cycle).
    const summary = (callLLM && process.env.INTEL_SUMMARY_ENABLED !== "false") ? await summarizeNews(news, callLLM) : null;
    return {
      symbol,
      news: news ? { count: news.length, summary, topHeadlines: news.slice(0, 3).map(a => a.title) } : null,
      macro: macro ? { regime, fedFundsRate: macro.fedFundsRate, unemployment: macro.unemployment, vix: macro.vix, cpi: macro.cpi } : null,
      sentiment,
      gatherMs: cfg.now() - t0,
    };
  }

  function stats() {
    return {
      enabled: true,
      newsApiKeyConfigured: !!cfg.newsApiKey,
      fredApiKeyConfigured: !!cfg.fredApiKey,
      cacheSize: cache.size,
      ...counters,
    };
  }

  function clearCache() { cache.clear(); }

  return { gather, stats, clearCache, REGIMES };
}

module.exports = { createIntelligencePipeline, REGIMES };
