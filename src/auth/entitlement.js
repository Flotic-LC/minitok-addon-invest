"use strict";

/**
 * The trading add-on's entitlement gate.
 *
 * [2026-10-21 7단계] The add-on had NO subscription awareness at all. It runs
 * unattended under Docker Compose and PM2, trades a real brokerage account
 * with real money, and did not care whether anyone had paid for anything.
 * Meanwhile the minitok server already had a complete, server-authoritative
 * entitlement contract:
 *
 *   POST {serverUrl}/v1/validate
 *     { token: <installation jwt>, entitlement: { payload, signature, key_id } }
 *   -> { valid, installation: { installation_id, status, subscription_id },
 *        subscription: { status, plan_id, current_period_end } }
 *
 * The server checks the Ed25519 signature, the installation ownership and
 * the subscription state. The add-on never trusts a tier that was handed to
 * it: the server's answer is the only thing that counts, and the local
 * checks are defence in depth for the case where the server cannot be
 * reached.
 *
 * The states below are the product-facing outcomes. Every one of them except
 * ACTIVE denies the trade, and the denial always carries a reason the
 * operator can act on.
 */

const STATES = Object.freeze({
  ACTIVE: "active",
  TRIAL: "trial",
  EXPIRED: "expired",
  CANCELED: "canceled",
  PAYMENT_PENDING: "payment_pending",
  OWNERSHIP_MISMATCH: "ownership_mismatch",
  LEGACY_SESSION: "legacy_session",
  SERVER_UNAVAILABLE: "server_unavailable",
  MISSING: "missing",
  MALFORMED: "malformed",
  INVALID_SIGNATURE: "invalid_signature",
  PLAN_MISMATCH: "plan_mismatch",
});

/**
 * The states in which the add-on may trade.
 *
 * [2026-10-21 7단계] Only an ACTIVE paid subscription grants the add-on.
 * The free trial does not: it is a bounded 14-day / 5-run evaluation of the
 * coding agent, and live trading against a real brokerage account is not
 * part of it.
 */
const ALLOWED_STATES = Object.freeze([STATES.ACTIVE]);

const DEFAULT_MIN_PLAN_ID = "level1";

/** The server's error codes and the state each one means. */
function classifyServerRejection(code, error) {
  const text = String(error || "").toLowerCase();
  if (code === 410) return STATES.EXPIRED;
  if (text.includes("ownership")) return STATES.OWNERSHIP_MISMATCH;
  if (text.includes("expired")) return STATES.EXPIRED;
  if (text.includes("canceled") || text.includes("cancelled")) return STATES.CANCELED;
  if (text.includes("payment") || text.includes("past_due") || text.includes("unpaid")) return STATES.PAYMENT_PENDING;
  if (text.includes("trial")) return STATES.TRIAL;
  if (text.includes("subscription")) return STATES.EXPIRED;
  return STATES.EXPIRED;
}

/** The subscription status values the server may return. */
function classifySubscriptionStatus(status) {
  const s = String(status || "").toLowerCase();
  if (s === "canceled" || s === "cancelled") return STATES.CANCELED;
  if (s === "payment_pending" || s === "past_due" || s === "unpaid" || s === "incomplete") return STATES.PAYMENT_PENDING;
  if (s === "trialing" || s === "trial") return STATES.TRIAL;
  if (s === "active") return STATES.ACTIVE;
  if (s === "expired") return STATES.EXPIRED;
  return STATES.EXPIRED;
}

/**
 * The user-facing explanation for every state.
 *
 * [2026-10-21 7단계] The add-on runs unattended, so a denial has to tell the
 * operator what to do about it: sign in again, check the subscription, or
 * contact support. The wording is what the runner prints and what the
 * Telegram alert carries.
 */
