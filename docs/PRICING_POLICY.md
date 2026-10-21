# Pricing and unit economics

**Status:** implemented 2026-10-21. The accounting is live; the prices are
not set.

---

## 1. What it is for

The add-on had no cost accounting of any kind. It called a paid model API
on every decision and **threw the provider's token report away**, called
the broker API again for the order book on every decision, wrote tens of
megabytes of logs a day, and attributed none of it to anybody. A price
could not be set on evidence, so no price was set.

`src/ops/unit-economics.js` makes the cost measurable. The operator can now
see what an account costs, what it pays, and which usage pattern it
represents.

---

## 2. The rules

1. **A cost that is not measured is an estimate and is labelled as one.**
   The report separates the measured lines from the estimated ones, and an
   account whose margin rests entirely on estimates is flagged
   (`marginIsEstimated`). A hypothesis is not reported as a margin.
2. **A customer is never switched off for being expensive.** The controls
   compare what the account is worth with what it costs and change *how the
   account is served* (a cheaper model, a tighter call budget, a cache).
   The only hard stop is an abuse quota, which exists to bound a runaway.
3. **The unit costs are configuration, not code.** `COST_*` in the
   environment. Nothing is hardcoded.

---

## 3. What is measured, and where

| Cost | Counter | Choke point |
|---|---|---|
| model calls + **the provider's own tokens** | `usage.llmCalls`, `usage.llmTotalTokens` | `src/ai/provider-router.js:227` - the provider's `data.usage` was parsed and discarded; it is now read and returned |
| broker API calls, per operation | `usage.brokerCalls`, `usage.brokerOps` | `src/tossinvest.js:203` - every authenticated broker call |
| market data calls | `usage.marketDataCalls` | the market-data paths |
| notifications | `usage.notifications` | `runner.js:594` (`_sendTelegramRaw`) |
| headless browser runs | `usage.browserRuns` | the WTS browser fallback |
| trades and realised P&L | `usage.trades`, `usage.realizedPnl` | the fill path |
| log bytes written | `usage.logBytes` | the file logger |

The ledger is opened in the runner before the state is restored and is
persisted with the rest of the state, so **a restart does not reset the
month's cost to zero**.

The account key is `MINITOK_INSTALLATION_ID` (the installation the add-on
belongs to), with `TOSS_CLIENT_ID` as the fallback. There is still **no
per-customer isolation of the state files** - see the remaining items.

---

## 4. The cost model

| Item | Variable | Default |
|---|---|---|
| model API, per call | `COST_LLM_PER_CALL` | 0 |
| model API, per 1k tokens | `COST_LLM_PER_1K_TOKENS` | 0 |
| broker API, per call | `COST_BROKER_PER_CALL` | 0 |
| market data, per call | `COST_MARKET_DATA_PER_CALL` | 0 |
| notification, per message | `COST_NOTIFICATION_PER_MESSAGE` | 0 |
| storage, per MB per month | `COST_STORAGE_PER_MB_MONTH` | 0 |
| compute, per cpu second / per MB-hour | `COST_SERVER_PER_CPU_SECOND`, `COST_SERVER_PER_MEMORY_MB_HOUR` | 0 |
| headless browser, per launch | `COST_BROWSER_PER_RUN` | 0 |
| the source of each line | `COST_SOURCE_*` | `estimated` |

**Every default is zero**, which means a report generated before the prices
are filled in says so rather than pretending the cost was free.

---

## 5. The revenue side

| Plan | Price | Note |
|---|---|---|
| `level1` | 899 cents ($8.99) per month | the only purchasable plan |
| `trial` | 0 | the free trial; it does not grant live trading (see `docs/ENTITLEMENT_POLICY.md`) |

The server is authoritative for the price. The values above are the ones the
report uses and they are marked `source: "server"`.

---

## 6. The usage segments

Descriptive, and they are what a price is set against. An account that is
expensive because it **trades a lot** is a different product problem from
one that is expensive because its **prompt grew**.

`low_usage` · `high_usage` · `high_trade_frequency` · `high_llm_cost` ·
`long_idle` · `big_loss` - the thresholds are the `thresholds` argument of
`segmentAccount()` and are configuration, not code.

---

## 7. The controls

`CONTROL_OPTIONS` lists them with what each one does and what it costs:

