#!/bin/bash
# deploy.sh — Single unified deployment script for invest bot
# Replaces all previous scp+systemd/pm2 workflows and ad-hoc docker cp patches.
#
# Usage (from local Windows):
#   scp -i ~/.ssh/minitok_deploy scripts/deploy.sh root@49.13.132.147:/tmp/deploy.sh
#   ssh -i ~/.ssh/minitok_deploy root@49.13.132.147 "bash /tmp/deploy.sh"
#
# Or directly on server:
#   bash /opt/minitok/addons/invest/scripts/deploy.sh
#
# Environment variables:
#   DEPLOY_NO_BUILD=1   Skip image build (just recreate from existing image)
#   DEPLOY_NO_CACHE=1   Force --no-cache build (slower, full rebuild)
set -euo pipefail

ADDON_DIR="/opt/minitok/addons/invest"
COMPOSE_FILE="${ADDON_DIR}/docker-compose.production.yml"
SERVICE_NAME="invest-bot"
CONTAINER_NAME="minitok-invest"
HEALTH_URL="http://localhost:9100/health"

echo "[deploy] $(date -u '+%Y-%m-%d %H:%M:%S UTC') — Starting unified deployment"
echo "[deploy] Addon:   $ADDON_DIR"
echo "[deploy] Service: $SERVICE_NAME | Container: $CONTAINER_NAME"

# --- Pre-flight checks ---
echo ""
echo "[deploy] Pre-flight checks..."

# Ensure no rogue processes outside Docker
ROGUE=$(ps aux | grep 'node runner' | grep -v grep | grep -v docker | wc -l)
if [ "$ROGUE" -gt 0 ]; then
  echo "[deploy] WARNING: Found $ROGUE rogue node runner process(es) outside Docker!"
  ps aux | grep 'node runner' | grep -v grep | grep -v docker
  echo "[deploy] Killing them..."
  ps aux | grep 'node runner' | grep -v grep | grep -v docker | awk '{print $2}' | xargs -r kill -9
  sleep 2
fi

# Ensure PM2 is not running (legacy)
if command -v pm2 &>/dev/null; then
  echo "[deploy] WARNING: pm2 found — stopping all pm2 processes"
  pm2 kill 2>/dev/null || true
fi

# Ensure stale systemd units don't exist
if ls /etc/systemd/system/invest*.service /etc/systemd/system/tossinvest*.service 2>/dev/null; then
  echo "[deploy] WARNING: stale systemd units found — removing"
  rm -f /etc/systemd/system/invest*.service /etc/systemd/system/tossinvest*.service
  systemctl daemon-reload
fi

# Ensure compose file exists
if [ ! -f "$COMPOSE_FILE" ]; then
  echo "[deploy] ERROR: Compose file not found: $COMPOSE_FILE"
  exit 1
fi

echo "[deploy] Pre-flight OK"

# --- Build and deploy ---
if [ "${DEPLOY_NO_BUILD:-0}" != "1" ]; then
  echo ""
  if [ "${DEPLOY_NO_CACHE:-0}" = "1" ]; then
    echo "[deploy] Building Docker image (--no-cache)..."
    cd "$ADDON_DIR"
    docker compose -f "$COMPOSE_FILE" build --no-cache "$SERVICE_NAME" 2>&1 | tail -8
  else
    echo "[deploy] Building Docker image (cached)..."
    cd "$ADDON_DIR"
    docker compose -f "$COMPOSE_FILE" build "$SERVICE_NAME" 2>&1 | tail -8
  fi
else
  echo ""
  echo "[deploy] DEPLOY_NO_BUILD=1 — skipping image build"
fi

echo ""
echo "[deploy] Recreating container..."
cd "$ADDON_DIR"
docker compose -f "$COMPOSE_FILE" up -d --no-deps "$SERVICE_NAME" 2>&1

echo ""
echo "[deploy] Waiting for startup (20s)..."
sleep 20

# --- Health check ---
echo ""
echo "[deploy] Health check..."
HEALTH=$(docker exec "$CONTAINER_NAME" curl -sf "$HEALTH_URL" 2>/dev/null || echo "FAILED")

if [ "$HEALTH" = "FAILED" ]; then
  echo "[deploy] ERROR: Health check failed!"
  echo "[deploy] Last 25 lines of container logs:"
  docker logs --tail 25 "$CONTAINER_NAME" 2>&1
  exit 1
fi

# Parse key metrics (includes P12 AI success rate + failure reasons)
echo "$HEALTH" | python3 -c "
import sys, json
h = json.load(sys.stdin)
sa = h.get('selfAudit', {})
ai = h.get('ai', {})
fr = ai.get('failureReasons') or {}
print('[deploy] Health: status=' + h.get('status', 'unknown'))
print('[deploy] SelfAudit: enabled=' + str(sa.get('enabled')))
print('[deploy]   uptime:              ' + str(round(sa.get('uptime', 0), 1)) + 's')
print('[deploy]   prices/10min:        ' + str(sa.get('pricesCollectedLast10Min')))
print('[deploy]   AI interval avg:     ' + str(round((sa.get('aiCallIntervalAvg') or 0) / 1000, 1)) + 's')
print('[deploy]   equity KRW:          ' + str(round(sa.get('equityKrw') or 0, 0)))
print('[deploy]   auth failures (1h):  ' + str(sa.get('authFailuresLastHour')))
print('[deploy]   exec errors (1h):    ' + str(sa.get('executionErrorsLastHour')))
print('[deploy]   AI consec failures:  ' + str(sa.get('aiConsecutiveFailures')))
print('[deploy]   recent decisions:    ' + str(sa.get('totalDecisionsRecent')))
if ai:
  rate = ai.get('successRatePct')
  print('[deploy] AI: successes=' + str(ai.get('successes')) +
        ' failures=' + str(ai.get('failures')) +
        ' rate=' + (str(rate) + '%' if rate is not None else 'n/a'))
  print('[deploy] AI failure reasons: ' +
        'timeout=' + str(fr.get('timeout', 0)) +
        ' network=' + str(fr.get('network', 0)) +
        ' http=' + str(fr.get('http', 0)) +
        ' empty=' + str(fr.get('empty', 0)) +
        ' parse=' + str(fr.get('parse', 0)) +
        ' other=' + str(fr.get('other', 0)))
  if rate is not None and rate < 95:
    print('[deploy] WARNING: AI success rate ' + str(rate) + '% is below 95% target')
"

# --- Verify single process ---
echo ""
echo "[deploy] Process verification:"
RUNNER_COUNT=$(ps aux | grep 'node runner' | grep -v grep | wc -l)
echo "[deploy]   node runner processes: $RUNNER_COUNT (expected: 1 inside Docker)"

# --- Host↔Container checksum verification ---
echo ""
echo "[deploy] File integrity (host vs container):"
for f in runner.js src/ai/provider-router.js; do
  HOST_MD=$(md5sum "${ADDON_DIR}/$f" 2>/dev/null | awk '{print $1}' || echo "missing")
  CTR_MD=$(docker exec "$CONTAINER_NAME" md5sum "/app/$f" 2>/dev/null | awk '{print $1}' || echo "missing")
  if [ "$HOST_MD" = "$CTR_MD" ]; then
    echo "[deploy]   ✓ $f ($HOST_MD)"
  else
    echo "[deploy]   ✗ $f HOST=$HOST_MD CTR=$CTR_MD  ← DRIFT!"
  fi
done

echo ""
echo "[deploy] Deployment complete."
docker ps --filter name=$CONTAINER_NAME --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}' | sed 's/^/[deploy]   /'
