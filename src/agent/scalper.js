// scalper.js — Hybrid rule-based scalper (sub-second reaction, no LLM in the hot path).
//
// Architecture:
//   - AI (LLM) supervises: enables/disables the scalper per symbol and tunes params.
//   - Rule engine (this module) executes: on each WS tick, evaluates cheap numeric
//     conditions in <1ms and, if armed, emits an immediate order decision.
//
// Safety: scalper only fires when (a) globally enabled, (b) armed for the symbol by AI
// or config, (c) within a daily fire-count budget, (d) price-move trigger exceeded.

const SCALPER_ENABLED = String(process.env.SCALPER_ENABLED || "false") === "true";
const SCALPER_DEFAULT_ARMED = String(process.env.SCALPER_DEFAULT_ARMED || "false") === "true";
const SCALPER_MAX_FIRES_PER_DAY = Number(process.env.SCALPER_MAX_FIRES_PER_DAY || 20);
const SCALPER_TRIGGER_PCT = Number(process.env.SCALPER_TRIGGER_PCT || 0.6); // % move vs last tick
const SCALPER_COOLDOWN_MS = Number(process.env.SCALPER_COOLDOWN_MS || 15000);
const SCALPER_WINDOW_MS = Number(process.env.SCALPER_WINDOW_MS || 8000); // price window
const SCALPER_MIN_TICKS = Number(process.env.SCALPER_MIN_TICKS || 3);
const SCALPER_TAKE_PCT = Number(process.env.SCALPER_TAKE_PCT || 0.9);
const SCALPER_STOP_PCT = Number(process.env.SCALPER_STOP_PCT || -0.5);
const SCALPER_MAX_POSITION_PCT = Number(process.env.SCALPER_MAX_POSITION_PCT || 10); // % equity per scalp

// Per-symbol state
const state = new Map(); // sym -> { armed, ticks: [{p, ts}], lastFireAt, firesToday, day, openScalp }

function today() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

function getState(sym) {
  if (!state.has(sym)) {
    state.set(sym, {
      armed: SCALPER_DEFAULT_ARMED,
      ticks: [],
      lastFireAt: 0,
      firesToday: 0,
      day: today(),
      openScalp: null, // { entryPrice, qty, entryAt }
    });
  }
  const s = state.get(sym);
  if (s.day !== today()) { // reset daily budget
    s.day = today();
    s.firesToday = 0;
    s.openScalp = null;
  }
  return s;
}

// --- AI supervision API ---
function arm(sym, params) {
  const s = getState(sym);
  s.armed = true;
  if (params && typeof params === "object") {
    if (params.triggerPct != null) s.triggerPct = Number(params.triggerPct);
    if (params.takePct != null) s.takePct = Number(params.takePct);
    if (params.stopPct != null) s.stopPct = Number(params.stopPct);
  }
  return { armed: true, symbol: sym };
}

function disarm(sym) {
  const s = getState(sym);
  s.armed = false;
  return { armed: false, symbol: sym };
}

function isArmed(sym) {
  return getState(sym).armed;
}

function status() {
  const out = [];
  for (const [sym, s] of state.entries()) {
    out.push({ symbol: sym, armed: s.armed, firesToday: s.firesToday, openScalp: !!s.openScalp });
  }
  return { enabled: SCALPER_ENABLED, maxFiresPerDay: SCALPER_MAX_FIRES_PER_DAY, symbols: out };
}

// --- Hot-path tick evaluation (must stay <1ms, no async, no LLM) ---
// Returns a decision object or null.
function onTick(sym, price, opts) {
  if (!SCALPER_ENABLED) return null;
  if (price == null || !(price > 0)) return null;
  const s = getState(sym);
  const now = Date.now();

  // Maintain a rolling tick window
  s.ticks.push({ p: price, ts: now });
  while (s.ticks.length > 0 && now - s.ticks[0].ts > SCALPER_WINDOW_MS) s.ticks.shift();

  // If a scalp position is open, manage exit (take/stop)
  if (s.openScalp) {
    const entry = s.openScalp.entryPrice;
    const pnlPct = ((price - entry) / entry) * 100;
    const take = s.takePct != null ? s.takePct : SCALPER_TAKE_PCT;
    const stop = s.stopPct != null ? s.stopPct : SCALPER_STOP_PCT;
    if (pnlPct >= take || pnlPct <= stop) {
      const qty = s.openScalp.qty;
      const reason = pnlPct >= take ? "scalp_take_profit" : "scalp_stop";
      s.openScalp = null;
      return { action: "SELL", symbol: sym, quantity: qty, price: price, reason: reason + "_" + pnlPct.toFixed(2) + "pct", strategy: "scalper" };
    }
    return null; // holding open scalp, wait
  }

  // Entry gating
  if (!s.armed) return null;
  if (s.firesToday >= SCALPER_MAX_FIRES_PER_DAY) return null;
  if (now - s.lastFireAt < SCALPER_COOLDOWN_MS) return null;
  if (s.ticks.length < SCALPER_MIN_TICKS) return null;

  // Trigger: % move within the window vs earliest tick
  const first = s.ticks[0].p;
  const movePct = ((price - first) / first) * 100;
  const trigger = s.triggerPct != null ? s.triggerPct : SCALPER_TRIGGER_PCT;
  if (Math.abs(movePct) < trigger) return null;

  // Position sizing: % of equity in native price units (caller converts if needed)
  const equityKrw = opts && opts.equityKrw ? opts.equityKrw : 0;
  const fxRate = opts && opts.fxRate ? opts.fxRate : 1; // native->KRW
  const priceKrw = price * fxRate;
  let qty = 0;
  if (equityKrw > 0 && priceKrw > 0) {
    const budgetKrw = equityKrw * (SCALPER_MAX_POSITION_PCT / 100);
    qty = Math.floor(budgetKrw / priceKrw);
  }
  if (qty < 1) return null;

  const dir = movePct > 0 ? "up" : "down";
  // Downward scalp: no naked short on equities; do NOT consume fire budget/cooldown
  if (movePct <= 0) {
    return null;
  }
  // Fire a scalp entry in the direction of the move (momentum scalp)
  s.lastFireAt = now;
  s.firesToday++;
  s.openScalp = { entryPrice: price, qty: qty, entryAt: now };
  return { action: "BUY", symbol: sym, quantity: qty, price: price, reason: "scalp_momentum_" + dir + "_" + movePct.toFixed(2) + "pct", strategy: "scalper" };
}

module.exports = {
  onTick,
  arm,
  disarm,
  isArmed,
  status,
  _config: {
    SCALPER_ENABLED, SCALPER_MAX_FIRES_PER_DAY, SCALPER_TRIGGER_PCT,
    SCALPER_COOLDOWN_MS, SCALPER_TAKE_PCT, SCALPER_STOP_PCT, SCALPER_MAX_POSITION_PCT,
  },
};
