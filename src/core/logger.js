"use strict";

function maskSecret(s) {
  if (!s) return s;
  const str = String(s);
  if (str.length <= 8) return "****";
  return str.slice(0, 4) + "****" + str.slice(-4);
}

function toAudit(input = {}, result = {}, meta = {}) {
  const audit = {
    ts: new Date().toISOString(),
    op: input.operation,
    symbol: input.symbol,
    side: input.side,
    accountSeq: input.target?.accountSeq ?? input.accountSeq,
    dryRun: !!(input.dryRun ?? input.dry_run),
    simulated: !!result.simulated,
  };
  if (input.quantity != null) audit.quantity = input.quantity;
  if (input.price != null) audit.price = input.price;
  if (result.orderId != null) audit.orderId = result.orderId;
  if (result.http_status != null) audit.http_status = result.http_status;
  if (result.code != null) audit.code = result.code;
  if (result.status != null) audit.status = result.status;
  if (meta.durationMs != null) audit.duration_ms = meta.durationMs;
  if (meta.idempotencyKey != null) audit.idempotency_key = meta.idempotencyKey;
  return audit;
}

module.exports = { toAudit, maskSecret };
