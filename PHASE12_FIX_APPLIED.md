# PHASE 1·2 수정사항 적용 결과 (2026-10-14)

**적용 환경:** `minitok-invest`, `minitok-sentinel` 컨테이너 (root@49.13.132.147)
**검증:** 배포 후 라이브 로그 실측

---

## 배포 완료 — 코드 수정

### 1. backtest-feedback trust gate (Prompt #6 → 항목 1) ✅ 작동 확인
- **문제:** `trades=0`(입력 캔들의 open/close=0)인 망가진 백테스트가 `DD<1%`, `winRate<40` 조건을 만족해 SL -2→-3, TP 5→8 로 **리스크를 근거 없이 확대**
- **수정:** `trades < BT_MIN_TRADES(20)` 또는 전 지표 0이면 피드백 루프 거부 → 기본값 유지
- **라이브 증거:**
  ```
  [backtest-feedback] REJECTED: trades=0 < min 20 ... Keeping default STOP_LOSS_PCT/TAKE_PROFIT_PCT.
  ```
- 파일: `/app/runner.js` (`loadBacktestFeedback`), 백업 `/app/runner.js.bak-p10`

### 2. SELL 손익 억제 (Prompt #4 → 항목 2) ✅ 배포
- **문제:** entry price 없을 때 주문가로 폴백해 `grossPnl=0, pnlPct=-0.5028` 같은 **가짜 손실** 생성 → kill-switch·AI 이력 오염
- **수정:** entry 미확정 시 `sellPnl=null`, `PNL_SUPPRESSED` 이벤트 기록, FILL은 `pnlUnknown:true`로 보존. recordSymbolOutcome/knowledgeStore/perfMonitor/degradationDetector/metaCognition 모두 null 가드
- 파일: `/app/runner.js`

### 3. kill-switch 데이터 부재 구분 (Prompt #4 → 항목 3) ✅ 배포
- **문제:** `recentFills`가 비면 consecutiveLosses=0 → 손실 난무 중에도 "안전"으로 오판
- **수정:** known SELL fill이 0이면 `_ksMetrics.consecutiveLossesKnown=false` + 경고 로그. daily-loss/exposure 체크는 유지
- 파일: `/app/runner.js`

### 4. STATE_DIR 영속화 (Prompt #4 → 항목 8) ✅ 작동 확인
- **문제:** STATE_DIR 미설정 → state가 컨테이너 쓰기 레이어(`/app/.runner-state.json`)에 기록, 재생성 시 소실
- **수정:** compose에 `STATE_DIR=/app/state` 추가 (볼륨 `minitok_invest-state`는 이미 마운트돼 있었음)
- **라이브 증거:** `/app/state/` 에 `.target-state.json`, `pending_offhours_sells.json` 기록 중
- 파일: `docker-compose.production.yml` (invest-bot environment)

### 5. Evolution 캔들 경로 (Prompt #6 → 항목 4·5) ✅ 작동 확인
- **문제:** `EVOLUTION_ENABLED=true`인데 `EVOLUTION_CANDLES_PATH` 미설정 → 매 사이클 `[evolution] skipped`
- **수정:** `EVOLUTION_CANDLES_PATH=/app/candles.json`, `WALK_FORWARD_ENABLED=true`, `BT_MIN_TRADES=20` 추가. candles.json은 유효 데이터로 재생성됨(open/close 정상)
- **라이브 증거:** `[phase-d] Evolution cycle scheduled (interval=168h, first run in 5min)`

### 6. Telegram 409 자동중단 (Prompt #5 → 항목 6·7) ✅ 배포
- **문제:** 409 충돌 시 3초 간격 재시도만 반복 → 지난번 1,092건 후 13시간 조용히 폴링 포기
- **수정:** `conflictStreak` circuit breaker — 연속 409 시 폴링 중단 + Telegram 에스컬레이션. startup에서 토큰 충돌 사전 경고
- 파일: `/app/sentinel.js` (백업 `.bak-p10`)
- **라이브 증거:** `Polling started`, 재시작 후 **409 0건**

---

## 미적용 — 코드 외 / 판단 보류

### 7. 봇 토큰 범위 축소 (항목 8) — 구조상 미적용
- 같은 토큰(`8666626553`)이 invest/sentinel/sidecar 3곳에 `.env`로 주입됨
- invest·sidecar는 전송만 하고 `getUpdates` 미사용 → 현재 폴러는 sentinel 하나뿐이라 **충돌 소지 없음**
- sidecar는 Python 코드에 Telegram 사용이 없어 토큰 미사용 확인. 단, compose 재생성 없이 env 제거 불가하고 다른 서비스에 영향 우려 → **현 상태 유지, 추후 별도 봇 분리 권장**

### 8. JPY 환율 (Prompt #2) — 버그 아님, 코드 변경 없음
- JPY=9는 폴백 하드코딩값. API가 `allowedValues:["KRW","USD"]`만 허용해 JPY 원천 거부
- 계좌에 JPY 자산 없어(QQQ/SPY만 USD) **실영향 0**
- 단 `|| 1` 폴백은 미지 통화를 원화로 오인하는 잠재 버그로 문서에만 기록 (`JPY_FX_PARSING_ANALYSIS.md`)

