"use strict";
// patch-heartbeat.js — adds heartbeat-based wakeup to tossinvest bot + sentinel
const fs = require("fs");

const RUNNER = "/opt/minitok/addons/tossinvest/runner.js";
const SENTINEL = "/opt/minitok/addons/tossinvest/sentinel.js";

// ========== runner.js ==========
let runner = fs.readFileSync(RUNNER, "utf8");
fs.writeFileSync(RUNNER + ".bak-heartbeat", runner);
let rPatched = 0;

// Patch 1: reset wsReconnectAttempts on successful WS connect
const r1_old = "      wsClient.subscribe(subs);\n    } catch (e) {";
const r1_new = "      wsClient.subscribe(subs);\n      wsReconnectAttempts = 0; // reset backoff on successful reconnect\n    } catch (e) {";
if (runner.includes(r1_old)) {
  runner = runner.replace(r1_old, r1_new);
  rPatched++;
  console.log("[runner] patch 1 OK: wsReconnectAttempts reset on success");
} else {
  console.log("[runner] WARN: patch 1 marker not found");
}

// Patch 2: heartbeat file writer after "Bot is running"
const r2_marker = '  console.log("[runner] Bot is running. Press Ctrl+C to stop.");';
const r2_insert = '  console.log("[runner] Bot is running. Press Ctrl+C to stop.");\n' +
  '\n' +
  '  // --- Heartbeat: write timestamp for sentinel staleness detection ---\n' +
  '  const HEARTBEAT_PATH = path.join(__dirname, ".heartbeat");\n' +
  '  const HEARTBEAT_INTERVAL_MS = 30000; // 30s\n' +
  '  try { fs.writeFileSync(HEARTBEAT_PATH, String(Date.now())); } catch {}\n' +
  '  setInterval(function() {\n' +
  '    try { fs.writeFileSync(HEARTBEAT_PATH, String(Date.now())); } catch {}\n' +
  '  }, HEARTBEAT_INTERVAL_MS);';
if (runner.includes(r2_marker)) {
  runner = runner.replace(r2_marker, r2_insert);
  rPatched++;
  console.log("[runner] patch 2 OK: heartbeat writer added");
} else {
  console.log("[runner] WARN: patch 2 marker not found");
}

fs.writeFileSync(RUNNER, runner);

// ========== sentinel.js ==========
let sentinel = fs.readFileSync(SENTINEL, "utf8");
fs.writeFileSync(SENTINEL + ".bak-heartbeat", sentinel);
let sPatched = 0;

// Patch 3: heartbeat staleness check before log-based checks
const s3_marker = "  // 2. Check recent logs for errors";
const s3_insert =
  '  // 1.5 Check heartbeat staleness — process alive but unresponsive\n' +
  '  const HEARTBEAT_FILE = "/opt/minitok/addons/tossinvest/.heartbeat";\n' +
  '  const HEARTBEAT_STALE_MS = Number(process.env.HEARTBEAT_STALE_MS || 180000); // 3 min\n' +
  '  try {\n' +
  '    const hbStat = fs.statSync(HEARTBEAT_FILE);\n' +
  '    const hbAge = Date.now() - hbStat.mtimeMs;\n' +
  '    if (hbAge > HEARTBEAT_STALE_MS) {\n' +
  '      const ageMin = Math.round(hbAge / 60000);\n' +
  '      log("CRITICAL: Heartbeat stale for " + ageMin + " min. Restarting bot...");\n' +
  '      sendTelegram("\ud83d\udea8 *Heartbeat Stale*: No heartbeat for " + ageMin + " min. Auto-restarting tossinvest bot...");\n' +
  '      exec("systemctl restart " + BOT_SERVICE);\n' +
  '      return;\n' +
  '    }\n' +
  '  } catch (e) {\n' +
  '    // Heartbeat file missing — grace period on first startup\n' +
  '  }\n' +
  '\n' +
  '  // 2. Check recent logs for errors';
if (sentinel.includes(s3_marker)) {
  sentinel = sentinel.replace(s3_marker, s3_insert);
  sPatched++;
  console.log("[sentinel] patch OK: heartbeat staleness check added");
} else {
  console.log("[sentinel] WARN: patch marker not found");
}

fs.writeFileSync(SENTINEL, sentinel);

console.log("\nDone: runner.js " + rPatched + "/2 patches, sentinel.js " + sPatched + "/1 patches applied.");
if (rPatched < 2 || sPatched < 1) {
  console.log("WARNING: Some patches were NOT applied. Check markers.");
  process.exit(1);
}