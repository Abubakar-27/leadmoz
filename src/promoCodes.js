import path from "node:path";
import crypto from "node:crypto";
import { readJsonWithBackup, writeJsonAtomic } from "./atomicJson.js";

const dataDir = path.join(process.cwd(), "data");
export const PROMO_PATH = path.join(dataDir, "promoCodes.json");

const EMPTY = { codes: [] };

export const ALLOWED_CYCLES = ["monthly", "3month", "6month", "yearly"];

/*
  Map a plan+billing pair to its billing cycle, since 3m and 6m are separate
  plan ids (starter3, pro6, ...) that still report billing "monthly", while 1m
  and 1y share the base plan id and differ only in the billing flag.
*/
export function resolveCycle(planId = "", billing = "") {
  const pid = String(planId || "").toLowerCase();
  if (pid.endsWith("3")) return "3month";
  if (pid.endsWith("6")) return "6month";
  return String(billing || "monthly").toLowerCase() === "yearly" ? "yearly" : "monthly";
}

function readPromos() {
  const data = readJsonWithBackup(PROMO_PATH, EMPTY);
  return {
    codes: Array.isArray(data.codes) ? data.codes : []
  };
}

function writePromos(data) {
  writeJsonAtomic(PROMO_PATH, data);
}

/*
  Codes are stored uppercase and compared case-insensitively, because a customer
  typing "launch20" instead of "LAUNCH20" should not lose a discount at the
  payment step. Whitespace and inner dashes are normalised for the same reason.
*/
export function normalizePromoCode(code = "") {
  return String(code || "")
    .trim()
    .toUpperCase()
    .replace(/[\s_]+/g, "")
    .replace(/-+/g, "-");
}

export function listPromos() {
  return readPromos().codes;
}

export function getPromo(code) {
  const key = normalizePromoCode(code);
  if (!key) return null;
  return readPromos().codes.find(c => c.code === key) || null;
}

export function createPromo({ code, type = "percent", value, prices = {}, expiresAt = "", maxUses = 0, plans = [], cycles = [], note = "" }) {
  const key = normalizePromoCode(code);
  const rawKind = String(type || "percent").trim().toLowerCase();
  const kind = ["percent", "amount", "fixed"].includes(rawKind) ? rawKind : "percent";
  const amount = Number(value);

  if (!key || key.length < 3) return { ok: false, error: "Code must be at least 3 characters" };

  let priceMap = null;
  if (kind === "fixed") {
    priceMap = {};
    for (const [planId, price] of Object.entries(prices || {})) {
      const n = Number(price);
      if (Number.isFinite(n) && n >= 0) priceMap[String(planId).trim().toLowerCase()] = Math.round(n * 100) / 100;
    }
    if (!Object.keys(priceMap).length) return { ok: false, error: "Fixed-price code needs at least one priced plan" };
  } else {
    if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "Discount must be greater than 0" };
    if (kind === "percent" && amount > 100) return { ok: false, error: "Percent discount cannot exceed 100" };
  }

  const store = readPromos();
  if (store.codes.some(c => c.code === key)) return { ok: false, error: "Code already exists" };

  let expiry = "";
  if (expiresAt) {
    const t = new Date(expiresAt);
    if (Number.isNaN(t.getTime())) return { ok: false, error: "Expiry must be a valid date" };
    if (t.getTime() <= Date.now()) return { ok: false, error: "Expiry must be in the future" };
    expiry = t.toISOString();
  }

  const record = {
    code: key,
    type: kind,
    value: kind === "fixed" ? null : Math.round(amount * 100) / 100,
    ...(kind === "fixed" ? { prices: priceMap } : {}),
    active: true,
    expiresAt: expiry,
    maxUses: Math.max(0, Math.floor(Number(maxUses) || 0)),
    uses: 0,
    plans: (Array.isArray(plans) ? plans : []).map(p => String(p).toLowerCase()).filter(Boolean),
    cycles: Array.isArray(cycles)
      ? [...new Set(cycles.map(c => String(c).toLowerCase()).filter(c => ALLOWED_CYCLES.includes(c)))]
      : [],
    note: String(note || "").slice(0, 200),
    createdAt: new Date().toISOString(),
    redemptions: []
  };

  store.codes.push(record);
  writePromos(store);
  return { ok: true, promo: record };
}

export function setPromoActive(code, active) {
  const store = readPromos();
  const key = normalizePromoCode(code);
  const item = store.codes.find(c => c.code === key);
  if (!item) return null;
  item.active = Boolean(active);
  writePromos(store);
  return item;
}

