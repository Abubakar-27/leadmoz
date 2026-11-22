import { getEffectivePlanId, PAID_PLANS, getDailyLeadLimitForUser } from "./plans.js";
import { getUserUsage, addUserUsage, adjustUserUsage } from "./authStore.js";
import { getJob, updateJob } from "./store.js";
import { trackEvent } from "./analytics.js";
import {
  introCreditAmount,
  getCreditAccount,
  creditBalance,
  grantIntroCredits,
  reserveCredits,
  refundCredits,
  isIntroConsumed
} from "./creditLedger.js";

/*
  Credit policy: WHO pays for generation, and HOW.

  Four account shapes are possible, and each keeps its existing entitlement
  rather than being flattened into one model:

    admin    - no metering at all.
    paid     - the plan's daily lead allowance, exactly as before. A paid
               customer's access must not change because the free tier changed.
    lifetime - AppSumo/legacy lifetime accounts keep their free-plan daily
               allowance (five a day) forever; their entitlement is preserved.
    credits  - everyone else (new free users). A one-time introductory balance
               in the ledger. No daily refill, so it cannot be farmed.

  Generation is billed with a reserve/settle model over that account's meter
  (the ledger for credits, the day's usage row for paid/lifetime), so a search
  that returns fewer leads than requested - or fails outright - gives back the
  difference instead of silently burning the allowance.
*/

export function isLifetimeUser(user) {
  return Number(user?.lifetimeTier || 0) > 0;
}

export function isPaidActive(user) {
  if (!user) return false;
  const effective = getEffectivePlanId(user);
  return PAID_PLANS.includes(effective);
}

export function creditModeFor(user) {
  if (!user) return "credits";
  if (user.role === "admin") return "admin";
  if (isPaidActive(user)) return "paid";
  if (isLifetimeUser(user)) return "lifetime";
  return "credits";
}

