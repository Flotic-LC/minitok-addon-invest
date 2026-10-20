# Level 4.5 Implementation Plan ??minitok-addon-tossinvest

> **?묒꽦**: 2026-10-12
> **?곹깭**: Draft
> **湲곗?**: `runner.js` Phase A~H ?꾩꽦 ?? L4.5 ?꾨떖 媛?遺꾩꽍 湲곕컲

---

## 1. 媛쒖슂: Level 4.5? 臾댁뾿?멸?

minitok???먯쑉???깃툒? ?먯쑉二쇳뻾 SAE ?덈꺼??李⑥슜??5?④퀎 遺꾨쪟瑜??곕Ⅸ??

| Level | ?대쫫 | ?섎? | ?꾩옱 ?곹깭 |
|-------|------|------|-----------|
| L1 | Manual | ?섎룞 ?ㅽ뻾, AI 蹂댁“ ?놁쓬 | ??議몄뾽 |
| L2 | Assisted | AI 異붿쿇 + ?멸컙 ?뱀씤 | ??議몄뾽 |
| L3 | Conditional | ?뱀젙 議곌굔(?뚯븸쨌?⑥닚) ?먯쑉 | ??議몄뾽 |
| **L4.5** | **High-Autonomy with Self-Awareness** | **?遺遺??먯쑉 + ?먭린?몄? + ?ㅽ뙣 ?먭?蹂듦뎄 + ?멸컙 ?먯뒪而щ젅?댁뀡** | **??紐⑺몴** |
| L5 | Full Autonomy | 紐⑤뱺 議곌굔 ?꾩쟾 ?먯쑉, ?멸컙 媛쒖엯 遺덊븘??| ?κ린 紐⑺몴 |

