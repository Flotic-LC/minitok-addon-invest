# `[backtest-feedback] Loaded: Sharpe=0, Return=0%, DD=0%` 원인 분석

**작성일:** 2026-10-14
**조사 방법:** 파일 실측 + 코드 경로 추적 (`/app/runner.js`, `/app/backtest.js`, `/app/candles.json`)

---

## 판정: **입력 캔들 데이터가 망가짐 (open/close 전부 0)**

포맷 오류도, 파일 부재도 아니다. JSON은 정상 파싱되고 `sharpe`는 `number` 타입이라
**guard를 통과한다**. 문제는 **백테스트 입력 캔들의 가격이 전부 0**이라
전략이 거래를 하나도 생성하지 못한 것이다. 즉 **0은 연산 결과가 아니라 연산 실패의 산출물**이다.

---

## 1. 데이터 소스 경로

| 항목 | 값 |
|---|---|
| 소비 파일 | `/app/backtest-result.json` (5536 B) |
| 코드 | `runner.js:1806` `path.join(__dirname, "backtest-result.json")` |
| mtime | 2026-10-13T21:00:03Z |
| 입력 파일 | `/app/candles.json` (30667 B, 180 캔들) — **동일 시각** |
| 결과 기록 경로 | `backtest.js:352` — 캔들 파일과 **같은 디렉토리**에 기록 |

## 2. 파일 상태 — 비어있지도, 없지도, 깨지지도 않음

```
JSON parse: OK
sharpe           = 0   typeof=number  ✓ numeric
totalReturnPct   = 0   typeof=number  ✓
maxDrawdownPct   = 0   typeof=number  ✓
winRatePct       = 0   typeof=number  ✓
```

guard(`typeof bt.sharpe !== "number"`)를 **통과**한다. 그래서 로그에
`Loaded: Sharpe=0...`가 찍히는 것이지, `Failed to load`이 아니다.

**실제로 0인 것들이 더 많다:**
```
initialEquity=10000000  finalEquity=10000000  → 변동 0
trades=0  buys=0  sells=0  wins=0  losses=0  winRatePct=0
tradeLog=[]   equityCurve=60pt 전부 10000000 (완전 평평)
```

`/app/tests/backtest-result.json`(10-09)도 동일하게 0이다. 즉 이 문제는 **오래된 고질적 상태**다.

## 3. 백테스트 생성 주체

**별도 워커/phase-h가 아니다.** 순수 CLI:

- `backtest.js` — 캔들 JSON을 읽아 결과를 `backtest-result.json`에 기록 (`backtest.js:352`)
- `runner.js`는 이 결과를 **읽기만** 한다 (`loadBacktestFeedback()`)

`phase-h`(walk-forward)는 **백테스트를 생성하지 않는다**. 별개 기능이며 아래 4절 참조.
따라서 `backtest-result.json`은 **수동/CI 실행 결과가 그대로 방치된 파일**이다.

## 4. 근본 원인 — 캔들의 open/close가 전부 0

`/app/candles.json` 실측:

```json
{"symbol":"005930","date":"2026-07-14T00:00:00.000+09:00",
 "open":0,"high":270000,"low":240000,"close":0,"volume":75341354}
```

**`open`과 `close`가 0**인 반면 `high`/`low`는 정상 값이다.

이것이 0거래로 직결된다 (`backtest.js:170-172`):

```js
const closes = series.slice(0, idx + 1).map((c) => Number(c.close));
const price = closes[closes.length - 1];
if (!price || closes.length < 3) continue;    // ← price=0 → 무조건 continue
```

`!price`가 참이므로 **전략 판단 자체가 실행되지 않는다**. 결과적으로:

- `trades=0` → `sharpe` 계산 불가 → 0
- 포지션 0 → `finalEquity == initialEquity` → `totalReturnPct=0`, `maxDrawdownPct=0`

**누가 0을 썼는가는 미확인.** 확인한 것:

| 후보 | 결론 |
|---|---|
| `tests/gen-candles.js` | **아니다.** `open=price`, `close=price+drift`로 모두 채움 |
| `validate-parity.js`의 `syntheticCandles()` | **아니다.** `close` 계산함, 심볼도 `SYNTH` |
| `runner.js` / `EVOLUTION_CANDLES_PATH` | **아니다.** env 미설정이라 미실행 |

`candles.json`을 쓰는 코드는 위 3개뿐이고 전부 정상 값을 만든다.
즉 **현재 코드로는 재현 불가**한 데이터다. 추정: 과거에 외부 API 연동이나
임시 스크립트로 만들어졌고, 가격 필드 매핑이 빠진 채 저장된 듯하다.

## 5. phase-h skip 및 candlesPath 판별

```
EVOLUTION_ENABLED      = true     ← 설정됨
EVOLUTION_CANDLES_PATH = (미설정)
WALK_FORWARD_ENABLED   = (미설정)
```

로그 문구(`runner.js:5112`)와 정확히 일치한다:
```
[phase-h] Walk-forward periodic validation skipped (validator=false, candlesPath=false)
```

- **validator=false** ← `WALK_FORWARD_ENABLED` 미설정 (1093행 분기)
- **candlesPath=false** ← `EVOLUTION_CANDLES_PATH` 미설정

**판정: 의도적 비활성화가 아니라 설정 누락.**

