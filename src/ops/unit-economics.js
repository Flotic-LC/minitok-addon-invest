"use strict";

/**
 * Unit economics: what a customer costs, what they pay, and which usage
 * patterns destroy the margin.
 *
 * [2026-10-21 8단계] The add-on had no cost accounting of any kind. It
 * called a paid model API on every decision and threw the provider's token
 * usage away, called the broker API again for the order book on every
 * decision, wrote tens of megabytes of logs a day, and attributed none of it
 * to anybody. A price could not be set on evidence, so no price was set.
 *
 * Two rules hold throughout this module:
 *
 *   1. A cost that is not measured is an ESTIMATE and is labelled as one.
 *      The report separates the measured items from the estimated ones, and
 *      an account whose margin is only known because of estimates is
 *      flagged, not presented as profitable.
 *   2. A customer is never blocked for being expensive. The controls
 *      compare what the account is worth against what it costs, and the
 *      only hard stop is an abuse quota.
 */

/** The plan prices. The server is authoritative; these are the values used. */
const DEFAULT_PRICES = Object.freeze({
  level1: Object.freeze({ amount: 899, currency: "USD", interval: "month", source: "server" }),
  trial: Object.freeze({ amount: 0, currency: "USD", interval: "month", source: "server" }),
});

/**
 * The unit costs. Every one of them is a configured estimate until an
 * operator fills in a real figure; `source` says which.
 */
const DEFAULT_COSTS = Object.freeze({
  llm: Object.freeze({ perCall: 0, per1kTokens: 0, source: "estimated", label: "model API" }),
  broker: Object.freeze({ perCall: 0, source: "estimated", label: "broker API" }),
  marketData: Object.freeze({ perCall: 0, source: "estimated", label: "market data" }),
  notification: Object.freeze({ perMessage: 0, source: "estimated", label: "notifications" }),
  storage: Object.freeze({ perMbMonth: 0, source: "estimated", label: "storage" }),
  server: Object.freeze({ perCpuSecond: 0, perMemoryMbHour: 0, source: "estimated", label: "server compute" }),
  browser: Object.freeze({ perRun: 0, source: "estimated", label: "headless browser" }),
});

/** The usage types the segments are derived from. */
const SEGMENTS = Object.freeze({
  LOW_USAGE: "low_usage",
  HIGH_USAGE: "high_usage",
  HIGH_TRADE_FREQUENCY: "high_trade_frequency",
  HIGH_LLM_COST: "high_llm_cost",
  LONG_IDLE: "long_idle",
  BIG_LOSS: "big_loss",
});

/**
 * The per-account usage ledger.
 *
 * One instance per account. The counters are cumulative for the month and
 * are persisted with the rest of the runner state, so a restart does not
 * reset the month's cost.
 */
