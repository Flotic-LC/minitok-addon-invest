/**
 * Add STATE_DIR / EVOLUTION_CANDLES_PATH / WALK_FORWARD_ENABLED / BT_MIN_TRADES
 * to the invest-bot service in docker-compose.production.yml.
 * Idempotent: re-running does not duplicate the block.
 */
"use strict";
const fs = require("fs");

const FILE = "/opt/minitok/addons/invest/docker-compose.production.yml";
let src = fs.readFileSync(FILE, "utf8");

if (src.includes("STATE_DIR")) {
  console.log("Already patched (STATE_DIR present). Nothing to do.");
  process.exit(0);
}

const anchor = "      - SIDECAR_URL=http://sidecar:8471\n";
if (!src.includes(anchor)) {
  console.error("ANCHOR NOT FOUND: " + JSON.stringify(anchor));
  process.exit(1);
}

const block = anchor + [
  "      # [P10-4] Persist runner state to the durable volume. Without STATE_DIR the",
  "      # state file lands at /app/.runner-state.json (container layer) and is wiped",
  "      # on every recreate, so entryPrices/peakPrices/recentFills restore as 0.",
  "      - STATE_DIR=/app/state",
  "      # [P10-5] Evolution was enabled but had no candle source, so every cycle hit",
  '      # "[evolution] skipped - EVOLUTION_CANDLES_PATH not set" and walk-forward',
  "      # never ran. Point both at a real candle file.",
  "      - EVOLUTION_CANDLES_PATH=/app/candles.json",
  "      - WALK_FORWARD_ENABLED=true",
  "      # [P10-1] Minimum trades before backtest feedback may tune SL/TP.",
  "      - BT_MIN_TRADES=20",
].join("\n") + "\n";

src = src.replace(anchor, block);
fs.writeFileSync(FILE, src, "utf8");
console.log("Patched " + FILE);
console.log("--- invest-bot environment block ---");
const i = src.indexOf("  invest-bot:");
console.log(src.substring(i, src.indexOf("    volumes:", i)));