# JPY 환율 버그 분석 — `JPY=9`

**작성일:** 2026-10-14
**증상:** `[fx] Cached rates: USD=1336.64, JPY=9`
**조사 방법:** 실세션 라이브 프로빙 (실제 OpenAPI 토큰 + 실제 계좌 holdings)

---

## 결론 (먼저)

**JPY=9는 파싱 버그가 아니다. API가 JPY를 원천 거부하기 때문에 값이 갱신되지 못하고
폴백 기본값 `9`가 그대로 남아있는 것이다.** 그리고 이 값은 **현재 실제로는 쓰이지 않는다**
(계좌에 JPY 자산이 없음). 다만 잠재적 함정은 남아 있다.

단위 혼동(100엔 vs 1엔) 가설은 **기각**한다. 근거는 아래 3절.

---

## 1. 코드 위치

`/app/runner.js` (컨테이너 기준, 라이브 정본)

| 행 | 내용 |
|---|---|
| **834** | `const cachedFxRates = { FX_USD_KRW: 1350, FX_JPY_KRW: 9 };` ← **폴백 하드코딩** |
| 836-853 | `refreshCachedFxRates()` — 시세 갱신 함수 |
| 848 | `cachedFxRates["FX_"+pair[0]+"_"+pair[1]] = rate;` — 갱신 지점 |
| 852 | `console.log("[fx] Cached rates: ...")` — 증상의 로그 |
| 856-857 | 15초 후 1회 + 30분 간격 갱신 스케줄 |
| 3050-3061 | `computeTotalEquityKrw()` — 실사용 지점 |

### 갱신 로직 원문 (836-853행)

```js
var pairs = [["USD","KRW"],["JPY","KRW"]];
for (var pair of pairs) {
  try {
    var r = await getExchangeRate(_fxToken, pair[0], pair[1]);
    var rawRate = r && r.body && (r.body.result && r.body.result.rate ? r.body.result.rate : r.body.rate);
    if (rawRate) {
      var rate = Number(rawRate);
      // Toss returns JPY rate per 100 units typically — detect and normalize
      if (pair[0] === "JPY" && rate < 50) rate = rate * 100;
      cachedFxRates["FX_" + pair[0] + "_" + pair[1]] = rate;
    }
  } catch (_fxp) { /* best-effort, keep stale */ }   // ← 실패가 완전히 묵살됨
}
```

**문제 1:** `catch (_fxp) { /* keep stale */ }` — JPY 호출이 실패해도 **아무 로그도 남기지 않는다**.
그래서 원인을 눈으로 볼 수 없었던 것이다.

---

## 2. JPY 데이터 소스 — 존재하지 않음

`src/tossinvest.js`의 `getExchangeRate()`:

```js
async function getExchangeRate(token, baseCurrency, quoteCurrency, dateTime) {
  const params = new URLSearchParams({ baseCurrency, quoteCurrency });
  if (dateTime) params.set("dateTime", dateTime);
  return tossRequest(`/api/v1/exchange-rate?${params.toString()}`, { method: "GET", token });
}
```

→ `GET /api/v1/exchange-rate?baseCurrency=JPY&quoteCurrency=KRW`

### 실제 API 응답 (라이브)

**USD (정상):**
```json
{"result":{"baseCurrency":"USD","quoteCurrency":"KRW","rate":"1346.42",
"midRate":"1345.92","basisPoint":"4","rateChangeType":"UP",
"validFrom":"2026-10-14T23:47:56.000+09:00","validUntil":"2026-10-14T23:52:55.000+09:00"}}
```

**JPY (거부):**
```json
{"error":{"requestId":"e50GK8vrbJiTe4Ti","code":"invalid-request",
"message":"지원하지 않는 통화입니다.",
"data":{"field":"baseCurrency","allowedValues":["KRW","USD"]}}}
```

### 화이트리스트 전수 확인

| baseCurrency | 결과 |
|---|---|
| USD | 200 `rate=1346.44` |
| KRW | 400 |
| **JPY** | **400 `allowedValues:[KRW,USD]`** |
| EUR / HKD / CNY / GBP / TWD | 전부 400 `allowedValues:[KRW,USD]` |

`quoteCurrency`도 `["KRW","USD"]`만 허용 → **양쪽 어디에도 JPY를 넣을 수 없다.**

따라서 **크로스레이트 우회(`USD/KRW ÷ USD/JPY`)도 불가능**하다.
`baseCurrency=USD&quoteCurrency=JPY` 역시 400.

---

## 3. 파싱 로직 — 단위 혼동 가설은 기각

의심의 코드:
```js
if (pair[0] === "JPY" && rate < 50) rate = rate * 100;   // "100엔 기준" 가정
```

**이 코드는 결코 실행된 적이 없다.** `rate`를 계산하기 전에 API가 400으로 거부하므로,
`rawRate`가 `undefined` → `if (rawRate)` 자체가 false → 해당 조건문에 도달하지 않는다.

**게다가 휴리스틱 자체가 틀렸다:**
- 실제 1엔 ≈ 9.03원 (1346.44 ÷ 149 ≈ 9.03)
- API가 JPY를 지원했다면 `rate` ≈ 9.03 (1엔 기준)
- 그런데 `9.03 < 50`이 참이므로 `× 100` → **903**으로 잘못 변환되었을 것
- 즉 이 코드는 의도와 **반대로** 동작한다

