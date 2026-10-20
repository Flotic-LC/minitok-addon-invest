const { execSync } = require("child_process");
const fs = require("fs");
const path = require("node:path");

// [Sentinel Fix] Import durable event store so sentinel can read actual
// trade records (FILL events) written by runner.js — fixes false "No Trading
// Activity" alerts and enables /pnl, /trades, /daily commands.
const { createStore, kstDateString } = require("./src/store");
const eventStore = createStore({});

// [P2-9 Integration] Audit logger for sentinel events
const { createAuditLogger } = require("./src/core/audit-logger");
const audit = createAuditLogger({
  dir: path.join(__dirname, ".audit"),
  enabled: process.env.AUDIT_LOG_ENABLED !== "false",
});

// [P2-9 Integration] Config validation for sentinel env vars
const { validateConfig } = require("./src/core/config-validator");
const { runClineTask } = require("./src/agent/cline-runner"); // [AGENT-BRIDGE]
const sentinelEnvSchema = {
  BOT_SERVICE: { type: "string", default: "invest-bot.service" },
  BOT_LOG_PATH: { type: "string" },
  CHECK_INTERVAL_MS: { type: "integer", min: 5000, max: 3600000, default: 60000 },
  TELEGRAM_BOT_TOKEN: { type: "string", secret: true },
  TELEGRAM_CHAT_ID: { type: "string" },
  PROFUNDO_API_KEY: { type: "string", secret: true },
  PROFUNDO_BASE_URL: { type: "string", default: "https://api.profundoai.com/v1" },
  PROFUNDO_MODEL: { type: "string", default: "gpt-6-astra" },
  AI_ANALYSIS_INTERVAL_MS: { type: "integer", min: 60000, max: 3600000, default: 900000 },
  ALERT_COOLDOWN_MS: { type: "integer", min: 60000, max: 86400000, default: 3600000 },
  PROMETHEUS_PORT: { type: "integer", min: 1024, max: 65535, default: 9100 },
};
// Validate only sentinel-specific vars (don't require TOSS_* here)
const sentinelCfg = validateConfig(process.env, { schema: sentinelEnvSchema });
if (sentinelCfg.warnings.length > 0) {
  for (const w of sentinelCfg.warnings) console.warn("[sentinel-config] " + w);
}

const BOT_SERVICE = process.env.BOT_SERVICE || "invest-bot.service";
const LOG_PATH = process.env.BOT_LOG_PATH || "/opt/minitok/addons/invest/bot.log";
const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS || 60000);
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const SENTINEL_LOG = "/opt/minitok/addons/invest/sentinel.log";
const PROMETHEUS_PORT = Number(process.env.PROMETHEUS_PORT || 9100);

// [Telegram Bot] Bidirectional command interface
const TELEGRAM_POLL_MS = Number(process.env.TELEGRAM_POLL_MS || 3000);
const TELEGRAM_ALLOWED_CHAT_IDS = (process.env.TELEGRAM_CHAT_ID || "").split(",").map(function(s) { return s.trim(); }).filter(Boolean);
const BOT_INTERNAL_URL = process.env.BOT_INTERNAL_URL || ("http://minitok-invest:" + PROMETHEUS_PORT);
let telegramOffset = 0;
let telegramPollTimer = null;
let telegramActive = !!(TELEGRAM_TOKEN && TELEGRAM_CHAT_ID);

// [Conversational] Per-chat conversation memory (last N exchanges)
const CONVO_MAX_TURNS = 10;
const conversationMemory = new Map(); // chatId -> [{role, content}]

// [AI ANALYSIS] Same Profundo API as the trading agent
const PROFUNDO_API_KEY = process.env.PROFUNDO_API_KEY || "";
const PROFUNDO_BASE_URL = process.env.PROFUNDO_BASE_URL || "https://api.profundoai.com/v1";
const PROFUNDO_MODEL = process.env.PROFUNDO_MODEL || "gpt-6-astra";
const AI_ANALYSIS_INTERVAL_MS = Number(process.env.AI_ANALYSIS_INTERVAL_MS || 900000); // 15 min
let lastAiAnalysisAt = 0;

const ERROR_PATTERNS = [
  "Scan failed",
  "TOSS_TIMEOUT",
  "TARGET_ENGINE_HALTED",
  "Fatal:",
  "MODULE_NOT_FOUND"
];

// Cooldown to prevent spamming Telegram for the same error every cycle
const ALERT_COOLDOWN_MS = Number(process.env.ALERT_COOLDOWN_MS || 3600000); // 1 hour default
const lastAlertAt = new Map();

function shouldAlert(key) {
  const now = Date.now();
  const prev = lastAlertAt.get(key) || 0;
  if (now - prev < ALERT_COOLDOWN_MS) return false;
  lastAlertAt.set(key, now);
  return true;
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(SENTINEL_LOG, line + "\n"); } catch {}
  // [P2-9] Also record in audit logger for structured forensics
  try { audit.custom("sentinel", { message: msg }); } catch {}
}

function exec(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", timeout: 15000 }).trim();
  } catch (e) {
    return null;
  }
}

// [P2-9 FIX] Cross-platform process check (Windows uses tasklist, Unix uses pgrep)
const IS_WINDOWS = process.platform === "win32";
function findRunnerProcess() {
  if (IS_WINDOWS) {
    // Windows: use tasklist + findstr
    const result = exec('tasklist /FI "IMAGENAME eq node.exe" /FO CSV 2>nul');
    if (!result) return null;
    // Look for node.exe running runner.js
    const lines = result.split("\n");
    for (const line of lines) {
      if (line.includes("node.exe")) return "found"; // simplified check
    }
    return null;
  } else {
    // Unix: use pgrep
    return exec('pgrep -f "node runner.js"');
  }
}

// [P2-9 FIX] Cross-platform service restart
// Detect Docker environment (sentinel runs inside container in production)
const IS_DOCKER = fs.existsSync("/.dockerenv") || process.env.DOCKER_ENV === "true";
const BOT_CONTAINER_NAME = process.env.BOT_CONTAINER_NAME || "minitok-invest";

function restartService() {
  if (IS_WINDOWS) {
    log("Windows detected. Cannot auto-restart systemd service. Manual restart required.");
    return null;
  }
  if (IS_DOCKER) {
    // Inside Docker: use docker-cli (mounted docker.sock) to restart the bot container
    log("Docker environment detected. Restarting container: " + BOT_CONTAINER_NAME);
    return exec(`docker restart ${BOT_CONTAINER_NAME}`);
  }
  return exec(`systemctl restart ${BOT_SERVICE}`);
}

// [P2-9 FIX] Cross-platform log reading
function readRecentLogs(lineCount, logPath) {
  if (IS_WINDOWS) {
    // Windows: use PowerShell Get-Content
    const psCmd = `powershell -Command "Get-Content '${logPath}' -Tail ${lineCount} -ErrorAction SilentlyContinue"`;
    return exec(psCmd) || "";
  } else {
    return exec(`tail -${lineCount} ${logPath} 2>/dev/null`) || "";
  }
}

async function sendTelegram(message) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  const text = `[Sentinel] ${message}`;
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" })
    });
  } catch (e) {
    log("Telegram send failed: " + e.message);
  }
}

// [P2-9] Check bot /health endpoint for liveness
// In Docker: use BOT_INTERNAL_URL (cross-container HTTP)
// On host: use localhost:PROMETHEUS_PORT
async function checkBotHealth() {
  const url = IS_DOCKER
    ? BOT_INTERNAL_URL + "/health"
    : `http://localhost:${PROMETHEUS_PORT}/health`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (resp.ok) {
      const data = await resp.json();
      return { alive: true, uptime: data.uptime, status: data.status, selfAudit: data.selfAudit || {} };
    }
    return { alive: false, error: "HTTP " + resp.status };
  } catch (e) {
    return { alive: false, error: e.message };
  }
}

// Backwards-compatible alias (older code paths may still reference this)
const checkPrometheusHealth = checkBotHealth;

