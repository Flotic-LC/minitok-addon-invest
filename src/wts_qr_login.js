/**
 * WTS QR Login Daemon
 *
 * 1. Opens tossinvest.com/signin in Playwright (headless)
 * 2. Clicks "QR코드로 로그인" → fetches QR image + answer letter
 * 3. Sends QR to Telegram
 * 4. Polls /api/v2/login/wts/toss/status until logged in
 * 5. Extracts UTK / XSRF-TOKEN / SESSION cookies
 * 6. Prints them in WTS_UTK=... WTS_XSRF=... form and writes state file
 *
 * Usage: node wts_qr_login.js [--timeout 180]
 */
"use strict";
const fs = require("fs");
const path = require("path");

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const SIGNIN_URL = "https://www.tossinvest.com/signin?redirectUrl=%2F";
const POLL_INTERVAL_MS = 3000;

function argTimeout() {
  const i = process.argv.indexOf("--timeout");
  if (i >= 0 && process.argv[i + 1]) return parseInt(process.argv[i + 1], 10) * 1000;
  return 300000; // 5 min default
}

async function tgSendText(text) {
  if (!TG_TOKEN || !TG_CHAT) { console.log("[TG] not configured, skipping text:", text); return; }
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text }),
    });
    const j = await r.json();
    if (!j.ok) console.log("[TG] sendMessage failed:", JSON.stringify(j));
  } catch (e) { console.log("[TG] sendMessage error:", e.message); }
}

async function tgSendPhoto(base64Png, caption) {
  if (!TG_TOKEN || !TG_CHAT) { console.log("[TG] not configured, skipping photo"); return; }
  try {
    const form = new FormData();
    form.append("chat_id", TG_CHAT);
    if (caption) form.append("caption", caption);
    form.append("photo", new Blob([Buffer.from(base64Png, "base64")], { type: "image/png" }), "qr.png");
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, { method: "POST", body: form });
    const j = await r.json();
    if (!j.ok) console.log("[TG] sendPhoto failed:", JSON.stringify(j).substring(0, 300));
  } catch (e) { console.log("[TG] sendPhoto error:", e.message); }
}

