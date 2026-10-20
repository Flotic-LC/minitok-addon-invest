# 자동 환전 (USD→KRW) — 현재 상태 및 blocker

**작성일:** 2026-10-14
**조사 방법:** 실세션으로 라이브 API 프로빙 (`minitok-invest` 컨테이너, 실제 UTK/OpenAPI 토큰)
**결론부터:** 자동 환전은 **현재 동작하지 않는다.** 두 경로 모두 막혀 있고, 기존 코드는 존재하지 않는 엔드포인트를 호출한다.

---

## 1. 결론 요약

| 경로 | 상태 | 증거 |
|---|---|---|
| 비공식 WTS API (`wts-cert-api`) | 라우트 존재, **바디 스키마 미확정** | POST → `400 {"error":{"statusCode":400,"code":null}}` |
| 공식 OpenAPI (`openapi.tossinvest.com`) | **엔드포인트 자체가 없음** | POST `/api/v1/exchange-orders` → `404 not-found` |
| 기존 `runner.js` auto-exchange 패치 | **존재하지 않는 경로 호출** | `createExchangeOrder()` → `/api/v1/exchange-orders` (404) |

---

## 2. 버그로 확정·수정한 것 (`src/toss_wts_exchange.js`)

아래 4건은 실제 라이브 응답으로 확인된 버그이며, 모두 수정 완료.

| # | 버그 | 근거 |
|---|---|---|
| 1 | **호스트 오류** — 주문을 `wts-api`(launcher)로 전송 → `404` | 앱 라우트 테이블(`_app-defa174fe05bb4ad.js`)이 `exchange-auto-orders`를 host **`cert`**로 매핑 |
| 2 | **쿠키 불충분** — `UTK=` 단독 전송 → `401 unauthenticated.session-expired` | 라이브 검증. 전체 쿠키 jar 필요 |
| 3 | **계좌키 형태 오류** — `result.accounts[0].key`를 찾음 | 실제로 `/api/v1/accounts`는 문자열 반환 (`{"result":"18501077497"}`) → `X-Tossinvest-Account`가 영구 미설정 |
| 4 | **시세 파라미터 오류** — `{amount,fromCurrency,toCurrency}` 전송 | 실제 계약은 `{buyCurrency,sellCurrency,checkBalance,sellAmount}` |

### 수정 후 라이브 검증 결과 (실제 세션)

```
[1] calculate/for-sell-amount → 200   token 발급, 1 USD = 1340 KRW
[2] exchange-auto-orders/histories → 200   (cert 호스트 — 수정 전 401)
[3] exchange-auto-orders → 200
[4] executeExchange(dryRun) → success: true
[5] executeExchange(LIVE) → 400, unresolvedSchema: true
```

즉 **인증·호스트·쿠키·시세는 모두 해결**되어 읽기 경로는 정상 동작한다.
남은 것은 주문 POST 바디 하나뿐이다.

---

## 3. Blocker A — WTS 주문 바디 스키마

`POST /api/v1/exchange-auto-orders`는 **존재한다** (cert → 400, launcher → 404).
그러나 요청 바디를 확정할 수 없다.

- `_buildManifest.js` 기준 **88개 청크 전수 스캔** → 해당 문자열은 **GET 라우트 레지스트리에만** 존재. POST 정의·호출부 없음.
- `pages/indices/exchange-rate-*.js` (3.2 KB)는 차트 셸일 뿐.
- **~130개 필드 조합** 브루트포스 → 전부 동일한 응답:
  `{"error":{"statusCode":400,"code":null,"message":null}}`
  - token 필드: `token`/`quoteToken`/`exchangeToken`/`calculationToken`/`calcToken`/`sellToken`/`quoteId`/`tokenId`/`exchangeId`
  - extras: `isSellAll`, `sellAmount`, `orderType`, `exchangeType`, `targetRate`+`targetRateType`, `agreeToTerms`, `accountKey` 등
  - token-as-query-param, PUT/PATCH 포함
- `GET /api/v1/exchange-quote-info/buffered-quote` → 모든 query 조합 400
- 서브패스(`/prepare`, `/execute` 등)는 전부 `[exchangeAutoOrderId]` 경로변수 라우트
  → `MethodArgumentTypeMismatchException`, 실제 엔드포인트 아님

**핵심 난점:** `code:null`은 프레임워크 레벨 바인딩 실패라, 어떤 필드가 맞는지
응답만으로 구분이 불가능하다. 추측으로 구분할 수 없는 구조.

**근본 원인:** 수동 환전 화면은 **모바일 앱 전용**이다. `tossinvest.com` 웹 번들에는
환전 실행 UI 자체가 없고(주식 주문만 존재), 따라서 바디 정의가 웹에 노출되지 않는다.

