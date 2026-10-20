"use strict";

/**
 * Human Escalation Protocol (Phase N / L4.5) — structured escalation
 * from autonomous agent to human operator via configurable channels
 * (Telegram, Discord, email). Supports:
 *
 *   - Severity levels: info | warn | critical
 *   - Structured context: summary + bullet list + response options
 *   - Recommended action marking per option
 *   - Timeout with configurable fallback policy
 *   - Daily escalation limit (circuit breaker)
 *   - Audit trail for every escalation + response
 *   - Channel routing (single or broadcast)
 *   - Cooldown per escalation key (debounce repeated alerts)
 *
 * Usage:
 *   const { createEscalationManager } = require("./src/orchestrator/escalation");
 *   const em = createEscalationManager({
 *     channels: {
 *       telegram: async (msg) => sendTelegram(msg),
 *       email:    async (msg) => sendEmail(msg),
 *     },
 *     config: { dailyLimit: 3, defaultTimeoutMs: 14400000 },
 *     onTimeout: (id, fallback) => executeFallback(fallback),
 *   });
 *   const id = await em.escalate({
 *     severity: "critical",
 *     summary:  "killswitch triggered",
 *     bullets:  ["DATA_DRIFT 3 days", "Sharpe -1.2"],
 *     options:  [
 *       { id: "wait",   label: "1h wait",    recommended: true },
 *       { id: "shadow", label: "shadow mode" },
 *       { id: "abort",  label: "full abort" },
 *     ],
 *     timeoutMs: 60000,
 *     fallbackOptionId: "shadow",
 *   });
 */

const DEFAULTS = Object.freeze({
  enabled: process.env.ESCALATION_ENABLED !== "false",
  dailyLimit: Number(process.env.ESCALATION_DAILY_LIMIT || 3),
  defaultTimeoutMs: Number(process.env.ESCALATION_DEFAULT_TIMEOUT_MS || 14400000),
  timeoutFallback: "default",
  cooldownMs: Number(process.env.ESCALATION_COOLDOWN_MS || 300000),
  maxHistorySize: Number(process.env.ESCALATION_MAX_HISTORY || 500),
  now: null,
});

const SEVERITIES = Object.freeze(["info", "warn", "critical"]);

