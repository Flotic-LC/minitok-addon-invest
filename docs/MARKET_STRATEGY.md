# Market Strategy — verified against the broker and the code

**Last verified: 2026-10-21.** Every statement below was checked against the
live Toss Securities Open API and the code in this repository, not against
the previous version of this document. Where the two disagreed, the code
was changed and this document was rewritten to match.

---

## 1. What the broker actually supports

Verified with live calls on 2026-10-21 (see `EXCHANGE_EXECUTION_NOTES.md`
for the FX probes and `docs/` for the endpoint inventory).

| Capability | Broker support | Enabled in code | Note |
|---|---|---|---|
| **US equities** — quotes, orderbook, daily candles, orders, conditional orders, fills, price limits, buying power, sellable quantity, commissions | **Yes** (Open API v1.2.24, 41 endpoints) | **Yes** | Prices arrive over the WebSocket (`trade:us`). The REST poll (`POLL_INTERVAL_MS`, default 45s) is the stale-feed fallback. |
| **US pre/post-market** | **No** — there is no extended-hours stream, and the session the broker prices is the regular session only | **No** | The regular session is 09:30–16:00 ET (`America/New_York`, DST-aware). The strategy calendar models exactly that. |
| **JP equities** | **No data collection.** The Open API does not price the Japanese market; the runner falls back to the broker's *average cost*, which is not a price | **No** (removed 2026-10-21) | JP symbols were in the tradable list and the watchlist while the bot could not observe them. They are now refused by the tradability gate and by the watchlist. |
| **KR equities** | n/a | **No** (removed 2026-10-21) | The Korean market was removed with its configuration. `detectMarket` still classifies a 6-digit symbol as KR so that it can be *refused*. |
| **FX order (KRW↔USD)** | **No order endpoint.** `POST /api/v1/exchange-orders` is a 404 and the Open API has no FX-order path. The unofficial WTS route exists but its POST body schema is unresolved (400 with `code:null`); only the mobile app can use it. | **No** | The read path works: `GET /api/v1/exchange-rate` and the FX order history. The earlier claim in this document that an FX order was impossible was correct; the *code* was the thing that drifted, by carrying an `createExchangeOrder` call with no working endpoint. That call is now explicitly marked `unresolvedSchema` and fails loudly. |
| **Crypto** | **No** | **No** | Not supported by the broker. |
| **Futures / options** | **No** | **No** | Not supported by the broker. |
| **WebSocket** | **Yes** — `trade:us` only | **Yes** | There is no `trade:jp` and no `trade:kr` stream. |
| **REST polling** | **Yes** | **Yes** | The fallback feed; its 45s interval is the worst-case staleness of a REST-priced signal. |

### Drift that was found and fixed

1. **The JP market was "tradable" but unobservable.** The runner has always
   logged *"Toss OpenAPI does not support JP data collection"* and then
   carried on with a broker-average-cost fallback. A fallback that is not a
   price cannot be spread against, ranked, or traded. JP is now refused
   before an order is formed, and JP symbols are refused by the watchlist.
2. **The FX order was documented as impossible but implemented as if it
   worked.** The code path is retained only as a loud, explicit failure.
3. **The Korean market was still described here after it had been removed
   from the code.** This document no longer describes it as active.
4. **The expansion roadmap below was unvalidated.** It is now a recorded
   decision, not a plan.

---

## 2. What the strategy is allowed to trade

A symbol reaches the order path only after it passes the **tradability
gate** (`src/agent/tradability.js`, called from the pre-trade path in
`runner.js`):

| Check | Rule | Why |
|---|---|---|
| Market is tradable | `TRADABLE_MARKETS` | Not negotiable. |
| Broker can price the market | `API_SUPPORTED_MARKETS = ["US"]` | A market the broker cannot observe cannot be traded. |
| Session is open | regular session, holidays and weekends excluded | A queued buy is a bet on the overnight gap, and the measured strategy lost more on queued exits than on anything else. A **SELL** is allowed to queue, because refusing a risk-reducing exit leaves the position exposed to the same gap. |
| Quote freshness | ≤ 15 min (measured on the orderbook fetch, not on the daily candle) | The daily candle is a day old by construction; freshness has to be measured on the live quote. |
| Recent trade | last trade ≤ 60 s ago | A symbol that is not moving is a gift to the spread. |
| Price floor | ≥ $5 | The cost model already assumes a $5 floor. |
| Dollar volume | ≥ $5,000,000/day | Below this the exit cost is a material share of the expected move. |
| Spread | ≤ 30 bps | The round trip costs ~74 bps; a 30 bps spread already eats 40% of it. |
| Price limits | inside the broker's daily limit, with a 0.5% buffer | A limit order outside the limit is rejected. |
| Expected move | must cover the round-trip cost **and** the spread | The edge has to survive the friction, not merely exist. |