function createUsageLedger(options) {
  const opts = options || {};
  const now = opts.now || Date.now;
  let account = opts.account || "unknown";
  let month = opts.month || monthKey(now());

  const zero = function () {
    return {
      llmCalls: 0, llmPromptTokens: 0, llmCompletionTokens: 0, llmTotalTokens: 0,
      brokerCalls: 0, marketDataCalls: 0, notifications: 0, browserRuns: 0,
      trades: 0, realizedPnl: 0, logBytes: 0, cpuSeconds: 0, memoryMbHours: 0,
      brokerOps: {},
    };
  };

  const state = { account: account, month: month, usage: zero(), days: {}, lastActiveAt: 0 };

  function monthKey(ts) {
    return new Date(ts).toISOString().slice(0, 7);
  }

  function rollover(ts) {
    const key = monthKey(ts);
    if (key !== state.month) {
      // A new month starts a new ledger. The previous month is reported by
      // the report script from the persisted history.
      state.month = key;
      state.usage = zero();
      state.days = {};
    }
  }

  function dayKey(ts) {
    return new Date(ts).toISOString().slice(0, 10);
  }

  function touch(ts) {
    const d = dayKey(ts);
    if (!state.days[d]) state.days[d] = zero();
    state.days[d].lastActiveAt = ts;
    state.lastActiveAt = ts;
    return state.days[d];
  }

  const api = {
    /** The model API. `usage` is the provider's own token report. */
    llm: function (usage, meta) {
      const ts = (meta && meta.at) || now();
      rollover(ts);
      const day = touch(ts);
      const u = usage || {};
      const prompt = Number(u.prompt_tokens || 0) || 0;
      const completion = Number(u.completion_tokens || 0) || 0;
      const total = Number(u.total_tokens || 0) || (prompt + completion);
      state.usage.llmCalls++;
      state.usage.llmPromptTokens += prompt;
      state.usage.llmCompletionTokens += completion;
      state.usage.llmTotalTokens += total;
      day.llmCalls++;
      day.llmPromptTokens += prompt;
      day.llmCompletionTokens += completion;
      day.llmTotalTokens += total;
      return total;
    },
    /** A broker API call. */
    broker: function (op, meta) {
      const ts = (meta && meta.at) || now();
      rollover(ts);
      const day = touch(ts);
      state.usage.brokerCalls++;
      day.brokerCalls++;
      const key = String(op || "unknown");
      state.usage.brokerOps[key] = (state.usage.brokerOps[key] || 0) + 1;
      return key;
    },
    /** A market data call. */
    marketData: function (meta) {
      const ts = (meta && meta.at) || now();
      rollover(ts);
      const day = touch(ts);
      state.usage.marketDataCalls++;
      day.marketDataCalls++;
    },
    /** A notification. */
    notification: function (meta) {
      const ts = (meta && meta.at) || now();
      rollover(ts);
      const day = touch(ts);
      state.usage.notifications++;
      day.notifications++;
    },
    /** A headless browser run. */
    browser: function (meta) {
      const ts = (meta && meta.at) || now();
      rollover(ts);
      const day = touch(ts);
      state.usage.browserRuns++;
      day.browserRuns++;
    },
    /** A trade that filled. */
    trade: function (meta) {
      const ts = (meta && meta.at) || now();
      rollover(ts);
      const day = touch(ts);
      const pnl = Number(meta && meta.pnl) || 0;
      state.usage.trades++;
      state.usage.realizedPnl += pnl;
      day.trades++;
      day.realizedPnl += pnl;
    },
    /** Bytes written to the logs. */
    logBytes: function (bytes, meta) {
      const ts = (meta && meta.at) || now();
      rollover(ts);
      const day = touch(ts);
      const n = Number(bytes) || 0;
      state.usage.logBytes += n;
      day.logBytes += n;
    },
    snapshot: function () {
      return {
        account: state.account,
        month: state.month,
        usage: JSON.parse(JSON.stringify(state.usage)),
        days: JSON.parse(JSON.stringify(state.days)),
        lastActiveAt: state.lastActiveAt,
      };
    },
    restore: function (snap) {
      if (!snap || typeof snap !== "object") return false;
      if (snap.account) state.account = snap.account;
      if (snap.month) state.month = snap.month;
      if (snap.usage) state.usage = Object.assign(zero(), snap.usage);
      if (snap.days) state.days = snap.days;
      if (snap.lastActiveAt) state.lastActiveAt = snap.lastActiveAt;
      return true;
    },
    get account() { return state.account; },
    get month() { return state.month; },
  };
  return api;
}

/**
 * The cost of one account's usage.
 *
 * Every item is returned with its source so the report can separate what is
 * known from what is assumed.
 */
