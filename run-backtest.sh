#!/bin/bash
# [P0-2] Automated Backtest Runner
# Fetches recent candle data from Toss API and runs backtest.js
# Designed to be executed via cron or manually.
#
# Usage: ./run-backtest.sh
# Output: backtest-result.json in the same directory

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Load environment variables
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

if [ -z "${TOSS_CLIENT_ID:-}" ] || [ -z "${TOSS_CLIENT_SECRET:-}" ]; then
  echo "[backtest-cron] ERROR: TOSS_CLIENT_ID or TOSS_CLIENT_SECRET not set"
  exit 1
fi

echo "[backtest-cron] $(date -u +%Y-%m-%dT%H:%M:%SZ) Starting automated backtest..."

# Step 1+2: Use Node.js with tossinvest.js adapter to fetch candles
# This avoids bash quoting issues and handles gzip/auth/response unwrapping correctly
CANDLES_FILE="$SCRIPT_DIR/candles.json"

node -e "
const path = require('path');
const fs = require('fs');

// Load .env manually since dotenv may not be installed
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx > 0) {
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

const { fetchAccessToken, getCandles } = require('./src/tossinvest');

const clientId = process.env.TOSS_CLIENT_ID;
const clientSecret = process.env.TOSS_CLIENT_SECRET;
const symbols = ['005930', '000660', '035720'];
const outFile = process.argv[1];

(async () => {
  try {
    const token = await fetchAccessToken(clientId, clientSecret);
    console.log('[backtest-cron] Token obtained successfully');

    const allCandles = [];
    for (const sym of symbols) {
      try {
        // Use interval='1d' as required by Toss API (not 'DAY')
        const resp = await getCandles(token, sym, '1d', { count: 60 });
        const body = resp.body;
        // Response structure: array of candle objects or wrapped in result
        const candles = Array.isArray(body) ? body : (body && body.candles ? body.candles : []);
        for (const c of candles) {
          allCandles.push({
            symbol: sym,
            date: c.date || c.timestamp || c.dateTime || new Date().toISOString().slice(0,10),
            open: Number(c.open || c.openingPrice || 0),
            high: Number(c.high || c.highPrice || 0),
            low: Number(c.low || c.lowPrice || 0),
            close: Number(c.close || c.tradePrice || c.closingPrice || 0),
            volume: Number(c.volume || c.accTradeVolume || c.tradingVolume || 0),
          });
        }
        console.log('[backtest-cron] Fetched ' + candles.length + ' candles for ' + sym);
      } catch (e) {
        console.error('[backtest-cron] Error fetching ' + sym + ': ' + e.message);
      }
    }

    allCandles.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    fs.writeFileSync(outFile, JSON.stringify(allCandles, null, 2), 'utf8');
    console.log('[backtest-cron] Total: ' + allCandles.length + ' candles written to ' + outFile);
  } catch (e) {
    console.error('[backtest-cron] Fatal: ' + e.message);
    process.exit(1);
  }
})();
" "$CANDLES_FILE"

# Step 3: Run backtest if we have data
if [ ! -f "$CANDLES_FILE" ] || [ "$(wc -c < "$CANDLES_FILE")" -lt 10 ]; then
  echo "[backtest-cron] No candle data fetched, skipping backtest"
  exit 0
fi

# Read current SL/TP from env or use defaults
SL="${STOP_LOSS_PCT:--2}"
TP="${TAKE_PROFIT_PCT:-5}"
MAX_ORDER="${MAX_ORDER_VALUE_KRW:-300000}"

echo "[backtest-cron] Running backtest with SL=$SL%, TP=$TP%, maxOrder=$MAX_ORDER KRW"
node "$SCRIPT_DIR/backtest.js" --data "$CANDLES_FILE" --stop-loss "$SL" --take-profit "$TP" --max-order-value "$MAX_ORDER"

# Step 4: Verify result was written
if [ -f "$SCRIPT_DIR/backtest-result.json" ]; then
  echo "[backtest-cron] backtest-result.json created successfully"
  cp "$SCRIPT_DIR/backtest-result.json" "$SCRIPT_DIR/backtest-result.json.bak" 2>/dev/null || true
else
  echo "[backtest-cron] WARNING: backtest-result.json was not created"
fi

echo "[backtest-cron] $(date -u +%Y-%m-%dT%H:%M:%SZ) Done"