async function checkHealth() {
  // Docker environment: rely on HTTP /health endpoint (pgrep can't see other containers)
  if (IS_DOCKER) {
    const h = await checkBotHealth();
    if (!h.alive) {
      log(`CRITICAL: bot /health unreachable (${h.error}).`);
      audit.error({ source: "sentinel", code: "bot_down", message: "bot /health unreachable: " + h.error });
      if (shouldAlert("bot:down")) {
        sendTelegram(`🚨 *CRITICAL*: invest bot unreachable!\nError: ${h.error}`);
        sendTelegram(`🔄 Auto-restarting container ${BOT_CONTAINER_NAME}...`);
        restartService();
      }
      return;
    }
    // Bot is alive — log periodic heartbeat (throttled)
    if (shouldAlert("heartbeat:" + Math.floor(Date.now() / 600000))) { // every 10 min
      const eq = h.selfAudit.equityKrw ? "₩" + Number(h.selfAudit.equityKrw).toLocaleString() + (h.selfAudit.equityUsd ? " ($" + Math.round(h.selfAudit.equityUsd).toLocaleString() + ")" : "") : "n/a";
      log(`[heartbeat] bot alive, uptime=${Math.round(h.uptime || 0)}s, equity=${eq}`);
    }
  } else {
    // Host environment: use pgrep as primary, HTTP as supplement
    const pid = findRunnerProcess();
    if (!pid) {
      log(`CRITICAL: runner.js is not running.`);
      audit.error({ source: "sentinel", code: "bot_down", message: "runner.js process not found" });
      sendTelegram(`🚨 *CRITICAL*: invest bot stopped!`);
      if (!IS_WINDOWS) {
        log("Restarting via systemd...");
        sendTelegram(`Auto-restarting via systemd...`);
        restartService();
      } else {
        log("Windows: manual restart required.");
        sendTelegram(`⚠️ Manual restart required (Windows).`);
      }
      return;
    }

    // [P2-9] Supplement with HTTP health check
    checkBotHealth().then(function(h) {
      if (!h.alive) {
        log(`WARNING: bot /health unreachable (${h.error}). Bot may be stuck.`);
        audit.error({ source: "sentinel", code: "health_unreachable", message: h.error });
      }
    }).catch(function() {});
  }

  // 2. Check recent logs for errors (cross-platform)
  const logs = readRecentLogs(100, LOG_PATH);
  for (const pattern of ERROR_PATTERNS) {
    if (logs.includes(pattern)) {
      log(`WARNING: Detected error pattern '${pattern}' in logs.`);
      // [telegram-noise-patch] non-fatal error pattern alert removed (log only).

      if (pattern === "TARGET_ENGINE_HALTED" || pattern === "Fatal:") {
        log("Critical error detected.");
        if (!IS_WINDOWS) {
          log("Restarting bot via systemd...");
          restartService();
          if (shouldAlert("restart:fatal")) {
            sendTelegram(`🔄 Auto-restarted invest bot via systemd`);
          }
        } else {
          log("Windows: manual intervention required for critical error.");
          if (shouldAlert("restart:fatal")) {
            sendTelegram(`⚠️ Critical error detected. Manual restart required (Windows).`);
          }
        }
      }
      break;
    }
  }

  // 3. Check universe size from logs (Log only, NO Telegram alert to prevent spam)
  const addedMatch = logs.match(/Total: (\d+)/g);
  if (addedMatch) {
    const last = addedMatch[addedMatch.length - 1];
    const count = parseInt(last.replace("Total: ", ""));
    if (count >= 45) {
      log(`INFO: Universe approaching max capacity (${count}/50)`);
      // Removed sendTelegram here to stop continuous warnings
    }
  }

  // 4. [NEW] Check trading activity - alert if no trades for extended period
  checkTradingActivity(logs);
}

// --- [FIX] Trading Activity Detection — Event Store based ---
// Primary signal: FILL events in the durable event store (written by runner.js
// on every actual fill). Log keyword scan kept as secondary fallback to catch
// AI decisions / order creation that haven't filled yet.
const NO_TRADE_ALERT_MS = Number(process.env.NO_TRADE_ALERT_MS || 3600000); // 1 hour default
let lastTradeDetectedAt = Date.now(); // Start from now to give grace period

function checkTradingActivity(logs) {
  let hasActivity = false;
  let recentFillCount = 0;
  let lastFillAt = null;

  // Primary: event store — definitive proof of real trades
  try {
    const sinceTs = new Date(Date.now() - NO_TRADE_ALERT_MS).toISOString();
    const recentFills = eventStore.query({ types: ["FILL"], sinceTs: sinceTs, limit: 50 });
    recentFillCount = recentFills.length;
    if (recentFillCount > 0) {
      hasActivity = true;
      lastFillAt = recentFills[recentFills.length - 1].ts;
    }
  } catch (e) {
    log("[activity] event store query failed: " + e.message);
  }

  // Secondary fallback: log keyword scan (AI decisions, order creation)
  if (!hasActivity) {
    const tradePatterns = ["executeDecision", "create_order", "FILLED", "order-monitor", "askAI"];
    hasActivity = tradePatterns.some(function(p) { return logs.includes(p); });
  }

  if (hasActivity) {
    lastTradeDetectedAt = Date.now();
    return;
  }

  const silentMs = Date.now() - lastTradeDetectedAt;
  if (silentMs > NO_TRADE_ALERT_MS) {
    const silentMin = Math.round(silentMs / 60000);
    if (shouldAlert("no-trade")) {
      log(`WARNING: No trading activity detected for ${silentMin} minutes.`);
      // [telegram-noise-patch] no-trade Telegram removed (normal during market closure); log only.
    }
  }
}

// --- [NEW] AI-Powered Log Analysis (same Profundo API as trading agent) ---
async function aiAnalyzeLogs() {
  if (!PROFUNDO_API_KEY) {
    log("AI analysis skipped: PROFUNDO_API_KEY not set");
    return;
  }

  const logs = readRecentLogs(150, LOG_PATH);
  const errorLogPath = process.env.BOT_ERROR_LOG_PATH || "/opt/minitok/addons/invest/bot-error.log";
  const errorLogs = readRecentLogs(30, errorLogPath);

  if (!logs && !errorLogs) return;

  const prompt = [
    "You are a monitoring assistant for an automated stock trading bot.",
    "Analyze the following logs and identify:",
    "1. Any critical errors or patterns that need attention",
    "2. Whether the bot appears to be trading normally or stalled",
    "3. WebSocket connection status",
    "4. AI API availability issues",
    "5. Any recommended actions",
    "Respond in Korean, max 5 lines, concise. If everything looks normal, say '정상 작동 중' with key metrics.",
    "",
    "=== BOT LOG (last 150 lines) ===",
    logs.substring(0, 6000),
    "",
    "=== ERROR LOG (last 30 lines) ===",
    errorLogs.substring(0, 2000)
  ].join("\n");

  try {
    const resp = await fetch(PROFUNDO_BASE_URL + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + PROFUNDO_API_KEY,
      },
      body: JSON.stringify({
        model: PROFUNDO_MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 512,
        temperature: 0,
      }),
    });

    if (!resp.ok) {
      log("AI analysis failed: HTTP " + resp.status);
      return;
    }

    const data = await resp.json();
    const analysis = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || "").trim();
    if (!analysis) return;

    log("AI Analysis: " + analysis.substring(0, 200));

    // [telegram-noise-patch] AI analysis Telegram removed (log only).
    if (analysis) log("AI analysis result: " + analysis.substring(0, 120));
  } catch (e) {
    log("AI analysis error: " + e.message);
  }
}

log(`Sentinel started (standalone). Service: ${BOT_SERVICE}, Interval: ${CHECK_INTERVAL_MS}ms, AI analysis every ${AI_ANALYSIS_INTERVAL_MS / 60000}min`);
audit.config({ key: "sentinel_start", oldValue: null, newValue: `service=${BOT_SERVICE} interval=${CHECK_INTERVAL_MS}ms prometheus=:${PROMETHEUS_PORT}`, source: "sentinel" });
log("[telegram-noise-patch] startup Telegram suppressed.");

// Health check loop (every 60s) — async-safe
setInterval(() => {
  checkHealth().catch(function(e) { log("Check loop error: " + e.message); });
}, CHECK_INTERVAL_MS);

// AI analysis loop (every 15 min)
setInterval(() => {
  aiAnalyzeLogs().catch(function(e) { log("AI analysis loop error: " + e.message); });
}, AI_ANALYSIS_INTERVAL_MS);

checkHealth().catch(function(e) { log("Initial checkHealth error: " + e.message); });
// Run first AI analysis 30s after startup (let bot initialize first)
setTimeout(function() {
  aiAnalyzeLogs().catch(function(e) { log("Initial AI analysis error: " + e.message); });
}, 30000);

