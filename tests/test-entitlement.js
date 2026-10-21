"use strict";

/**
 * Entitlement gate tests.
 *
 * [2026-10-21 7단계] The add-on trades a real brokerage account. These tests
 * pin the states in which it must refuse to do so, and the case the whole
 * exercise exists for: an entitlement that belongs to a different minitok
 * account.
 */

const test = require("node:test");
const assert = require("node:assert");
const {
  STATES,
  verifyEntitlement,
  parseArtifact,
  messageFor,
} = require("../src/auth/entitlement");

const INSTALLATION = "11111111-2222-3333-4444-555555555555";
const OTHER_INSTALLATION = "99999999-8888-7777-6666-555555555555";

function artifact(over) {
  const payload = Object.assign({
    entitlement_id: "e-1",
    installation_id: INSTALLATION,
    plan_id: "level1",
    features: ["run", "goal", "mcp"],
    max_devices: 1,
    issued_at: "2026-10-01T00:00:00.000Z",
    expires_at: "2026-11-01T00:00:00.000Z",
    key_id: "key-2024-01-prod",
  }, (over && over.payload) || {});
  return {
    payload: payload,
    signature: (over && over.signature) || "c2lnbmF0dXJl",
    key_id: (over && over.key_id) || "key-2024-01-prod",
  };
}

/** A fetch stub that answers like the minitok server. */
function serverFetch(handler) {
  return function (url, init) {
    // The handler may be a function (the default response, optionally
    // overridden) or a ready-made response object.
    const result = (typeof handler === "function" ? handler(url, init) : handler) || {};
    const status = result.status || 200;
    const body = result.body !== undefined ? result.body : {};
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status: status,
      text: function () { return Promise.resolve(JSON.stringify(body)); },
    });
  };
}

function validServerResponse(over) {
  return {
    status: 200,
    body: Object.assign({
      valid: true,
      installation: { installation_id: INSTALLATION, status: "active", subscription_id: "s-1" },
      subscription: { status: "active", plan_id: "level1", current_period_end: "2026-11-01T00:00:00.000Z" },
    }, (over && over.body) || {}),
  };
}

const BASE = {
  serverUrl: "https://minitok.dev",
  token: "installation-jwt",
  entitlement: artifact(),
  expectedInstallationId: INSTALLATION,
  now: Date.parse("2026-10-21T00:00:00.000Z"),
};

test("an active paid subscription is allowed", async function () {
  const r = await verifyEntitlement(Object.assign({}, BASE, { fetchImpl: serverFetch(validServerResponse) }));
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(r.state, STATES.ACTIVE);
  assert.strictEqual(r.plan, "level1");
  assert.strictEqual(r.installationId, INSTALLATION);
});

test("the free trial does not grant live trading", async function () {
  const resp = validServerResponse({ body: { subscription: { status: "trialing", plan_id: "trial" } } });
  const r = await verifyEntitlement(Object.assign({}, BASE, { fetchImpl: serverFetch(resp) }));
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.state, STATES.TRIAL);
  assert.ok(/trial does not include live trading/.test(r.message));
});

test("an expired subscription is refused", async function () {
  const resp = validServerResponse({ body: { subscription: { status: "expired", plan_id: "level1" } } });
  const r = await verifyEntitlement(Object.assign({}, BASE, { fetchImpl: serverFetch(resp) }));
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.state, STATES.EXPIRED);
});

test("a canceled subscription is refused", async function () {
  const resp = validServerResponse({ body: { subscription: { status: "canceled", plan_id: "level1" } } });
  const r = await verifyEntitlement(Object.assign({}, BASE, { fetchImpl: serverFetch(resp) }));
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.state, STATES.CANCELED);
});

test("a pending payment is refused", async function () {
  const resp = validServerResponse({ body: { subscription: { status: "past_due", plan_id: "level1" } } });
  const r = await verifyEntitlement(Object.assign({}, BASE, { fetchImpl: serverFetch(resp) }));
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.state, STATES.PAYMENT_PENDING);
});

test("an entitlement issued for another installation is refused before the server is asked", async function () {
  let asked = 0;
  const r = await verifyEntitlement(Object.assign({}, BASE, {
    entitlement: artifact({ payload: { installation_id: OTHER_INSTALLATION } }),
    fetchImpl: function () { asked++; return Promise.reject(new Error("must not be called")); },
  }));
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.state, STATES.OWNERSHIP_MISMATCH);
  assert.strictEqual(asked, 0, "the server must not even be contacted for a foreign entitlement");
});

test("a server that answers about a different installation is refused", async function () {
  const resp = validServerResponse({ body: { installation: { installation_id: OTHER_INSTALLATION, status: "active" } } });
  const r = await verifyEntitlement(Object.assign({}, BASE, { fetchImpl: serverFetch(resp) }));
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.state, STATES.OWNERSHIP_MISMATCH);
});

test("a legacy artifact without an installation binding is refused", function () {
  const p = parseArtifact(artifact({ payload: { installation_id: undefined } }));
  assert.strictEqual(p.ok, false);
  assert.strictEqual(p.state, STATES.LEGACY_SESSION);
});

test("the server being unreachable fails closed", async function () {
  const r = await verifyEntitlement(Object.assign({}, BASE, {
    fetchImpl: function () { return Promise.reject(new Error("ECONNREFUSED")); },
  }));
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.state, STATES.SERVER_UNAVAILABLE);
  assert.ok(/could not be reached/.test(r.message));
});

test("an unreachable server is allowed only inside an explicit grace window", async function () {
  const cached = { allowed: true, state: STATES.ACTIVE, checkedAt: BASE.now - 1000, plan: "level1" };
  const r = await verifyEntitlement(Object.assign({}, BASE, {
    graceMs: 60000,
    cached: cached,
    fetchImpl: function () { return Promise.reject(new Error("ECONNREFUSED")); },
  }));
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(r.degraded, true);
});

test("a missing entitlement is refused with an actionable message", async function () {
  const r = await verifyEntitlement({ serverUrl: "https://minitok.dev", token: null, entitlement: null });
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.state, STATES.MISSING);
  assert.ok(/MINITOK_ENTITLEMENT_PATH/.test(r.message));
});

test("a malformed artifact is refused", function () {
  const p = parseArtifact({ payload: { plan_id: "level1" } });
  assert.strictEqual(p.ok, false);
});

test("a locally held tier does not override the server's refusal", async function () {
  // The artifact claims level1, but the server says the subscription is
  // gone. The server wins - a tier handed to the add-on is not evidence.
  const resp = { status: 403, body: { valid: false, error: "Subscription not found" } };
  const r = await verifyEntitlement(Object.assign({}, BASE, { fetchImpl: serverFetch(resp) }));
  assert.strictEqual(r.allowed, false);
});

test("a plan that does not include the add-on is refused", async function () {
  const resp = validServerResponse({ body: { subscription: { status: "active", plan_id: "something-else" } } });
  const r = await verifyEntitlement(Object.assign({}, BASE, { fetchImpl: serverFetch(resp) }));
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.state, STATES.PLAN_MISMATCH);
});

test("every state has an operator-facing message", function () {
  for (const state of Object.keys(STATES)) {
    const m = messageFor(state);
    assert.ok(typeof m === "string" && m.length > 10, "the message for " + state + " is not usable");
  }
});
