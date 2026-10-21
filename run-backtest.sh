#!/bin/bash
# [P0-2] Automated Backtest Runner
# Fetches recent candle data from the Toss API and runs backtest.js.
# Designed to be executed via cron or manually.
#
# Usage: ./run-backtest.sh
# Output: backtest-result.json in the same directory, and a copy in the
#         durable state volume so the runner can read it.
#
# [2026-10-21] This script was part of the broken measurement pipeline. Fixed:
#   - it fetched Korean symbols while the bot trades US equities, so the
#     measurement did not describe the live strategy;
#   - the candle field mapping used `|| 0`, which is exactly how a candles
#     file with open/close = 0 was produced: a renamed field silently became
#     a zero price and the backtest then "ran" on an untradable dataset;
#   - the backtest order clip was taken from MAX_ORDER_VALUE_KRW, a LIVE
#     absolute KRW amount sized for a 73M KRW account. Against the backtest's
#     10M KRW starting equity that clip is larger than the whole account,
#     every order is unaffordable, and the run ends with zero trades;
#   - the exit code was ignored, so a rejected run was reported as success.
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

# The durable location the runner reads the result from. The runner's state
# directory is a mounted volume, so a result written here survives a
# container recreate — the result used to be written into the image layer,
# where the runner could never see it.
STATE_DIR="${STATE_DIR:-/var/lib/docker/volumes/minitok-invest_invest-state/_data}"
RESULT_DIR="${BACKTEST_RESULT_DIR:-$SCRIPT_DIR}"

# Symbols to measure. These must be the markets the bot actually trades, or
# the measurement describes a strategy that is not running.
BACKTEST_SYMBOLS="${BACKTEST_SYMBOLS:-AAPL MSFT NVDA SPY QQQ}"
BACKTEST_CANDLE_COUNT="${BACKTEST_CANDLE_COUNT:-120}"

# The backtest's own money model. The order clip is a SHARE of the starting
# equity, not the live absolute KRW limit.
#
# The unit follows the unit of the candles, which for the US universe is USD.
# Only the ratios matter: 15% per position and a 100%-of-equity daily traded
# value limit mirror the live configuration.
BT_INITIAL="${BT_INITIAL:-10000}"
BT_ORDER_PCT="${BT_ORDER_PCT:-15}"
BT_COMMISSION="${BT_COMMISSION:-0.25}"   # US commission, 0.25% per side
BT_SLIPPAGE="${BT_SLIPPAGE:-0.1}"        # 0.1% slippage per trade
BT_STOP_LOSS="${BT_STOP_LOSS:--8}"
BT_TAKE_PROFIT="${BT_TAKE_PROFIT:-8}"
BT_MAX_ORDER=$(( BT_INITIAL * BT_ORDER_PCT / 100 ))

echo "[backtest-cron] $(date -u +%Y-%m-%dT%H:%M:%SZ) Starting automated backtest..."
echo "[backtest-cron] symbols: $BACKTEST_SYMBOLS | initial=$BT_INITIAL KRW | order=${BT_ORDER_PCT}% (${BT_MAX_ORDER} KRW) | commission=${BT_COMMISSION}%"

# Step 1+2: Use Node.js with tossinvest.js adapter to fetch candles
# This avoids bash quoting issues and handles gzip/auth/response unwrapping correctly
CANDLES_FILE="$SCRIPT_DIR/candles.json"

node -e "
const path = require('path');
const fs = require('fs');
const { validateCandleData } = require('./src/strategy/candle-validation');

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
const symbols = process.argv[2].split(/\s+/).filter(Boolean);
const count = Number(process.argv[3]) || 120;
const outFile = process.argv[1];

/**
 * Read a field without the '|| 0' fallback that used to turn an unmapped
 * field into a zero price. A missing field is an error, not a zero.
 *
 * The live API returns openPrice / highPrice / lowPrice / closePrice. The
 * old mapping looked for 'open' and 'closingPrice', matched neither, and
 * wrote 0 for the open and the close of every single candle — which is
 * exactly the dataset that produced the zero-valued "measurement".
 */
function pick(c, names) {
  for (const n of names) {
    const v = c[n];
    if (v !== undefined && v !== null && v !== '') return Number(v);
  }
  return null;
}