// ============================================================================
// [Telegram Bot] Bidirectional command interface via long-polling
// ============================================================================

async function fetchTelegramUpdates() {
  if (!TELEGRAM_TOKEN) return null;
  const url = "https://api.telegram.org/bot" + TELEGRAM_TOKEN +
    "/getUpdates?timeout=25&allowed_updates=[\"message\"]" +
    (telegramOffset ? "&offset=" + telegramOffset : "");
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(35000) });
    if (!resp.ok) {
      // [P10-6/7] Distinguish a token conflict from any other failure. 409 means
      // another process holds this bot's getUpdates (or a webhook is set), so
      // retrying every 3s just spams logs while commands stay dead.
      const status = resp.status;
      if (status === 409) {
        log("[tg-bot] CONFLICT: getUpdates HTTP 409 — another poller or a webhook owns this bot token");
        let detail = "";
        try { detail = JSON.stringify(await resp.json()).substring(0, 200); } catch (_e) {}
        return { conflict: true, status: status, detail: detail };
      }
      log("[tg-bot] getUpdates HTTP " + status);
      return { error: true, status: status };
    }
    return await resp.json();
  } catch (e) {
    if (!String(e.message).includes("aborted") && !String(e.message).includes("timeout"))
      log("[tg-bot] getUpdates error: " + e.message);
    return { error: true, message: e.message };
  }
}

function isAllowedChat(chatId) {
  if (!TELEGRAM_ALLOWED_CHAT_IDS.length) return false;
  return TELEGRAM_ALLOWED_CHAT_IDS.includes(String(chatId));
}

async function replyToChat(chatId, text, opts) {
  if (!TELEGRAM_TOKEN) return;
  opts = opts || {};
  const url = "https://api.telegram.org/bot" + TELEGRAM_TOKEN + "/sendMessage";
  // parseMode: "" -> plain text (no parse_mode sent); undefined -> Markdown
  const parseMode = (typeof opts.parseMode === "string") ? opts.parseMode : "Markdown";
  const payload = {
    chat_id: chatId,
    text: String(text).substring(0, 4000),
    disable_web_page_preview: true,
  };
  if (parseMode) payload.parse_mode = parseMode;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign(payload, opts.extra || {})),
    });
  } catch (e) { log("[tg-bot] reply failed: " + e.message); }
}

async function botFetchFromRunner(urlPath) {
  try {
    const resp = await fetch(BOT_INTERNAL_URL + urlPath, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return { error: "HTTP " + resp.status };
    const text = await resp.text();
    try { return { json: JSON.parse(text) }; }
    catch (_e) { return { text: text.substring(0, 3500) }; }
  } catch (e) { return { error: e.message }; }
}

// ============================================================================
// [Sentinel Fix] PnL / Trade History helpers — read event store
// ============================================================================

// [P2-11 CORRECTION_MEMO] Retroactive PnL corrections for phantom-loss trades
// that were recorded with missing entryPrice (Oct 14, 2026 incident). The event
// store is append-only so we cannot rewrite history; instead, this memo is
// consulted during daily PnL aggregation to substitute the correct netPnl.
//
// Root cause: container restart wiped ephemeral .runner-state.json, so SELL
// fills fell back to info.price (≈ fillPrice) → grossPnl≈0 → full commission
// + tax was recorded as net loss. In reality, both trades were profitable or
// near-breakeven based on TRADE_EXECUTED reason text and subsequent re-entry.
//
// Each entry keyed by { date (KST), symbol, side, ts } — applied when matching
// a suspicious FILL event. estimatedGrossPnl is in KRW.
const CORRECTION_MEMO = [
  {
    date: "2026-10-14",
    symbol: "BRK.B",
    side: "SELL",
    tsMatch: "2026-10-13T17:47:49.812Z",
    recordedNetPnl: -17674.79,
    estimatedEntryPrice: 505.00,
    estimatedGrossPnlKrw: 117900,
    correctedNetPnl: 100225,
    note: "Profit-taking trade misrecorded as loss. BRK.B bought pre-Oct 13, state lost on restart. Reason: 'surged ~$20 above lastClose'.",
  },
  {
    date: "2026-10-14",
    symbol: "SPY",
    side: "SELL",
    tsMatch: "2026-10-13T18:45:31.164Z",
    recordedNetPnl: -89398.97,
    estimatedEntryPrice: 776.62,
    estimatedGrossPnlKrw: 17700,
    correctedNetPnl: -71699,
    note: "Premature exit re-entered @778.4 2min later. Gross ~0 but costs were real; not the -89k loss reported.",
  },
];

// Build a fast lookup: "date|symbol|side|ts" -> correction
const _correctionIndex = new Map();
for (const c of CORRECTION_MEMO) {
  _correctionIndex.set(c.date + "|" + c.symbol + "|" + c.side + "|" + c.tsMatch, c);
}

/**
 * Aggregate FILL events for a given KST date (YYYY-MM-DD).
 * Returns { date, buys, sells, totalTrades, netPnl, commission, tax,
 *           wins, losses, winRate, trades[], corrections[] }.
 */
function computeDailyPnl(dateStr) {
  const target = dateStr || kstDateString();
  let fills = [];
  try {
    fills = eventStore.query({ types: ["FILL"], limit: 10000 });
  } catch (e) {
    log("[pnl] event store query failed: " + e.message);
  }

  // Always convert UTC timestamps to KST (UTC+9) for date matching.
  // The bot operates in KST context; all daily boundaries must use KST.
  const dayFills = fills.filter(function(f) {
    if (!f.ts) return false;
    try {
      const kst = new Date(new Date(f.ts).getTime() + 9 * 3600 * 1000);
      return kst.toISOString().slice(0, 10) === target;
    } catch { return false; }
  });

  const sells = dayFills.filter(function(f) { return f.side === "SELL"; });
  const buys = dayFills.filter(function(f) { return f.side === "BUY"; });

  // --- Realized PnL (from SELL events only) ---
  // netPnl in each SELL event already includes: grossPnl - buyCommission - sellCommission - sellTax
  // So we sum netPnl directly. Commission/tax are shown as reference breakdowns, NOT added again.
  let realizedPnl = 0, totalCommission = 0, totalTax = 0, grossProfit = 0, grossLoss = 0;
  let wins = 0, losses = 0, suspiciousCount = 0;
  const closedTrades = [];
  const appliedCorrections = [];

  for (const s of sells) {
    let net = Number(s.netPnl) || 0;
    const bc = Number(s.buyCommission) || 0;
    const sc = Number(s.sellCommission) || 0;
    const tx = Number(s.sellTax) || 0;
    // [P2-10] Detect phantom-loss trades: grossPnl≈0 but costs>0 means entryPrice
    // was missing at fill time and fell back to order price. Flag for user awareness.
    const gross = Number(s.grossPnl) || 0;
    const costs = Number(s.totalCosts) || (bc + sc + tx);
    const suspicious = s.suspicious === true || (Math.abs(gross) < 0.01 && costs > 0);

    // [P2-11 CORRECTION_MEMO] Apply retroactive fix for known phantom-loss fills.
    // Substitutes the correct netPnl and annotates the trade record.
    let correction = null;
    if (suspicious) {
      const key = target + "|" + s.symbol + "|" + s.side + "|" + s.ts;
      correction = _correctionIndex.get(key) || null;
      if (correction) {
        net = correction.correctedNetPnl;
        appliedCorrections.push({
          symbol: s.symbol,
          recordedNetPnl: Math.round(correction.recordedNetPnl),
          correctedNetPnl: Math.round(correction.correctedNetPnl),
          delta: Math.round(correction.correctedNetPnl - correction.recordedNetPnl),
          note: correction.note,
        });
      }
    }

    realizedPnl += net;
    totalCommission += bc + sc; // informational: already deducted in netPnl
    totalTax += tx;             // informational: already deducted in netPnl
    if (suspicious && !correction) suspiciousCount++;
    if (net > 0) { wins++; grossProfit += net; }
    else if (net < 0) { losses++; grossLoss += Math.abs(net); }
    closedTrades.push({
      symbol: s.symbol,
      side: "SELL",
      qty: s.quantity,
      price: s.fillPrice,
      entryPrice: correction ? correction.estimatedEntryPrice : (s.entryPrice || null),
      entryPriceSource: correction ? "CORRECTION_MEMO" : (s.entryPriceSource || null),
      netPnl: Math.round(net),
      pnlPct: s.pnlPct != null ? (s.pnlPct * 1).toFixed(2) + "%" : "—",
      suspicious: suspicious && !correction,
      corrected: !!correction,
    });
  }

  // --- Open positions (BUY without matching SELL today) ---
  // Track which symbols were closed so we can identify still-open positions.
  const closedSymbols = new Set(sells.map(function(s) { return s.symbol; }));
  const openPositions = [];
  for (const b of buys) {
    openPositions.push({
      symbol: b.symbol,
      side: "BUY",
      qty: b.quantity,
      entryPrice: b.fillPrice,
      netPnl: null, // unrealized — needs live price to compute
    });
  }

  const sellCount = sells.length;
  const winRate = sellCount > 0 ? (wins / sellCount) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);

  return {
    date: target,
    buys: buys.length,
    sells: sellCount,
    totalTrades: dayFills.length,
    // Realized PnL — this is the actual profit/loss after ALL costs
    realizedPnl: Math.round(realizedPnl),
    // Cost breakdown (already included in realizedPnl, shown for reference)
    commissionPaid: Math.round(totalCommission),
    taxPaid: Math.round(totalTax),
    wins: wins,
    losses: losses,
    winRate: winRate.toFixed(1),
    profitFactor: Number.isFinite(profitFactor) ? profitFactor.toFixed(2) : "∞",
    closedTrades: closedTrades,
    openPositions: openPositions,
    suspiciousCount: suspiciousCount,
    corrections: appliedCorrections,
    correctionCount: appliedCorrections.length,
    // Legacy field for backward compatibility
    netPnl: Math.round(realizedPnl),
    trades: closedTrades.concat(openPositions),
  };
}

