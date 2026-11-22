import crypto from "crypto";
import { getUserById, getUserByEmail, normalizeEmail, setUserPlan } from "./authStore.js";
import { PLANS, getEffectivePlanId } from "./plans.js";
import { requireAuth } from "./auth.js";
import {
  grantEnrichmentAddon,
  scheduleCancelEnrichmentAddon,
  markEnrichmentPastDue,
  findEntitlementBySubscription
} from "./enrichmentStore.js";
import {
  enrichmentEnabled,
  enrichmentPriceId,
  enrichmentPriceMonthly,
  enrichmentPriceTiers,
  enrichmentTierForPlan,
  enrichmentRequireBasePlan
} from "./enrichmentConfig.js";
import { trackEvent } from "./analytics.js";

const BASE_PLANS = new Set(["starter", "pro", "agency"]);
const CYCLE_DAYS = { monthly: 30, yearly: 365, "3month": 90, "6month": 181 };
const WEBHOOK_PATH = "/v1/webhooks/paddle";

const processedTransactions = new Set();
function rememberTransaction(id) {
  processedTransactions.add(id);
  if (processedTransactions.size > 5000) processedTransactions.clear();
  return id;
}

export function paddleMode() {
  const env = String(process.env.PADDLE_MODE || process.env.PADDLE_ENVIRONMENT || "").trim().toLowerCase();
  if (env === "sandbox" || env === "live") return env;
  if (process.env.PADDLE_LIVE_CLIENT_TOKEN) return "live";
  if (process.env.PADDLE_SANDBOX_CLIENT_TOKEN) return "sandbox";
  return null;
}

export function paddleClientToken() {
  const mode = paddleMode();
  if (mode === "live") return process.env.PADDLE_LIVE_CLIENT_TOKEN || process.env.PADDLE_CLIENT_TOKEN || "";
  if (mode === "sandbox") return process.env.PADDLE_SANDBOX_CLIENT_TOKEN || process.env.PADDLE_CLIENT_TOKEN || "";
  return "";
}

export function parsePrices() {
  const raw = String(process.env.PADDLE_PRICES || "").trim();
  if (!raw) return null;
  try {
    const cfg = JSON.parse(raw);
    const out = {};
    for (const plan of ["starter", "pro", "agency"]) {
      const cycles = cfg[plan];
      if (!cycles || typeof cycles !== "object") return null;
      const row = {};
      for (const cycle of ["monthly", "3month", "6month", "yearly"]) {
        const priceId = String(cycles[cycle] || "").trim();
        if (!/^pri_[A-Za-z0-9]+$/.test(priceId)) return null;
        row[cycle] = priceId;
      }
      out[plan] = row;
    }
    const addonTiers = enrichmentPriceTiers().filter(t => t.priceId);
    if (addonTiers.length) {
      out.enrichment = Object.fromEntries(addonTiers.map(t => [t.tier, { monthly: t.priceId }]));
    }
    return out;
  } catch {
    return null;
  }
}

