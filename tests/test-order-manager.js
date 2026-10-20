"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createOrderManager } = require("../src/agent/orderManager");

function fakeGetOrder(statusMap) {
  return async (orderId) => ({ body: statusMap[orderId] || { status: "OPEN" } });
}

test("filled order is removed and onFilled called", async () => {
  const events = [];
  const om = createOrderManager({
    getOrder: fakeGetOrder({ o1: { status: "FILLED", filledQuantity: 10, filledPrice: 101000 } }),
    onFilled: (ord, fill) => events.push({ type: "filled", ord, fill }),
  });
  om.track("o1", { symbol: "005930", side: "BUY", price: 100000, quantity: 10 });
  const s = await om.poll();
  assert.equal(s.filled, 1);
  assert.equal(om.size(), 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].fill.filledPrice, 101000);
});

test("expired order is canceled and onExpired called", async () => {
  const events = [];
  let canceled = 0;
  let now = Date.now();
  const om = createOrderManager({
    getOrder: fakeGetOrder({}),
    cancelOrder: async () => { canceled++; },
    onExpired: (ord) => events.push({ type: "expired", ord }),
    timeoutMs: 1000,
    now: () => now,
  });
  om.track("o2", { symbol: "AAPL", side: "BUY", price: 100, quantity: 5 });
  now += 2000; // advance past timeout
  const s = await om.poll();
  assert.equal(s.expired, 1);
  assert.equal(canceled, 1);
  assert.equal(events.length, 1);
});

test("partial fill keeps order tracked with remaining quantity", async () => {
  const partials = [];
  const om = createOrderManager({
    getOrder: fakeGetOrder({ o3: { status: "OPEN", filledQuantity: 4, filledPrice: 1000 } }),
    onPartialFill: (ord, info) => partials.push({ ord, info }),
  });
  om.track("o3", { symbol: "7203", side: "BUY", price: 1000, quantity: 10 });
  const s = await om.poll();
  assert.equal(s.partial, 1);
  assert.equal(om.size(), 1);
  assert.equal(om.get("o3").remainingQuantity, 6);
  assert.equal(partials[0].info.newFilled, 4);
});

test("rejected order retries then fails", async () => {
  const failures = [];
  const om = createOrderManager({
    getOrder: fakeGetOrder({ o4: { status: "REJECTED" } }),
    onFailed: (ord, reason) => failures.push(reason),
    maxRetries: 2,
  });
  om.track("o4", { symbol: "005930", side: "SELL", price: 50000, quantity: 1 });
  await om.poll(); // retry 1
  assert.equal(om.size(), 1);
  await om.poll(); // retry 2 -> failed
  assert.equal(om.size(), 0);
  assert.equal(failures.length, 1);
});

test("open order within timeout stays tracked", async () => {
  const om = createOrderManager({ getOrder: fakeGetOrder({}) });
  om.track("o5", { symbol: "QQQ", side: "BUY", price: 400, quantity: 2 });
  const s = await om.poll();
  assert.equal(s.open, 1);
  assert.equal(om.size(), 1);
});

test("requires getOrder function", () => {
  assert.throws(() => createOrderManager({}), TypeError);
});
