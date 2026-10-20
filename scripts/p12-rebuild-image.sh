#!/bin/bash
# P12 — Rebuild Docker image so the baked image contains the latest runner.js
# and provider-router.js (previously applied via docker cp).
# This eliminates the host-vs-image drift and makes future `docker compose up -d --build`
safe. Also verifies that the container's /app files match the host's /opt files by checksum.
set -euo pipefail

cd /opt/minitok/addons/invest
COMPOSE=docker-compose.production.yml
SVC=invest-bot
CTR=minitok-invest

echo "[p12-rebuild] $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "[p12-rebuild] Host file checksums:"
md5sum runner.js src/ai/provider-router.js

echo "[p12-rebuild] Building image (cached layers)..."
docker compose -f "$COMPOSE" build "$SVC"

echo "[p12-rebuild] Recreating container from new image..."
docker compose -f "$COMPOSE" up -d --no-deps "$SVC"

echo "[p12-rebuild] Waiting 20s for startup..."
sleep 20

echo "[p12-rebuild] Container file checksums:"
docker exec "$CTR" md5sum /app/runner.js /app/src/ai/provider-router.js

echo "[p12-rebuild] Health check..."
docker exec "$CTR" curl -s http://localhost:9100/health > /tmp/p12-final-health.json 2>/dev/null || true
if [ -f /tmp/p12-final-health.json ]; then
  python3 - <<'PY'
import json
h = json.load(open("/tmp/p12-final-health.json"))
ai = h.get("ai", {})
sa = h.get("selfAudit", {})
print("  status:", h.get("status"))
print("  uptime:", round(h.get("uptime", 0), 1))
print("  ai.successes:", ai.get("successes"))
print("  ai.failures:", ai.get("failures"))
print("  ai.successRatePct:", ai.get("successRatePct"))
print("  ai.failureReasons:", ai.get("failureReasons"))
print("  selfAudit.aiConsecutiveFailures:", sa.get("aiConsecutiveFailures"))
print("  selfAudit.totalDecisionsRecent:", sa.get("totalDecisionsRecent"))
PY
fi

echo "[p12-rebuild] Image ID used by running container:"
docker inspect "$CTR" --format '{{.Image}}'
docker images --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.CreatedAt}}' | grep invest-bot || true

echo "[p12-rebuild] DONE"
