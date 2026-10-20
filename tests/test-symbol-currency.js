"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { symbolCurrency } = require("../src/tossinvest");

// The order body carries no currency field, so the local buying-power
// pre-check derives it from the symbol. Without this, a US order's USD value
// was compared against the KRW pool (0) and every US order was rejected with
// INSUFFICIENT_BALANCE before reaching the exchange.

test("symbolCurrency: KRX symbols are KRW", () => {
  assert.equal(symbolCurrency("005930"), "KRW");
  assert.equal(symbolCurrency("kr:005930"), "KRW");
  assert.equal(symbolCurrency("000660"), "KRW");
});

test("symbolCurrency: TSE symbols are JPY", () => {
  assert.equal(symbolCurrency("7203"), "JPY");
  assert.equal(symbolCurrency("6758"), "JPY");
});

test("symbolCurrency: US symbols are USD", () => {
  assert.equal(symbolCurrency("AAPL"), "USD");
  assert.equal(symbolCurrency("us:AAPL"), "USD");
  assert.equal(symbolCurrency("BRK.B"), "USD");
  assert.equal(symbolCurrency("GOOGL"), "USD");
});

test("symbolCurrency: unknown symbols fall back to KRW", () => {
  assert.equal(symbolCurrency(""), "KRW");
  assert.equal(symbolCurrency(undefined), "KRW");
  assert.equal(symbolCurrency("!!invalid!!"), "KRW");
});