const MESSAGES = Object.freeze({
  active: "the subscription is active",
  trial: "the free trial does not include live trading - a paid minitok Level 1 subscription is required",
  expired: "the subscription has expired - renew it to keep the trading add-on running",
  canceled: "the subscription was canceled - reactivate it to keep the trading add-on running",
  payment_pending: "the payment is still pending - the add-on starts once the payment settles",
  ownership_mismatch: "the entitlement belongs to a different minitok account - sign in with the account that owns this installation",
  legacy_session: "this installation still uses a legacy session - sign out and sign in again to bind it to your account",
  server_unavailable: "the minitok server could not be reached, so the entitlement could not be verified - the add-on stays paused until it can",
  missing: "no entitlement was configured - set MINITOK_ENTITLEMENT_PATH (or MINITOK_ENTITLEMENT) and restart",
  malformed: "the entitlement file could not be read - it must contain { payload, signature, key_id }",
  invalid_signature: "the entitlement signature did not verify - it was not issued by the minitok server",
  plan_mismatch: "the current subscription does not include the trading add-on",
});

function messageFor(state) {
  return MESSAGES[state] || ("the entitlement state is " + state);
}

/**
 * Parse the entitlement artifact.
 *
 * The artifact is a bare Ed25519 detached signature over canonical JSON -
 * not a JWT. The payload carries the plan, the features and the identity
 * binding (installation_id).
 */
function parseArtifact(raw) {
  let art = raw;
  if (typeof art === "string") {
    const text = art.trim();
    if (!text) return { ok: false, reason: "the entitlement is empty" };
    try {
      art = JSON.parse(text);
    } catch (e) {
      return { ok: false, reason: "the entitlement is not valid JSON" };
    }
  }
  if (!art || typeof art !== "object") return { ok: false, reason: "the entitlement is not an object" };
  if (!art.payload || typeof art.payload !== "object") return { ok: false, reason: "the entitlement has no payload" };
  if (typeof art.signature !== "string" || !art.signature) return { ok: false, reason: "the entitlement has no signature" };
  if (typeof art.key_id !== "string" || !art.key_id) return { ok: false, reason: "the entitlement has no key id" };
  const p = art.payload;
  if (typeof p.plan_id !== "string" || !p.plan_id) return { ok: false, reason: "the entitlement has no plan id" };
  if (typeof p.installation_id !== "string" || !p.installation_id) {
    // [2026-10-21 7단계] An artifact without an installation binding is a
    // pre-account legacy artifact. It is parseable, and the client treats it
    // as LEGACY_UNBOUND: not runtime-authorised.
    return { ok: false, reason: "the entitlement is not bound to an installation", state: STATES.LEGACY_SESSION };
  }
  if (p.expires_at && Number.isFinite(Date.parse(p.expires_at)) && Date.parse(p.expires_at) <= (Date.now ? Date.now() : 0)) {
    return { ok: false, reason: "the entitlement expired at " + p.expires_at, state: STATES.EXPIRED };
  }
  return { ok: true, artifact: art, payload: p };
}

/**
 * Verify the entitlement against the minitok server.
 *
 * @param {object} options
 * @param {string} options.serverUrl        the minitok server base url
 * @param {string} options.token             the installation token (the server's jwt)
 * @param {object|string} options.entitlement the signed artifact
 * @param {string} [options.expectedInstallationId] the installation this add-on belongs to
 * @param {string} [options.minPlanId]       the plan that grants the add-on (default level1)
 * @param {number} [options.graceMs]         how long a cached verification stays valid when the server is unreachable (default 0 = fail closed at once)
 * @param {function} [options.fetchImpl]     the http client (for the tests)
 * @param {object} [options.cached]          the previous verification result
 * @param {number} [options.now]
 */