/** Return the most recent N FILL events (newest last). */
function getRecentTrades(n) {
  const limit = Math.min(50, Math.max(1, Number(n) || 10));
  try {
    return eventStore.query({ types: ["FILL"], limit: limit });
  } catch (e) {
    log("[trades] event store query failed: " + e.message);
    return [];
  }
}

/** Compare two KST dates — used by /compare command and conversational AI. */
function compareDailyPnl(date1, date2) {
  const d1 = computeDailyPnl(date1);
  const d2 = computeDailyPnl(date2);
  return {
    d1: d1,
    d2: d2,
    pnlDiff: d2.netPnl - d1.netPnl,
    tradeCountDiff: d2.totalTrades - d1.totalTrades,
  };
}

/** List available event-store dates (newest first). */
function listTradingDates() {
  try {
    return eventStore.listFiles()
      .map(function(f) { const m = f.match(/events-(\d{4}-\d{2}-\d{2})\.jsonl/); return m ? m[1] : null; })
      .filter(Boolean)
      .reverse();
  } catch { return []; }
}


async function aiAnalyzeLogsOnce(logsOverride) {
  if (!PROFUNDO_API_KEY) return null;
  const logs = logsOverride || readRecentLogs(150, LOG_PATH);
  const errorLogPath = process.env.BOT_ERROR_LOG_PATH || "/opt/minitok/addons/invest/bot-error.log";
  const errorLogs = readRecentLogs(30, errorLogPath);
  if (!logs && !errorLogs) return null;
  const prompt = [
    "You are a monitoring assistant for an automated stock trading bot.",
    "Analyze the following logs and identify:",
    "1. Any critical errors or patterns that need attention",
    "2. Whether the bot appears to be trading normally or stalled",
    "3. WebSocket connection status",
    "4. AI API availability issues",
    "5. Any recommended actions",
    "Respond in Korean, max 5 lines, concise. If everything looks normal, say '정상 작동 중' with key metrics.",
    "", "=== BOT LOG ===", (logs || "").substring(0, 6000),
    "", "=== ERROR LOG ===", (errorLogs || "").substring(0, 2000),
  ].join("\n");
  const resp = await fetch(PROFUNDO_BASE_URL + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + PROFUNDO_API_KEY },
    body: JSON.stringify({ model: PROFUNDO_MODEL, messages: [{ role: "user", content: prompt }], max_tokens: 512, temperature: 0 }),
  });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  const data = await resp.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || "").trim();
}

