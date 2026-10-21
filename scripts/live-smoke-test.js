#!/usr/bin/env node
"use strict";

/**
 * The read-only live smoke test.
 *
 * [2026-10-21 9단계] Before a strategy is allowed near real money, the
 * things that would stop it from working have to be checked against the
 * real broker - but WITHOUT placing an order. This script therefore never
 * calls an order endpoint, and it says so in its output.
 *
 * It verifies:
 *   1. the entitlement: the server confirms this installation is entitled
 *   2. the ownership: the entitlement belongs to this installation
 *   3. the position read: the broker's holdings are readable
 *   4. the reconciliation: the runner's local positions match the broker's
 *
 * Usage: node scripts/live-smoke-test.js
 */

const fs = require("fs");
const path = require("path");

const results = [];
function record(name, ok, detail) {
  results.push({ name: name, ok: !!ok, detail: detail || "" });
  console.log((ok ? "OK   " : "FAIL ") + name + (detail ? " - " + detail : ""));
}

async function main() {
  console.log("=== live smoke test (read-only: no order is placed) ===");
  console.log("");

  // 1. The entitlement.
  try {
    const ent = require("../src/auth/entitlement");
    const artifact = ent.loadArtifact({
      path: process.env.MINITOK_ENTITLEMENT_PATH,
      entitlement: process.env.MINITOK_ENTITLEMENT,
    });
    const verdict = await ent.verifyEntitlement({
      serverUrl: process.env.MINITOK_SERVER_URL,
      token: process.env.MINITOK_INSTALLATION_TOKEN,
      entitlement: artifact,
      expectedInstallationId: process.env.MINITOK_INSTALLATION_ID,
      minPlanId: process.env.MINITOK_ADDON_MIN_PLAN_ID,
      graceMs: Number(process.env.MINITOK_ENTITLEMENT_GRACE_MS || 0),
    });
    record("the entitlement is valid", verdict.allowed, "state=" + verdict.state + " plan=" + (verdict.plan || "-"));
  } catch (e) {
    record("the entitlement is valid", false, e && e.message);
  }

  // 2. The ownership: the artifact must belong to this installation.
  try {
    const ent = require("../src/auth/entitlement");
    const artifact = ent.loadArtifact({
      path: process.env.MINITOK_ENTITLEMENT_PATH,
      entitlement: process.env.MINITOK_ENTITLEMENT,
    });
    const expected = String(process.env.MINITOK_INSTALLATION_ID || "").trim();
    const actual = artifact && artifact.payload ? String(artifact.payload.installation_id || "") : "";
    if (!expected) {
      record("the ownership matches", false, "MINITOK_INSTALLATION_ID is not set - the ownership cannot be checked");
    } else {
      record("the ownership matches", expected === actual, "expected " + expected + ", the entitlement carries " + (actual || "none"));
    }
  } catch (e) {
    record("the ownership matches", false, e && e.message);
  }

  // 3. The position read.
  let holdings = null;
  try {
    const toss = require("../src/tossinvest");
    const { clientId, clientSecret } = require("../src/core/credentials");
    const token = await toss.fetchAccessToken(clientId, clientSecret);
    const resp = await toss.getHoldings(token, process.env.TOSS_ACCOUNT_SEQ || "0");
    const body = resp && resp.body ? resp.body : [];
    holdings = Array.isArray(body) ? body : (body.holdings || body.items || []);
    record("the broker's positions are readable", true, holdings.length + " position(s)");
  } catch (e) {
    record("the broker's positions are readable", false, e && e.message);
  }

  // 4. The reconciliation: the runner's local positions against the broker's.
  try {
    const STATE_DIR = process.env.STATE_DIR || path.join(__dirname, "..", "state");
    const stateFile = path.join(STATE_DIR, ".runner-state.json");
    const local = {};
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      const pos = (raw && raw.positions) || (raw && raw.portfolio && raw.portfolio.positions) || [];
      for (const p of pos) local[String(p.symbol || "").toUpperCase()] = Number(p.quantity) || 0;
    } catch (e) { /* no local state: the check is reported as not applicable */ }
    if (!holdings) {
      record("the state reconciles with the broker", false, "the broker's positions could not be read");
    } else if (!Object.keys(local).length) {
      record("the state reconciles with the broker", true, "not applicable - the runner has no persisted positions");
    } else {
      const diffs = [];
      for (const h of holdings) {
        const sym = String(h.symbol || h.code || "").toUpperCase();
        const qty = Number(h.quantity) || 0;
        if (local[sym] != null && Math.abs(local[sym] - qty) > 1e-6) diffs.push(sym + ": local " + local[sym] + " vs broker " + qty);
        if (local[sym] == null && qty !== 0) diffs.push(sym + ": the broker holds " + qty + " and the runner does not know it");
      }
      record("the state reconciles with the broker", diffs.length === 0, diffs.length ? diffs.join("; ") : "the local and broker positions agree");
    }
  } catch (e) {
    record("the state reconciles with the broker", false, e && e.message);
  }

  console.log("");
  const failed = results.filter(function (r) { return !r.ok; });
  console.log("=== " + (results.length - failed.length) + "/" + results.length + " checks passed ===");
  if (failed.length) {
    console.log("the strategy is NOT ready for live: " + failed.length + " check(s) failed");
    process.exit(1);
  }
  console.log("the read-only checks passed. A promotion still needs the paper criteria to pass.");
}

if (require.main === module) {
  main().catch(function (e) {
    console.error("[smoke] " + (e && e.message));
    process.exit(1);
  });
}

module.exports = { main: main };
