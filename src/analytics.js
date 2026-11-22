import path from "path";
import { readJsonWithBackup, writeJsonAtomic } from "./atomicJson.js";

/*
  Lightweight internal conversion-funnel tracking.

  There is no third-party analytics provider in this app, so the funnel is
  recorded server-side with the existing database convention (a crash-safe JSON
  file) and exposed to the admin panel. The point is to be able to answer the
  real questions - how many registered users generate a lead, how many exhaust
  the free credits, how many reach pricing, click upgrade, start checkout and
  pay - from data, not from a guess.

  Privacy: no PII is stored. Events carry an internal user id (or none for an
  anonymous visitor), a first-party session id, a source page and a small,
  sanitised meta object - never emails, names, tokens or lead contact details.
  Anything that looks like an email or a long token is dropped from meta.

  First-party events (pricing page seen, upgrade clicked, checkout opened) are
  reported by the browser through one rate-limited beacon and are therefore
  deduplicated within a short window, so a double-firing script or a re-render
  cannot inflate the counts. Every other event is derived server-side from a
  real action and cannot be forged by the client.
*/

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "analytics.json");

const MAX_EVENTS = 20000;
const DEDUPE_PRUNE_MS = 60 * 60 * 1000;

/*
  FUNNEL_STEPS is the ordered journey an admin reads top-to-bottom. EVENTS is
  the full allow-list of recordable names, which includes one extra internal
  event (first_generation_attempt) that is useful for diagnosing drop-off before
  a lead is produced but is not part of the headline funnel.
*/
export const FUNNEL_STEPS = [
  "signup_started",
  "signup_completed",
  "email_verified",
  "free_credits_granted",
  "first_lead_generated",
  "lead_generation_completed",
  "free_credits_low",
  "free_credits_exhausted",
  "pricing_page_viewed",
  "upgrade_cta_clicked",
  "checkout_started",
  "payment_completed"
];

export const EVENTS = [
  ...FUNNEL_STEPS,
  "first_generation_attempt",
  /* Company & Contact Enrichment add-on */
  "enrichment_section_viewed",
  "enrichment_purchase_initiated",
  "enrichment_addon_purchased",
  "enrichment_addon_granted",
  "enrichment_addon_canceled",
  "enrichment_job_created",
  "enrichment_job_completed",
  "enrichment_job_failed",
  "enrichment_company_profile_found",
  "enrichment_decision_maker_found",
  "enrichment_email_found",
  "enrichment_email_verified",
  "enrichment_credits_low",
  "enrichment_credits_exhausted"
];

const EVENT_SET = new Set(EVENTS);

/*
  Keep meta to a few primitive fields and drop anything that looks like an
  email address or a long token, so a careless caller cannot smuggle PII in.
*/
function sanitizeMeta(meta) {
  if (!meta || typeof meta !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
      continue;
    }
    if (typeof value === "string") {
      const v = value.slice(0, 120);
      if (/@/.test(v)) continue;
      out[key] = v;
    }
  }
  return out;
}

function sanitizeLabel(value) {
  if (typeof value !== "string") return "";
  const v = value.slice(0, 160);
  return /@/.test(v) ? "" : v;
}

function emptyAnalytics() {
  return { version: 2, counts: {}, users: {}, firsts: {}, events: [], recentSigs: {} };
}

function readAnalytics() {
  const data = readJsonWithBackup(FILE, emptyAnalytics);
  return {
    version: 2,
    counts: data && typeof data.counts === "object" && data.counts ? data.counts : {},
    users: data && typeof data.users === "object" && data.users ? data.users : {},
    firsts: data && typeof data.firsts === "object" && data.firsts ? data.firsts : {},
    events: Array.isArray(data?.events) ? data.events : [],
    recentSigs: data && typeof data.recentSigs === "object" && data.recentSigs ? data.recentSigs : {}
  };
}

function writeAnalytics(data) {
  writeJsonAtomic(FILE, data, { backup: false });
}

