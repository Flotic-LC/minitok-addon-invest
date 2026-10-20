"use strict";

/**
 * Toss Securities Open API WebSocket client (실시간 체결·호가·주문 이벤트).
 *
 * Spec source: https://openapi.tossinvest.com/openapi-docs/overview.md
 * - URL: wss://openapi-ws.tossinvest.com/ws/v1 (Authorization: Bearer header)
 * - Subscribe: send a JSON array (full-replace) of { type, codes }
 *   e.g. [{"type":"trade:us","codes":["AAPL"]},
 *         {"type":"orderbook:kr","codes":["005930"]},
 *         {"type":"personal:order","codes":["<accountSeq>"]}]
 * - Keepalive: server drops connections after 180s without client traffic;
 *   send text "PING" every 60s (server replies {"type":"pong"}).
 * - Frames: subscriptions (ack) / message (data) / error / pong
 * - personal:order is LOSSLESS per session; after reconnect resync orders
 *   via GET /api/v1/orders (exposed here as onNeedResync callback).
 * - Limits: 2 connections/account, 100 topics/connection, 5 declarations/sec.
 *
 * The `ws` package is used because Node's built-in WebSocket cannot send
 * custom handshake headers (Authorization). Tests may inject a fake
 * implementation via options.WebSocketImpl.
 */

const WS_URL = "wss://openapi-ws.tossinvest.com/ws/v1";
const DEFAULT_PING_INTERVAL_MS = 60_000;

// The `ws` package is only needed when no implementation is injected. Loading it
// lazily keeps this module usable in environments that inject a fake (the unit
// tests) without requiring the native dependency to be installed.
function loadWsLib() {
  try { return require("ws"); } catch (e) { return null; }
}

function createTossWsClient(options = {}) {
  const { getToken, onOpen, onMessage, onSubscriptions, onError, onPong, onNeedResync, onClose, pingIntervalMs = DEFAULT_PING_INTERVAL_MS, WebSocketImpl: InjectedWs, autoReconnect = true, maxReconnectDelayMs = 300000 } = options;
  if (typeof getToken !== "function") throw new TypeError("createTossWsClient: getToken function is required");

  const Impl = InjectedWs || loadWsLib();
  if (!Impl) throw new TypeError("createTossWsClient: the 'ws' package is required when WebSocketImpl is not provided");
  let ws = null;
  let pingTimer = null;
  let subscriptions = [];
  let closedByUser = false;
  let connected = false;
  let reconnectTimer = null;
  let reconnectAttempts = 0;

  function sendPayload(payload) {
    if (ws && ws.readyState === 1 /* OPEN */) ws.send(payload);
  }

  function declareSubscriptions() {
    if (subscriptions.length) sendPayload(JSON.stringify(subscriptions));
  }

  function clearReconnectTimer() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  }

  function scheduleReconnect() {
    if (!autoReconnect || closedByUser) return;
    clearReconnectTimer();
    reconnectAttempts++;
    const delay = Math.min(Math.pow(2, reconnectAttempts) * 1000, maxReconnectDelayMs);
    reconnectTimer = setTimeout(async () => {
      try { await connect(); } catch { /* error handlers inside connect will retry */ }
    }, delay);
    if (reconnectTimer.unref) reconnectTimer.unref();
  }

  let connectPromise = null;
  let connectGeneration = 0;

  function connect() {
    if (connectPromise) return connectPromise;
    connectPromise = _connectInternal().finally(function() { connectPromise = null; });
    return connectPromise;
  }

  async function _connectInternal() {
    const gen = ++connectGeneration;
    closedByUser = false;
    clearReconnectTimer();
    if (ws) { try { ws.close(); } catch { /* already closed */ } ws = null; }
    const token = await getToken();
    if (gen !== connectGeneration || closedByUser) return null;
    ws = new Impl(WS_URL, { headers: { Authorization: `Bearer ${token}` } });

    ws.on("open", () => {
      connected = true;
      reconnectAttempts = 0;
      declareSubscriptions();
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => sendPayload("PING"), pingIntervalMs);
      if (pingTimer.unref) pingTimer.unref();
      if (onOpen) onOpen();
    });

    ws.on("message", raw => {
      let frame;
      try { frame = JSON.parse(String(raw)); } catch { return; }
      switch (frame.type) {
        case "subscriptions": if (onSubscriptions) onSubscriptions(frame); break;
        case "message":
          if (onMessage) {
            try {
              const result = onMessage(frame);
              // Safely catch rejections from async onMessage handlers to prevent
              // unhandled promise rejections from crashing the process.
              if (result && typeof result.catch === "function") {
                result.catch(err => {
                  if (onError) onError({ type: "error", error: { code: "async_message_handler_error", message: err.message || String(err) } });
                });
              }
            } catch (err) {
              if (onError) onError({ type: "error", error: { code: "message_handler_error", message: err.message || String(err) } });
            }
          }
          break;
        case "error": if (onError) onError(frame); break;
        case "pong": if (onPong) onPong(frame); break;
        default: break;
      }
    });

    ws.on("close", () => {
      const wasUserInitiated = closedByUser;
      connected = false;
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      if (onClose) onClose({ user_initiated: wasUserInitiated });
      if (!wasUserInitiated) {
        // [FIX] Signal that LOSSLESS events (personal:order) may have been
        // lost during the disconnect. The caller (runner.js) is responsible
        // for deciding when to perform the actual REST resync — typically
        // delayed until after reconnect succeeds to avoid revoking the WS
        // token mid-handshake.
        if (onNeedResync) {
          try {
            const result = onNeedResync();
            if (result && typeof result.catch === "function") {
              result.catch(e => {
                if (onError) onError({ type: "error", error: { code: "async_resync_callback_error", message: e.message || String(e) } });
              });
            }
          } catch (e) {
            if (onError) onError({ type: "error", error: { code: "resync_callback_error", message: e.message } });
          }
        }
        scheduleReconnect();
      }
    });

    ws.on("error", err => { if (onError) onError({ type: "error", error: { code: "socket_error", message: err.message } }); });
    return ws;
  }

  /** Full-replace subscription declaration (server semantics). */
  function subscribe(subs) {
    subscriptions = Array.isArray(subs) ? subs : [subs];
    declareSubscriptions();
  }

  function close() {
    closedByUser = true;
    connectGeneration++;
    clearReconnectTimer();
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (ws) { try { ws.close(); } catch { /* already closed */ } ws = null; }
    connected = false;
  }

  return {
    connect,
    subscribe,
    close,
    isOpen: () => connected,
    getSubscriptions: () => [...subscriptions],
    getReconnectAttempts: () => reconnectAttempts,
  };
}

module.exports = { WS_URL, DEFAULT_PING_INTERVAL_MS, createTossWsClient };