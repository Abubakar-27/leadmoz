import path from "path";
import crypto from "node:crypto";
import { readJsonWithBackup, writeJsonAtomic } from "./atomicJson.js";
import {
  enrichmentEnabled,
  enrichmentStageCost,
  enrichmentLimits,
  enrichmentRequireBasePlan,
  enrichmentPublicConfig
} from "./enrichmentConfig.js";
import {
  isEnrichmentEntitled,
  reserveEnrichmentCredits,
  refundEnrichmentCredits,
  enrichmentBalance
} from "./enrichmentStore.js";
import {
  scrapeCompanySite,
  mapWebsiteProfile,
  mapWebsiteDecisionMakers,
  mapWebsiteEmails,
  hunterDomainSearch,
  hunterFindEmail,
  hunterVerifyEmail,
  hunterAvailable,
  freeFindEmail,
  freeVerifyEmail,
  freeEmailAvailable,
  webSearchAvailable,
  EMAIL_STATUS
} from "./enrichmentProviders.js";
import { researchPeopleOnWeb, researchPersonByName } from "./enrichmentResearch.js";
import { getCachedEnrichment, setCachedEnrichment } from "./enrichmentCache.js";
import { normalizeDomain, dedupeDomains, assertPublicDomain } from "./enrichmentSafety.js";
import { PAID_PLANS, getEffectivePlanId } from "./plans.js";
import { trackEvent } from "./analytics.js";

/*
  Company & Contact Enrichment - job workflow.

  One job = a set of domains x a set of stages (profile, decision_maker, email).
  Stages run independently and are charged independently; a stage that returns
  nothing usable is refunded. Results are cached per domain, and a cache hit is
  free. The queue is in-process and bounded, and jobs left mid-flight by a
  restart are re-queued on boot instead of being failed (see recoverEnrichmentJobs).
*/

const DATA_DIR = path.join(process.cwd(), "data");
const JOBS_FILE = path.join(DATA_DIR, "enrichment-jobs.json");
const MAX_JOBS_TOTAL = 3000;
const MAX_JOBS_PER_USER = 100;
const MAX_ERROR_CHARS = 300;

const VALID_STAGES = ["profile", "decision_maker", "email"];
const TERMINAL = new Set(["completed", "partial", "failed", "canceled"]);

const queue = [];
let active = 0;
let pumping = false;
const cancelRequested = new Set();

function emptyJobs() {
  return { version: 1, jobs: {} };
}

function readJobs() {
  const raw = readJsonWithBackup(JOBS_FILE, emptyJobs);
  return { version: 1, jobs: raw && typeof raw.jobs === "object" && raw.jobs ? raw.jobs : {} };
}

function writeJobs(data) {
  writeJsonAtomic(JOBS_FILE, data);
}

function nowIso() {
  return new Date().toISOString();
}