/*
  Record one event.

  Returns whether this was the first time the given user triggered it, which
  callers use to fire one-shot downstream events (the "first lead" and
  "exhausted" moments, for example).

  dedupeMs: when non-zero, an identical (name + identity + plan) event seen
  within that window is dropped. Used by the browser beacon so a re-render or a
  double-fired listener cannot inflate page-view counts. Server-derived events
  pass no window, so genuine repeated actions are still counted.
*/
export function trackEvent(name, {
  userId = "",
  sessionId = "",
  source = "",
  referrer = "",
  plan = "",
  meta = {},
  dedupeMs = 0
} = {}) {
  if (!EVENT_SET.has(name)) return { ok: false, reason: "unknown_event", first: false };

  const nowMs = Date.now();
  const at = new Date(nowMs).toISOString();
  const data = readAnalytics();
  const uid = String(userId || "");
  const sid = String(sessionId || "");
  const planId = sanitizeLabel(plan);

  if (dedupeMs > 0) {
    const sig = `${name}|${uid || sid || "anon"}|${planId}`;
    const last = Number(data.recentSigs[sig] || 0);
    if (last && nowMs - last < dedupeMs) return { ok: true, duplicate: true, first: false, at };
    data.recentSigs[sig] = nowMs;
  }

  data.counts[name] = Number(data.counts[name] || 0) + 1;

  let first = false;
  if (uid) {
    if (!data.users[name]) data.users[name] = {};
    if (!data.users[name][uid]) {
      data.users[name][uid] = at;
      first = true;
    }
    if (!data.firsts[uid]) data.firsts[uid] = {};
    if (!data.firsts[uid][name]) data.firsts[uid][name] = at;
  }

  data.events.push({
    n: name,
    u: uid,
    s: sid,
    at,
    src: sanitizeLabel(source),
    ref: sanitizeLabel(referrer),
    plan: planId,
    m: sanitizeMeta(meta)
  });
  if (data.events.length > MAX_EVENTS) data.events = data.events.slice(-MAX_EVENTS);

  for (const [sig, ts] of Object.entries(data.recentSigs)) {
    if (!ts || nowMs - Number(ts) > DEDUPE_PRUNE_MS) delete data.recentSigs[sig];
  }

  writeAnalytics(data);
  return { ok: true, first, at };
}

export function hasEvent(userId, name) {
  if (!userId) return false;
  const data = readAnalytics();
  return Boolean(data.users[name] && data.users[name][userId]);
}

export function eventUserCount(name) {
  const data = readAnalytics();
  return data.users[name] ? Object.keys(data.users[name]).length : 0;
}

/*
  Anonymous-to-authenticated attribution. When a visitor with the first-party
  session handle `sessionId` creates an account, the pricing/checkout events
  they recorded while anonymous are re-attributed to the new user id, so the
  funnel credits the journey that actually happened. It is privacy-conscious:
  only an internally-generated, non-identifying handle is used, the events are
  internal (no PII), and nothing is merged across different handles.
*/
export function attributeEvents(sessionId, userId) {
  const sid = String(sessionId || "");
  const uid = String(userId || "");
  if (!sid || !uid) return { attributed: 0 };

  const data = readAnalytics();
  let attributed = 0;
  for (const e of data.events) {
    if (e && e.u === "" && e.s === sid) {
      e.u = uid;
      attributed += 1;
      if (!data.users[e.n]) data.users[e.n] = {};
      if (!data.users[e.n][uid] || Date.parse(data.users[e.n][uid]) > Date.parse(e.at)) {
        data.users[e.n][uid] = e.at;
      }
      if (!data.firsts[uid]) data.firsts[uid] = {};
      if (!data.firsts[uid][e.n]) data.firsts[uid][e.n] = e.at;
    }
  }
  if (attributed > 0) writeAnalytics(data);
  return { attributed };
}

