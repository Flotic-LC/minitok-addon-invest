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

const { fetchAccessToken, getAccounts, getHoldings } = require("./src/tossinvest");

(async () => {
  try {
    const token = await fetchAccessToken(process.env.TOSS_CLIENT_ID, process.env.TOSS_CLIENT_SECRET);
    console.log("Token OK.");

    // 1. List all accounts
    console.log("--- getAccounts ---");
    const accounts = await getAccounts(token);
    console.log(JSON.stringify(accounts.body?.json ? accounts.body.json() : accounts.body, null, 2));

    // 2. Try getHoldings with empty/no accountSeq to see error
    console.log("--- getHoldings (no accountSeq) ---");
    try {
      const h = await getHoldings(token, "");
      console.log("Status:", h.status);
      console.log("Body:", JSON.stringify(h.body?.json ? h.body.json() : h.body, null, 2));
    } catch (e) {
      console.log("Error:", e.message);
    }

  } catch (err) {
    console.error("FATAL:", err.message);
    console.error(err.stack);
  }
})();