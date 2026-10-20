"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createStore, kstDateString } = require("../src/store");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "store-test-"));
}

test("append + query round-trip with type filter", () => {
  const dir = tmpDir();
  const store = createStore({ dir });
  store.append("FILL", { symbol: "005930", side: "BUY", netPnl: null });
  store.append("FILL", { symbol: "005930", side: "SELL", netPnl: 98035 });
  store.append("JOURNAL", { note: "test" });

  const all = store.query({});
  assert.equal(all.length, 3);
  assert.ok(all[0].ts <= all[2].ts); // chronological

  const fills = store.query({ types: ["FILL"] });
  assert.equal(fills.length, 2);
  assert.equal(fills[1].netPnl, 98035);
});

test("query respects limit (newest kept)", () => {
  const dir = tmpDir();
  const store = createStore({ dir });
  for (let i = 0; i < 10; i++) store.append("T", { i });
  const out = store.query({ limit: 3 });
  assert.equal(out.length, 3);
  assert.equal(out[2].i, 9);
  assert.equal(out[0].i, 7);
});

test("empty store queries cleanly", () => {
  const dir = path.join(os.tmpdir(), "store-nonexistent-" + process.pid);
  const store = createStore({ dir });
  assert.deepEqual(store.query({}), []);
  assert.deepEqual(store.listFiles(), []);
});

test("kstDateString uses UTC+9", () => {
  // 2026-01-01T20:00:00Z = 2026-01-02 05:00 KST
  assert.equal(kstDateString(new Date("2026-01-01T20:00:00Z")), "2026-01-02");
  assert.equal(kstDateString(new Date("2026-01-01T10:00:00Z")), "2026-01-01");
});