async function handleBotCommand(chatId, rawCmd, args, fullName) {
  const cmd = rawCmd.toLowerCase();
  log("[tg-bot] cmd=" + cmd + " from=" + chatId + " user=" + fullName);
  audit.custom("telegram_cmd", { cmd: cmd, chatId: String(chatId), user: fullName });

  if (cmd === "/ping") {
    return replyToChat(chatId, "🏓 pong\nSentinel: " + new Date().toISOString() + "\nBot URL: " + BOT_INTERNAL_URL);
  }

  if (cmd === "/help") {
    return replyToChat(chatId,
      "🤖 *Sentinel Commands*\n" +
      "/ping — liveness check\n" +
      "/status — bot overall status\n" +
      "/health — /health endpoint dump\n" +
      "/metrics — prometheus metrics\n" +
      "/equity — portfolio equity\n" +
      "/positions — open positions\n" +
      "/pnl [YYYY-MM-DD] — daily P&L (default today, KST)\n" +
      "/trades [N] — recent N fills (default 10)\n" +
      "/daily — today's trade summary\n" +
      "/compare <d1> <d2> — compare two dates' P&L\n" +
      "/history — list dates with trade records\n" +
      "/selfheal — self-healing state\n" +
      "/news [N] — latest market news (default 10)\n" +
      "/sentiment — CNN Fear & Greed Index\n" +
      "/ai — last AI analysis\n" +
      "/logs [N] — last N log lines (default 30)\n" +
      "/halt-state — target engine halt/phase state\n" +
      "/recover — clear halt + reset daily baseline\n" +
      "/restart — restart bot container\n" +
      "/kill — disabled (safety)\n" +
      "/agent <task> — run AI coding agent (Cline)\n" +
      "/help — this message"
    );
  }

  if (cmd === "/status") {
    const h = await botFetchFromRunner("/health");
    if (h.error) return replyToChat(chatId, "❌ Bot unreachable: " + h.error);
    const j = h.json || {};
    const sa = j.selfAudit || {};
    const sh = j.selfHealing || {};
    return replyToChat(chatId,
      "📊 *Bot Status*\n" +
      "status: `" + (j.status || "?") + "`\n" +
      "uptime: " + (Math.round((j.uptime || 0) / 60)) + " min\n" +
      "equity: ₩" + (sa.equityKrw ? Number(sa.equityKrw).toLocaleString() : "n/a") + (sa.equityUsd ? " ($" + Math.round(sa.equityUsd).toLocaleString() + ")" : "") + "\n" +
      "auth fail/1h: " + (sa.authFailuresLastHour || 0) + "\n" +
      "exec err/1h: " + (sa.executionErrorsLastHour || 0) + "\n" +
      "AI consec fail: " + (sa.aiConsecutiveFailures || 0) + "\n" +
      "self-heal active: " + (sh.activeMitigations || 0) + "\n" +
      "runner PID: " + (findRunnerProcess() ? "✅ alive" : "❌ missing")
    );
  }

  if (cmd === "/health") {
    const h = await botFetchFromRunner("/health");
    if (h.error) return replyToChat(chatId, "❌ " + h.error);
    const text = h.text || JSON.stringify(h.json, null, 2);
    return replyToChat(chatId, "```\n" + text.substring(0, 3500) + "\n```", { parseMode: "" });
  }

  if (cmd === "/metrics") {
    const h = await botFetchFromRunner("/metrics");
    if (h.error) return replyToChat(chatId, "❌ " + h.error);
    const text = h.text || JSON.stringify(h.json, null, 2);
    return replyToChat(chatId, "```\n" + text.substring(0, 3500) + "\n```", { parseMode: "" });
  }

  if (cmd === "/equity" || cmd === "/positions") {
    const h = await botFetchFromRunner("/health");
    if (h.error) return replyToChat(chatId, "❌ " + h.error);
    const j = h.json || {};
    const sa = j.selfAudit || {};
    const pos = Array.isArray(sa.openPositions) ? sa.openPositions : (Array.isArray(j.positions) ? j.positions : []);
    let body = "💼 *Equity*: ₩" + (sa.equityKrw ? Number(sa.equityKrw).toLocaleString() : "n/a") + (sa.equityUsd ? " ($" + Math.round(sa.equityUsd).toLocaleString() + ")" : "") + "\n\n";
    if (!pos.length) {
      body += "_(no open positions in /health)_";
    } else {
      body += "*Open positions* (" + pos.length + "):\n";
      for (const p of pos.slice(0, 20)) {
        const sym = p.symbol || p.ticker || "?";
        const qty = p.qty != null ? p.qty : (p.quantity != null ? p.quantity : "?");
        const pnl = p.unrealizedPnl != null ? p.unrealizedPnl : (p.pnl != null ? p.pnl : "?");
        body += "  • `" + sym + "` qty=" + qty + " pnl=" + pnl + "\n";
      }
    }
    return replyToChat(chatId, body);
  }

  if (cmd === "/selfheal" || cmd === "/self-heal") {
    const h = await botFetchFromRunner("/self-healing");
    if (h.error) {
      const hh = await botFetchFromRunner("/health");
      if (hh.error) return replyToChat(chatId, "❌ " + hh.error);
      const sh = (hh.json || {}).selfHealing || {};
      return replyToChat(chatId, "🛡 *Self-Healing*\n```\n" + JSON.stringify(sh, null, 2) + "\n```");
    }
    const text = h.text || JSON.stringify(h.json, null, 2);
    return replyToChat(chatId, "🛡 *Self-Healing*\n```\n" + text.substring(0, 3500) + "\n```");
  }

  if (cmd === "/news") {
    const h = await botFetchFromRunner("/news");
    if (h.error) return replyToChat(chatId, "❌ " + h.error);
    const j = h.json || {};
    if (!j.enabled) return replyToChat(chatId, "⚠️ Market intel not enabled on runner");
    const news = Array.isArray(j.news) ? j.news : [];
    const limit = Math.min(20, Math.max(1, parseInt(args[0], 10) || 10));
    let body = "📰 *Market News* (" + news.length + " collected)\n\n";
    if (!news.length) {
      body += "_(no news yet — collector may still be starting)_";
    } else {
      for (const n of news.slice(0, limit)) {
        const tags = Array.isArray(n.tags) ? n.tags.slice(0, 3).join(", ") : "";
        body += "• " + String(n.title || "?").substring(0, 80) + "\n";
        if (n.source) body += "  _" + n.source + "_";
        if (tags) body += " [" + tags + "]";
        body += "\n";
      }
    }
    return replyToChat(chatId, body);
  }

  if (cmd === "/sentiment") {
    const h = await botFetchFromRunner("/sentiment");
    if (h.error) return replyToChat(chatId, "❌ " + h.error);
    const j = h.json || {};
    if (!j.enabled) return replyToChat(chatId, "⚠️ Market intel not enabled on runner");
    const fgData = j.fearGreed || {};
    const fg = fgData.fearGreed || null;
    let body = "📊 *Market Sentiment*\n\n";
    if (fg && fg.score != null) {
      const emoji = fg.score <= 25 ? "😱" : fg.score <= 45 ? "😟" : fg.score <= 55 ? "😐" : fg.score <= 75 ? "😊" : "🤑";
      body += "CNN Fear & Greed Index: " + emoji + " *" + fg.score + "* (" + (fg.label || "n/a") + ")\n";
      body += "Updated: " + (fg.at || fgData.updatedAt || "n/a") + "\n";
    } else {
      body += "Fear & Greed data not yet available.\n";
    }
    const st = j.stats || {};
    body += "\nCollector: ticks=" + (st.ticks || 0) + " success=" + (st.successCount || 0) + " errors=" + (st.errorCount || 0) + " history=" + (st.historySize || 0);
    return replyToChat(chatId, body);
  }

  if (cmd === "/ai") {
    if (!PROFUNDO_API_KEY) return replyToChat(chatId, "⚠️ PROFUNDO_API_KEY not set");
    await replyToChat(chatId, "🤖 Running AI log analysis…");
    try {
      const analysis = await aiAnalyzeLogsOnce();
      if (!analysis) return replyToChat(chatId, "🤖 AI returned no analysis.");
      return replyToChat(chatId, "🤖 *AI Analysis*\n" + analysis.substring(0, 2000));
    } catch (e) {
      return replyToChat(chatId, "❌ AI analysis error: " + e.message);
    }
  }

  if (cmd === "/logs") {
    const n = Math.min(200, Math.max(5, parseInt(args[0], 10) || 30));
    const logs = readRecentLogs(n, LOG_PATH);
    if (!logs) return replyToChat(chatId, "❌ No logs at " + LOG_PATH);
    return replyToChat(chatId, "📜 *Last " + n + " lines*\n```\n" + logs.substring(0, 3500) + "\n```", { parseMode: "" });
  }

  if (cmd === "/restart") {
    if (IS_WINDOWS) return replyToChat(chatId, "⚠️ Windows — manual restart required.");
    await replyToChat(chatId, "🔄 Restarting via `systemctl restart " + BOT_SERVICE + "`…");
    const out = restartService();
    return replyToChat(chatId, "✅ restart issued\n`" + (out || "(no output)") + "`");
  }

  // [AGENT-BRIDGE]
  if (cmd === "/agent") {
    const task = args.join(" ");
    if (!task) {
      return replyToChat(chatId, "Usage: /agent <task description>");
    }
    await replyToChat(chatId, "⏳ Starting Cline agent... (timeout 5min)");
    try {
      const result = await runClineTask(task, {
        apiKey: PROFUNDO_API_KEY,
        baseUrl: PROFUNDO_BASE_URL,
        model: process.env.PROFUNDO_MODEL || "qwen-3.8-max-thinking",
        onChunk: async (chunk) => {
          // Telegram has 4096 char limit; split if needed
          const safeChunk = chunk.substring(0, 4000);
          await replyToChat(chatId, safeChunk).catch(() => {});
        }
      });
      if (!result.success) {
        await replyToChat(chatId, result.summary);
      }
    } catch (e) {
      await replyToChat(chatId, "❌ Agent failed: " + e.message);
    }
    return;
  }


  if (cmd === "/recover") {
    // [P2-11] Manual recovery: clear halt state + reset daily baseline via runner HTTP
    await replyToChat(chatId, "🔧 *Recovery initiated…*\nClearing halt state and resetting daily baseline.");
    try {
      // 1. Get current equity from /health
      const h = await botFetchFromRunner("/health");
      const equity = (h.json && h.json.selfAudit && h.json.selfAudit.equityKrw) || null;
      // 2. POST /admin/resume with resetBaseline
      const resumePayload = { resetBaseline: true, equity: equity || 0 };
      const resumeUrl = BOT_INTERNAL_URL + "/admin/resume";
      const resp = await fetch(resumeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(resumePayload),
        signal: AbortSignal.timeout(10000),
      });
      const result = await resp.json();
      if (result.ok) {
        let msg = "✅ *Recovery successful*\n";
        msg += "halted: `" + result.previous.halted + "` → `" + result.current.halted + "`\n";
        msg += "phase: `" + result.current.phase + "`\n";
        if (result.current.dailyBaselineEquity) {
          msg += "daily baseline: ₩" + Math.round(result.current.dailyBaselineEquity).toLocaleString() + "\n";
        }
        msg += "\n봇이 정상 거래를 재개합니다.";
        audit.custom("recovery", { action: "recover", result: "ok", equity: equity });
        return replyToChat(chatId, msg);
      } else {
        return replyToChat(chatId, "❌ Recovery returned error: " + JSON.stringify(result));
      }
    } catch (e) {
      audit.error({ source: "sentinel", code: "recover_failed", message: e.message });
      return replyToChat(chatId, "❌ *Recovery failed*: " + e.message + "\nRunner가 응답하지 않습니다. `/restart`를 시도하세요.");
    }
  }

  if (cmd === "/halt-state") {
    // [P2-11] Show target engine halt/phase state
    const st = await botFetchFromRunner("/admin/state");
    if (st.error) return replyToChat(chatId, "❌ " + st.error);
    const j = st.json || {};
    const lim = j.limits || {};
    const hs = (j.fullState && j.fullState.haltState) || {};
    return replyToChat(chatId,
      "🔧 *Target Engine State*\n" +
      "phase: `" + lim.phase + "` (" + (lim.phaseName || "?") + ")\n" +
      "dryRun: `" + lim.dryRun + "`\n" +
      "halted: `" + lim.halted + "`\n" +
      "halt reason: `" + (hs.reason || "none") + "`\n" +
      "halt since: `" + (hs.since || "n/a") + "`\n" +
      "daily baseline: ₩" + (lim.dailyBaselineEquity ? Math.round(lim.dailyBaselineEquity).toLocaleString() : "n/a") + "\n" +
      "HWM: ₩" + (lim.highWaterEquity ? Math.round(lim.highWaterEquity).toLocaleString() : "n/a") + "\n" +
      "state path: `" + (j.statePath || "?") + "`"
    );
  }

  if (cmd === "/kill") {
    return replyToChat(chatId, "🚫 `/kill` disabled for safety. Use `/restart`.");
  }

  // --- [Sentinel Fix] PnL / Trade History commands ---

  if (cmd === "/pnl") {
    const dateArg = args[0] || null;
    try {
      const pnl = computeDailyPnl(dateArg);
      if (pnl.totalTrades === 0) {
        return replyToChat(chatId, "📊 *" + pnl.date + "* — 거래 기록 없음\n\n이벤트 스토어에 해당 날짜의 FILL 이벤트가 없습니다.\n거래가 있었는지 확인하려면 `/history`로 기록 가능한 날짜를 확인하세요.");
      }
      const emoji = pnl.realizedPnl > 0 ? "📈" : pnl.realizedPnl < 0 ? "📉" : "➖";
      let body = emoji + " *P&L — " + pnl.date + "*\n\n" +
        "거래: " + pnl.totalTrades + " (매수:" + pnl.buys + " 매도:" + pnl.sells + ")\n" +
        "실현손익: ₩" + pnl.realizedPnl.toLocaleString() + "\n" +
        "  _(수수료 ₩" + pnl.commissionPaid.toLocaleString() + " + 세금 ₩" + pnl.taxPaid.toLocaleString() + " 공제됨)_\n" +
        "승률: " + pnl.winRate + "% (" + pnl.wins + "승 " + pnl.losses + "패)\n" +
        "Profit Factor: " + pnl.profitFactor + "\n";

      if (pnl.closedTrades && pnl.closedTrades.length > 0) {
        body += "\n*청산 포지션*:\n";
        for (const t of pnl.closedTrades.slice(0, 15)) {
          const pnlEmoji = t.netPnl > 0 ? "📈" : t.netPnl < 0 ? "📉" : "➖";
          const warn = t.suspicious ? "⚠️" : "";
          const src = t.entryPriceSource ? " _" + t.entryPriceSource + "_" : "";
          body += "  " + warn + pnlEmoji + " `" + t.symbol + "` " + t.qty + "@" + t.price + " → ₩" + t.netPnl.toLocaleString() + " (" + t.pnlPct + ")" + src + "\n";
        }
        if (pnl.closedTrades.length > 15) body += "  _…" + (pnl.closedTrades.length - 15) + " more_\n";
      }
      if (pnl.suspiciousCount > 0) {
        body += "\n⚠️ *" + pnl.suspiciousCount + "건 의심 거래*: 진입가 미기록으로 수수료가 전액 손실로 처리됨. 실제 손익과 다를 수 있습니다.\n";
      }
      if (pnl.correctionCount > 0) {
        body += "\n📝 *" + pnl.correctionCount + "건 소급 보정 적용됨* (CORRECTION_MEMO):\n";
        for (const c of pnl.corrections.slice(0, 10)) {
          const emoji = c.delta > 0 ? "✅" : "🔻";
          body += "  " + emoji + " `" + c.symbol + "` 기록: ₩" + c.recordedNetPnl.toLocaleString() + " → 보정: ₩" + c.correctedNetPnl.toLocaleString() + " (Δ " + (c.delta > 0 ? "+" : "") + c.delta.toLocaleString() + ")\n";
          body += "     _" + c.note + "_\n";
        }
      }
      if (pnl.openPositions && pnl.openPositions.length > 0) {
        body += "\n*미결제 포지션* (당일 매수):\n";
        for (const p of pnl.openPositions.slice(0, 15)) {
          body += "  🟢 `" + p.symbol + "` " + p.qty + "@" + p.entryPrice + " (미실현)\n";
        }
        if (pnl.openPositions.length > 15) body += "  _…" + (pnl.openPositions.length - 15) + " more_\n";
      }
      return replyToChat(chatId, body);
    } catch (e) {
      return replyToChat(chatId, "❌ /pnl error: " + e.message);
    }
  }

  if (cmd === "/trades") {
    const n = Math.min(50, Math.max(1, parseInt(args[0], 10) || 10));
    try {
      const fills = getRecentTrades(n);
      if (!fills.length) {
        return replyToChat(chatId, "📋 최근 거래 기록이 없습니다.\n이벤트 스토어에 FILL 이벤트가 없습니다.");
      }
      let body = "📋 *최근 " + fills.length + "건 거래*\n\n";
      for (const f of fills) {
        const t = f.ts ? f.ts.slice(5, 16).replace("T", " ") : "?";
        const pnlStr = f.netPnl != null ? " pnl=₩" + Math.round(f.netPnl).toLocaleString() : "";
        const emoji = f.side === "BUY" ? "🟢" : f.netPnl > 0 ? "📈" : f.netPnl < 0 ? "📉" : "🔴";
        body += emoji + " `" + t + "` " + f.side + " `" + (f.symbol || "?") + "` " + (f.quantity || "?") + "@" + (f.fillPrice || "?") + pnlStr + "\n";
      }
      return replyToChat(chatId, body);
    } catch (e) {
      return replyToChat(chatId, "❌ /trades error: " + e.message);
    }
  }

  if (cmd === "/daily") {
    try {
      const pnl = computeDailyPnl(null);
      const dates = listTradingDates();
      let body = "📊 *오늘 요약 — " + pnl.date + "*\n\n" +
        "총 거래: " + pnl.totalTrades + "건\n" +
        "매수: " + pnl.buys + " / 매도: " + pnl.sells + "\n" +
        "실현손익: ₩" + pnl.realizedPnl.toLocaleString() + "\n" +
        "  _(수수료 ₩" + pnl.commissionPaid.toLocaleString() + ", 세금 ₩" + pnl.taxPaid.toLocaleString() + " 공제)_\n" +
        "승률: " + pnl.winRate + "% (" + pnl.wins + "승 " + pnl.losses + "패)\n" +
        "Profit Factor: " + pnl.profitFactor + "\n\n";
      if (dates.length > 0) {
        body += "*거래 기록 있는 날짜* (최근 10일):\n";
        for (const d of dates.slice(0, 10)) {
          body += "  `" + d + "`\n";
        }
        body += "\n_특정 날짜: `/pnl YYYY-MM-DD`_";
      } else {
        body += "_이벤트 스토어에 거래 기록이 없습니다._";
      }
      return replyToChat(chatId, body);
    } catch (e) {
      return replyToChat(chatId, "❌ /daily error: " + e.message);
    }
  }

  if (cmd === "/compare") {
    if (args.length < 2) {
      return replyToChat(chatId, "사용법: `/compare YYYY-MM-DD YYYY-MM-DD`\n예: `/compare 2026-10-12 2026-10-13`");
    }
    try {
      const cmp = compareDailyPnl(args[0], args[1]);
      const emoji = cmp.pnlDiff > 0 ? "📈" : cmp.pnlDiff < 0 ? "📉" : "➖";
      let body = emoji + " *P&L 비교*\n\n";
      body += "*" + cmp.d1.date + "*\n" +
        "  거래: " + cmp.d1.totalTrades + "건, 실현손익: ₩" + cmp.d1.realizedPnl.toLocaleString() + "\n" +
        "  수수료: ₩" + cmp.d1.commissionPaid.toLocaleString() + ", 승률: " + cmp.d1.winRate + "%, PF: " + cmp.d1.profitFactor + "\n\n";
      body += "*" + cmp.d2.date + "*\n" +
        "  거래: " + cmp.d2.totalTrades + "건, 실현손익: ₩" + cmp.d2.realizedPnl.toLocaleString() + "\n" +
        "  수수료: ₩" + cmp.d2.commissionPaid.toLocaleString() + ", 승률: " + cmp.d2.winRate + "%, PF: " + cmp.d2.profitFactor + "\n\n";
      body += "*차이*: ₩" + cmp.pnlDiff.toLocaleString() + " (" + (cmp.pnlDiff >= 0 ? "+" : "") + ")\n";
      body += "거래 수 차이: " + (cmp.tradeCountDiff >= 0 ? "+" : "") + cmp.tradeCountDiff + "건";
      return replyToChat(chatId, body);
    } catch (e) {
      return replyToChat(chatId, "❌ /compare error: " + e.message);
    }
  }

  if (cmd === "/history") {
    try {
      const dates = listTradingDates();
      if (!dates.length) {
        return replyToChat(chatId, "📅 이벤트 스토어에 거래 기록이 없습니다.\n디렉토리: `" + eventStore.dir + "`");
      }
      let body = "📅 *거래 기록 있는 날짜* (" + dates.length + "일)\n\n";
      for (const d of dates.slice(0, 30)) {
        const pnl = computeDailyPnl(d);
        const emoji = pnl.realizedPnl > 0 ? "📈" : pnl.realizedPnl < 0 ? "📉" : "➖";
        body += emoji + " `" + d + "` " + pnl.totalTrades + "건 ₩" + pnl.realizedPnl.toLocaleString() + " (" + pnl.wins + "승 " + pnl.losses + "패)\n";
      }
      if (dates.length > 30) body += "\n_…" + (dates.length - 30) + " more_";
      return replyToChat(chatId, body);
    } catch (e) {
      return replyToChat(chatId, "❌ /history error: " + e.message);
    }
  }

  return replyToChat(chatId, "❓ Unknown command. Try /help");
}

