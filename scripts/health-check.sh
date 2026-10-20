#!/bin/bash
echo "=== Final selfAudit 14-metric verification ==="
docker exec minitok-tossinvest wget -qO- http://localhost:9100/health 2>/dev/null | python3 -c "
import sys, json
h = json.load(sys.stdin)
sa = h.get('selfAudit', {})
fields = ['enabled','uptime','pricesCollectedLast10Min','aiCallIntervalAvg',
          'equityKrw','authFailuresLastHour','wsReconnectsLastHour',
          'fallbackDecisionsLastHour','slippageSampleCount','avgSlippagePct',
          'aiConsecutiveFailures','executionErrorsLastHour',
          'holdDecisionRatio','totalDecisionsRecent']
missing = [f for f in fields if f not in sa]
for f in fields:
    v = sa.get(f, 'MISSING')
    if isinstance(v, float):
        v = round(v, 3)
    print(f'  {f}: {v}')
print()
if missing:
    print(f'FAIL: missing fields: {missing}')
else:
    print(f'OK: all {len(fields)} selfAudit metrics present')
print(f'selfAudit keys total: {len(sa)}')
"