"use strict";

/**
 * Multi-provider LLM router with circuit breaker and health tracking.
 *
 * Features:
 *   - Round-robin failover across configured providers
 *   - Per-provider health tracking (success/failure counts, latency)
 *   - Circuit breaker: after N consecutive failures, provider disabled
 *   - Priority recovery: periodically probe disabled providers
 *   - JSON extraction with markdown fence tolerance
 *
 * Usage:
 *   const { createProviderRouter } = require("./src/ai/provider-router");
 *   const router = createProviderRouter({
 *     providers: [
 *       { name: "profundo", key, baseUrl: "https://api.profundoai.com/v1", model: "gpt-6-astra" },
 *       { name: "openai",   key, baseUrl: "https://api.openai.com/v1",     model: "gpt-4o-mini" },
 *     ],
 *   });
 *   const result = await router.call(messages);
 *   router.stats();
 */

const DEFAULTS = Object.freeze({
  // [P12-AI] Relaxed: 30s→60s timeout to reduce timeout-classified failures.
  // Historical 82% success rate suggested timeout was the dominant failure mode.
  timeoutMs: Number(process.env.AI_TIMEOUT_MS || 60000),
  circuitBreakerThreshold: Number(process.env.AI_CIRCUIT_BREAKER_THRESHOLD || 5),
  // [P12-AI] Relaxed: 300s→90s cooldown so tripped providers recover faster.
  circuitBreakerCooldownMs: Number(process.env.AI_CIRCUIT_BREAKER_COOLDOWN_MS || 90000),
  probeIntervalMs: Number(process.env.AI_PROBE_INTERVAL_MS || 600000),
  // [P12-AI] Relaxed: 1→2 retries to give transient failures a second chance.
  maxRetries: Number(process.env.AI_MAX_RETRIES || 2),
  temperature: Number(process.env.AI_TEMPERATURE || 0.0),  // [FIX] 0.0 for deterministic JSON; 0.1 caused 20%+ parse errors
  maxTokens: Number(process.env.AI_MAX_TOKENS || 2048),  // [FIX] 1024 caused truncated JSON
});

// [P3-AI] Robust JSON extraction with multiple fallback strategies.
// Handles: trailing commas, single quotes, unquoted keys, comments, markdown fences.
function extractJson(text) {
  if (!text) return null;

  // Step 1: Strip markdown fences
  let stripped = text.replace(/^```(?:json)?\s*/im, "").replace(/\s*```\s*$/m, "");

  // Step 2: Extract JSON object boundaries
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  let candidate = stripped.substring(start, end + 1);

  // Step 3: Try direct parse first (fast path)
  try { return JSON.parse(candidate); } catch {}

  // Step 4: Sanitize common LLM output issues
  let sanitized = candidate
    // Remove JS-style single-line comments
    .replace(/\/\/[^\n]*/g, "")
    // Remove JS-style multi-line comments
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // Replace single quotes with double quotes (careful with escaped quotes)
    .replace(/(?<=[\[{,]\s*)'([^']*)'(?=\s*[:,}\]])/g, '"$1"')
    // Quote unquoted keys: {key: "value"} -> {"key": "value"}
    .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')
    // Remove trailing commas before } or ]
    .replace(/,\s*([}\]])/g, "$1");

  try { return JSON.parse(sanitized); } catch {}

  // Step 5: Last resort — try to extract key-value pairs manually for simple cases
  try {
    const actionMatch = sanitized.match(/"action"\s*:\s*"([A-Z]+)"/);
    const symbolMatch = sanitized.match(/"symbol"\s*:\s*"([^"]+)"/);
    const qtyMatch = sanitized.match(/"quantity"\s*:\s*([\d.]+)/);
    const priceMatch = sanitized.match(/"price"\s*:\s*([\d.]+)/);
    const confMatch = sanitized.match(/"confidence"\s*:\s*([\d.]+)/);
    const reasonMatch = sanitized.match(/"reason"\s*:\s*"([^"]+)"/);
    if (actionMatch) {
      const act = actionMatch[1];
      // Require symbol for BUY/SELL; otherwise downgrade to HOLD to avoid partial execution
      if ((act === "BUY" || act === "SELL") && !symbolMatch) {
        return { action: "HOLD", confidence: 0, reason: "malformed-json-missing-symbol" };
      }
      const out = {
        action: act,
        confidence: confMatch ? parseFloat(confMatch[1]) : 0.5,
        reason: reasonMatch ? reasonMatch[1] : "extracted-from-malformed-json",
      };
      if (symbolMatch) out.symbol = symbolMatch[1];
      if (qtyMatch) out.quantity = parseFloat(qtyMatch[1]);
      if (priceMatch) out.price = parseFloat(priceMatch[1]);
      return out;
    }
  } catch {}

  return null;
}

