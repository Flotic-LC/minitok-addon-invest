#!/usr/bin/env node
"use strict";

/**
 * Adaptive-Target engine status CLI.
 *
 * Reads the persisted state file (default ~/.minitok-addon-tossinvest/target-state.json)
 * and prints the current phase, daily target, effective limits, and whether the
 * engine is currently halted. This is a read-only diagnostic — it performs no
 * network calls and never places orders.
 *
 * Usage:
 *   node bin/target-status.js
 *   node bin/target-status.js --state ./state.json
 *   node bin/target-status.js --json     # emit machine-readable JSON
 */

const path = require("node:path");
const { createTargetEngine, DEFAULT_STATE_PATH } = require("../src/agent/target");

function parseArgs(argv) {
  const out = { state: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json" || a === "-j") out.json = true;
    else if (a === "--state" || a === "-s") out.state = argv[i + 1], (i += 1);
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write("Usage: node bin/target-status.js [--state <path>] [--json]\n");
    return 0;
  }

  const statePath = args.state || process.env.TOSSINVEST_TARGET_STATE || DEFAULT_STATE_PATH;
  const eng = createTargetEngine({ statePath });
  const lim = eng.getEffectiveLimits();
  const proj = eng.project();
  const st = eng.getState();

  const result = {
    statePath,
    phase: lim.phase,
    phaseName: lim.phaseName,
    baseTargetPct: lim.baseTargetPct,
    dryRun: lim.dryRun,
    maxOrderValueKrw: lim.maxOrderValueKrw,
    halted: proj.halted,
    haltReason: st.haltState.reason,
    operationCycles: st.operationCycles.length,
    returnCycles: st.returnCycles.length,
    highWaterEquity: st.highWaterEquity,
    lastEscalationAt: st.lastEscalationAt,
    updatedAt: st.updatedAt,
    reasons: proj.reasons,
  };

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    const lines = [
      "TossInvest Adaptive Target Engine — status",
      "────────────────────────────────────────────",
      `state file       : ${result.statePath}`,
      `phase            : ${result.phase} (${result.phaseName})`,
      `base target      : ${result.baseTargetPct}% / day`,
      `dryRun enforced  : ${result.dryRun}`,
      `max order value  : ${result.maxOrderValueKrw.toLocaleString()} KRW`,
      `halted           : ${result.halted}${result.haltReason ? ` (${result.haltReason})` : ""}`,
      `operation cycles : ${result.operationCycles}`,
      `return cycles    : ${result.returnCycles}`,
      `high-water equity: ${result.highWaterEquity ? Number(result.highWaterEquity).toLocaleString() : "—"}`,
      `last escalation  : ${result.lastEscalationAt || "—"}`,
      `updated          : ${result.updatedAt}`,
      `reasons          : ${result.reasons.join("; ")}`,
    ];
    process.stdout.write(lines.join("\n") + "\n");
  }
  return 0;
}

process.exitCode = main();