function computeCost(usage, costs) {
  const c = Object.assign({}, DEFAULT_COSTS, costs || {});
  const u = usage || {};
  const items = [];
  const add = function (key, label, amount, source, note) {
    items.push({ key: key, label: label, amount: Number(amount) || 0, source: source, note: note || null });
  };
  const llmCost = (Number(c.llm.perCall) || 0) * (Number(u.llmCalls) || 0)
    + (Number(c.llm.per1kTokens) || 0) * ((Number(u.llmTotalTokens) || 0) / 1000);
  add("llm", c.llm.label || "model API", llmCost, c.llm.source || "estimated", "per call plus per 1k tokens");
  add("broker", c.broker.label || "broker API", (Number(c.broker.perCall) || 0) * (Number(u.brokerCalls) || 0), c.broker.source || "estimated", "per call");
  add("marketData", c.marketData.label || "market data", (Number(c.marketData.perCall) || 0) * (Number(u.marketDataCalls) || 0), c.marketData.source || "estimated", "per call");
  add("notification", c.notification.label || "notifications", (Number(c.notification.perMessage) || 0) * (Number(u.notifications) || 0), c.notification.source || "estimated", "per message");
  add("storage", c.storage.label || "storage", (Number(c.storage.perMbMonth) || 0) * ((Number(u.logBytes) || 0) / (1024 * 1024)), c.storage.source || "estimated", "per MB written, monthly");
  add("server", c.server.label || "server compute",
    (Number(c.server.perCpuSecond) || 0) * (Number(u.cpuSeconds) || 0)
    + (Number(c.server.perMemoryMbHour) || 0) * (Number(u.memoryMbHours) || 0), c.server.source || "estimated", "cpu seconds plus memory MB-hours");
  add("browser", c.browser.label || "headless browser", (Number(c.browser.perRun) || 0) * (Number(u.browserRuns) || 0), c.browser.source || "estimated", "per launch");
  const total = items.reduce(function (s, i) { return s + i.amount; }, 0);
  const estimatedOnly = items.every(function (i) { return i.source === "estimated"; });
  return { items: items, total: total, estimatedOnly: estimatedOnly, measuredKeys: items.filter(function (i) { return i.source === "measured"; }).map(function (i) { return i.key; }) };
}

/**
 * Segment an account by how it uses (and loses) money.
 *
 * [2026-10-21 8단계] The segments are descriptive. They are what the
 * operator prices against: an account that is expensive because it trades a
 * lot is a different product problem from one that is expensive because its
 * prompt grew.
 */
function segmentAccount(usage, thresholds) {
  const t = Object.assign({
    lowUsageCalls: 20, highUsageCalls: 500, highTradeFrequency: 60,
    highLlmTokens: 500000, idleDays: 14, bigLossAbs: 500,
  }, thresholds || {});
  const u = usage || {};
  const segments = [];
  const reasons = [];
  const calls = Number(u.llmCalls) || 0;
  const tokens = Number(u.llmTotalTokens) || 0;
  const trades = Number(u.trades) || 0;
  const pnl = Number(u.realizedPnl) || 0;
  const lastActive = Number(u.lastActiveAt) || 0;

  if (calls > 0 && calls < t.lowUsageCalls) { segments.push(SEGMENTS.LOW_USAGE); reasons.push(calls + " model calls"); }
  if (calls > t.highUsageCalls) { segments.push(SEGMENTS.HIGH_USAGE); reasons.push(calls + " model calls"); }
  if (trades > t.highTradeFrequency) { segments.push(SEGMENTS.HIGH_TRADE_FREQUENCY); reasons.push(trades + " trades"); }
  if (tokens > t.highLlmTokens) { segments.push(SEGMENTS.HIGH_LLM_COST); reasons.push(tokens + " tokens"); }
  if (lastActive && (Date.now() - lastActive) > t.idleDays * 86400000) { segments.push(SEGMENTS.LONG_IDLE); reasons.push("no activity for " + Math.floor((Date.now() - lastActive) / 86400000) + " days"); }
  if (pnl < -Math.abs(t.bigLossAbs)) { segments.push(SEGMENTS.BIG_LOSS); reasons.push("realised P&L " + pnl.toFixed(2)); }
  return { segments: segments, reasons: reasons };
}

/**
 * The revenue and the margin for one account.
 */
