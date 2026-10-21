const fs = require("fs");
const path = require("path");

// Simple .env loader (no dotenv dependency)
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

const { createEquitySnapshotter } = require("./src/agent");

(async () => {
  console.log("TOSS_CLIENT_ID set:", !!process.env.TOSS_CLIENT_ID);
  console.log("TOSS_CLIENT_SECRET set:", !!process.env.TOSS_CLIENT_SECRET);
  console.log("TOSS_ACCOUNT_SEQ set:", !!process.env.TOSS_ACCOUNT_SEQ);

  const s = createEquitySnapshotter({
    credentials: { clientId: process.env.TOSS_CLIENT_ID, clientSecret: process.env.TOSS_CLIENT_SECRET },
    accountSeq: process.env.TOSS_ACCOUNT_SEQ,
    currency: "KRW"
  });

  try {
    console.log("Fetching equity...");
    const equity = await s.fetchEquity();
    console.log("EQUITY_RESULT:", equity);
    console.log("Recording snapshot...");
    const phase = await s.snapshot();
    console.log("PHASE_AFTER:", phase);
  } catch (err) {
    console.error("EQUITY_ERROR:", err.message);
    console.error(err.stack);
  }
})();