### 폰 캡처가 어려운 이유 (기존 제안 수정)

이전에 mitmproxy/HTTP Toolkit 캡처를 제안했으나, 이는 **비현실적**이다.
토스 앱은 SSL Pinning을 사용하여 루트 CA 체인을 거부한다. 우회하려면 루팅 +
Frida가 필요한데, 이는 개인 금융 앱 무결성 우회에 해당하므로 권장하지 않는다.
**따라서 이 경로는 사실상 막혀 있다.**

---

## 4. Blocker B — 공식 OpenAPI에도 없음 (오늘 추가 확인)

`minitok-addon-tossinvest/src/tossinvest.js`의 `createExchangeOrder()`는
`/api/v1/exchange-orders`를 호출한다. 실재 토큰으로 검증:

```
404  GET  /api/v1/exchange-orders     {"code":"not-found"}
404  GET  /api/v1/exchange-order
404  GET  /api/v1/exchanges
404  GET  /api/v1/exchange
404  GET  /api/v1/currency-exchange
404  GET  /api/v1/foreign-exchange
400  GET  /api/v1/exchange-rate       ← 존재. baseCurrency 파라미터 필요 (환율 조회 전용)
404  POST /api/v1/exchange-orders     ← 3가지 바디 모두 not-found
```

공식 스펙(v1.2.24, 41개 엔드포인트)에도 환전 주문이 없다.
`exchange-rate`는 **환율 조회**이지 환전 실행이 아니다.

---

## 5. 기존 코드의 위험 — 무음 실패 (정정 포함)

**정정:** 이전 구두 보고에서 "`createExchangeOrder`가 runner.js에 import조차 안 되어
있다"고 했으나 이는 **틀렸다**. 실제 라이브 코드(`/app/runner.js`)를 확인한 결과:

- **410행** — `createExchangeOrder`는 import되어 있다.
- **1638행** — `heldPositionSweep` 내 `cashRescueMode` 분기에서 **실제로 호출**된다.

```js
// /app/runner.js:1638
var exchangeResp = await createExchangeOrder(token, TOSS_ACCOUNT_SEQ, {
  baseCurrency: "USD",
  quoteCurrency: "KRW",
  amount: exchangeAmount,
});
if (exchangeResp.status === 200 || exchangeResp.status === 201) { ... }
else { console.warn("[auto-exchange] FAILED: status=..."); }
```

**문제:** 이 호출은 100% 404로 실패한다(존재하지 않는 경로). 그런데 실패 처리가
`console.warn` 한 줄뿐이라, **KRW 부족 상황이 조용히 무음 처리**된다.
잔고 부족으로 매수 타이밍을 놓치는 원인이 알림 없이 지나갈 수 있다.

참고로 앞서 검토한 `runner.js.bak.autoexchange`는 백업본이라 import 목록이 달랐고,
그걸 보고 잘못 판단했다. 라이브 파일이 정본이다.

---

## 6. `executeExchange()`의 현재 동작 계약

추측한 바디를 성공인 것처럼 보고하지 않는다:

```js
return {
  success: false,
  unresolvedSchema: true,          // ← balance/auth 오류와 구분
  error: "Order status 400 (CERT host)",
  hint: "POST body schema unknown — requires APK-level capture...",
  detail: {...},
  httpStatus: 400,
  attempt: {...},                  // 시도한 바디를 그대로 노출
};
```

- 주문 ID를 fabricate하지 않는다.
- 호출부가 잔고 부족으로 오인해 **재시도 루프를 돌리지 않도록** `unresolvedSchema` 플래그를 둔다.

---

## 7. 남은 선택지

| 선택지 | 실현 가능성 | 비고 |
|---|---|---|
| WTS 바디 캡처 | **사실상 불가** | SSL pinning + 루팅 필요 |
| 공식 OpenAPI 환전 | **없음** | 토스가 제공 안 함 (2026-10-14 기준) |
| **KRW 부족 알림** (권장) | **즉시 가능** | 자동 환전 대신 조건 발생 시 텔레그램 알림 → 수동 환전 유도 |
| 죽은 코드 정리 | 즉시 가능 | 404 호출 제거 또는 명시적 guard 추가 |

**권장:** 자동 환전은 API만으로 현재 막혀 있으므로, "환전 미지원"을 명시적으로
드러내고 KRW 부족 시 알림을 보내 수동 환전을 유도하는 쪽이 현실적이다.

---

## 8. 산출물

- `C:\Users\J1\toss_wts_exchange.js` — 4개 버그 수정, 서버 반영·구문검증 완료
- 본 문서 — 검증된 경로 / 수정 버그 / blocker / 해결법

임시 프로브 스크립트는 서버·로컬 모두 정리 완료.