**결론:** 100엔 vs 1엔 혼동은 **없었다**. 혼동할 데이터 자체가 없다.

---

## 4. USD=1336.64는 같은 파서가 맞게 처리하는가

**예, 맞게 처리한다.** 파서는 동일하고 문제없다.

```
USD: rawRate="1346.42" → Number()=1346.42 → 휴리스틱 미적용(JPY 아님) → 1346.42  ✅
JPY: API 400            → rawRate=undefined → 갱신 스킵               → 9 (폴백)  ❌
```

USD가 정상이고 JPY만 9로 남는 이유는 **파서 차이가 아니라, 데이터 가용성 차이**다.
같은 파서가 JPY만 못 처리하는 게 아니라, **JPY는 처리할 데이터가 API에 존재하지 않는다.**

---

## 5. 실제 주문/손익 계산에 미치는 영향

### 사용 지점: `computeTotalEquityKrw()` (3050-3061행)

```js
function computeTotalEquityKrw(portfolio) {
  let total = portfolio.cashKrw || 0;
  for (const p of (portfolio.positions || [])) {
    var mv = p.marketValue || 0;
    if (p.currency && p.currency !== "KRW") {
      var fxKey = "FX_" + p.currency + "_KRW";
      var fxRate = (typeof globalThis !== "undefined" && globalThis[fxKey]) || cachedFxRates[fxKey] || 1;
      mv = mv * fxRate;                    // ← JPY면 ×9 (실제값의 1/100)
    }
    total += mv;
  }
  return total;
}
```

### 호출부 7곳 (모두 equity 파생)

| 행 | 용도 |
|---|---|
| 1574 | heldPositionSweep — equityKrw 로깅 |
| 1680 | heldPositionSweep — totalEquity |
| 2244 | portfolio context |
| 3107 / 3123 | sector exposure 검사 |
| 3729 | kill-switch equity 판정 |
| 4713 | 총 자산 계산 |

### 현재 실제 영향: **없음 (잠재적)**

라이브 계좌 확인:
```
holdings: QQQ currency=USD, SPY currency=USD     → JPY 없음
buying-power: KRW 200 / USD 200 (42187.14) / JPY 400 invalid-request
```

**토스 계좌에 JPY 자산/지갑이 존재하지 않는다.** `holdings[].currency`가 `JPY`가 될 수 없으므로
`fxKey = "FX_JPY_KRW"`는 현재 도달 불가 → **영향 0**.

### 영향이 현실이 되는 조건

`p.currency === "JPY"`인 포지션이 생기는 경우. 토스가 JPY 상장 종목(일본주식 직거래)이나
JPY 결제를 추가하는 날, 이 코드는 **조용히 equity를 1/100로 과소계산**한다:

- 100만 엔 어치 보유 → 90만 원으로 계산 (실제 903만 원)
- 3729행 kill-switch가 equity 급락으로 오인 → **불필요한 거래 중단 가능**
- 3107/3123행 sector exposure 비율 왜곡
- 1680행 cashRescueMode 판단 왜곡 → 이전에 논한 auto-exchange 분기로 유입

**가장 위험한 것은 `|| 1` 폴백이다.** 알 수 없는 통화(EUR 등)가 들어오면 fxRate=1이 되어
원화 환산 없이 그대로 더해진다. 이것도 조용히 실패한다.

---

## 6. 요약

| 항목 | 결론 |
|---|---|
| 원인 | **파싱 버그 아님.** API가 JPY를 `400 allowedValues:[KRW,USD]`로 거부 |
| 단위 혼동 (100엔/1엔) | **기각.** 데이터 자체가 없어 휴리스틱이 실행된 적 없음 |
| USD 정상 / JPY만 9인 이유 | 파서 차이 아니라 **데이터 가용성 차이** |
| 현재 실영향 | **없음.** 계좌에 JPY 자산 없음, 토스에 JPY 지갑 자체가 없음 |
| 잠재 영향 | JPY 포지션 발생 시 equity를 **1/100 과소계산** → kill-switch 오작동 위험 |

---

## 7. 권장 수선 (우선순위순)

1. **JPY 루프를 제거** — 지원하지 않는 통화를 30분마다 호출하며 실패를 묵살하고 있다.
   `pairs`를 `[["USD","KRW"]]`으로 축소.
2. **실패를 로그로 남긴다** — `catch (_fxp) {}`는 진단을 불가능하게 만든 근본 원인.
   최소 `console.warn("[fx] "+pair+" failed: ...")`.
3. **`|| 1` 폴백을 제거** — 미지 통화를 원화처럼 더하는 silent corruption.
   미지 통화는 스킵하거나 명시적 에러.
4. **폴백 상수를 명시적으로 표시** — `9`가 "현재값"인지 "기본값"인지 로그만으론 구분 불가.
   갱신 성공 여부를 플래그로 들고 있어야 한다.
5. (선택) JPY가 필요하면 **외부 환율 소스**를 별도로 붙여야 한다. 토스 OpenAPI로는 불가.

**주의:** 이 문서는 분석만 담는다. 코드 수정은 요청 시 별도 진행.