The gate is deliberately fail-closed on the questions it can answer and
deliberately permissive on the ones it cannot: a missing spread or a
missing volume is not a reason to refuse an otherwise sound order.

### Ranking

Candidates are ranked by **opportunity**, not by signal strength:

```
opportunity = (expected move - round-trip cost - spread cost - gap risk) x fill probability
```

A strong signal on a wide-spread, stale-priced symbol is worth less than a
modest signal on a liquid one that can actually be filled, because the first
one pays the full round trip for nothing.

---

## 3. The measured economics that constrain the strategy

From the 2026-10-21 backtest on the real market data (600 daily candles,
5 US symbols, 2026-05-01 → 2026-10-21):

| | Baseline | After the entry/exit rework |
|---|---|---|
| Net expectancy | −4.634 | **+0.481** |
| Net P&L | −574.65 | **+37.07** |
| Total cost / gross P&L | 1.888 | **0.953** |
| Profit factor | 0.758 | **1.030** |
| Max drawdown | 12.99% | **8.73%** |
| Sharpe | −0.073 | **+0.200** |
| Round trips | 250 | 156 |

The strategy that survived the cost analysis is the low-frequency one
(`mean_reversion`). The high-frequency entry signals were removed by the
measured blocklist, and the churn they caused was what the costs were
feeding on.

**The rule this imposes on any market expansion:** a new market is only
admissible if it lowers the cost ratio or raises the net expectancy on
paper, measured on the same cost model, with the same round-trip cost the
live account pays.

---

## 4. Market expansion: **STOPPED**

The previous revision of this document proposed crypto (Binance), IBKR,
Alpaca and a second Korean exchange. That proposal is **withdrawn**.

**Reason, recorded 2026-10-21:**

1. The base strategy is barely break-even: net expectancy +0.481 with one
   surviving signal type, and the result carries a known in-sample
   selection bias (the blocklist was derived from the same 120 days it is
   measured on).
2. Each additional venue multiplies the surface that has to be correct
   before it may place an order: the market calendar, the fee schedule,
   the cost model, the tradability gate, the fill accounting, the position
   accounting, the event store, the P&L attribution and the trade
   analytics. Every one of those is a place where a unit error (as in the
   0.015% / 0.25% commission error) silently changes the measured result.
3. There is no measured demand for more markets. The problem is not a lack
   of opportunities; it is that the existing ones are traded with a
   74 bps round trip and a 1-bar holding period. Adding venues before that
   is fixed multiplies the churn across all of them.
4. No new broker was added, so requirement 9 (abstraction boundary,
   tests, dry-run verification) does not apply to this phase. If it is
   ever revived, it starts with the abstraction boundary and the tests, and
   the first order in the new venue is a dry run.

**The condition for revisiting:** the base strategy's net expectancy has
survived two consecutive out-of-sample measurements (the daily cron
measurement, which is not the data the blocklist was derived from) and the
cost ratio is below 0.5.

---

## 5. Configuration reference

| Variable | Default | Meaning |
|---|---|---|
| `TRADABILITY_MIN_PRICE_USD` | 5 | Price floor |
| `TRADABILITY_MIN_DOLLAR_VOLUME` | 5,000,000 | Daily dollar-volume floor |
| `TRADABILITY_MAX_SPREAD_BPS` | 30 | Spread ceiling |
| `TRADABILITY_MAX_DATA_AGE_MS` | 900,000 | Quote freshness |
| `TRADABILITY_MIN_TRADE_AGE_MS` | 60,000 | Recent-trade requirement |
| `TRADABILITY_PRICE_LIMIT_BUFFER_PCT` | 0.5 | Buffer inside the daily limit |
| `TRADABILITY_MIN_EDGE_MULTIPLE` | 1 | How many times the cost the expected move must cover |
| `COST_SPREAD_PCT` | 0.02 | Assumed spread per side, in percent |
| `COST_SLIPPAGE_PCT` | 0.05 | Assumed slippage per side, in percent |
| `POLL_INTERVAL_MS` | 45000 | REST poll interval; the worst-case staleness of a REST-priced signal |
| `SIG_BLOCKED_STRATEGIES` | (empty) | The measured blocklist of entry signals that lose money after costs |

None of these enable order flow. The tradability gate can only *refuse* an
order; every setting above tightens the funnel and none of them loosens a
risk limit.