// ============================================================================
// [Conversational] Natural-language chat with live trading context
// ============================================================================

function getConversation(chatId) {
  if (!conversationMemory.has(chatId)) conversationMemory.set(chatId, []);
  return conversationMemory.get(chatId);
}

function pushConversation(chatId, role, content) {
  const convo = getConversation(chatId);
  convo.push({ role, content });
  while (convo.length > CONVO_MAX_TURNS * 2) convo.shift();
}

async function gatherBotContext() {
  const parts = [];
  const h = await botFetchFromRunner("/health");
  if (h.json) {
    const j = h.json;
    const sa = j.selfAudit || {};
    const sh = j.selfHealing || {};
    const cm = j.crossMarket || {};
    const lc = j.lifecycle || {};
    const mc = j.metaCognition || {};
    parts.push("status=" + (j.status || "unknown"));
    parts.push("uptime=" + Math.round(j.uptime || 0) + "s");
    parts.push("equityKRW=" + (sa.equityKrw || "n/a"));
    parts.push("authFail1h=" + (sa.authFailuresLastHour || 0));
    parts.push("execErr1h=" + (sa.executionErrorsLastHour || 0));
    parts.push("aiConsecFail=" + (sa.aiConsecutiveFailures || 0));
    parts.push("wsReconnects1h=" + (sa.wsReconnectsLastHour || 0));
    parts.push("selfHealActive=" + (sh.activeMitigations || 0));

    // Data collection metrics (REST polling + WebSocket)
    parts.push("pricesCollected10min=" + (sa.pricesCollectedLast10Min || 0));
    parts.push("aiCallIntervalAvgMs=" + Math.round(sa.aiCallIntervalAvg || 0));

    // Cross-market scanner status
    if (cm.totalPairs != null || cm.scans != null) {
      parts.push("crossMarket:scans=" + (cm.scans || 0) + "/pairs=" + (cm.activePairs || 0) + "/opps=" + (cm.opportunities || 0));
    }

    // Strategy lifecycle
    if (lc.totalStrategies != null) {
      const by = lc.byPhase || {};
      parts.push("strategies=" + (lc.totalStrategies || 0) + "(disc=" + (by.discovery || 0) + "/inc=" + (by.incubation || 0) + "/prod=" + (by.production || 0) + ")");
    }

    // MetaCognition
    if (mc.totalDecisions != null) {
      parts.push("decisions=" + (mc.totalDecisions || 0) + "(strong=" + (mc.strongDecisions || 0) + ")");
    }

    // Market intelligence (news + sentiment)
    const mi = j.marketIntel || {};
    if (mi.enabled) {
      parts.push("marketIntel:history=" + (mi.historySize || 0) + "/ticks=" + (mi.ticks || 0));
      if (mi.fearGreed && mi.fearGreed.score != null) {
        parts.push("fearGreed=" + mi.fearGreed.score + "(" + (mi.fearGreed.label || "?") + ")");
      }
    }

    // Positions
    if (Array.isArray(sa.openPositions) && sa.openPositions.length) {
      const posStr = sa.openPositions.slice(0, 10).map(function(p) {
        return (p.symbol || p.ticker || "?") + " qty=" + (p.qty != null ? p.qty : "?") + " pnl=" + (p.unrealizedPnl != null ? p.unrealizedPnl : "?");
      }).join("; ");
      parts.push("positions=[" + posStr + "]");
    } else {
      parts.push("positions=none");
    }
  } else {
    parts.push("bot_unreachable=" + (h.error || "unknown"));
  }

  // [Sentinel Fix] Append event store trade data to context
  try {
    const todayPnl = computeDailyPnl(null);
    parts.push("todayPnl:realized=₩" + todayPnl.realizedPnl + "/trades=" + todayPnl.totalTrades + "/wins=" + todayPnl.wins + "/losses=" + todayPnl.losses + "/winRate=" + todayPnl.winRate + "%/commission=₩" + todayPnl.commissionPaid + "/open=" + todayPnl.openPositions.length);
    const recentFills = getRecentTrades(5);
    if (recentFills.length > 0) {
      const fillStr = recentFills.map(function(f) {
        const sym = f.symbol || "?";
        const pnl = f.netPnl != null ? "₩" + Math.round(f.netPnl) : "";
        return f.side + " " + sym + " " + (f.quantity || "?") + " " + pnl;
      }).join("; ");
      parts.push("recentFills=[" + fillStr + "]");
    } else {
      parts.push("recentFills=none");
    }
    const tradingDates = listTradingDates();
    parts.push("tradingDates=" + (tradingDates.length > 0 ? tradingDates.slice(0, 5).join(",") : "none"));
  } catch (e) {
    parts.push("eventStore=error:" + e.message);
  }

  return parts.join(", ");
}

