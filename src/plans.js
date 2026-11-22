import { isPlanExpired } from "./authStore.js";

export const PLANS = {
  free: {
    id: "free",
    name: "Free",
    priceMonth: 0,
    /*
      leadsPerDay: 5 is the LIFETIME/AppSumo daily entitlement (and the daily
      cap for lifetime accounts); the free SIGNUP tier is a one-time grant of
      intro credits handled by creditPolicy.js, not a daily allowance.
    */
    leadsPerDay: 5,
    features: [
      "10 free lead credits, one time",
      "Basic website scraping",
      "AI outreach copy",
      "24-hour lead dashboard",
      "Bring your own Gmail SMTP"
    ]
  },
  starter: {
    id: "starter",
    name: "Starter",
    priceMonth: 19,
    leadsPerDay: 150,
    features: [
      "150 leads per day",
      "Advanced verification",
      "AI email, DM, and call opener",
      "Email sender settings",
      "Campaign export"
    ]
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceMonth: 49,
    leadsPerDay: 500,
    features: [
      "500 leads per day",
      "Priority scraping queue",
      "Bulk CSV export",
      "Campaign history",
      "Future email automation access"
    ]
  },
  starter3: {
    id: "starter3",
    name: "Starter (3 Months)",
    priceMonth: 19,
    price3Month: 54,
    price6Month: 103,
    cycle: "3month",
    leadsPerDay: 150,
    features: [
      "150 leads per day",
      "Advanced verification",
      "AI email, DM, and call opener",
      "Email sender settings",
      "Campaign export"
    ]
  },
  starter6: {
    id: "starter6",
    name: "Starter (6 Months)",
    priceMonth: 19,
    price3Month: 54,
    price6Month: 103,
    cycle: "6month",
    leadsPerDay: 150,
    features: [
      "150 leads per day",
      "Advanced verification",
      "AI email, DM, and call opener",
      "Email sender settings",
      "Campaign export"
    ]
  },
  pro3: {
    id: "pro3",
    name: "Pro (3 Months)",
    priceMonth: 49,
    price3Month: 140,
    price6Month: 265,
    cycle: "3month",
    leadsPerDay: 500,
    features: [
      "500 leads per day",
      "Priority scraping queue",
      "Bulk CSV export",
      "Campaign history",
      "Future email automation access"
    ]
  },
  pro6: {
    id: "pro6",
    name: "Pro (6 Months)",
    priceMonth: 49,
    price3Month: 140,
    price6Month: 265,
    cycle: "6month",
    leadsPerDay: 500,
    features: [
      "500 leads per day",
      "Priority scraping queue",
      "Bulk CSV export",
      "Campaign history",
      "Future email automation access"
    ]
  },
  agency: {
    id: "agency",
    name: "Agency",
    priceMonth: 99,
    leadsPerDay: 1000,
    features: [
      "1000 leads per day",
      "Priority scraping queue",
      "Bulk CSV export",
      "Campaign history",
      "Priority support"
    ]
  },
  agency3: {
    id: "agency3",
    name: "Agency (3 Months)",
    priceMonth: 99,
    price3Month: 282,
    price6Month: 534,
    cycle: "3month",
    leadsPerDay: 1000,
    features: [
      "1000 leads per day",
      "Priority scraping queue",
      "Bulk CSV export",
      "Campaign history",
      "Priority support"
    ]
  },
  agency6: {
    id: "agency6",
    name: "Agency (6 Months)",
    priceMonth: 99,
    price3Month: 282,
    price6Month: 534,
    cycle: "6month",
    leadsPerDay: 1000,
    features: [
      "1000 leads per day",
      "Priority scraping queue",
      "Bulk CSV export",
      "Campaign history",
      "Priority support"
    ]
  }
};

export const PAYMENT_METHODS = {
  bank: {
    id: "bank",
    label: "Faysal Bank",
    accountName: "ABUBAKAR NAEEM",
    iban: "PK35FAYS3607704000003034",
    instructions:
      "Send the plan amount via bank transfer to the account below, then verify your payment on WhatsApp."
  }
};

export function whatsappAdminNumber() {
  return String(process.env.ADMIN_WHATSAPP_NUMBER || "+923395155422")
    .replace(/[^0-9]/g, "");
}

