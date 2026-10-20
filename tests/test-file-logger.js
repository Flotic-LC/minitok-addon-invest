"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createFileLogger } = require("../src/core/file-logger");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "file-logger-test-"));
}

test("createFileLogger hooks console and writes to daily file", () => {
  const dir = makeTempDir();
  const logger = createFileLogger({ dir, enabled: true });
  const stats = logger.stats();
  assert.equal(stats.enabled, true);
  assert.equal(stats.dir, dir);

  console.log("test info message");
  console.warn("test warn message");
  console.error("test error message");

  logger.close();

  // Verify files were created
  const files = fs.readdirSync(dir);
  const logFile = files.find(f => f.endsWith(".log") && !f.includes(".err."));
  const errFile = files.find(f => f.includes(".err."));
  assert.ok(logFile, "combined log file should exist");
  assert.ok(errFile, "error log file should exist");

  const logContent = fs.readFileSync(path.join(dir, logFile), "utf8");
  assert.ok(logContent.includes("test info message"));
  assert.ok(logContent.includes("test warn message"));
  assert.ok(logContent.includes("test error message"));

  const errContent = fs.readFileSync(path.join(dir, errFile), "utf8");
  assert.ok(errContent.includes("test error message"));
  assert.ok(!errContent.includes("test info message"));

  fs.rmSync(dir, { recursive: true, force: true });
});

test("createFileLogger restores console on close", () => {
  const dir = makeTempDir();
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;

  const logger = createFileLogger({ dir, enabled: true });
  assert.notEqual(console.log, origLog);
  logger.close();
  assert.equal(console.log, origLog);
  assert.equal(console.warn, origWarn);
  assert.equal(console.error, origError);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("createFileLogger disabled returns noop", () => {
  const logger = createFileLogger({ enabled: false });
  const stats = logger.stats();
  assert.equal(stats.enabled, false);
  logger.close(); // should not throw
  assert.equal(logger.prune(), 0);
});

test("createFileLogger prune removes old files", () => {
  const dir = makeTempDir();
  // Create a fake old log file
  const oldDate = "2020-01-01";
  fs.writeFileSync(path.join(dir, `bot-${oldDate}.log`), "old data");
  fs.writeFileSync(path.join(dir, `bot-${oldDate}.err.log`), "old errors");

  const logger = createFileLogger({ dir, enabled: true, maxAgeDays: 1 });
  const removed = logger.prune();
  logger.close();

  assert.equal(removed, 2);
  const files = fs.readdirSync(dir);
  assert.ok(!files.some(f => f.includes("2020-01-01")));

  fs.rmSync(dir, { recursive: true, force: true });
});

test("createFileLogger stats tracks bytes and lines", () => {
  const dir = makeTempDir();
  const logger = createFileLogger({ dir, enabled: true });

  console.log("hello world");
  console.log("second line");

  const stats = logger.stats();
  assert.ok(stats.linesWritten >= 2);
  assert.ok(stats.bytesWritten > 0);

  logger.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
