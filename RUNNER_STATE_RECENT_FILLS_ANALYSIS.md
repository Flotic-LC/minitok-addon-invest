# `[state] Restored 0 recent fills` 원인 분석

**작성일:** 2026-10-14
**증상:** `[state] Restored 0 recent fills` / peak prices=0, ATR hard stops=0, entry prices=0
**조사 방법:** state 파일·journal 볼륨·컨테이너 마운트 실측

---

## 판정: **데이터 소실 (복구 불필요)**

`fills=0`은 "오늘 체결 없음"이 **아니다**. 체결은 **12건** 있었고 정상 기록되어 있다.
문제는 runner의 인메모리 상태가 **영속 볼륨에 단 한 번도 쓰이지 않았다**는 것이다.

체결 기록 자체는 살아있으므로 **복구할 데이터가 없다** (이미 journal에 온전함).
다만 근본 원인을 고치지 않으면 매 재시작마다 반복된다.

---

## 1. State 파일 위치 — 볼륨이 아니라 컨테이너 레이어

| 경로 | 존재 | 비고 |
|---|---|---|
| `/app/.runner-state.json` | **예** (4441 B) | 컨테이너 쓰기 레이어 — **재생성 시 소멸** |
| `/app/state/.runner-state.json` | **없음** | 영속 볼륨 (`minitok_invest-state`) — 의도한 위치 |

마운트 확인:
```
"Name":"minitok_invest-state"  "Destination":"/app/state"   ← 영속 볼륨
```

코드 의도 (`runner.js:5847`):
```js
const RUNNER_STATE_PATH = path.join(
  process.env.STATE_DIR || path.join(__dirname, "state"),   // ← __dirname/state
  ".runner-state.json"
);
```

**근본 원인:** `STATE_DIR` 환경변수가 **설정되어 있지 않다** (`/proc/1/environ`에 없음).
따라서 경로는 `__dirname/state` = **`/app/state`** 가 되어야 하는데, 실제 파일은
**`/app/.runner-state.json`** 에 있다. 즉 `__dirname`이 `/app`으로 해석된 형태로,
`/app/state`가 아닌 `/app` 직하에 쓰이고 있다.

결과적으로 **볼륨(`/app/state`)과 무관한 컨테이너 레이어에 기록**되어,
컨테이너 재생성마다 전부 사라진다.

## 2. recentFills가 기록되는 경로

기록(쓰기)은 **정상 구현**되어 있다:

| 행 | 내용 |
|---|---|
| 946 | `const recentFills = [];` |
| 959 | 체결 시 `recentFills.push({symbol, side, price, quantity, pnl, at})` |
| 5860 | `dumpRunnerState()` 안에 `recentFills: recentFills.slice()` |
| 5910-5912 | 원자적 쓰기 (tmp → rename) |
| 6038/6047 | SIGTERM / SIGINT 에서 dump |

복원(`restoreRunnerState`, 5919행)도 정상:
```js
if (raw.recentFills && Array.isArray(raw.recentFills)) {
  recentFills.length = 0;
  for (var rf of raw.recentFills) recentFills.push(rf);
  console.log("[state] Restored " + raw.recentFills.length + " recent fills");
}
```

**문제는 읽기/쓰기 로직이 아니다.** 5921행:
```js
if (!fs.existsSync(RUNNER_STATE_PATH)) return;   // ← 파일이 없으면 그냥 종료
```
파일이 없으므로 전 항목이 0으로 초기화된 채 로그만 찍힌다.

**게다가 복원 후 파일을 지운다** (6028행):
```js
try { fs.unlinkSync(RUNNER_STATE_PATH); } catch {}
```
주석은 "stale data 방지"지만, 이 탓에 디버깅 증거마저 사라진다.
현재 `/app/.runner-state.json`은 삭제되지 않고 살아있는데, 이는
**정상 restore가 끝난 적이 없고(SIGKILL/OOM 등) 그 시점의 파일이 남은 것**이다.

## 3. 실제 체결 여부 — **12건 있었다**

journal (영속 볼륨 `/app/state/events/`)은 온전하다:

| 파일 | 기간 | FILL | TRADE_EXECUTED (ok) |
|---|---|---|---|
| events-2026-10-13.jsonl | 10-13 12:37 ~ 14:40 UTC | 0 | 0 |
| **events-2026-10-14.jsonl** | **10-13 15:26 ~ 10-14 01:40 UTC** | **12** | **140 (성공 38 / 실패 102)** |

파일명은 `10-14`지만 실제 내용은 **10월 13일 저녁~14일 새벽 (한국 시간으로 10/14 낮)**이다.
**오늘 체결이 있었고 기록도 되어 있다.**

실제 FILL 12건:
```
QQQ   BUY   742.13  ×3
BRK.B SELL  522.47  ×5    netPnl=-17674.79  pnlPct=-0.5028  ← prompt의 BRK.B
EWJ   BUY   97.18   ×2
TSLA  BUY   373.71  ×3
CEPU  BUY   13.21   ×5
SPY   SELL  777.66  ×17   netPnl=-89398.97  pnlPct=-0.5028
JPEF  BUY   82.88   ×8
SPY   BUY   778.40  ×16
ASBH  BUY   18.21   ×4
TSLA  SELL  375.79  ×3    netPnl=+790.06    pnlPct=+0.0524
CEPU  BUY   13.16   ×82
AXIN  BUY   10.38   ×5
```

