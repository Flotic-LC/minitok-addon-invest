"use strict";

/**
 * Web Tools for AI Function-Calling (P-WebTools)
 *
 * Provides the AI model with two tools to retrieve live information:
 *   - web_search(query, [limit])  — Brave Search API (primary) or DuckDuckGo HTML fallback
 *   - web_fetch(url)              — fetch arbitrary URL and extract readable plaintext
 *
 * Design goals:
 *   - Zero-config fallback: works without API keys via DuckDuckGo HTML scraping
 *   - Strict resource bounds: timeouts, size caps, concurrency guard
 *   - OpenAI function-calling compatible schemas (tools[] array)
 *   - Best-effort: all handlers resolve; errors returned as tool_result content
 *
 * Usage:
 *   const { createWebTools, WEB_TOOL_SCHEMAS } = require("./src/agent/web-tools");
 *   const webTools = createWebTools({ braveApiKey, fetchImpl });
 *   const result = await webTools.handle("web_search", { query: "Fed rate decision" });
 */

const DEFAULTS = Object.freeze({
  braveApiKey: process.env.BRAVE_SEARCH_API_KEY || "",
  fetchTimeoutMs: Number(process.env.WEB_FETCH_TIMEOUT_MS || 10000),
  maxFetchBytes: Number(process.env.WEB_FETCH_MAX_BYTES || 200000),
  maxResultChars: Number(process.env.WEB_RESULT_MAX_CHARS || 12000),
  searchLimit: Number(process.env.WEB_SEARCH_LIMIT || 5),
  userAgent: process.env.WEB_USER_AGENT || "MinitokBot/1.0 (+https://minitok.ai; research)",
  browserUserAgent: process.env.WEB_BROWSER_UA ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  fetchImpl: typeof fetch !== "undefined" ? fetch : null,
  now: () => Date.now(),
});

