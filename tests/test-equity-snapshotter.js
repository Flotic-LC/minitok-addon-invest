"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

// ---------------------------------------------------------------------------
// Equity snapshotter — partial data must never be returned as a number.
//
// Before 2026-10-20 fetchEquity() silently dropped any component it could not
// resolve (a failed buying-power call zeroed the cash leg, a failed
// exchange-rate call dropped that position's market value) and it forced a
// token refresh on every call. Toss revokes every previously issued token when
// a new one is issued, so the refresh invalidated the token every concurrent
// request was using; those requests failed and their component vanished from
// the equity sum. The result was a plausible-looking equity ~10M KRW below the
// real one, which the daily-loss kill-switch read as a 13% crash and turned
// into a 30-minute trading freeze.
//
// The contract now: a complete sample returns a number, an incomplete one
// throws so the caller keeps the previous baseline.
// ---------------------------------------------------------------------------

const TOSS_PATH = require.resolve("../src/tossinvest");
const TARGET_PATH = require.resolve("../src/agent/target");

function installMockToss(mock) {
  const previous = require.cache[TOSS_PATH];
  require.cache[TOSS_PATH] = {
    id: TOSS_PATH,
    filename: TOSS_PATH,
    loaded: true,
    exports: mock,
    children: [],
    paths: [],
  };
  return previous;
}

// The snapshotter requires ../tossinvest lazily, when it is constructed — so
// the mock has to stay installed for the whole test, not only for the require.
async function withMockToss(mock, fn) {
  const previous = installMockToss(mock);
  try {
    delete require.cache[TARGET_PATH];
    const target = require(TARGET_PATH);
    return await fn(target);
  } finally {
    if (previous) require.cache[TOSS_PATH] = previous;
    else delete require.cache[TOSS_PATH];
    delete require.cache[TARGET_PATH];
  }
}

const HOLDINGS = [
  { symbol: "MSFT", name: "MSFT", currency: "USD", quantity: 15, lastPrice: 531.43, marketValue: { amount: "7971.45" } },
  { symbol: "SPY", name: "SPY", currency: "USD", quantity: 11.04, lastPrice: 771.62, marketValue: { amount: "8521.16" } },
];

function baseMock(overrides = {}) {
  const calls = { fx: [], bp: [], token: 0, resetToken: 0 };
  const mock = {
    calls,
    async fetchAccessToken() { calls.token++; return "token"; },
    resetTokenCache() { calls.resetToken++; },
    async getHoldings() { return { body: HOLDINGS }; },
    async getBuyingPower(token, seq, currency) {
      calls.bp.push(currency);
      if (currency === "USD") return { body: { currency: "USD", cashBuyingPower: "7094.13" } };
      return { body: { currency: "KRW", cashBuyingPower: "0" } };
    },
    async getExchangeRate(token, base, quote) {
      calls.fx.push(base + quote);
      return { body: { baseCurrency: base, quoteCurrency: quote, rate: "1330.22" } };
    },
  };
  return Object.assign(mock, overrides);
}

const CREDENTIALS = { clientId: "id", clientSecret: "secret" };

test("equity snapshotter: a complete book returns the full KRW value", async () => {
  const mock = baseMock();
  await withMockToss(mock, async ({ createEquitySnapshotter }) => {
    const snap = createEquitySnapshotter({ credentials: CREDENTIALS, accountSeq: "1" });
    const equity = await snap.fetchEquity();
    // (7971.45 + 8521.16) USD * 1330.22 + 7094.13 USD * 1330.22
    const expected = (7971.45 + 8521.16 + 7094.13) * 1330.22;
    assert.ok(Math.abs(equity - expected) < 1, "expected " + expected + ", got " + equity);
  });
});

test("equity snapshotter: the token cache is not reset on every snapshot", async () => {
  const mock = baseMock();
  await withMockToss(mock, async ({ createEquitySnapshotter }) => {
    const snap = createEquitySnapshotter({ credentials: CREDENTIALS, accountSeq: "1" });
    await snap.fetchEquity();
    assert.equal(mock.calls.resetToken, 0, "resetting the token revokes the token every concurrent request is using");
  });
});