function computeAccountEconomics(options) {
  const opts = options || {};
  const usage = opts.usage || {};
  const planId = opts.planId || "level1";
  const prices = Object.assign({}, DEFAULT_PRICES, opts.prices || {});
  const price = prices[planId] || prices.level1;
  const cost = computeCost(usage, opts.costs);
  // The price is in minor units (cents). The costs are in the same unit so
  // the margin is a plain subtraction.
  const months = Number(opts.months) || 1;
  const revenue = (Number(price.amount) || 0) * months;
  const margin = revenue - cost.total;
  const segment = segmentAccount(Object.assign({}, usage, { lastActiveAt: usage.lastActiveAt }), opts.thresholds);
  return {
    account: opts.account || "unknown",
    plan: planId,
    month: opts.month || null,
    usage: usage,
    cost: cost,
    revenue: revenue,
    margin: margin,
    marginPct: revenue > 0 ? (margin / revenue) * 100 : null,
    contribution: margin,
    segments: segment.segments,
    segmentReasons: segment.reasons,
    // A margin that rests on estimated unit costs is not a margin. It is a
    // hypothesis, and it says so.
    marginIsEstimated: cost.estimatedOnly,
    flags: buildFlags(usage, cost, margin, revenue, opts),
  };
}

function buildFlags(usage, cost, margin, revenue, opts) {
  const flags = [];
  if (cost.estimatedOnly) flags.push("the cost is entirely estimated - the margin is a hypothesis, not a measurement");
  if (revenue <= 0 && cost.total > 0) flags.push("the account costs money and pays nothing (a trial, or an unpaid account)");
  if (margin < 0) flags.push("the account is loss-making on a cost basis");
  if ((Number(usage.llmCalls) || 0) === 0 && (Number(usage.brokerCalls) || 0) === 0) flags.push("no usage was recorded - the account may be idle or unmeasured");
  if (opts.expectedPlan && opts.expectedPlan !== opts.plan) flags.push("the plan is " + opts.plan + " but " + opts.expectedPlan + " was expected");
  return flags;
}

/**
 * The cost policy for one account.
 *
 * [2026-10-21 8단계] The policy compares what the account is worth with
 * what it costs. A negative margin is not a reason to switch the customer
 * off - it is a reason to change how the product is served to them: a
 * cheaper model, a tighter call budget, a cache. The only hard stop is the
 * abuse quota, which exists to bound a runaway, not to price a customer.
 */
function decideCostPolicy(options) {
  const opts = options || {};
  const econ = opts.economics || {};
  const usage = opts.usage || {};
  const cfg = Object.assign({
    dailyLlmCalls: 0,        // 0 = no quota
    dailyBrokerCalls: 0,
    notificationsPerDay: 0,
    cheapModelAfterTokens: 0, // 0 = never downgrade
    minMarginPct: 0,          // below this the account is served more cheaply
  }, opts.controls || {});

  const day = (usage.days && usage.days.today) || {};
  const llmToday = Number(day.llmCalls) || 0;
  const brokerToday = Number(day.brokerCalls) || 0;
  const notificationsToday = Number(day.notifications) || 0;

  // The abuse guard. It is a quota, not a price.
  if (cfg.dailyLlmCalls > 0 && llmToday > cfg.dailyLlmCalls) {
    return { action: "deny", reason: "the daily model-call quota is exhausted (" + llmToday + " > " + cfg.dailyLlmCalls + ")", limit: cfg.dailyLlmCalls };
  }
  if (cfg.dailyBrokerCalls > 0 && brokerToday > cfg.dailyBrokerCalls) {
    return { action: "deny", reason: "the daily broker-call quota is exhausted (" + brokerToday + " > " + cfg.dailyBrokerCalls + ")", limit: cfg.dailyBrokerCalls };
  }
  if (cfg.notificationsPerDay > 0 && notificationsToday > cfg.notificationsPerDay) {
    return { action: "throttle", reason: "the daily notification budget is exhausted - further alerts are muted", limit: cfg.notificationsPerDay };
  }

  // The commercial controls. They change how the account is served.
  if (cfg.cheapModelAfterTokens > 0 && (Number(usage.llmTotalTokens) || 0) > cfg.cheapModelAfterTokens) {
    return { action: "downgrade", reason: "the account's model usage is above the threshold - serve it with the cheaper model", limit: cfg.cheapModelAfterTokens };
  }
  const marginPct = econ.marginPct;
  if (marginPct != null && marginPct < cfg.minMarginPct) {
    return { action: "throttle", reason: "the margin is " + marginPct.toFixed(1) + "% (below " + cfg.minMarginPct + "%) - reduce the call rate, do not switch the customer off", limit: cfg.minMarginPct };
  }
  return { action: "allow", reason: "within the configured budgets", limit: null };
}