async function verifyEntitlement(options) {
  const opts = options || {};
  const now = opts.now || Date.now();
  const minPlanId = opts.minPlanId || DEFAULT_MIN_PLAN_ID;
  const graceMs = opts.graceMs != null ? Number(opts.graceMs) : 0;
  const fetchImpl = opts.fetchImpl || (typeof fetch === "function" ? fetch : null);

  const deny = function(state, reason) {
    return {
      allowed: false,
      state: state,
      reason: reason || messageFor(state),
      message: messageFor(state),
      checkedAt: now,
      plan: null,
      installationId: null,
      expiresAt: null,
    };
  };

  if (!opts.token || !opts.entitlement) {
    return deny(STATES.MISSING, messageFor(STATES.MISSING));
  }

  const parsed = parseArtifact(opts.entitlement);
  if (!parsed.ok) {
    return deny(parsed.state || STATES.MALFORMED, parsed.reason);
  }
  const payload = parsed.payload;

  // The ownership binding, checked before the server is contacted. The
  // add-on belongs to one installation; an artifact issued for another one
  // must never be accepted, whoever presented it.
  if (opts.expectedInstallationId && payload.installation_id !== opts.expectedInstallationId) {
    return deny(STATES.OWNERSHIP_MISMATCH, messageFor(STATES.OWNERSHIP_MISMATCH));
  }

  if (!opts.serverUrl || !fetchImpl) {
    return deny(STATES.MISSING, "no minitok server url is configured");
  }

  let response;
  let body = null;
  try {
    response = await fetchImpl(String(opts.serverUrl).replace(/\/+$/, "") + "/v1/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: opts.token, entitlement: parsed.artifact }),
    });
    let text = "";
    try { text = await response.text(); } catch (e) { text = ""; }
    try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
  } catch (e) {
    // [2026-10-21 7단계] The server could not be reached. Fail closed: a
    // trading add-on may not keep trading on an unverified entitlement. A
    // bounded grace window can be configured for an operator who prefers
    // availability over strictness, but the default is zero.
    if (graceMs > 0 && opts.cached && opts.cached.allowed && now - (opts.cached.checkedAt || 0) <= graceMs) {
      return Object.assign({}, opts.cached, { allowed: true, state: opts.cached.state, degraded: true, checkedAt: now, reason: "the server could not be reached; the previous verification is still inside the grace window" });
    }
    return deny(STATES.SERVER_UNAVAILABLE, messageFor(STATES.SERVER_UNAVAILABLE));
  }

  if (!response || !response.ok || !body || body.valid !== true) {
    const code = response ? response.status : 0;
    const err = body && body.error ? body.error : (response ? "the server refused the entitlement" : "no answer from the server");
    return deny(classifyServerRejection(code, err), err);
  }

  // The server's answer is authoritative. Cross-check the identity binding it
  // returned against the artifact we presented.
  const installation = body.installation || {};
  const subscription = body.subscription || {};
  if (installation.installation_id && installation.installation_id !== payload.installation_id) {
    return deny(STATES.OWNERSHIP_MISMATCH, messageFor(STATES.OWNERSHIP_MISMATCH));
  }
  if (installation.status && String(installation.status).toLowerCase() !== "active") {
    return deny(STATES.OWNERSHIP_MISMATCH, "the installation is " + installation.status);
  }

  const subState = classifySubscriptionStatus(subscription.status);
  if (subState !== STATES.ACTIVE) {
    return deny(subState, messageFor(subState));
  }
  if (subscription.plan_id === "trial") {
    return deny(STATES.TRIAL, messageFor(STATES.TRIAL));
  }
  if (subscription.plan_id && subscription.plan_id !== minPlanId) {
    return deny(STATES.PLAN_MISMATCH, messageFor(STATES.PLAN_MISMATCH) + " (the plan is " + subscription.plan_id + ")");
  }

  return {
    allowed: true,
    state: STATES.ACTIVE,
    reason: messageFor(STATES.ACTIVE),
    message: messageFor(STATES.ACTIVE),
    plan: subscription.plan_id || payload.plan_id,
    installationId: payload.installation_id,
    expiresAt: subscription.current_period_end || payload.expires_at || null,
    features: Array.isArray(payload.features) ? payload.features : [],
    checkedAt: now,
  };
}

/**
 * Load the entitlement artifact from a file or from an environment value.
 */
function loadArtifact(options) {
  const opts = options || {};
  if (opts.entitlement) return opts.entitlement;
  if (opts.path) {
    const fs = opts.fs || require("fs");
    try {
      const raw = fs.readFileSync(opts.path, "utf8");
      return raw;
    } catch (e) {
      return null;
    }
  }
  return null;
}

module.exports = {
  STATES: STATES,
  ALLOWED_STATES: ALLOWED_STATES,
  MESSAGES: MESSAGES,
  DEFAULT_MIN_PLAN_ID: DEFAULT_MIN_PLAN_ID,
  verifyEntitlement: verifyEntitlement,
  parseArtifact: parseArtifact,
  classifyServerRejection: classifyServerRejection,
  classifySubscriptionStatus: classifySubscriptionStatus,
  messageFor: messageFor,
  loadArtifact: loadArtifact,
};
