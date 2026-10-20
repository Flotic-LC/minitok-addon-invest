"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createTossWsClient, WS_URL, DEFAULT_PING_INTERVAL_MS } = require("../src/ws");

function makeFakeWsClass() {
  const instances = [];
  class FakeWs {
    constructor(url, opts) {
      this.url = url;
      this.opts = opts;
      this.readyState = 0;
      this.sent = [];
      this.handlers = {};
      instances.push(this);
    }
    on(event, fn) { (this.handlers[event] ||= []).push(fn); }
    emit(event, ...args) { (this.handlers[event] || []).forEach(fn => fn(...args)); }
    send(payload) { this.sent.push(payload); }
    close() { this.readyState = 3; this.emit("close"); }
  }
  return { FakeWs, instances };
}

test("ws client connects with Bearer token handshake header", async () => {
  const { FakeWs, instances } = makeFakeWsClass();
  const client = createTossWsClient({ getToken: async () => "tok-123", WebSocketImpl: FakeWs });
  await client.connect();
  assert.equal(instances.length, 1);
  assert.equal(instances[0].url, WS_URL);
  assert.equal(instances[0].opts.headers.Authorization, "Bearer tok-123");
  client.close();
});

test("subscribe sends full-replace JSON array declaration and acks arrive", async () => {
  const { FakeWs, instances } = makeFakeWsClass();
  let acked = null;
  const client = createTossWsClient({ getToken: async () => "t", WebSocketImpl: FakeWs, onSubscriptions: f => { acked = f; } });
  await client.connect();
  const ws = instances[0];
  ws.readyState = 1;
  ws.emit("open");
  client.subscribe([{ type: "trade:us", codes: ["AAPL"] }, { type: "personal:order", codes: ["1"] }]);
  assert.equal(ws.sent.length, 1);
  const declared = JSON.parse(ws.sent[0]);
  assert.equal(declared.length, 2);
  assert.equal(declared[0].type, "trade:us");
  ws.emit("message", JSON.stringify({ type: "subscriptions", subscribed: ["trade:us:AAPL"], rejected: [] }));
  assert.ok(acked);
  assert.deepEqual(acked.subscribed, ["trade:us:AAPL"]);
  client.close();
});

test("ping keepalive fires at configured interval", async () => {
  const { FakeWs, instances } = makeFakeWsClass();
  const client = createTossWsClient({ getToken: async () => "t", WebSocketImpl: FakeWs, pingIntervalMs: 30 });
  await client.connect();
  const ws = instances[0];
  ws.readyState = 1;
  ws.emit("open");
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(ws.sent.filter(p => p === "PING").length >= 2, `expected >=2 PINGs, got ${ws.sent.filter(p => p === "PING").length}`);
  ws.emit("message", JSON.stringify({ type: "pong" }));
  client.close();
});

test("message and error frames are routed to callbacks", async () => {
  const { FakeWs, instances } = makeFakeWsClass();
  const messages = [];
  const errors = [];
  const client = createTossWsClient({
    getToken: async () => "t", WebSocketImpl: FakeWs,
    onMessage: f => messages.push(f), onError: f => errors.push(f),
  });
  await client.connect();
  const ws = instances[0];
  ws.emit("message", JSON.stringify({ type: "message", topic: "personal:order:1", data: { orderId: "o-1" } }));
  ws.emit("message", JSON.stringify({ type: "error", error: { code: "rate-limit-exceeded" } }));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].topic, "personal:order:1");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error.code, "rate-limit-exceeded");
  client.close();
});

test("unexpected disconnect requests order resync; user close does not", async () => {
  const { FakeWs, instances } = makeFakeWsClass();
  let resyncs = 0;
  const client = createTossWsClient({ getToken: async () => "t", WebSocketImpl: FakeWs, onNeedResync: () => { resyncs += 1; } });
  await client.connect();
  const ws = instances[0];
  ws.readyState = 1;
  ws.emit("open");
  // unexpected drop → LOSSLESS events lost → resync needed
  ws.readyState = 3;
  ws.emit("close");
  assert.equal(resyncs, 1);
  // user-initiated close → no resync
  client.close();
  assert.equal(resyncs, 1);
});

test("default ping interval is 60s per Toss guidance", () => {
  assert.equal(DEFAULT_PING_INTERVAL_MS, 60000);
});

test("socket_error frames are routed to onError callback", async () => {
  const { FakeWs, instances } = makeFakeWsClass();
  const errors = [];
  const client = createTossWsClient({
    getToken: async () => "t", WebSocketImpl: FakeWs,
    onError: f => errors.push(f),
  });
  await client.connect();
  const ws = instances[0];
  // Simulate a socket-level error (e.g., network failure, handshake rejection)
  ws.emit("error", new Error("Unexpected server response: 401"));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].type, "error");
  assert.equal(errors[0].error.code, "socket_error");
  assert.match(errors[0].error.message, /Unexpected server response: 401/);
  client.close();
});
