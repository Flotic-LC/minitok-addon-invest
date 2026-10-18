# minitok-addon-tossinvest

**토스증권(Toss Securities) Open API 어댑터 — minitok용 독립 애드온(add-on)**

이 패키지는 minitok과 **완전히 별개**입니다.

- minitok 패키지(`@flotic/minitok`)에 속하지 않으며, minitok 저장소에도 이 코드가 존재하지 않습니다.
- minitok은 이 애드온을 알지 못합니다. 통합은 오직 minitok의 공개 확장점 `registerAdapter()`를 **외부에서 호출**하는 방식으로만 일어납니다.
- minitok은 optional peer로만 참조합니다.
- 런타임 의존성: `ws` 1개 (웹소켓 handshake에 Authorization 헤더가 필요해 Node 내장 WebSocket 대신 사용).

## 구조

```
minitok-addon-tossinvest/
├── package.json              # 독립 패키지 (name: minitok-addon-tossinvest)
├── index.js                  # 진입점: registerTossInvestAddon()
├── bin/target-status.js     # 적응형 목표 엔진 현황 CLI
├── bin/smoke.js              # 자격증명 기반 스모크테스트 CLI (기본 읽기 전용)
├── src/tossinvest.js         # 토스증권 REST API 어댑터 (주문·조건주문 포함)
├── src/ws.js                 # 웹소켓 클라이언트 (실시간 체결·호가·주문 이벤트)
├── src/agent/                # 에이전트 툴 레이어 (tools, safety, target 엔진, index)
├── src/core/                 # 공유 유틸 (logger, errors)
├── scripts/extract-spec.js   # openapi 스펙 추출 유틸
└── tests/                    # 63개 단위/통합 테스트 (모의 네트워크, 실제 트래픽 없음)
```

## 지원 기능

| 카테고리 | 동작(operation) |
|---|---|
| 조회 | `get_accounts`, `get_holdings`, `get_prices`, `get_orderbook`, `get_price_limits`, `get_orders`, `get_order` |
| 주문 | `create_order`, `cancel_order`, `modify_order` |
| 조건주문 (SINGLE/OCO/OTO) | `get_conditional_orders`, `get_conditional_order`, `create_conditional_order`, `modify_conditional_order`, `cancel_conditional_order` |
| 주문 정보 (신규) | `get_buying_power`(매수가능금액), `get_sellable_quantity`(매도가능수량), `get_commissions`(수수료) |
| 시장 데이터 (신규) | `get_trades`(체결), `get_candles`(캔들), `get_stocks`(종목정보), `get_stocks_all`(유니버스), `get_exchange_rate`(환율), `get_market_calendar`(거래일), `get_stock_warnings`(투자경고) |
| 실시간 (별도 모듈 `src/ws.js`) | 체결·호가(`trade`/`orderbook`), 개인 주문 이벤트(`personal:order`), 60초 PING 유지보수, 끊김 시 주문 재동기화 콜백 |

## 에이전트용 신규 기능

### Dry-run 모드 (시뮬레이션)
모든 mutation(`create_order`, `cancel_order`, `modify_order`, 조건주문 CRUD)은 `dryRun: true`(또는 `dry_run`)로 실제 네트워크 호출 없이 시뮬레이션됩니다. 결과는 `simulated: true`, `http_status: 0`, `status: "simulated"`로 반환되며 계약의 read-after-write 검증도 네트워크 없이 통과합니다.

```js
await executeAdapter(registry, "api", {
  operation: "create_order", target: { accountSeq: "1" },
  symbol: "kr:005930", side: "BUY", orderType: "LIMIT", quantity: 1, price: 70000,
  dryRun: true, // 실제 주문 전송 안 됨
}, opts);
```

에이전트 툴 레이어(`createAgentTools`)는 기본적으로 `dryRunDefault = true`이며 `dryRun: false`로 명시해야 실제 주문이 전송됩니다.

### 심볼 정규화
Toss API는 `kr:005930`/`us:AAPL` 접두사가 아닌 순수 심볼(`005930`, `AAPL`)만 받습니다. 어댑터가 모든 호출에 대해 `normalizeSymbol()`을 적용하므로 minitok 규약의 `kr:`/`us:` 접두사 표기를 그대로 사용할 수 있습니다.

### 계좌 상태 사전체크 (opt-in)
`safetyLimits: { enforcePreChecks: true }`를 설정하면 주문 생성 전에 계좌 상태를 확인합니다:
- **BUY**: `get_buying_power`의 `cashBuyingPower` ≥ 주문 금액 (부족 시 `INSUFFICIENT_BALANCE`)
- **SELL**: `get_sellable_quantity`의 `sellableQuantity` ≥ 주문 수량 (부족 시 `INSUFFICIENT_HOLDINGS`)
- 조회 실패 시 fail-closed로 `PRE_CHECK_FAILED` 반환 (기본값: 꺼짐 — 기존 동작 유지)