export function deletePromo(code) {
  const store = readPromos();
  const key = normalizePromoCode(code);
  const next = store.codes.filter(c => c.code !== key);
  if (next.length === store.codes.length) return false;
  store.codes = next;
  writePromos(store);
  return true;
}

/*
  Validation returns a reason for every failure rather than a bare false, so the
  checkout can say "expired" instead of leaving the customer guessing whether
  they typed it correctly. The discount is always computed against the price the
  customer would otherwise pay, never against a plan's list price, so a code can
  be used on a discounted cycle without double-counting.
*/
export function validatePromo(code, baseAmount, planId = "", billing = "") {
  const key = normalizePromoCode(code);
  if (!key) return { ok: false, reason: "Enter a promo code" };

  const promo = readPromos().codes.find(c => c.code === key);
  if (!promo) return { ok: false, reason: "That promo code does not exist" };

  if (!promo.active) return { ok: false, reason: "That promo code is no longer active" };

  if (promo.expiresAt) {
    const expires = new Date(promo.expiresAt).getTime();
    if (Number.isFinite(expires) && expires <= Date.now()) {
      return { ok: false, reason: "That promo code has expired" };
    }
  }

  if (Number(promo.maxUses) > 0 && Number(promo.uses || 0) >= Number(promo.maxUses)) {
    return { ok: false, reason: "That promo code has reached its usage limit" };
  }

  if (Array.isArray(promo.plans) && promo.plans.length && planId) {
    if (!promo.plans.includes(String(planId).toLowerCase())) {
      return { ok: false, reason: "That promo code does not apply to this plan" };
    }
  }

  const cycle = resolveCycle(planId, billing);
  if (Array.isArray(promo.cycles) && promo.cycles.length && !promo.cycles.includes(cycle)) {
    return { ok: false, reason: "That promo code does not apply to this billing period" };
  }

  const base = Math.max(0, Number(baseAmount) || 0);
  if (base <= 0) return { ok: false, reason: "This plan is already free" };

  /*
    Fixed-price (LTD-style) codes replace the price rather than discounting the
    list price: the customer pays exactly the amount in the prices map for that
    plan. Unlike a percent/amount code this does not require the fixed price to
    sit below the list price, so it still works when the deal price is higher
    than a single monthly invoice (e.g. pro at 78 while the monthly list is 49).
  */
  if (promo.type === "fixed") {
    const fixed = Number((promo.prices || {})[String(planId || "").toLowerCase()]);
    if (!Number.isFinite(fixed) || fixed < 0) {
      return { ok: false, reason: "That promo code does not apply to this plan" };
    }
    const finalAmount = Math.round(fixed * 100) / 100;
    const savings = Math.max(0, Math.round((base - finalAmount) * 100) / 100);
    return {
      ok: true,
      code: promo.code,
      type: promo.type,
      prices: promo.prices || {},
      baseAmount: base,
      discount: Number(savings.toFixed(2)),
      finalAmount: Number(finalAmount.toFixed(2))
    };
  }

  const discount = promo.type === "amount"
    ? Math.min(base, Math.max(0, Number(promo.value) || 0))
    : Math.round((base * Math.max(0, Number(promo.value) || 0)) / 100 * 100) / 100;

  if (discount <= 0) return { ok: false, reason: "That promo code gives no discount on this plan" };

  return {
    ok: true,
    code: promo.code,
    type: promo.type,
    value: promo.value,
    baseAmount: base,
    discount: Number(discount.toFixed(2)),
    finalAmount: Number((base - discount).toFixed(2))
  };
}

/*
  Called at approval time rather than checkout time. A customer can sit on the
  checkout page for days while an admin approves manually, and a code that
  expired or hit its limit in between must not still grant the discount.
*/
export function recordPromoUse(code, { userId = "", plan = "", billing = "", amountPaid = 0 } = {}) {
  const store = readPromos();
  const key = normalizePromoCode(code);
  const item = store.codes.find(c => c.code === key);
  if (!item) return null;

  item.uses = Number(item.uses || 0) + 1;
  item.redemptions = Array.isArray(item.redemptions) ? item.redemptions : [];
  item.redemptions.push({
    userId: String(userId || ""),
    plan: String(plan || ""),
    billing: String(billing || ""),
    cycle: resolveCycle(plan, billing),
    amountPaid: Number(amountPaid) || 0,
    at: new Date().toISOString()
  });

  writePromos(store);
  return item;
}

export function promoSummary() {
  const list = readPromos().codes;
  return {
    total: list.length,
    active: list.filter(c => c.active).length,
    redemptions: list.reduce((s, c) => s + Number(c.uses || 0), 0)
  };
}

export function newPromoId() {
  return `promo_${crypto.randomBytes(6).toString("hex")}`;
}