export function verifyPaddleSignature(signatureHeader = "", secret = "", rawBody = "") {
  if (!signatureHeader || !secret) return false;
  const parts = {};
  for (const piece of String(signatureHeader).split(/[;,]/)) {
    const eq = piece.indexOf("=");
    if (eq < 0) continue;
    parts[piece.slice(0, eq).trim()] = piece.slice(eq + 1).trim();
  }
  const ts = parts.ts;
  const h1 = parts.h1;
  if (!ts || !h1) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${ts}:${rawBody}`).digest("hex");
  const a = Buffer.from(h1);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function resolvePlanCycle(customData = {}) {
  const plan = String(customData.plan || "").toLowerCase();
  const cycle = String(customData.cycle || "").toLowerCase();
  if (!BASE_PLANS.has(plan) || !CYCLE_DAYS[cycle]) return null;
  return { plan, cycle };
}

/*
  Subscription lifecycle events only ever touch the ADD-ON. The base plan does
  not handle subscription.* today and must keep behaving exactly as it did - a
  base-plan cancellation is matched to an enrichment entitlement only when the
  subscription id was recorded on one at grant time (or the event explicitly
  carries addon: "enrichment"), so the two subscriptions cannot cancel each
  other.
*/
const CANCEL_EVENTS = ["subscription.cancelled", "subscription.canceled", "subscription.deleted"];
const PAST_DUE_EVENTS = ["subscription.payment_failed", "subscription.past_due"];

/*
  Billing metadata key. It was renamed with the domain (leadio_user_id ->
  leadmoz_user_id), but transactions and subscriptions created before the
  rename still carry the old key, so both are accepted. Writing only the new
  key keeps the two from diverging further.
*/
export function paddleUserId(custom = {}) {
  return String(custom.leadmoz_user_id || custom.leadio_user_id || "");
}

function handleSubscriptionEvent(eventType, data = {}) {
  const subscriptionId = String(data.id || "");
  const custom = data.custom_data || {};
  const base = { subscriptionId, transactionId: "" };

  const isAddonSub =
    custom.addon === "enrichment" ||
    Boolean(subscriptionId && findEntitlementBySubscription(subscriptionId));
  if (!isAddonSub) return { action: "ignored", reason: "not_addon_subscription", ...base };

  const entitlementUserId = findEntitlementBySubscription(subscriptionId);
  let user = entitlementUserId ? getUserById(entitlementUserId) : null;
  const uid = paddleUserId(custom);
  if (!user && uid) user = getUserById(uid);
  if (!user && data.customer?.email) user = getUserByEmail(normalizeEmail(String(data.customer.email)));
  if (!user) return { action: "ignored", reason: "no_user", ...base };

  if (PAST_DUE_EVENTS.includes(eventType)) {
    return { action: "past_due", userId: user.id, ...base, ...markEnrichmentPastDue(user.id, { reason: "payment_failed" }) };
  }

  if (CANCEL_EVENTS.includes(eventType)) {
    const result = scheduleCancelEnrichmentAddon(user.id, { reason: eventType });
    if (result.scheduled) {
      try {
        trackEvent("enrichment_addon_canceled", { userId: user.id, meta: { source: "paddle", event: eventType } });
      } catch (err) {
        console.error("[paddle] analytics failed:", err.message);
      }
    }
    return { action: "canceled", userId: user.id, ...base, ...result };
  }

  return { action: "ignored", reason: "event_type", ...base };
}

export function handlePaddleEvent(payload = {}) {
  const eventType = String(payload.event_type || "");
  const data = payload.data || {};

  if (CANCEL_EVENTS.includes(eventType) || PAST_DUE_EVENTS.includes(eventType)) {
    return handleSubscriptionEvent(eventType, data);
  }

  const transactionId = String(data.id || "");
  if (eventType !== "transaction.completed") return { action: "ignored", reason: "event_type" };
  if (String(data.status) !== "completed") return { action: "ignored", reason: "status" };

  const custom = data.custom_data || {};
  const priceItems = Array.isArray(data.items) ? data.items : [];
  /*
    The add-on is recognised ONLY by one of its configured price ids actually
    being paid, never by custom_data alone - the frontend chooses custom_data,
    so it must not be able to mint an entitlement by labelling a cheap or free
    transaction as the add-on.
  */
  const addonPriceIds = new Set(enrichmentPriceTiers().map(t => t.priceId).filter(Boolean));
  const paidAddonPriceId =
    priceItems.map(item => String(item?.price?.id || item?.price_id || "")).find(id => addonPriceIds.has(id)) || "";
  const isEnrichmentAddon = Boolean(paidAddonPriceId);
  if (!isEnrichmentAddon && custom.addon === "enrichment") {
    console.warn("[paddle] transaction claims enrichment add-on but paid none of its price ids; ignoring");
  }
  const mapped = resolvePlanCycle(custom);
  const subscriptionId = String(data.subscription_id || data.subscriptionId || "");

  let user = getUserById(paddleUserId(custom));
  if (!user && data.customer?.email) user = getUserByEmail(normalizeEmail(String(data.customer.email)));
  if (!user) return { action: "ignored", reason: "no_user", transactionId };

  /*
    One transaction can now carry BOTH line items (base plan + add-on), so both
    grants run for the same transaction id. The add-on keeps its durable
    transaction-keyed dedupe; the base plan keeps its in-memory dedupe exactly
    as before, and a replay short-circuits before either grant can run twice.
  */
  if (processedTransactions.has(transactionId)) {
    return { action: "already_processed", userId: user.id, transactionId };
  }

  const result = { userId: user.id, transactionId };

  if (isEnrichmentAddon) {
    /*
      The tier (and therefore the price) is derived server-side from the base
      plan - from the plan being bought in this transaction, or from the plan
      the account already holds - and cross-checked against the price id that
      was actually paid. A mismatch still grants access (the money was taken)
      but is logged so pricing drift is visible instead of silent.
    */
    const tier = enrichmentTierForPlan(mapped ? mapped.plan : getEffectivePlanId(user));
    const expectedPriceId = enrichmentPriceId(tier);
    if (expectedPriceId && paidAddonPriceId && expectedPriceId !== paidAddonPriceId) {
      console.warn(
        `[paddle] add-on price mismatch: paid=${paidAddonPriceId} expected=${expectedPriceId} tier=${tier || "?"}`
      );
    }
    const grant = grantEnrichmentAddon(user.id, {
      days: 30,
      transactionId,
      source: "paddle",
      subscriptionId,
      tier
    });
    result.addon = grant.duplicate ? "already_processed" : "granted";
    result.enrichment = grant;
    if (grant.granted) {
      try {
        trackEvent("enrichment_addon_purchased", { userId: user.id, meta: { source: "paddle" } });
      } catch (err) {
        console.error("[paddle] analytics failed:", err.message);
      }
    }
  }

  if (!mapped) {
    if (isEnrichmentAddon) {
      rememberTransaction(transactionId);
      return { action: "enrichment_granted", ...result };
    }
    return { action: "ignored", reason: "bad_mapping", ...result };
  }

  rememberTransaction(transactionId);
  setUserPlan(user.id, mapped.plan, CYCLE_DAYS[mapped.cycle], mapped.cycle);

  return {
    ...result,
    action: "granted",
    plan: mapped.plan,
    cycle: mapped.cycle,
    durationDays: CYCLE_DAYS[mapped.cycle],
    planId: PLANS[mapped.plan]?.id || mapped.plan
  };
}

export function registerPaddleRoutes(app) {
  app.get("/api/auth/paddle-config", requireAuth, (req, res) => {
    const environment = paddleMode();
    const token = paddleClientToken();
    const prices = parsePrices();
    const enabled = Boolean(environment && token && prices);
    /*
      The add-on's own flag is deliberately independent of `enabled`: whether a
      price id exists for it is what decides if the checkbox can be offered. A
      deployment that only takes bank transfers can still sell the add-on; card
      payment for it simply needs the full Paddle config like everything else.
    */
    /*
      The tier is decided here, on the server, from the plan being purchased
      (or the plan the account already has) - never from anything the client
      claims about price. Checkout passes ?plan=<base plan key> so a free
      visitor buying Starter + add-on is quoted the Starter tier price.
    */
    const tiers = enrichmentPriceTiers();
    const requestedPlan = String(req.query.plan || "").toLowerCase();
    const sourcePlan = BASE_PLANS.has(requestedPlan) ? requestedPlan : getEffectivePlanId(req.user);
    const tier = enrichmentTierForPlan(sourcePlan);
    const addonPriceId = enrichmentPriceId(tier);
    res.json({
      enabled,
      environment: enabled ? environment : "",
      clientToken: enabled ? token : "",
      prices: enabled ? prices : null,
      userId: req.user.id,
      enrichment: {
        /*
          Driven by the feature flag, not by price ids: bank-transfer-only
          deployments must still be able to offer the checkbox. `priceId`
          below stays empty without Paddle, and checkout only needs it for
          the card-payment path.
        */
        enabled: enrichmentEnabled(),
        tiers,
        tier,
        priceId: addonPriceId,
        priceMonthly: enrichmentPriceMonthly(tier),
        requireBasePlan: enrichmentRequireBasePlan()
      }
    });
  });

  app.post(WEBHOOK_PATH, (req, res) => {
    const secret = String(process.env.PADDLE_WEBHOOK_SECRET || "");
    if (!secret) {
      console.warn("[paddle] PADDLE_WEBHOOK_SECRET not set; rejecting webhook so Paddle retries");
      return res.status(503).json({ ok: false, error: "webhook not configured" });
    }
    const signature = String(req.headers["paddle-signature"] || req.headers["Paddle-Signature"] || "");
    if (!verifyPaddleSignature(signature, secret, String(req.rawBody || ""))) {
      return res.status(401).json({ ok: false, error: "bad signature" });
    }
    try {
      const result = handlePaddleEvent(req.body || {});
      console.log(`[paddle] ${req.body?.event_type || "?"} tx=${req.body?.data?.id || "?"} -> ${JSON.stringify(result)}`);
      res.json({ ok: true, result });
    } catch (err) {
      console.error("[paddle] handler error:", err.message);
      res.status(500).json({ ok: false, error: "handler error" });
    }
  });
}