### 에러 코드 정규화
Toss API 에러 응답(`error`, `error_description`, BFF 래퍼 포함)을 정규화된 코드로 매핑합니다: `INSUFFICIENT_BALANCE`, `ORDER_REJECTED`, `INVALID_SYMBOL`, `RATE_LIMITED`, `TOSS_SERVER_ERROR`, `TOSS_TIMEOUT`, `TOSS_AUTH_ERROR` 등. 실패 결과에 `code`, `reason`, `api_error`가 포함됩니다.

### 타임아웃
모든 REST 호출은 AbortController 기반 30초 타임아웃을 적용하며, 초과 시 `TOSS_TIMEOUT` 코드로 반환됩니다.

### 에이전트 툴 레이어 (`src/agent/`)
```js
const { createAgentTools } = require("minitok-addon-tossinvest");
const tools = createAgentTools({
  credentials: { clientId: "...", clientSecret: "..." },
  safetyLimits: { maxOrderValueKrw: 1_000_000, allowedSymbols: ["kr:005930"] },
});
await tools.order({ target: { accountSeq: "1" }, symbol: "kr:005930", side: "BUY", orderType: "LIMIT", quantity: 1, price: 70000 }); // dryRun 기본 true
await tools.buying_power({ target: { accountSeq: "1" }, currency: "KRW" });
await tools.positions({ target: { accountSeq: "1" } });
await tools.candles({ symbol: "005930", interval: "1d", count: 10 });
```

_killswitch_: 환경변수 `TOSSINVEST_KILLSWITCH=true`면 모든 에이전트 툴 호출이 즉시 차단됩니다.

### 적응형 목표 엔진 (Adaptive Target Engine)

minitok에 **수정 없이** 애드온 내부(`src/agent/target.js`)에서만 동작하는 목표-승급-강등 엔진입니다. 에이전트의 기본 목표는 **1%/day**이며, 누적 실적이 검증되면 단계적으로 목표점과 포지션 한도를 높입니다(복리 과장을 방지: 10%/day·2%/day는 불가능에 가깝습니다).

**단계(Phase) 래더** — 승급은 데이터 충족 시에만, 실패 시 **자동 강등/중단**:

| Phase | 목표 | 실주문 | 승급 조건 |
|---|---|---|---|
| 0 (dry_run) | 1.0% | 차단 (dry-run 강제) | 30건 이상의 성공적인 주문 사이클 |
| 1 (live_small) | 1.0% | 허용 (최대 30만원) | 50일 누적 실적: 평균≥0.8%, 목표 달성률≥30%, 낙폭≤3% |
| 2 (live_scaled) | 1.25% | 허용 (최대 100만원) | 100일 누적 실적 + 상관 검증 |
| 3 (live_aggressive) | 1.5% | 허용 (최대 300만원) | terminal |

**강등/중단 트리거** (항상 평가, 승급보다 더 민감):
- 일간 손실 **≤ -1%** → 단계 강등(실시간)
- 일간 손실 **≤ -2%** → **즉시 거래 중단(halt)** + 단계 강등, `target.resume()` 또는 깨끗한 사이클 N일 이후 자동 해제
- 누적 **낙폭 > 5%** (high-water 대비) → 단계 강등
- 최근 20일 **양전 날짜 비율 < 10%** → 단계 강등
- 미측정일(스냅샷 실패 등)은 사이클에 포함되지 않음 → 승급 의사결정 **fail-closed**

**규칙이 애드온에서만 프로젝팅(projecting)** 되는 방식: `createAgentTools({ targetEngine })`에 엔진을 주입하면 `tools.order()` 호출 시 엔진이 현재 상태를 조회해 **자동으로** 적용합니다.
- `halted`면 `TARGET_ENGINE_HALTED`로 즉시 차단 (네트워크 호출 없음)
- Phase 0이면 `dryRun`을 강제 (실제 주문 불가)
- 주문 금액이 `maxOrderValueKrw`을 초과하면 `TARGET_SIZE_EXCEEDED`로 차단

```js
const { createTargetEngine, createAgentTools } = require("minitok-addon-tossinvest");
const targetEngine = createTargetEngine({ /* 옵션: statePath, now, ... */ });
const tools = createAgentTools({ credentials, safetyLimits, targetEngine });
// 이제 tools.order(...)는 엔진의 현재 단계/한도/중단 상태에 따라 자동 게이트됩니다.
```