**L4.5???듭떖 ?붽굔**(?먯쑉二쇳뻾 L4? 援щ텇?섎뒗 ?몃젅?대뵫 ?뱁솕 ?붿냼):
1. **Self-Awareness (?먯븘?몄?)**: AI媛 *?먯떊??寃곗젙 ?덉쭏*???ㅼ떆媛??됯??쒕떎.
2. **Confidence Calibration (?좊ː??蹂댁젙)**: LLM ?묐떟??uncertainty瑜?泥⑤??섍퀬, 遺덊솗????蹂댁닔???됰룞??痍⑦븳??
3. **Self-Healing (?먭?蹂듦뎄)**: ?ㅽ뙣 ?⑦꽩??媛먯??섍퀬 肄붾뱶 蹂寃??놁씠 ?먮룞 蹂듦뎄?쒕떎.
4. **Human Escalation (?멸컙 ?먯뒪而щ젅?댁뀡)**: 寃쎄퀎瑜??섏쑝硫??멸컙?먭쾶 *留λ씫怨?異붿쿇 ?됰룞*???④퍡 ?꾨떖?쒕떎.
5. **Continuous Self-Improvement (吏???먭린媛쒖꽑)**: ?꾨왂 ?앹꽦?믨?利앪넂諛고룷?믪??댁쓽 ?꾩쟾???섎챸二쇨린瑜??먮룞?뷀븳??
6. **Regulatory Self-Compliance (洹쒖젣 ?먭?以??**: 嫄곕옒?뙿룹꽭臾는룹쇅??洹쒖젙??肄붾뱶 ?섏??먯꽌 ?먮룞 ?곸슜?쒕떎.

---

## 2. ?꾩옱 ?곹깭: Phase A~H ?먯궛 ?뺣━

?꾨옒???대? L4.5濡??쒓렇?섏뼱 `runner.js`???듯빀??紐⑤뱢援곗씠??

| Phase | 紐⑤뱢 | ??븷 | L4.5 湲곗뿬??|
|-------|------|------|-------------|
| **A** | `intelligence/pipeline.js`, `memory/trading-memory.js` | 留ㅽ겕濡쑣룰컧?굿룸돱???섏쭛 + 怨쇨굅 寃곗젙 ?좎궗???뚯긽 | ?몄? ?낅젰 |
| **B** | `council/council.js`, `simulation/scenario.js` | ?ㅼ쨷 ?먯씠?꾪듃 ?⑹쓽 + ?쒕굹由ъ삤 ?쒕??덉씠??| 吏묐떒吏??|
| **C** | `orchestrator/shadow-mode.js`, `killswitch.js`, `approval-gate.js` | 洹몃┝??寃利?+ 鍮꾩긽 ?뺤? + ?뱀씤 寃뚯씠??| ?덉쟾?μ튂 |
| **D** | `orchestrator/evolution.js` | ?좎쟾 ?뚭퀬由ъ쬁 ?뚮씪誘명꽣 理쒖쟻??(二쇨컙) | ?먭린理쒖쟻??|
| **E** | `strategy/orchestrator.js` | ?꾨왂蹂??깃낵 媛以??먮낯 諛곕텇 | ?먯썝 諛곕텇 |
| **F** | `risk/var-engine.js`, `portfolio-risk.js` | VaR/CVaR (?뚮씪硫뷀듃由?룹뿭??룸が?뚯뭅瑜쇰줈) | ?꾪뿕 ?뺣웾??|
| **G** | `strategy/regime-hmm.js` | HMM 3-state (bull/sideways/bear) 異붾줎 | ?쒖옣 ?몄? |
| **H** | `orchestrator/walk-forward.js` | OOS 寃利앹쑝濡?怨쇱쟻??李⑤떒 | 寃利?寃뚯씠??|

**?뚯뒪??而ㅻ쾭由ъ?**: 553/553 passing (?꾩껜 ?ㅼ쐞??

---

## 3. 媛?遺꾩꽍: L4.5 ?꾨떖??遺議깊븳 6媛吏 異?

```
?뚢???????????????????????????????????????????????????????????????
??                   L4.5 SELF-AWARENESS LAYER                 ??
?쒋???????????р???????????р???????????р??????????р??????????р??????????

---

## 4. Phase I ??Meta-Cognition Engine (?먭린?몄?)

**紐⑺몴**: AI媛 *?대┛ 寃곗젙 ?먯껜*???덉쭏???ㅼ떆媛꾩쑝濡??됯??섍퀬, ?먮떒 洹쇨굅??嫄댁쟾?깆쓣 ?먯닔?뷀븳??

### 4.1 ?ㅺ퀎

```js
// src/intelligence/meta-cognition.js
createMetaCognition({
  decisionScorer(decision) {
    // 寃곗젙 ?쒖젏??而⑦뀓?ㅽ듃瑜??ㅼ감???먯닔濡??섏궛
    return {
      evidenceDepth: 0..1,     // intelligence pipeline ?낅젰 ??/ 理쒖냼 ?붽뎄 ??
      councilAgreement: 0..1,  // council ?⑹쓽 媛뺣룄 (?쒖??몄감 inverse)
      regimeAlignment: 0..1,   // HMM regime? ?꾨왂 諛⑺뼢 ?쇱튂??
      memorySupport: 0..1,     // ?좎궗 怨쇨굅 寃곗젙???깃났瑜?
      walkForwardPass: 0|1,    // walk-forward deploy/reject
      noveltyPenalty: 0..1,    // 怨쇨굅 ?ㅽ뙣 ?⑦꽩怨쇱쓽 ?좎궗??(inverse)
    };
  },
  aggregateScore(scores) { /* 媛以묓룊洹? 湲곕낯 洹좊벑 媛以?*/ },
  threshold: 0.55,             // ?댄븯硫?"??덉쭏 寃곗젙"?쇰줈 遺꾨쪟
});
```

### 4.2 ?듯빀 ?ъ씤??

| ?꾩튂 | ??|
|------|----|
| `runner.js` BUY/SELL 寃곗젙 吏곹썑 | `meta.recordDecision(id, scores)` |
| ?ъ???泥?궛 ??| `meta.attachOutcome(id, pnl, holdBars)` |
| 24h 二쇨린 | `meta.calibrate()` ???덉륫 ?먯닔? ?ㅼ젣 PnL ?곴? 遺꾩꽍, 媛以묒튂 媛깆떊 |

### 4.3 ?곗텧臾?

- `meta.stats()`: ?꾩쟻 寃곗젙 ?? ?됯퇏 ?먯닔, ?먯닔-PnL ?곴? 怨꾩닔
- `meta.getWeakDecisions(n)`: ?먯닔 ??븯?쇰굹 媛뺥뻾??寃곗젙 由ъ뒪?????꾨왂 ????꾨낫

### 4.4 ?깃났 湲곗?

- 寃곗젙 ?덉쭏 ?먯닔? ?ㅼ젣 PnL??Spearman ? ??0.35 (100 寃곗젙 ?꾩쟻 ??
- 誘몃떖 ??媛以묒튂 ?먮룞 ?ы븰???먮뒗 ?멸컙 寃???붿껌

---

## 5. Phase J ??Self-Healing Framework (?먭?蹂듦뎄)

**紐⑺몴**: ?ㅽ뙣瑜??좏삎蹂꾨줈 遺꾨쪟?섍퀬, 肄붾뱶 ?щ같???놁씠 ?고???????꾨왂???꾪솚?쒕떎.

### 5.1 ?ㅽ뙣 ?좏삎 ?앹냼?몃?

| ?좏삎 | ?몃━嫄?| ?먮룞 ???|
|------|--------|----------|
| `API_TRANSIENT` | Toss WS ?딄?, 429, 5xx | `connection-manager` ?ъ떆??+ 吏??諛깆삤??|
| `DATA_DRIFT` | 理쒓렐 50媛?寃곗젙???밸쪧 關 짹 2? ?댄깉 | ?꾨왂 媛以묒튂 ?щ텇諛?(`strategy/orchestrator` ?몄텧) |
| `REGIME_MISMATCH` | HMM regime 蹂????3?곗냽 ?먯떎 | regime蹂??꾨━???꾨왂?쇰줈 ?먮룞 ?꾪솚 |
| `PARAM_STALE` | Walk-forward reject 2???곗냽 | Phase D evolution 媛뺤젣 ?ъ떎??|
| `LIQUIDITY_SHOCK` | ?ㅽ봽?덈뱶 > 3? | ?좉퇋 BUY 30遺??쇱떆 以묒? + killswitch 寃쎄퀬 |
| `LLM_DEGRADATION` | LLM ?묐떟 吏??> 10s ?먮뒗 parse ?ㅽ뙣??> 20% | `provider-router`媛 諛깆뾽 紐⑤뜽濡??꾪솚 |

### 5.2 紐⑤뱢

```js
// src/orchestrator/self-healing.js
createSelfHealer({
  onIncident(type, ctx) {
    // 1) 遺꾨쪟 2) ????ㅽ뻾 3) 媛먯궗 濡쒓렇 4) ?멸컙 ?먯뒪而щ젅?댁뀡 ?щ? 寃곗젙
  },
  cooldowns: { API_TRANSIENT: 60_000, DATA_DRIFT: 3600_000, ... },
  escalationThreshold: 3, // ?숈씪 ?좏삎 ?꾩쟻 3?뚮㈃ Phase N?쇰줈 ?먯뒪而щ젅?댁뀡
});
```

### 5.3 ?곹깭 蹂듭썝

- `.runner-state.json`??`healingHistory[]`, `activeMitigations{}` ???
- ?ъ떆?????쒖꽦 ?꾪솕嶺?蹂듭썝 (?? regime ?꾨━???좉툑)

---

## 6. Phase K ??Confidence Calibration (?좊ː??蹂댁젙)

**紐⑺몴**: LLM ?묐떟??遺덊솗?ㅼ꽦???뺣웾?뷀븯怨? ??? ?좊ː??寃곗젙? ?먮룞 異뺤냼?쒕떎.

### 6.1 ?좏샇??

---

## 7. Phase L ??Strategy Lifecycle Manager (?꾨왂 ?섎챸二쇨린)

**紐⑺몴**: ?꾨왂??*?꾩깮遺????닿퉴吏* ?꾩쟾 ?먮룞?? LLM???꾨왂 ?꾩씠?붿뼱 ?앹꽦 ??寃利????먯쭊??諛고룷 ???깃낵 紐⑤땲?곕쭅 ???먮룞 ???

### 7.1 ?곹깭 癒몄떊

```
   [DISCOVERY]         [INCUBATION]         [PRODUCTION]         [RETIREMENT]
   LLM ?꾩씠?붿뼱   ??  諛깊뀒?ㅽ듃+WF OOS  ??  ?뚯븸 ?쇱씠釉? ??  洹쒕え?? ??  ?깃낵 ?섎씫  ?? ?꾩뭅?대툕
       ??                  ??reject              ??reject             ??
    ?먭린(0??          ?먭린 濡쒓렇           shadow revert         ???寃곗젙
```

### 7.2 紐⑤뱢 API

```js
// src/strategy/lifecycle.js
createLifecycleManager({
  proposeStrategy(llmContext) ??{ id, name, logic, hypothesis },
  validate(strategyId) {
    // 1) Phase H walk-forward OOS
    // 2) Phase F VaR ?쒕??덉씠??
    // 3) Phase B council 李щ컲 ?ы몴
    return { verdict: 'promote|reject|shadow', score };
  },
  promote(strategyId, phase) {
    // paper ??10% ??50% ??100% (Phase E orchestrator 媛以묒튂 媛깆떊)
  },
  retire(strategyId, reason) {
    // 30??rolling Sharpe < threshold OR 理쒕? ?쒕줈?ㅼ슫 > 1.5횞 ?쒕룄
  },
});
```

### 7.3 ????몃━嫄?

| 吏??| ?꾧퀎媛?| 議곗튂 |
|------|--------|------|
| 30??Sharpe | < 0.0 | shadow 紐⑤뱶 ?꾪솚 |
| 60??Sharpe | < 0.2 | ?꾩쟾 ??? ?먮낯 ?щ같遺?|
| Max DD | > strategy ?덉슜移섏쓽 1.5횞 | 利됱떆 killswitch + ???|
| ?밸쪧 | 理쒓렐 50 ?몃젅?대뱶 < 35% | Phase D evolution???ы븰???붿껌 |

### 7.4 媛먯궗

- `strategy-history.jsonl`: 紐⑤뱺 ?꾨왂???꾩깮/????깃낵 湲곕줉
- ?????LLM??"????댁쑀"瑜??꾨＼?꾪듃濡??ъ＜?????ㅼ쓬 ?꾨왂 ?앹꽦 ???숈뒿

---

## 8. Phase M ??Cross-Market Arbitrage (援먯감 ?쒖옣 李⑥씡)

**紐⑺몴**: ?숈씪 ?먯궛???ㅼ쨷 ?쒖옣 媛寃?李⑥씠瑜?媛먯??섍퀬, 由ъ뒪???ㅼ? ?먮뒗 李⑥씡 ?ㅽ쁽???쒖슜.

### 8.1 媛먯? ???

| ??| ?쒖옣 A | ?쒖옣 B | 湲고쉶 |
|----|--------|--------|------|
| ?쇱꽦?꾩옄 | KRX 005930 | LSE GDR / OTC ADR | ?섏쑉 議곗젙 ???ㅽ봽?덈뱶 |
| ?뚯뒳??| NASDAQ TSLA | FRA TSLA.DE / HKEX 9868 | FX + 嫄곕옒鍮꾩슜 議곗젙 |
| 鍮꾪듃肄붿씤 | Binance | Upbit | 源移섑봽由щ???(愿李곕쭔, ?ㅽ뻾? 洹쒖젣 寃???? |

### 8.2 紐⑤뱢


**Completed: 2026-10-12**

| 파일 | 내용 | 라인 | 비고 |
|--------|---------|------|------|
| `cross-market.js` | Factory + pair mgmt + scan + state | 340 | 구현 완료 |
| `test-cross-market.js` | 26 test cases | 504 | 26/26 pass |
| `index.js` | Exports wired | 2 | createCrossMarketScanner, CROSS_MARKET_DEFAULTS |
| `README.md` | Phase M section | ~85 | Full docs |

**구현 함수:**
- `registerPair(pair)` / `removePair(id)` / `listPairs()`: 페어 관리
- `scan()`: 활성 페어 전수 스캔, Promise.all 병렬, 에러 격리
- `computeSpread(pair)`: 단일 페어 FX-adjusted spread 계산
- `getHistory(limit?)`: 스캔 히스토리 (FIFO, maxHistorySize 캡)
- `stats()`: scans/opportunities/errors/lastScanAt 카운터
- `state()` / `restore(snap)` / `reset()`: 상태 영속화

**테스트 커버리지 (26 tests):**
- DEFAULTS, bps helper (3), pair management (5), scan empty/A_TO_B/B_TO_A/below-threshold
- FX+ADR normalization, error isolation, timeout, callbacks, stats, history+cap
- state/restore/reset, null-restore, inactive skip, missing feed, invalid price, missing fx

**Wired into runner.js: 2026-10-12**

| Integration Point | Lines | Description |
|-------------------|-------|-------------|
| Factory init | ~850-890 | `createCrossMarketScanner()` with env-driven config, `onOpportunity`/`onError` callbacks |
| Periodic scan timer | ~935-950 | `setInterval` at `CROSS_MARKET_SCAN_INTERVAL_MS` (default 60s) |
| Health endpoint | `/health` | `crossMarket: { enabled, ...stats() }` |
| HTTP endpoint | `/cross-market` | stats + listPairs + recentHistory(30) |
| State dump | `dumpRunnerState()` | `crossMarket: scanner.state()` |
| State restore | restore block | `scanner.restore(raw.crossMarket)` |
| Cross-phase → Phase N | `onOpportunity` | High-value opps (>=2x threshold) escalate to human |

**환경 변수:**
- `CROSS_MARKET_ENABLED` (default `false` — multi-broker not yet provisioned)
- `CROSS_MARKET_THRESHOLD_BPS` (default 50)
- `CROSS_MARKET_COST_BPS` (default 10)
- `CROSS_MARKET_SCAN_INTERVAL_MS` (default 60000)
- `CROSS_MARKET_FETCH_TIMEOUT_MS` (default 5000)
- `CROSS_MARKET_MAX_HISTORY` (default 1000)

---

## 9. Phase N ??Human Escalation Protocol (?묐갑???멸컙 ?먯뒪而щ젅?댁뀡)

**紐⑺몴**: 寃쎄퀎 ?곹솴?먯꽌 ?멸컙?먭쾶 *留λ씫 + ?좏깮吏 + 異붿쿇 ?됰룞*???꾨떖?섍퀬, ?묐떟???쒖뒪???곹깭??諛섏쁺.

### 9.1 ?⑤갑??vs ?묐갑??

| ?④퀎 | ?꾩옱 (L3) | 紐⑺몴 (L4.5) |
|------|----------|-------------|
| ?뚮┝ | Telegram "killswitch 諛쒕룞" | "killswitch 諛쒕룞. ?댁쑀: DATA_DRIFT 3?곗냽. ?좏깮吏: (1) 1h 愿留?(2) shadow 蹂듦? (3) ?꾩쟾 ?뺤?. 異붿쿇: (1)" |
| ?낅젰 | ??| Telegram reply ??command parser ???곹깭 ?꾩씠 |
| 留λ씫 | ??| 理쒓렐 5 寃곗젙, regime, VaR, 硫뷀??몄? ?먯닔 泥⑤? |

### 9.2 ?꾨줈?좎퐳

```js
// src/orchestrator/escalation.js
createEscalationManager({
  channels: ['telegram', 'discord', 'email'],
  
  escalate(ctx) {
    const message = renderTemplate(ctx.template, {
      severity: ctx.severity,       // info|warn|critical
      summary: ctx.summary,         // 1臾몄옣 ?붿빟
      context: ctx.bullets,         // 3~5媛??듭떖 ?섏튂
      options: ctx.options,         // [{id, label, recommended}]
      timeout: ctx.timeout,         // 臾댁쓳????湲곕낯 ?됰룞
    });
    return sendAndWait(message, ctx.timeout);
  },
  
  onResponse(escalationId, optionId) {
    // ?좏깮??audit 濡쒓렇 + ?곹깭 ?꾩씠??諛섏쁺
  },
  
  onTimeout(escalationId) {
    // 蹂댁닔??湲곕낯媛??곸슜 (蹂댄넻 "愿留? ?먮뒗 "shadow 蹂듦?")
  },
});
```

### 9.3 ?먯뒪而щ젅?댁뀡 ?몃━嫄?

| ?곹솴 | ?ш컖??| ??꾩븘??| 湲곕낯 ?됰룞 |


**Completed: 2026-10-12**

| 파일 | 내용 | 라인 | 비고 |
|--------|---------|------|------|
| `src/orchestrator/escalation.js` | Factory + escalate + respond + queries + state | 414 | 구현 완료 |
| `tests/test-escalation.js` | 32 test cases | 537 | 32/32 pass |
| `index.js` | Exports wired | 3 | createEscalationManager, ESCALATION_DEFAULTS, ESCALATION_SEVERITIES |
| `README.md` | Phase N section | ~80 | Full docs |

**구현 함수:**
- `escalate(ctx)`: 다중 채널 브로드캐스트 + 일일 한도 + 쿨다운 + 타임아웃 타이머
- `respond(escalationId, optionId)`: 인간 응답 처리, 타이머 취소, optionId 검증
- `getPending()` / `getHistory(limit)` / `stats()`: 조회 API
- `state()` / `restore(snap)` / `reset()`: 상태 영속화 (reset은 활성 타이머 모두 정리)
- `renderTemplate(ctx)`: severity/summary/bullets/options/timeout 포맷팅 (`_internals`)

**핵심 동작:**
- Severity: `info` / `warn` / `critical` (SEVERITIES 배열)
- Timeout fallback: `default` (recommended) / `safest` (last) / `none` (null) / explicit `fallbackOptionId`
- Rejection reasons: `disabled`, `daily_limit`, `cooldown`
- Channel error isolation: 한 채널 실패가 다른 채널 차단하지 않음 (`dispatchResults[]`)
- Daily limit: 자정(KST) 기준 리셋, `countForToday()` / `incrementToday()`
- Cooldown: `cooldownKey`별 독립 관리

**테스트 커버리지 (32 tests):**
- DEFAULTS, SEVERITIES, renderTemplate (2), escalate validation (4), dispatch + multi-channel
- Channel error isolation, respond happy path, respond unknown optionId, respond double-resolve
- Respond missing id, daily limit + remainingToday, cooldown per-key + cross-key isolation
- Timeout fallback default/safest/none/explicit, respond cancels timeout
- Disabled state, audit trail, stats counters, getHistory + FIFO cap
- State/restore persistence, reset, null-restore safety, getPending filtering, metadata passthrough

**Wired into runner.js: 2026-10-12**

| Integration Point | Lines | Description |
|-------------------|-------|-------------|
| Factory init | ~893-932 | `createEscalationManager()` with telegram channel + env config |
| Health endpoint | `/health` | `escalation: { enabled, ...stats() }` |
| HTTP GET | `/escalation` | stats + getPending + recentHistory(30) |
| HTTP POST | `/escalation/respond` | `{escalationId, optionId}` → `em.respond()` |
| State dump | `dumpRunnerState()` | `escalation: em.state()` |
| State restore | restore block | `em.restore(raw.escalation)` |
| ← Phase C killswitch | `onHalt` callback | Critical escalation with acknowledge/shadow/abort options |
| ← Phase J self-healer | `onEscalation` callback | Critical escalation when auto-mitigations exhausted |
| ← Phase M cross-market | `onOpportunity` callback | Info escalation for high-value (>=2x threshold) arbs |

**환경 변수:**
- `ESCALATION_ENABLED` (default `true`)
- `ESCALATION_DAILY_LIMIT` (default 3)
- `ESCALATION_DEFAULT_TIMEOUT_MS` (default 14400000 = 4h)
- `ESCALATION_TIMEOUT_FALLBACK` (default `"default"`)
- `ESCALATION_COOLDOWN_MS` (default 300000 = 5min)
- `ESCALATION_MAX_HISTORY` (default 500)

---

## 10. ?듯빀 ?꾪궎?띿쿂: L4.5 Self-Awareness Layer

```
?뚢????????????????????????????????????????????????????????????????????????
??                    HUMAN ESCALATION (Phase N)                       ??
??             Telegram/Discord ???묐갑????媛먯궗 濡쒓렇                   ??
?쒋????????????????????????????????????????????????????????????????????????
??                                                                     ??
?? ?뚢??????????????? ?뚢??????????????? ?뚢??????????????? ?뚢????????????????
?? ??Meta-Cogn.  ?? ??Confidence  ?? ?괪elf-Healing ?? ??Strategy   ????
?? ??  (I)       ?? ??  (K)       ?? ??  (J)       ?? ??Lifecycle  ????
?? ??            ?? ??            ?? ??            ?? ??  (L)      ????
?? ??寃곗젙 ?덉쭏   ?귘넂???좊ː??蹂댁젙 ?귘넂???ㅽ뙣 遺꾨쪟   ?귘넂???앹꽦?믪??? ????
?? ???먯닔??     ?귘넀??logprobs    ?귘넀???먮룞 ???  ?귘넀??OOS 寃利?  ????
?? ?붴???????р???????? ?붴???????р???????? ?붴???????р???????? ?붴??????р??????????
??        ??               ??               ??              ??        ??
?? ?뚢???????닳?????????????????닳?????????????????닳????????????????닳???????? ??
?? ??             Cross-Market Scanner (Phase M)                   ?? ??
?? ??        KRX ??LSE GDR / NASDAQ ??FRA / Binance ??Upbit      ?? ??
?? ?붴????????????????????????????р????????????????????????????????????? ??
??                             ??                                      ??
?쒋???????????????????????????????쇄?????????????????????????????????????????
??             Phase A~H 湲곕컲 (湲곗〈 ?듯빀 紐⑤뱢)                        ??
?? ?뚢????????р????????р????????р????????р????????р????????р????????р????????? ??
?? ?? A    ?? B    ?? C    ?? D    ?? E    ?? F    ?? G    ?? H    ?? ??
?? ?괞ntel. ?괖ounc. ?괪hadow ?괙vol.  ?괪trat. ?괯aR    ?괝MM    ?괰alk   ?? ??
?? ?괦ipe.  ??Sim.  ??Kill  ?괛A     ?괔lloc. ?괖VaR   ?괨egime ?괚wd.   ?? ??
?? ?붴????????닳????????닳????????닳????????닳????????닳????????닳????????닳????????? ??
??                             ??                                      ??
?쒋???????????????????????????????쇄?????????????????????????????????????????
??                   runner.js ?ㅼ??ㅽ듃?덉씠??                         ??
?? Toss API ??WS/REST ??Order Manager ??Position Sizer ??Audit      ??
?붴????????????????????????????????????????????????????????????????????????
```

### 10.1 ?곗씠???먮쫫

```
?쒖옣 ?곗씠???섏떊
    ??
    ?쒋????[Phase G] HMM regime 異붾줎
    ?쒋????[Phase A] Intelligence pipeline (?댁뒪쨌媛먯꽦쨌留ㅽ겕濡?
    ?쒋????[Phase M] Cross-market ?ㅼ틪
    ??
    ??
AI 寃곗젙 ?붿껌 (LLM)
    ??
    ?쒋????[Phase K] Confidence calibration (logprobs/sampling)
    ?쒋????[Phase B] Council ?⑹쓽 + ?쒕굹由ъ삤 ?쒕??덉씠??
    ?쒋????[Phase I] Meta-cognition ?먯닔??
    ??
    ??
寃곗젙 ?덉쭏 寃뚯씠??
    ??
    ?쒋?? metaScore < threshold ??[Phase J] DATA_DRIFT or [Phase N] ?먯뒪而щ젅?댁뀡
    ?쒋?? confidence < 0.40 ???ъ????ъ씠利?75% 異뺤냼
    ?쒋?? walk-forward reject ??[Phase J] PARAM_STALE ??吏꾪솕 ?ъ떎??
    ??
    ??
?ㅽ뻾
    ??
    ?쒋????[Phase C] Shadow mode 鍮꾧탳 + killswitch ?뺤씤
    ?쒋????[Phase F] VaR budget ?먭?
    ?쒋????[Phase E] Strategy orchestrator ?먮낯 諛곕텇
    ??
    ??
?ы썑 愿由?
    ??
    ?쒋????[Phase I] 寃곌낵 泥⑤? (PnL, hold bars)
    ?쒋????[Phase L] ?꾨왂 ?깃낵 異붿쟻 ??????먯젙
    ?쒋????[Phase J] ?ㅽ뙣 ?⑦꽩 媛먯? ???먮룞 ???
    ?쒋????[Phase H] 二쇨린??OOS ?ш?利?(24h)
```

### 10.2 紐⑤뱢 ?섏〈??
| Module | Activation Trigger | Deactivation Condition |
|--------|-------------------|------------------------|
| **Phase I: Meta-Cognition** | Always-on when `META_COG_ENABLED=true` | Disabled if metaScore consistently > 0.8 for 500+ decisions (low value-add) |
| **Phase K: Confidence Calibration** | Always-on when LLM provides logprobs | Falls back to uniform confidence if LLM sampling unavailable |
| **Phase J: Self-Healing** | Always-on; auto-triggers on incident classification | Manual override via `/self-healing/pause` endpoint |
| **Phase L: Strategy Lifecycle** | Activates when >= 3 strategies in production | Disabled in single-strategy mode or shadow-only mode |
| **Phase M: Cross-Market Scanner** | Periodic timer (`CROSS_MARKET_INTERVAL_MS`, default 5min) | Disabled if `CROSS_MARKET_ENABLED=false` or API quota exhausted |
| **Phase N: Human Escalation** | Always-on; triggers on severity >= threshold | Never auto-disables; manual acknowledgment required |
| **Constitution Loader** | Loads once at startup from `constitution.yaml` | Falls back to hard-coded defaults if file missing or parse error |

**Selection Logic:**
- All L4.5 modules are **opt-in via environment variables** (default: enabled)
- Modules degrade gracefully: if dependencies fail, they log warnings and use fallback behavior
- No module can be disabled if it enforces **constitutional constraints** (killswitch, approval gates, risk limits)
- Cross-phase escalation paths (Phase M/N, Phase J/N) remain active even if source module is paused
---

## 11. 援ы쁽 ??꾨씪??

### 11.1 留덉씪?ㅽ넠 (15二?

```
Week 1-2:  Phase I (Meta-Cognition)
           ?붴? 寃곗젙 ?덉쭏 ?먯닔??+ ?듦퀎 紐⑤뱢
           ?붴? runner.js ?듯빀 (寃곗젙 湲곕줉 ??
           ?붴? ?뚯뒪?? test-meta-cognition.js (??5 tests)

Week 3-4:  Phase K (Confidence Calibration)
           ?붴? logprobs/sampling 湲곕컲 ?좊ː??異붿젙
           ?붴? ?ъ????ъ씠利?蹂댁젙 濡쒖쭅
           ?붴? ?뚯뒪?? test-confidence.js (??2 tests)

Week 5-6:  Phase J (Self-Healing)
           ?붴? ?ㅽ뙣 ?좏삎 遺꾨쪟湲?+ ????꾨왂 留?
           ?붴? cooldown + ?곹깭 蹂듭썝
           ?붴? ?뚯뒪?? test-self-healing.js (??0 tests)

Week 7-8:  Phase L (Strategy Lifecycle)
           ?붴? ?곹깭 癒몄떊 (discovery?뭝ncubation?뭦roduction?뭨etirement)
           ?붴? LLM ?꾨왂 ?앹꽦 + ?먮룞 寃利??뚯씠?꾨씪??
           ?붴? ?뚯뒪?? test-lifecycle.js (??8 tests)

Week 9-10: Phase M (Cross-Market Scanner)
           ?붴? 媛寃?鍮꾧탳 ?붿쭊 + FX 議곗젙
           ?붴? ?뚮┝ ?꾩슜 (?ㅽ뻾? ?ㅼ쨷 釉뚮줈而??곕룞 ??
           ?붴? ?뚯뒪?? test-cross-market.js (??0 tests)

Week 11-12: Phase N (Human Escalation)
           ?붴? Telegram ?묐갑???꾨줈?좎퐳
           ?붴? ??꾩븘??+ 蹂댁닔??湲곕낯媛?
           ?붴? ?뚯뒪?? test-escalation.js (??4 tests)

Week 13-14: ?듯빀 ?뚯뒪??+ ?덉젙??
           ?붴? ?꾩껜 6媛?Phase ?곕룞 ?쒕굹由ъ삤 ?뚯뒪??
           ?붴? Shadow mode ?κ린媛?寃利?(7??
           ?붴? ?깅뒫 踰ㅼ튂留덊겕 (?ㅻ쾭?ㅻ뱶 < 5%)

Week 15:    L4.5 議몄뾽 ?ъ궗
           ?붴? 짠13 ?깃났 湲곗? ?ъ꽦 ?뺤씤
           ?붴? 臾몄꽌??+ 媛먯궗 濡쒓렇 寃??
```

### 11.2 蹂묐젹 ?묒뾽 媛?μ꽦

```
Stage 1: SHADOW VALIDATION (Week 1-2)
  Gate: Constitution loader active, all modules initialized
  Scope: All phases run in shadow mode; no real orders submitted
  Metrics: Collect Spearman correlation (predicted vs actual PnL)
  Exit: Spearman >= 0.3 AND zero constitution violations for 7 days
  Rollback: Any killswitch trigger extends shadow by 7 days

Stage 2: PAPER TRADING (Week 3-4)
  Gate: Stage 1 exit criteria met + council consensus >= 0.6 on 90% of decisions
  Scope: Real API calls, simulated fills with realistic slippage model
  Capital: 0 KRW (paper only); constitution risk_limits enforced
  Metrics: Win rate, Sharpe ratio, max drawdown, approval gate response time
  Exit: Sharpe >= 1.0 AND max drawdown < daily_max_loss_pct * 0.5
  Rollback: Drawdown > 50% of limit -> return to Stage 1

Stage 3: LIMITED LIVE (Week 5-8)
  Gate: Stage 2 exit criteria met + human approval via /escalation/respond
  Scope: Live orders with strict position caps
  Capital: 10% of target allocation (max_single_order_krw * 0.1)
  Constraints: max_open_positions = 5, max_total_exposure_pct = 30%
  Metrics: Real fill rates, latency, slippage vs paper model
  Exit: 4 weeks of positive Sharpe AND < 5% slippage deviation
  Rollback: Any killswitch trigger OR 3 consecutive losses -> Stage 2

Stage 4: GRADUATED SCALING (Week 9-12)
  Gate: Stage 3 exit criteria met + weekly council review approval
  Scope: Progressive capital increase
  Schedule:
    Week 9-10:  25% of target allocation, max_open_positions = 8
    Week 11:    50% of target allocation, max_open_positions = 12
    Week 12:    100% of target allocation, all constitution limits active
  Metrics: Full performance dashboard + Spearman stability
  Exit: Sustained performance for 4 weeks at full allocation
  Rollback: Any stage regression > 20% -> step back one stage

Stage 5: FULL AUTONOMY (Week 13+)
  Gate: Stage 4 exit criteria met + 30-day incident-free operation
  Scope: Full L4.5 autonomous operation
  Safeguards: All constitution rules active, daily reporting, weekly council review
  Monitoring: Real-time alerts for killswitch, approval gates, regime changes
  Evolution: Self-modification enabled within constitution bounds
```

**Rollback Protocol:**
 - Any killswitch trigger -> immediate halt + 24h cooldown + human approval
 - Constitution violation -> immediate position reduction to prior stage limits
 - Spearman correlation < 0.2 for 3 consecutive days -> stage regression
 - Human override via `/escalation/respond` with `abort` option -> full liquidation

```

---

## 12. 由ъ뒪??& ?꾪솕 ?꾨왂

| 由ъ뒪??| ?뺣쪧 | ?곹뼢 | ?꾪솕 |
|--------|------|------|------|
| LLM logprobs API 誘몄???| ?믪쓬 | Phase K ?뺥솗?????| Sampling 遺꾩궛(n=3) + council ?⑹쓽?꾨줈 ?泥?|
| Meta-cognition ?먯닔-PnL ?곴? ?ㅽ뙣 | 以묎컙 | Phase I ?좊ː???섎씫 | 100 寃곗젙留덈떎 媛以묒튂 ?먮룞 ?ы븰??|
| Self-healing 臾댄븳 猷⑦봽 | ??쓬 | ?쒖뒪??遺덉븞??| cooldown + ?숈씪 ?좏삎 3???꾩쟻 ??Phase N ?먯뒪而щ젅?댁뀡 |
| Strategy lifecycle 怨쇱쟻??| 以묎컙 | ?덉쐞 ?꾨왂 ?묒궛 | Phase H walk-forward + Phase B council ?댁쨷 寃뚯씠??|
| Cross-market false positive | ?믪쓬 | 遺덊븘?뷀븳 ?뚮┝ ??쬆 | thresholdBps ?숈쟻 議곗젙 (30???대룞?됯퇏 ?ㅽ봽?덈뱶 湲곕컲) |
| Escalation ?쇰줈 (?뚮┝ 怨쇰떎) | 以묎컙 | ?멸컙 ?묐떟瑜????| severity ?꾪꽣留?+ ?섎（ 理쒕? 3嫄??쒗븳 |
| Phase A~H 紐⑤뱢 regression | ??쓬 | ?꾩껜 ?쒖뒪??遺덉븞??| 留?Phase ?꾨즺留덈떎 553??50 tests ?꾩쟾 ?ъ떎??|
| Toss API ?ㅽ럺 蹂寃?| 以묎컙 | ?щ줈?ㅻ쭏耳??먯뒪而щ젅?댁뀡 ?⑥젅 | API 踰꾩쟾 紐⑤땲?곕쭅 + adapter fallback |

---

## 13. L4.5 議몄뾽 湲곗? (Graduation Criteria)

?꾨옒 議곌굔??**紐⑤몢** 異⑹”?섎㈃ Level 4.5 ?ъ꽦?쇰줈 ?먯젙?쒕떎.

### 13.1 ?뺣웾 吏??

| # | 吏??| 紐⑺몴 | 痢≪젙 諛⑸쾿 |
|---|------|------|----------|
| 1 | Meta-cognition ?먯닔-PnL Spearman ? | ??0.35 | 100 寃곗젙 ?꾩쟻 ??|
| 2 | Confidence ECE (Expected Calibration Error) | < 0.05 | 200 ?섑뵆 ?꾩쟻 ??|
| 3 | Self-healing ?먮룞 蹂듦뎄??| ??80% | incident ?鍮?human escalation 鍮꾩쑉 |
| 4 | Strategy lifecycle ?뚯쟾??| ??1 ?꾨왂/???먮룞 ???| 3媛쒖썡 愿李?|
| 5 | Cross-market 媛먯? 吏??| < 90珥?| p95 latency |
| 6 | Escalation ?묐떟瑜?| ??70% | timeout ?鍮?human response 鍮꾩쑉 |
| 7 | ?꾩껜 ?쒖뒪???ㅻ쾭?ㅻ뱶 | < 5% CPU/memory | Phase A~H ?鍮?|
| 8 | ?뚯뒪??而ㅻ쾭由ъ? | ??650 tests, 0 failures | `node --test tests/*.js` |

### 13.2 ?뺤꽦 吏??

---

## 14. minitok ?앺깭怨??곌퀎

### 14.1 minitok-client-release (v1.5.2) ?쒖슜

| minitok 湲곕뒫 | L4.5 ?쒖슜 |
|-------------|----------|
| Goal Agent (`goal-agent`) | Phase L ?꾨왂 ?앹꽦 ??紐⑺몴 ?뺣젹 寃利?|
| Discovery Pipeline | Phase A intelligence 蹂댁“ ?곗씠???뚯뒪 |
| MCP Tools (read/search/execute) | Phase N ?먯뒪而щ젅?댁뀡 ??而⑦뀓?ㅽ듃 ?먮룞 ?섏쭛 |
| Constitution (constitution.yaml) | Phase B council ?ы몴 ???뚮쾿 以???먭? |

### 14.2 minitok-server-deploy (v0.1.0) ?쒖슜

| ?쒕쾭 湲곕뒫 | L4.5 ?쒖슜 |
|----------|----------|
| Remote MCP | Phase M cross-market ?곗씠??吏묎퀎 (?ㅼ쨷 ?몃뱶) |
| Audit Store | Phase I~N ??紐⑤뱢 媛먯궗 濡쒓렇 以묒븰 吏묒쨷??|
| Model Registry | Phase K ?좊ː??蹂댁젙 ??紐⑤뜽 踰꾩쟾蹂?logprobs ?뱀꽦 愿由?|

### 14.3 ?뺤옣 寃쎈줈

```
L4.5 議몄뾽
    ??
    ?쒋????Binance Adapter 異붽? ??Phase M ?ㅽ뻾 ?쒖꽦??(crypto 24/7)
    ?쒋????IBKR Adapter 異붽? ??Phase M 湲濡쒕쾶 李⑥씡 ?ㅽ뻾
    ?쒋????Multi-Account ??Phase L ?꾨왂??怨꾩젙蹂꾨줈 李⑤벑 諛고룷
    ??
    ??
Level 5 (Full Autonomy) 吏꾩엯
```


---

## 부록 A: 환경 변수 요약 (Phase I~N)

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `META_COGNITION_ENABLED` | `true` | Phase I 마스터 스위치 |
| `META_COG_THRESHOLD` | `0.55` | 저품질 결정 판정 기준 |
| `META_COG_RECALIBRATE_EVERY` | `100` | 가중치 재학습 주기 (결정 수) |
| `SELF_HEALING_ENABLED` | `true` | Phase J 마스터 스위치 |
| `HEALING_MAX_INCIDENTS_PER_HOUR` | `5` | 시간당 최대 incident 처리 수 |
| `CONFIDENCE_ENABLED` | `true` | Phase K 마스터 스위치 |
| `CONFIDENCE_SAMPLE_COUNT` | `3` | LLM 샘플링 횟수 |
| `CONFIDENCE_MIN_THRESHOLD` | `0.40` | 이하면 포지션 75% 축소 |
| `LIFECYCLE_ENABLED` | `true` | Phase L 마스터 스위치 |
| `LIFECYCLE_MIN_SHARPE` | `0.2` | 전략 유지 최소 Sharpe |
| `CROSS_MARKET_ENABLED` | `false` | Phase M (다중 브로커 준비 전 기본 off) |
| `CROSS_MARKET_THRESHOLD_BPS` | `50` | 차익 감지 임계값 (basis points) |
| `ESCALATION_ENABLED` | `true` | Phase N 마스터 스위치 |
| `ESCALATION_DAILY_LIMIT` | `3` | 일일 최대 에스컬레이션 수 |
| `ESCALATION_DEFAULT_TIMEOUT_MS` | `14400000` | 무응답 타임아웃 (4시간) |

---

## 부록 B: 파일 구조 (예상)

```
minitok-addon-tossinvest/
├── src/
│   ├── intelligence/
│   │   ├── pipeline.js          (기존 - Phase A)
│   │   ├── trading-memory.js    (기존 - Phase A)
│   │   ├── meta-cognition.js    (신규 - Phase I)
│   │   └── cross-market.js      (신규 - Phase M)
│   ├── ai/
│   │   ├── provider-router.js   (기존)
│   │   └── confidence.js        (신규 - Phase K)
│   ├── orchestrator/
│   │   ├── evolution.js         (기존 - Phase D)
│   │   ├── walk-forward.js      (기존 - Phase H)
│   │   ├── killswitch.js        (기존 - Phase C)
│   │   ├── shadow-mode.js       (기존 - Phase C)
│   │   ├── approval-gate.js     (기존 - Phase C)
│   │   ├── self-healing.js      (신규 - Phase J)
│   │   └── escalation.js        (신규 - Phase N)
│   ├── strategy/
│   │   ├── orchestrator.js      (기존 - Phase E)
│   │   ├── regime-hmm.js        (기존 - Phase G)
│   │   ├── registry.js          (기존)
│   │   └── lifecycle.js         (신규 - Phase L)
│   └── risk/
│       ├── var-engine.js        (기존 - Phase F)
│       └── portfolio-risk.js    (기존 - Phase F)
├── tests/
│   ├── test-meta-cognition.js   (신규 - ~15 tests)
│   ├── test-self-healing.js     (신규 - ~20 tests)
│   ├── test-confidence.js       (신규 - ~12 tests)
│   ├── test-lifecycle.js        (신규 - ~18 tests)
│   ├── test-cross-market.js     (신규 - ~10 tests)
│   ├── test-escalation.js       (신규 - ~14 tests)
│   └── ... (기존 553 tests 유지)
├── runner.js                    (Phase I~N 훅 추가)
├── goals.json                   (기존)
├── minitok.yml                  (기존)
└── L45_IMPLEMENTATION_PLAN.md   (본 문서)
```

---

*문서 버전: 1.0 | 최종 업데이트: 2026-10-12*

