# Paper trading and live promotion

**Status:** implemented 2026-10-21. The gate is armed. The deployment is in
paper.

---

## 1. What was wrong

`DRY_RUN` was not a mode. It advanced the target engine's phase, and the
phase decided whether a fake operation was injected. Concretely:

- there was no code path that said "this order may not reach the broker";
- nothing in the order, the PnL or the notification said which mode
  produced it, so a paper result and a live result were indistinguishable;
- nothing had to pass before live trading - the deployment went live by
  flipping one environment variable;
- there was no way to trade live with a fraction of the capital, so the
  first live trade was the full capital;
- a regression demoted nothing.

---

## 2. The three modes

| Mode | What it means |
|---|---|
| `paper` | The default. **No order can reach the broker.** Every decision is recorded as a virtual fill. |
| `ramped` | Live, with a fraction of the capital, after a promotion that passed the criteria. |
| `live` | Live, with the full capital, after the ramp passed. |

**The capability and the permission are separate.** The environment says
what the deployment is *capable* of (`TRADING_MODE`, or `DRY_RUN=false`);
the promotion record says what it is *allowed* to do. A live-capable
deployment with no promotion on file trades **paper**.

The mode is resolved at startup and printed:

```
[mode] trading mode: paper (capable of live, capital 0%) - the deployment
       is capable of live trading but no promotion is on file
[mode] NOT LIVE: ... Paper results are recorded and a promotion is
       required before any order reaches the broker.
```

---

## 3. What a paper trade records

Every field the promotion needs to judge the strategy, and the mode that
produced it:

| Field | Meaning |
|---|---|
| `mode` | always `paper` - a paper result can never be read as a live one |
| `expectedFillPrice` | the price the strategy assumed |
| `marketPrice` | the market price the decision was made from |
| `expectedSlippagePct` | the slippage the run assumes |
| `realisedSlippagePct` | the slippage the fill actually paid |
| `fillPrice` | the price the paper fill assumed |
| `grossPnl` / `costs` / `netPnl` | the result, with the costs taken out |
| `costRatio` | the costs as a share of the gross |
| `signalTimestamp` / `executionTimestamp` | when the decision was taken and when it would have been executed |

The paper history is persisted with the runner state, so a deployment that
restarts often still accumulates one.

---

## 4. The promotion criteria

All of them have to pass (`src/ops/promotion.js`, `DEFAULT_CRITERIA`):

| Criterion | Default |
|---|---|
| the paper period is long enough | 14 days |
| there are enough closed trades | 30 |
| the expectancy **after the costs** is positive | > 0 |
| the drawdown is inside the limit | 15% |
| the out-of-sample expectancy is positive | > 0 |
| the broker error rate is inside the limit | 5% |
| there are no duplicate orders | 0 |
| the state reconciles with the broker | required |
| the kill switch test passed | required |

**A measurement that is missing is a failure, not a pass.** "We do not
know" must never promote a strategy to real money.

---

## 5. The capital ramp

`DEFAULT_RAMP = [0, 0.05, 0.15, 0.35, 1.0]`. Live trading starts with 5%
of the capital and grows one stage at a time. Stage 0 is paper.

The promotion record is **signed** (`PROMOTION_SIGNING_KEY`), so it cannot
be edited into existence, and a record that does not verify is ignored -
the deployment stays in paper.

```json
{ "promoted": true, "stage": 1, "at": "...", "approver": "...",
  "reason": "...", "signature": "..." }
```

---

## 6. The demotion

`evaluateDemotion()` watches the drawdown, the expectancy, the broker error
rate, the duplicate orders, the data error rate and the reconciliation. A
regression sends the deployment back to paper and records the reasons.

---

## 7. The audit trail

Every promotion and demotion carries the reason and the approver. The
paper gate writes a `PAPER_FILL` journal entry for every virtual fill with
its mode, so a paper run is auditable separately from a live one.

---

## 8. The read-only live smoke test

```bash
node scripts/live-smoke-test.js
```

It verifies the entitlement, the ownership, the position read and the
reconciliation **without placing an order**, and it says so in its output.
It exits non-zero if any check fails, so it can be a gate.

---

## 9. What this means for the current deployment

The deployment is **in paper**. It was live before this change, with no
paper period behind it and no promotion on file - which is the thing this
stage exists to prevent. The measured paper results accumulate from the
next restart; the promotion is an operator decision once the criteria can
be met.

---

## 10. Remaining work

1. The demotion is evaluated by the module but is **not yet wired into the
   running loop** - it is called by the promotion tooling, not by the
   runner's periodic check.
2. The capital ramp is applied to the **order size** through the promotion
   stage, but the position sizing itself still uses the full equity.
3. The paper fill assumes the slippage rather than observing the market
   move between the signal and the execution; the two timestamps are
   recorded so the gap is visible, but the price is not re-read.
4. The promotion's out-of-sample and broker-error inputs are not yet fed
   from the runner's live counters.
5. The kill switch test is a criterion, but there is no automated kill
   switch exercise in the paper loop yet.
6. The 9단계 change stops the live trading of the current deployment. That
   is the intent of the stage, and it is reversible by promoting.
