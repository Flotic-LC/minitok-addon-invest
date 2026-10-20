# Market Strategy & Expansion Analysis

## Current State: Toss Securities Open API

Toss Securities (토스증권) is a relatively new entrant in the Korean brokerage landscape.
Its Open API provides access to:
- **KRX (Korean Exchange)**: Domestic stocks, ETFs, ETNs
- **US Markets**: NYSE/NASDAQ listed stocks and ETFs
- **FX Exchange Rate**: KRW/USD reference rate READ-ONLY (`GET /api/v1/exchange-rate`).

> **Correction (2026-10-15)**: FX **order execution does NOT exist** in the Toss Securities Open API. Verified by inspecting the full official SDK (`tossinvest` PyPI 0.1.0) — only `exchange_rate()` (read-only) is exposed; there is no `POST /fx`, `/exchange`, or any currency-conversion order endpoint. Currency conversion (환전) must be done manually in the app. Auto-exchange triggers are a manual one-time setup in the brokerage account, not an API capability.

### Limitations for 24/7 Autonomous Trading

| Gap | Impact | Severity |
|-----|--------|----------|
| No Crypto support | Cannot trade during weekends or off-hours when traditional markets are closed | High |
| No Futures/Options | Cannot hedge positions or leverage macro views | Medium |
| No FX order API | Currency conversion (환전) is NOT exposed via API — manual app action only | High |
| JP market REST-only | WebSocket not supported; polling adds latency | Low |
| Limited US pre/post-market | Orders execute during regular hours only | Medium |

### Market Coverage Timeline (UTC)

```
00:00-06:00  JP market (REST polled)
06:00-13:30  GAP - Only crypto would fill this
13:30-20:00  US market (WebSocket real-time)
20:00-23:50  GAP - Only crypto would fill this
23:50-06:35  KR market (WebSocket real-time)
```

Even with KR+US+JP coverage, there are approximately 9.5 hours of dead time daily
where no traditional market is open. For true 24/7 autonomous operation, crypto
exposure is essential.

## Recommendation: Multi-Broker Abstraction Layer

To achieve genuine 24/7 global market coverage, minitok should implement a
broker-agnostic adapter architecture that allows simultaneous connections to
multiple exchanges.

### Proposed Architecture

```
┌─────────────────────────────────────────────┐
│           minitok Target Engine              │
│     (Phase ladder, goals, risk mgmt)         │
├─────────────────────────────────────────────┤
│         Unified Order Router                 │
│   (Symbol → Broker mapping, failover)        │
├──────────┬──────────┬──────────┬────────────┤
│  Toss    │ Binance  │ IBKR     │ Alpaca     │
│ Adapter  │ Adapter  │ Adapter  │ Adapter    │
│ (KR/US)  │ (Crypto) │ (Global) │ (US/API)   │
└──────────┴──────────┴──────────┴────────────┘
```

### Priority Expansion Roadmap

1. **Phase A (Immediate)**: Maximize Toss KR+US coverage with current goals.json templates
2. **Phase B (Short-term)**: Add Binance/Upbit adapter for crypto (BTC, ETH, SOL) — fills 24/7 gaps
3. **Phase C (Medium-term)**: Add Interactive Brokers (IBKR) for global equities, options, futures
4. **Phase D (Long-term)**: Multi-account portfolio optimization across all connected brokers

### Why This Matters for minitok

minitok's adaptive target engine already supports phase-based escalation with
risk controls. By connecting multiple brokers, the AI agent can:
- Trade crypto during traditional market off-hours
- Execute cross-market arbitrage (e.g., Samsung KRX vs GDR)
- Hedge equity exposure with futures or options
- Maintain continuous learning cycles without idle periods

This transforms minitok from a single-market trading bot into a truly global,
always-on autonomous investment platform.