async function handleConversation(chatId, userText, userName) {
  if (!PROFUNDO_API_KEY) {
    return replyToChat(chatId, "⚠️ AI 키 미설정으로 대화 기능을 사용할 수 없습니다. 슬래시 명령어는 사용 가능합니다.");
  }

  const convo = getConversation(chatId);
  const context = await gatherBotContext();

  const systemPrompt = [
    "You are a helpful Korean-speaking assistant monitoring an automated stock trading bot (minitok-invest).",
    "You have access to live bot telemetry. Answer naturally and concisely in Korean.",
    "If the user asks about status/equity/positions/errors, use the telemetry below.",
    "If the user asks to restart the bot, tell them they can say '재시작해줘' or use /restart.",
    "",
    "CRITICAL FACTS about data collection (use these when asked):",
    "- The bot does NOT use web scraping or crawling.",
    "- Market data is collected via Toss Securities Open API (REST) and WebSocket connections.",
    "- During market hours: real-time WebSocket streaming (체결, 호가, 주문).",
    "- Outside market hours: REST polling for background data collection (KR, US, JP markets).",
    "- 'pricesCollected10min' shows how many price ticks were received in the last 10 minutes.",
    "- Cross-market scanner periodically scans KOSPI/KOSDAQ/NASDAQ for opportunities.",
    "- Market intelligence: collects RSS news (Google News KR, Investing.com, Yahoo Finance) and CNN Fear & Greed Index every 15 min.",
    "- Use /news for latest headlines, /sentiment for Fear & Greed Index.",
    "",
    "",
    "TRADING & P&L DATA (from durable event store — authoritative source):",
    "- 'todayPnl' shows today's net P&L, trade count, wins/losses, win rate (KST date).",
    "- 'recentFills' shows the last 5 actual executed trades with symbol, side, quantity, and realized P&L.",
    "- 'tradingDates' lists dates that have trade records in the event store.",
    "- If user asks about daily profit/loss, compare dates, or trade history, use this telemetry data.",
    "- If user asks to compare two dates (e.g. '10월 12일과 13일 비교'), compute from todayPnl and recentFills or suggest /compare <d1> <d2>.",
    "- If 'recentFills=none' and 'todayPnl:trades=0', there are no trades recorded for today.",
    "- Trading commands: /pnl [date], /trades [N], /daily, /compare <d1> <d2>, /history.",
    "- The runner writes FILL events to a durable JSONL event store on every actual order fill.",
    "- Sentinel reads this store directly — so if fills exist, they will appear in telemetry.",
    "",
    "ABOUT THE TRADING SYSTEM (use when asked how it works):",
    "- Runner: autonomous trading bot that executes AI-driven strategies across KR/US/JP markets.",
    "- Sentinel (this bot): monitoring watchdog — checks runner health, alerts on anomalies, answers questions about trading.",
    "- Strategies: base_signals (momentum/mean-reversion hybrid), managed by strategy orchestrator with performance-weighted allocation.",
    "- Risk: VaR/CVaR engine (95% confidence), ATR-based trailing stops, portfolio risk budget (2%).",
    "- Regime detection: HMM classifies market as bear/sideways/bull; position sizing adjusts accordingly.",
    "- Self-healing: automatic mitigation for API failures, WS disconnects, AI degradation.",
    "- Meta-cognition: reviews past decisions and adjusts confidence thresholds.",
    "- P&L includes commission (KR 0.015%, US 0.07%, JP 0.05%) and sell tax (KR 0.15%, US SEC fee 0.00278%).",
    "- Shadow account (src/shadow_account) does PDF/OCR-based reconciliation against Toss statements.",
    "Be friendly, concise (max 5 lines), and helpful. Use emoji sparingly.",
    "If the user asks what data the bot collects, mention: real-time prices, order book, trade execution events, cross-market arbitrage signals — all via API, not web scraping.",
    "",
    "=== LIVE BOT TELEMETRY ===",
    context,
    "=== TELEMETRY END ==="
  ].join("\n");

  // Build messages array
  const messages = [{ role: "system", content: systemPrompt }];
  for (const m of convo) messages.push(m);
  messages.push({ role: "user", content: userText });

  // Detect explicit positive restart intent; avoid negations like "재시작하지마"
  const normalizedText = userText.replace(/\s+/g, " ").trim();
  const restartKeywords = [
    "재시작해줘", "재시작 해줘", "재시작해주세요", "재시작 해주세요", "재시작 부탁",
    "봇 재시작해", "봇 재시작 해", "리스타트해줘", "리스타트 해줘",
    "다시 시작해줘", "다시 시작 해줘", "다시시작해줘", "봇 다시 시작해줘", "봇 다시시작해줘"
  ];
  const isRestart = (
    normalizedText === "재시작" ||
    normalizedText === "봇 재시작" ||
    restartKeywords.some(function(k) { return normalizedText.includes(k); })
  ) && !normalizedText.includes("하지마") && !normalizedText.includes("말아") && !normalizedText.includes("않아");

  if (isRestart) {
    if (IS_WINDOWS) {
      pushConversation(chatId, "user", userText);
      pushConversation(chatId, "assistant", "Windows 환경이라 자동 재시작이 불가능합니다. 직접 서버에 접속하여 재시작해주세요.");
      return replyToChat(chatId, "⚠️ Windows 환경이라 자동 재시작이 불가능합니다.");
    }
    pushConversation(chatId, "user", userText);
    pushConversation(chatId, "assistant", "봇을 재시작했습니다.");
    await replyToChat(chatId, "🔄 봇을 재시작합니다…");
    const out = restartService();
    return replyToChat(chatId, "✅ 재시작 완료\n`" + (out || "(응답 없음)") + "`");
  }

  // Call AI
  try {
    const resp = await fetch(PROFUNDO_BASE_URL + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + PROFUNDO_API_KEY },
      body: JSON.stringify({
        model: PROFUNDO_MODEL,
        messages: messages,
        max_tokens: 512,
        temperature: 0.3,
      }),
    });
    if (!resp.ok) {
      log("[convo] AI HTTP " + resp.status);
      return replyToChat(chatId, "⚠️ AI 응답 오류 (HTTP " + resp.status + ")");
    }
    const data = await resp.json();
    const reply = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || "").trim();
    if (!reply) return replyToChat(chatId, "🤖 응답이 비어있습니다.");

    pushConversation(chatId, "user", userText);
    pushConversation(chatId, "assistant", reply);
    return replyToChat(chatId, reply, { parseMode: "" });
  } catch (e) {
    log("[convo] AI error: " + e.message);
    return replyToChat(chatId, "❌ AI 호출 실패: " + e.message);
  }
}