**주의 — 별개 버그:** SELL 3건(BRK.B, SPY 등)의 `grossPnl=0`, `pnlPct=-0.5028`,
`costsPct=0.5028` 패턴이 동일하다. 이건 직전 문서에서 지적한
"entryPrices 소실 → `info.price` 폴백 → 가짜 손실"과 **정확히 같은 징후**다.
즉 entryPrices=0이 이미 **손익 계산을 오염**시키고 있다.

`pending_offhours_sells.json`은 현재 `[]` (9개 → 0으로 비워짐, 별도 이슈).

## 4. fills=0 판별 — 소실

| 가설 | 판정 | 근거 |
|---|---|---|
| 오늘 체결 없음 | **기각** | journal에 FILL 12건, TRADE_EXECUTED 140건 |
| 파서 버그 | **기각** | 복원 로직 정상, 파일만 없음 |
| **데이터 소실** | **확정** | state가 영속 볼륨에 기록된 적 없음 |

타임라인:
```
/app/.runner-state.json mtime = 2026-10-12T08:13:45Z   ← 54.7시간 전에 멈춤
journal 최신              = 2026-10-14T01:40:47Z
```
state는 **2일 전** 쓰기 이후 전혀 갱신되지 않았다.

## 5. peak/ATR/entry prices=0 — 같은 원인

**예, 동일 원인이다.** 네 항목 모두 `dumpRunnerState()`의 같은 객체에 있고,
같은 파일에 함께 직렬화된다:

```js
var state = {
  pendingOrders:     Array.from(pendingOrders.entries()),
  entryPrices:       Array.from(entryPrices.entries()),      // 0
  symbolPerformance: Array.from(symbolPerformance.entries()),
  peakPrices:        Array.from(peakPrices.entries()),       // 0
  atrStopPrices:     Array.from(atrStopPrices.entries()),    // 0
  recentFills:       recentFills.slice(),                    // 0
  ...
```

실제 파일 내용도 전부 0이다:
```
pendingOrders=0  entryPrices=0  symbolPerformance=0
peakPrices=0     atrStopPrices=0  recentFills=0
aiMetrics={"successes":142,"failures":2}
```

`aiMetrics`는 값이 있는데 배열 6개만 0이다. 즉 **의도적으로 비운 게 아니라
그 시점(10-12)에 인메모리에 아무것도 없었고, 그 이후 dump가 한 번도 돌지 않았다.**

**주의:** `aiMetrics`(142성공)는 다른 메커니즘으로 저장되는 듯 구분된다.
핵심은 **배열 6개가 전부 같은 파일·같은 함수·같은 경로**를 공유한다는 점이다.

---

## 영향 범위

| 영향 | 심각도 | 설명 |
|---|---|---|
| SELL 손익 오염 | **높음** | entryPrices=0 → `info.price` 폴백 → 가짜 손실. BRK.B/SPY의 `pnlPct=-0.5028`이 증거 |
| trailing stop / ATR hard stop 소실 | 중 | peakPrices=0 → 트레일링 기준 소실, atrStopPrices=0 → 하드스톱 미등록 |
| kill-switch 손실률 왜곡 | 중 | `_ksRecentLosses`는 recentFills를 읽으므로 0 → 위험 완화로 **오판** |
| AI 맥락 상실 | 낮 | recentFills=0 → "your last 5 executions" 비어 전략 학습 저하 |

특히 kill-switch(3741행)는 `recentFills`로 최근 손실을 세는데, 0이면
**손실 난무 중에도 안전하다고 판단**할 수 있다. 방향이 위험한 쪽이다.

---

## 결론 및 권장

**복구 필요 여부: 불필요.** 체결 원장은 journal 볼륨에 온전하다. 잃어버린 것은
파생 인메모리 상태뿐이고, 이들은 재시작 후 자연 재구축된다.

**고쳐야 할 것 (우선순위순):**

1. **`STATE_DIR` 미설정** — 영속 볼륨 `/app/state`를 가리키도록 설정.
   이게 근본 원인이며, 안 고치면 매번 반복된다.
2. **복원 후 `unlinkSync` 제거** (6028행) — 증거를 지워 재진단을 불가하게 만든다.
3. **주기적 dump 부재** — SIGTERM/SIGINT에서만 저장. 크래시(SIGKILL/OOM) 시 전부 소실.
   N분 간격 자동 dump가 필요.
4. **`entryPrices` 부재 시 손익 억제** — entry price를 모르면 `info.price`로
   가짜 손익을 만들지 말고 `pnl: null` 처리해야 한다. 현재 SELL의 -0.5028은 허위 손실이다.
5. **`pending_offhours_sells.json`이 9→0** — 별도 추적 필요 (본 범위 밖).

**주의:** 이 문서는 분석만 담는다. 코드 수정은 요청 시 별도 진행.