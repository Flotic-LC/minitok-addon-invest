"use strict";
// patch-telegram-v2.js — reduce Telegram noise in sentinel.js
// Keep only: crash restart, heartbeat stale, fatal/halted restart (all with cooldown)
// Remove: no-trade alert, AI analysis alert, startup alert, non-fatal error patterns
const fs = require("fs");
const F = "/opt/minitok/addons/tossinvest/sentinel.js";
let src = fs.readFileSync(F, "utf8");

if (src.includes("telegram-noise-patch-v1")) {
  console.log("Already patched. Nothing to do.");
  process.exit(0);
}

fs.writeFileSync(F + ".bak-telegram", src);
let lines = src.split("\n");
let counts = { crash: 0, err: 0, noTrade: 0, ai: 0, startup: 0 };
let inNoTrade = false;
let noTradeIndent = "";

for (let i = 0; i < lines.length; i++) {
  let line = lines[i];

  // Inside multi-line no-trade sendTelegram block comment
  if (inNoTrade) {
    if (line.includes(");")) {
      lines[i] = line + "\n" + noTradeIndent + "*/";
      inNoTrade = false;
      counts.noTrade++;
    }
    continue;
  }

  // 1. Bot crash: add cooldown
  if (line.includes("sendTelegram(") && line.includes("*CRITICAL*: tossinvest bot stopped") && !line.includes("shouldAlert")) {
    lines[i] = line.replace("sendTelegram(", 'if (shouldAlert("bot-crash")) sendTelegram(');
    counts.crash++;
    continue;
  }

  // 2. Non-fatal error pattern: comment out sendTelegram, keep log
  if (line.includes("sendTelegram(") && line.includes("*WARNING*: Error detected")) {
    const indent = line.match(/^\s*/)[0];
    lines[i] = indent + "// telegram-noise-patch-v1: non-fatal error pattern log only\n" + indent + "// " + line.trim();
    counts.err++;
    continue;
  }

  // 3. No-trade alert: wrap in block comment (multi-line sendTelegram)
  if (line.trim() === "sendTelegram(" && lines[i + 1] && lines[i + 1].includes("No Trading Activity")) {
    const indent = line.match(/^\s*/)[0];
    noTradeIndent = indent;
    lines[i] = indent + "/* telegram-noise-patch-v1: no-trade Telegram removed (normal during market closure)\n" + line;
    inNoTrade = true;
    continue;
  }

  // 4. AI analysis: comment out sendTelegram, keep log
  if (line.includes("sendTelegram(") && line.includes("analysis.substring")) {
    const indent = line.match(/^\s*/)[0];
    lines[i] = indent + "// telegram-noise-patch-v1: AI analysis log only\n" + indent + "// " + line.trim();
    counts.ai++;
    continue;
  }

  // 5. Startup notification: comment out
  if (line.includes("sendTelegram(") && line.includes("Sentinel Online")) {
    const indent = line.match(/^\s*/)[0];
    lines[i] = indent + "// telegram-noise-patch-v1: startup notification removed\n" + indent + "// " + line.trim();
    counts.startup++;
    continue;
  }
}

if (inNoTrade) {
  console.error("ERROR: unterminated no-trade sendTelegram block");
  process.exit(1);
}

lines.unshift("// telegram-noise-patch-v1: Telegram alerts limited to critical restarts");
fs.writeFileSync(F, lines.join("\n"));
console.log(JSON.stringify(counts));
const total = counts.crash + counts.err + counts.noTrade + counts.ai + counts.startup;
if (total < 5) {
  console.log("WARNING: expected 5 patches, got " + total);
  process.exit(1);
}
console.log("Done: Telegram noise reduced. Critical restart alerts remain.");
