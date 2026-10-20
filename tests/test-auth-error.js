"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { isAuthError, isTokenRevoked } = require("../src/core/auth-error.js");

test("isAuthError: recognises the English markers", () => {
  assert.equal(isAuthError("invalid-token"), true);
  assert.equal(isAuthError("invalid_token"), true);
  assert.equal(isAuthError("token-revoked"), true);
  assert.equal(isAuthError("token_revoked"), true);
  assert.equal(isAuthError("TOSS_AUTH_ERROR"), true);
  assert.equal(isAuthError("Unauthorized"), true);
});

test("isAuthError: recognises the Korean messages Toss actually returns", () => {
  assert.equal(isAuthError("유효하지 않은 토큰입니다."), true);
  assert.equal(
    isAuthError("새로 발급된 토큰으로 대체되어 더 이상 유효하지 않은 토큰입니다. 최신 토큰으로 다시 시도해 주세요."),
    true
  );
  assert.equal(isAuthError("만료된 토큰입니다."), true);
  assert.equal(isAuthError("폐기된 토큰입니다."), true);
});

test("isAuthError: does not swallow unrelated failures", () => {
  assert.equal(isAuthError(""), false);
  assert.equal(isAuthError(null), false);
  assert.equal(isAuthError(undefined), false);
  assert.equal(isAuthError("Not Found"), false);
  assert.equal(isAuthError("호출 제한 exceeded"), false);
  assert.equal(isAuthError("insufficient balance"), false);
});

test("isTokenRevoked: separates revocation from a plain invalid token", () => {
  assert.equal(isTokenRevoked("token-revoked"), true);
  assert.equal(isTokenRevoked("token was revoked"), true);
  assert.equal(isTokenRevoked("새로 발급된 토큰으로 대체되어 ..."), true);
  assert.equal(isTokenRevoked("폐기된 토큰입니다."), true);
  assert.equal(isTokenRevoked("유효하지 않은 토큰입니다."), false);
  assert.equal(isTokenRevoked("Not Found"), false);
});