- **상태 파일**: 기본 `~/.minitok-addon-tossinvest/target-state.json` (원자적 쓰기). `--state <path>` 또는 `TOSSINVEST_TARGET_STATE`로 변경.
- **실적 기록**: `recordOperationOutcome()`은 주문 결과를 사이클로 기록, `recordEquitySnapshot({equity})`/`recordDailyEquity()`은 일별 포트폴리오 가치의 일간 변화를 계산해 return-cycle로 기록. `createEquitySnapshotter({credentials, accountSeq})`가 `getHoldings`+`getBuyingPower`+`get_exchange_rate`로 KRW 평가금액을 자동 조회해 줍니다.
- **현황 CLI**: `node bin/target-status.js` (텍스트) / `node bin/target-status.js --json`.

## 설치 · 테스트

```powershell
cd C:\Users\J1\minitok-addon-tossinvest
npm install        # ws 의존성
npm test           # 63개 테스트 (minitok sibling 체크아웃을 peer로 사용)
```

minitok 체크아웃 위치가 다르면: `$env:MINITOK_CLIENT_ROOT = "C:\path\to\minitok-client-release"`

## 실제 자격증명 스모크테스트 (소액 검증)

```powershell
$env:TOSS_CLIENT_ID = "tsck_live_..."
$env:TOSS_CLIENT_SECRET = "..."
npm run smoke                      # 읽기 전용: 토큰/계좌/잔고/시세/주문/조건주문 조회
# 라이브 소액 주문 왕복 (지정가 1주 → 검증 → 즉시 취소):
node bin/smoke.js --place-order --symbol kr:005930 --qty 1 --price 1000
```

사전 조건: 토스증권 WTS에서 Open API 활성화 + **허용 IP 등록** (미등록 시 403/401).

## 사용법 (호스트 스크립트)

```js
const { createAdapterRegistry, executeAdapter } =
  require("C:/path/to/minitok-client-release/src/goal/adapter_registry");
const { registerTossInvestAddon } = require("minitok-addon-tossinvest");

const registry = createAdapterRegistry();
registerTossInvestAddon(registry, {
  minitokRoot: "C:/path/to/minitok-client-release",
  credentials: { clientId: process.env.TOSS_CLIENT_ID, clientSecret: process.env.TOSS_CLIENT_SECRET },
  safetyLimits: { maxOrderValueKrw: 1_000_000, allowedSymbols: ["kr:005930"] },
});

const result = await executeAdapter(registry, "api", {
  operation: "create_order",
  target: { accountSeq: "12345" },
  symbol: "kr:005930", side: "BUY", orderType: "LIMIT", quantity: 1, price: 70000,
}, {
  capabilities: ["read", "inspect", "external_call", "credential_use"],
  mode: "authorized_external",
  production_adapter_opt_in: true, audit_persisted: true, integrity_preflight: true,
  environment_observation: { external_connectivity: true },
  operation_ledger: new Map(),
});
// result.completed === true 여야 실행 완료 (read-after-write 검증 포함)
```

웹소켓:

```js
const { createTossWsClient } = require("minitok-addon-tossinvest/src/ws");
const client = createTossWsClient({
  getToken: () => fetchAccessToken(clientId, clientSecret),
  onMessage: frame => console.log(frame.topic, frame.data),
  onNeedResync: () => { /* 재연결 → GET /api/v1/orders로 주문 상태 재동기화 */ },
});
await client.connect();
client.subscribe([{ type: "personal:order", codes: [accountSeq] }]);
```

## 보안 · 안전 정책

- `execution_policy: "authorized_external"`, `production: true` — minitok의 승인/감사/무결성 게이트가 모두 충족되기 전에는 어떤 주문도 실행되지 않음 (fail-closed).
- 모든 쓰기 작업에 `external_operation_contract`: 멱등성 키(→ Toss `clientOrderId`로 전달, 10분 유효), read-after-write 검증, 30초 타임아웃, 재시도 정책.
- 중복 실행은 operation ledger에서 `DUPLICATE_EXTERNAL_OPERATION`으로 차단 (모의 테스트로 검증됨).
- safety limit: 종목 화이트리스트, 1건 최대 주문 금액 — 네트워크 호출 전에 차단.
- 자격증명은 환경변수로만 전달. 코드에 하드코딩 금지.
- 데이터 이용 정책: 투자자 본인 매매 목적으로만 사용 가능 (제3자 배포 금지).

## 참고

- 토스증권 OpenAPI 문서: https://developers.tossinvest.com (LLM용 `llms.txt` 제공)
- Rate limits: 주문 `ORDER` 그룹, 조건주문 `CONDITIONAL_ORDER` 그룹 / 웹소켓: 계정당 2 연결, 연결당 100 구독, 선언 5회/초

## L4.5 Self-Awareness Layer (Phase A~J)

