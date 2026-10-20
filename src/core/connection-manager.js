"use strict";

/**
 * Connection state machine — manages WebSocket/API connection lifecycle
 * with explicit states, exponential backoff, and circuit breaker.
 *
 * States:
 *   IDLE → CONNECTING → CONNECTED → RECONNECTING → FAILED → HALTED
 *
 * Transitions:
 *   IDLE       → CONNECTING   (connect() called)
 *   CONNECTING → CONNECTED    (connection established)
 *   CONNECTING → RECONNECTING (connection failed, retries remain)
 *   CONNECTED  → RECONNECTING (connection lost)
 *   RECONNECTING → CONNECTING (retry attempt)
 *   RECONNECTING → FAILED     (max retries exceeded)
 *   FAILED     → CONNECTING   (manual reset or cooldown expired)
 *   FAILED     → HALTED       (circuit breaker tripped)
 *   HALTED     → CONNECTING   (manual resume)
 *
 * Usage:
 *   const { createConnectionManager } = require("./connection-manager");
 *   const cm = createConnectionManager({
 *     connectFn: async () => wsClient.connect(),
 *     disconnectFn: () => wsClient.close(),
 *     onStateChange: (from, to) => console.log(`${from} → ${to}`),
 *   });
 *   await cm.connect();
 *   cm.reportDisconnect(); // triggers reconnect logic
 */

const STATES = Object.freeze({
  IDLE: "IDLE",
  CONNECTING: "CONNECTING",
  CONNECTED: "CONNECTED",
  RECONNECTING: "RECONNECTING",
  FAILED: "FAILED",
  HALTED: "HALTED",
});

const DEFAULTS = Object.freeze({
  maxRetries: Number(process.env.CONN_MAX_RETRIES || 10),
  baseBackoffMs: Number(process.env.CONN_BASE_BACKOFF_MS || 1000),
  maxBackoffMs: Number(process.env.CONN_MAX_BACKOFF_MS || 300000),
  backoffMultiplier: Number(process.env.CONN_BACKOFF_MULT || 2),
  circuitBreakerThreshold: Number(process.env.CONN_CB_THRESHOLD || 5),
  circuitBreakerCooldownMs: Number(process.env.CONN_CB_COOLDOWN_MS || 600000),
  heartbeatIntervalMs: Number(process.env.CONN_HEARTBEAT_MS || 30000),
});

function createConnectionManager(options = {}) {
  const {
    connectFn,
    disconnectFn,
    onStateChange,
    onConnected,
    onDisconnected,
    onFailed,
    onHalted,
    maxRetries = DEFAULTS.maxRetries,
    baseBackoffMs = DEFAULTS.baseBackoffMs,
    maxBackoffMs = DEFAULTS.maxBackoffMs,
    backoffMultiplier = DEFAULTS.backoffMultiplier,
    circuitBreakerThreshold = DEFAULTS.circuitBreakerThreshold,
    circuitBreakerCooldownMs = DEFAULTS.circuitBreakerCooldownMs,
    now = () => Date.now(),
  } = options;

  let state = STATES.IDLE;
  let retryCount = 0;
  let totalDisconnects = 0;
  let consecutiveFailures = 0;
  let lastConnectedAt = null;
  let lastDisconnectedAt = null;
  let lastStateChangeAt = now();
  let circuitOpen = false;
  let circuitOpenedAt = null;
  let reconnectTimer = null;

  function setState(newState) {
    const prev = state;
    state = newState;
    lastStateChangeAt = now();
    if (onStateChange) onStateChange(prev, newState);
  }

  function getBackoffMs() {
    const delay = baseBackoffMs * Math.pow(backoffMultiplier, retryCount);
    return Math.min(delay, maxBackoffMs);
  }

  function clearTimer() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  }

  async function connect() {
    if (state === STATES.HALTED) {
      throw new Error("Connection manager is halted. Call resume() first.");
    }
    if (circuitOpen) {
      const elapsed = now() - circuitOpenedAt;
      if (elapsed < circuitBreakerCooldownMs) {
        return false; // Still in cooldown
      }
      circuitOpen = false; // Allow probe
    }

    setState(STATES.CONNECTING);
    try {
      if (connectFn) await connectFn();
      setState(STATES.CONNECTED);
      retryCount = 0;
      consecutiveFailures = 0;
      lastConnectedAt = now();
      if (onConnected) onConnected();
      return true;
    } catch (e) {
      consecutiveFailures++;
      if (consecutiveFailures >= circuitBreakerThreshold) {
        circuitOpen = true;
        circuitOpenedAt = now();
        setState(STATES.HALTED);
        if (onHalted) onHalted(e);
        return false;
      }
      setState(STATES.RECONNECTING);
      scheduleReconnect();
      return false;
    }
  }

  function scheduleReconnect() {
    clearTimer();
    if (retryCount >= maxRetries) {
      setState(STATES.FAILED);
      if (onFailed) onFailed(new Error("max retries exceeded"));
      return;
    }
    const delay = getBackoffMs();
    retryCount++;
    reconnectTimer = setTimeout(() => {
      connect().catch(() => {});
    }, delay);
    if (reconnectTimer.unref) reconnectTimer.unref();
  }

  function reportDisconnect(reason = "unknown") {
    if (state !== STATES.CONNECTED) return;
    totalDisconnects++;
    lastDisconnectedAt = now();
    setState(STATES.RECONNECTING);
    if (onDisconnected) onDisconnected(reason);
    scheduleReconnect();
  }

  function disconnect() {
    clearTimer();
    if (disconnectFn) {
      try { disconnectFn(); } catch {}
    }
    setState(STATES.IDLE);
    retryCount = 0;
  }

  function resume() {
    if (state !== STATES.HALTED && state !== STATES.FAILED) return false;
    circuitOpen = false;
    circuitOpenedAt = null;
    retryCount = 0;
    consecutiveFailures = 0;
    setState(STATES.IDLE);
    return true;
  }

  function reset() {
    clearTimer();
    state = STATES.IDLE;
    retryCount = 0;
    totalDisconnects = 0;
    consecutiveFailures = 0;
    circuitOpen = false;
    circuitOpenedAt = null;
    lastConnectedAt = null;
    lastDisconnectedAt = null;
  }

  function status() {
    return {
      state,
      retryCount,
      maxRetries,
      totalDisconnects,
      consecutiveFailures,
      circuitOpen,
      lastConnectedAt,
      lastDisconnectedAt,
      lastStateChangeAt,
      backoffMs: state === STATES.RECONNECTING ? getBackoffMs() : 0,
    };
  }

  return {
    connect,
    disconnect,
    reportDisconnect,
    resume,
    reset,
    status,
    STATES,
  };
}

module.exports = { createConnectionManager, STATES, DEFAULTS };