(async () => {
  try {
    const token = await fetchAccessToken(clientId, clientSecret);
    console.log('[backtest-cron] Token obtained successfully');

    const allCandles = [];
    let rejected = 0;
    for (const sym of symbols) {
      try {
        // Use interval='1d' as required by Toss API (not 'DAY')
        const resp = await getCandles(token, sym, '1d', { count: count });
        const body = resp.body;
        // Response structure: array of candle objects or wrapped in result
        const candles = Array.isArray(body) ? body : (body && (body.candles || body.items) ? (body.candles || body.items) : []);
        let kept = 0;
        for (const c of candles) {
          const open = pick(c, ['open', 'openPrice', 'openingPrice']);
          const high = pick(c, ['high', 'highPrice']);
          const low = pick(c, ['low', 'lowPrice']);
          const close = pick(c, ['close', 'closePrice', 'tradePrice', 'closingPrice']);
          const volume = pick(c, ['volume', 'accTradeVolume', 'tradingVolume']);
          const date = c.date || c.timestamp || c.dateTime || null;
          if (open === null || high === null || low === null || close === null || !date) {
            rejected++;
            console.error('[backtest-cron] Rejected a candle for ' + sym + ': unmapped or missing field ('
              + 'open=' + open + ' high=' + high + ' low=' + low + ' close=' + close + ' date=' + date + ')');
            continue;
          }
          allCandles.push({ symbol: sym, date: String(date).slice(0, 10), open, high, low, close, volume: volume || 0 });
          kept++;
        }
        console.log('[backtest-cron] Fetched ' + kept + '/' + candles.length + ' usable candles for ' + sym);
      } catch (e) {
        console.error('[backtest-cron] Error fetching ' + sym + ': ' + e.message);
      }
    }

    allCandles.sort((a, b) => String(a.date).localeCompare(String(b.date)));

    // Fail closed: never publish a dataset that cannot be measured.
    const validation = validateCandleData(allCandles);
    if (!validation.ok) {
      console.error('[backtest-cron] CANDLE DATA REJECTED: ' + validation.invalidReason);
      for (const issue of validation.issues) console.error('[backtest-cron]   - ' + issue);
      console.error('[backtest-cron] No candles.json was written and no backtest was run.');
      process.exit(2);
    }
    if (rejected > 0) {
      console.error('[backtest-cron] ' + rejected + ' candles were dropped during the fetch.');
    }
    fs.writeFileSync(outFile, JSON.stringify(allCandles, null, 2), 'utf8');
    console.log('[backtest-cron] Total: ' + allCandles.length + ' candles written to ' + outFile
      + ' (' + validation.metadata.symbolCount + ' symbol(s), ' + validation.metadata.dataStart
      + ' .. ' + validation.metadata.dataEnd + ')');
  } catch (e) {
    console.error('[backtest-cron] Fatal: ' + e.message);
    process.exit(1);
  }
})();
" "$CANDLES_FILE" "$BACKTEST_SYMBOLS" "$BACKTEST_CANDLE_COUNT"

# Step 3: Run backtest if we have data
if [ ! -f "$CANDLES_FILE" ] || [ "$(wc -c < "$CANDLES_FILE")" -lt 10 ]; then
  echo "[backtest-cron] No candle data fetched, skipping backtest"
  exit 0
fi

echo "[backtest-cron] Running backtest with SL=$BT_STOP_LOSS%, TP=$BT_TAKE_PROFIT%, maxOrder=$BT_MAX_ORDER KRW, commission=$BT_COMMISSION%"
set +e
node "$SCRIPT_DIR/backtest.js" \
  --data "$CANDLES_FILE" \
  --initial "$BT_INITIAL" \
  --stop-loss "$BT_STOP_LOSS" \
  --take-profit "$BT_TAKE_PROFIT" \
  --max-order-value "$BT_MAX_ORDER" \
  --commission "$BT_COMMISSION" \
  --slippage "$BT_SLIPPAGE"
BT_EXIT=$?
set -e

# Step 4: Publish only a trustworthy result.
# backtest.js exits 0 for a valid result, 2 for rejected input and 3 for a
# result that is not trustworthy (zero trades or a degraded dataset). In the
# latter cases it wrote backtest-result.invalid.json and left the previous
# result alone, so there is nothing to publish.
if [ "$BT_EXIT" -ne 0 ]; then
  echo "[backtest-cron] Backtest did not produce a trustworthy result (exit $BT_EXIT)."
  if [ -f "$SCRIPT_DIR/backtest-result.invalid.json" ]; then
    cp "$SCRIPT_DIR/backtest-result.invalid.json" "$RESULT_DIR/backtest-result.invalid.json" 2>/dev/null || true
    echo "[backtest-cron] Quarantined result copied to $RESULT_DIR/backtest-result.invalid.json"
  fi
  echo "[backtest-cron] The previous backtest-result.json was left untouched."
  exit "$BT_EXIT"
fi

if [ -f "$SCRIPT_DIR/backtest-result.json" ]; then
  echo "[backtest-cron] backtest-result.json created successfully"
  cp "$SCRIPT_DIR/backtest-result.json" "$SCRIPT_DIR/backtest-result.json.bak" 2>/dev/null || true
  # The runner reads the result from its durable state directory.
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  cp "$SCRIPT_DIR/backtest-result.json" "$STATE_DIR/backtest-result.json" 2>/dev/null \
    && echo "[backtest-cron] Published to $STATE_DIR/backtest-result.json" \
    || echo "[backtest-cron] WARNING: could not publish to $STATE_DIR (the runner will not see it)"
else
  echo "[backtest-cron] WARNING: backtest-result.json was not created"
  exit 1
fi

echo "[backtest-cron] $(date -u +%Y-%m-%dT%H:%M:%SZ) Done"