// --- OpenAI function-calling tool schemas ---
const WEB_TOOL_SCHEMAS = Object.freeze([
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for recent information. Returns titles, snippets, and URLs. Use for breaking news, market-moving events, company announcements, or macro data you have not yet seen.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query in English (e.g., 'Fed rate decision October 2026', 'NVDA earnings Q3').", minLength: 2, maxLength: 300 },
          limit: { type: "integer", description: "Maximum results to return (default 5, max 10).", minimum: 1, maximum: 10 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch a specific URL and extract its readable text content. Use when you have a URL (from web_search or otherwise) and need the full article or data. Returns up to 12000 characters of cleaned plaintext.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute http(s) URL to fetch.", minLength: 8, maxLength: 2000 },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
]);

// --- Native HTTPS fetch for DDG (fetch API sometimes blocked) ---
function ddgNativeFetch(query, timeoutMs, userAgent) {
  return new Promise((resolve, reject) => {
    let https;
    try { https = require("https"); } catch { return reject(new Error("no https module")); }
    const qs = require("querystring");
    const postData = qs.stringify({ q: query, b: "", kl: "" });
    const req = https.request({
      hostname: "html.duckduckgo.com",
      port: 443,
      path: "/html/",
      method: "POST",
      timeout: timeoutMs,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(postData),
        "User-Agent": userAgent,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://html.duckduckgo.com/",
      },
    }, (r) => {
      let body = "";
      r.on("data", (c) => (body += c));
      r.on("end", () => resolve({ status: r.statusCode, body }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("DDG native timeout")); });
    req.write(postData);
    req.end();
  });
}

// --- Decode search-engine redirect URLs to the real target ---
function unwrapSearchUrl(url) {
  if (!url || typeof url !== "string") return url;
  // Strip HTML entities first (Bing HTML escapes & as &amp; which breaks param parsing)
  url = url.replace(/&amp;/gi, "&")
           .replace(/&lt;/gi, "<")
           .replace(/&gt;/gi, ">")
           .replace(/&quot;/gi, '"')
           .replace(/&#0?39;/g, "'")
           .replace(/&apos;/g, "'")
           .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
           .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
  // Bing: https://www.bing.com/ck/a?!...&u=a1<base64url>&ntb=1
  // The 'u' param is base64url where "a1" prefix is stripped
  const bingM = /[?&]u=([^&]+)/.exec(url);
  if (bingM && /bing\.com\/ck\/a/.test(url)) {
    try {
      let b64 = decodeURIComponent(bingM[1]);
      if (b64.startsWith("a1")) b64 = b64.slice(2);
      // base64url -> base64
      b64 = b64.replace(/-/g, "+").replace(/_/g, "/");
      while (b64.length % 4) b64 += "=";
      const decoded = Buffer.from(b64, "base64").toString("utf8");
      if (/^https?:\/\//i.test(decoded)) return decoded;
    } catch {}
  }
  // DDG: uddg=<urlencoded>
  if (url.includes("uddg=")) {
    try { return decodeURIComponent(url.split("uddg=")[1].split("&")[0]); } catch {}
  }
  return url;
}

// --- HTML text extraction (no heavy deps) ---
function stripHtml(html) {
  if (!html) return "";
  let s = String(html);
  s = s.replace(/<!--[\s\S]*?-->/gi, " ");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<nav[\s\S]*?<\/nav>/gi, " ");
  s = s.replace(/<footer[\s\S]*?<\/footer>/gi, " ");
  s = s.replace(/<header[\s\S]*?<\/header>/gi, " ");
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/&nbsp;/gi, " ")
       .replace(/&amp;/gi, "&")
       .replace(/&lt;/gi, "<")
       .replace(/&gt;/gi, ">")
       .replace(/&quot;/gi, '"')
       .replace(/&#39;/g, "'")
       .replace(/&apos;/g, "'");
  s = s.replace(/[ \t\f]+/g, " ");
  s = s.replace(/\n[ \t]+/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function truncate(s, max) {
  if (!s) return "";
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n...[truncated at " + max + " chars]";
}


// --- DuckDuckGo HTML fallback (POST form data — GET returns 202 homepage) ---
async function searchDuckDuckGo(query, limit, cfg) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.fetchTimeoutMs);
  if (timer.unref) timer.unref();
  try {
    // DDG /html/ endpoint requires POST with urlencoded form body
    const resp = await cfg.fetchImpl("https://html.duckduckgo.com/html/", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": cfg.browserUserAgent,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://html.duckduckgo.com/",
      },
      body: "q=" + encodeURIComponent(query) + "&b=&kl=",
      redirect: "follow",
    });
    if (!resp.ok) throw new Error("DDG HTTP " + resp.status);
    let html = await resp.text();
    // If fetch returned empty/blocked, try native https as fallback
    if (html.length < 500) {
      try {
        const nr = await ddgNativeFetch(query, cfg.fetchTimeoutMs, cfg.browserUserAgent);
        if (nr.status >= 200 && nr.status < 300 && nr.body.length > 500) {
          html = nr.body;
        }
      } catch {}
    }
    if (html.length < 500) throw new Error("DDG empty/blocked response (" + html.length + "b)");

    // Parse result__a links (title + URL) and result__snippet (summary)
    // Use multiple patterns to handle DDG HTML structure variations
    const reA = /<a[^>]+rel="nofollow"[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const reA2 = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const reA3 = /<a[^>]+class="result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const reA4 = /<a[^>]+href="([^"]+)"[^>]+class="result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    const reSnip = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    const titles = [];
    const snippets = [];
    let m;
    while ((m = reA.exec(html)) !== null) {
      titles.push({ url: m[1], title: stripHtml(m[2]).replace(/\s+/g, " ").trim() });
    }
    if (titles.length === 0) {
      while ((m = reA2.exec(html)) !== null) {
        titles.push({ url: m[1], title: stripHtml(m[2]).replace(/\s+/g, " ").trim() });
      }
    }
    if (titles.length === 0) {
      while ((m = reA3.exec(html)) !== null) {
        titles.push({ url: m[1], title: stripHtml(m[2]).replace(/\s+/g, " ").trim() });
      }
    }
    if (titles.length === 0) {
      while ((m = reA4.exec(html)) !== null) {
        titles.push({ url: m[1], title: stripHtml(m[2]).replace(/\s+/g, " ").trim() });
      }
    }
    while ((m = reSnip.exec(html)) !== null) {
      snippets.push(stripHtml(m[1]).replace(/\s+/g, " ").trim());
    }
    const results = [];
    for (let i = 0; i < Math.min(titles.length, limit); i++) {
      const u = unwrapSearchUrl(titles[i].url);
      results.push({ title: titles[i].title, url: u, snippet: snippets[i] || "" });
    }
    // If fetch API returned HTML but no results parsed (homepage/captcha),
    // retry with native https which has different TLS fingerprint
    if (results.length === 0) {
      try {
        const nr = await ddgNativeFetch(query, cfg.fetchTimeoutMs, cfg.browserUserAgent);
        if (nr.status >= 200 && nr.status < 300 && nr.body.length > 500) {
          const nHtml = nr.body;
          const nTitles = [];
          const nSnippets = [];
          let nm;
          const nReA = /<a[^>]+rel="nofollow"[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
          const nReA2 = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
          const nReSnip = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
          while ((nm = nReA.exec(nHtml)) !== null) {
            nTitles.push({ url: nm[1], title: stripHtml(nm[2]).replace(/\s+/g, " ").trim() });
          }
          if (nTitles.length === 0) {
            while ((nm = nReA2.exec(nHtml)) !== null) {
              nTitles.push({ url: nm[1], title: stripHtml(nm[2]).replace(/\s+/g, " ").trim() });
            }
          }
          while ((nm = nReSnip.exec(nHtml)) !== null) {
            nSnippets.push(stripHtml(nm[1]).replace(/\s+/g, " ").trim());
          }
          for (let i = 0; i < Math.min(nTitles.length, limit); i++) {
            const u2 = unwrapSearchUrl(nTitles[i].url);
            results.push({ title: nTitles[i].title, url: u2, snippet: nSnippets[i] || "" });
          }
        }
      } catch {}
    }
    return results;
  } finally {
    clearTimeout(timer);
  }
}

// --- Bing search scrape fallback ---
async function searchBing(query, limit, cfg) {
  const url = "https://www.bing.com/search?q=" + encodeURIComponent(query) +
    "&count=" + Math.min(limit, 10) + "&setlang=en";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.fetchTimeoutMs);
  if (timer.unref) timer.unref();
  try {
    const resp = await cfg.fetchImpl(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": cfg.browserUserAgent,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
    if (!resp.ok) throw new Error("Bing HTTP " + resp.status);
    const html = await resp.text();
    // Bing wraps each result in <li class="b_algo">
    const reBlock = /<li[^>]+class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
    const reA = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
    const reSnip = /<(p|div)[^>]+class="[^"]*b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i;
    const reSnip2 = /<p[^>]*>([\s\S]*?)<\/p>/i;
    const results = [];
    let m;
    while ((m = reBlock.exec(html)) !== null && results.length < limit) {
      const block = m[1];
      const aM = reA.exec(block);
      if (!aM) continue;
      const u = unwrapSearchUrl(aM[1]);
      const title = stripHtml(aM[2]).replace(/\s+/g, " ").trim();
      let snippet = "";
      const sM = reSnip.exec(block) || reSnip2.exec(block);
      if (sM) snippet = stripHtml(sM[sM.length - 1]).replace(/\s+/g, " ").trim();
      if (!title) continue;
      results.push({ title, url: u, snippet });
    }
    return results;
  } finally {
    clearTimeout(timer);
  }
}

// --- Wikipedia opensearch (factual / entity queries — final fallback) ---
async function searchWikipedia(query, limit, cfg) {
  const url = "https://en.wikipedia.org/w/api.php?action=opensearch" +
    "&search=" + encodeURIComponent(query) +
    "&limit=" + Math.min(limit, 5) +
    "&namespace=0&format=json";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.fetchTimeoutMs);
  if (timer.unref) timer.unref();
  try {
    const resp = await cfg.fetchImpl(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": cfg.userAgent,
        Accept: "application/json",
      },
    });
    if (!resp.ok) throw new Error("Wiki HTTP " + resp.status);
    const data = await resp.json();
    // opensearch format: [query, [titles], [descriptions], [urls]]
    if (!Array.isArray(data) || data.length < 4) return [];
    const titles = data[1] || [];
    const descs = data[2] || [];
    const urls = data[3] || [];
    const results = [];
    for (let i = 0; i < Math.min(titles.length, limit); i++) {
      results.push({
        title: titles[i] || "",
        url: urls[i] || "",
        snippet: descs[i] || "",
      });
    }
    return results;
  } finally {
    clearTimeout(timer);
  }
}