`runner.js`는 Phase A~H의 기본 인프라 위에 **L4.5 자가-인지 레이어**를 확장했습니다. 각 Phase는 독립 모듈로 구현되어 runner.js에 순차 통합됩니다.

| Phase | 모듈 | 역할 | 상태 |
|-------|------|------|------|
| **A** | `src/intelligence/pipeline.js`, `src/memory/trading-memory.js` | 뉴스·거시·센티먼트 수집 + 유사 경험 회상 | ✅ 통합 |
| **B** | `src/council/council.js`, `src/simulation/scenario.js` | 다중 에이전트 합의 + 몬테카를로 시뮬레이션 | ✅ 통합 |
| **C** | `src/orchestrator/shadow-mode.js`, `killswitch.js`, `approval-gate.js` | 그림자 모드 + 비상 정지 + 승인 게이트 | ✅ 통합 |
| **D** | `src/orchestrator/evolution.js` | 유전 알고리즘 기반 파라미터 진화 | ✅ 통합 |
| **E** | `src/strategy/orchestrator.js` | 전략 버킷 할당 + 성과 추적 | ✅ 통합 |
| **F** | `src/risk/var-engine.js`, `portfolio-risk.js` | VaR/CVaR 포트폴리오 리스크 | ✅ 통합 |
| **G** | `src/strategy/regime-hmm.js` | 3-state HMM (bull/sideways/bear) 체제 인식 | ✅ 통합 |
| **H** | `src/orchestrator/walk-forward.js` | OOS 워크포워드 검증 | ✅ 통합 |
| **I** | `src/intelligence/meta-cognition.js` | 의사결정 스코어링 + Spearman 보정 + 자가-학습 | ✅ 통합 |
| **J** | `src/orchestrator/self-healing.js` | 사고 분류 + 자동 완화 + 에스컬레이션 | ✅ 통합 |
| **K** | `src/ai/confidence.js` | LLM 불확실성 정량화 + 3축 신뢰도 | ✅ 통합 |
| **L** | `src/strategy/lifecycle.js` | 전략 수명주기 (DISCOVERY→INCUBATION→PRODUCTION→RETIREMENT) | ✅ 통합 |

### Phase I Meta-Cognition Engine

의사결정의 **질(quality)** 을 6차원 벡터로 점수화하고, 결과(PnL)와의 상관관계를 Spearman rho로 자동 보정하는 엔진입니다.

```js
const { createMetaCognition } = require("./src/intelligence/meta-cognition");
const meta = createMetaCognition({
  threshold: 0.55,           // 이하는 "weak decision"으로 분류
  recalibrateEvery: 100,     // N건마다 자동 보정
  minDecisionsForCalibration: 5,
  maxHistory: 500,
});

// 6차원 점수 벡터
const r = meta.recordDecision("d-001", {
  evidenceDepth: 0.9,       // intelligence 파이프라인 충실도
  councilAgreement: 0.8,    // council 합의 (disagreement inverse)
  regimeAlignment: 1.0,     // HMM regime ↔ action 정합
  memorySupport: 0.7,       // 유사 경험 승률
  walkForwardPass: 1,       // OOS 검증 통과 여부
  noveltyPenalty: 0.9,      // 과거 실패 패턴 유사도 (inverse)
});
// r = { id, aggregate, isWeak, scores }

meta.attachOutcome("d-001", { pnl: 15000, holdBars: 8 });
const cal = meta.calibrate(); // { rho, sampleSize, suggestedWeights }
```

**runner.js 통합 포인트:**
- BUY 결정 시 `_metaCogIntel`/`_metaCogMemory`/`_metaCogCouncil` 주입 → `recordDecision()`
- SELL fill 시 `attachOutcome(decisionId, { pnl })`로 round-trip 폐쇄
- 매 1시간마다 `calibrate()` 자동 실행 (Spearman rho 계산)
- Weak decision은 journal + metrics로 관측
- `/meta-cognition` HTTP 엔드포인트로 실시간 모니터링
- Graceful shutdown 시 `metaCogDecisionMap` 영속화

**환경변수:**
```
META_COG_THRESHOLD=0.55
META_COG_RECALIBRATE_EVERY=100
META_COG_CALIBRATION_INTERVAL_MS=3600000
```

**테스트:** `tests/test-meta-cognition.js` — **36/36 passing** (spearmanRho, scoreDecisionContext, factory, calibrate, maxHistory, custom weights)

### Phase J Self-Healing Framework

사고(incident)를 자동으로 분류하고, 유형별로 **쿨다운 기반 자동 완화**를 적용하며, 반복 발생 시 Phase N(인간 에스컬레이션)으로 승급하는 프레임워크입니다.