export const PAID_PLANS = ["starter", "pro", "starter3", "starter6", "pro3", "pro6", "agency", "agency3", "agency6"];

export function getPlan(plan) {
  return PLANS[String(plan || "free").toLowerCase()] || PLANS.free;
}

/*
  Single source of truth for what a plan actually costs.

  The 3- and 6-month cycles already have their period discount baked into
  price3Month/price6Month (54 is not 19 x 3), and checkout displays those same
  numbers. Computing the price here instead of in the client keeps a promo
  discount from being applied on top of a figure the customer never saw.
*/
export function getPlanPrice(planId, billing = "monthly") {
  const plan = getPlan(planId);
  const cycle = String(billing || "").toLowerCase();
  const id = String(planId || "").toLowerCase();

  if (cycle === "yearly") return Number(plan.priceMonth || 0) * 10;
  if (id.endsWith("6") && plan.price6Month) return Number(plan.price6Month);
  if (id.endsWith("3") && plan.price3Month) return Number(plan.price3Month);
  if (cycle === "6month" && plan.price6Month) return Number(plan.price6Month);
  if (cycle === "3month" && plan.price3Month) return Number(plan.price3Month);
  return Number(plan.priceMonth || 0);
}

/*
  Client-facing plan copy. Kept next to the prices so the marketing pages and
  checkout never need their own copy of a plan name or a dollar amount.
*/
const PLAN_DESCRIPTIONS = {
  free: "Start free with 10 one-time lead credits.",
  starter: "For freelancers and agencies - 150 leads a day.",
  starter3: "3-month starter plan - 150 leads a day. (5% discount)",
  starter6: "6-month starter plan - 150 leads a day. (10% discount)",
  pro: "For growing teams - 500 leads a day.",
  pro3: "3-month pro plan - 500 leads a day. (5% discount)",
  pro6: "6-month pro plan - 500 leads a day. (10% discount)",
  agency: "For agencies and multiple client books - 1000 leads a day.",
  agency3: "3-month agency plan - 1000 leads a day. (5% discount)",
  agency6: "6-month agency plan - 1000 leads a day. (10% discount)"
};

export const PLAN_CYCLES = {
  monthly: { key: "monthly", months: 1, label: "Monthly", periodLabel: "month", priceSuffix: "/ month" },
  "3month": { key: "3month", months: 3, label: "3 months", periodLabel: "3 months", priceSuffix: "/ 3 months" },
  "6month": { key: "6month", months: 6, label: "6 months", periodLabel: "6 months", priceSuffix: "/ 6 months" },
  yearly: { key: "yearly", months: 12, label: "Yearly", periodLabel: "year", priceSuffix: "/ year" }
};

/*
  How many months a given plan id / billing combination covers. The 3- and
  6-month products are separate ids, so the id wins over the billing string.
*/
export function getPlanMonths(planId, billing = "monthly") {
  const id = String(planId || "").toLowerCase();
  const cycle = String(billing || "").toLowerCase();
  if (id.endsWith("6")) return 6;
  if (id.endsWith("3")) return 3;
  if (cycle === "yearly") return 12;
  if (cycle === "6month") return 6;
  if (cycle === "3month") return 3;
  return 1;
}

/*
  One canonical shape for anything that displays a plan. The price is always
  produced by getPlanPrice(), i.e. on the server - no client recomputes it.
*/
export function getPlanDisplay(planId, billing = "monthly") {
  const id = String(planId || "free").toLowerCase();
  const plan = getPlan(id);
  const months = getPlanMonths(id, billing);
  const price = getPlanPrice(id, billing);
  const perMonth = months > 0 ? Number((price / months).toFixed(2)) : price;
  const cycle = PLAN_CYCLES[months === 12 ? "yearly" : months === 6 ? "6month" : months === 3 ? "3month" : "monthly"];

  return {
    id: plan.id || id,
    name: plan.name,
    description: PLAN_DESCRIPTIONS[id] || "",
    features: Array.isArray(plan.features) ? plan.features : [],
    leadsPerDay: Number(plan.leadsPerDay || 0),
    price,
    monthlyPrice: Number(plan.priceMonth || 0),
    months,
    perMonth,
    periodLabel: cycle.periodLabel,
    priceSuffix: cycle.priceSuffix
  };
}

