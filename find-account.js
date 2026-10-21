const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, "utf8").split("\n").forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const idx = trimmed.indexOf("=");
    if (idx < 0) return;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  });
}

const { fetchAccessToken } = require("./src/tossinvest");

(async () => {
  try {
    console.log("Fetching access token...");
    const token = await fetchAccessToken(process.env.TOSS_CLIENT_ID, process.env.TOSS_CLIENT_SECRET);
    console.log("Token acquired.");

    // Try common Toss account list endpoints
    const endpoints = [
      "/v1/accounts",
      "/v1/account/list",
      "/api/v1/accounts",
      "/v1/trading/accounts"
    ];

    for (const ep of endpoints) {
      try {
        const url = "https://api.tossinvest.com" + ep;
        console.log("Trying:", url);
        const resp = await fetch(url, {
          headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" }
        });
        const text = await resp.text();
        console.log("Status:", resp.status);
        console.log("Response:", text.substring(0, 500));
        console.log("---");
        if (resp.ok && text.includes("account")) break;
      } catch (e) {
        console.log("Error:", e.message);
      }
    }
  } catch (err) {
    console.error("FATAL:", err.message);
  }
})();