"use strict";
// Direct test of Profundo AI API from the server itself.
// Usage: node test-ai-api.js
const baseUrl = process.env.PROFUNDO_BASE_URL || "https://api.profundoai.com/v1";
const apiKey = process.env.PROFUNDO_API_KEY || "";
const model = process.env.PROFUNDO_MODEL || "gpt-6-astra";

if (!apiKey) {
  console.error("PROFUNDO_API_KEY not set");
  process.exit(1);
}

async function main() {
  const payload = {
    model: model,
    messages: [{ role: "user", content: "Reply with the single word OK." }],
    max_tokens: 10,
    temperature: 0,
  };
  console.log("POST " + baseUrl + "/chat/completions");
  console.log("Payload: " + JSON.stringify(payload));
  const t0 = Date.now();
  try {
    const res = await fetch(baseUrl + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey,
      },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    console.log("HTTP " + res.status + " (" + (Date.now() - t0) + "ms)");
    console.log(text.substring(0, 1000));
    if (res.status === 200) {
      try {
        const j = JSON.parse(text);
        const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
        console.log("AI reply: " + content);
      } catch (e) {
        console.log("Parse error: " + e.message);
      }
    }
  } catch (e) {
    console.error("Fetch error: " + e.message);
    process.exit(2);
  }
}

main();
