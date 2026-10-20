"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeApiError } = require("../src/tossinvest");

// Regression coverage for the Toss error-envelope shape. The API answers with
// { error: { requestId, code, message, data } }; reading `body.error` directly
// captured that whole envelope, so the adapter reported `code` as an object
// (logged as "[object Object]") and lost the mappedCode classification.

test("normalizeApiError: unwraps the { error: { code, message } } envelope", () => {
  const err = normalizeApiError(400, {
    error: {
      requestId: "abc123",
      code: "invalid-request",
      message: "지원하지 않는 통화입니다.",
      data: { field: "currency", allowedValues: ["KRW", "USD"] },
    },
  }, "");

  assert.equal(typeof err.code, "string");
  assert.equal(err.code, "invalid-request");
  assert.equal(err.message, "지원하지 않는 통화입니다.");
  assert.equal(err.status, 400);
});

test("normalizeApiError: maps an insufficient-balance envelope to INSUFFICIENT_BALANCE", () => {
  const err = normalizeApiError(400, {
    error: { code: "INSUFFICIENT_BALANCE", message: "주문 가능 금액이 부족합니다." },
  }, "");

  assert.equal(err.code, "INSUFFICIENT_BALANCE");
  assert.equal(err.mappedCode, "INSUFFICIENT_BALANCE");
});

test("normalizeApiError: maps an order-rejected envelope to ORDER_REJECTED", () => {
  const err = normalizeApiError(400, {
    error: { code: "ORDER_REJECTED", message: "주문이 거절되었습니다." },
  }, "");

  assert.equal(err.code, "ORDER_REJECTED");
  assert.equal(err.mappedCode, "ORDER_REJECTED");
});

test("normalizeApiError: still handles a flat { code, message } body", () => {
  const err = normalizeApiError(400, { code: "not-found", message: "no such route" }, "");

  assert.equal(err.code, "not-found");
  assert.equal(err.message, "no such route");
});

test("normalizeApiError: still handles a string error field", () => {
  const err = normalizeApiError(400, { error: "plain error string" }, "");

  assert.equal(err.code, "plain error string");
  assert.equal(err.message, "plain error string");
});

test("normalizeApiError: unwraps a { result: { error } } envelope", () => {
  const err = normalizeApiError(400, {
    result: { error: { code: "REJECTED", message: "거절" } },
  }, "");

  assert.equal(err.code, "REJECTED");
  assert.equal(err.message, "거절");
});

test("normalizeApiError: falls back to TOSS_API_ERROR when no code is present", () => {
  const err = normalizeApiError(500, {}, "");

  assert.equal(err.code, "TOSS_API_ERROR");
  assert.equal(err.mappedCode, "TOSS_SERVER_ERROR");
});

test("normalizeApiError: classifies status-driven failures", () => {
  assert.equal(normalizeApiError(429, { error: { code: "too-many" } }, "").mappedCode, "RATE_LIMITED");
  assert.equal(normalizeApiError(401, { error: { code: "unauthorized" } }, "").mappedCode, "TOSS_AUTH_ERROR");
  assert.equal(normalizeApiError(408, { error: { code: "timeout" } }, "").mappedCode, "TOSS_TIMEOUT");
});

test("normalizeApiError: code is always a string, never an object", () => {
  const err = normalizeApiError(400, {
    error: { requestId: "x", code: "some-code", message: "m", data: { nested: true } },
  }, "");

  assert.equal(typeof err.code, "string");
  assert.equal(typeof err.mappedCode, "string");
});
