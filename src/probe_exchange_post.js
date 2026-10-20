/**
 * Scan the app bundle for ALL exchange-related POST definitions on cert host,
 * and extract the surrounding code to find the request body schema.
 */
"use strict";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

(async () => {
  const t = await (await fetch("https://www.tossinvest.com/assets/v2/_next/static/chunks/pages/_app-defa174fe05bb4ad.js", { headers: { "User-Agent": UA } })).text();

  // 1. Find all POST definitions with host:"cert" that contain "exchange"
  const re = /\(0,[a-zA-Z0-9_$.]+\)\(\{host:"cert",method:"POST",path:"([^"]*exchange[^"]*)"[^}]*\}\)/g;
  console.log("=== cert POST exchange routes ===");
  for (const m of t.matchAll(re)) {
    console.log(`POST ${m[1]}`);
    // Get 800 chars before and after this match for context
    const idx = m.index;
    const ctx = t.substring(Math.max(0, idx - 400), Math.min(t.length, idx + m[0].length + 800));
    console.log("CTX:", ctx.replace(/\s+/g, " ").substring(0, 600));
    console.log("---");
  }

  // 2. Also search for any function that calls exchange-auto-orders with POST
  // The route table shows GET only, but maybe there's a dynamic POST call
  const postRe = /method:\s*"POST"[^}]*path:\s*"([^"]*exchange[^"]*)"/g;
  console.log("\n=== All POST exchange (any host) ===");
  for (const m of t.matchAll(postRe)) {
    console.log(m[1]);
  }

  // 3. Search for body construction near exchange order creation
  // Look for patterns like: {token: ..., sellAmount: ...} or similar
  const bodyRe = /exchange-auto-order[^}]{0,500}/gi;
  console.log("\n=== exchange-auto-order context ===");
  let bm;
  let count = 0;
  while ((bm = bodyRe.exec(t)) !== null && count < 10) {
    count++;
    console.log(bm[0].replace(/\s+/g, " ").substring(0, 400));
    console.log("---");
  }

  // 4. Search for the actual function that triggers exchange execution
  // Look for keywords like "executeExchange", "submitExchange", "createExchange"
  const funcRe = /(execute|submit|create|place|send)[A-Za-z]*[Ee]xchange[A-Za-z]*\s*[=(]/g;
  console.log("\n=== Exchange execution functions ===");
  for (const m of t.matchAll(funcRe)) {
    const idx = m.index;
    console.log(t.substring(idx, idx + 300).replace(/\s+/g, " "));
    console.log("---");
  }
})();