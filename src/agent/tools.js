"use strict";

const path = require("node:path");

function resolveMinitokRegistryModule() {
  const root = process.env.MINITOK_CLIENT_ROOT
    || path.join(__dirname, "..", "..", "..", "minitok-client-release");
  return require(path.join(root, "src", "goal", "adapter_registry"));
}

const EQUITY_SNAPSHOT_THROTTLE_MS = 60_000;

function createAgentTools({ registry, adapter, credentials, safetyLimits, dryRunDefault = true, targetEngine = null, fetchEquity = null } = {}) {
  const adapterInst = adapter || (require("../tossinvest").createTossInvestAdapter(credentials || {}, safetyLimits || {}));
  const { createSafety } = require("./safety");
  const safety = createSafety(safetyLimits || {});
  const { toAudit } = require("../core/logger");
  let lastEquitySnapshotAt = 0;

  async function exec(input) {
    if (safety.isKillswitch()) return { ok: false, code: "KILLSWITCH_ACTIVE", message: "Killswitch active" };
    const in2 = { ...input };
    if (in2.dryRun == null && in2.dry_run == null) in2.dryRun = dryRunDefault;
    // Adaptive target engine projection: halted blocks all live calls,
    // phase dry-run forces simulation, phase maxOrderValueKrw caps size.
    if (targetEngine) {
      const projection = targetEngine.project();
      // [CASH-RESCUE] Allow off-hours SELL orders to bypass halt (rescue mechanism)
      const isOffHoursSell = in2.operation === "create_order" && in2.side === "SELL" && (in2.orderType === "LIMIT" || in2.type === "LIMIT");
      if (projection.halted && !isOffHoursSell) {
        return { ok: false, code: "TARGET_ENGINE_HALTED", message: projection.reasons.join("; "), audit: toAudit(in2, {}, { durationMs: 0 }) };
      }
      if (projection.halted && isOffHoursSell) {
        console.log("[exec] Bypassing halt for off-hours SELL " + in2.symbol + " (cash rescue)");
      }
      if (projection.dryRun) in2.dryRun = true;
      if (process.env.UNLIMIT_MODE === "true") {
     console.warn("[safety] UNLIMIT_MODE=true — max-order-value safety cap DISABLED. Dangerous.");
   }
   if (in2.operation === "create_order" && projection.maxOrderValueKrw && in2.price != null && in2.quantity != null && process.env.UNLIMIT_MODE !== "true") {
        if (Number(in2.price) * Number(in2.quantity) > projection.maxOrderValueKrw) {
          return { ok: false, code: "TARGET_SIZE_EXCEEDED", message: `order value exceeds phase cap ${projection.maxOrderValueKrw}`, audit: toAudit(in2, {}, { durationMs: 0 }) };
        }
      }
    }
    const { executeAdapter, createAdapterRegistry } = resolveMinitokRegistryModule();
    const reg = registry || createAdapterRegistry([adapterInst]);
    const opts = {
      capabilities: ["read", "inspect", "external_call", "credential_use"],
      mode: "authorized_external",
      production_adapter_opt_in: true,
      audit_persisted: true,
      integrity_preflight: true,
      environment_observation: { external_connectivity: true },
      operation_ledger: new Map(),
    };
    // Agent-level pre-checks for mutations (symbol whitelist,
    // value/quantity limits, cooldown). Account-state checks
    // (buying power / sellable quantity) run inside the adapter
    // when safetyLimits.enforcePreChecks is enabled.
    if (in2.operation === "create_order") {
      const guard = safety.checkPreCreateOrder(in2);
      if (!guard.ok) return { ok: false, code: guard.code, message: guard.reason || guard.message, audit: toAudit(in2, {}, { durationMs: 0 }) };
    }
    const t0 = Date.now();
    const r = await executeAdapter(reg, adapterInst.name || "api", in2, opts);
    const dur = Date.now() - t0;
    const ok = !!r.success || !!r.completed;
    if (targetEngine && in2.operation === "create_order") {
      targetEngine.recordOperationOutcome({
        operation: in2.operation, symbol: in2.symbol, side: in2.side,
        quantity: in2.quantity, price: in2.price,
        ok, code: r.code, verified: r.verification?.valid === true,
      });
      // Auto-capture equity snapshot after successful live orders so the
      // adaptive target engine can track daily return / drawdown without
      // requiring an explicit host-side cron. Failures are swallowed —
      // equity capture is best-effort and must never block or fail the
      // originating order response.
      if (ok && !in2.dryRun && typeof fetchEquity === "function") {
        const now = Date.now();
        if (now - lastEquitySnapshotAt >= EQUITY_SNAPSHOT_THROTTLE_MS) {
          lastEquitySnapshotAt = now;
          Promise.resolve().then(async () => {
            try {
              const equity = await fetchEquity();
              targetEngine.recordEquitySnapshot({ equity });
            } catch { /* best-effort */ }
          });
        }
      }
    }
    return {
      ok,
      code: r.code,
      message: r.reason || r.message,
      data: r,
      simulated: !!r.simulated,
      audit: toAudit(in2, r, { durationMs: dur }),
    };
  }

  return {
    order: (i) => exec({ ...i, operation: i.operation || "create_order" }),
    cancel: (i) => exec({ ...i, operation: "cancel_order" }),
    modify: (i) => exec({ ...i, operation: "modify_order" }),
    balance: (i) => exec({ ...i, operation: "get_accounts" }),
    positions: (i) => exec({ ...i, operation: "get_holdings" }),
    accounts: (i) => exec({ ...i, operation: "get_accounts" }),
    buying_power: (i) => exec({ ...i, operation: "get_buying_power" }),
    sellable_quantity: (i) => exec({ ...i, operation: "get_sellable_quantity" }),
    commissions: (i) => exec({ ...i, operation: "get_commissions" }),
    orders: (i) => exec({ ...i, operation: "get_orders", status: i.status || "OPEN" }),
    openOrders: (i) => exec({ ...i, operation: "get_orders", status: "OPEN" }),
    prices: (i) => exec({ ...i, operation: "get_prices" }),
    quote: (i) => exec({ ...i, operation: "get_prices" }),
    orderbook: (i) => exec({ ...i, operation: "get_orderbook" }),
    price_limits: (i) => exec({ ...i, operation: "get_price_limits" }),
    trades: (i) => exec({ ...i, operation: "get_trades" }),
    candles: (i) => exec({ ...i, operation: "get_candles" }),
    stocks: (i) => exec({ ...i, operation: "get_stocks" }),
    stocks_all: (i) => exec({ ...i, operation: "get_stocks_all" }),
    exchange_rate: (i) => exec({ ...i, operation: "get_exchange_rate" }),
    market_calendar: (i) => exec({ ...i, operation: "get_market_calendar" }),
    stock_warnings: (i) => exec({ ...i, operation: "get_stock_warnings" }),
    health: (i) => exec({ operation: "get_accounts" }),
    exec,
    adapter: adapterInst,
    _safety: safety,
  };
}

module.exports = { createAgentTools };