function uid() {
  return "esc_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function startOfDay(ts) {
  var d = new Date(ts);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

function renderTemplate(ctx) {
  var lines = [];
  lines.push("[" + ctx.severity.toUpperCase() + "] " + ctx.summary);
  if (ctx.bullets && ctx.bullets.length) {
    lines.push("");
    for (var i = 0; i < ctx.bullets.length; i++) {
      lines.push("• " + ctx.bullets[i]);
    }
  }
  if (ctx.options && ctx.options.length) {
    lines.push("");
    lines.push("Options:");
    for (var j = 0; j < ctx.options.length; j++) {
      var opt = ctx.options[j];
      var marker = opt.recommended ? " (recommended)" : "";
      lines.push("  " + (j + 1) + ". [" + opt.id + "] " + opt.label + marker);
    }
  }
  if (ctx.timeoutMs) {
    lines.push("");
    lines.push("Timeout: " + Math.round(ctx.timeoutMs / 1000) + "s");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
function createEscalationManager(options) {
  var opts = options || {};
  var cfg = Object.assign({}, DEFAULTS, opts.config || {});
  var channels = opts.channels || {};
  var audit = typeof opts.audit === "function" ? opts.audit : null;
  var onTimeoutCb = typeof opts.onTimeout === "function" ? opts.onTimeout : null;
  var onResponseCb = typeof opts.onResponse === "function" ? opts.onResponse : null;
  var now = typeof cfg.now === "function" ? cfg.now : function() { return Date.now(); };

  var active = new Map(); // id -> { entry, timer }
  var history = [];
  var dailyCounts = {};
  var cooldowns = {};
  var counters = { total: 0, responded: 0, timedOut: 0, rejected: 0 };

  function addHistory(entry) {
    history.push(entry);
    if (history.length > cfg.maxHistorySize) {
      history.splice(0, history.length - cfg.maxHistorySize);
    }
  }

  function writeAudit(event, data) {
    if (!audit) return;
    try { audit({ event: event, ts: now(), data: data }); } catch (e) { /* ignore */ }
  }

  function countForToday() {
    var day = startOfDay(now());
    if (!dailyCounts[day]) dailyCounts[day] = 0;
    return dailyCounts[day];
  }

  function incrementToday() {
    var day = startOfDay(now());
    if (!dailyCounts[day]) dailyCounts[day] = 0;
    dailyCounts[day]++;
  }

  function checkCooldown(key) {
    if (!key) return false;
    var last = cooldowns[key];
    if (!last) return false;
    return (now() - last) < cfg.cooldownMs;
  }

  function recordCooldown(key) {
    if (!key) return;
    cooldowns[key] = now();
  }

  function resolveFallback(entry) {
    if (cfg.timeoutFallback === "none") return null;
    if (entry.fallbackOptionId) return entry.fallbackOptionId;
    if (cfg.timeoutFallback === "safest" && entry.options && entry.options.length) {
      return entry.options[entry.options.length - 1].id;
    }
    if (entry.options) {
      for (var i = 0; i < entry.options.length; i++) {
        if (entry.options[i].recommended) return entry.options[i].id;
      }
      if (entry.options.length > 0) return entry.options[0].id;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // escalate()
  // -------------------------------------------------------------------------
  function escalate(ctx) {
    if (!ctx || typeof ctx !== "object") {
      return Promise.reject(new Error("escalate: context object required"));
    }
    if (!ctx.summary || typeof ctx.summary !== "string") {
      return Promise.reject(new Error("escalate: summary string required"));
    }
    var severity = ctx.severity || "info";
    if (SEVERITIES.indexOf(severity) === -1) {
      return Promise.reject(new Error("escalate: invalid severity '" + severity + "'"));
    }
    if (!cfg.enabled) {
      counters.rejected++;
      var disabled = {
        id: uid(), severity: severity, summary: ctx.summary,
        status: "disabled", resolvedAt: now(), optionId: null,
      };
      addHistory(disabled);
      return Promise.resolve(disabled.id);
    }
    // daily limit
    if (countForToday() >= cfg.dailyLimit) {
      counters.rejected++;
      var rejected = {
        id: uid(), severity: severity, summary: ctx.summary,
        status: "rejected", reason: "daily_limit",
        dailyCount: countForToday(), dailyLimit: cfg.dailyLimit,
        resolvedAt: now(), optionId: null,
      };
      addHistory(rejected);
      writeAudit("escalation.rejected", rejected);
      return Promise.resolve(rejected.id);
    }
    // cooldown
    if (checkCooldown(ctx.cooldownKey)) {
      counters.rejected++;
      var cooled = {
        id: uid(), severity: severity, summary: ctx.summary,
        status: "rejected", reason: "cooldown",
        cooldownKey: ctx.cooldownKey, cooldownMs: cfg.cooldownMs,
        resolvedAt: now(), optionId: null,
      };
      addHistory(cooled);
      writeAudit("escalation.cooldown", cooled);
      return Promise.resolve(cooled.id);
    }

    var channelList = ctx.channels || Object.keys(channels);
    if (!Array.isArray(channelList) || channelList.length === 0) {
      return Promise.reject(new Error("escalate: no channels configured"));
    }

    var options = ctx.options || [];
    if (!Array.isArray(options)) {
      return Promise.reject(new Error("escalate: options must be array"));
    }
    for (var i = 0; i < options.length; i++) {
      if (!options[i].id || !options[i].label) {
        return Promise.reject(new Error("escalate: each option requires id and label"));
      }
    }

    var timeoutMs = typeof ctx.timeoutMs === "number" ? ctx.timeoutMs : cfg.defaultTimeoutMs;
    var id = uid();
    var entry = {
      id: id,
      severity: severity,
      summary: ctx.summary,
      bullets: ctx.bullets || [],
      options: options,
      timeoutMs: timeoutMs,
      fallbackOptionId: ctx.fallbackOptionId || null,
      cooldownKey: ctx.cooldownKey || null,
      metadata: ctx.metadata || {},
      status: "pending",
      channels: channelList,
      escalatedAt: now(),
      resolvedAt: null,
      optionId: null,
      responseMode: null,
    };

    var message = renderTemplate(entry);

    var dispatchPromises = channelList.map(function(ch) {
      var sender = channels[ch];
      if (typeof sender !== "function") {
        return Promise.resolve({ channel: ch, ok: false, error: "unknown channel" });
      }
      return Promise.resolve()
        .then(function() { return sender({ id: id, severity: severity, message: message, entry: entry }); })
        .then(function() { return { channel: ch, ok: true }; })
        .catch(function(e) { return { channel: ch, ok: false, error: e.message }; });
    });

    incrementToday();
    counters.total++;
    recordCooldown(entry.cooldownKey);

    var timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(function() {
        var current = active.get(id);
        if (!current || current.entry.status !== "pending") return;
        var fallback = resolveFallback(current.entry);
        current.entry.status = "resolved";
        current.entry.optionId = fallback;
        current.entry.responseMode = "timeout";
        current.entry.resolvedAt = now();
        counters.timedOut++;
        addHistory(current.entry);
        active.delete(id);
        writeAudit("escalation.timeout", { id: id, fallback: fallback });
        if (onTimeoutCb) {
          try { onTimeoutCb(id, fallback, current.entry); } catch (e) { /* ignore */ }
        }
      }, timeoutMs);
      if (timer.unref) timer.unref();
    }

    active.set(id, { entry: entry, timer: timer });
    writeAudit("escalation.sent", { id: id, severity: severity, channels: channelList });

    return Promise.all(dispatchPromises).then(function(results) {
      entry.dispatchResults = results;
      return id;
    });
  }


  // -------------------------------------------------------------------------
  // respond()
  // -------------------------------------------------------------------------
  function respond(escalationId, optionId) {
    if (!escalationId) return { ok: false, error: "escalationId required" };
    var record = active.get(escalationId);
    if (!record) return { ok: false, error: "escalation not found or already resolved" };
    if (record.entry.status !== "pending") {
      return { ok: false, error: "already resolved" };
    }
    // validate optionId
    if (record.entry.options.length > 0) {
      var valid = false;
      for (var i = 0; i < record.entry.options.length; i++) {
        if (record.entry.options[i].id === optionId) { valid = true; break; }
      }
      if (!valid) return { ok: false, error: "unknown optionId: " + optionId };
    }
    if (record.timer) clearTimeout(record.timer);
    record.entry.status = "resolved";
    record.entry.optionId = optionId;
    record.entry.responseMode = "human";
    record.entry.resolvedAt = now();
    counters.responded++;
    addHistory(record.entry);
    active.delete(escalationId);
    writeAudit("escalation.response", { id: escalationId, optionId: optionId });
    if (onResponseCb) {
      try { onResponseCb(escalationId, optionId, record.entry); } catch (e) { /* ignore */ }
    }
    return { ok: true, id: escalationId, optionId: optionId };
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------
  function getPending() {
    var out = [];
    active.forEach(function(v) {
      if (v.entry.status === "pending") out.push(v.entry);
    });
    return out;
  }

  function getHistory(limit) {
    if (typeof limit === "number" && limit > 0) {
      return history.slice(-limit);
    }
    return history.slice();
  }

  function stats() {
    var today = countForToday();
    return {
      enabled: cfg.enabled,
      dailyLimit: cfg.dailyLimit,
      todayCount: today,
      remainingToday: Math.max(0, cfg.dailyLimit - today),
      total: counters.total,
      responded: counters.responded,
      timedOut: counters.timedOut,
      rejected: counters.rejected,
      pendingCount: active.size,
      channels: Object.keys(channels),
    };
  }

  // -------------------------------------------------------------------------
  // State / restore / reset
  // -------------------------------------------------------------------------
  function state() {
    return {
      config: Object.assign({}, cfg),
      counters: Object.assign({}, counters),
      dailyCounts: Object.assign({}, dailyCounts),
      cooldowns: Object.assign({}, cooldowns),
      history: history.slice(),
    };
  }

  function restore(snap) {
    if (!snap || typeof snap !== "object") return;
    if (snap.counters) Object.assign(counters, snap.counters);
    if (snap.dailyCounts) {
      dailyCounts = {};
      Object.keys(snap.dailyCounts).forEach(function(k) { dailyCounts[k] = snap.dailyCounts[k]; });
    }
    if (snap.cooldowns) {
      cooldowns = {};
      Object.keys(snap.cooldowns).forEach(function(k) { cooldowns[k] = snap.cooldowns[k]; });
    }
    if (Array.isArray(snap.history)) {
      history.length = 0;
      for (var i = 0; i < snap.history.length; i++) history.push(snap.history[i]);
    }
  }

  function reset() {
    active.forEach(function(v) { if (v.timer) clearTimeout(v.timer); });
    active.clear();
    history.length = 0;
    dailyCounts = {};
    cooldowns = {};
    counters.total = 0;
    counters.responded = 0;
    counters.timedOut = 0;
    counters.rejected = 0;
  }

  return {
    escalate: escalate,
    respond: respond,
    getPending: getPending,
    getHistory: getHistory,
    stats: stats,
    state: state,
    restore: restore,
    reset: reset,
    _internals: { renderTemplate: renderTemplate, SEVERITIES: SEVERITIES, DEFAULTS: DEFAULTS },
  };
}

module.exports = { createEscalationManager: createEscalationManager, DEFAULTS: DEFAULTS, SEVERITIES: SEVERITIES };