```js
const { createSelfHealer } = require("./src/orchestrator/self-healing");
const healer = createSelfHealer({
  onIncident: (type, ctx) => { /* Telegram 알림 등 */ },
  onMitigation: (type, action) => { /* 로그 기록 */ },
  onEscalation: (type, info) => { /* 인간 개입 요청 */ },
});

// 수동 보고
healer.reportIncident("API_TRANSIENT", { source: "ws", code: 429 });

// 자동 감지 (tick마다)
healer.tick({ currentRegime: "bear", spreadBps: 5.2, calibrationRho: 0.15 });
```

**6가지 사고 유형:**

| 유형 | 트리거 | 완화 액션 | 쿨다운 |
|------|--------|-----------|--------|
| `API_TRANSIENT` | WS 끊김, 429, 5xx | backoff + 재연결 | 1분 |
| `DATA_DRIFT` | Spearman rho < 0.2 (2회 연속) | 전략 일시정지 | 1시간 |
| `REGIME_MISMATCH` | HMM regime 3회 연속 플립 | 전략 일시정지 | 30분 |
| `PARAM_STALE` | Walk-forward reject 2회 연속 | 재진화 트리거 | 2시간 |
| `LIQUIDITY_SHOCK` | 스프레드 > 3bps | BUY 차단 | 30분 |
| `LLM_DEGRADATION` | 지연 > 10s 또는 parse 오류 > 20% | 프로바이더 전환 | 5분 |

**runner.js 통합 포인트:**
- `detectRegime()` 후 `selfHealer.tick({ currentRegime })` — REGIME_MISMATCH 자동 감지
- Auth 오류 시 `reportIncident("API_TRANSIENT")` — API 일시장애 기록
- AI 실패 시 `reportIncident("LLM_DEGRADATION")` — LLM 성능 저하 감지
- Orderbook 조회 후 `tick({ spreadBps })` — LIQUIDITY_SHOCK 자동 감지
- Walk-forward verdict 후 `tick({ walkForwardVerdict })` — PARAM_STALE 자동 감지
- Calibration 후 `tick({ calibrationRho })` — DATA_DRIFT 자동 감지
- BUY 실행 전 `isMitigated("LIQUIDITY_SHOCK")` 체크 — 매수 차단
- `/self-healing` HTTP 엔드포인트로 실시간 모니터링
- Graceful shutdown 시 self-healing state 영속화

**테스트:** `tests/test-self-healing.js` — **32/32 passing** (reportIncident, cooldown, escalation, tick auto-detect all 6 types, state/restore, reset, callbacks, FIFO eviction)

### Phase K Confidence Calibration (LLM 불확실성 정량화)

LLM 응답의 신뢰도를 정량화하여 저신뢰 결정 시 포지션 크기를 자동 축소하거나 거래를 건너뜁니다.

**신뢰도 계산 3축:**
| Signal | 설명 | 가중치 |
|--------|------|--------|
| `actionAgreement` | N회 샘플 중 동일 action 비율 (mode 일치도) | 0.50 |
| `numericStability` | 수치 필드(targetPrice, quantity 등) CV 기반 안정성 | 0.30 |
| `logprobScore` | Provider가 노출한 token logprob 평균 (없으면 재분배) | 0.20 |

**권장 티어:**
- `confidence >= 0.40` → proceed (scale=1.0)
- `confidence >= 0.20` → reduce (scale=0.25, 75% 축소)
- `confidence < 0.20` → skip (scale=0, 거래 생략)

```js
const { createConfidenceCalibrator } = require("./src/ai/confidence");
const conf = createConfidenceCalibrator({ sampleCount: 3, minThreshold: 0.40 });
const result = await conf.evaluate(callLLM, messages);
const qty = conf.adjustPosition(100, result);  // → 25 if reduce
```

**런너 통합 포인트:**
- `callAI()` 호출 시 필요에 따라 `confidenceCalibrator.evaluate()`로 N회 샘플링
- `/confidence` HTTP 엔드포인트로 실시간 통계/히스토리 모니터링
- `/health` 엔드포인트에 `confidence` 블록 추가
- Graceful shutdown 시 `confidenceCalibrator.state()` 영속화

**테스트:** `tests/test-confidence.js` — **51/51 passing** (DEFAULTS, extractAction, extractNumerics, coefficientOfVariation, computeActionAgreement, computeNumericStability, computeLogprobScore, evaluateFromResponses proceed/reduce/skip tiers, async evaluate sampling, error handling, adjustPosition scaling/clamping, stats, getHistory, state/restore, reset, onLowConfidence callback, maxHistorySize FIFO)

### Phase L Strategy Lifecycle Manager (전략 수명주기 관리)

LLM이 제안한 전략을 **DISCOVERY → INCUBATION → PRODUCTION → RETIREMENT** 4단계로 관리하며, 점진적 자본 배분과 성과 기반 자동 은퇴를 수행합니다.

