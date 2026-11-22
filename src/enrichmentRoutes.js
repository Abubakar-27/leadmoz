import express from "express";
import {
  enrichmentEnabled,
  enrichmentPublicConfig,
  enrichmentPriceMonthly,
  enrichmentMonthlyCredits,
  enrichmentTierForPlan
} from "./enrichmentConfig.js";
import { getUserById } from "./authStore.js";
import {
  getEnrichmentEntitlement,
  getEnrichmentAccount,
  enrichmentUsageSnapshot,
  grantEnrichmentAddon,
  revokeEnrichmentAddon,
  adjustEnrichmentCredits,
  listEnrichmentTransactions,
  providerUsageStats,
  setProviderDisabled,
  getDisabledProviders
} from "./enrichmentStore.js";
import {
  assertCanUseEnrichment,
  createEnrichmentJob,
  getEnrichmentJob,
  listEnrichmentJobs,
  cancelEnrichmentJob,
  retryEnrichmentJob,
  enrichCsvRows,
  enrichmentAdminSummary,
  recoverEnrichmentJobs
} from "./enrichment.js";
import { requireAuth, requireAdmin } from "./auth.js";
import { PAID_PLANS, getEffectivePlanId } from "./plans.js";

/*
  Company & Contact Enrichment routes.

  User routes are behind auth and rely on assertCanUseEnrichment (entitlement +
  base-plan gate) plus server-side credit checks inside the job engine. Admin
  routes use requireAdmin. CSV export is returned as text/csv and is the only
  way to download results without a new dependency.
*/

export const enrichmentRouter = express.Router();

function canUserUse(user) {
  const gate = assertCanUseEnrichment(user);
  if (!gate.ok) return gate;
  return { ok: true };
}

function parseStages(body = {}) {
  const raw = Array.isArray(body.stages) ? body.stages : ["profile", "decision_maker", "email"];
  const allowed = ["profile", "decision_maker", "email"];
  return raw.filter(s => allowed.includes(String(s)));
}

/* public-ish config for the app UI (still mounted behind auth on client) */
enrichmentRouter.get("/config", requireAuth, (req, res) => {
  const user = req.user;
  const gate = canUserUse(user);
  /*
    The viewer's own add-on price comes from THEIR base plan, decided here on
    the server. Free users get tier "" and the UI shows the tier list instead
    of a price - the frontend never supplies a price.
  */
  const viewerTier = user.role === "admin" ? "" : enrichmentTierForPlan(getEffectivePlanId(user));
  return res.json({
    ...enrichmentPublicConfig(),
    canUse: gate.ok,
    reason: gate.ok ? "" : gate.error,
    status: gate.ok ? gate.status || 200 : gate.status || 402,
    tier: viewerTier,
    priceMonthly: viewerTier ? enrichmentPriceMonthly(viewerTier) : 0,
    monthlyCredits: enrichmentMonthlyCredits(viewerTier || "starter"),
    entitlement: user.role === "admin" ? { active: true, admin: true } : getEnrichmentEntitlement(user.id),
    account: user.role === "admin" ? { balance: "unlimited", admin: true } : getEnrichmentAccount(user.id),
    snapshot: enrichmentUsageSnapshot(user)
  });
});

/* list jobs */
enrichmentRouter.get("/jobs", requireAuth, (req, res) => {
  const gate = canUserUse(req.user);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });
  const limit = Number(req.query.limit) || 20;
  const jobs = listEnrichmentJobs(req.user, limit);
  /*
    Send the credit snapshot with the job list: the engine reserves a stage's
    cost while the job runs, so the UI's poll is the only moment the meter can
    stay truthful without a second request every 3 seconds.
  */
  return res.json({ jobs, snapshot: enrichmentUsageSnapshot(req.user) });
});

/* create job */
enrichmentRouter.post("/jobs", requireAuth, async (req, res) => {
  const gate = canUserUse(req.user);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  try {
    const domains = req.body?.domains;
    const companyNames = req.body?.companyNames || {};
    const stages = parseStages(req.body);
    const result = await createEnrichmentJob(req.user, { domains, companyNames, stages });
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
    return res.json({ job: result.job });
  } catch (err) {
    console.error("enrichment: create job failed", err);
    return res.status(500).json({ error: "Failed to start enrichment." });
  }
});