function newJobId() {
  return `enr_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function trimError(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_CHARS);
}

function pruneJobs(data) {
  const entries = Object.values(data.jobs);
  if (entries.length <= MAX_JOBS_TOTAL) return;
  const removable = entries
    .filter(j => TERMINAL.has(j.status) && !j.pinned)
    .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
  const excess = entries.length - MAX_JOBS_TOTAL;
  for (const job of removable.slice(0, excess)) delete data.jobs[job.id];
}

function stageLabel(stage) {
  if (stage === "profile") return "Company profile";
  if (stage === "decision_maker") return "Decision-makers";
  if (stage === "email") return "Business email";
  return stage;
}

function usable(value) {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

/* ---------------------------------------------------------------- validation */

export function enrichmentFeatureReady() {
  return enrichmentEnabled();
}

export function assertCanUseEnrichment(user) {
  if (!user) return { ok: false, status: 401, error: "Please sign in." };
  if (!enrichmentEnabled()) {
    return { ok: false, status: 503, error: "Company enrichment is not available right now." };
  }
  if (user.role !== "admin" && enrichmentRequireBasePlan()) {
    const plan = getEffectivePlanId(user);
    if (!PAID_PLANS.includes(plan)) {
      return { ok: false, status: 402, error: "Company enrichment is an add-on to a paid plan." };
    }
  }
  if (!isEnrichmentEntitled(user)) {
    return { ok: false, status: 402, error: "Add Company Enrichment to use this feature." };
  }
  return { ok: true };
}

function jobsCreatedLastHour(userId) {
  const since = Date.now() - 60 * 60 * 1000;
  return Object.values(readJobs().jobs).filter(j =>
    j.userId === userId && new Date(j.createdAt || 0).getTime() >= since
  ).length;
}

/* ------------------------------------------------------------------- create */

export async function createEnrichmentJob(user, { domains = [], companyNames = {}, stages = VALID_STAGES } = {}) {
  const gate = assertCanUseEnrichment(user);
  if (!gate.ok) return gate;

  const limits = enrichmentLimits();
  const selected = VALID_STAGES.filter(s => Array.isArray(stages) && stages.includes(s));
  if (selected.length === 0) {
    return { ok: false, status: 400, error: "Choose at least one enrichment step." };
  }

  const rawList = Array.isArray(domains) ? domains : String(domains || "").split(/[\s,;]+/);
  const cleaned = dedupeDomains(rawList);
  if (cleaned.length === 0) {
    return { ok: false, status: 400, error: "Add at least one valid company website or domain." };
  }
  if (cleaned.length > limits.maxDomainsPerJob) {
    return {
      ok: false,
      status: 400,
      error: `You can enrich up to ${limits.maxDomainsPerJob} companies per job.`
    };
  }

  if (jobsCreatedLastHour(user.id) >= limits.perHour) {
    return { ok: false, status: 429, error: "Too many enrichment jobs. Please try again shortly." };
  }

  const perCompany = selected.reduce((sum, s) => sum + enrichmentStageCost(s), 0);
  if (enrichmentBalance(user.id) < perCompany && user.role !== "admin") {
    return {
      ok: false,
      status: 402,
      error: `You need at least ${perCompany} enrichment credits to run these steps.`
    };
  }

  const id = newJobId();
  const ts = nowIso();
  const job = {
    id,
    userId: user.id,
    adminBypass: user.role === "admin",
    status: "queued",
    stages: selected,
    createdAt: ts,
    updatedAt: ts,
    startedAt: "",
    finishedAt: "",
    cancelRequested: false,
    creditsCharged: 0,
    creditsRefunded: 0,
    counts: { total: cleaned.length, done: 0, ok: 0, partial: 0, failed: 0, skipped: 0 },
    items: cleaned.map(domain => ({
      domain,
      companyName: String(companyNames?.[domain] || companyNames?.[rawListIndex(rawList, domain)] || "").trim().slice(0, 120),
      status: "pending",
      reason: "",
      stages: Object.fromEntries(selected.map(s => [s, { status: "pending", reason: "" }])),
      creditsCharged: 0,
      creditsRefunded: 0,
      result: null
    })),
    error: ""
  };

  const data = readJobs();
  data.jobs[id] = job;
  pruneJobs(data);
  writeJobs(data);

  enqueue(id);

  /*
    Funnel event. Aggregated (one write per job, not per company) because the
    analytics file is rewritten on every event.
  */
  try {
    trackEvent("enrichment_job_created", {
      userId: user.id,
      meta: { domains: cleaned.length, stages: selected.join(",") }
    });
  } catch (err) {
    console.error("[enrichment] analytics failed:", err.message);
  }

  return { ok: true, job: shapeJob(job) };
}

function rawListIndex(rawList, domain) {
  return rawList.find(d => normalizeDomain(d) === domain) || "";
}

/* ------------------------------------------------------------------- worker */

function enqueue(jobId) {
  if (!queue.includes(jobId)) queue.push(jobId);
  pump();
}

function pump() {
  if (pumping) return;
  pumping = true;
  try {
    const limit = enrichmentLimits().concurrency;
    while (active < limit && queue.length > 0) {
      const jobId = queue.shift();
      const data = readJobs();
      const job = data.jobs[jobId];
      if (!job || TERMINAL.has(job.status)) continue;
      active += 1;
      processJob(jobId)
        .catch(() => {})
        .finally(() => {
          active = Math.max(0, active - 1);
          pumping = false;
          pump();
        });
    }
  } finally {
    pumping = false;
  }
}

function saveJob(job) {
  const data = readJobs();
  data.jobs[job.id] = job;
  writeJobs(data);
}

function recount(job) {
  const counts = { total: job.items.length, done: 0, ok: 0, partial: 0, failed: 0, skipped: 0 };
  for (const item of job.items) {
    if (item.status === "ok") counts.ok += 1;
    else if (item.status === "partial") counts.partial += 1;
    else if (item.status === "failed") counts.failed += 1;
    else if (item.status === "skipped") counts.skipped += 1;
    if (TERMINAL.has(item.status) || item.status === "ok" || item.status === "partial" || item.status === "failed" || item.status === "skipped") {
      counts.done += 1;
    }
  }
  job.counts = counts;
  return counts;
}

async function processJob(jobId) {
  const started = nowIso();
  let data = readJobs();
  let job = data.jobs[jobId];
  if (!job || TERMINAL.has(job.status)) return;

  job.status = "running";
  job.startedAt = job.startedAt || started;
  job.updatedAt = started;
  saveJob(job);

  try {
    for (const item of job.items) {
      if (cancelRequested.has(jobId) || job.cancelRequested) break;

      if (TERMINAL.has(item.status)) continue;

      data = readJobs();
      job = data.jobs[job.id];
      const target = job.items.find(i => i.domain === item.domain);
      if (!target) continue;

      target.status = "running";
      job.updatedAt = nowIso();
      saveJob(job);

      const outcome = await enrichSingleDomain(job, target);

      data = readJobs();
      job = data.jobs[job.id];
      const fresh = job.items.find(i => i.domain === target.domain);
      if (!fresh) continue;
      Object.assign(fresh, outcome);
      fresh.status = outcome.status;
      job.creditsCharged += outcome.creditsCharged || 0;
      job.creditsRefunded += outcome.creditsRefunded || 0;
      recount(job);
      job.updatedAt = nowIso();
      saveJob(job);

      if (outcome.stoppedForCredits) {
        for (const rest of job.items) {
          if (rest.status === "pending") {
            rest.status = "skipped";
            rest.reason = "insufficient_credits";
            for (const s of Object.keys(rest.stages)) {
              if (rest.stages[s].status === "pending") rest.stages[s] = { status: "skipped", reason: "insufficient_credits" };
            }
          }
        }
        recount(job);
        break;
      }
    }
  } catch (err) {
    job = readJobs().jobs[job.id] || job;
    job.error = trimError(err.message || "Enrichment failed");
  }

  data = readJobs();
  job = data.jobs[job.id];
  if (!job) return;

  for (const item of job.items) {
    if (item.status === "pending" || item.status === "running") {
      item.status = "skipped";
      item.reason = job.cancelRequested || cancelRequested.has(job.id) ? "canceled" : "not_processed";
      for (const s of Object.keys(item.stages)) {
        if (item.stages[s].status === "pending" || item.stages[s].status === "running") {
          item.stages[s] = { status: "skipped", reason: item.reason };
        }
      }
    }
  }

  const counts = recount(job);
  if (job.cancelRequested || cancelRequested.has(job.id)) job.status = "canceled";
  else if (counts.ok === counts.total) job.status = "completed";
  else if (counts.ok + counts.partial > 0) job.status = "partial";
  else job.status = "failed";

  job.finishedAt = nowIso();
  job.updatedAt = job.finishedAt;
  saveJob(job);
  cancelRequested.delete(job.id);

  emitJobAnalytics(job);
}

/*
  Product metrics for the add-on (spec section 13). Everything is counted once
  per job and carries no PII - only numbers - so the whole set costs a handful
  of writes. A failure here must never affect a job the user is waiting on.
*/
function emitJobAnalytics(job) {
  try {
    /* A canceled job is neither a completion nor a failure - it is not counted. */
    if (job.status === "canceled") return;

    const meta = {
      status: job.status,
      total: job.counts.total,
      ok: job.counts.ok,
      partial: job.counts.partial,
      failed: job.counts.failed
    };
    trackEvent(job.status === "failed" ? "enrichment_job_failed" : "enrichment_job_completed", {
      userId: job.userId,
      meta
    });

    if (job.status === "failed") return;

    let profiles = 0;
    let decisionMakers = 0;
    let emails = 0;
    let verified = 0;
    for (const item of job.items) {
      if (item.result?.profile) profiles += 1;
      decisionMakers += (item.result?.contacts || []).length;
      emails += (item.result?.emails || []).length;
      verified += (item.result?.emails || []).filter(e => e && e.status === "verified").length;
    }

    if (profiles > 0) trackEvent("enrichment_company_profile_found", { userId: job.userId, meta: { count: profiles } });
    if (decisionMakers > 0) trackEvent("enrichment_decision_maker_found", { userId: job.userId, meta: { count: decisionMakers } });
    if (emails > 0) trackEvent("enrichment_email_found", { userId: job.userId, meta: { count: emails } });
    if (verified > 0) trackEvent("enrichment_email_verified", { userId: job.userId, meta: { count: verified } });

    if (job.items.some(i => i.reason === "insufficient_credits")) {
      trackEvent("enrichment_credits_exhausted", { userId: job.userId, meta: { total: job.counts.total } });
    }
  } catch (err) {
    console.error("[enrichment] analytics failed:", err.message);
  }
}

/* --------------------------------------------------------- per-domain logic */

async function chargeStage(job, domain, stage, item, out) {
  const cost = enrichmentStageCost(stage);
  if (cost <= 0) return { ok: true, charged: 0 };
  /*
    Admins never spend: /config reports their balance as "unlimited", so
    charging here would make every admin job skip with insufficient_credits.
  */
  if (job.adminBypass) return { ok: true, charged: 0 };
  const result = reserveEnrichmentCredits(job.userId, cost, {
    reason: `enrichment_${stage}`,
    idempotencyKey: `${job.id}:${domain}:${stage}`
  });
  if (!result.ok) return { ok: false, charged: 0, error: result.error || "insufficient_credits" };
  item.creditsCharged += result.reserved || 0;
  /* keep the per-domain and per-job totals in step with the ledger: the job
     total is what the dashboard and admin summary report as credits charged */
  if (out) out.creditsCharged += result.reserved || 0;
  return { ok: true, charged: result.reserved || 0, duplicate: Boolean(result.duplicate) };
}

function refundStage(job, domain, stage, item, charged) {
  if (!charged || charged <= 0) return 0;
  const result = refundEnrichmentCredits(job.userId, charged, {
    reason: `enrichment_${stage}_no_result`,
    idempotencyKey: `${job.id}:${domain}:${stage}:refund`
  });
  if (result.ok && !result.duplicate) {
    item.creditsRefunded += result.refunded || 0;
    return result.refunded || 0;
  }
  return 0;
}

async function enrichSingleDomain(job, item) {
  const domain = item.domain;
  const stages = job.stages;
  const out = {
    status: "failed",
    reason: "",
    stages: { ...item.stages },
    creditsCharged: 0,
    creditsRefunded: 0,
    result: item.result || null,
    stoppedForCredits: false
  };

  const cached = getCachedEnrichment(domain);
  if (cached && cached.data) {
    const cachedResult = cached.data;
    const requested = {};
    if (stages.includes("profile") && cachedResult.profile) requested.profile = { status: "ok", reason: "", cached: true };
    if (stages.includes("decision_maker") && usable(cachedResult.contacts)) requested.decision_maker = { status: "ok", reason: "", cached: true };
    if (stages.includes("email") && usable(cachedResult.emails)) requested.email = { status: "ok", reason: "", cached: true };
    if (Object.keys(requested).length > 0) {
      for (const stage of stages) {
        if (!requested[stage]) requested[stage] = { status: "not_found", reason: "not_in_cache", cached: true };
      }
      out.stages = requested;
      out.result = { ...cachedResult, cached: true };
      out.status = Object.values(requested).some(s => s.status === "ok") ? "ok" : "partial";
      out.reason = "cached";
      return out;
    }
  }

  try {
    await assertPublicDomain(domain);
  } catch (err) {
    out.status = "failed";
    out.reason = err.code === "unsafe_destination" ? "unsafe_destination"
      : err.code === "dns_failed" ? "domain_not_found"
      : "invalid_domain";
    for (const stage of stages) out.stages[stage] = { status: "failed", reason: out.reason };
    return out;
  }

  const needSite = stages.length > 0;
  const scraped = needSite ? await scrapeCompanySite(domain, { companyName: item.companyName }) : null;

  const result = {
    domain,
    companyName: item.companyName || "",
    profile: null,
    contacts: [],
    emails: [],
    sources: [],
    providerNotes: [],
    retrievedAt: nowIso(),
    cached: false
  };

  const stageOk = {};
  let stoppedForCredits = false;

  /* Hunter's domain search is fetched at most ONCE per company, even when both
     decision-makers and email steps are selected - the free allowance is small
     and a second identical call would be pure waste. */
  let hunterBundle = null;
  const getHunterEmails = async () => {
    if (hunterBundle) return hunterBundle;
    if (!hunterAvailable()) {
      hunterBundle = { ok: false, reason: "hunter_unavailable", emails: [] };
      return hunterBundle;
    }
    hunterBundle = await hunterDomainSearch(domain);
    if (!hunterBundle.ok && hunterBundle.reason) {
      result.providerNotes.push(`hunter: ${trimError(hunterBundle.reason)}`);
    }
    return hunterBundle;
  };

  /* ---- company profile */
  if (stages.includes("profile")) {
    const charge = await chargeStage(job, domain, "profile", item, out);
    if (!charge.ok) {
      out.stages.profile = { status: "skipped", reason: "insufficient_credits" };
      stoppedForCredits = true;
    } else {
      const profile = mapWebsiteProfile(scraped, domain);
      if (profile) {
        result.profile = profile;
        result.sources.push(...profile.sourceUrls);
        out.stages.profile = { status: "ok", reason: "" };
      } else {
        out.stages.profile = { status: "not_found", reason: "site_unreadable" };
        out.creditsRefunded += refundStage(job, domain, "profile", item, charge.charged);
      }
    }
  }

  /*
    Web-search research: when the company's own site (and Hunter) name nobody,
    search the public web for the owner/founder and read the top result pages.
    Fetched at most ONCE per company and shared with the email stage, exactly
    like the Hunter bundle. Never runs when the site already found people -
    their own pages are the most authoritative source and cost nothing extra.
  */
  let researchBundle = null;
  const getResearch = async () => {
    if (researchBundle) return researchBundle;
    if (!webSearchAvailable()) {
      researchBundle = { contacts: [], emails: [], sources: [], notes: ["web_search: not available"] };
      return researchBundle;
    }
    try {
      researchBundle = await researchPeopleOnWeb(domain, { companyName: item.companyName || scraped?.businessName || "" });
    } catch (err) {
      researchBundle = { contacts: [], emails: [], sources: [], notes: [`web_search: ${trimError(err.message)}`] };
    }
    for (const note of researchBundle.notes || []) result.providerNotes.push(note);
    for (const src of researchBundle.sources || []) if (!result.sources.includes(src)) result.sources.push(src);
    return researchBundle;
  };

  /*
    Person-level research: once a person is NAMED, search the public web for
    THAT person - LinkedIn/X profile, interviews, directories - anywhere they
    are publicly documented. One search per person, shared by the
    decision-maker and email stages exactly like the company bundle.
  */
  const personResearchCache = new Map();
  const getPersonResearch = async (name) => {
    const key = String(name || "").trim().toLowerCase();
    const empty = { contacts: [], emails: [], profiles: [], sources: [], notes: [] };
    if (!key) return empty;
    if (personResearchCache.has(key)) return personResearchCache.get(key);
    let bundle;
    if (!webSearchAvailable()) {
      bundle = { ...empty, notes: ["web_search: not available"] };
    } else {
      try {
        bundle = await researchPersonByName(name, {
          company: item.companyName || scraped?.businessName || "",
          domain
        });
      } catch (err) {
        bundle = { ...empty, notes: [`web_search: ${trimError(err.message)}`] };
      }
    }
    for (const note of bundle.notes || []) {
      if (!result.providerNotes.includes(note)) result.providerNotes.push(note);
    }
    for (const src of bundle.sources || []) if (!result.sources.includes(src)) result.sources.push(src);
    personResearchCache.set(key, bundle);
    return bundle;
  };

  /* ---- decision makers */
  if (stages.includes("decision_maker") && !stoppedForCredits) {
    const charge = await chargeStage(job, domain, "decision_maker", item, out);
    if (!charge.ok) {
      out.stages.decision_maker = { status: "skipped", reason: "insufficient_credits" };
      stoppedForCredits = true;
    } else {
      const contacts = mapWebsiteDecisionMakers(scraped, domain);
      const byName = new Map(contacts.map(c => [c.name.toLowerCase(), c]));

      if (hunterAvailable()) {
        const hunter = await getHunterEmails();
        for (const email of hunter.emails || []) {
          if (!email.contactName) continue;
          const key = email.contactName.toLowerCase();
          if (byName.has(key)) {
            const existing = byName.get(key);
            existing.title = existing.title || email.title;
            existing.sourceUrl = existing.sourceUrl || email.sourceUrl;
            existing.confidence = existing.confidence === "low" ? "medium" : existing.confidence;
          } else {
            const contact = {
              name: email.contactName,
              title: email.title || "",
              company: result.profile?.name || scraped?.businessName || domain,
              domain,
              profileUrl: "",
              source: "hunter",
              sourceUrl: email.sourceUrl || "",
              confidence: Number(email.confidence) >= 90 ? "medium" : "low",
              status: "reported",
              verification: "unverified"
            };
            byName.set(key, contact);
            contacts.push(contact);
          }
        }
      } else {
        result.providerNotes.push("hunter: not available (website contacts only)");
      }

      /*
        Wider public web - when the company's own sources found nobody, or
        found nobody whose public professional profile we have. The company
        search itself is free of extra charge (paid for by the decision-maker
        stage above) and runs at most once per company.
      */
      const needsWebProfile = contacts.length === 0 || contacts.every(c => !c.profileUrl);
      if (needsWebProfile) {
        const research = await getResearch();
        for (const person of research.contacts || []) {
          const key = person.name.toLowerCase();
          if (byName.has(key)) continue;
          byName.set(key, person);
          contacts.push(person);
        }
      }

      /*
        Named person, unknown profile: search the public web for THAT person
        - their LinkedIn/X profile, interviews, directory entries. The profile
        URL is taken from search results and must match the person's own name
        slug; LinkedIn itself is never fetched (its terms forbid it). Bounded
        to three people per company so one job cannot drain the daily cap.
      */
      const wantProfile = contacts.filter(c => !c.profileUrl && c.name.includes(" ")).slice(0, 3);
      for (const person of wantProfile) {
        const detail = await getPersonResearch(person.name);
        const profile = (detail.profiles || [])[0] || "";
        if (profile) person.profileUrl = profile;
        if (!person.sourceUrl && (detail.sources || []).length) person.sourceUrl = detail.sources[0];
        if (!person.title) person.title = detail.contacts?.[0]?.title || "";
      }

      result.contacts = contacts.slice(0, 10);
      if (result.contacts.length > 0) {
        out.stages.decision_maker = { status: "ok", reason: "" };
      } else {
        out.stages.decision_maker = { status: "not_found", reason: "no_decision_makers_found" };
        out.creditsRefunded += refundStage(job, domain, "decision_maker", item, charge.charged);
      }
    }
  }

  /* ---- business email */
  if (stages.includes("email") && !stoppedForCredits) {
    const charge = await chargeStage(job, domain, "email", item, out);
    if (!charge.ok) {
      out.stages.email = { status: "skipped", reason: "insufficient_credits" };
      stoppedForCredits = true;
    } else {
      const emails = mapWebsiteEmails(scraped, domain);
      const seen = new Set(emails.map(e => e.email));

      /* Company-domain addresses published on third-party public pages - only
         when the company's own site published none (research runs at most once
         per company and is free to reuse if the decision-maker stage paid for it). */
      const needWebEmails = emails.length === 0;
      const research = needWebEmails ? await getResearch() : { emails: [], sources: [] };
      for (const email of research.emails || []) {
        if (seen.has(email)) continue;
        seen.add(email);
        emails.push({
          email,
          contactName: "",
          title: "",
          domain,
          provider: "web",
          source: "web",
          sourceUrl: (research.sources || [])[0] || "",
          status: EMAIL_STATUS.UNVERIFIED,
          published: true,
          freemail: false,
          confidence: 50,
          verifiedAt: "",
          retrievedAt: nowIso()
        });
      }

      /*
        Emails published on pages about a NAMED decision-maker (company domain
        only, same guard). Person research is cached from the decision-maker
        stage, so this reuses its searches instead of paying again.
      */
      if (needWebEmails) {
        const namedNoEmail = result.contacts.filter(c => !c.email && c.name.includes(" ")).slice(0, 2);
        for (const person of namedNoEmail) {
          const detail = await getPersonResearch(person.name);
          for (const email of detail.emails || []) {
            if (seen.has(email)) continue;
            seen.add(email);
            emails.push({
              email,
              contactName: person.name,
              title: person.title || "",
              domain,
              provider: "web",
              source: "web",
              sourceUrl: (detail.sources || [])[0] || "",
              status: EMAIL_STATUS.UNVERIFIED,
              published: true,
              freemail: false,
              confidence: 50,
              verifiedAt: "",
              retrievedAt: nowIso()
            });
            if (!person.email) person.email = email;
          }
        }
      }

      const freeEnabled = freeEmailAvailable();

      if (hunterAvailable()) {
        const hunter = await getHunterEmails();
        for (const email of hunter.emails || []) {
          if (!email.email || seen.has(email.email)) continue;
          seen.add(email.email);
          emails.push(email);
          if (!email.contactName) continue;
          const contact = result.contacts.find(c => c.name.toLowerCase() === email.contactName.toLowerCase());
          if (contact && !contact.email) contact.email = email.email;
        }
      }

      /*
        Keyless finder: for each named decision-maker still missing an address,
        try the common professional layouts and confirm the winner against the
        company's own MX server. Hunter (when configured) is tried first
        because its database knows real addresses; the built-in finder then
        fills the gaps without spending any provider quota.

        Nothing is invented: a candidate only becomes a contact email when the
        mail server actually accepts that mailbox and the domain is not
        catch-all (see src/apis/freeEmail.js).
      */
      const needsEmail = result.contacts
        .filter(c => !c.email && c.name.includes(" "))
        .slice(0, enrichmentLimits().freeEmailFindMaxPerCompany);

      for (const contact of needsEmail) {
        const [first, ...rest] = contact.name.split(/\s+/);

        if (hunterAvailable()) {
          const found = await hunterFindEmail(domain, first, rest.join(" "));
          if (found.ok && found.email && !seen.has(found.email.email)) {
            seen.add(found.email.email);
            found.email.contactName = contact.name;
            found.email.title = contact.title || found.email.title;
            emails.push(found.email);
            contact.email = found.email.email;
            continue;
          }
        }

        if (!freeEnabled) continue;
        const found = await freeFindEmail(domain, first, rest.join(" "));
        if (found.ok && found.email && !seen.has(found.email.email)) {
          seen.add(found.email.email);
          found.email.contactName = contact.name;
          found.email.title = contact.title || found.email.title;
          emails.push(found.email);
          contact.email = found.email.email;
        }
      }

      /*
        Verification. The built-in SMTP check costs nothing, so it runs first
        for the most promising addresses. Hunter is only asked about addresses
        the free check could not decide, which preserves its small quota.
      */
      if (freeEnabled) {
        const toVerify = emails
          .filter(e => e.status === EMAIL_STATUS.UNVERIFIED || e.status === EMAIL_STATUS.LIKELY)
          .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
          .slice(0, enrichmentLimits().freeEmailVerifyMaxPerCompany);

        for (const email of toVerify) {
          if (!freeEmailAvailable()) break;
          const verified = await freeVerifyEmail(email.email);
          if (verified.ok) {
            email.status = verified.status;
            email.verifiedAt = verified.verifiedAt || "";
            email.confidence = Math.max(Number(email.confidence) || 0, Number(verified.score) || 0);
          }
        }
      }

      if (hunterAvailable()) {
        const stillUnknown = emails
          .filter(e => e.status === EMAIL_STATUS.UNVERIFIED)
          .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
          .slice(0, 5);

        for (const email of stillUnknown) {
          if (!hunterAvailable()) break;
          const verified = await hunterVerifyEmail(email.email);
          if (verified.ok) {
            email.status = verified.status;
            email.verifiedAt = verified.verifiedAt || "";
            email.confidence = Math.max(Number(email.confidence) || 0, Number(verified.score) || 0);
          }
        }
      }

      if (!freeEnabled && !hunterAvailable()) {
        result.providerNotes.push("email lookup: no verification provider available");
      }

      const deduped = [];
      const finalSeen = new Set();
      for (const email of emails) {
        if (!email.email || finalSeen.has(email.email)) continue;
        finalSeen.add(email.email);
        deduped.push(email);
      }

      result.emails = deduped.slice(0, enrichmentLimits().emailsPerCompany);

      if (result.emails.length > 0) {
        out.stages.email = { status: "ok", reason: "" };
      } else {
        const providerBlocked = !freeEmailAvailable() && !hunterAvailable();
        out.stages.email = {
          status: "not_found",
          reason: providerBlocked ? "no_email_found_provider_unavailable" : "no_email_found"
        };
        out.creditsRefunded += refundStage(job, domain, "email", item, charge.charged);
      }
    }
  }

  /* Cache a bundle that actually contains something, so repeats are free. */
  const hasAny = Boolean(result.profile) || usable(result.contacts) || usable(result.emails);
  if (hasAny) {
    result.sources = [...new Set(result.sources)].slice(0, 10);
    setCachedEnrichment(domain, {
      profile: result.profile,
      contacts: result.contacts,
      emails: result.emails,
      sources: result.sources,
      retrievedAt: result.retrievedAt
    });
  }

  out.result = result;
  out.stoppedForCredits = stoppedForCredits;

  const okCount = Object.values(out.stages).filter(s => s.status === "ok").length;
  const failedCount = Object.values(out.stages).filter(s => s.status === "failed").length;

  if (okCount === stages.length) {
    out.status = "ok";
    out.reason = "";
  } else if (okCount > 0) {
    out.status = "partial";
    out.reason = Object.entries(out.stages).filter(([, s]) => s.status !== "ok").map(([k, s]) => `${k}:${s.reason || s.status}`).join(", ");
  } else if (stoppedForCredits) {
    out.status = "skipped";
    out.reason = "insufficient_credits";
  } else {
    out.status = "failed";
    out.reason = failedCount > 0
      ? Object.entries(out.stages).find(([, s]) => s.status === "failed")?.[1]?.reason || "failed"
      : "no_results";
  }

  if (item.companyName && result.profile && !result.profile.name) result.profile.name = item.companyName;
  return out;
}

/* ------------------------------------------------------------------- public */

export function shapeJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    stages: job.stages,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    creditsCharged: job.creditsCharged,
    creditsRefunded: job.creditsRefunded,
    counts: job.counts,
    error: job.error,
    items: job.items.map(item => ({
      domain: item.domain,
      companyName: item.companyName,
      status: item.status,
      reason: item.reason,
      stages: item.stages,
      creditsCharged: item.creditsCharged,
      creditsRefunded: item.creditsRefunded,
      result: item.result
    }))
  };
}

export function getEnrichmentJob(user, jobId) {
  if (!user) return null;
  const job = readJobs().jobs[String(jobId || "")];
  if (!job) return null;
  if (job.userId !== user.id && user.role !== "admin") return null;
  return shapeJob(job);
}

export function listEnrichmentJobs(user, limit = 20) {
  if (!user) return [];
  return Object.values(readJobs().jobs)
    .filter(j => j.userId === user.id)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, Math.max(1, Number(limit) || 20))
    .map(shapeJob);
}

export function cancelEnrichmentJob(user, jobId) {
  const data = readJobs();
  const job = data.jobs[String(jobId || "")];
  if (!job || (job.userId !== user.id && user.role !== "admin")) {
    return { ok: false, status: 404, error: "Job not found." };
  }
  if (TERMINAL.has(job.status)) {
    return { ok: true, job: shapeJob(job), alreadyFinished: true };
  }
  job.cancelRequested = true;
  job.updatedAt = nowIso();
  data.jobs[job.id] = job;
  writeJobs(data);
  cancelRequested.add(job.id);
  return { ok: true, job: shapeJob(job) };
}

export function retryEnrichmentJob(user, jobId) {
  const data = readJobs();
  const job = data.jobs[String(jobId || "")];
  if (!job || (job.userId !== user.id && user.role !== "admin")) {
    return { ok: false, status: 404, error: "Job not found." };
  }
  if (!TERMINAL.has(job.status)) {
    return { ok: false, status: 409, error: "This job is still running." };
  }

  let touched = false;
  for (const item of job.items) {
    if (item.status === "ok") continue;
    const pendingStages = Object.entries(item.stages).filter(([, s]) => s.status !== "ok");
    if (pendingStages.length === 0) continue;

    item.status = "pending";
    item.reason = "";
    for (const [stage] of pendingStages) item.stages[stage] = { status: "pending", reason: "" };
    touched = true;
  }

  if (!touched) return { ok: false, status: 400, error: "Nothing to retry - all requested steps succeeded." };

  job.status = "queued";
  job.cancelRequested = false;
  job.finishedAt = "";
  job.error = "";
  job.updatedAt = nowIso();
  job.counts = recount(job);
  data.jobs[job.id] = job;
  writeJobs(data);
  cancelRequested.delete(job.id);
  enqueue(job.id);
  return { ok: true, job: shapeJob(job) };
}

/*
  Called once at boot. Any job that was queued or running when the process
  stopped is put back in the queue and resumes from the first unfinished item;
  completed items and successful stages are skipped, and stage charges are
  idempotent so resuming never double-charges.
*/
export function recoverEnrichmentJobs() {
  const data = readJobs();
  let resumed = 0;
  for (const job of Object.values(data.jobs)) {
    if (job.status !== "queued" && job.status !== "running") continue;
    job.status = "queued";
    job.updatedAt = nowIso();
    data.jobs[job.id] = job;
    resumed += 1;
  }
  if (resumed > 0) writeJobs(data);
  for (const job of Object.values(data.jobs)) {
    if (job.status === "queued") enqueue(job.id);
  }
  return { resumed };
}

export function enrichCsvRows(jobId, user) {
  const job = getEnrichmentJob(user, jobId);
  if (!job) return null;

  const header = [
    "domain", "company_name", "status", "company_industry", "company_location",
    "company_website", "company_linkedin", "contact_name", "contact_title",
    "contact_linkedin", "email", "email_status", "source_url", "confidence", "reason"
  ];

  const rows = [];
  for (const item of job.items) {
    const profile = item.result?.profile || {};
    const contacts = item.result?.contacts || [];
    const emails = item.result?.emails || [];
    const emailByContact = new Map();
    for (const email of emails) {
      if (email.contactName) emailByContact.set(String(email.contactName).toLowerCase(), email);
    }

    const people = contacts.length > 0 ? contacts : emails.length > 0
      ? emails.map(e => ({ name: e.contactName || "", title: e.title || "", profileUrl: "", email: e.email }))
      : [{ name: "", title: "", profileUrl: "", email: "" }];

    for (const person of people) {
      const email = person.email || emailByContact.get(String(person.name).toLowerCase())?.email || "";
      const emailRow = emails.find(e => e.email === email);
      rows.push([
        item.domain,
        item.companyName || profile.name || "",
        item.status,
        profile.industry || "",
        profile.location || profile.country || "",
        profile.website || "",
        profile.profileUrl || "",
        person.name || "",
        person.title || "",
        person.profileUrl || "",
        email,
        emailRow?.status || "",
        person.sourceUrl || emailRow?.sourceUrl || profile.sourceUrls?.[0] || "",
        person.confidence || "",
        item.reason || ""
      ]);
    }

    if (emails.length > 0 && contacts.length > 0) {
      const attached = new Set(contacts.map(c => c.email).filter(Boolean));
      for (const email of emails) {
        if (attached.has(email.email)) continue;
        rows.push([
          item.domain,
          item.companyName || profile.name || "",
          item.status,
          profile.industry || "",
          profile.location || profile.country || "",
          profile.website || "",
          profile.profileUrl || "",
          email.contactName || "",
          email.title || "",
          "",
          email.email,
          email.status || "",
          email.sourceUrl || "",
          email.confidence || "",
          item.reason || ""
        ]);
      }
    }
  }

  const escape = (value) => {
    const text = String(value ?? "");
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  return [header, ...rows].map(row => row.map(escape).join(",")).join("\r\n");
}

export function enrichmentAdminSummary() {
  const data = readJobs();
  const jobs = Object.values(data.jobs);
  const byStatus = {};
  let charged = 0;
  let refunded = 0;
  for (const job of jobs) {
    byStatus[job.status] = (byStatus[job.status] || 0) + 1;
    charged += Number(job.creditsCharged) || 0;
    refunded += Number(job.creditsRefunded) || 0;
  }
  return {
    totalJobs: jobs.length,
    byStatus,
    creditsCharged: charged,
    creditsRefunded: refunded,
    featureEnabled: enrichmentEnabled(),
    publicConfig: enrichmentPublicConfig()
  };
}
