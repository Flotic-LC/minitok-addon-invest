#!/usr/bin/env node
"use strict";

/**
 * The operator's unit-economics report.
 *
 * [2026-10-21 8단계] The numbers a pricing decision needs, from the usage
 * the runner actually recorded:
 *
 *   - what the account paid (the plan price)
 *   - what the account cost (the model calls and their tokens, the broker
 *     calls, the market data calls, the notifications, the storage, the
 *     compute, the headless browser)
 *   - the margin, and whether that margin is measured or only estimated
 *   - which usage pattern the account represents
 *
 * The cost of every line comes from the COST_* environment variables. A
 * line whose cost is still zero is reported as an estimate with a zero
 * value, and the report says so: a margin computed from unpriced items is
 * not a margin, it is a hypothesis.
 *
 * Usage: node scripts/unit-economics-report.js [--json out.json] [--month YYYY-MM]
 */

const fs = require("fs");
const path = require("path");

const ue = require("../src/ops/unit-economics");

const STATE_DIR = process.env.STATE_DIR || path.join(__dirname, "..", "state");
const STATE_FILE = path.join(STATE_DIR, ".runner-state.json");

function envNum(name, dflt) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : (dflt || 0);
}

/** The cost model. Every line is an estimate until an operator prices it. */
function costModel() {
  return {
    llm: { perCall: envNum("COST_LLM_PER_CALL", 0), per1kTokens: envNum("COST_LLM_PER_1K_TOKENS", 0), source: process.env.COST_SOURCE_LLM || "estimated", label: "model API" },
    broker: { perCall: envNum("COST_BROKER_PER_CALL", 0), source: process.env.COST_SOURCE_BROKER || "estimated", label: "broker API" },
    marketData: { perCall: envNum("COST_MARKET_DATA_PER_CALL", 0), source: process.env.COST_SOURCE_MARKET_DATA || "estimated", label: "market data" },
    notification: { perMessage: envNum("COST_NOTIFICATION_PER_MESSAGE", 0), source: process.env.COST_SOURCE_NOTIFICATION || "estimated", label: "notifications" },
    storage: { perMbMonth: envNum("COST_STORAGE_PER_MB_MONTH", 0), source: process.env.COST_SOURCE_STORAGE || "estimated", label: "storage" },
    server: { perCpuSecond: envNum("COST_SERVER_PER_CPU_SECOND", 0), perMemoryMbHour: envNum("COST_SERVER_PER_MEMORY_MB_HOUR", 0), source: process.env.COST_SOURCE_SERVER || "estimated", label: "server compute" },
    browser: { perRun: envNum("COST_BROWSER_PER_RUN", 0), source: process.env.COST_SOURCE_BROWSER || "estimated", label: "headless browser" },
  };
}

function loadUsage() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (raw && raw.usageLedger) return raw.usageLedger;
  } catch (e) {
    // No state yet: the report says so rather than printing zeros as if they
    // were a measurement.
  }
  return null;
}

function main() {
  const args = process.argv.slice(2);
  let jsonOut = null;
  let month = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json" && args[i + 1]) { jsonOut = args[++i]; }
    if (args[i] === "--month" && args[i + 1]) { month = args[++i]; }
  }

  const usage = loadUsage();
  const report = {
    generatedAt: new Date().toISOString(),
    month: month || (usage && usage.month) || null,
    account: usage && usage.account ? usage.account : null,
    usageAvailable: !!usage,
    costModel: costModel(),
    economics: null,
    segments: null,
    controls: ue.CONTROL_OPTIONS,
    notes: [],
  };

  if (!usage) {
    report.notes.push("no usage was recorded yet - the runner writes it into " + STATE_FILE + " every 5 minutes");
  } else {
    const econ = ue.computeAccountEconomics({
      account: usage.account,
      planId: process.env.UNIT_ECONOMICS_PLAN_ID || "level1",
      usage: Object.assign({}, usage.usage, { lastActiveAt: usage.lastActiveAt }),
      costs: report.costModel,
      months: 1,
    });
    report.economics = econ;
    report.segments = econ.segments;
    const policy = ue.decideCostPolicy({
      economics: econ,
      usage: Object.assign({}, usage.usage, { days: usage.days, today: usage.days && Object.keys(usage.days).sort().pop() }),
      controls: {
        dailyLlmCalls: envNum("COST_DAILY_LLM_CALL_QUOTA", 0),
        dailyBrokerCalls: envNum("COST_DAILY_BROKER_CALL_QUOTA", 0),
        notificationsPerDay: envNum("COST_NOTIFICATIONS_PER_DAY", 0),
        cheapModelAfterTokens: envNum("COST_CHEAP_MODEL_AFTER_TOKENS", 0),
        minMarginPct: envNum("COST_MIN_MARGIN_PCT", 0),
      },
    });
    report.policy = policy;
    if (econ.marginIsEstimated) {
      report.notes.push("the cost is entirely estimated - the margin below is a hypothesis, not a measurement");
    }
  }

  const text = render(report);
  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2), "utf8");
    console.log("[unit-economics] wrote " + jsonOut);
  }
  console.log(text);
}

function money(n) {
  return (Number(n) || 0).toFixed(2);
}

function render(r) {
  const lines = [];
  lines.push("=== unit economics " + (r.month || "(no month)") + " ===");
  lines.push("account : " + (r.account || "(none)"));
  lines.push("generated: " + r.generatedAt);
  if (!r.economics) {
    lines.push("");
    lines.push("no usage has been recorded yet.");
    for (const n of r.notes) lines.push("  - " + n);
    return lines.join("\n");
  }
  const e = r.economics;
  lines.push("");
  lines.push("usage   : " + e.usage.llmCalls + " model calls, " + e.usage.llmTotalTokens + " tokens, "
    + e.usage.brokerCalls + " broker calls, " + e.usage.marketDataCalls + " market-data calls, "
    + e.usage.notifications + " notifications, " + e.usage.trades + " trades");
  lines.push("");
  lines.push("cost    :");
  for (const i of e.cost.items) {
    lines.push("  " + i.label.padEnd(20) + money(i.amount).padStart(12) + "  [" + i.source + "]" + (i.source === "estimated" ? "  (price it with the COST_* variables)" : ""));
  }
  lines.push("  " + "TOTAL".padEnd(20) + money(e.cost.total).padStart(12));
  lines.push("");
  lines.push("revenue : " + money(e.revenue) + " (plan " + e.plan + ")");
  lines.push("margin  : " + money(e.margin) + (e.marginPct != null ? "  (" + e.marginPct.toFixed(1) + "%)" : ""));
  if (e.marginIsEstimated) lines.push("          ^ the cost is estimated, so this margin is a hypothesis");
  lines.push("segments: " + (e.segments.length ? e.segments.join(", ") : "(normal)"));
  for (const reason of e.segmentReasons) lines.push("  - " + reason);
  if (e.flags.length) {
    lines.push("");
    lines.push("flags   :");
    for (const f of e.flags) lines.push("  - " + f);
  }
  if (r.policy) {
    lines.push("");
    lines.push("policy  : " + r.policy.action + " - " + r.policy.reason);
  }
  if (r.notes.length) {
    lines.push("");
    for (const n of r.notes) lines.push("note: " + n);
  }
  return lines.join("\n");
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error("[unit-economics] " + (e && e.message));
    process.exit(1);
  }
}

module.exports = { costModel: costModel, render: render };