// --- Google News RSS (reliable, no bot blocking, great for financial/news queries) ---
async function searchGoogleNewsRSS(query, limit, cfg) {
  const url = "https://news.google.com/rss/search?q=" +
    encodeURIComponent(query) +
    "&hl=en-US&gl=US&ceid=US:en";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.fetchTimeoutMs);
  if (timer.unref) timer.unref();
  try {
    const resp = await cfg.fetchImpl(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": cfg.userAgent,
        Accept: "application/rss+xml, application/xml, text/xml",
      },
      redirect: "follow",
    });
    if (!resp.ok) throw new Error("GNews HTTP " + resp.status);
    const xml = await resp.text();
    if (xml.length < 200) throw new Error("GNews empty response");
    // Parse RSS <item> elements
    const reItem = /<item>([\s\S]*?)<\/item>/gi;
    const reTitle = /<title>([\s\S]*?)<\/title>/i;
    const reLink = /<link>([\s\S]*?)<\/link>/i;
    const reDesc = /<description>([\s\S]*?)<\/description>/i;
    const results = [];
    let m;
    while ((m = reItem.exec(xml)) !== null && results.length < limit) {
      const block = m[1];
      const tM = reTitle.exec(block);
      const lM = reLink.exec(block);
      const dM = reDesc.exec(block);
      if (!tM || !lM) continue;
      const title = stripHtml(tM[1]).replace(/\s+/g, " ").trim();
      const link = stripHtml(lM[1]).trim();
      const snippet = dM ? stripHtml(dM[1]).replace(/\s+/g, " ").trim() : "";
      if (!title || !link) continue;
      results.push({ title, url: link, snippet });
    }
    return results;
  } finally {
    clearTimeout(timer);
  }
}

