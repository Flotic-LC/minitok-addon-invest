"use strict";

/**
 * Phase N ↔ MCP Tool Bridge (P1-6) — exposes escalation manager and
 * related orchestration surfaces as MCP-compatible tool handlers that
 * the minitok client can invoke via JSON-RPC.
 *
 * Architecture:
 *   - Defines a small tool catalog: tossinvest_escalate, tossinvest_respond,
 *     tossinvest_status, tossinvest_lifecycle_list
 *   - Each handler validates args, calls the underlying manager, returns
 *     a JSON-RPC-friendly result { content: [{ type: "text", text }] }
 *   - Registration is opt-in: host can call getToolDefinitions() to merge
 *     these into its TOOLS array, or call handlers directly
 *
 * Usage:
 *   const { createMcpBridge } = require("./src/agent/mcp-bridge");
 *   const bridge = createMcpBridge({ escalationManager, lifecycleManager });
 *   const defs = bridge.getToolDefinitions();
 *   const result = await bridge.handle("tossinvest_status", {});
 */

const SCHEMA_VERSION = 1;

function jsonResponse(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResponse(message, code) {
  const err = Object.assign(new Error(message), { code: code || "TOOL_ERROR" });
  throw err;
}

function createMcpBridge(options) {
  const opts = options || {};
  const escalationManager = opts.escalationManager || null;
  const lifecycleManager = opts.lifecycleManager || null;
  const audit = typeof opts.audit === "function" ? opts.audit : null;
  const now = typeof opts.now === "function" ? opts.now : function() { return Date.now(); };

  const counters = { calls: 0, errors: 0, byTool: {} };

  function bump(tool, ok) {
    counters.calls++;
    if (!ok) counters.errors++;
    counters.byTool[tool] = (counters.byTool[tool] || 0) + 1;
  }

  const TOOLS = [
    {
      name: "tossinvest_status",
      description: "Get current status of the tossinvest addon (escalation + lifecycle counters)",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "tossinvest_escalate",
      description: "Create a human escalation request with severity, summary, and response options",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["info", "warn", "critical"] },
          summary: { type: "string", minLength: 1, maxLength: 500 },
          bullets: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10 },
          options: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", minLength: 1, maxLength: 64 },
                label: { type: "string", minLength: 1, maxLength: 200 },
                recommended: { type: "boolean" },
              },
              required: ["id", "label"],
              additionalProperties: false,
            },
            minItems: 1, maxItems: 8,
          },
          timeoutMs: { type: "integer", minimum: 1000, maximum: 86400000 },
          fallbackOptionId: { type: "string", minLength: 1, maxLength: 64 },
        },
        required: ["severity", "summary", "options"],
        additionalProperties: false,
      },
    },
    {
      name: "tossinvest_respond",
      description: "Respond to a pending escalation with a chosen option",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        type: "object",
        properties: {
          escalation_id: { type: "string", minLength: 1, maxLength: 128 },
          option_id: { type: "string", minLength: 1, maxLength: 64 },
        },
        required: ["escalation_id", "option_id"],
        additionalProperties: false,
      },
    },
    {
      name: "tossinvest_lifecycle_list",
      description: "List strategies and their current lifecycle phase",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    // [Patch 2026-10-15] Scalper arm/disarm tools for AI-controlled HFT
    {
      name: "scalper_arm",
      description: "Arm the tick scalper for a specific symbol. The scalper will then execute sub-second trades autonomously when micro-structure conditions are met. Use when you detect high-volatility or momentum regime suitable for scalping.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Symbol to arm (e.g. TQQQ, NVDA)" },
          maxQty: { type: "number", description: "Max quantity per scalp trade (optional, default from env)" },
          profitBps: { type: "number", description: "Target profit in basis points (optional)" },
          stopBps: { type: "number", description: "Stop loss in basis points (optional)" }
        },
        required: ["symbol"],
        additionalProperties: false
      }
    },
    {
      name: "scalper_disarm",
      description: "Disarm the tick scalper for a specific symbol. Stops autonomous scalping immediately.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Symbol to disarm" }
        },
        required: ["symbol"],
        additionalProperties: false
      }
    },
    {
      name: "scalper_status",
      description: "Get current scalper status for all symbols (armed state, fires today, open positions).",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: { type: "object", properties: {}, additionalProperties: false }
    },
  ];

  function getToolDefinitions() { return TOOLS.slice(); }


  function findTool(name) {
    for (let i = 0; i < TOOLS.length; i++) {
      if (TOOLS[i].name === name) return TOOLS[i];
    }
    return null;
  }

  function writeAudit(event, data) {
    if (!audit) return;
    try { audit({ event: event, ts: new Date(now()).toISOString(), data: data }); } catch {}
  }

  function validateArgs(name, args) {
    const def = findTool(name);
    if (!def) errorResponse("Unknown tool: " + name, "TOOL_NOT_FOUND");
    const schema = def.inputSchema;
    if (schema.additionalProperties === false && args && typeof args === "object") {
      for (const key of Object.keys(args)) {
        if (!schema.properties || !schema.properties[key]) {
          errorResponse("Unknown argument: " + key, "INVALID_PARAMS");
        }
      }
    }
    if (schema.required) {
      for (const key of schema.required) {
        if (!args || args[key] === undefined || args[key] === null) {
          errorResponse("Missing required argument: " + key, "INVALID_PARAMS");
        }
      }
    }
    return args || {};
  }

  function handleStatus() {
    bump("tossinvest_status", true);
    const result = {
      timestamp: new Date(now()).toISOString(),
      escalation: escalationManager ? escalationManager.stats() : null,
      lifecycle: lifecycleManager ? lifecycleManager.stats() : null,
      bridge: {
        calls: counters.calls,
        errors: counters.errors,
        byTool: Object.assign({}, counters.byTool),
      },
    };
    writeAudit("tossinvest_status", result);
    return jsonResponse(result);
  }

  function handleEscalate(args) {
    if (!escalationManager) errorResponse("Escalation manager not available", "UNAVAILABLE");
    const request = {
      severity: args.severity,
      summary: args.summary,
      bullets: args.bullets || [],
      options: args.options || [],
      timeoutMs: args.timeoutMs,
      fallbackOptionId: args.fallbackOptionId,
    };
    const id = escalationManager.escalate(request);
    bump("tossinvest_escalate", true);
    writeAudit("tossinvest_escalate", { escalationId: id, severity: args.severity, summary: args.summary });
    return jsonResponse({ escalationId: id, severity: args.severity, summary: args.summary, status: "pending" });
  }

  function handleRespond(args) {
    if (!escalationManager) errorResponse("Escalation manager not available", "UNAVAILABLE");
    let result;
    try {
      result = escalationManager.respond(args.escalation_id, args.option_id);
    } catch (e) {
      bump("tossinvest_respond", false);
      errorResponse(e && e.message ? e.message : String(e), "ESCALATION_ERROR");
    }
    bump("tossinvest_respond", true);
    writeAudit("tossinvest_respond", { escalationId: args.escalation_id, optionId: args.option_id, result: result });
    return jsonResponse({ escalationId: args.escalation_id, optionId: args.option_id, result: result });
  }

  function handleLifecycleList() {
    if (!lifecycleManager) errorResponse("Lifecycle manager not available", "UNAVAILABLE");
    const list = (lifecycleManager.listStrategies ? lifecycleManager.listStrategies() : []).map(function(s) {
      return {
        id: s.id, name: s.name, phase: s.phase,
        allocationPct: s.allocationPct, promotionLevel: s.promotionLevel,
        createdAt: s.createdAt, promotedAt: s.promotedAt,
      };
    });
    bump("tossinvest_lifecycle_list", true);
    writeAudit("tossinvest_lifecycle_list", { count: list.length });
    return jsonResponse({ strategies: list, count: list.length });
  }

  async function handle(name, args) {
    validateArgs(name, args);
    try {
      if (name === "tossinvest_status") return handleStatus();
      if (name === "tossinvest_escalate") return handleEscalate(args);
      if (name === "tossinvest_respond") return handleRespond(args);
      if (name === "tossinvest_lifecycle_list") return handleLifecycleList();
      // [Patch 2026-10-15] Scalper arm/disarm/status handlers
      if (name === "scalper_arm") {
        if (!opts.scalper) errorResponse("Scalper module not available", "SCALPER_UNAVAILABLE");
        var _saRes = opts.scalper.arm(args.symbol, { maxQty: args.maxQty, profitBps: args.profitBps, stopBps: args.stopBps });
        bump("scalper_arm", true);
        return jsonResponse({ success: true, result: _saRes });
      }
      if (name === "scalper_disarm") {
        if (!opts.scalper) errorResponse("Scalper module not available", "SCALPER_UNAVAILABLE");
        var _sdRes = opts.scalper.disarm(args.symbol);
        bump("scalper_disarm", true);
        return jsonResponse({ success: true, result: _sdRes });
      }
      if (name === "scalper_status") {
        if (!opts.scalper) errorResponse("Scalper module not available", "SCALPER_UNAVAILABLE");
        var _ssRes = opts.scalper.status();
        bump("scalper_status", true);
        return jsonResponse({ success: true, status: _ssRes });
      }
      errorResponse("Unknown tool: " + name, "TOOL_NOT_FOUND");
    } catch (e) {
      if (e && e.code && e.code !== "TOOL_ERROR") throw e;
      counters.errors++;
      throw e;
    }
  }

  function stats() {
    return {
      schemaVersion: SCHEMA_VERSION,
      tools: TOOLS.map(function(t) { return t.name; }),
      calls: counters.calls,
      errors: counters.errors,
      byTool: Object.assign({}, counters.byTool),
      escalationAvailable: !!escalationManager,
      lifecycleAvailable: !!lifecycleManager,
    };
  }

  return {
    getToolDefinitions: getToolDefinitions,
    handle: handle,
    validateArgs: validateArgs,
    stats: stats,
  };
}

module.exports = { createMcpBridge, SCHEMA_VERSION };