function cycleNote(planId, cycle, total) {
  const plan = getPlan(planId);
  const monthly = Number(plan.priceMonth || 0);
  if (cycle === "monthly") return "Billed monthly";

  if (cycle === "yearly") {
    const freeMonths = monthly > 0 ? Math.round(12 - total / monthly) : 0;
    return freeMonths > 0
      ? `${freeMonths} month${freeMonths === 1 ? "" : "s"} free - $${total}/yr`
      : `$${total}/yr`;
  }

  const months = Number(PLAN_CYCLES[cycle]?.months || 0);
  const full = monthly * months;
  const pct = full > 0 ? Math.round((1 - total / full) * 100) : 0;
  const label = months === 3 ? "3 months" : "6 months";
  return pct > 0 ? `${pct}% off - $${total} every ${label}` : `$${total} every ${label}`;
}

function signupHref(planId, cycle) {
  if (cycle === "yearly") return `/auth?plan=${planId}&billing=yearly`;
  if (cycle === "3month") return `/auth?plan=${planId}3`;
  if (cycle === "6month") return `/auth?plan=${planId}6`;
  return `/auth?plan=${planId}&billing=monthly`;
}

/*
  Public catalogue used by the landing page and checkout. Every number here is
  calculated by getPlanPrice() - the browser only renders what this returns.
*/
export function planCatalog() {
  const cycles = Object.keys(PLAN_CYCLES);
  const cards = {};

  for (const id of ["starter", "pro", "agency"]) {
    const display = getPlanDisplay(id, "monthly");
    const prices = {};

    for (const cycle of cycles) {
      /*
        The 3- and 6-month prices live on the separate starter3/starter6 ids,
        not on the base plan object, so price the matching variant rather than
        silently charging a single month for a prepay.
      */
      const pricedId = cycle === "3month" ? `${id}3` : cycle === "6month" ? `${id}6` : id;
      const total = getPlanPrice(pricedId, cycle);
      const months = Number(PLAN_CYCLES[cycle].months);
      prices[cycle] = {
        total,
        months,
        perMonth: Number((total / months).toFixed(2)),
        note: cycleNote(id, cycle, total),
        href: signupHref(id, cycle)
      };
    }

    cards[id] = { ...display, prices };
  }

  const plans = {};
  for (const id of Object.keys(PLANS)) {
    const months = getPlanMonths(id, "monthly");
    const cycle = months === 12 ? "yearly" : months === 6 ? "6month" : months === 3 ? "3month" : "monthly";
    plans[id] = getPlanDisplay(id, cycle);
  }

  return {
    currency: "USD",
    cycles: PLAN_CYCLES,
    cards,
    plans,
    referral: {
      starterMonthly: Number((getPlanPrice("starter", "monthly") * 0.2).toFixed(2)),
      proMonthly: Number((getPlanPrice("pro", "monthly") * 0.2).toFixed(2)),
      proYearly: Number((getPlanPrice("pro", "yearly") * 0.2).toFixed(2)),
      agencyYearly: Number((getPlanPrice("agency", "yearly") * 0.2).toFixed(2))
    }
  };
}

export function getEffectivePlanId(user) {
  if (!user) return "free";
  if (user.role === "admin") return user.plan || "admin";
  if (isPlanExpired(user)) return "free";
  return String(user.plan || "free").toLowerCase();
}

export function hasAuditAccess(user) {
  if (!user) return false;
  if (user.role === "admin") return true;
  return PAID_PLANS.includes(getEffectivePlanId(user));
}

export function getPlanForUser(user) {
  if (!user) return PLANS.free;
    if (user.role === "admin") return { ...PLANS.pro, name: "Admin", priceMonth: 0, leadsPerDay: 100 };
  return getPlan(getEffectivePlanId(user));
}

export function getDailyLeadLimitForUser(user) {
  if (!user) return PLANS.free.leadsPerDay;
    if (user.role === "admin") return 100;
  const effectivePlan = getEffectivePlanId(user);
  const configured = Number(process.env[`${effectivePlan.toUpperCase()}_DAILY_LEAD_LIMIT`]);
  if (configured > 0) return configured;
  return getPlan(effectivePlan).leadsPerDay;
}