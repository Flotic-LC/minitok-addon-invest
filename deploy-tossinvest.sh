#!/bin/bash
# Deploy minitok tossinvest addon changes to server
# Downloads updated files from GitHub Gist and runs deploy.sh
set -e

ADDON_DIR="/opt/minitok/addons/invest"
if [ ! -d "$ADDON_DIR" ]; then
    ADDON_DIR="/opt/minitok/addons/tossinvest"
fi
if [ ! -d "$ADDON_DIR" ]; then
    echo "ERROR: Addon directory not found"
    echo "Checked: /opt/minitok/addons/invest /opt/minitok/addons/tossinvest"
    exit 1
fi

echo "Addon directory: $ADDON_DIR"

GIST_BASE="https://gist.githubusercontent.com/Flotic-LC/8df220e49bf021e7eb9bf230443cb727/raw"

declare -A FILES=(
    ["runner.js"]="641ac4ef6a8bd542226178ae01fcbe202ecef532"
    ["pnl.js"]="62c868610869e947693d3265e618006bccddf044"
    ["target.js"]="5ae57fa763725e1ecffd8bf2df66369f6ef2d3a3"
    ["store.js"]="8b43601c9050e9d756c099c9cdabcfd5bb816733"
    ["performance-monitor.js"]="8625900f96c78ac672e39fd1484ff63f4c1ee332"
)

declare -A DEST=(
    ["runner.js"]="${ADDON_DIR}/runner.js"
    ["pnl.js"]="${ADDON_DIR}/src/agent/pnl.js"
    ["target.js"]="${ADDON_DIR}/src/agent/target.js"
    ["store.js"]="${ADDON_DIR}/src/store.js"
    ["performance-monitor.js"]="${ADDON_DIR}/src/agent/performance-monitor.js"
)

echo "Downloading changed files from Gist..."
for name in "${!FILES[@]}"; do
    url="${GIST_BASE}/${FILES[$name]}/${name}"
    dst="${DEST[$name]}"
    mkdir -p "$(dirname "$dst")"
    echo "  $name -> $dst"
    curl -sf "$url" -o "$dst"
    echo "  OK"
done

echo "All files downloaded."
echo "Running deploy.sh..."
bash "${ADDON_DIR}/scripts/deploy.sh"