| Control | Effect | What it costs |
|---|---|---|
| `cache` | removes the repeated broker calls that make one AI decision expensive | a stale quote can change the entry price |
| `rate_limit` | bounds the model cost of a churning account | fewer decisions |
| `batch` | the price poll is already batched; the order book is not | one symbol's order book still needs its own call |
| `cheap_model_fallback` | keeps the decision rate while the unit cost falls | a weaker decision |
| `quota` | an absolute bound | the customer can hit the wall mid-session |
| `tier_limit` | prices the capability instead of subsidising it | an entitlement change, which needs the migration below |

`decideCostPolicy()` implements the policy: a quota denies, a negative
margin throttles, a token threshold downgrades the model. It never denies
for cost.

---

## 8. Changing the price without breaking anybody

The entitlement carries a **plan id, not a price**, so a price change does
not invalidate anything an existing customer holds. What it needs is a
notice period, and `planPriceMigration()` plans it:

- the customers who have been on the plan for less than `noticeDays` keep
  the price they paid and are listed with the days remaining
- the others move to the new price
- the plan ids, the entitlements and the feature lists are **not touched**

---

## 9. The operator's report

```bash
node scripts/unit-economics-report.js --json /tmp/unit-economics.json
```

It reads the usage the runner recorded, prices it with the `COST_*`
variables and prints the revenue, the cost per line, the margin, the
segments, the flags and the cost policy. With no usage recorded it says
that instead of printing zeros that look like a measurement.

---

## 10. What the audit found (and what is not fixed yet)

| # | Finding | Location | Status |
|---|---|---|---|
| 1 | The provider's token usage was parsed and thrown away | `src/ai/provider-router.js:227` | **fixed** |
| 2 | Nothing counted the broker calls | `src/tossinvest.js:203` | **fixed** |
| 3 | `recordApiCost()` was only called on the `callAIWithTools` path; the `callAI` path booked nothing | `runner.js:3275` / `:3306` | the ledger now counts every provider call, so the flat per-decision counter is redundant |
| 4 | That counter counted **decisions**, not provider calls, while the router retries up to 3 times - the cost was under-counted by up to 3x | `src/ai/provider-router.js:34` | **fixed** (the ledger counts the attempts) |
| 5 | **No cache for `getPrices` or `getOrderbook`**: the order book is refetched on every AI decision | `runner.js:2857` | **not fixed** - the `cache` control is the fix, and it needs a quote-freshness decision |
| 6 | `discoverSymbols` is an N+1 amplifier: 1 `listStocksAll` plus up to 50 `getCandles` every 10 minutes | `src/tossinvest.js:407` | **not fixed** |
| 7 | The Playwright/Chromium layer in the production image is **dead weight**: the only code that launches a browser is the WTS fallback, and the production deployment sets `WTS_UTK`, so that path is unreachable | `Dockerfile:5-25`, `src/toss_wts_exchange.js:42` | **not fixed** - roughly 300-400 MB of image and the apt install on every build |
| 8 | The log retention is 30 days and the audit log has **no prune at all** | `src/core/file-logger.js:33`, `src/core/audit-logger.js:59` | **not fixed** - a storage cost that grows |
| 9 | The admin's `BOT_LOG_PATH` does not match the runner's log file name | `docker-compose.production.yml:117` | **not fixed** |
| 10 | There is **one flat set of state files** for the whole process - nothing is keyed by customer | the state directory | **not fixed** - the ledger is keyed by account, the files are not |
| 11 | The "multi-account" module rotates the broker account for BUY orders; it is a budget allocator, not multi-tenancy | `src/agent/multi-account.js` | documented, not changed |

---

## 11. Remaining work

1. Fill in the `COST_*` prices from the provider's and the broker's
   invoices. Until then every margin is a hypothesis, and the report says
   so.
2. Decide the price and the tier structure (the unit cost of a decision
   scales with the trading frequency, so a flat fee over a variable cost
   inverts as the product improves - a separate add-on SKU is the sound
   shape).
3. The `cache` control for the order book and the prices, with a
   quote-freshness rule that does not break the tradability gate.
4. Make the Chromium layer conditional in the Dockerfile.
5. Per-customer isolation of the state files, so the cost of one customer
   cannot be confused with another's.
6. Prune the audit log, and fix the admin's log path.