export function introCutoverMs() {
  const raw = process.env.INTRO_CREDITS_CUTOVER;
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/*
  Whether this account may receive the one-time introductory grant.

  Every exclusion is deliberate:
    - admins, paid and lifetime accounts already have their own entitlement.
    - introEligible === false is stamped by the migration on pre-existing
      accounts, and is the durable marker that survives a lost ledger file.
    - isIntroConsumed covers accounts the ledger already granted or marked.
    - a createdAt before the cutover (when configured) catches any existing
      account the migration has not run over yet, so a deploy cannot hand a
      second grant to someone who signed up before the change.
  introEligible === true is an explicit admin override that wins.
*/
export function isIntroEligible(user) {
  if (!user) return false;
  if (user.role === "admin") return false;
  if (isPaidActive(user)) return false;
  if (isLifetimeUser(user)) return false;
  if (user.introEligible === true) return true;
  if (user.introEligible === false) return false;
  if (isIntroConsumed(user.id)) return false;

  const cutover = introCutoverMs();
  if (cutover !== null) {
    const created = Date.parse(user.createdAt || "");
    if (Number.isFinite(created) && created < cutover) return false;
  }
  return true;
}

/*
  Grant the intro credits if (and only if) the account is eligible. Safe to call
  on every login and every verification callback: grantIntroCredits is idempotent
  and isIntroEligible refuses existing accounts, so repeated calls are no-ops.
*/
export function maybeGrantIntroCredits(user) {
  if (!isIntroEligible(user)) return { granted: false, reason: "not_eligible" };
  const result = grantIntroCredits(user.id, {
    amount: introCreditAmount(),
    reason: "signup_intro",
    idempotencyKey: `intro:${user.id}`
  });
  return result;
}

/*
  What the dashboard and API report. `mode` tells the client which model is in
  force so it can render credits (free) or a daily allowance (paid/lifetime).
*/
export function creditSnapshot(user) {
  const mode = creditModeFor(user);

  if (mode === "credits") {
    const account = getCreditAccount(user.id);
    const granted = Number(account.introCreditsGranted || 0);
    const allowance = introCreditAmount();
    return {
      mode,
      remaining: account.balance,
      balance: account.balance,
      total: granted > 0 ? granted : allowance,
      granted,
      used: Number(account.lifetimeUsed || 0),
      introCredits: allowance,
      introGranted: granted > 0,
      exhausted: account.balance <= 0,
      daily: false
    };
  }

  if (mode === "paid" || mode === "lifetime") {
    const limit = getDailyLeadLimitForUser(user);
    const usage = getUserUsage(user.id);
    const used = Number(usage.leadsRequested || 0);
    const remaining = Math.max(0, limit - used);
    return {
      mode,
      remaining,
      balance: remaining,
      total: limit,
      used,
      exhausted: remaining <= 0,
      daily: true
    };
  }

  return { mode: "admin", remaining: null, balance: null, total: null, unlimited: true, daily: false };
}

/*
  Decide how a generation request should be metered, without changing anything
  yet. Returns the mode, how many units to reserve (capped by the account's
  remaining meter), and a targetCount the job should actually aim for.
*/
export function planGeneration(user, requestedCount) {
  const requested = Math.max(1, Math.floor(Number(requestedCount) || 1));
  const mode = creditModeFor(user);

  if (mode === "admin") {
    return { ok: true, mode, reserved: 0, targetCount: Math.min(requested, 1000) };
  }

  if (mode === "paid" || mode === "lifetime") {
    const limit = getDailyLeadLimitForUser(user);
    const usage = getUserUsage(user.id);
    const used = Number(usage.leadsRequested || 0);
    const remaining = Math.max(0, limit - used);

    if (remaining <= 0) {
      return {
        ok: false,
        code: "DAILY_LIMIT",
        status: 403,
        error: `Daily limit reached for your plan. Remaining leads today: 0.`,
        limit,
        used,
        remaining
      };
    }
    const targetCount = Math.min(requested, remaining);
    return { ok: true, mode, reserved: targetCount, targetCount, limit, used, remaining };
  }

  const balance = creditBalance(user.id);
  if (balance <= 0) {
    const allowance = introCreditAmount();
    return {
      ok: false,
      code: "CREDITS_EXHAUSTED",
      status: 402,
      error: `You have used all ${allowance} free lead credits. Upgrade to a paid plan to keep generating leads.`,
      balance: 0
    };
  }

  const targetCount = Math.min(requested, balance);
  return { ok: true, mode: "credits", reserved: targetCount, targetCount, balance, remaining: balance };
}

/*
  Apply the reservation once a job id exists. For credits this is the ledger
  reserve; for paid/lifetime it is the day's usage. Synchronous, so it cannot
  lose a race with another request in this process.
*/
export function reserveForJob({ user, jobId, mode, reserved }) {
  const meta = { mode, reserved: Number(reserved) || 0, jobId, reservedAt: new Date().toISOString() };

  if (mode === "credits") {
    const r = reserveCredits(user.id, reserved, { reason: "job_reserve", idempotencyKey: `reserve:${jobId}` });
    if (!r.ok) return { ok: false, error: r.error || "insufficient_credits", balance: r.balance };
    return { ok: true, billing: meta, balance: r.balance };
  }

  if (mode === "paid" || mode === "lifetime") {
    addUserUsage(user.id, reserved);
    return { ok: true, billing: meta };
  }

  return { ok: true, billing: meta };
}

/*
  Settle a finished job: refund whatever was reserved but not turned into a
  billable lead. Idempotent through the job's billing.settledAt stamp, so a
  recovered job that completes twice cannot refund twice.
*/
export function settleJobBilling(jobId, { billable = 0, failed = false } = {}) {
  const job = getJob(jobId);
  if (!job) return { settled: false, reason: "no_job" };

  const billing = job.billing;
  if (!billing || !billing.mode || billing.mode === "admin") {
    return { settled: false, reason: "not_billed" };
  }
  if (billing.settledAt) return { settled: false, reason: "already_settled" };

  const reserved = Number(billing.reserved) || 0;
  const billableCount = Math.min(Math.max(0, Math.floor(Number(billable) || 0)), reserved);
  const refund = Math.max(0, reserved - billableCount);
  const mode = billing.mode;
  const userId = job.userId;

  if (mode === "credits") {
    if (refund > 0) {
      refundCredits(userId, refund, {
        reason: failed ? "job_failed" : "job_unused",
        idempotencyKey: `settle:${jobId}`
      });
    }
  } else if (mode === "paid" || mode === "lifetime") {
    if (refund > 0) adjustUserUsage(userId, -refund);
  }

  updateJob(jobId, {
    billing: { ...billing, settledAt: new Date().toISOString(), billable: billableCount, refunded: refund }
  });

  return { settled: true, mode, reserved, billable: billableCount, refund };
}

/*
  Fire the two conversion moments that matter for a non-paying account: it has
  five credits left (the point the upgrade prompt appears), and it has run out.
  trackEvent's first-per-user semantics make these one-shot even if called on
  every search, so a user is not counted twice.
*/
export function trackCreditMilestones(user, previousBalance, newBalance) {
  if (!user || creditModeFor(user) !== "credits") return;
  const prev = Number(previousBalance);
  const next = Number(newBalance);
  if (!Number.isFinite(prev) || !Number.isFinite(next)) return;

  if (prev > 5 && next <= 5 && next > 0) {
    trackEvent("free_credits_low", { userId: user.id, meta: { balance: next } });
  }
  if (prev > 0 && next <= 0) {
    trackEvent("free_credits_exhausted", { userId: user.id, meta: { balance: 0 } });
  }
}