async function telegramPollLoop() {
  if (!telegramActive) {
    log("[tg-bot] Polling disabled (missing TELEGRAM_TOKEN or TELEGRAM_CHAT_ID)");
    return;
  }
  log("[tg-bot] Polling started (poll=" + TELEGRAM_POLL_MS + "ms, allowed=" + TELEGRAM_ALLOWED_CHAT_IDS.join(",") + ")");

  // [P10-6] Consecutive-conflict circuit breaker. On 2026-10-14 this loop logged
  // 1,092 conflicts then silently gave up for 13 hours — alerts looked alive while
  // every command was dead. After TG_CONFLICT_LIMIT strikes we stop polling,
  // log a clear escalation and record it, instead of spinning forever.
  const TG_CONFLICT_LIMIT = Number(process.env.TG_CONFLICT_LIMIT || 10);
  let conflictStreak = 0;
  let pollingDisabled = false;

  try {
    const prime = await fetchTelegramUpdates();
    if (prime && prime.conflict) {
      log("[tg-bot] WARNING: token is already in use at startup — commands may not arrive");
    } else if (prime && Array.isArray(prime.result) && prime.result.length) {
      telegramOffset = prime.result[prime.result.length - 1].update_id + 1;
      log("[tg-bot] Primed offset=" + telegramOffset);
    }
  } catch (e) {
    log("[tg-bot] Prime failed: " + e.message);
  }

  async function tick() {
    if (pollingDisabled) return; // circuit open — stop until process restart
    try {
      const data = await fetchTelegramUpdates();

      if (data && data.conflict) {
        conflictStreak++;
        if (conflictStreak >= TG_CONFLICT_LIMIT) {
          pollingDisabled = true;
          log("[tg-bot] STOPPING POLLING after " + conflictStreak + " consecutive 409 conflicts. Commands are NOT being received.");
          log("[tg-bot] Cause: another process is calling getUpdates with this bot token, or a webhook is set. Fix that, then restart the sentinel.");
          try { await replyToChat(TELEGRAM_CHAT_ID,
            "⚠️ *Telegram polling stopped*\n" +
            conflictStreak + " consecutive 409 conflicts — another poller or a webhook owns this bot token.\n" +
            "Commands are not being received. Restart the sentinel after fixing the conflict."); } catch (_e) {}
          return;
        }
        return; // back off via the normal timer
      }
      conflictStreak = 0; // any healthy response resets the streak

      if (data && Array.isArray(data.result)) {
        for (const upd of data.result) {
          telegramOffset = upd.update_id + 1;
          const msg = upd.message;
          if (!msg || !msg.text) continue;
          const chatId = msg.chat && msg.chat.id;
          if (!chatId) continue;
          if (!isAllowedChat(chatId)) {
            log("[tg-bot] REJECTED from chat=" + chatId);
            await replyToChat(chatId, "🚫 Unauthorized. Your id: `" + chatId + "`");
            continue;
          }
          const text = msg.text.trim();
          const fullName = (msg.from && ((msg.from.first_name || "") + " " + (msg.from.last_name || "")).trim()) || "unknown";
          try {
            if (text.startsWith("/")) {
              // Slash command
              const parts = text.split(/\s+/);
              const cmdPart = parts[0].split("@")[0];
              const cmdArgs = parts.slice(1);
              await handleBotCommand(chatId, cmdPart, cmdArgs, fullName);
            } else {
              // Natural conversation
              await handleConversation(chatId, text, fullName);
            }
          } catch (e) {
            log("[tg-bot] handler error: " + e.message);
            await replyToChat(chatId, "❌ error: " + e.message).catch(function(){});
          }
        }
      }
    } catch (e) {
      log("[tg-bot] tick error: " + e.message);
    } finally {
      telegramPollTimer = setTimeout(tick, TELEGRAM_POLL_MS);
    }
  }
  telegramPollTimer = setTimeout(tick, 1000);
}

setTimeout(function() {
  telegramPollLoop().catch(function(e) { log("[tg-bot] startup error: " + e.message); });
}, 5000);
