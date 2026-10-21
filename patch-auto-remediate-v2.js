"use strict";
// patch-auto-remediate-v2.js — add automatic remediation to sentinel.js
const fs = require("fs");
const F = "/opt/minitok/addons/tossinvest/sentinel.js";
let src = fs.readFileSync(F, "utf8");

if (src.includes("auto-remediate-v2")) {
  console.log("Already patched.");
  process.exit(0);
}

fs.writeFileSync(F + ".bak-remediate-v2", src);
const lines = src.split("\n");
const out = [];
const done = { helpers: 0, patterns: 0, count: 0, prompt: 0, ai: 0, decay: 0 };

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];

  // Replace AI prompt line with structured ACTION request
  if (!done.prompt && line.includes("Respond in Korean, max 5 lines, concise. If everything looks normal")) {
    out.push('    "Respond in Korean, max 5 lines, concise.",');
    out.push('    "IMPORTANT: End your response with exactly one line: ACTION:NONE or ACTION:RESTART_BOT.",');
    out.push('    "Use ACTION:RESTART_BOT only for repeated errors, token revocation, stalled bot, or persistent WS/API failure.",');
    done.prompt = 1;
    continue;
  }

  // Insert consecutive-error counting before cooldown alert comment
  if (!done.count && line.includes("// Only send Telegram alert if cooldown has passed for this pattern")) {
    out.push("        // auto-remediate-v2: count repeated errors and auto-restart");
    out.push("        const errCount = (consecutiveErrors.get(pattern) || 0) + 1;");
    out.push("        consecutiveErrors.set(pattern, errCount);");
    out.push("        if (errCount >= CONSECUTIVE_ERROR_THRESHOLD && canRemediate()) {");
    out.push("          executeRemediation(pattern + ' repeated ' + errCount + ' cycles');");
    out.push("          return;");
    out.push("        }");
    done.count = 1;
  }

  // Insert counter decay before universe check
  if (!done.decay && line.includes("// 3. Check universe size from logs")) {
    out.push("  // auto-remediate-v2: decay error counters when pattern is absent");
    out.push("  for (const [key, count] of consecutiveErrors) {");
    out.push("    if (count > 0 && !logs.includes(key)) {");
    out.push("      consecutiveErrors.set(key, Math.max(0, count - 1));");
    out.push("    }");
    out.push("  }");
    out.push("");
    done.decay = 1;
  }

  out.push(line);

  // Insert remediation helpers after alert cooldown map
  if (!done.helpers && line.includes("const lastAlertAt = new Map();")) {
    out.push("");
    out.push("// auto-remediate-v2: automatic remediation state");
    out.push("const consecutiveErrors = new Map();");
    out.push("let lastRemediationAt = 0;");
    out.push("const REMEDIATION_COOLDOWN_MS = Number(process.env.REMEDIATION_COOLDOWN_MS || 1800000);");
    out.push("const CONSECUTIVE_ERROR_THRESHOLD = Number(process.env.CONSECUTIVE_ERROR_THRESHOLD || 3);");
    out.push("");
    out.push("function canRemediate() {");
    out.push("  const now = Date.now();");
    out.push("  if (now - lastRemediationAt < REMEDIATION_COOLDOWN_MS) return false;");
    out.push("  lastRemediationAt = now;");
    out.push("  return true;");
    out.push("}");
    out.push("");
    out.push("function executeRemediation(reason) {");
    out.push("  log('[auto-remediate] Restarting ' + BOT_SERVICE + ' | Reason: ' + reason);");
    out.push("  if (shouldAlert('remediation')) {");
    out.push("    sendTelegram('🔧 Auto-Remediation | Reason: ' + reason + ' | Action: restart ' + BOT_SERVICE);");
    out.push("  }");
    out.push("  exec('systemctl restart ' + BOT_SERVICE);");
    out.push("  consecutiveErrors.clear();");
    out.push("}");
    done.helpers = 1;
  }

  // Add token error patterns
  if (!done.patterns && line.trim() === '"MODULE_NOT_FOUND"') {
    out[out.length - 1] = '  "MODULE_NOT_FOUND",';
    out.push('  "token-revoked",');
    out.push('  "token expired"');
    done.patterns = 1;
  }

  // Parse AI ACTION after analysis log
  if (!done.ai && line.includes('log("AI Analysis: " + analysis.substring(0, 200));')) {
    out.push("");
    out.push("    // auto-remediate-v2: execute AI-recommended remediation");
    out.push("    const actionMatch = analysis.match(/ACTION:(RESTART_BOT|NONE)/);");
    out.push("    const aiAction = actionMatch ? actionMatch[1] : 'NONE';");
    out.push("    if (aiAction === 'RESTART_BOT' && canRemediate()) {");
    out.push("      executeRemediation('AI analysis recommended RESTART_BOT');");
    out.push("    }");
    done.ai = 1;
  }
}

if (!Object.values(done).every(Boolean)) {
  console.log(JSON.stringify(done));
  console.log("ERROR: missing markers; no changes written.");
  process.exit(1);
}

fs.writeFileSync(F, out.join("\n"));
console.log(JSON.stringify(done));
console.log("Auto-remediation v2 patch applied.");