근거 — 두 변수가 서로 모순된다:
- `EVOLUTION_ENABLED=true`로 진화 사이클은 **켜놨다**
- 그런데 진화에 필수인 캔들 경로는 **비워뒀다**

그래서 `runner.js:4845`에서 매 사이클마다 이렇게 죽는다:
```js
if (!EVOLUTION_CANDLES_PATH) {
  console.warn("[evolution] skipped — EVOLUTION_CANDLES_PATH not set");
```
→ **진화는 항상 skip**되고, walk-forward 검증도 돌지 않는다.
즉 켜놓은 기능이 몽땅 무력화된 **반쯤 켜진 상태**다.

`EVOLUTION_CANDLES_PATH`만 채우면 두 기능이 동시에 살아난다
(5076행이 동일 변수를 공유). 그러므로 누락이지 의도가 아니다.

## 6. 거래에 미치는 영향

### SL/TP는 조정되지 않고 기본값 유지

```
STOP_LOSS_PCT   = -2   (runner.js:2990)
TAKE_PROFIT_PCT = 5    (runner.js:2991)
```

`loadBacktestFeedback()`는 **null을 반환하지 않고** 0값 객체를 반환하므로
조정 분기에 진입한다. 그런데 조정 조건이 **전부 false**다:

| 조건 | 실제값 | 발동 |
|---|---|---|
| `maxDrawdownPct > 3` → SL -1.5 | `0 > 3` | ✗ |
| `maxDrawdownPct < 1` → SL -3 | `0 < 1` | **✓ 발동** |
| `winRatePct < 40 && sharpe < 0.5` → TP 8 | `0 < 40 && 0 < 0.5` | **✓ 발동** |

**이것이 가장 위험한 부분이다.** 엉망인 백테스트가 **의도적으로 정상처럼 보이는** 조정을 만들어낸다:
- "드로다운 < 1% → 손절을 -3%로 완화" (여유를 달라)
- "승률 저조 → 익절을 8%로 확대" (수익을 더 달려라)

둘 다 **리스크를 키우는 방향**이다. 실제로는 데이터가 0이라 **근거가 전혀 없다**.
즉 의미 없는 수치가 리스크 상향으로 번역되어 라이브에 적용된다.

### 실제 거래 영향 (현재 세대)

현재 컨테이너(`Up 4 hours`)는 이 분기를 **아직 통과하지 않았다**:
- 조정 로그(`Adjusting STOP_LOSS_PCT`)가 stdout에 없음
- heartbeat는 `equity=₩21,650,614.95`로 정지 상태
- 무거래 781분 경고 지속 중

따라서 **영향은 잠재적**이다. 단 `runner.js:3584`의 `liveParamsOverride =
loadBacktestFeedback()`는 **프로세스 기동 시 1회** 실행되므로, **다음 재시작부터
SL -3 / TP 8이 실제로 적용**된다.

### 리스크 요약

| 영향 | 심각도 |
|---|---|
| 손절 -2% → **-3%** (손실 허용 폭 50% 확대) | **높음** |
| 익절 5% → **8%** (수익 실현 지연, 되돌림 노출) | 중 |
| 진화(walk-forward) 완전 무력화 | 중 |
| 0값이 "정상"으로 위장해 원인 은폐 | **높음** (진입 장벽) |

---

## 결론

| 질문 | 답 |
|---|---|
| 왜 0인가 | **입력 캔들의 `open`/`close`가 전부 0** → 전략이 거래 생성 불가 |
| 포맷 오류? | **아니다.** JSON 정상, `sharpe`도 number → guard 통과 |
| 누가 생성? | `backtest.js` CLI (수동 실행). phase-h 아님 |
| phase-h skip 이유 | `WALK_FORWARD_ENABLED`·`EVOLUTION_CANDLES_PATH` **둘 다 미설정** |
| candlesPath 누락 or 의도? | **누락.** `EVOLUTION_ENABLED=true`와 모순 |
| 거래 영향 | 잠재적. **다음 재시작 시 SL -3 / TP 8 적용** (둘 다 리스크 확대) |

## 권장 수선 (우선순위순)

1. **0값 백테스트를 거부한다** — `trades === 0`이면 피드백 루프를 중단.
   지금 구조는 "계산 실패"와 "전략이 보수적"을 구분 못 해서, 망가진 데이터가
   라이브 리스크 파라미터를 바꾼다. 이게 핵심이다.
2. **조정은 신뢰 임계값을 넘길 때만** — 예: `trades >= 20 && sharpe !== 0`.
3. **캔들 입력 검증** — `close`/`open`이 0이면 로드 단계에서 거부.
   `backtest.js:172`의 `if (!price) continue`가 실패를 삼키고 있다.
4. **`EVOLUTION_CANDLES_PATH` 설정** — 켜놓고 못 쓰는 상태를 해소.
5. **`WALK_FORWARD_ENABLED` 결정** — 진화를 실제로 쓸 거면 `true`, 아니면
   `EVOLUTION_ENABLED도 false로 맞춰 일관성 확보.
6. **`/app/candles.json` 교체** — `tests/gen-candles.js` 또는 실제 일봉 데이터로.
   현 파일은 어떤 코드로도 재현 불가하다.

**주의:** 이 문서는 분석만 담는다. 코드 수정은 요청 시 별도 진행.