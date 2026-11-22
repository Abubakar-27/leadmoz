import path from "path";
import { readJsonWithBackup, writeJsonAtomic } from "./atomicJson.js";
import { enrichmentMonthlyCredits } from "./enrichmentConfig.js";

/*
  Company & Contact Enrichment - entitlement and credit ledger.

  Deliberately SEPARATE from the lead-credit ledger (creditLedger.js): buying
  the add-on must never change a user's lead balance, and enriching a company
  must never spend a lead credit. Both files use the same crash-safe atomic JSON
  helpers.

  Everything here is a synchronous read-modify-write with no await in between, so
  two in-flight requests in this single PM2 process cannot interleave and
  overspend or double-grant. (A multi-process deployment would need an external
  lock; noted in the report.)

  Entitlement is only ever granted by the verified Paddle webhook path, and is
  keyed by transaction id so a replayed webhook cannot extend access or grant a
  second allowance.
*/

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "enrichment.json");

const MAX_TXNS_PER_ACCOUNT = 250;
const MAX_IDEMPOTENCY_KEYS = 5000;
const MAX_CYCLES_PER_USER = 50;

function emptyData() {
  return {
    version: 1,
    entitlements: {},
    accounts: {},
    idempotency: {},
    providerUsage: {},
    disabledProviders: []
  };
}

function readData() {
  const raw = readJsonWithBackup(FILE, emptyData);
  const base = emptyData();
  return {
    version: 1,
    entitlements: raw && typeof raw.entitlements === "object" && raw.entitlements ? raw.entitlements : base.entitlements,
    accounts: raw && typeof raw.accounts === "object" && raw.accounts ? raw.accounts : base.accounts,
    idempotency: raw && typeof raw.idempotency === "object" && raw.idempotency ? raw.idempotency : base.idempotency,
    providerUsage: raw && typeof raw.providerUsage === "object" && raw.providerUsage ? raw.providerUsage : base.providerUsage,
    disabledProviders: Array.isArray(raw?.disabledProviders) ? raw.disabledProviders : []
  };
}

function writeData(data) {
  writeJsonAtomic(FILE, data);
}

function blankEntitlement(userId) {
  return {
    userId,
    active: false,
    plan: "enrichment",
    purchasedAt: "",
    updatedAt: "",
    expiresAt: "",
    periodStart: "",
    periodEnd: "",
    lastTransactionId: "",
    subscriptionId: "",
    /* add-on price tier the customer pays for: starter | pro | agency */
    tier: "",
    canceledAt: "",
    cancelReason: "",
    pastDueAt: "",
    cycles: []
  };
}

function entitlementOf(data, userId) {
  if (!data.entitlements[userId]) data.entitlements[userId] = blankEntitlement(userId);
  const e = data.entitlements[userId];
  if (!Array.isArray(e.cycles)) e.cycles = [];
  return e;
}

function blankAccount(userId) {
  return {
    userId,
    balance: 0,
    lifetimeGranted: 0,
    lifetimeUsed: 0,
    lifetimeRefunded: 0,
    periodStart: "",
    periodGranted: 0,
    updatedAt: "",
    transactions: []
  };
}

function accountOf(data, userId) {
  if (!data.accounts[userId]) data.accounts[userId] = blankAccount(userId);
  const a = data.accounts[userId];
  a.balance = Number(a.balance) || 0;
  a.lifetimeGranted = Number(a.lifetimeGranted) || 0;
  a.lifetimeUsed = Number(a.lifetimeUsed) || 0;
  a.lifetimeRefunded = Number(a.lifetimeRefunded) || 0;
  a.periodGranted = Number(a.periodGranted) || 0;
  if (!Array.isArray(a.transactions)) a.transactions = [];
  return a;
}

function seenIdempotency(data, key) {
  if (!key) return null;
  return data.idempotency[key] || null;
}

function rememberIdempotency(data, key, txnId) {
  if (!key) return;
  data.idempotency[key] = { txnId, at: new Date().toISOString() };
  const keys = Object.keys(data.idempotency);
  if (keys.length > MAX_IDEMPOTENCY_KEYS) {
    const oldest = keys.sort((a, b) =>
      String(data.idempotency[a].at).localeCompare(String(data.idempotency[b].at))
    );
    for (const k of oldest.slice(0, keys.length - MAX_IDEMPOTENCY_KEYS)) delete data.idempotency[k];
  }
}

