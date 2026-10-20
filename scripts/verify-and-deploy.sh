#!/bin/bash
# verify-and-deploy.sh ??Verify single-process deployment and self-audit health
# Usage: scp this to server, then bash verify-and-deploy.sh
set -e

echo "=== [1/5] Network topology verification ==="
echo "Kuma networks:"
docker inspect minitok-kuma --format '{{json .NetworkSettings.Networks}}' | python3 -c "import sys,json; print(list(json.load(sys.stdin).keys()))"
echo "Tossinvest networks:"
docker inspect minitok-tossinvest --format '{{json .NetworkSettings.Networks}}' | python3 -c "import sys,json; print(list(json.load(sys.stdin).keys()))"
echo "Caddy networks:"
docker inspect minitok-caddy --format '{{json .NetworkSettings.Networks}}' | python3 -c "import sys,json; print(list(json.load(sys.stdin).keys()))"

echo ""
echo "=== [2/5] Kuma reachability test ==="
RESULT=$(docker exec minitok-kuma sh -c 'wget -qO- --timeout=5 http://minitok-tossinvest:9100/health 2>/dev/null | head -c 200' 2>/dev/null || echo "CANNOT_REACH")
echo "$RESULT"

echo ""
echo "=== [3/5] Process singularity check ==="
echo "Node runner processes:"
ps aux | grep 'node runner' | grep -v grep || echo "  (none found)"
echo "PM2:"
which pm2 2>/dev/null && echo "  WARNING: pm2 still installed" || echo "  OK: pm2 not found"
echo "systemd units:"
ls /etc/systemd/system/tossinvest* 2>/dev/null && echo "  WARNING: systemd units exist" || echo "  OK: no systemd units"

echo ""
echo "=== [4/5] Self-audit health (from inside container) ==="
docker exec minitok-tossinvest wget -qO- http://localhost:9100/health 2>/dev/null | python3 -c "
import sys, json
h = json.load(sys.stdin)
sa = h.get('selfAudit', {})
print('  enabled:', sa.get('enabled'))
print('  uptime:', round(sa.get('uptime', 0), 1), 's')
print('  pricesCollectedLast10Min:', sa.get('pricesCollectedLast10Min'))
print('  aiCallIntervalAvg:', round(sa.get('aiCallIntervalAvg', 0) / 1000, 1), 's')
print('  equityKrw:', sa.get('equityKrw'))
print('  authFailuresLastHour:', sa.get('authFailuresLastHour'))
print('  fallbackDecisionsLastHour:', sa.get('fallbackDecisionsLastHour'))
print('  avgSlippagePct:', sa.get('avgSlippagePct'))
print('  aiConsecutiveFailures:', sa.get('aiConsecutiveFailures'))
print('  executionErrorsLastHour:', sa.get('executionErrorsLastHour'))
print('  holdDecisionRatio:', sa.get('holdDecisionRatio'))
print('  totalDecisionsRecent:', sa.get('totalDecisionsRecent'))
"

echo ""
echo "=== [5/5] Container status ==="
docker ps --filter name=tossinvest --format 'table {{.ID}}\t{{.Names}}\t{{.Status}}\t{{.CreatedAt}}'
echo ""
echo "=== ALL CHECKS COMPLETE ==="
