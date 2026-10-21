"use strict";
// patch-heartbeat-2.js — add Telegram cooldown to heartbeat-stale alert in sentinel.js
const fs = require("fs");
const SENTINEL = "/opt/minitok/addons/tossinvest/sentinel.js";
let s = fs.readFileSync(SENTINEL, "utf8");

if (s.includes('shouldAlert("heartbeat-stale")')) {
  console.log("Already patched — skipping.");
  process.exit(0);
}

const lines = s.split("\n");
let patched = false;
for (let i = 0; i < lines.length; i++) {
  if (
    lines[i].includes("Auto-restarting tossinvest bot") &&
    lines[i].includes("sendTelegram") &&
    !lines[i].includes("shouldAlert")
  ) {
    fs.writeFileSync(SENTINEL + ".bak-heartbeat2", s);
    lines[i] = lines[i].replace(
      "sendTelegram(",
      'if (shouldAlert("heartbeat-stale")) sendTelegram('
    );
    patched = true;
    console.log("Patched sentinel.js line " + (i + 1));
  }
}

if (!patched) {
  console.log("ERROR: heartbeat-stale sendTelegram line not found.");
  process.exit(1);
}

fs.writeFileSync(SENTINEL, lines.join("\n"));
console.log("Done: Telegram cooldown added for heartbeat-stale alerts (1h via ALERT_COOLDOWN_MS).");
