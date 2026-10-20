/**
 * Deep analysis of WTS auth mechanism from the app bundle.
 * Search for: Bearer tokens, Authorization headers, app-secret, device-id patterns,
 * and any custom headers used specifically for wts-cert-api calls.
 */
"use strict";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

(async () => {
  const t = await (await fetch("https://www.tossinvest.com/assets/v2/_next/static/chunks/pages/_app-defa174fe05bb4ad.js", { headers: { "User-Agent": UA } })).text();
  
  // 1. Find all Authorization/Bearer/header patterns near exchange or cert
  console.log("=== Authorization/Bearer patterns ===");
  const authRe = /[Aa]uthorization["']?\s*[:=]\s*["']?(Bearer\s+)?[^"',;}{)]{5,80}/g;
  for (const m of t.matchAll(authRe)) {
    const ctx = t.substring(Math.max(0, m.index - 200), m.index + m[0].length + 100).replace(/\s+/g, " ");
    if (ctx.includes("exchange") || ctx.includes("cert") || ctx.includes("wts")) {
      console.log(`\n@${m.index}: ${m[0]}\nCTX: ${ctx.substring(0, 300)}`);
    }
  }

  // 2. Find custom header definitions (x-toss-*, app-*, device-*)
  console.log("\n\n=== Custom headers near exchange/cert ===");
  const hdrRe = /["'](x-toss-[a-z-]+|app-[a-z-]+|device-[a-z-]+|toss-[a-z-]+)["']/gi;
  const seen = new Set();
  for (const m of t.matchAll(hdrRe)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      const ctx = t.substring(Math.max(0, m.index - 150), m.index + m[0].length + 150).replace(/\s+/g, " ");
      console.log(`${m[1]}: ${ctx.substring(0, 250)}`);
    }
  }

  // 3. Find the actual fetch/request wrapper that handles cert host
  console.log("\n\n=== Request wrapper for cert host ===");
  const certIdx = t.indexOf('host:"cert"');
  if (certIdx !== -1) {
    // Look backwards for the function that processes this
    const chunk = t.substring(Math.max(0, certIdx - 2000), certIdx + 500);
    // Find fetch/request patterns
    const fetchRe = /(fetch|request|axios|http)\s*\([^)]{0,300}\)/g;
    for (const m of chunk.matchAll(fetchRe)) {
      console.log(`FETCH: ${m[0].substring(0, 200)}`);
    }
    // Find header construction
    const headerChunk = chunk.substring(Math.max(0, chunk.length - 1500));
    console.log("\nHEADER CONTEXT:", headerChunk.replace(/\s+/g, " ").substring(0, 800));
  }

  // 4. Search for token refresh or session management
  console.log("\n\n=== Token/session management ===");
  const tokenPatterns = ["refreshToken", "accessToken", "sessionToken", "authToken", "getAccessToken", "renewSession"];
  for (const p of tokenPatterns) {
    let idx = -1;
    while ((idx = t.indexOf(p, idx + 1)) !== -1) {
      const ctx = t.substring(Math.max(0, idx - 100), idx + p.length + 200).replace(/\s+/g, " ");
      if (ctx.includes("exchange") || ctx.includes("cert") || ctx.includes("wts") || ctx.includes("order")) {
        console.log(`${p} @${idx}: ${ctx.substring(0, 300)}`);
      }
    }
  }

  // 5. Find POST body construction for exchange-auto-orders
  console.log("\n\n=== exchange-auto-orders POST body ===");
  let searchIdx = 0;
  while ((searchIdx = t.indexOf("exchange-auto-orders", searchIdx + 1)) !== -1) {
    const before = t.substring(Math.max(0, searchIdx - 800), searchIdx);
    const after = t.substring(searchIdx, searchIdx + 400);
    const combined = (before + after).replace(/\s+/g, " ");
    // Look for object literals or JSON.stringify nearby
    if (combined.includes("POST") || combined.includes("body") || combined.includes("stringify") || combined.includes("token")) {
      console.log(`\n@${searchIdx}: ${combined.substring(Math.max(0, combined.length - 600), combined.length)}`);
    }
  }
})();