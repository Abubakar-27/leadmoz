import fs from "fs";
import path from "path";
import { requireAdmin } from "./auth.js";
import { setUserPlan } from "./authStore.js";
import { PAID_PLANS, getPlanPrice } from "./plans.js";
import {
  createCommission,
  listCommissions,
  markCommissionPaid,
  voidCommission,
  referralSummary
} from "./referrals.js";
import {
  validatePromo,
  recordPromoUse,
  listPromos,
  createPromo,
  setPromoActive,
  deletePromo,
  promoSummary
} from "./promoCodes.js";
import { getRates, formatLocal } from "./rates.js";
import { trackEvent, checkoutVisits } from "./analytics.js";
import { accountsForDeviceHash } from "./abuseGuard.js";
import { emailForDevice } from "./paymentIntent.js";
import { getCreditAccount, adjustCredits, listCreditTransactions, introCreditAmount } from "./creditLedger.js";

const DATA_DIR = path.join(process.cwd(), "data");
const AUTH_FILE = path.join(DATA_DIR, "auth.json");
const STORE_FILE = path.join(DATA_DIR, "store.json");

function readAuth() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
  } catch {
    return { users: [], sessions: [], emailCodes: [], usage: [] };
  }
}

function readStoreJobs() {
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, "utf8")).jobs || {};
  } catch {
    return {};
  }
}

function writeAuth(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2));
}

