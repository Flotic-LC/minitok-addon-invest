"use strict";
// Stub in-process admin module.
// The full watchdog now runs in a dedicated minitok-admin container (Dockerfile.admin).
// This stub satisfies runner.js require() so the bot can start without the legacy in-process module.

function createSentinel(opts) {
  var _logCount = 0;
  var _startedAt = 0;

  function ingestLog(line) {
    _logCount++;
    // No-op: log ingestion is now handled by the external sentinel container
    // which reads the bot log file via shared volume.
  }

  function start() {
    _startedAt = Date.now();
    console.log("[admin-stub] passive mode - external admin container is authoritative");
  }

  function stats() {
    return {
      startedAt: _startedAt,
      logCount: _logCount,
      mode: "stub"
    };
  }

  return {
    ingestLog: ingestLog,
    start: start,
    stats: stats
  };
}

module.exports = { createSentinel: createSentinel };
