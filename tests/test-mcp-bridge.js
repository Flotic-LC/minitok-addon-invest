"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createMcpBridge, SCHEMA_VERSION } = require("../src/agent/mcp-bridge");

function parseTextContent(result) {
  return JSON.parse(result.content[0].text);
}

test("module exports createMcpBridge and SCHEMA_VERSION", () => {
  assert.equal(typeof createMcpBridge, "function");
  assert.equal(SCHEMA_VERSION, 1);
});

test("getToolDefinitions returns 4 tools", () => {
  const bridge = createMcpBridge({});
  const defs = bridge.getToolDefinitions();
  assert.equal(defs.length, 7);
  const names = defs.map(function(d) { return d.name; });
  assert.ok(names.includes("tossinvest_status"));
  assert.ok(names.includes("tossinvest_escalate"));
  assert.ok(names.includes("tossinvest_respond"));
  assert.ok(names.includes("tossinvest_lifecycle_list"));
  assert.ok(names.includes("scalper_arm"));
  assert.ok(names.includes("scalper_disarm"));
  assert.ok(names.includes("scalper_status"));
});

test("stats reports tool list and availability", () => {
  const bridge = createMcpBridge({ escalationManager: {}, lifecycleManager: {} });
  const s = bridge.stats();
  assert.equal(s.escalationAvailable, true);
  assert.equal(s.lifecycleAvailable, true);
  assert.equal(s.tools.length, 7);
  assert.equal(s.calls, 0);
});

test("handle tossinvest_status returns counters", async () => {
  const esc = { stats: function() { return { total: 5 }; } };
  const lc = { stats: function() { return { totalStrategies: 3 }; } };
  const bridge = createMcpBridge({ escalationManager: esc, lifecycleManager: lc });
  const result = await bridge.handle("tossinvest_status", {});
  const data = parseTextContent(result);
  assert.equal(data.escalation.total, 5);
  assert.equal(data.lifecycle.totalStrategies, 3);
  assert.ok(data.timestamp);
});

test("handle tossinvest_escalate creates escalation", async () => {
  let captured = null;
  const esc = {
    stats: function() { return {}; },
    escalate: function(req) { captured = req; return "esc_123"; },
  };
  const bridge = createMcpBridge({ escalationManager: esc });
  const result = await bridge.handle("tossinvest_escalate", {
    severity: "critical",
    summary: "Position limit breach",
    options: [{ id: "halt", label: "Halt trading" }, { id: "cont", label: "Continue" }],
  });
  const data = parseTextContent(result);
  assert.equal(data.escalationId, "esc_123");
  assert.equal(data.severity, "critical");
  assert.equal(data.status, "pending");
});

test("handle tossinvest_respond forwards response", async () => {
  let captured = null;
  const esc = {
    stats: function() { return {}; },
    respond: function(id, opt) { captured = { id: id, opt: opt }; return { accepted: true }; },
  };
  const bridge = createMcpBridge({ escalationManager: esc });
  const result = await bridge.handle("tossinvest_respond", {
    escalation_id: "esc_123", option_id: "halt",
  });
  const data = parseTextContent(result);
  assert.equal(data.escalationId, "esc_123");
  assert.equal(data.optionId, "halt");
  assert.equal(data.result.accepted, true);
});

test("handle tossinvest_lifecycle_list returns strategies", async () => {
  const lc = {
    stats: function() { return {}; },
    listStrategies: function() {
      return [
        { id: "s1", name: "Alpha", phase: "INCUBATION", allocationPct: 0.1 },
        { id: "s2", name: "Beta", phase: "PRODUCTION", allocationPct: 1.0 },
      ];
    },
  };
  const bridge = createMcpBridge({ lifecycleManager: lc });
  const result = await bridge.handle("tossinvest_lifecycle_list", {});
  const data = parseTextContent(result);
  assert.equal(data.count, 2);
  assert.equal(data.strategies[0].id, "s1");
});

test("handle throws TOOL_NOT_FOUND for unknown tool", async () => {
  const bridge = createMcpBridge({});
  let threw = false;
  try { await bridge.handle("no_such_tool", {}); } catch (e) {
    threw = true; assert.equal(e.code, "TOOL_NOT_FOUND");
  }
  assert.ok(threw, "should have thrown");
});

test("validateArgs throws on missing required args", () => {
  const bridge = createMcpBridge({});
  let threw = false;
  try { bridge.validateArgs("tossinvest_escalate", {}); } catch (e) {
    threw = true; assert.equal(e.code, "INVALID_PARAMS");
  }
  assert.ok(threw);
});

test("validateArgs throws on unknown args", () => {
  const bridge = createMcpBridge({});
  let threw = false;
  try {
    bridge.validateArgs("tossinvest_status", { unknown_field: 1 });
  } catch (e) {
    threw = true; assert.equal(e.code, "INVALID_PARAMS");
  }
  assert.ok(threw);
});

test("handle throws UNAVAILABLE when escalationManager missing", async () => {
  const bridge = createMcpBridge({});
  let threw = false;
  try {
    await bridge.handle("tossinvest_escalate", {
      severity: "warn", summary: "x", options: [{ id: "a", label: "A" }],
    });
  } catch (e) {
    threw = true; assert.equal(e.code, "UNAVAILABLE");
  }
  assert.ok(threw);
});

test("handle throws UNAVAILABLE when lifecycleManager missing", async () => {
  const bridge = createMcpBridge({});
  let threw = false;
  try { await bridge.handle("tossinvest_lifecycle_list", {}); } catch (e) {
    threw = true; assert.equal(e.code, "UNAVAILABLE");
  }
  assert.ok(threw);
});

test("audit callback is invoked on handle", async () => {
  const auditEvents = [];
  const bridge = createMcpBridge({
    escalationManager: { stats: function() { return {}; } },
    lifecycleManager: { stats: function() { return {}; } },
    audit: function(e) { auditEvents.push(e); },
  });
  await bridge.handle("tossinvest_status", {});
  assert.ok(auditEvents.length >= 1);
  assert.equal(auditEvents[0].event, "tossinvest_status");
});

test("stats tracks call counts by tool", async () => {
  const bridge = createMcpBridge({
    escalationManager: { stats: function() { return {}; } },
    lifecycleManager: { stats: function() { return {}; } },
  });
  await bridge.handle("tossinvest_status", {});
  await bridge.handle("tossinvest_status", {});
  const s = bridge.stats();
  assert.equal(s.calls, 2);
  assert.equal(s.byTool.tossinvest_status, 2);
});