const JSON_GUARD = "CRITICAL OUTPUT RULES:\n" +
  "1. You MUST respond with ONLY a single valid JSON object.\n" +
  "2. No markdown fences, no code blocks, no prose, no explanation before or after.\n" +
  "3. First character must be '{' and last character must be '}'.\n" +
  "4. If unsure, output: {\"action\":\"HOLD\",\"confidence\":0.0,\"reason\":\"uncertain\"}";

function injectJsonGuard(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  // Append/merge into the LAST system message; otherwise append a new one.
  const msgs = messages.slice();
  const lastIdx = msgs.length - 1;
  if (msgs[lastIdx] && msgs[lastIdx].role === "system") {
    msgs[lastIdx] = { role: "system", content: msgs[lastIdx].content + "\n\n" + JSON_GUARD };
  } else {
    msgs.push({ role: "system", content: JSON_GUARD });
  }
  return msgs;
}

function createProviderRouter(options = {}) {
  const {
    providers = [],
    timeoutMs = DEFAULTS.timeoutMs,
    circuitBreakerThreshold = DEFAULTS.circuitBreakerThreshold,
    circuitBreakerCooldownMs = DEFAULTS.circuitBreakerCooldownMs,
    probeIntervalMs = DEFAULTS.probeIntervalMs,
    maxRetries = DEFAULTS.maxRetries,
    temperature = DEFAULTS.temperature,
    maxTokens = DEFAULTS.maxTokens,
    fetchImpl = typeof fetch !== "undefined" ? fetch : null,
    now = () => Date.now(),
  } = options;

  if (!fetchImpl) throw new Error("provider-router: fetch implementation required");
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error("provider-router: at least one provider required");
  }

  let lastUsedProviderName = null;
  function getLastUsedProvider() { return lastUsedProviderName; }

  const health = new Map();
  for (const p of providers) {
    health.set(p.name, {
      name: p.name, baseUrl: p.baseUrl, model: p.model, key: p.key,
      successes: 0, failures: 0, consecutiveFailures: 0,
      totalLatencyMs: 0, lastSuccessAt: null, lastFailureAt: null,
      circuitOpen: false, circuitOpenedAt: null, lastProbeAt: null,
      // [P12-AI] Failure reason categorization for root-cause analysis
      failureReasons: { timeout: 0, network: 0, http: 0, empty: 0, parse: 0, other: 0 },
    });
  }
  // [P12-AI] Global failure reason aggregation across all providers
  const globalFailureReasons = { timeout: 0, network: 0, http: 0, empty: 0, parse: 0, other: 0 };

  function getHealthyProviders() {
    const t = now();
    const result = [];
    for (const p of providers) {
      const h = health.get(p.name);
      if (!h.circuitOpen) { result.push(p); continue; }
      if (h.circuitOpenedAt && (t - h.circuitOpenedAt) >= circuitBreakerCooldownMs) {
        if (!h.lastProbeAt || (t - h.lastProbeAt) >= probeIntervalMs) {
          h.lastProbeAt = t;
          result.push(p);
        }
      }
    }
    return result;
  }

  function recordSuccess(name, latencyMs) {
    const h = health.get(name);
    if (!h) return;
    h.successes++;
    h.consecutiveFailures = 0;
    h.totalLatencyMs += latencyMs;
    h.lastSuccessAt = now();
    if (h.circuitOpen) { h.circuitOpen = false; h.circuitOpenedAt = null; }
  }

  // [P12-AI] Enhanced failure recording with reason categorization
  function recordFailure(name, reason) {
    const h = health.get(name);
    if (!h) return;
    h.failures++;
    h.consecutiveFailures++;
    h.lastFailureAt = now();
    // Categorize failure reason
    const r = reason || "other";
    if (h.failureReasons[r] !== undefined) {
      h.failureReasons[r]++;
    } else {
      h.failureReasons.other++;
    }
    if (globalFailureReasons[r] !== undefined) {
      globalFailureReasons[r]++;
    } else {
      globalFailureReasons.other++;
    }
    if (h.consecutiveFailures >= circuitBreakerThreshold && !h.circuitOpen) {
      h.circuitOpen = true;
      h.circuitOpenedAt = now();
    }
  }

  async function callSingleProvider(provider, messages, signal, tools) {
    const t0 = now();
    const body = { model: provider.model, messages, temperature, max_tokens: maxTokens };
    if (tools && tools.length > 0) body.tools = tools;
    // [FIX] Normalize trailing slashes on baseUrl — gemini's configured base_url ends
    // with "/openai/" which produced ".../openai//chat/completions" → HTTP 404, silently
    // disabling the primary provider and leaving profundo as the de-facto only one.
    const _base = provider.baseUrl.replace(/\/+$/, "");
    const resp = await fetchImpl(_base + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + provider.key },
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error("HTTP " + resp.status + ": " + text.slice(0, 200));
    }
    const data = await resp.json();
    const choice = data.choices && data.choices[0];
    if (!choice || !choice.message) throw new Error("No message in response");
    return { message: choice.message, finishReason: choice.finish_reason, latency: now() - t0 };
  }

  // [P3-AI / P6-FIX] Sliding-window parse-failure tracking.
  // Previous cumulative counters never recovered once above threshold, causing
  // permanent LLM_DEGRADATION escalation. Use a ring buffer of the last N calls
  // so recent clean calls push old failures out of the window.
  const PARSE_WINDOW_SIZE = Number(process.env.AI_PARSE_WINDOW_SIZE || 50);
  const parseWindow = []; // each entry: 1 = success, 0 = fail

  function recordParseResult(ok) {
    parseWindow.push(ok ? 1 : 0);
    if (parseWindow.length > PARSE_WINDOW_SIZE) parseWindow.shift();
  }

  function parseErrorPct() {
    if (parseWindow.length === 0) return 0;
    let fails = 0;
    for (let i = 0; i < parseWindow.length; i++) if (parseWindow[i] === 0) fails++;
    return fails / parseWindow.length;
  }

  function parseWindowStats() {
    return { size: parseWindow.length, windowSize: PARSE_WINDOW_SIZE, pct: parseErrorPct() };
  }

  // [P3-AI] Reinforcement prompt injected on retry after parse failure.
  const REINFORCE_JSON = "YOUR PREVIOUS RESPONSE WAS NOT VALID JSON. " +
    "You MUST output ONLY a valid JSON object now. " +
    "No prose, no markdown, no explanation. " +
    'Example: {"action":"HOLD","confidence":0.5,"reason":"default"}';

  async function call(messages) {
    // [FIX] Append a hard JSON-only guard to the system prompt to reduce parse failures
    const _msgs = injectJsonGuard(messages);
    const healthy = getHealthyProviders();
    const candidates = healthy.length > 0 ? healthy : [providers[0]];
    let lastParseError = null;
    for (const provider of candidates) {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        if (timer.unref) timer.unref();
        // [P3-AI] On retry after parse failure, inject reinforcement prompt
        let attemptMsgs = _msgs;
        if (attempt > 0 && lastParseError) {
          attemptMsgs = _msgs.slice();
          attemptMsgs.push({ role: "system", content: REINFORCE_JSON });
        }
        try {
          const { message, latency } = await callSingleProvider(provider, attemptMsgs, ctrl.signal, null);
          const text = (message.content || "").trim();
          if (!text) throw new Error("Empty response");
          lastUsedProviderName = provider.name;
          const parsed = extractJson(text);
          if (!parsed) {
            recordParseResult(false);
            lastParseError = text.slice(0, 200);
            console.warn("[ai-router] PARSE_FAIL provider=" + provider.name + " model=" + provider.model +
              " attempt=" + attempt + "/" + maxRetries + " pct=" + (parseErrorPct() * 100).toFixed(1) +
              "% sample=" + JSON.stringify(text.slice(0, 200)));
            if (attempt < maxRetries) continue; // retry with reinforcement
            throw new Error("JSON parse failed after " + (maxRetries + 1) + " attempts");
          }
          recordParseResult(true);
          recordSuccess(provider.name, latency);
          return parsed;
        } catch (e) {
          if (attempt < maxRetries) continue;
          // [P12-AI] Categorize failure reason
          const msg = (e && e.message) || String(e);
          let reason = "other";
          if (e && e.name === "AbortError" || /abort|timeout|timed out/i.test(msg)) reason = "timeout";
          else if (/JSON parse failed|parse failed/i.test(msg)) reason = "parse";
          else if (/Empty response/i.test(msg)) reason = "empty";
          else if (/HTTP \d+/.test(msg)) reason = "http";
          else if (/fetch|network|ECONNR|ENOTFOUND|socket/i.test(msg)) reason = "network";
          recordFailure(provider.name, reason);
          const h = health.get(provider.name);
          if (h && h.circuitOpen) break;
        } finally {
          clearTimeout(timer);
        }
      }
    }
    return null;
  }

  // Raw call returning full message for function-calling / agentic loops.
  // When `opts.tools` is provided, the LLM may respond with `tool_calls`
  // instead of content. The caller is responsible for executing tools
  // and appending tool results to the message history.
  async function callRaw(messages, opts) {
    const tools = (opts && opts.tools) || null;
    // [FIX] Append JSON-only guard
    const _msgs = injectJsonGuard(messages);
    const healthy = getHealthyProviders();
    const candidates = healthy.length > 0 ? healthy : [providers[0]];
    for (const provider of candidates) {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        if (timer.unref) timer.unref();
        try {
          const result = await callSingleProvider(provider, _msgs, ctrl.signal, tools);
          lastUsedProviderName = provider.name;
          recordSuccess(provider.name, result.latency);
          return result;
        } catch (e) {
          if (attempt < maxRetries) continue;
          // [P12-AI] Categorize failure reason
          const msg = (e && e.message) || String(e);
          let reason = "other";
          if (e && e.name === "AbortError" || /abort|timeout|timed out/i.test(msg)) reason = "timeout";
          else if (/Empty response/i.test(msg)) reason = "empty";
          else if (/HTTP \d+/.test(msg)) reason = "http";
          else if (/fetch|network|ECONNR|ENOTFOUND|socket/i.test(msg)) reason = "network";
          recordFailure(provider.name, reason);
          const h = health.get(provider.name);
          if (h && h.circuitOpen) break;
        } finally {
          clearTimeout(timer);
        }
      }
    }
    return null;
  }

  function lastUsedProvider() { return lastUsedProviderName; }

  function stats() {
    const result = [];
    for (const p of providers) {
      const h = health.get(p.name);
      const total = h.successes + h.failures;
      result.push({
        name: h.name, model: h.model,
        successes: h.successes, failures: h.failures,
        successRate: total > 0 ? Math.round((h.successes / total) * 100) : 0,
        avgLatencyMs: h.successes > 0 ? Math.round(h.totalLatencyMs / h.successes) : 0,
        consecutiveFailures: h.consecutiveFailures,
        circuitOpen: h.circuitOpen,
        lastSuccessAt: h.lastSuccessAt, lastFailureAt: h.lastFailureAt,
        // [P12-AI] Per-provider failure reason breakdown
        failureReasons: Object.assign({}, h.failureReasons),
      });
    }
    return {
      providers: result,
      healthyCount: result.filter((p) => !p.circuitOpen).length,
      totalCount: result.length,
      // [P12-AI] Global failure reason aggregation
      globalFailureReasons: Object.assign({}, globalFailureReasons),
    };
  }

  function resetCircuit(name) {
    if (name) {
      const h = health.get(name);
      if (h) { h.circuitOpen = false; h.circuitOpenedAt = null; h.consecutiveFailures = 0; }
    } else {
      for (const h of health.values()) {
        h.circuitOpen = false; h.circuitOpenedAt = null; h.consecutiveFailures = 0;
      }
    }
  }

  return { call, callRaw, stats, resetCircuit, extractJson, lastUsedProvider, parseErrorPct, parseWindowStats, DEFAULTS };
}

module.exports = { createProviderRouter, extractJson, DEFAULTS };
