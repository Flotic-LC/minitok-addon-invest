"use strict";
// Suppress stderr from pipeline during tests (PowerShell treats stderr as failure)
process.env.INTEL_QUIET = "1";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createIntelligencePipeline, REGIMES } = require("../src/intelligence/pipeline");

function mockFetch(responses) {
  const calls = [];
  async function impl(url) {
    calls.push(url);
    const key = Object.keys(responses).find(k => url.includes(k));
    if (key && responses[key]) return { ok: true, json: async () => responses[key] };
    return { ok: false, status: 404, text: async () => "not found" };
  }
  impl.calls = calls;
  return impl;
}

test("pipeline returns disabled when no fetchImpl", () => {
  const p = createIntelligencePipeline({ fetchImpl: null });
  assert.equal(p.stats().enabled, false);
});

test("gather returns null news/macro when no API keys", async () => {
  const p = createIntelligencePipeline({ fetchImpl: mockFetch({}), newsApiKey: "", fredApiKey: "" });
  const r = await p.gather("005930");
  assert.equal(r.symbol, "005930");
  assert.equal(r.news, null);
  assert.equal(r.macro, null);
  assert.equal(r.sentiment, null);
});

test("fetchNews retrieves and caches articles", async () => {
  const articles = [
    { title: "Samsung profit surge", description: "Record earnings", source: { name: "Reuters" }, publishedAt: "2026-10-11" },
    { title: "Chip demand growth", description: "AI rally drives demand", source: { name: "Bloomberg" }, publishedAt: "2026-10-10" },
  ];
  const p = createIntelligencePipeline({ fetchImpl: mockFetch({ "newsapi.org": { articles } }), newsApiKey: "k", fredApiKey: "" });
  const r1 = await p.gather("005930");
  assert.equal(r1.news.count, 2);
  assert.equal(r1.news.topHeadlines[0], "Samsung profit surge");
  const r2 = await p.gather("005930");
  assert.equal(r2.news.count, 2);
  assert.equal(p.stats().newsHits, 1);
  assert.equal(p.stats().newsMisses, 1);
});

test("fetchMacro retrieves FRED indicators", async () => {
  const fetchImpl = mockFetch({
    "series_id=DFF": { observations: [{ value: "5.25", date: "2026-10-01" }] },
    "series_id=UNRATE": { observations: [{ value: "3.7", date: "2026-10-01" }] },
    "series_id=CPIAUCSL": { observations: [{ value: "312.5", date: "2026-10-01" }] },
    "series_id=VIXCLS": { observations: [{ value: "14.2", date: "2026-10-01" }] },
  });
  const p = createIntelligencePipeline({ fetchImpl, newsApiKey: "", fredApiKey: "k" });
  const r = await p.gather("AAPL");
  assert.ok(r.macro);
  assert.equal(r.macro.fedFundsRate, 5.25);
  assert.equal(r.macro.unemployment, 3.7);
  assert.equal(r.macro.vix, 14.2);
  assert.equal(r.macro.regime, "tightening");
});

test("sentiment derives bull/bear from news text", async () => {
  const articles = [
    { title: "Stock surge rally record", description: "Growth profit bullish buy upgrade", source: { name: "X" } },
    { title: "Market crash drop", description: "Loss decline warning", source: { name: "Y" } },
  ];
  const p = createIntelligencePipeline({ fetchImpl: mockFetch({ "newsapi.org": { articles } }), newsApiKey: "k", fredApiKey: "" });
  const r = await p.gather("TEST");
  assert.ok(r.sentiment);
  assert.ok(r.sentiment.bullCount > r.sentiment.bearCount);
  assert.equal(r.sentiment.label, "bullish");
});