function safeUser(user) {
  if (!user) return null;
  /*
    Admin responses are still browser responses. Never ship credential
    material to them: password hashes, SMTP app passwords and the user's own
    AI key all stay server-side. The rest of the account fields are fair game.
  */
  const { passwordHash, smtpPass, geminiApiKey, gmailSender, ...safe } = user;
  if (gmailSender && typeof gmailSender === "object") {
    const { smtpPass: _senderPass, ...sender } = gmailSender;
    safe.gmailSender = sender;
  }
  return safe;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

/*
  Every plan that checkout actually sells. The 3- and 6-month cycles were left
  off, so a referred starter3 sale paid the referrer nothing - not even the $19
  "monthly base" - while the same customer to a starter link earned 20% of $19.
  With these included, the commission uses getPlanPrice below, i.e. the prepay
  total actually collected (54/103/140/265), or its discounted figure when a
  promo code was applied. Agency is intentionally not listed here so it only
  becomes commissionable if that is decided.
*/
const COMMISSIONABLE_PLANS = ["starter", "pro", "starter3", "starter6", "pro3", "pro6"];

function maybeCreateCommission(referee, plan, billing, approvalTrace, amountOverride = null) {
  if (!COMMISSIONABLE_PLANS.includes(plan)) return null;
  if (!referee || !referee.referredBy) return null;

  const data = readAuth();
  const referrer = (data.users || []).find(u => u.id === referee.referredBy);
  const validReferrer = referrer
    && referrer.role !== "admin" && referrer.status === "active" && referrer.id !== referee.id
    && !(referrer.signupIp && referee.signupIp && referrer.signupIp === referee.signupIp);

  if (!validReferrer) return null;

  const listPrice = getPlanPrice(plan, billing);
  if (!(listPrice > 0)) return null;

  /*
    A promo changes what the customer actually paid, so the commission is
    computed on the discounted figure rather than list price. Without a promo
    the list price is used. getPlanPrice returns the prepaid total for the 3-
    and 6-month plans (54/103/140/265), so those sales generate a commission on
    what was actually collected instead of the $19/$49 monthly base - a starter3
    sale previously commissioned as if it were a $19 monthly sale.
  */
  const amountPaid = amountOverride !== null
    ? Math.max(0, Number(amountOverride) || 0)
    : listPrice;
  if (amountPaid <= 0) return null;

  const commission = createCommission({
    referrerId: referrer.id,
    referrerEmail: referrer.email,
    refereeId: referee.id,
    refereeEmail: referee.email,
    plan,
    billing,
    amountPaid,
    approvalTrace
  });

  console.log(`[referral] commission${commission ? ` ${commission.id}` : " skipped"} -> referrer ${referrer.email}`);
  return commission;
}

export function registerAdminToolRoutes(app) {
  app.get("/api/admin/users", requireAdmin, (req, res) => {
    const data = readAuth();
    const today = todayKey();

    const users = (data.users || []).map(user => {
      const usageToday =
        (data.usage || []).find(u => u.userId === user.id && u.date === today) || {
          leadsRequested: 0,
          jobsCreated: 0
        };

      const totalUsage = (data.usage || [])
        .filter(u => u.userId === user.id)
        .reduce(
          (acc, u) => {
            acc.leadsRequested += Number(u.leadsRequested || 0);
            acc.jobsCreated += Number(u.jobsCreated || 0);
            return acc;
          },
          { leadsRequested: 0, jobsCreated: 0 }
        );

      const copy = { ...safeUser(user), usageToday, totalUsage };
      if (copy.gmailSender) {
        const { smtpPass, ...sender } = copy.gmailSender;
        copy.gmailSender = sender;
      }
      copy.smtpConfigured = Boolean(user.gmailSender && user.gmailSender.smtpUser && user.gmailSender.smtpPass);

      return copy;
    });

    res.json({ users });
  });

  app.get("/api/admin/jobs", requireAdmin, (req, res) => {
    const data = readAuth();
    const usersById = new Map((data.users || []).map(u => [u.id, u.email || ""]));

    const jobs = Object.values(readStoreJobs())
      .filter(job => Boolean(job && job.id))
      .map(job => ({
        ...job,
        email: job.email || usersById.get(job.userId) || ""
      }))
      .sort((a, b) =>
        String(b.createdAt || b.updatedAt || "").localeCompare(String(a.createdAt || a.updatedAt || ""))
      )
      .slice(0, 25);

    res.json({ jobs });
  });

  app.post("/api/admin/users/:id/role", requireAdmin, (req, res) => {
    const data = readAuth();
    const user = (data.users || []).find(u => u.id === req.params.id);
    const role = String(req.body.role || "").trim();

    if (!user) return res.status(404).json({ error: "User not found" });
    if (!["user", "admin"].includes(role)) return res.status(400).json({ error: "Invalid role" });

    user.role = role;
    user.updatedAt = new Date().toISOString();

    writeAuth(data);
    res.json({ ok: true, user: safeUser(user) });
  });

  app.post("/api/admin/users/:id/status", requireAdmin, (req, res) => {
    const data = readAuth();
    const user = (data.users || []).find(u => u.id === req.params.id);
    const status = String(req.body.status || "").trim();

    if (!user) return res.status(404).json({ error: "User not found" });
    if (!["active", "blocked"].includes(status)) return res.status(400).json({ error: "Invalid status" });

    user.status = status;
    user.updatedAt = new Date().toISOString();

    writeAuth(data);
    res.json({ ok: true, user: safeUser(user) });
  });

  app.post("/api/admin/users/:id/plan", requireAdmin, (req, res) => {
    const data = readAuth();
    const user = (data.users || []).find(u => u.id === req.params.id);
    const plan = String(req.body.plan || "").trim();
    const durationDays = Math.max(1, Number(req.body.durationDays ?? req.body.duration ?? 30) || 30);

    if (!user) return res.status(404).json({ error: "User not found" });
    if (!["free", "starter", "pro", "agency"].includes(plan)) return res.status(400).json({ error: "Invalid plan" });

    const yearly = req.body.billing === "yearly" || Number(durationDays) >= 300;
    const billing = yearly ? "yearly" : "monthly";

    user.plan = plan;
    user.planRequest = "";
    user.planRequestedAt = "";
    user.planBilling = COMMISSIONABLE_PLANS.includes(plan) ? billing : "";
    user.planApprovedAt = new Date().toISOString();
    user.updatedAt = new Date().toISOString();

    if (["starter", "pro", "agency"].includes(plan)) {
      user.planDurationDays = durationDays;
      user.planExpiresAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString();
    } else {
      user.planDurationDays = 0;
      user.planExpiresAt = "";
    }

    writeAuth(data);

    maybeCreateCommission(user, plan, billing, String(user.planApprovedAt || ""));

    if (PAID_PLANS.includes(plan)) {
      trackEvent("payment_completed", { userId: user.id, meta: { plan, billing, source: "admin_plan" } });
    }

    res.json({ ok: true, user: safeUser(user) });
  });

  app.post("/api/admin/users/:id/approve-plan", requireAdmin, async (req, res) => {
    const data = readAuth();
    const user = (data.users || []).find(u => u.id === req.params.id);

    if (!user) return res.status(404).json({ error: "User not found" });

    const requested = String(user.planRequest || "").trim();
    const plan = String(req.body.plan || requested || "").trim();
    /*
      The admin UI always sends a term length per plan, but a request that omits
      it should still get the right one: the plan id carries the period, since
      3- and 6-month plans are separate ids.
    */
    const fallbackDays = plan.endsWith("6") ? 180 : plan.endsWith("3") ? 90 : 30;
    const durationDays = Math.max(1, Number(req.body.durationDays ?? req.body.duration ?? fallbackDays) || fallbackDays);

    /*
      Accept every plan that has an entry and a price. The hardcoded old
      three-item list rejected every prepaid cycle: an admin could never approve
      the starter3/starter6/pro3/pro6 requests the checkout page itself creates.
      The UI has always had term lengths for all seven plans, so this was
      approval lagging the plans that were already being sold.
    */
    if (!PAID_PLANS.includes(plan)) return res.status(400).json({ error: "Invalid plan" });

    const yearly = req.body.billing === "yearly" || Number(durationDays) >= 300;
    const billing = yearly ? "yearly" : "monthly";

    /*
      Re-validated here, not trusted from checkout. Payment is manual and
      approval can be days later, so a code that expired or hit its usage limit
      in between must not still grant the discount. A rejected code does not
      block the plan: it returns a note so the admin can see what happened and
      decide whether to honour it.
    */
    const promoCode = String(req.body.promo || user.promoCode || "").trim();
    const listPrice = getPlanPrice(plan, billing);

    let promoApplied = null;
    let promoNote = "";
    if (promoCode) {
      const check = validatePromo(promoCode, listPrice, plan, billing);
      if (check.ok) promoApplied = check;
      else promoNote = check.reason || "That promo code is no longer valid";
    }

    const updated = setUserPlan(user.id, plan, durationDays, billing);

    if (!updated) return res.status(404).json({ error: "User not found" });

    if (promoApplied) {
      recordPromoUse(promoApplied.code, {
        userId: user.id,
        plan,
        billing,
        amountPaid: promoApplied.finalAmount
      });
    }

    // setUserPlan wrote the file, so re-read before stamping the audit fields.
    const fresh = readAuth();
    const record = (fresh.users || []).find(u => u.id === user.id);
    if (record) {
      record.promoApplied = promoApplied ? promoApplied.code : "";
      record.promoDiscount = promoApplied ? promoApplied.discount : 0;
      record.planAmountPaid = promoApplied ? promoApplied.finalAmount : listPrice;
      // Clear a code that failed validation so a later approval does not
      // silently retry it.
      if (!promoApplied && promoCode) record.promoCode = "";
      writeAuth(fresh);
    }

    maybeCreateCommission(
      record || updated,
      plan,
      billing,
      String(updated.planApprovedAt || updated.updatedAt || ""),
      promoApplied ? promoApplied.finalAmount : null
    );

    const paidAmount = promoApplied ? promoApplied.finalAmount : listPrice;
    const rates = await getRates();
    const localPkr = rates.ok ? formatLocal(paidAmount, "PKR", rates) : null;
    const localInr = rates.ok ? formatLocal(paidAmount, "INR", rates) : null;

    trackEvent("payment_completed", {
      userId: user.id,
      meta: { plan, billing, amount: paidAmount, promo: promoApplied ? promoApplied.code : "" }
    });

    res.json({
      ok: true,
      user: safeUser(record || updated),
      listPrice,
      paidAmount,
      localPkr,
      localInr,
      promo: promoApplied
        ? { code: promoApplied.code, discount: promoApplied.discount, amountPaid: promoApplied.finalAmount }
        : null,
      promoNote
    });
  });

  app.get("/api/admin/referrals", requireAdmin, (req, res) => {
    const all = listCommissions();
    const users = readAuth().users || [];
    const nameOf = id => {
      const u = users.find(x => x.id === id);
      return u ? (u.name || u.email) : id;
    };
    const rows = all.map(c => ({
      ...c,
      referrerName: nameOf(c.referrerId),
      refereeName: nameOf(c.refereeId)
    }));
    res.json({ summary: referralSummary(), rows: rows.reverse() });
  });

  app.get("/api/admin/referral-signups", requireAdmin, (req, res) => {
    const users = readAuth().users || [];
    const byId = new Map(users.map(u => [u.id, u]));

    const rows = users
      .filter(u => Boolean(u.referredBy) && u.referredBy !== u.id)
      .map(u => {
        const referrer = byId.get(u.referredBy) || null;
        return {
          id: u.id,
          name: u.name || "",
          email: u.email,
          plan: u.plan || "free",
          status: u.status || "active",
          provider: u.provider || "",
          createdAt: u.createdAt || "",
          planApprovedAt: u.planApprovedAt || "",
          signupIp: u.signupIp || "",
          referrer: referrer ? {
            id: referrer.id,
            name: referrer.name || "",
            email: referrer.email,
            refCode: referrer.refCode || ""
          } : null
        };
      })
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

    res.json({ rows, total: rows.length });
  });

  app.post("/api/admin/referrals/:id/pay", requireAdmin, (req, res) => {
    const item = markCommissionPaid(req.params.id);
    if (!item) return res.status(404).json({ error: "Commission not found" });
    res.json({ ok: true, item });
  });

  app.post("/api/admin/referrals/:id/void", requireAdmin, (req, res) => {
    const item = voidCommission(req.params.id);
    if (!item) return res.status(404).json({ error: "Commission not found" });
    res.json({ ok: true, item });
  });

  app.get("/api/admin/promos", requireAdmin, (req, res) => {
    res.json({ ok: true, codes: listPromos(), summary: promoSummary() });
  });

  app.post("/api/admin/promos", requireAdmin, (req, res) => {
    const result = createPromo({
      code: req.body.code,
      type: req.body.type,
      value: req.body.value,
      expiresAt: req.body.expiresAt || "",
      maxUses: req.body.maxUses,
      plans: Array.isArray(req.body.plans) ? req.body.plans : [],
      cycles: Array.isArray(req.body.cycles) ? req.body.cycles : [],
      note: req.body.note || ""
    });

    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ok: true, promo: result.promo });
  });

  app.post("/api/admin/promos/:code/toggle", requireAdmin, (req, res) => {
    const item = setPromoActive(req.params.code, req.body.active);
    if (!item) return res.status(404).json({ error: "Code not found" });
    res.json({ ok: true, promo: item });
  });

  app.post("/api/admin/promos/:code/delete", requireAdmin, (req, res) => {
    if (!deletePromo(req.params.code)) return res.status(404).json({ error: "Code not found" });
    res.json({ ok: true });
  });

  app.post("/api/admin/users/:id/reset-usage", requireAdmin, (req, res) => {
    const data = readAuth();
    const user = (data.users || []).find(u => u.id === req.params.id);
    const today = todayKey();

    if (!user) return res.status(404).json({ error: "User not found" });

    data.usage = (data.usage || []).filter(u => !(u.userId === user.id && u.date === today));

    writeAuth(data);
    res.json({ ok: true });
  });

  /*
    Payment-page tracker: one row per distinct visitor who entered the payment
    flow (the /auth?plan=<paid> page or /checkout). Signed-in visitors are keyed
    by user id and joined to their account so the admin sees the email;
    anonymous visitors are keyed by their first-party device handle, and any
    account later created on that same device is shown too, so a logged-out
    visitor who went on to register is identified rather than left as a bare
    session string.
  */
  app.get("/api/admin/payment-visits", requireAdmin, (req, res) => {
    const users = readAuth().users || [];
    const byId = new Map(users.map(u => [u.id, u]));
    const visits = checkoutVisits().map(v => {
      const u = v.userId ? byId.get(v.userId) : null;
      const linkedAccounts = v.anonymous
        ? accountsForDeviceHash(v.sessionId)
            .map(id => byId.get(id))
            .filter(Boolean)
            .map(a => ({ email: a.email || "", name: a.name || "" }))
        : [];
      const intent = v.anonymous ? emailForDevice(v.sessionId) : null;
      return {
        ...v,
        email: u ? u.email || "" : "",
        name: u ? u.name || "" : "",
        accountPlan: u ? u.plan || "" : "",
        lifetimeTier: u ? Number(u.lifetimeTier || 0) : 0,
        emailVerified: u ? Boolean(u.emailVerifiedAt || u.emailVerified) : false,
        linkedAccounts,
        intentEmail: intent ? intent.email : "",
        intentPlan: intent ? intent.plan : ""
      };
    });

    const identified = visits.filter(v => !v.anonymous);
    res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      totals: {
        visitors: visits.length,
        identifiedVisitors: identified.length,
        anonymousVisitors: visits.length - identified.length,
        totalVisits: visits.reduce((n, v) => n + v.visits, 0),
        converted: visits.filter(v => v.converted).length
      },
      visits
    });
  });

  /*
    Support tool: look at and adjust one account's free-credit balance. Every
    change is written to the ledger as an auditable transaction with the reason
    and a reference to which admin made it.
  */
  app.get("/api/admin/users/:id/credits", requireAdmin, (req, res) => {
    const account = getCreditAccount(req.params.id);
    res.json({
      ok: true,
      account: {
        userId: account.userId,
        balance: account.balance,
        introCreditsGranted: account.introCreditsGranted,
        lifetimeGranted: account.lifetimeGranted,
        lifetimeUsed: account.lifetimeUsed,
        lifetimeRefunded: account.lifetimeRefunded,
        introExcluded: Boolean(account.introExcluded)
      },
      transactions: listCreditTransactions(req.params.id, 50)
    });
  });

  app.post("/api/admin/users/:id/credits", requireAdmin, (req, res) => {
    const data = readAuth();
    const user = (data.users || []).find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    const delta = Math.floor(Number(req.body.delta));
    if (!Number.isFinite(delta) || delta === 0) {
      return res.status(400).json({ error: "delta must be a non-zero integer" });
    }
    const reason = String(req.body.reason || "admin_adjust").slice(0, 120);

    /*
      adjustmentKey makes a retried admin click idempotent when the client sends
      one; otherwise each deliberate adjustment is its own transaction.
    */
    const key = req.body.idempotencyKey ? `admin:${req.params.id}:${String(req.body.idempotencyKey)}` : "";
    const result = adjustCredits(req.params.id, delta, { reason, idempotencyKey: key });
    res.json({ ok: true, ...result, account: getCreditAccount(req.params.id) });
  });

  app.get("/api/admin/health", requireAdmin, (req, res) => {
    const env = process.env;

    res.json({
      ai: {
        openrouter: Boolean(env.OPENROUTER_API_KEY),
        gemini: Boolean(env.GEMINI_API_KEY),
        groq: Boolean(env.GROQ_API_KEY)
      },
      search: {
        tavily: Boolean(env.TAVILY_API_KEYS || env.TAVILY_API_KEY),
        tavilyPaid: Boolean(env.TAVILY_API_KEYS_PAID),
        tavilyPaidKeys: String(env.TAVILY_API_KEYS_PAID || "")
          .split(",").map(s => s.trim()).filter(Boolean).length,
        langsearch: Boolean(env.LANGSEARCH_API_KEYS || env.LANGSEARCH_API_KEY),
        langsearchKeys: String(env.LANGSEARCH_API_KEYS || env.LANGSEARCH_API_KEY || "")
          .split(",").map(s => s.trim()).filter(Boolean).length,
        tavilyCountry: env.TAVILY_COUNTRY || "us",
        tavilyMaxResults: Number(env.TAVILY_MAX_RESULTS || 20),
        tavilyCallsPerRun: Number(env.TAVILY_CALLS_PER_RUN || 3),
        firecrawl: Boolean(env.FIRECRAWL_API_KEYS || env.FIRECRAWL_API_KEY),
        firecrawlKeys: String(env.FIRECRAWL_API_KEYS || env.FIRECRAWL_API_KEY || "")
          .split(",").map(s => s.trim()).filter(Boolean).length,
        firecrawlPaid: Boolean(env.FIRECRAWL_API_KEYS_PAID),
        firecrawlPaidKeys: String(env.FIRECRAWL_API_KEYS_PAID || "")
          .split(",").map(s => s.trim()).filter(Boolean).length,
        firecrawlSearchLimit: Number(env.FIRECRAWL_SEARCH_LIMIT || 10),
        firecrawlCallsPerRun: Number(env.FIRECRAWL_CALLS_PER_RUN || 1),
        searxng: (() => {
          const url = String(env.SEARXNG_URL ?? "http://127.0.0.1:8888").trim();
          return url && url !== "off" && url !== "0" ? url : "";
        })()
      },
      email: {
        smtpConfigured: Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS),
        smtpUser: env.SMTP_USER || ""
      },
      auth: {
        googleConfigured: Boolean(env.GOOGLE_CLIENT_ID),
        superAdminConfigured: Boolean(env.SUPER_ADMIN_EMAIL || env.SUPER_ADMIN_EMAILS)
      },
      limits: {
        freeDailyLeadLimit: Number(env.FREE_DAILY_LEAD_LIMIT || 25),
        introCredits: introCreditAmount()
      }
    });
  });
}