---

## 배포 이력
| 시각(UTC) | 작업 |
|---|---|
| 15:41 | sentinel 수정본 배포 + 재시작 → Polling 정상, 409 0건 |
| 15:46 | `docker compose up -d invest-bot` 재생성 → STATE_DIR/EVOLUTION/BT_MIN env 적용 |
| 15:4x | runner.js 수정본 재적용(재생성으로 이미지 구버전 복귀했던 것) + 재시작 → trust gate 발동 확인 |

**주의:** runner.js·sentinel.js는 이미지에 baked-in이 아니라 `docker cp`로 주입됐으므로, `docker compose up -d`(재생성/재빌드) 시 **구버전으로 되돌아갑니다.** 영구화하려면 Dockerfile 소스 트리에 반영 필요.

## 현재 상태
모든 컨테이너 Up 정상. invest-bot 트레이딩 루프 정상(WS frames, rest-poll, AI decisions). Telegram 알림 경로 정상.

---

## 소스 트리 영구화 (완료)

Dockerfile이 `COPY . .` 로 context 전체를 이미지에 복사하므로, 소스 트리(`/opt/minitok/addons/invest/`)에 반영하면 재빌드 시 유지됩니다. 다음 3개 파일을 소스 트리에 배포 완료:

| 파일 | 상태 | 백업 |
|---|---|---|
| `runner.js` | trust gate 등 전체 수정본 반영 | `.bak.src-p10` |
| `sentinel.js` | conflictStreak circuit breaker 반영 | `.bak.src-p10` |
| `src/ai/provider-router.js` | trailing-slash URL 정규화 반영 | `.bak.src-p10` |

구문 검증 통과 (`node --check` × 3).

### 잔여 사항
- **실행 중 이미지는 6일 전 빌드** — 위 소스 변경은 다음 `docker compose build` 또는 `up -d --build` 시 이미지에 반영됩니다.
- **현재 라이브 컨테이너에는 `docker cp`로 주입된 동일 내용이 동작 중** (재생성 시 소멸하는 ephemeral 레이어). 라이브와 소스 트리 내용은 동일하므로, 재빌드 시 동작 차이 없음.
- 영구 활성화 명령: `docker compose -f docker-compose.production.yml up -d --build invest-bot`

---

## Prompt #1 — REGIME_MISMATCH / pause_strategy 진단 + 수정

### 진단 결과
- **트레이딩 상태: ACTIVE** — pause 발동 이력 없음 (`REGIME_MISMATCH total=0`)
- regime은 ATR 기반(`detectRegime`, 974행), anchor symbol(SPY/QQQ/005930/KS200)만 사용해 flip 방지 → flip 0건
- pause 해제 조건: 30분 쿨다운 자동 해제 (수동 경로 없음)

### 🔴 발견한 근본 버그: pause_strategy가 실제 주문을 차단하지 않았음
`self-healing.js`의 `computeMitigation`은 `REGIME_MISMATCH`/`DATA_DRIFT`에 `pause_strategy`를 반환하지만, `runner.js`에서 `isMitigated()`를 체크하는 곳은 `LIQUIDITY_SHOCK`(BUY만) 한 곳뿐이었다. 즉 **pause_strategy는 로그·저널에만 기록되고 주문 경로와 미연결**이었다 — 보호 장치가 무력한 상태.

### 수정 (`runner.js` exec 경로, LIQUIDITY_SHOCK 가드 직후)
`REGIME_MISMATCH`·`DATA_DRIFT` 완화가 활성일 때 주문을 차단:
- **BUY**: 항상 차단
- **SELL**: 기본 차단, `SELFHEAL_ALLOW_SELL_DURING_PAUSE=1` 설정 시 허용 (리스크 오프용 exit)
- 차단 시 `journalEntry({type:"ORDER_BLOCKED", reason:"PAUSE_STRATEGY", incident})` 기록

### 검증 (라이브 컨테이너, `/tmp/probe_pause.js`)
```
REGIME_MISMATCH 강제 발동 → activeMitigations에 pause_strategy 등록
BUY  SPY → BLOCKED (REGIME_MISMATCH)
SELL SPY → BLOCKED (REGIME_MISMATCH)              [기본]
SELL SPY → ALLOWED                               [SELFHEAL_ALLOW_SELL_DURING_PAUSE=1]
30분 경과 후 → activeMitigations 비워짐, BUY/SELL 모두 ALLOWED (자동 해제)
```

### 배포
- 소스 트리: `/opt/minitok/addons/invest/runner.js` (백업 `.bak.src-p1pause`)
- 라이브 컨테이너: `docker cp` 주입 + 재시작, `[phase-j] Self-healing framework initialized` 확인
- `node --check` 통과 (소스·라이브 양쪽)