function pushTxn(account, type, amount, reason, meta = {}) {
  const txn = {
    id: `etxn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    type,
    amount: Number(amount) || 0,
    reason: String(reason || ""),
    at: new Date().toISOString(),
    balanceAfter: account.balance
  };
  if (meta && Object.keys(meta).length) txn.meta = meta;
  account.transactions.push(txn);
  if (account.transactions.length > MAX_TXNS_PER_ACCOUNT) {
    account.transactions = account.transactions.slice(-MAX_TXNS_PER_ACCOUNT);
  }
  return txn;
}

function isoIn(days) {
  return new Date(Date.now() + Math.max(0, Number(days) || 0) * 24 * 60 * 60 * 1000).toISOString();
}

/* ---------------------------------------------------------------- entitlement */

export function getEnrichmentEntitlement(userId) {
  if (!userId) return blankEntitlement("");
  const e = entitlementOf(readData(), userId);
  return { ...e, active: isEntitlementActiveRecord(e) };
}

export function isEntitlementActiveRecord(e) {
  if (!e || !e.active) return false;
  const exp = new Date(e.expiresAt || 0).getTime();
  return Number.isFinite(exp) && exp > Date.now();
}

export function isEnrichmentEntitled(user) {
  if (!user) return false;
  if (user.role === "admin") return true;
  return isEntitlementActiveRecord(entitlementOf(readData(), user.id));
}

/*
  Grant (or renew) the add-on for `days`. Idempotent by transactionId: a
  replayed webhook returns already_processed and changes nothing. Each NEW
  payment starts a new allowance period and grants that period's credits exactly
  once.
*/
export function grantEnrichmentAddon(userId, { days = 30, transactionId = "", cycle = "monthly", source = "paddle", subscriptionId = "", tier = "" } = {}) {
  if (!userId) return { ok: false, reason: "no_user" };

  const data = readData();
  const e = entitlementOf(data, userId);
  const txKey = transactionId ? `addon_tx:${transactionId}` : "";

  if (txKey && seenIdempotency(data, txKey)) {
    return { ok: true, duplicate: true, reason: "already_processed", expiresAt: e.expiresAt };
  }

  const now = new Date().toISOString();
  const periodDays = Math.max(1, Number(days) || 30);

  /*
    Renewal inside an active period extends from the current expiry (so paying
    early does not lose days); a fresh purchase starts from now.
  */
  const baseMs = isEntitlementActiveRecord(e) ? new Date(e.expiresAt).getTime() : Date.now();
  const expiresAt = new Date(baseMs + periodDays * 24 * 60 * 60 * 1000).toISOString();

  e.active = true;
  e.plan = "enrichment";
  e.purchasedAt = e.purchasedAt || now;
  e.updatedAt = now;
  e.expiresAt = expiresAt;
  e.periodStart = now;
  e.periodEnd = expiresAt;
  e.lastTransactionId = transactionId || e.lastTransactionId;
  if (subscriptionId) e.subscriptionId = String(subscriptionId);
  if (tier) e.tier = String(tier);
  e.canceledAt = "";
  e.cancelReason = "";
  e.pastDueAt = "";
  e.cycles.push({ at: now, days: periodDays, cycle, source, transactionId, expiresAt, tier: tier || e.tier || "" });
  if (e.cycles.length > MAX_CYCLES_PER_USER) e.cycles = e.cycles.slice(-MAX_CYCLES_PER_USER);

  const account = accountOf(data, userId);
  /* the allowance follows the TIER that was bought, not a flat number */
  const credits = enrichmentMonthlyCredits(tier || e.tier);
  account.balance += credits;
  account.periodGranted = credits;
  account.periodStart = now;
  account.lifetimeGranted += credits;
  account.updatedAt = now;
  pushTxn(account, "period_grant", credits, "monthly_allowance", { periodEnd: expiresAt, transactionId });

  rememberIdempotency(data, txKey, `addon_${transactionId || now}`);
  writeData(data);

  return { ok: true, granted: true, credits, balance: account.balance, expiresAt, transactionId, tier: e.tier || tier || "" };
}

export function revokeEnrichmentAddon(userId, { reason = "canceled" } = {}) {
  if (!userId) return { ok: false, reason: "no_user" };
  const data = readData();
  const e = entitlementOf(data, userId);
  e.active = false;
  e.canceledAt = new Date().toISOString();
  e.cancelReason = String(reason || "canceled");
  e.updatedAt = e.canceledAt;
  writeData(data);
  return { ok: true, revoked: true, reason: e.cancelReason };
}

/*
  Billing lifecycle (Paddle subscription events).

  Policy, deliberately paid-through rather than immediate:
    - cancelled / deleted  -> the add-on stops renewing but stays usable until
      `expiresAt`, i.e. the end of the period the customer already paid for.
      No further allowance is granted after that, and the entitlement then
      fails the normal `expiresAt` check like any other expiry.
    - payment_failed/past_due -> same paid-through window; if the payment later
      succeeds, `transaction.completed` renews normally.
  Both are idempotent: replaying the same webhook just rewrites the same flags.
*/
export function scheduleCancelEnrichmentAddon(userId, { reason = "subscription_canceled" } = {}) {
  if (!userId) return { ok: false, reason: "no_user" };
  const data = readData();
  const e = entitlementOf(data, userId);
  if (!e.active && e.canceledAt) return { ok: true, alreadyScheduled: true, expiresAt: e.expiresAt };
  const now = new Date().toISOString();
  e.canceledAt = now;
  e.cancelReason = String(reason || "subscription_canceled");
  e.updatedAt = now;
  writeData(data);
  return { ok: true, scheduled: true, reason: e.cancelReason, expiresAt: e.expiresAt, active: isEntitlementActiveRecord(e) };
}

export function markEnrichmentPastDue(userId, { reason = "payment_failed" } = {}) {
  if (!userId) return { ok: false, reason: "no_user" };
  const data = readData();
  const e = entitlementOf(data, userId);
  if (!e.active) return { ok: true, inactive: true };
  const now = new Date().toISOString();
  e.pastDueAt = now;
  e.cancelReason = String(reason || "payment_failed");
  e.updatedAt = now;
  writeData(data);
  return { ok: true, pastDue: true, expiresAt: e.expiresAt };
}

/*
  Lifecycle webhooks identify the subscription, not the user, and Paddle does
  not resend custom_data for them - so the subscription id recorded at grant
  time is what a cancelled/past-due event is resolved against.
*/
export function findEntitlementBySubscription(subscriptionId) {
  const id = String(subscriptionId || "");
  if (!id) return null;
  const data = readData();
  const match = Object.values(data.entitlements).find(e => e && e.subscriptionId === id);
  return match ? match.userId : null;
}

/* -------------------------------------------------------------- credit ledger */

export function getEnrichmentAccount(userId) {
  if (!userId) return blankAccount("");
  const a = accountOf(readData(), userId);
  return { ...a, transactions: a.transactions.slice(-25) };
}

export function enrichmentBalance(userId) {
  if (!userId) return 0;
  return accountOf(readData(), userId).balance;
}

export function listEnrichmentTransactions(userId, limit = 50) {
  if (!userId) return [];
  const a = accountOf(readData(), userId);
  return a.transactions.slice(-Math.max(1, Number(limit) || 50)).reverse();
}

export function reserveEnrichmentCredits(userId, amount, { reason = "enrich", idempotencyKey = "" } = {}) {
  const data = readData();
  const account = accountOf(data, userId);

  if (seenIdempotency(data, idempotencyKey)) {
    return { ok: true, duplicate: true, reserved: 0, balance: account.balance };
  }

  const amt = Math.max(0, Math.floor(Number(amount) || 0));
  if (amt <= 0) return { ok: true, reserved: 0, balance: account.balance };

  if (account.balance < amt) {
    return { ok: false, error: "insufficient_credits", balance: account.balance, required: amt };
  }

  account.balance -= amt;
  account.lifetimeUsed += amt;
  account.updatedAt = new Date().toISOString();
  const txn = pushTxn(account, "reserve", -amt, reason, { userId });
  rememberIdempotency(data, idempotencyKey, txn.id);
  writeData(data);

  return { ok: true, reserved: amt, balance: account.balance, transaction: txn };
}

export function refundEnrichmentCredits(userId, amount, { reason = "refund", idempotencyKey = "" } = {}) {
  const data = readData();
  const account = accountOf(data, userId);

  if (seenIdempotency(data, idempotencyKey)) {
    return { ok: true, duplicate: true, refunded: 0, balance: account.balance };
  }

  const amt = Math.max(0, Math.floor(Number(amount) || 0));
  if (amt <= 0) return { ok: true, refunded: 0, balance: account.balance };

  account.balance += amt;
  account.lifetimeRefunded += amt;
  account.lifetimeUsed = Math.max(0, account.lifetimeUsed - amt);
  account.updatedAt = new Date().toISOString();
  const txn = pushTxn(account, "refund", amt, reason, { userId });
  rememberIdempotency(data, idempotencyKey, txn.id);
  writeData(data);

  return { ok: true, refunded: amt, balance: account.balance, transaction: txn };
}

export function adjustEnrichmentCredits(userId, delta, { reason = "admin_adjust", idempotencyKey = "" } = {}) {
  const data = readData();
  const account = accountOf(data, userId);

  if (seenIdempotency(data, idempotencyKey)) {
    return { ok: true, duplicate: true, balance: account.balance };
  }

  const change = Math.floor(Number(delta) || 0);
  if (change === 0) return { ok: true, balance: account.balance };

  const before = account.balance;
  account.balance = Math.max(0, account.balance + change);
  const applied = account.balance - before;
  if (applied > 0) account.lifetimeGranted += applied;
  account.updatedAt = new Date().toISOString();
  const txn = pushTxn(account, "admin_adjust", applied, reason, { userId });
  rememberIdempotency(data, idempotencyKey, txn.id);
  writeData(data);

  return { ok: true, applied, balance: account.balance, transaction: txn };
}

/* ------------------------------------------------------------ provider usage */

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

export function recordProviderCall(provider, { ok = true, error = "" } = {}) {
  const data = readData();
  const key = String(provider || "unknown");
  const row = data.providerUsage[key] || { calls: 0, ok: 0, failed: 0, lastError: "", lastCallAt: "", daily: {} };
  row.calls += 1;
  if (ok) {
    row.ok += 1;
    /*
      lastError means "the last thing this provider did", not "the last thing
      that ever went wrong". Keeping a fixed key's old 401 on screen forever
      makes the admin summary look broken long after the provider recovered.
    */
    row.lastError = "";
  } else {
    row.failed += 1;
    row.lastError = String(error || "").slice(0, 200);
  }
  row.lastCallAt = new Date().toISOString();

  if (!row.daily || typeof row.daily !== "object") row.daily = {};
  const day = todayKey();
  row.daily[day] = (Number(row.daily[day]) || 0) + 1;
  const days = Object.keys(row.daily).sort();
  for (const old of days.slice(0, Math.max(0, days.length - 14))) delete row.daily[old];

  data.providerUsage[key] = row;
  writeData(data);
  return row;
}

export function providerCallsToday(provider) {
  const row = readData().providerUsage[String(provider || "")];
  if (!row || !row.daily) return 0;
  return Number(row.daily[todayKey()]) || 0;
}

export function providerUsageStats() {
  return readData().providerUsage;
}

export function setProviderDisabled(provider, disabled) {
  const data = readData();
  const key = String(provider || "");
  if (!key) return { ok: false };
  const set = new Set(data.disabledProviders);
  if (disabled) set.add(key);
  else set.delete(key);
  data.disabledProviders = [...set];
  writeData(data);
  return { ok: true, disabledProviders: data.disabledProviders };
}

export function isProviderDisabled(provider) {
  return readData().disabledProviders.includes(String(provider || ""));
}

export function getDisabledProviders() {
  return readData().disabledProviders;
}

/* ------------------------------------------------------------------ snapshot */

export function enrichmentUsageSnapshot(user) {
  if (!user) {
    return { entitled: false, balance: 0, monthlyCredits: enrichmentMonthlyCredits("starter") };
  }
  const e = getEnrichmentEntitlement(user.id);
  const a = getEnrichmentAccount(user.id);
  return {
    entitled: user.role === "admin" || e.active,
    admin: user.role === "admin",
    expiresAt: e.expiresAt,
    purchasedAt: e.purchasedAt,
    canceledAt: e.canceledAt,
    periodStart: a.periodStart || e.periodStart,
    periodEnd: e.periodEnd,
    balance: a.balance,
    tier: e.tier || "",
    monthlyCredits: enrichmentMonthlyCredits(e.tier),
    periodGranted: a.periodGranted,
    lifetimeUsed: a.lifetimeUsed,
    lifetimeRefunded: a.lifetimeRefunded,
    transactions: a.transactions.slice(-10).reverse()
  };
}