test("equity snapshotter: the exchange rate is resolved once per currency, not once per holding", async () => {
  const mock = baseMock();
  await withMockToss(mock, async ({ createEquitySnapshotter }) => {
    const snap = createEquitySnapshotter({ credentials: CREDENTIALS, accountSeq: "1" });
    await snap.fetchEquity();
    assert.equal(mock.calls.fx.filter((c) => c === "USDKRW").length, 1,
      "expected a single USD->KRW rate lookup, got " + JSON.stringify(mock.calls.fx));
  });
});

test("equity snapshotter: a failing buying-power call rejects instead of returning a partial equity", async () => {
  const mock = baseMock({
    async getBuyingPower(token, seq, currency) {
      if (currency === "USD") throw new Error("HTTP 429");
      return { body: { currency: "KRW", cashBuyingPower: "0" } };
    },
  });
  await withMockToss(mock, async ({ createEquitySnapshotter }) => {
    const snap = createEquitySnapshotter({ credentials: CREDENTIALS, accountSeq: "1" });
    await assert.rejects(() => snap.fetchEquity(), /buying power unavailable|HTTP 429/);
  });
});

test("equity snapshotter: a failing exchange-rate call rejects instead of dropping the position", async () => {
  const mock = baseMock({
    async getExchangeRate() { throw new Error("token replaced by a newly issued token"); },
  });
  await withMockToss(mock, async ({ createEquitySnapshotter }) => {
    const snap = createEquitySnapshotter({ credentials: CREDENTIALS, accountSeq: "1" });
    await assert.rejects(() => snap.fetchEquity(), /exchange rate unavailable|token replaced/);
  });
});

test("equity snapshotter: an unrecognised holdings shape rejects instead of reporting cash-only equity", async () => {
  const mock = baseMock({ async getHoldings() { return { body: { unexpected: "shape" } }; } });
  await withMockToss(mock, async ({ createEquitySnapshotter }) => {
    const snap = createEquitySnapshotter({ credentials: CREDENTIALS, accountSeq: "1" });
    await assert.rejects(() => snap.fetchEquity(), /holdings response shape not recognised/);
  });
});

test("equity snapshotter: a holding without a market-value amount rejects instead of dropping it", async () => {
  const mock = baseMock({
    async getHoldings() {
      return { body: [{ symbol: "MSFT", currency: "USD", quantity: 15, marketValue: { purchaseAmount: "7971.45" } }] };
    },
  });
  await withMockToss(mock, async ({ createEquitySnapshotter }) => {
    const snap = createEquitySnapshotter({ credentials: CREDENTIALS, accountSeq: "1" });
    await assert.rejects(() => snap.fetchEquity(), /market value has no amount/);
  });
});

test("equity snapshotter: a zero-quantity holding is excluded", async () => {
  const mock = baseMock({
    async getHoldings() {
      return {
        body: [
          { symbol: "MSFT", currency: "USD", quantity: 15, lastPrice: 531.43, marketValue: { amount: "7971.45" } },
          { symbol: "OLD", currency: "USD", quantity: 0, lastPrice: 100, marketValue: { amount: "9999" } },
        ],
      };
    },
  });
  await withMockToss(mock, async ({ createEquitySnapshotter }) => {
    const snap = createEquitySnapshotter({ credentials: CREDENTIALS, accountSeq: "1" });
    const equity = await snap.fetchEquity();
    const expected = (7971.45 + 7094.13) * 1330.22;
    assert.ok(Math.abs(equity - expected) < 1, "a closed holding must not add value, got " + equity);
  });
});

test("equity snapshotter: the result envelope form of the rate is accepted", async () => {
  const mock = baseMock({
    async getExchangeRate(token, base, quote) {
      return { body: { result: { baseCurrency: base, quoteCurrency: quote, rate: "1330.22" } } };
    },
  });
  await withMockToss(mock, async ({ createEquitySnapshotter }) => {
    const snap = createEquitySnapshotter({ credentials: CREDENTIALS, accountSeq: "1" });
    const equity = await snap.fetchEquity();
    assert.ok(equity > 0, "the nested rate form must still be parsed");
  });
});