**수명주기 단계:**
| 단계 | 설명 | 자본 배분 |
|------|------|-----------|
| `DISCOVERY` | LLM 제안, 검증 대기 | 0% |
| `INCUBATION` | Shadow paper trading | 0% |
| `PRODUCTION` | 실거래 (단계별 확대) | 10% → 50% → 100% |
| `RETIREMENT` | 성과 악화로 비활성화 | 0% |

**검증 파이프라인 (가중합 ≥ 0.70 → promote, ≥ 0.40 → shadow, 미만 → reject):**
| 검사 | 가중치 | 기준 |
|------|--------|------|
| Walk-forward OOS | 0.40 | `verdict === "deploy"` |
| VaR 리스크 | 0.30 | parametricVaR < 5% (또는 <10% 시 0.15) |
| Council 승인 | 0.30 | `approved === true` |

**자동 은퇴 트리거 (L45_IMPLEMENTATION_PLAN.md §7.3):**
- 30일 롤링 Sharpe < 0.0
- 60일 롤링 Sharpe < 0.2
- 최대 드로다운 > 전략 한도 × 1.5 (killswitch)
- 50거래 이상 승률 < 35%

```js
const { createLifecycleManager } = require("./src/strategy/lifecycle");
const lm = createLifecycleManager({
  walkForwardValidator, varEngine, council,
  onPromote: (id, phase, alloc) => { ... },
  onRetire:  (id, reason, from)  => { ... },
});
const s = lm.proposeStrategy({ name: "momentum_v2", logic: "SMA cross", hypothesis: "..." });
const v = await lm.validate(s.id);
if (v.verdict === "promote") lm.promote(s.id, "INCUBATION");
lm.recordFill(s.id, { symbol: "AAPL", pnl: 150 });
const check = lm.checkRetirement(s.id);
if (check.shouldRetire) lm.retire(s.id, check.reason);
```

**런너 통합 포인트:**
- Phase H walk-forward 이후 초기화 (`runner.js:784`)
- `/lifecycle` HTTP 엔드포인트로 전략 목록/통계/히스토리 조회
- `/lifecycle/:id` 개별 전략 상세 + 은퇴 점검 결과
- `/health` 엔드포인트에 `lifecycle` 블록 (byPhase count, totalAllocatedPct)
- `dumpRunnerState()`/`restoreRunnerState()`에 `lifecycle` state 영속화
- `onPromote`/`onRetire` 콜백 → journal + metrics + Telegram 알림

**환경변수:**
```
LIFECYCLE_ENABLED=true          # 기본 활성
LIFECYCLE_MIN_SHARPE_30D=0.0
LIFECYCLE_MIN_SHARPE_60D=0.2
LIFECYCLE_DD_MULTIPLIER=1.5
LIFECYCLE_MIN_WIN_RATE=0.35
LIFECYCLE_MIN_TRADES_WIN_RATE=50
```

**테스트:** `tests/test-lifecycle.js` — **56/56 passing** (DEFAULTS, PHASES, proposeStrategy 5 cases, validate 7 cases incl. WF/VaR/council + error resilience, promote 8 cases incl. graduated allocation, retire 4 cases, recordFill 4 cases, checkRetirement 6 cases covering all 4 triggers, getStrategy/listStrategies/getByPhase, stats, getHistory + FIFO, state/restore 3 cases, reset, computeRollingSharpe 5 cases, onReview exception safety)

### Phase M Cross-Market Arbitrage Scanner (크로스 마켓 차익거래 감지)

여러 거래소의 동일 자산 가격을 비교하여 FX 조정 후 차익거래 기회를 실시간 감지합니다.

**지원 페어 유형:**
| 유형 | 시장 A | 시장 B | 비고 |
|------|--------|--------|------|
| GDR/ADR | KRX 005930 | LSE GDR / OTC ADR | ADR ratio 적용 |
| 이중상장 | NASDAQ TSLA | FRA TSLA.DE / HKEX 9868 | FX + 거래소 수수료 |
| 암호화폐 | Binance BTC-USDT | Upbit BTC-KRW | 김치프리미엄 감지 |

**스프레드 계산 파이프라인:**
1. 양쪽 가격을 공통 통화(USD)로 FX 정규화
2. ADR ratio 적용 (예: 삼성 1 GDR = 50 KRX 주식)
3. 베이시스 포인트 계산: `((pB - pA) / midpoint) × 10000`
4. 왕복 비용 차감 (2 × costBps) → net spread
5. `|netSpread| ≥ thresholdBps` 시 opportunity 감지