/**
 * The cost-control knobs that are available, and what each one costs to
 * implement. [2026-10-21 8단계] These are the options the operator picks
 * between; the module does not apply any of them on its own.
 */
const CONTROL_OPTIONS = Object.freeze([
  { key: "cache", what: "cache the order book and the price quotes for a short TTL", effect: "removes the repeated broker calls that make one AI decision expensive", cost: "a stale quote can change the entry price" },
  { key: "rate_limit", what: "cap the model calls per symbol per hour", effect: "bounds the model cost of a churning account", cost: "fewer decisions" },
  { key: "batch", what: "batch the market data of the whole universe into one call", effect: "the price poll is already batched; the order book is not", cost: "one symbol's order book still needs its own call" },
  { key: "cheap_model_fallback", what: "fall back to the cheaper model once the account's token usage crosses a threshold", effect: "keeps the decision rate while the unit cost falls", cost: "a weaker decision" },
  { key: "quota", what: "a per-account quota on the calls", effect: "an absolute bound", cost: "the customer can hit the wall mid-session" },
  { key: "tier_limit", what: "give the expensive capabilities to a higher tier", effect: "prices the capability instead of subsidising it", cost: "an entitlement change, which needs the migration below" },
]);

/**
 * Plan a price change without breaking the contracts that already exist.
 *
 * [2026-10-21 8단계] The entitlement carries a plan id, not a price, so a
 * price change does not invalidate anything an existing customer holds.
 * What it does need is a notice period: the customers who already paid
 * keep the price they paid for until the notice expires, and only then move
 * to the new one. The plan ids, the entitlements and the feature lists stay
 * exactly as they are.
 */
function planPriceMigration(options) {
  const opts = options || {};
  const accounts = opts.accounts || [];
  const now = Number(opts.now) || Date.now();
  const noticeDays = Number(opts.noticeDays) || 0;
  const newPrice = opts.newPrice || null;
  const grandfathered = [];
  const migrated = [];
  const notices = [];
  for (const a of accounts) {
    const since = Number(a.startedAt) || now;
    const ageDays = (now - since) / 86400000;
    if (noticeDays > 0 && ageDays < noticeDays) {
      grandfathered.push({ account: a.account, plan: a.plan, price: a.price || null, daysRemaining: Math.ceil(noticeDays - ageDays) });
    } else {
      migrated.push({ account: a.account, plan: a.plan, from: a.price || null, to: newPrice ? newPrice.amount : null });
    }
  }
  if (grandfathered.length) {
    notices.push(grandfathered.length + " account(s) keep their current price for the notice period");
  }
  notices.push("the plan ids, the entitlements and the feature lists are unchanged - an entitlement carries a plan, not a price");
  return { grandfathered: grandfathered, migrated: migrated, notices: notices, noticeDays: noticeDays };
}

/**
 * The shared usage ledger.
 *
 * [2026-10-21 8단계] The counters live in the modules that know the cost:
 * the provider router (the model calls and their tokens), the broker client
 * (the API calls) and the notification path. The runner creates the ledger
 * at startup and persists it with the rest of the state.
 */
let sharedLedger = null;

function setUsageLedger(ledger) {
  sharedLedger = ledger || null;
  return sharedLedger;
}

function usageLedger() {
  return sharedLedger;
}

module.exports = {
  DEFAULT_PRICES: DEFAULT_PRICES,
  DEFAULT_COSTS: DEFAULT_COSTS,
  SEGMENTS: SEGMENTS,
  CONTROL_OPTIONS: CONTROL_OPTIONS,
  setUsageLedger: setUsageLedger,
  usageLedger: usageLedger,
  createUsageLedger: createUsageLedger,
  computeCost: computeCost,
  segmentAccount: segmentAccount,
  computeAccountEconomics: computeAccountEconomics,
  decideCostPolicy: decideCostPolicy,
  planPriceMigration: planPriceMigration,
};
