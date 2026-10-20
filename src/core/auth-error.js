"use strict";

/**
 * Classify Toss authentication failures.
 *
 * Toss replies in Korean as well as English, and both forms have to be
 * recognised. A revoked token that is not classified as an auth error skips
 * the invalidate-and-retry path: the caller keeps using the dead token until
 * its TTL expires, which in practice means the runner stops seeing its own
 * portfolio while every other Toss call fails with an invalid token.
 */

// English markers used by the Toss API and by our own mapped error codes.
const ENGLISH_MARKERS = [
  "invalid-token",
  "invalid_token",
  "token-revoked",
  "token_revoked",
  "toss_auth_error",
  "unauthorized",
];

// Korean markers.
//   "유효하지 않은 토큰입니다."                      -> the token is not valid
//   "새로 발급된 토큰으로 대체되어 ... 유효하지 ..."   -> replaced by a newly issued token
//   "만료된 토큰입니다."                              -> the token has expired
//   "폐기된 토큰입니다."                              -> the token was revoked
const KOREAN_TOKEN = "토큰";
const KOREAN_INVALID = ["유효하지", "만료", "폐기", "대체"];

function isAuthError(msg) {
  const lower = String(msg || "").toLowerCase();
  if (!lower) return false;
  for (const marker of ENGLISH_MARKERS) {
    if (lower.indexOf(marker) !== -1) return true;
  }
  if (lower.indexOf(KOREAN_TOKEN) === -1) return false;
  for (const marker of KOREAN_INVALID) {
    if (lower.indexOf(marker) !== -1) return true;
  }
  return false;
}

function isTokenRevoked(msg) {
  const lower = String(msg || "").toLowerCase();
  if (lower.indexOf("token-revoked") !== -1) return true;
  if (lower.indexOf("token_revoked") !== -1) return true;
  if (lower.indexOf("revoked") !== -1 && lower.indexOf("token") !== -1) return true;
  if (lower.indexOf(KOREAN_TOKEN) !== -1 && (lower.indexOf("대체") !== -1 || lower.indexOf("폐기") !== -1)) return true;
  return false;
}

module.exports = { isAuthError, isTokenRevoked };
