import path from "path";
import { readJsonWithBackup, writeJsonAtomic } from "./atomicJson.js";

/*
  Server-side credit ledger.

  This is the single source of truth for a free user's introductory lead
  credits. Before it existed, the free allowance lived in two places that did
  not agree and neither was really enforced as a balance:
    - src/creditManager.mjs tracked credits_used_today / credits_last_reset on
      the user, but was never imported by anything, so it was dead code.
    - src/auth.js enforceLeadLimit gated on a DAILY limit (plans.js
      getDailyLeadLimitForUser) plus a per-day usage row, so a free user got
      five leads every single day, forever. That daily refill is exactly the
      abuse vector: a fresh account, or several of them, never runs out.

  The ledger replaces the daily refill with a ONE-TIME balance. Every change to
  a balance is a recorded transaction, so a balance can always be reconstructed
  and audited. Balances are never accepted from the client.

  Atomicity: every mutating function below is a synchronous read-modify-write
  with no await in between, so two in-flight HTTP requests in this process
  cannot interleave a read and a write and overspend. The deployment runs a
  single PM2 instance of this process (see PM2 config), which is the scope this
  guarantee covers; a multi-process deployment would need an external lock or a
  transactional database (noted in the report).

  Idempotency: callers pass an idempotencyKey (the job id for generation
  billing). A key is remembered after the first application, so a retried
  request - a recovered job, a duplicated callback - cannot charge or refund
  the same operation twice.
*/

const DATA_DIR = path.join(process.cwd(), "data");
const LEDGER_FILE = path.join(DATA_DIR, "credits.json");

const MAX_TXNS_PER_ACCOUNT = 250;
const MAX_IDEMPOTENCY_KEYS = 5000;

export function introCreditAmount() {
  const n = Number(process.env.INTRO_CREDITS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10;
}

function emptyLedger() {
  return { version: 1, accounts: {}, idempotency: {} };
}

function readLedger() {
  const data = readJsonWithBackup(LEDGER_FILE, emptyLedger);
  return {
    version: 1,
    accounts: data && typeof data.accounts === "object" && data.accounts ? data.accounts : {},
    idempotency: data && typeof data.idempotency === "object" && data.idempotency ? data.idempotency : {}
  };
}

function writeLedger(data) {
  writeJsonAtomic(LEDGER_FILE, data);
}

function blankAccount(userId) {
  return {
    userId,
    balance: 0,
    introCreditsGranted: 0,
    introGrantedAt: "",
    lifetimeGranted: 0,
    lifetimeUsed: 0,
    lifetimeRefunded: 0,
    updatedAt: new Date().toISOString(),
    transactions: []
  };
}

function accountOf(data, userId) {
  if (!data.accounts[userId]) data.accounts[userId] = blankAccount(userId);
  const a = data.accounts[userId];

  a.balance = Number(a.balance) || 0;
  a.introCreditsGranted = Number(a.introCreditsGranted) || 0;
  a.lifetimeGranted = Number(a.lifetimeGranted) || 0;
  a.lifetimeUsed = Number(a.lifetimeUsed) || 0;
  a.lifetimeRefunded = Number(a.lifetimeRefunded) || 0;
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
    const oldestFirst = keys.sort((a, b) =>
      String(data.idempotency[a].at).localeCompare(String(data.idempotency[b].at))
    );
    for (const k of oldestFirst.slice(0, keys.length - MAX_IDEMPOTENCY_KEYS)) {
      delete data.idempotency[k];
    }
  }
}