/* CSV export. Registered BEFORE /jobs/:id: Express 4's `:id` also matches a
   value containing a dot, so listing it after the detail route made
   /jobs/<id>.csv resolve as a job id and 404. */
enrichmentRouter.get("/jobs/:id.csv", requireAuth, (req, res) => {
  const gate = canUserUse(req.user);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });
  const csv = enrichCsvRows(req.params.id, req.user);
  if (csv === null) return res.status(404).json({ error: "Job not found." });
  const filename = `enrichment-${req.params.id}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  return res.send(csv);
});

/* get job */
enrichmentRouter.get("/jobs/:id", requireAuth, (req, res) => {
  const gate = canUserUse(req.user);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });
  const job = getEnrichmentJob(req.user, req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found." });
  return res.json({ job });
});

/* cancel job */
enrichmentRouter.post("/jobs/:id/cancel", requireAuth, (req, res) => {
  const gate = canUserUse(req.user);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });
  const result = cancelEnrichmentJob(req.user, req.params.id);
  if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
  return res.json({ job: result.job, alreadyFinished: result.alreadyFinished });
});

/* retry job */
enrichmentRouter.post("/jobs/:id/retry", requireAuth, (req, res) => {
  const gate = canUserUse(req.user);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });
  const result = retryEnrichmentJob(req.user, req.params.id);
  if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
  return res.json({ job: result.job });
});

/* CSV export moved above the job-detail route so `:id.csv` is not swallowed
   by `:id` - see the note on the route itself. */

/* ------------------------------------------------------------------ admin */

enrichmentRouter.get("/admin/summary", requireAdmin, (req, res) => {
  const summary = enrichmentAdminSummary();
  return res.json({ summary, providerUsage: providerUsageStats(), disabledProviders: getDisabledProviders() });
});

enrichmentRouter.get("/admin/entitlements/:userId", requireAdmin, (req, res) => {
  const userId = String(req.params.userId || "");
  return res.json({
    entitlement: getEnrichmentEntitlement(userId),
    account: getEnrichmentAccount(userId),
    transactions: listEnrichmentTransactions(userId, 100)
  });
});

enrichmentRouter.post("/admin/grant", requireAdmin, (req, res) => {
  const userId = String(req.body?.userId || "");
  const days = Number(req.body?.days) || 30;
  if (!userId) return res.status(400).json({ error: "userId required" });
  /*
    The granted tier (price AND allowance) is derived from the target account's
    own plan here on the server - an admin request cannot name a cheaper tier.
  */
  const tier = enrichmentTierForPlan(getEffectivePlanId(getUserById(userId)));
  const result = grantEnrichmentAddon(userId, {
    days,
    transactionId: req.body?.transactionId || `admin_${Date.now()}`,
    source: "admin",
    tier
  });
  return res.json(result);
});

enrichmentRouter.post("/admin/revoke", requireAdmin, (req, res) => {
  const userId = String(req.body?.userId || "");
  if (!userId) return res.status(400).json({ error: "userId required" });
  const result = revokeEnrichmentAddon(userId, { reason: req.body?.reason || "admin_revoked" });
  return res.json(result);
});

enrichmentRouter.post("/admin/adjust-credits", requireAdmin, (req, res) => {
  const userId = String(req.body?.userId || "");
  const delta = Number(req.body?.delta) || 0;
  if (!userId) return res.status(400).json({ error: "userId required" });
  const result = adjustEnrichmentCredits(userId, delta, { reason: req.body?.reason || "admin_adjust" });
  return res.json(result);
});

enrichmentRouter.post("/admin/provider/:provider/disable", requireAdmin, (req, res) => {
  const provider = String(req.params.provider || "");
  const disabled = Boolean(req.body?.disabled);
  const result = setProviderDisabled(provider, disabled);
  return res.json(result);
});

enrichmentRouter.post("/admin/recover", requireAdmin, (req, res) => {
  const result = recoverEnrichmentJobs();
  return res.json(result);
});

export function mountEnrichment(app) {
  app.use("/api/enrichment", enrichmentRouter);
}
