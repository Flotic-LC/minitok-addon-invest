"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { atomicWriteFileSync } = require("../src/core/atomic-write");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "atomic-write-test-"));
}

test("atomicWriteFileSync creates file with correct content", () => {
  const dir = makeTempDir();
  const target = path.join(dir, "state.json");
  const content = JSON.stringify({ phase: 1, equity: 1000000 }, null, 2);
  const result = atomicWriteFileSync(target, content);
  assert.equal(result.ok, true);
  assert.equal(result.method, "rename");
  assert.equal(result.bytes, Buffer.byteLength(content, "utf8"));
  assert.equal(fs.readFileSync(target, "utf8"), content);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("atomicWriteFileSync creates parent directories", () => {
  const dir = makeTempDir();
  const target = path.join(dir, "nested", "deep", "state.json");
  const result = atomicWriteFileSync(target, "hello");
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(target, "utf8"), "hello");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("atomicWriteFileSync overwrites existing file atomically", () => {
  const dir = makeTempDir();
  const target = path.join(dir, "state.json");
  fs.writeFileSync(target, "old content", "utf8");
  const result = atomicWriteFileSync(target, "new content");
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(target, "utf8"), "new content");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("atomicWriteFileSync leaves no temp files on success", () => {
  const dir = makeTempDir();
  const target = path.join(dir, "state.json");
  atomicWriteFileSync(target, "data");
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  assert.equal(files[0], "state.json");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("atomicWriteFileSync verifies file size", () => {
  const dir = makeTempDir();
  const target = path.join(dir, "state.json");
  const content = "x".repeat(1000);
  const result = atomicWriteFileSync(target, content, { verify: true });
  assert.equal(result.ok, true);
  assert.equal(result.bytes, 1000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("atomicWriteFileSync handles unicode content", () => {
  const dir = makeTempDir();
  const target = path.join(dir, "state.json");
  const content = JSON.stringify({ symbol: "삼성전자", note: "매수 추천 📈" });
  const result = atomicWriteFileSync(target, content);
  assert.equal(result.ok, true);
  const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.equal(parsed.symbol, "삼성전자");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("atomicWriteFileSync handles empty content", () => {
  const dir = makeTempDir();
  const target = path.join(dir, "empty.json");
  const result = atomicWriteFileSync(target, "");
  assert.equal(result.ok, true);
  assert.equal(result.bytes, 0);
  assert.equal(fs.readFileSync(target, "utf8"), "");
  fs.rmSync(dir, { recursive: true, force: true });
});
