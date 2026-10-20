"use strict";

/**
 * End-of-session trading summary formatter.
 *
 * Pure function: all data is passed in, so the format is unit-testable and
 * the admin stays responsible for collecting it.
 *
 * Why a session window instead of a calendar day: the US session runs
 * 22:30–05:00 KST and straddles midnight, so a KST-date rollup would split
 * one session across two days. The summary therefore covers the closed
 * session that actually traded.
 *
 * The output is plain text on purpose. Telegram's legacy Markdown parser
 * treats `_`, `*`, `@`, `#` and `$` as entity starters, and trade data
 * (entryPriceSource "order_price", pnlPct strings) breaks the entity balance
 * — the message is then rejected with HTTP 400 and only survives via the
 * plain-text retry. A report must never depend on that.
 */

const { kstHm } = require("./session-window");

function won(n) {
  return "₩" + Math.round(Number(n) || 0).toLocaleString("en-US");
}

function formatSessionSummary({ session, pnl, health }) {
  const lines = [];
  // The header names the window, not the market of every trade in it: the
  // window is the last closed session, and the bot can trade other markets
  // inside it.
  const window = kstHm(session.openAt) + " ~ " + kstHm(session.closeAt) + " KST";
  lines.push("📊 거래 요약 — " + session.market + " 마감 후 (" + window + ")");
  lines.push("");

  const total = pnl.totalTrades || 0;
  lines.push("거래 " + total + "건 (매수 " + (pnl.buys || 0) + " / 매도 " + (pnl.sells || 0) + ")");
  lines.push("실현손익 " + won(pnl.realizedPnl));
  lines.push("수수료 " + won(pnl.commissionPaid) + " · 세금 " + won(pnl.taxPaid));
  lines.push("승률 " + (pnl.winRate != null ? pnl.winRate + "%" : "—") +
             " (" + (pnl.wins || 0) + "승 " + (pnl.losses || 0) + "패) · PF " + (pnl.profitFactor || "—"));

  const closed = pnl.closedTrades || [];
  const open = pnl.openPositions || [];
  lines.push("청산 " + closed.length + "건 · 미결 " + open.length + "건");

  for (const t of closed.slice(0, 10)) {
    const emoji = t.netPnl > 0 ? "📈" : t.netPnl < 0 ? "📉" : "➖";
    lines.push("  " + emoji + " " + t.symbol + " " + t.qty + "@" + t.price + " → " + won(t.netPnl) + " (" + (t.pnlPct || "—") + ")");
  }
  if (closed.length > 10) lines.push("  … " + (closed.length - 10) + " more");
  for (const p of open.slice(0, 10)) {
    lines.push("  🟢 " + p.symbol + " " + p.qty + "@" + p.entryPrice + " (미실현)");
  }
  if (open.length > 10) lines.push("  … " + (open.length - 10) + " more");

  if (pnl.unknownPnlCount > 0) {
    lines.push("");
    lines.push("⚠️ 청산 " + pnl.unknownPnlCount + "건은 진입가 미확인(상태 미복원)으로 실현손익 미상 — 위 손익에 미반영");
  }
  if (pnl.suspiciousCount > 0) {
    lines.push("");
    lines.push("⚠️ 의심 거래 " + pnl.suspiciousCount + "건 — 진입가 미기록으로 손익이 실제와 다를 수 있음");
  }
  if (pnl.correctionCount > 0) {
    lines.push("📝 소급 보정 " + pnl.correctionCount + "건 적용됨");
  }

  const sa = (health && health.selfAudit) || {};
  const limits = (health && health.limits) || {};
  lines.push("");
  lines.push("자기자본 " + (sa.equityKrw ? won(sa.equityKrw) : "n/a"));
  const phase = limits.phaseName || limits.phase || "—";
  const halted = limits.halted === true ? "🚨 HALTED" : "false";
  lines.push("Phase " + phase + " · Halted " + halted);
  const ai = (health && health.ai) || {};
  lines.push("실행오류(1h) " + (sa.executionErrorsLastHour || 0) +
             " · 인증오류(1h) " + (sa.authFailuresLastHour || 0) +
             " · AI " + (ai.successes || 0) + "/" + (ai.failures || 0));

  return lines.join("\n");
}

module.exports = { formatSessionSummary };