test("classifyRegime returns crisis for VIX > 30", async () => {
  const fetchImpl = mockFetch({
    "series_id=VIXCLS": { observations: [{ value: "35.0", date: "2026-10-01" }] },
    "series_id=DFF": { observations: [{ value: "2.0", date: "2026-10-01" }] },
    "series_id=UNRATE": { observations: [{ value: "4.0", date: "2026-10-01" }] },
    "series_id=CPIAUCSL": { observations: [{ value: "300", date: "2026-10-01" }] },
  });
  const p = createIntelligencePipeline({ fetchImpl, newsApiKey: "", fredApiKey: "k" });
  const r = await p.gather("SPY");
  assert.equal(r.macro.regime, "crisis");
});

test("classifyRegime returns expansion for low unemp + low VIX", async () => {
  const fetchImpl = mockFetch({
    "series_id=VIXCLS": { observations: [{ value: "12.0", date: "2026-10-01" }] },
    "series_id=DFF": { observations: [{ value: "3.0", date: "2026-10-01" }] },
    "series_id=UNRATE": { observations: [{ value: "3.5", date: "2026-10-01" }] },
    "series_id=CPIAUCSL": { observations: [{ value: "300", date: "2026-10-01" }] },
  });
  const p = createIntelligencePipeline({ fetchImpl, newsApiKey: "", fredApiKey: "k" });
  const r = await p.gather("SPY");
  assert.equal(r.macro.regime, "expansion");
});

test("summarizeNews calls LLM when provided", async () => {
  const articles = [
    { title: "Earnings beat", description: "Strong quarter", source: { name: "Reuters" } },
  ];
  let llmCalled = false;
  const callLLM = async () => { llmCalled = true; return { summary: "Strong earnings" }; };
  const p = createIntelligencePipeline({ fetchImpl: mockFetch({ "newsapi.org": { articles } }), newsApiKey: "k", fredApiKey: "" });
  const r = await p.gather("AAPL", callLLM);
  assert.equal(llmCalled, true);
  assert.equal(r.news.summary, "Strong earnings");
});

test("cache respects TTL", async () => {
  let now = 1000000;
  const articles = [{ title: "News", description: "", source: { name: "X" } }];
  const p = createIntelligencePipeline({ fetchImpl: mockFetch({ "newsapi.org": { articles } }), newsApiKey: "k", fredApiKey: "", cacheTtlMs: 1000, now: () => now });
  await p.gather("SYM");
  assert.equal(p.stats().newsMisses, 1);
  now += 500;
  await p.gather("SYM");
  assert.equal(p.stats().newsHits, 1);
  now += 2000;
  await p.gather("SYM");
  assert.equal(p.stats().newsMisses, 2);
});

test("clearCache empties all cached data", async () => {
  const articles = [{ title: "T", description: "D", source: { name: "S" } }];
  const p = createIntelligencePipeline({ fetchImpl: mockFetch({ "newsapi.org": { articles } }), newsApiKey: "k", fredApiKey: "" });
  await p.gather("SYM");
  assert.ok(p.stats().cacheSize >= 1);
  p.clearCache();
  assert.equal(p.stats().cacheSize, 0);
});

test("REGIMES exports all expected values", () => {
  assert.equal(REGIMES.TIGHTENING, "tightening");
  assert.equal(REGIMES.EASING, "easing");
  assert.equal(REGIMES.EXPANSION, "expansion");
  assert.equal(REGIMES.CONTRACTION, "contraction");
  assert.equal(REGIMES.CRISIS, "crisis");
  assert.equal(REGIMES.NEUTRAL, "neutral");
});

test("gather includes gatherMs timing", async () => {
  const p = createIntelligencePipeline({ fetchImpl: mockFetch({}), newsApiKey: "", fredApiKey: "" });
  const r = await p.gather("SYM");
  assert.ok(typeof r.gatherMs === "number");
  assert.ok(r.gatherMs >= 0);
});

test("fetch failure does not throw", async () => {
  const fetchImpl = async () => { throw new Error("network down"); };
  const p = createIntelligencePipeline({ fetchImpl, newsApiKey: "k", fredApiKey: "k" });
  const r = await p.gather("SYM");
  assert.equal(r.news, null);
  assert.equal(r.macro, null);
  assert.ok(p.stats().errors > 0);
});