function pushTxn(account, type, amount, reason, meta = {}) {
  const txn = {
    id: `txn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
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

export function getCreditAccount(userId) {
  if (!userId) return blankAccount("");
  const account = accountOf(readLedger(), userId);
  return { ...account, transactions: account.transactions.slice(-25) };
}

export function creditBalance(userId) {
  if (!userId) return 0;
  return accountOf(readLedger(), userId).balance;
}

export function listCreditTransactions(userId, limit = 50) {
  if (!userId) return [];
  const account = accountOf(readLedger(), userId);
  return account.transactions.slice(-Math.max(1, Number(limit) || 50)).reverse();
}

/*
  Grant the one-time introductory credits. Idempotent twice over: the
  introCreditsGranted flag means an account can never receive a second intro
  grant, and the idempotency key stops a retried call from being applied twice
  in the same instant. A migrated existing user has this flag pre-set (see the
  migration), which is how they are excluded.
*/
export function grantIntroCredits(userId, { amount = introCreditAmount(), reason = "intro_grant", idempotencyKey = "" } = {}) {
  const data = readLedger();
  const account = accountOf(data, userId);

  if (seenIdempotency(data, idempotencyKey)) {
    return { granted: false, reason: "duplicate_key", balance: account.balance };
  }
  if (account.introCreditsGranted > 0) {
    return { granted: false, reason: "already_granted", balance: account.balance };
  }

  const amt = Math.max(0, Math.floor(Number(amount) || 0));
  if (amt <= 0) return { granted: false, reason: "zero_amount", balance: account.balance };

  account.balance += amt;
  account.introCreditsGranted += amt;
  account.introGrantedAt = new Date().toISOString();
  account.lifetimeGranted += amt;
  account.updatedAt = new Date().toISOString();

  const txn = pushTxn(account, "intro_grant", amt, reason, { userId });
  rememberIdempotency(data, idempotencyKey, txn.id);
  writeLedger(data);

  return { granted: true, amount: amt, balance: account.balance, transaction: txn };
}

/*
  Reserve credits for an operation that is about to run. This is the only
  place a free balance goes down. It refuses rather than going negative, which
  is what makes concurrent requests safe: whoever reads a positive balance and
  writes first wins, the next read sees the reduced balance.
*/
export function reserveCredits(userId, amount, { reason = "generate", idempotencyKey = "" } = {}) {
  const data = readLedger();
  const account = accountOf(data, userId);

  if (seenIdempotency(data, idempotencyKey)) {
    return { ok: true, duplicate: true, reserved: 0, balance: account.balance };
  }

  const amt = Math.max(0, Math.floor(Number(amount) || 0));
  if (amt <= 0) return { ok: false, error: "invalid_amount", balance: account.balance };

  if (account.balance < amt) {
    return { ok: false, error: "insufficient_credits", balance: account.balance, required: amt };
  }

  account.balance -= amt;
  account.lifetimeUsed += amt;
  account.updatedAt = new Date().toISOString();

  const txn = pushTxn(account, "reserve", -amt, reason, { userId });
  rememberIdempotency(data, idempotencyKey, txn.id);
  writeLedger(data);

  return { ok: true, reserved: amt, balance: account.balance, transaction: txn };
}

/*
  Return credits that were reserved but not spent - the settle half of the
  reserve/settle model. A job that reserved five but produced two billable
  leads refunds three. Idempotent by key so a recovered job that finishes twice
  cannot refund twice.
*/
export function refundCredits(userId, amount, { reason = "refund", idempotencyKey = "" } = {}) {
  const data = readLedger();
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
  writeLedger(data);

  return { ok: true, refunded: amt, balance: account.balance, transaction: txn };
}

/*
  Manual, auditable adjustment for support. Records who/why via the reason
  string. Never lets a balance go below zero.
*/
export function adjustCredits(userId, delta, { reason = "admin_adjust", idempotencyKey = "" } = {}) {
  const data = readLedger();
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
  writeLedger(data);

  return { ok: true, applied, balance: account.balance, transaction: txn };
}

/*
  Mark an existing account as having already consumed its introductory offer
  without touching its balance. Used by the migration so a pre-existing user is
  never handed a second grant, and by any account we deliberately exclude.
*/
export function markIntroConsumed(userId, { reason = "migration", grantAmount = 0, idempotencyKey = "" } = {}) {
  const data = readLedger();
  const account = accountOf(data, userId);

  if (account.introCreditsGranted > 0 || account.introExcluded) {
    return { marked: false, reason: "already_set", balance: account.balance };
  }

  account.introCreditsGranted = Math.max(0, Math.floor(Number(grantAmount) || 0));
  account.introExcluded = true;
  account.introExcludedReason = String(reason || "");
  account.introGrantedAt = account.introGrantedAt || "";
  account.updatedAt = new Date().toISOString();
  pushTxn(account, "migration_mark", 0, reason, { userId });
  rememberIdempotency(data, idempotencyKey, "mark");
  writeLedger(data);

  return { marked: true, balance: account.balance };
}

export function isIntroConsumed(userId) {
  if (!userId) return false;
  const account = accountOf(readLedger(), userId);
  return account.introCreditsGranted > 0 || account.introExcluded === true;
}