function parseBound(value) {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

/*
  The funnel. Without arguments it reports lifetime totals (all events ever
  recorded). With { since, until } it reports only the events inside that window
  and labels the range, so a period figure is never silently mixed with a
  lifetime one. Uniques are recomputed per window from the raw events.
*/
export function funnelSummary({ since = "", until = "" } = {}) {
  const data = readAnalytics();
  const sinceMs = parseBound(since);
  const untilMs = parseBound(until);
  const ranged = Boolean(sinceMs || untilMs);

  const inRange = at => {
    const ms = Date.parse(at);
    if (!Number.isFinite(ms)) return false;
    if (sinceMs && ms < sinceMs) return false;
    if (untilMs && ms > untilMs) return false;
    return true;
  };

  let unique;
  let total;

  if (ranged) {
    const evts = data.events.filter(e => inRange(e.at));
    const uniq = {};
    const counts = {};
    for (const e of evts) {
      counts[e.n] = (counts[e.n] || 0) + 1;
      if (e.u) {
        if (!uniq[e.n]) uniq[e.n] = new Set();
        uniq[e.n].add(e.u);
      }
    }
    unique = name => (uniq[name] ? uniq[name].size : 0);
    total = name => counts[name] || 0;
  } else {
    unique = name => (data.users[name] ? Object.keys(data.users[name]).length : 0);
    total = name => Number(data.counts[name] || 0);
  }

  const steps = FUNNEL_STEPS.map(name => ({
    event: name,
    uniqueUsers: unique(name),
    totalEvents: total(name)
  }));

  const registered = unique("signup_completed");
  const verified = unique("email_verified");
  const granted = unique("free_credits_granted");
  const generatedAtLeastOne = unique("first_lead_generated");
  const completedAGeneration = unique("lead_generation_completed");
  const exhausted = unique("free_credits_exhausted");
  const pricing = unique("pricing_page_viewed");
  const pricingViews = total("pricing_page_viewed");
  const upgradeClicks = unique("upgrade_cta_clicked");
  const checkout = unique("checkout_started");
  const paying = unique("payment_completed");

  const pct = (part, whole) => (whole > 0 ? Number(((part / whole) * 100).toFixed(1)) : null);

  return {
    range: {
      since: since || null,
      until: until || null,
      label: ranged ? "custom-range" : "lifetime"
    },
    steps,
    funnel: {
      registeredUsers: registered,
      verifiedUsers: verified,
      usersGrantedCredits: granted,
      usersWhoGeneratedALead: generatedAtLeastOne,
      usersWhoCompletedAGeneration: completedAGeneration,
      usersWhoExhaustedCredits: exhausted,
      usersWhoViewedPricing: pricing,
      pricingPageViews: pricingViews,
      usersWhoClickedUpgrade: upgradeClicks,
      usersWhoStartedCheckout: checkout,
      payingCustomers: paying
    },
    conversion: {
      signupToFirstLeadPct: pct(generatedAtLeastOne, registered),
      firstLeadToPricingPct: pct(pricing, generatedAtLeastOne),
      pricingToCheckoutPct: pct(checkout, pricing),
      checkoutToPaidPct: pct(paying, checkout),
      signupToPaidPct: pct(paying, registered)
    },
    denominators: {
      signupToFirstLead: "users who generated a lead / registered users",
      firstLeadToPricing: "unique pricing viewers / users who generated a lead",
      pricingToCheckout: "users who started checkout / unique pricing viewers",
      checkoutToPaid: "paying customers / users who started checkout",
      signupToPaid: "paying customers / registered users"
    }
  };
}

export function recentEvents(limit = 100) {
  const data = readAnalytics();
  return data.events.slice(-Math.max(1, Number(limit) || 100)).reverse();
}

/*
  Everyone who reached the payment (checkout) page, one row per distinct
  visitor. Authenticated visitors are keyed by user id; anonymous ones by their
  first-party session handle, so a logged-out visitor who opened checkout is
  still counted rather than silently dropped. `converted` is true when that user
  later recorded payment_completed. Returned most-recent-first.
*/
export function checkoutVisits(limit = 500) {
  const data = readAnalytics();
  const paidUsers = new Set(Object.keys(data.users.payment_completed || {}));
  const byKey = new Map();

  for (const e of data.events) {
    if (!e || e.n !== "checkout_started") continue;
    const userId = String(e.u || "");
    const key = userId || `anon:${e.s || "unknown"}`;
    let rec = byKey.get(key);
    if (!rec) {
      rec = {
        key,
        userId,
        anonymous: !userId,
        sessionId: String(e.s || ""),
        visits: 0,
        plans: [],
        firstAt: e.at,
        lastAt: e.at,
        source: e.src || "",
        referrer: e.ref || "",
        converted: false
      };
      byKey.set(key, rec);
    }
    rec.visits += 1;
    if (e.at < rec.firstAt) rec.firstAt = e.at;
    if (e.at > rec.lastAt) { rec.lastAt = e.at; rec.source = e.src || rec.source; rec.referrer = e.ref || rec.referrer; }
    if (e.plan && !rec.plans.includes(e.plan)) rec.plans.push(e.plan);
    if (userId && paidUsers.has(userId)) rec.converted = true;
  }

  return [...byKey.values()]
    .sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0))
    .slice(0, Math.max(1, Number(limit) || 500));
}