// --- Brave Search API ---
async function searchBrave(query, limit, cfg) {
  const url = "https://api.search.brave.com/res/v1/web/search?q=" +
    encodeURIComponent(query) +
    "&count=" + Math.min(limit, 10) +
    "&search_lang=en&result_filter=web";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.fetchTimeoutMs);
  if (timer.unref) timer.unref();
  try {
    const resp = await cfg.fetchImpl(url, {
      signal: ctrl.signal,
      headers: {
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": cfg.braveApiKey,
      },
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error("Brave HTTP " + resp.status + ": " + txt.slice(0, 200));
    }
    const data = await resp.json();
    const web = (data && data.web && data.web.results) || [];
    return web.slice(0, limit).map(r => ({
      title: r.title || "",
      url: r.url || "",
      snippet: r.description || r.snippet || "",
    }));
  } finally {
    clearTimeout(timer);
  }
}

// --- Web fetch (URL to plaintext) ---
async function fetchUrl(url, cfg) {
  if (!/^https?:\/\//i.test(url)) throw new Error("Invalid URL scheme (must be http/https)");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.fetchTimeoutMs);
  if (timer.unref) timer.unref();
  try {
    const resp = await cfg.fetchImpl(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": cfg.userAgent,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status + " " + resp.statusText);
    const ct = (resp.headers && typeof resp.headers.get === "function" ? String(resp.headers.get("content-type") || "") : "").toLowerCase();
    if (ct && !/text\/(html|plain|xml)|application\/(json|xml|rss\+xml|atom\+xml)|\+json/.test(ct)) {
      throw new Error("Unsupported content-type: " + ct);
    }
    if (!resp.body || typeof resp.body.getReader !== "function") {
      const text = await resp.text();
      if (text.length > cfg.maxFetchBytes) {
        return truncate(text, cfg.maxResultChars) + "\n[note: exceeded " + cfg.maxFetchBytes + " bytes, truncated]";
      }
      return text;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let out = "", total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        total += value.length;
        if (total > cfg.maxFetchBytes) {
          try { reader.cancel(); } catch {}
          out += "\n[truncated at " + cfg.maxFetchBytes + " bytes]";
          break;
        }
        out += decoder.decode(value, { stream: true });
      }
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}


// --- Main factory ---
function createWebTools(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  if (!cfg.fetchImpl) {
    return {
      enabled: false,
      handle: async () => ({ error: "no fetch implementation" }),
      getSchemas: () => [],
      stats: () => ({ enabled: false }),
    };
  }

  const counters = { search: 0, fetch: 0, errors: 0, braveHits: 0, ddgFallback: 0, gnewsFallback: 0, bingFallback: 0, wikiFallback: 0, totalChars: 0 };

  async function handleSearch(args) {
    counters.search++;
    const query = String(args && args.query || "").trim();
    const limit = Math.max(1, Math.min(10, Number(args && args.limit) || cfg.searchLimit));
    if (!query) return { error: "query is required" };

    // Multi-source fallback chain: Brave → DuckDuckGo → Google News → Bing → Wikipedia
    const sources = [];
    if (cfg.braveApiKey) sources.push({ name: "brave", fn: searchBrave, counter: "braveHits" });
    sources.push({ name: "duckduckgo", fn: searchDuckDuckGo, counter: "ddgFallback" });
    sources.push({ name: "google-news", fn: searchGoogleNewsRSS, counter: "gnewsFallback" });
    sources.push({ name: "bing", fn: searchBing, counter: "bingFallback" });
    sources.push({ name: "wikipedia", fn: searchWikipedia, counter: "wikiFallback" });

    let results = null;
    let source = "none";
    const tried = [];
    for (const s of sources) {
      try {
        const r = await s.fn(query, limit, cfg);
        if (Array.isArray(r) && r.length > 0) {
          results = r;
          source = s.name;
          if (s.counter) counters[s.counter]++;
          break;
        }
        tried.push(s.name + ":0");
      } catch (e) {
        counters.errors++;
        tried.push(s.name + ":err(" + (e.message || "").slice(0, 60) + ")");
      }
    }

    if (!results || results.length === 0) {
      return {
        error: "search returned no results across all sources",
        query,
        tried: tried.join(", "),
        hint: "Try rephrasing the query or using web_fetch on a known URL.",
      };
    }

    const formatted = results.map((r, i) =>
      "[" + (i + 1) + "] " + r.title + "\n    URL: " + r.url + "\n    " + (r.snippet || "(no snippet)")
    ).join("\n\n");
    const out = "Query: " + query + " (" + results.length + " results via " + source + ")\n\n" + formatted;
    counters.totalChars += out.length;
    return { content: truncate(out, cfg.maxResultChars), resultCount: results.length, source, tried: tried.length > 0 ? tried.join(", ") : undefined };
  }

  async function handleFetch(args) {
    counters.fetch++;
    const url = String(args && args.url || "").trim();
    if (!url) return { error: "url is required" };

    let raw;
    try {
      raw = await fetchUrl(url, cfg);
    } catch (e) {
      counters.errors++;
      return { error: "fetch failed: " + (e.message || e), url };
    }

    const trimmed = raw.trimStart();
    let text;
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      text = raw;
    } else {
      text = stripHtml(raw);
    }
    const out = "URL: " + url + "\n\n" + truncate(text, cfg.maxResultChars);
    counters.totalChars += out.length;
    return { content: out, chars: text.length };
  }

  async function handle(name, args) {
    if (name === "web_search") return handleSearch(args);
    if (name === "web_fetch")  return handleFetch(args);
    return { error: "unknown tool: " + name };
  }

  return {
    enabled: true,
    handle,
    getSchemas: () => WEB_TOOL_SCHEMAS,
    stats: () => ({
      enabled: true,
      braveConfigured: !!cfg.braveApiKey,
      counters: Object.assign({}, counters),
    }),
  };
}

module.exports = { createWebTools, WEB_TOOL_SCHEMAS, stripHtml };