async function main() {
  const timeoutMs = argTimeout();
  console.log(`[QR-LOGIN] Starting. timeout=${timeoutMs / 1000}s`);
  const { chromium } = require("playwright");

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const ctx = await browser.newContext({
    locale: "ko-KR",
    viewport: { width: 480, height: 900 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await ctx.newPage();

  let qrBase64 = null;
  let answerLetter = null;
  let lastStatusBody = null;
  let statusHttp = null;

  page.on("response", async (r) => {
    try {
      const u = r.url();
      if (u.includes("/api/v2/login/wts/toss/qr") && r.status() === 200) {
        const body = await r.json();
        const res = body?.result;
        if (res?.qrCode) {
          const next = res.qrCode.replace(/^data:image\/png;base64,/, "");
          if (next !== qrBase64) {
            qrBase64 = next;
            answerLetter = res.answerLetter || answerLetter;
            console.log("[QR-LOGIN] QR received. answerLetter=" + answerLetter);
          }
        }
      }
      // Capture the site's OWN status polling responses (they carry session auth)
      if (u.includes("/api/v2/login/wts/toss/status")) {
        statusHttp = r.status();
        try { lastStatusBody = await r.json(); } catch { lastStatusBody = null; }
      }
    } catch {}
  });

  try {
    await page.goto(SIGNIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);

    const qrBtn = await page.$('button:has-text("QR코드로 로그인")');
    if (!qrBtn) throw new Error("QR button not found on signin page");
    await qrBtn.click();
    console.log("[QR-LOGIN] Clicked QR login button");

    await page.waitForTimeout(5000);
    if (!qrBase64) {
      const domQr = await page.evaluate(() => {
        const img = document.querySelector("img[src^='data:image/png']");
        return img ? img.src.replace(/^data:image\/png;base64,/, "") : null;
      });
      if (domQr) { qrBase64 = domQr; console.log("[QR-LOGIN] QR extracted from DOM"); }
    }
    if (!answerLetter) {
      answerLetter = await page.evaluate(() => {
        const m = document.body.innerText.match(/화면에 보는 문자 3개 중\s*(\S+)\s*을/);
        return m ? m[1] : null;
      });
    }
    if (!qrBase64) throw new Error("Failed to obtain QR code");
    console.log(`[QR-LOGIN] QR ready. answerLetter="${answerLetter || "?"}"`);

    // 4. Send QR to Telegram
    await tgSendText(
      `🔐 [WTS] 토스증권 QR 로그인 필요!\n\n` +
      `아래 QR 코드를 토스 앱으로 스캔하고\n` +
      `화면의 문자 3개 중 "${answerLetter || "?"}" 를 선택하세요.\n\n` +
      `⏳ ${Math.round(timeoutMs / 60000)}분 내 스캔 필요 (미스캔 시 자동 종료)`
    );
    await tgSendPhoto(qrBase64, `토스 앱으로 스캔 → 문자 "${answerLetter}" 선택`);

    // 5. Poll status until logged in
    const deadline = Date.now() + timeoutMs;
    let lastStatus = "";
    let success = false;

    while (Date.now() < deadline) {
      await page.waitForTimeout(POLL_INTERVAL_MS);
      try {
        // The signin page polls /status itself with proper session context.
        // We read the responses it already receives instead of issuing our own.
        if (statusHttp && statusHttp !== 403 && lastStatusBody) {
          const b = lastStatusBody;
          const res = b.result || b.data || b;
          const status = res.status || res.loginStatus || "UNKNOWN";
          const qrStatus = res.qrStatus || res.loginTypeStatus || "";
          const userStatus = res.userStatus || "";
          const sig = `${statusHttp} ${status}/${qrStatus}/${userStatus}`;
          if (sig !== lastStatus) {
            console.log(`[QR-LOGIN] status=${sig}`);
            lastStatus = sig;
          }

          const done = /^(COMPLETED|SUCCEED|SUCCESS|CONFIRMED)$/i.test(status) ||
                       userStatus === "ASSIGNED" ||
                       qrStatus === "CONFIRMED";
          if (done) {
            const cookies = await ctx.cookies();
            if (cookies.find((c) => c.name === "UTK")) { success = true; break; }
          }
          if (/^(FAILED|EXPIRED|REJECTED|DENIED)$/i.test(status)) throw new Error(`Login ${status}`);
        } else if (statusHttp === 403) {
          // session cookie not yet attached — keep waiting
          if (lastStatus !== "403") { console.log("[QR-LOGIN] status poll unauth (403), waiting for session..."); lastStatus = "403"; }
        }
      } catch (e) {
        if (/^Login /.test(e.message)) throw e;
      }
    }
    if (!success) throw new Error("Timeout waiting for QR scan");
    if (lastStatusBody) console.log("[QR-LOGIN] final status body:", JSON.stringify(lastStatusBody).substring(0, 300));

    // 6. Wait for session cookies to settle, then reload homepage
    await page.waitForTimeout(3000);
    await page.goto("https://www.tossinvest.com/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const cookies = await ctx.cookies();
    const utk = cookies.find((c) => c.name === "UTK");
    const xsrf = cookies.find((c) => c.name === "XSRF-TOKEN");
    const session = cookies.find((c) => c.name === "SESSION");
    if (!utk) throw new Error("UTK cookie missing after login");
    if (!session) console.log("[QR-LOGIN] WARN: SESSION cookie not found");

    const auth = {
      utk: utk.value,
      xsrf: xsrf ? xsrf.value : null,
      session: session ? session.value : null,
      allCookies: cookies.map((c) => `${c.name}=${c.value}`),
      extractedAt: new Date().toISOString(),
    };

    console.log("[QR-LOGIN] SUCCESS");
    console.log("[QR-LOGIN] cookies:", cookies.map((c) => c.name).join(", "));
    console.log("WTS_UTK=" + auth.utk);
    console.log("WTS_XSRF=" + (auth.xsrf || ""));
    console.log("WTS_SESSION=" + (auth.session || ""));

    // 7. Verify: /api/v1/accounts must return 200 when truly logged in (401 = anonymous)
    const cookieAll = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    try {
      const headers = { Accept: "application/json", Cookie: cookieAll, Origin: "https://www.tossinvest.com", Referer: "https://www.tossinvest.com/" };
      if (auth.xsrf) headers["X-XSRF-TOKEN"] = auth.xsrf;
      const r = await fetch("https://wts-api.tossinvest.com/api/v1/accounts", { headers });
      const t = await r.text();
      console.log("[QR-LOGIN] verify /api/v1/accounts → HTTP " + r.status + " " + t.substring(0, 200));
      auth.verified = r.status === 200;
      if (auth.verified) { try { const j = JSON.parse(t); auth.accountKey = j?.result?.accounts?.[0]?.key || null; } catch {} }
      else console.log("[QR-LOGIN] WARN: /api/v1/accounts returned " + r.status + " (session may need a different endpoint)");
    } catch (e) {
      auth.verified = false;
      console.log("[QR-LOGIN] verify error:", e.message);
    }

    // 8. Write state file
    const statePath = path.join(__dirname, "wts_auth_state.json");
    fs.writeFileSync(statePath, JSON.stringify(auth, null, 2));
    console.log("[QR-LOGIN] State written: " + statePath);

    // 8b. Save full Playwright storage state (cookies + localStorage) for browser-proxied requests
    try {
      const storagePath = path.join(__dirname, "wts_storage_state.json");
      await ctx.storageState({ path: storagePath });
      console.log("[QR-LOGIN] Storage state written: " + storagePath);
    } catch (e) { console.log("[QR-LOGIN] storageState error:", e.message); }

    await tgSendText(
      `✅ [WTS] 토스 로그인 성공!\n` +
      `UTK=${auth.utk.substring(0, 12)}...\n` +
      `API 검증: ${auth.verified ? "OK (200)" : "실패"}\n` +
      `서버 .env 주입 진행 중...`
    );

    process.exitCode = 0;
  } catch (e) {
    console.error("[QR-LOGIN] FAIL:", e.message);
    await tgSendText(`❌ [WTS] QR 로그인 실패: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
  process.exit(process.exitCode || 0);
}

main();