```js
const { createCrossMarketScanner } = require("minitok-addon-tossinvest");
const scanner = createCrossMarketScanner({
  priceFeeds: {
    KRX: async (sym) => 71000,
    LSE: async (sym) => 1050,
  },
  fxProvider: async (pair) => pair === "KRWUSD" ? 0.00075 : 1,
  config: { thresholdBps: 50, costBps: 10 },
  onOpportunity: (opp) => console.log(`Arb: ${opp.pairId} ${opp.direction} ${opp.grossBps}bps`),
  onError: (pairId, err) => console.error(`${pairId}: ${err.message}`),
});
scanner.registerPair({
  id: "samsung_gdr", name: "Samsung GDR",
  assetA: { exchange: "KRX", symbol: "005930", currency: "KRW", adrRatio: 50 },
  assetB: { exchange: "LSE", symbol: "SMSN", currency: "USD" },
});
const result = await scanner.scan();
// result.opportunities: [{ pairId, direction, grossBps, netBps, prices: { A, B } }]
```

**스캔 결과 구조:**
```json
{
  "scannedAt": 1697100000000,
  "pairsScanned": 3,
  "opportunities": [
    {
      "pairId": "samsung_gdr",
      "direction": "A_TO_B",
      "grossBps": 95.24,
      "netBps": 75.24,
      "opportunity": true,
      "prices": {
        "A": { "raw": 71000, "normalized": 2662.5, "fx": 0.00075, "currency": "KRW" },
        "B": { "raw": 1050, "normalized": 1050, "fx": 1, "currency": "USD" }
      }
    }
  ]
}
```

**에러 격리:** 각 페어는 독립적으로 스캔되며, 하나의 실패가 다른 페어에 영향을 주지 않습니다:
- Price feed 미등록 → `error: "no price feed for exchange: ..."` 
- Fetch 타임아웃 → `error: "price fetch timeout (5000ms): ..."`
- 비정상 가격 (≤0) → `error: "invalid price from ..."`
- FX provider 미설정 → `error: "no fxProvider configured"`

**런너 통합 포인트:**
- Phase A intelligence pipeline 이후 초기화 (`runner.js`)
- `/cross-market` HTTP 엔드포인트로 페어 목록/스캔 결과/히스토리 조회
- `/health` 엔드포인트에 `crossMarket` 블록 (scans, opportunities, errors)
- `dumpRunnerState()`/`restoreRunnerState()`에 scanner state 영속화
- `onOpportunity` 콜백 → journal + metrics + Telegram 알림

**환경변수:**
```
CROSS_MARKET_ENABLED=false         # 다중 브로커 준비 전 기본 off
CROSS_MARKET_THRESHOLD_BPS=50      # 차익 감지 임계값 (basis points)
CROSS_MARKET_COST_BPS=10           # 편도 거래 비용 (bps)
CROSS_MARKET_SCAN_INTERVAL_MS=60000 # 스캔 주기
CROSS_MARKET_FETCH_TIMEOUT_MS=5000  # 가격/FX fetch 타임아웃
CROSS_MARKET_MAX_HISTORY=1000       # 히스토리 최대 크기
```

**테스트:** `tests/test-cross-market.js` — **26/26 passing** (DEFAULTS, bps helper 3 cases, pair management 5 cases, scan empty/no-pairs, A_TO_B detection, B_TO_A detection, below-threshold no-opportunity, FX normalization + ADR ratio, error isolation per-pair, timeout handling, onOpportunity callback, stats counters, getHistory + FIFO cap, state/restore persistence, reset, null-restore safety, inactive pair skip, missing price feed, invalid price rejection, missing fxProvider error)

### Phase N Human Escalation Protocol (인간 에스컬레이션 프로토콜)

자동 알림을 넘어 **구조화된 의사결정 요청 + 인간 응답 대기 + 타임아웃 폴백**을 제공하는 L4.5 에스컬레이션 매니저입니다.

**주요 기능:**
- 다중 채널(Telegram, Discord, Email) 동시 브로드캐스트
- 심각도별 템플릿 렌더링 (`info` / `warn` / `critical`)
- 권장 옵션(recommended), 타임아웃, 폴백 전략 지원
- 일일 한도(dailyLimit) + 쿨다운(cooldownKey) 중복 에스컬레이션 방지
- 응답 시 타이머 취소, 타임아웃 시 자동 폴백 해결
- 감사 로그(audit) + 콜백(onResponse / onTimeout)

