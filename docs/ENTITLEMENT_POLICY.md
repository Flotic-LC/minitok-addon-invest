# The trading add-on's product and entitlement policy

**Status:** implemented 2026-10-21. The gate ships unarmed
(`MINITOK_ENTITLEMENT_REQUIRED=false`) until a commercial entitlement is
issued; see [Arming](#arming-the-gate).

---

## 1. The product policy (the decision)

**The trading add-on is not free. It requires an active, paid minitok
subscription, and it is not part of the free trial.**

| | Granted to | Denied to |
|---|---|---|
| `trial` (14 days, 5 runs, no card) | the coding agent | **live trading** |
| `level1` ($8.99/month, the only purchasable plan) | the coding agent **and the trading add-on** | - |
| retired `open` / `select` / `private` | nothing - the server refuses to issue or sell them | everything |

The add-on trades the **customer's own brokerage account** with the
customer's own credentials. minitok sells the automation, not the capital.
The free trial evaluates the coding agent; letting it drive real-money
orders against a real brokerage account is a different product and a
different risk, so the trial does not grant it.

### Why the add-on is not sold as its own SKU yet

The marginal cost of the add-on is not flat: every decision costs an LLM
call, and a more profitable bot decides more often. A flat monthly fee
over a variable cost is a loss leader whose margin falls exactly as the
product gets better. The gate is therefore written so that granting the
add-on by **entitlement feature** rather than by **plan id** is a
configuration change, not a code change, and the recommendation for the
commercial launch is a separate add-on SKU at the payment provider mapped
onto a plan row whose `features` array contains `trading_addon`.

---

## 2. Who decides

**The server. Always.**

The add-on never trusts a tier that was handed to it. The verification is a
server round trip:

```
POST {MINITOK_SERVER_URL}/v1/validate
  { token: <installation jwt>, entitlement: { payload, signature, key_id } }
-> { valid, installation: { installation_id, status, subscription_id },
     subscription: { status, plan_id, current_period_end } }
```

The entitlement is **not a JWT**: it is a bare Ed25519 detached signature
over canonical JSON (`minitok-server-deploy/src/entitlement/signer.js:135`).
The signed payload carries `plan_id`, `features`, `max_devices`,
`issued_at`, `expires_at`, `key_id` and - the identity binding -
`installation_id`.

The server checks the signature, that the artifact belongs to the
installation that was presented, that the installation is active, and that
the subscription is paid and current. The add-on then cross-checks the
`installation_id` the server returned against the one it presented, and
against the installation it is configured for.

There is **no `account_uuid` and no `customer_uuid` in the signed payload**
in any of the three repositories. The customer uuid is `customers.customer_id`
in the database and the `sub` claim of the installation token. The
add-on's ownership binding is therefore the **installation id**: an
artifact issued for another installation is refused before the server is
even contacted.

---

## 3. The states, and what the operator sees

`src/auth/entitlement.js` maps every outcome onto one state. Only `active`
allows trading.

| State | Cause | What the operator is told |
|---|---|---|
| `active` | a paid, current subscription | - |
| `trial` | a trial subscription | the free trial does not include live trading |
| `expired` | the period ended / the server returned 410 | renew to keep the add-on running |
| `canceled` | the subscription was canceled | reactivate to keep the add-on running |
| `payment_pending` | `past_due` / `unpaid` / `incomplete` | the add-on starts once the payment settles |
| `ownership_mismatch` | the artifact or the installation belongs to another account | sign in with the account that owns this installation |
| `legacy_session` | an artifact without an installation binding | sign out and sign in again to bind the installation |
| `server_unavailable` | the server could not be reached | the add-on stays paused until it can |
| `missing` | no entitlement configured | set `MINITOK_ENTITLEMENT_PATH` and restart |
| `malformed` | the artifact could not be read | it must contain `{ payload, signature, key_id }` |
| `invalid_signature` | the signature did not verify | it was not issued by the minitok server |
| `plan_mismatch` | the plan does not include the add-on | the current subscription does not include the trading add-on |

**Fail-closed.** An unreachable server denies the trade. A bounded grace
window (`MINITOK_ENTITLEMENT_GRACE_MS`, default `0`) can be configured for
an operator who prefers availability over strictness; the default is
zero, because the add-on moves real money.

The denial message is printed by the runner, and it is written to be
actionable: which state, what to do, and that support is an option.

---

## 4. Configuration

| Variable | Meaning |
|---|---|
| `MINITOK_ENTITLEMENT_REQUIRED` | `true` arms the gate. The add-on exits with code 1 when the entitlement does not verify |
| `MINITOK_SERVER_URL` | the minitok server base url (the `/v1/validate` host) |
| `MINITOK_INSTALLATION_TOKEN` | the installation token the server issued (a secret) |
| `MINITOK_ENTITLEMENT_PATH` | the file holding `{ payload, signature, key_id }` |
| `MINITOK_ENTITLEMENT` | the same artifact inline, for a container that only has env |
| `MINITOK_INSTALLATION_ID` | the installation this add-on belongs to. An artifact for another one is refused |
| `MINITOK_ADDON_MIN_PLAN_ID` | the plan that grants the add-on. Default `level1` |
| `MINITOK_ENTITLEMENT_GRACE_MS` | the grace window when the server is unreachable. Default `0` |

---

## 5. Arming the gate

```bash
# 1. The server issues the artifact for the customer + installation
#    (POST /v1/activate with the activation key, or an operator entitlement).
# 2. Put it where the container can read it, 0600.
install -m 0600 entitlement.json /opt/minitok/addons/invest/entitlement.json
# 3. Point the add-on at it and arm the gate.
#    MINITOK_ENTITLEMENT_PATH=/opt/minitok/addons/invest/entitlement.json
#    MINITOK_INSTALLATION_ID=<the installation uuid>
#    MINITOK_INSTALLATION_TOKEN=<the installation jwt>
#    MINITOK_SERVER_URL=https://minitok.dev
#    MINITOK_ENTITLEMENT_REQUIRED=true
# 4. Restart. The runner prints the plan, the installation and the expiry,
#    or the state and what to do about it.
```

Arming it before an artifact exists stops a running bot. That is the
intended fail-closed behaviour, and the reason the flag defaults to
`false` until the commercial path is live.

---

## 6. Consistency findings (the policy is not yet consistent everywhere)

These were found while building the gate and are **not** fixed here. They
are listed with their locations so the next pass can close them.

| # | Finding | Location |
|---|---|---|
| 1 | The auth contract still documents the **retired** plan ids `open`, `select`, `private` and a stale device/telemetry table, contradicting the code (`level1` + `trial`) | `minitok-server-deploy/docs/AUTH_CONTRACT_V1.md:91-97` |
| 2 | `DODO_PRODUCT_ID_LEVEL1` is **absent** from `.env` and `.env.example`, so `plans.dodo_product_id` seeds as NULL and the checkout answers 500 "Plan has no Dodo product configured" | `minitok-server-deploy/.env.example:29-31` (only the retired `_OPEN`/`_SELECT`/`_PRIVATE` placeholders remain) |
| 3 | The plan -> feature lists disagree in three places, and the seeded names would not satisfy the client's `features.includes(feature)` check | client `server/models/entitlement.js:24`, server `src/db/seed.js:9`, server `src/services/operator-entitlement.js:17` |
| 4 | The client trusts `key-2026-09-prod` but the server's `ED25519_PUBLIC_KEYS` configures only `key-2024-01-prod` | client `src/entitlement/public-key.js:49-57` vs server `.env:11` |
| 5 | `JWT_SECRET=change_me_in_production` is live | `minitok-server-deploy/.env:14` |
| 6 | The website's `website-v2/data-site.json` has no `pricingPlans` key (the price is hardcoded in the HTML) while `website/data-site.json` has it, and only the latter is covered by the consistency test | `minitok-server-deploy/deployment/website-v2/` |
| 7 | The client's `docs/entitlement.md` documents only the old embedded-server contract (`/api/entitlement/*`, an HS256 session JWT) and not the current `/v1/*` contract | `minitok-client-release/docs/entitlement.md` |

---

## 7. Manual tier promotion and account transfer

Both are privileged operations and both need an audit trail and an
approval, not a direct database write:

- A manual tier promotion records who approved it, on which customer, from
  which plan to which plan, and the evidence. The server's operator
  entitlement service is the only sanctioned path
  (`minitok-server-deploy/src/services/operator-entitlement.js`).
- An account transfer changes the owner of an installation. The server
  already refuses a mismatched owner
  (`minitok-server-deploy/src/services/account.js:254`), and a transfer has
  to go through the same check, not around it.

**Not implemented here.** The audit log and the approval procedure for
these two operations are the next step; until then they should be treated
as unsupported and the operators told so.

---

## 8. The end-to-end procedure that still has to be run

The gate's unit tests cover every state and the cross-account refusal
(`tests/test-entitlement.js`). The **real-account** end-to-end - login,
purchase, webhook, entitlement issued, tier promoted, the add-on allowed,
re-login, expiry, cancellation and a second account refused - needs a
payment sandbox and a real customer, and has **not** been run. The steps
are:

1. `minitok login` on a clean machine, note the installation id.
2. `minitok checkout` for `level1`, complete the payment.
3. The Dodo webhook fires; the server creates the subscription, the
   installation and the entitlement record.
4. `POST /v1/activate` with the activation key returns the artifact and
   the installation token.
5. Configure the add-on with the artifact and the installation id; arm the
   gate; restart. The runner prints `plan=level1`.
6. The add-on trades.
7. Restart the client, re-validate: the state stays `active`.
8. Expire the subscription: the next validation returns `expired` and the
   add-on stops.
9. Cancel: the state becomes `canceled` and the add-on stops.
10. Point the add-on at a second account's artifact: the gate refuses with
    `ownership_mismatch` **before** the server is contacted.
