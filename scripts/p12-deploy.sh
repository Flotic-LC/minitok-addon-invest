#!/bin/bash
# P12 — Deploy runner.js with AI metrics in /health
set -euo pipefail

cd /opt/minitok/addons/invest

echo "[p12] $(date -u '+%Y-%m-%d %H:%M:%S UTC') — Starting P12 deploy"
echo "[p12] runner.js size: $(wc -c < runner.js) bytes"

echo "[p12] Building invest-bot image..."
docker compose -f docker-compose.production.yml build invest-bot 2>&1 | tail -5

echo "[p12] Recreating container..."
docker compose -f docker-compose.production.yml up -d --no-deps invest-bot 2>&1

echo "[p12] Waiting 20s for startup..."
sleep 20

echo "[p12] Health check..."
docker exec minitok-invest curl -s http://localhost:9100/health > /tmp/p12-health.json 2>/dev/null || {
  echo "[p12] curl failed, trying node..."
  docker exec minitok-invest node -e 'fetch("http://localhost:9100/health").then(r=>r.text()).then(t=>require("fs").writeFileSync("/tmp/p12-health.json",t))' 2>/dev/null || true
}

if [ -f /tmp/p12-health.json ]; then
  echo "[p12] Health JSON saved. Parsing AI metrics..."
  python3 -c "
import json,sys
with open('/tmp/p12-health.json') as f:
  h = json.load(f)
ai = h.get('ai', {})
sa = h.get('selfAudit', {})
print('  status:', h.get('status'))
print('  ai.successes:', ai.get('successes'))
print('  ai.failures:', ai.get('failures'))
print('  ai.total:', ai.get('total'))
print('  ai.successRatePct:', ai.get('successRatePct'))
print('  ai.consecutiveFailures:', ai.get('consecutiveFailures'))
print('  ai.parseErrorPct:', ai.get('parseErrorPct'))
print('  ai.lastUsedProvider:', ai.get('lastUsedProvider'))
providers = ai.get('providers', {})
if providers and 'providers' in providers:
  for p in providers['providers']:
    print('  provider:', p.get('name'), 'rate:', str(p.get('successRatePct'))+'%', 'ok:', p.get('successes'), 'fail:', p.get('failures'))
print('  selfAudit.aiConsecutiveFailures:', sa.get('aiConsecutiveFailures'))
print('  selfAudit.totalDecisionsRecent:', sa.get('totalDecisionsRecent'))
"
else
  echo "[p12] WARNING: Could not retrieve health JSON"
fi

echo ""
echo "[p12] Container status:"
docker ps --filter name=minitok-invest --format 'table {{.Names}}\t{{.Status}}'

echo ""
echo "[p12] Deploy complete."