```js
const { createEscalationManager } = require("minitok-addon-tossinvest");
const em = createEscalationManager({
  channels: {
    telegram: async (msg) => sendTelegram(msg),
    email:    async (msg) => sendEmail(msg),
  },
  config: {
    dailyLimit: 5,
    defaultTimeoutMs: 4 * 3600_000,   // 4시간
    timeoutFallback: "default",       // "default" | "safest" | "none"
    cooldownMs: 5 * 60_000,           // 동일 키 5분 쿨다운
  },
  onResponse: (id, optId, entry) => log("human", id, optId),
  onTimeout:  (id, fallback, entry) => log("timeout", id, fallback),
  audit: (event) => journal.write(event),
});

const id = await em.escalate({
  severity: "critical",
  summary: "killswitch triggered",
  bullets: ["DATA_DRIFT 3 days", "Sharpe -1.2"],
  options: [
    { id: "wait",   label: "1h wait",     recommended: true },
    { id: "shadow", label: "shadow mode" },
    { id: "abort",  label: "full abort"  },
  ],
  cooldownKey: "killswitch",
  fallbackOptionId: "shadow",
  timeoutMs: 60_000,
  metadata: { strategyId: "momentum_v2" },
});

// 인간의 응답 처리 (예: Telegram reply webhook)
em.respond(id, "wait");

// 조회
em.getPending();            // 미해결 에스컬레이션 배열
em.getHistory(50);          // 최근 50개 히스토리
em.stats();                 // { enabled, dailyLimit, todayCount, remainingToday, total, responded, timedOut, rejected, pendingCount, channels }
em.state() / em.restore(snap) / em.reset();
```

**타임아웃 폴백 모드:**
| `timeoutFallback` | 동작 |
|-------------------|------|
| `"default"`       | `recommended: true` 옵션 선택 (없으면 첫 번째 옵션) |
| `"safest"`        | 마지막 옵션 선택 (보통 가장 보수적) |
| `"none"`          | `optionId: null`로 기록, 상위 레이어에서 결정 |
| (explicit)        | `fallbackOptionId`가 지정되면 그 옵션 선택 |

**거부(rejected) 사유:**
- `disabled`: `enabled: false` 설정
- `daily_limit`: 금일 `dailyLimit` 소진
- `cooldown`: 동일 `cooldownKey`에 대해 `cooldownMs` 경과 전

**채널 에러 격리:** 한 채널의 실패가 다른 채널 전송을 막지 않습니다. 각 채널 결과는 `dispatchResults[]`에 `{ok, error}` 형태로 기록됩니다.

**환경변수:**
```
ESCALATION_ENABLED=true             # 기본 활성
ESCALATION_DAILY_LIMIT=3            # 1일 최대 에스컬레이션 수
ESCALATION_TIMEOUT_MS=14400000      # 기본 타임아웃 (4시간)
ESCALATION_TIMEOUT_FALLBACK=default # default | safest | none
ESCALATION_COOLDOWN_MS=300000       # 동일 키 쿨다운 (5분)
ESCALATION_MAX_HISTORY=500          # 히스토리 최대 크기
```

**테스트:** `tests/test-escalation.js` — **32/32 passing** (DEFAULTS, SEVERITIES, renderTemplate 2 cases, escalate validation 4 cases, dispatch + multi-channel, channel error isolation, respond happy path, respond unknown optionId, respond double-resolve, respond missing id, daily limit + remainingToday, cooldown per-key + cross-key isolation, timeout fallback default/safest/none/explicit, respond cancels timeout, disabled state, audit trail, stats counters, getHistory + FIFO cap, state/restore persistence, reset, null-restore safety, getPending filtering, metadata passthrough)

## 실제 스펙과의 정합 (v1.2.21 openapi.json 기준 검증 완료)

- **응답 래퍼**: 모든 인증 API는 `{ result: ... }` (BFF `ApiResponse`) — 어댑터가 자동 unwrap
- **주문 생성 응답** (`OrderResponse`): `orderId` + `clientOrderId`만 반환, **status 없음** → read-after-write는 실조회로 상태 확인, 계약 fingerprint는 `orderId` 단독 비교
- **주문 상태 enum**: `PENDING, PENDING_CANCEL, PENDING_REPLACE, PARTIAL_FILLED, FILLED, CANCELED, REJECTED, CANCEL_REJECTED, REPLACE_REJECTED, REPLACED` (목록 파라미터 `status`는 그룹 라벨 `OPEN`/`CLOSED` — 별개 체계)
- **목록 응답**: `result.orders[]` 항목에 `clientOrderId` 없음 → 생성 직후 검증은 로컬 멱등키 레지스트리(최대 200건) + 상세 실조회로 해결
- **조건주문**: 생성 응답 `{ conditionalOrderId, clientOrderId }`, 상세에는 `status` 포함, 수정 시 ID 재발급(무효화) 반영
- 스펙 추출 유틸: `node scripts/extract-spec.js` (오프라인 스펙 파일 `$TEMP/toss-openapi.json` 필요)

## Data Collection Notes

- JP market: Toss Securities OpenAPI does not support JP (Japan) market data. JP symbols remain in the universe for reference, but price collection is disabled; P&L for held JP positions uses broker `avgPrice` fallback only.

