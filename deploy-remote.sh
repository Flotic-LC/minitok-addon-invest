#!/bin/bash
set -e

ADDON_DIR="/opt/minitok/addons/invest"
if [ ! -d "$ADDON_DIR" ]; then
    ADDON_DIR="/opt/minitok/addons/tossinvest"
fi
if [ ! -d "$ADDON_DIR" ]; then
    echo "ERROR: Addon directory not found"
    exit 1
fi

echo "Addon dir: $ADDON_DIR"
SERVER="146.70.205.102"
PORT="8080"
BASE="http://${SERVER}:${PORT}"

echo "Downloading changed files..."
curl -sf "${BASE}/runner.js" -o "${ADDON_DIR}/runner.js"
mkdir -p "${ADDON_DIR}/src/agent"
curl -sf "${BASE}/src/agent/pnl.js" -o "${ADDON_DIR}/src/agent/pnl.js"
curl -sf "${BASE}/src/agent/target.js" -o "${ADDON_DIR}/src/agent/target.js"
curl -sf "${BASE}/src/store.js" -o "${ADDON_DIR}/src/store.js"
curl -sf "${BASE}/src/agent/performance-monitor.js" -o "${ADDON_DIR}/src/agent/performance-monitor.js"

echo "All files downloaded successfully"
echo "Running deploy.sh..."
bash "${ADDON_DIR}/scripts/deploy.sh"
